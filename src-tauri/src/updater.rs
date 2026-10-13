//! Self-updates from the project's GitHub Releases, as the panels see them.
//!
//! `tauri-plugin-updater` does the work: it fetches `latest.json` from the endpoint in
//! `plugins.updater` (tauri.conf.json), compares versions by semver, downloads the bundle and
//! verifies its minisign signature against the public key there, and swaps the installed app
//! (macOS: the `.app`; Linux: the AppImage, or `dpkg` through `pkexec` for a `.deb`; Windows: the
//! NSIS installer, which relaunches the app). The endpoint is the `latest` release's asset, which
//! GitHub resolves to the newest *published, non-prerelease* release: the rolling `nightly`
//! pre-release and the draft a tag creates are never offered. CI writes `latest.json`
//! (`scripts/updater-artifacts.mjs`).
//!
//! This module keeps one `UpdateStatus` for every window, runs the periodic check, holds the
//! downloaded bytes until the user asks for the restart, and wraps each step as a command. The
//! user is always the one who starts a download and the one who restarts: nothing is installed
//! behind their back.
//!
//! # State machine
//!
//! ```text
//! idle --check--> checking --> none
//!                         \--> available --download--> downloading --> ready --install--> installing
//!                               ^   ^                     |  (cancel)                        |
//!                               |   +---------------------+                              (restart)
//!                               +--- failed (stage: download | install) --retry-->
//!                 failed (stage: check) --check-->
//! ```
//!
//! Automatic checks run only in release builds (a `tauri dev` binary has no bundle to replace):
//! once shortly after launch and then every six hours, quietly. A failed automatic check goes to
//! the evidence log and leaves the status alone; only a manual check reports its failure.
//! `KIMOCHI_UPDATE_ENDPOINT` replaces the configured endpoint, for testing against a local
//! manifest (see MANUAL_TESTING.md → App updates).
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{async_runtime::JoinHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The event every status change is published on, with an `UpdateStatus`.
const EVENT: &str = "update-status";
/// How often progress is reported while bytes arrive (about four times a second).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// The first automatic check waits for the windows and the dictionary engine to settle.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(20);
/// Between automatic checks.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// The activity-ticker key, so a later post about updates replaces the earlier one.
const ACTIVITY_KEY: &str = "update";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// Never checked (or the last automatic check failed quietly).
    Idle,
    Checking,
    /// Checked; this is the newest version.
    None,
    /// A newer version is offered; nothing downloaded yet.
    Available,
    Downloading,
    /// Downloaded and verified; waiting for the user to restart.
    Ready,
    /// The bundle is being swapped in; the app restarts when it is done.
    Installing,
    Failed,
}

/// Which step a `Failed` status failed at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Check,
    Download,
    Install,
}

/// What every window shows. `COMMANDS.md` → App updates.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub state: State,
    /// The running build's version.
    pub current_version: String,
    /// The offered version (available and later).
    pub version: Option<String>,
    /// The release's notes, as published.
    pub notes: Option<String>,
    /// When the release was published (RFC 3339).
    pub date: Option<String>,
    /// The bundle's size in bytes, when the manifest names it.
    pub size: Option<u64>,
    pub received_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    /// Why it failed.
    pub message: Option<String>,
    pub stage: Option<Stage>,
    /// When the last successful check finished, in milliseconds since the epoch.
    pub checked_at: Option<u64>,
    /// The user put the offer away for this run.
    pub dismissed: bool,
    /// Whether this build checks on its own.
    pub automatic: bool,
}

impl UpdateStatus {
    fn new(current_version: String, automatic: bool) -> Self {
        Self {
            state: State::Idle,
            current_version,
            version: None,
            notes: None,
            date: None,
            size: None,
            received_bytes: None,
            total_bytes: None,
            message: None,
            stage: None,
            checked_at: None,
            dismissed: false,
            automatic,
        }
    }

    fn fail(&mut self, stage: Stage, message: String) {
        self.state = State::Failed;
        self.stage = Some(stage);
        self.message = Some(message);
    }
}

struct Inner {
    status: UpdateStatus,
    /// The offered update, from `available` on.
    update: Option<Update>,
    /// The downloaded, verified bundle, from `ready` on.
    bytes: Option<Vec<u8>>,
    download: Option<JoinHandle<()>>,
    /// The version last posted on the activity ticker.
    announced: Option<String>,
}

pub struct Updates {
    app: tauri::AppHandle,
    inner: Mutex<Inner>,
    /// Records a diagnostic (`crate::record`).
    report: Box<dyn Fn(Value) + Send + Sync>,
    /// Stops the platform's own threads before the process is replaced (`app_quit` does the same).
    before_exit: fn(),
}

static UPDATES: OnceLock<Arc<Updates>> = OnceLock::new();

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Whether this build checks on its own: a bundle, never a `tauri dev` binary (there is no
/// `.app` or AppImage to replace), unless a test endpoint is set.
fn automatic() -> bool {
    !cfg!(debug_assertions) || std::env::var_os("KIMOCHI_UPDATE_ENDPOINT").is_some()
}

/// The plugin's errors read well enough, but a few are worth saying in the app's words.
fn describe(error: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match error {
        Error::ReleaseNotFound => "No release information was found.".into(),
        Error::Reqwest(e) => {
            if e.is_connect() || e.is_timeout() || e.is_request() {
                "Could not reach GitHub. Check your connection and try again.".into()
            } else {
                format!("Network error: {e}")
            }
        }
        Error::Network(e) => format!("Network error: {e}"),
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) => {
            "The download did not pass its signature check.".into()
        }
        Error::TargetsNotFound(_) | Error::TargetNotFound(_) => {
            "This release has no build for this computer.".into()
        }
        Error::AuthenticationFailed => "The installation was not authorised.".into(),
        other => other.to_string(),
    }
}

impl Updates {
    fn status(&self) -> UpdateStatus {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .status
            .clone()
    }

    fn emit(&self) {
        let _ = self.app.emit(EVENT, self.status());
    }

    /// The updater for one check. `KIMOCHI_UPDATE_ENDPOINT` replaces the configured endpoint.
    fn updater(&self) -> Result<tauri_plugin_updater::Updater, String> {
        let app = self.app.clone();
        let before_exit = self.before_exit;
        let mut builder = self.app.updater_builder().on_before_exit(move || {
            // Windows: the installer is about to be launched and this process to exit.
            before_exit();
            app.cleanup_before_exit();
        });
        if let Ok(endpoint) = std::env::var("KIMOCHI_UPDATE_ENDPOINT") {
            let url = endpoint
                .parse()
                .map_err(|e| format!("KIMOCHI_UPDATE_ENDPOINT is not a URL: {e}"))?;
            builder = builder.endpoints(vec![url]).map_err(describe)?;
        }
        builder.build().map_err(describe)
    }

    /// Check now. `manual` is the user's own click: its failure is shown, a quiet one is only
    /// logged. A check never disturbs a download, a downloaded bundle or an installation, and
    /// a quiet one leaves a standing offer alone (re-checking would blank the notice for a
    /// moment, to say the same thing).
    pub fn check(self: &Arc<Self>, manual: bool) -> UpdateStatus {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            match inner.status.state {
                State::Checking
                | State::Downloading
                | State::Ready
                | State::Installing => return inner.status.clone(),
                State::Available if !manual => return inner.status.clone(),
                _ => {}
            }
            inner.status.state = State::Checking;
            inner.status.message = None;
            inner.status.stage = None;
        }
        self.emit();
        let updates = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = match updates.updater() {
                Ok(updater) => updater.check().await.map_err(describe),
                Err(e) => Err(e),
            };
            let announce = {
                let mut inner = updates.inner.lock().unwrap_or_else(|p| p.into_inner());
                // Something else moved the status on (a cancel, a dismiss) while the request
                // ran: that is fine, this result still stands on top of it.
                let status = &mut inner.status;
                match result {
                    Ok(Some(update)) => {
                        let same = status.version.as_deref() == Some(update.version.as_str());
                        status.state = State::Available;
                        status.version = Some(update.version.clone());
                        status.notes = update.body.clone();
                        status.date = update.date.and_then(|d| {
                            d.format(&time::format_description::well_known::Rfc3339).ok()
                        });
                        status.size = manifest_size(&update);
                        status.received_bytes = None;
                        status.total_bytes = None;
                        status.checked_at = Some(now_ms());
                        // A dismissed offer stays dismissed until a different version arrives.
                        if !same {
                            status.dismissed = false;
                        }
                        let announce = inner.announced.as_deref() != Some(update.version.as_str());
                        if announce {
                            inner.announced = Some(update.version.clone());
                        }
                        inner.update = Some(update);
                        announce
                    }
                    Ok(None) => {
                        status.state = State::None;
                        status.version = None;
                        status.notes = None;
                        status.date = None;
                        status.size = None;
                        status.checked_at = Some(now_ms());
                        inner.update = None;
                        false
                    }
                    Err(message) => {
                        if manual {
                            status.fail(Stage::Check, message);
                        } else {
                            // Quietly: a laptop that is offline at launch should not nag.
                            status.state = if status.checked_at.is_some() {
                                State::None
                            } else {
                                State::Idle
                            };
                            (updates.report)(json!({
                                "check": "update-check",
                                "status": "failed",
                                "detail": message,
                            }));
                        }
                        false
                    }
                }
            };
            let status = updates.status();
            (updates.report)(json!({
                "check": "update-check",
                "status": format!("{:?}", status.state).to_lowercase(),
                "current": status.current_version,
                "version": status.version,
                "manual": manual,
            }));
            if announce {
                if let Some(version) = &status.version {
                    crate::activity::post(
                        &updates.app,
                        &format!("Kimochi {version} is available"),
                        crate::activity::Tone::Info,
                        Some(ACTIVITY_KEY),
                    );
                }
            }
            updates.emit();
        });
        self.status()
    }

    /// Download the offered bundle (or try again after a failure). A no-op while one runs or
    /// once the bundle is ready.
    pub fn download(self: &Arc<Self>) -> Result<UpdateStatus, String> {
        let update = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            match inner.status.state {
                State::Downloading | State::Ready | State::Installing => {
                    return Ok(inner.status.clone())
                }
                State::Available | State::Failed => {}
                _ => return Err("invalid: there is no update to download".into()),
            }
            let Some(update) = inner.update.clone() else {
                return Err("invalid: there is no update to download".into());
            };
            let status = &mut inner.status;
            status.state = State::Downloading;
            status.stage = None;
            status.message = None;
            status.received_bytes = Some(0);
            status.total_bytes = status.size;
            status.dismissed = false;
            update
        };
        self.emit();
        let updates = self.clone();
        let handle = tauri::async_runtime::spawn(async move {
            let mut received: u64 = 0;
            let mut last = Instant::now();
            let result = update
                .download(
                    |chunk, total| {
                        received += chunk as u64;
                        if last.elapsed() >= PROGRESS_INTERVAL {
                            last = Instant::now();
                            {
                                let mut inner =
                                    updates.inner.lock().unwrap_or_else(|p| p.into_inner());
                                let status = &mut inner.status;
                                status.received_bytes = Some(received);
                                status.total_bytes = total.or(status.size);
                            }
                            updates.emit();
                        }
                    },
                    || {},
                )
                .await;
            {
                let mut inner = updates.inner.lock().unwrap_or_else(|p| p.into_inner());
                inner.download = None;
                let status = &mut inner.status;
                match result {
                    Ok(bytes) => {
                        let size = bytes.len() as u64;
                        status.state = State::Ready;
                        status.received_bytes = Some(size);
                        status.total_bytes = Some(size);
                        status.size = Some(size);
                        inner.bytes = Some(bytes);
                    }
                    Err(e) => {
                        status.fail(Stage::Download, describe(e));
                        inner.bytes = None;
                    }
                }
            }
            let status = updates.status();
            (updates.report)(json!({
                "check": "update-download",
                "status": format!("{:?}", status.state).to_lowercase(),
                "version": status.version,
                "bytes": status.received_bytes,
                "detail": status.message,
            }));
            if status.state == State::Ready {
                if let Some(version) = &status.version {
                    crate::activity::post(
                        &updates.app,
                        &format!("Kimochi {version} is ready to install"),
                        crate::activity::Tone::Ok,
                        Some(ACTIVITY_KEY),
                    );
                }
            }
            updates.emit();
        });
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .download = Some(handle);
        Ok(self.status())
    }

    /// Stop a download; the offer stays. A no-op in any other state.
    pub fn cancel(&self) -> UpdateStatus {
        let cancelled = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            match inner.download.take() {
                Some(handle) if inner.status.state == State::Downloading => {
                    handle.abort();
                    let status = &mut inner.status;
                    status.state = State::Available;
                    status.received_bytes = None;
                    status.total_bytes = None;
                    true
                }
                _ => false,
            }
        };
        if cancelled {
            self.emit();
        }
        self.status()
    }

    /// Swap the downloaded bundle in and restart. The reply is the `installing` status; the
    /// process is replaced once the swap is done (on Windows the installer does the restart).
    pub fn install(self: &Arc<Self>) -> Result<UpdateStatus, String> {
        let (update, bytes) = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if inner.status.state == State::Installing {
                return Ok(inner.status.clone());
            }
            if inner.status.state != State::Ready {
                return Err("invalid: no update has been downloaded".into());
            }
            let (Some(update), Some(bytes)) = (inner.update.clone(), inner.bytes.take()) else {
                return Err("invalid: no update has been downloaded".into());
            };
            inner.status.state = State::Installing;
            (update, bytes)
        };
        self.emit();
        let updates = self.clone();
        // Never on the main thread: the macOS installer may wait on an AppleScript it runs there.
        tauri::async_runtime::spawn_blocking(move || {
            (updates.report)(json!({
                "check": "update-install",
                "status": "started",
                "version": updates.status().version,
            }));
            match update.install(&bytes) {
                Ok(()) => {
                    // macOS and Linux: the new bundle is in place; relaunch into it. (Windows
                    // never returns here: the installer is launched and this process exits.)
                    (updates.report)(json!({ "check": "update-install", "status": "restarting" }));
                    (updates.before_exit)();
                    updates.app.restart();
                }
                Err(e) => {
                    {
                        let mut inner = updates.inner.lock().unwrap_or_else(|p| p.into_inner());
                        // Keep the verified bytes: Retry installs again without a download.
                        inner.bytes = Some(bytes);
                        inner.status.fail(Stage::Install, describe(e));
                    }
                    let status = updates.status();
                    (updates.report)(json!({
                        "check": "update-install",
                        "status": "failed",
                        "detail": status.message,
                    }));
                    updates.emit();
                }
            }
        });
        Ok(self.status())
    }

    /// Try the failed step again: a download after a download failure, the install after an
    /// install failure, a check after a check failure.
    pub fn retry(self: &Arc<Self>) -> Result<UpdateStatus, String> {
        let stage = {
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if inner.status.state != State::Failed {
                return Ok(inner.status.clone());
            }
            (inner.status.stage, inner.bytes.is_some())
        };
        match stage {
            (Some(Stage::Install), true) => {
                {
                    let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                    inner.status.state = State::Ready;
                    inner.status.stage = None;
                    inner.status.message = None;
                }
                self.install()
            }
            (Some(Stage::Download), _) | (Some(Stage::Install), false) => self.download(),
            _ => Ok(self.check(true)),
        }
    }

    /// Put the offer away for this run: the notice goes, Settings still shows it.
    pub fn dismiss(&self) -> UpdateStatus {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner.status.dismissed = true;
        }
        self.emit();
        self.status()
    }
}

/// The bundle's size, which CI writes into `latest.json` beside each platform's URL and
/// signature (the plugin ignores it, but keeps the raw document).
fn manifest_size(update: &Update) -> Option<u64> {
    let url = update.download_url.as_str();
    update
        .raw_json
        .get("platforms")?
        .as_object()?
        .values()
        .find(|platform| platform.get("url").and_then(Value::as_str) == Some(url))?
        .get("size")?
        .as_u64()
}

/// Install the updates service: the shared status, and the periodic check in builds that
/// update themselves. Before any window asks.
pub fn install(
    app: &tauri::AppHandle,
    report: impl Fn(Value) + Send + Sync + 'static,
    before_exit: fn(),
) {
    let automatic = automatic();
    let updates = Arc::new(Updates {
        app: app.clone(),
        inner: Mutex::new(Inner {
            status: UpdateStatus::new(app.package_info().version.to_string(), automatic),
            update: None,
            bytes: None,
            download: None,
            announced: None,
        }),
        report: Box::new(report),
        before_exit,
    });
    if UPDATES.set(updates.clone()).is_err() {
        return;
    }
    if !automatic {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            updates.check(false);
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

fn service() -> Result<Arc<Updates>, String> {
    UPDATES
        .get()
        .cloned()
        .ok_or_else(|| "native: updates are not available yet".to_string())
}

// ---------------------------------------------------------------------------- commands

#[tauri::command]
pub fn update_status() -> Result<UpdateStatus, String> {
    Ok(service()?.status())
}

/// The user's own check: its result (or failure) is shown.
#[tauri::command]
pub fn update_check() -> Result<UpdateStatus, String> {
    Ok(service()?.check(true))
}

#[tauri::command]
pub fn update_download() -> Result<UpdateStatus, String> {
    service()?.download()
}

#[tauri::command]
pub fn update_cancel() -> Result<UpdateStatus, String> {
    Ok(service()?.cancel())
}

#[tauri::command]
pub fn update_install() -> Result<UpdateStatus, String> {
    service()?.install()
}

#[tauri::command]
pub fn update_retry() -> Result<UpdateStatus, String> {
    service()?.retry()
}

#[tauri::command]
pub fn update_dismiss() -> Result<UpdateStatus, String> {
    Ok(service()?.dismiss())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serialises_in_the_panels_vocabulary() {
        let mut status = UpdateStatus::new("0.1.0".into(), true);
        status.fail(Stage::Download, "boom".into());
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(value["state"], "failed");
        assert_eq!(value["stage"], "download");
        assert_eq!(value["currentVersion"], "0.1.0");
        assert_eq!(value["message"], "boom");
        assert_eq!(value["automatic"], true);
        assert_eq!(value["dismissed"], false);
        assert!(value["version"].is_null());
    }

    #[test]
    fn new_status_is_idle() {
        let status = UpdateStatus::new("0.1.0".into(), false);
        assert_eq!(status.state, State::Idle);
        assert_eq!(serde_json::to_value(status.state).unwrap(), "idle");
    }
}
