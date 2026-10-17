//! Optional Kimochi accounts: linking this computer to an account, the account's cached state,
//! and backup and restore of preferences and sessions.
//!
//! The account token (`kmc_…`) lives only here, in the app's data folder (mode 600 on Unix), one
//! file per server base (`file_name`: `account.json` for Kimochi cloud, `account-local.json` for
//! a local development server), and is sent only as `Authorization: Bearer` to that server
//! (`settings::server_base`). Each server has its own sign-in, so switching servers in a
//! development build never sends one server's token to the other. Like the owner's access key in `cloud.rs`, it never reaches a
//! webview, a log or a diagnostic: the webviews learn the cached user, the usage and whether
//! someone is signed in (`account_status`, `account-changed`), never the token.
//!
//! Linking is the server's device flow (`/api/v1/link/start`, then `/api/v1/link/poll` every
//! `interval` seconds on a thread of its own) with the confirmation page opened in the browser.
//! The `kimochi://account` URL the website's "Open Kimochi" button carries is handled here too.
use crate::{cloud, panels, platform, settings, state::Shared};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/// The account file for Kimochi cloud; also the name the single account file always had.
const FILE: &str = "account.json";
/// The account file for a local development server (`settings::LOCAL_SERVER`).
const LOCAL_FILE: &str = "account-local.json";
const USER_AGENT: &str = "Kimochi/0.1";
/// The staging folder a restore downloads into; applied at the next launch (`apply_pending_restore`).
const RESTORE_DIR: &str = "restore-pending";
const RESTORE_MARKER: &str = "ready.json";
/// The server's limit for `PUT /api/v1/prefs`.
const PREFS_LIMIT: usize = 256 * 1024;
/// The server's limit for one backed-up file.
const FILE_LIMIT: u64 = 50 * 1024 * 1024;

/// What `account.json` holds. The token never leaves this module except as a request header.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Stored {
    token: String,
    #[serde(default)]
    user: Value,
    #[serde(default)]
    usage: Option<Value>,
    #[serde(default)]
    backup: BackupMemo,
}

/// What the last backup did, so the next one uploads only what changed.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct BackupMemo {
    /// Epoch ms of the last backup that finished.
    last_backup_at: Option<u64>,
    last_error: Option<String>,
    /// SHA-256 of the last preferences document uploaded.
    prefs_hash: Option<String>,
    /// The data folder as it was at the last finished backup (`fingerprint`).
    fingerprint: Option<String>,
}

struct Link {
    seq: u64,
    code: String,
    verify_url: String,
    expires_at_ms: u64,
}

/// The account file last read, and what it holds. Reloaded whenever the server base changes.
struct Slot {
    file: PathBuf,
    stored: Option<Stored>,
}

struct Account {
    app: AppHandle,
    /// The folder of `settings.json`, where the account files live.
    data_dir: PathBuf,
    /// Where the Log keeps `presets.json`, `stats.json`, `sessions.json` and `sessions/`.
    local_dir: PathBuf,
    slot: Mutex<Slot>,
    link: Mutex<Option<Link>>,
    /// Bumped by every start and cancel; a poll thread stops once it is no longer current.
    link_seq: AtomicU64,
    backup_running: AtomicBool,
    usage_pending: AtomicBool,
}

static ACCOUNT: OnceLock<Account> = OnceLock::new();

fn account() -> Result<&'static Account, String> {
    ACCOUNT.get().ok_or_else(|| "native: accounts are not ready yet".to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

/// Load the saved account and start the automatic backup. Called once from `setup`, after the
/// shared service is managed.
pub fn install(app: &AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let local_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let _ = ACCOUNT.set(Account {
        app: app.clone(),
        data_dir,
        local_dir,
        // An empty path matches no server: the first look loads the current server's file.
        slot: Mutex::new(Slot { file: PathBuf::new(), stored: None }),
        link: Mutex::new(None),
        link_seq: AtomicU64::new(0),
        backup_running: AtomicBool::new(false),
        usage_pending: AtomicBool::new(false),
    });
    spawn_auto_backup();
    // The cached user and usage can be a month old: refresh them quietly once the app is up.
    if signed_in() {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(5));
            let _ = refresh_blocking();
        });
    }
    Ok(())
}

/// The account file for `base`, in the data folder. Kimochi cloud keeps `account.json`, the one
/// file there was before sign-ins were kept per server, so an existing sign-in stays cloud's.
fn file_name(base: &str) -> String {
    if base == settings::CLOUD_SERVER {
        FILE.to_string()
    } else if base == settings::LOCAL_SERVER {
        LOCAL_FILE.to_string()
    } else {
        format!("account-{}.json", &sha256_hex(base.as_bytes())[..12])
    }
}

fn load(file: &Path) -> Option<Stored> {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Stored>(&bytes).ok())
        .filter(|s| !s.token.is_empty())
}

/// Point `slot` at `base`'s account file in `data_dir`, reading it if the slot held another's.
fn select(slot: &mut Slot, data_dir: &Path, base: &str) {
    let file = data_dir.join(file_name(base));
    if slot.file != file {
        slot.stored = load(&file);
        slot.file = file;
    }
}

/// The slot holding `base`'s account.
fn slot_for<'a>(account: &'a Account, base: &str) -> std::sync::MutexGuard<'a, Slot> {
    let mut slot = lock(&account.slot);
    select(&mut slot, &account.data_dir, base);
    slot
}

/// What is saved for `base`'s server.
fn stored_for(base: &str) -> Option<Stored> {
    let account = ACCOUNT.get()?;
    slot_for(account, base).stored.clone()
}

fn token_for(base: &str) -> Option<String> {
    stored_for(base).map(|s| s.token)
}

/// The account token for the server in use, if this computer is signed in there. Only for
/// request headers.
pub fn token() -> Option<String> {
    token_for(&base().ok()?)
}

pub fn signed_in() -> bool {
    token().is_some()
}

fn persist(stored: Option<&Stored>, file: &Path) -> Result<(), String> {
    let Some(stored) = stored else {
        return match std::fs::remove_file(file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    };
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(stored).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut out = options.open(&tmp).map_err(|e| e.to_string())?;
        out.write_all(&bytes).map_err(|e| e.to_string())?;
        out.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}

/// Change `base`'s stored account and save it. `None` from `edit` signs out of that server.
fn update(base: &str, edit: impl FnOnce(Option<Stored>) -> Option<Stored>) -> Result<(), String> {
    let account = account()?;
    let mut slot = slot_for(account, base);
    let next = edit(slot.stored.take());
    let result = persist(next.as_ref(), &slot.file);
    slot.stored = next;
    result
}

/// What the webviews may know: never the token.
fn status_value() -> Value {
    let Some(account) = ACCOUNT.get() else {
        return json!({ "signedIn": false, "backup": { "running": false } });
    };
    let server = server_value();
    let stored = base().ok().and_then(|base| stored_for(&base));
    let linking = lock(&account.link).as_ref().map(|link| {
        json!({ "code": link.code, "verifyUrl": link.verify_url, "expiresAt": link.expires_at_ms })
    });
    let running = account.backup_running.load(Ordering::SeqCst);
    match stored {
        Some(s) => json!({
            "signedIn": true,
            "user": s.user,
            "usage": s.usage,
            "linking": linking,
            "server": server,
            "backup": {
                "running": running,
                "lastBackupAt": s.backup.last_backup_at,
                "lastError": s.backup.last_error,
            },
        }),
        None => json!({ "signedIn": false, "linking": linking, "server": server, "backup": { "running": running } }),
    }
}

/// The server the account belongs to: `{mode, url, forced}`, `forced` when a development build's
/// `KIMOCHI_SERVER` picks it over the setting.
fn server_value() -> Value {
    let Some(service) = ACCOUNT.get().and_then(|a| a.app.try_state::<Shared>()) else {
        return Value::Null;
    };
    let mode = settings::server_mode(&service.settings);
    json!({
        "mode": mode,
        "url": settings::base_for_mode(mode),
        "forced": settings::server_mode_override().is_some(),
    })
}

fn announce() {
    let Some(account) = ACCOUNT.get() else { return };
    let _ = account.app.emit("account-changed", status_value());
}

/// Signing in or out changes what Kimochi cloud offers: tell every window again.
fn announce_capabilities() {
    let Some(account) = ACCOUNT.get() else { return };
    if let Some(service) = account.app.try_state::<Shared>() {
        crate::spawn_capabilities_watch(account.app.clone(), service.inner().clone());
    }
}

fn base() -> Result<String, String> {
    let account = account()?;
    let service = account
        .app
        .try_state::<Shared>()
        .ok_or("native: Kimochi is still starting")?;
    Ok(settings::server_base(&service.settings))
}

fn client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(timeout)
        .build()
        .map_err(|_| "native: could not initialize the account HTTP client".to_string())
}

const OFFLINE: &str = "native: Kimochi cloud could not be reached (connection/TLS/timeout). Check your internet connection and try again.";

/// A failed answer from `base` as a sentence, signing out of that server locally when it no
/// longer accepts the token.
fn failure(feature: cloud::Feature, base: &str, response: reqwest::blocking::Response) -> String {
    let status = response.status().as_u16();
    let body = response.text().unwrap_or_default();
    if status == 401 {
        signed_out_remotely_from(base);
    }
    format!("native: {}", cloud::describe_failure(feature, status, &body, true))
}

/// The server answered 401 to the account token: it was revoked (on the website, by a password
/// reset) or expired. Forget it here, as a sign-out would.
pub fn signed_out_remotely() {
    if let Ok(base) = base() {
        signed_out_remotely_from(&base);
    }
}

fn signed_out_remotely_from(base: &str) {
    if token_for(base).is_none() {
        return;
    }
    let _ = update(base, |_| None);
    announce();
    announce_capabilities();
}

/// Refresh the cached usage a moment after a metered call, at most one at a time.
pub fn usage_changed() {
    let Some(account) = ACCOUNT.get() else { return };
    if token().is_none() || account.usage_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(2));
        if let Some(account) = ACCOUNT.get() {
            account.usage_pending.store(false, Ordering::SeqCst);
        }
        let _ = refresh_usage_blocking();
    });
}

fn refresh_usage_blocking() -> Result<(), String> {
    refresh_usage_for(&base()?)
}

fn refresh_usage_for(base: &str) -> Result<(), String> {
    let token = token_for(base).ok_or("native: not signed in")?;
    let http = client(Duration::from_secs(15))?;
    let response = http
        .get(format!("{base}/api/v1/usage"))
        .bearer_auth(&token)
        .send()
        .map_err(|_| OFFLINE.to_string())?;
    if !response.status().is_success() {
        return Err(failure(cloud::Feature::Account, base, response));
    }
    let usage: Value = response.json().map_err(|_| "native: Kimochi cloud sent an unreadable answer")?;
    update(base, |stored| {
        stored.map(|mut s| {
            s.usage = Some(usage);
            s
        })
    })?;
    announce();
    Ok(())
}

fn refresh_blocking() -> Result<Value, String> {
    let base = base()?;
    let token = token_for(&base).ok_or("native: not signed in")?;
    let http = client(Duration::from_secs(15))?;
    let response = http
        .get(format!("{base}/api/v1/me"))
        .bearer_auth(&token)
        .send()
        .map_err(|_| OFFLINE.to_string())?;
    if !response.status().is_success() {
        return Err(failure(cloud::Feature::Account, &base, response));
    }
    let me: Value = response.json().map_err(|_| "native: Kimochi cloud sent an unreadable answer")?;
    let user = me.get("user").cloned().unwrap_or(Value::Null);
    update(&base, |stored| {
        stored.map(|mut s| {
            s.user = user;
            s
        })
    })?;
    refresh_usage_for(&base)?;
    Ok(status_value())
}

// ---------------------------------------------------------------- linking

fn device_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !name.is_empty() {
            return name.chars().take(64).collect();
        }
    }
    #[cfg(target_os = "windows")]
    let name = std::env::var("COMPUTERNAME").unwrap_or_default();
    #[cfg(not(target_os = "windows"))]
    let name = {
        let mut buf = [0u8; 256];
        let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        if ok {
            String::from_utf8_lossy(&buf[..end]).trim_end_matches(".local").to_string()
        } else {
            String::new()
        }
    };
    let name = name.trim();
    if name.is_empty() {
        "Kimochi".into()
    } else {
        name.chars().take(64).collect()
    }
}

#[allow(deprecated)] // the shell plugin's `open` is the opener the app already uses
fn open_in_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    app.shell()
        .open(url, None)
        .map_err(|e| format!("native: could not open the browser: {e}"))
}

/// Bring the main window to the front and focus it; on `account`, on Settings → Account.
pub fn bring_forward(app: &AppHandle, account_page: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(service) = handle.try_state::<Shared>() else { return };
        let settings = service.settings.clone();
        if account_page && settings.set("settingsActiveTab", json!("account")).is_ok() {
            let _ = handle.emit(
                "settings:changed",
                json!({ "key": "settingsActiveTab", "value": "account" }),
            );
        }
        let _ = panels::act_existing(&handle, &settings, panels::MAIN, "show", None);
        if let Some(main) = handle.get_webview_window(panels::MAIN) {
            let _ = platform::activate_self(Some(&main));
        }
        if account_page {
            let _ = handle.emit("main:show-settings", json!({}));
        }
    });
}

/// `kimochi://…` URLs, from the deep-link plugin (a running copy, or a second launch forwarded by
/// the single-instance plugin, or the URL this copy was launched with).
pub fn handle_urls(app: &AppHandle, urls: &[String]) {
    for url in urls {
        if let Some(page) = deep_link_page(url) {
            bring_forward(app, page == "account");
            // Coming back from the website: whatever it changed (a new plan, a device removed)
            // shows at once.
            if page == "account" && signed_in() {
                std::thread::spawn(|| {
                    let _ = refresh_blocking();
                });
            }
        }
    }
}

/// The page a `kimochi://` URL asks for: `kimochi://account` (also `kimochi:///account`,
/// `kimochi://account/…`) is `account`; any other `kimochi://` URL just brings Kimochi forward.
fn deep_link_page(url: &str) -> Option<&'static str> {
    let rest = url.strip_prefix("kimochi:")?;
    let path = rest.trim_start_matches('/');
    let first = path.split(['/', '?', '#']).next().unwrap_or("");
    Some(if first.eq_ignore_ascii_case("account") { "account" } else { "" })
}

fn link_event(status: &str, code: &str, message: Option<&str>) {
    let Some(account) = ACCOUNT.get() else { return };
    let _ = account
        .app
        .emit("account-link", json!({ "status": status, "code": code, "message": message }));
}

fn end_link(seq: u64) {
    if let Some(account) = ACCOUNT.get() {
        let mut link = lock(&account.link);
        if link.as_ref().is_some_and(|l| l.seq == seq) {
            *link = None;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkStart {
    code: String,
    poll_token: String,
    verify_url: String,
    expires_in: u64,
    #[serde(default)]
    interval: Option<u64>,
}

#[tauri::command]
pub async fn account_link_start(app: AppHandle) -> Result<Value, String> {
    let base = base()?;
    let start_base = base.clone();
    let start = tauri::async_runtime::spawn_blocking(move || -> Result<LinkStart, String> {
        let base = start_base;
        let http = client(Duration::from_secs(15))?;
        let response = http
            .post(format!("{base}/api/v1/link/start"))
            .json(&json!({ "deviceName": device_name(), "platform": std::env::consts::OS }))
            .send()
            .map_err(|_| OFFLINE.to_string())?;
        if !response.status().is_success() {
            return Err(failure(cloud::Feature::Account, &base, response));
        }
        response
            .json::<LinkStart>()
            .map_err(|_| "native: Kimochi cloud sent an unreadable answer".to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    let account = account()?;
    let seq = account.link_seq.fetch_add(1, Ordering::SeqCst) + 1;
    *lock(&account.link) = Some(Link {
        seq,
        code: start.code.clone(),
        verify_url: start.verify_url.clone(),
        expires_at_ms: now_ms() + start.expires_in * 1000,
    });
    link_event("pending", &start.code, None);
    announce();
    // A browser that cannot be opened is not fatal: the code is on screen with "Open browser again".
    let _ = open_in_browser(&app, &start.verify_url);

    let interval = Duration::from_secs(start.interval.unwrap_or(2).clamp(1, 30));
    let deadline = Instant::now() + Duration::from_secs(start.expires_in);
    let (code, poll_token) = (start.code.clone(), start.poll_token);
    // The poll stays with the server it started on; switching servers cancels it.
    std::thread::spawn(move || poll(seq, base, code, poll_token, interval, deadline));

    Ok(json!({ "code": start.code, "verifyUrl": start.verify_url, "expiresIn": start.expires_in }))
}

fn poll(seq: u64, base: String, code: String, poll_token: String, interval: Duration, deadline: Instant) {
    let current = || ACCOUNT.get().is_some_and(|a| a.link_seq.load(Ordering::SeqCst) == seq);
    let Ok(http) = client(Duration::from_secs(15)) else { return };
    let mut wait = interval;
    let mut failures = 0u32;
    loop {
        std::thread::sleep(wait);
        if !current() {
            return;
        }
        if Instant::now() >= deadline {
            end_link(seq);
            link_event("expired", &code, None);
            announce();
            return;
        }
        let answer = http
            .post(format!("{base}/api/v1/link/poll"))
            .json(&json!({ "pollToken": poll_token }))
            .send();
        let response = match answer {
            Ok(response) => response,
            Err(_) => {
                failures += 1;
                if failures >= 15 {
                    end_link(seq);
                    link_event("error", &code, Some(OFFLINE.trim_start_matches("native: ")));
                    announce();
                    return;
                }
                continue;
            }
        };
        if response.status().as_u16() == 429 {
            wait = (wait * 2).min(Duration::from_secs(30));
            continue;
        }
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            failures += 1;
            if failures >= 5 || status == 400 || status == 404 {
                end_link(seq);
                let message = cloud::describe_failure(cloud::Feature::Account, status, &body, false);
                link_event("error", &code, Some(&message));
                announce();
                return;
            }
            continue;
        }
        failures = 0;
        wait = interval;
        let Ok(body) = response.json::<Value>() else { continue };
        if !current() {
            return;
        }
        match body.get("status").and_then(Value::as_str).unwrap_or("") {
            "pending" => {}
            "approved" => {
                let token = body.get("token").and_then(Value::as_str).unwrap_or("").to_string();
                if token.is_empty() {
                    continue;
                }
                let user = body.get("user").cloned().unwrap_or(Value::Null);
                end_link(seq);
                // A fresh account starts a fresh backup memo.
                let saved = update(&base, |_| {
                    Some(Stored { token, user, usage: None, backup: BackupMemo::default() })
                });
                if let Err(e) = saved {
                    link_event("error", &code, Some(&format!("Signed in, but the account could not be saved: {e}")));
                    announce();
                    return;
                }
                link_event("approved", &code, None);
                announce();
                announce_capabilities();
                if let Some(account) = ACCOUNT.get() {
                    bring_forward(&account.app, true);
                }
                let _ = refresh_usage_for(&base);
                return;
            }
            status @ ("denied" | "expired") => {
                end_link(seq);
                link_event(status, &code, None);
                announce();
                return;
            }
            _ => {}
        }
    }
}

/// Stop the sign-in in progress, if any: its poll thread ends at its next turn.
fn cancel_link(account: &Account) -> Option<String> {
    account.link_seq.fetch_add(1, Ordering::SeqCst);
    lock(&account.link).take().map(|l| l.code)
}

#[tauri::command]
pub fn account_link_cancel() -> Result<Value, String> {
    let code = cancel_link(account()?).unwrap_or_default();
    link_event("cancelled", &code, None);
    announce();
    Ok(status_value())
}

/// Development builds only: switch Kimochi's server (`serverSettings.mode`) at once. Each server
/// has its own sign-in, so the account shown, `cloudAccess` and every request follow the switch
/// without a restart. A sign-in in progress is cancelled.
#[tauri::command]
pub fn account_set_server(mode: String) -> Result<Value, String> {
    if !cfg!(debug_assertions) {
        return Err("invalid: the server can only be switched in a development build".into());
    }
    if mode != "cloud" && mode != "local" {
        return Err(format!("invalid: unknown server mode {mode:?} (cloud or local)"));
    }
    if let Some(forced) = settings::server_mode_override() {
        return Err(format!(
            "invalid: {}={forced} picks the server for this run; unset it to switch here",
            settings::SERVER_ENV
        ));
    }
    let account = account()?;
    let service = account
        .app
        .try_state::<Shared>()
        .ok_or("native: Kimochi is still starting")?;
    if let Some(code) = cancel_link(account) {
        link_event("cancelled", &code, None);
    }
    service.settings.set("serverSettings.mode", json!(mode))?;
    let value = service
        .settings
        .get("serverSettings")
        .ok()
        .flatten()
        .unwrap_or_else(|| json!({ "mode": mode }));
    let _ = account
        .app
        .emit("settings:changed", json!({ "key": "serverSettings", "value": value }));
    announce();
    announce_capabilities();
    if signed_in() {
        std::thread::spawn(|| {
            let _ = refresh_blocking();
        });
    }
    Ok(status_value())
}

#[tauri::command]
pub fn account_status() -> Value {
    status_value()
}

#[tauri::command]
pub async fn account_sign_out() -> Result<Value, String> {
    let base = base()?;
    let token = token_for(&base);
    // The local sign-out is what counts: the file goes even when the server cannot be reached.
    update(&base, |_| None)?;
    announce();
    announce_capabilities();
    if let Some(token) = token {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Ok(http) = client(Duration::from_secs(5)) {
                let _ = http.post(format!("{base}/api/v1/sign-out")).bearer_auth(&token).send();
            }
        })
        .await;
    }
    Ok(status_value())
}

#[tauri::command]
pub async fn account_refresh() -> Result<Value, String> {
    if !signed_in() {
        return Ok(status_value());
    }
    tauri::async_runtime::spawn_blocking(refresh_blocking)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn account_open_web(app: AppHandle) -> Result<(), String> {
    open_in_browser(&app, &format!("{}/account", base()?))
}

/// "Open browser again" while linking.
#[tauri::command]
pub fn account_link_open(app: AppHandle) -> Result<(), String> {
    let url = lock(&account()?.link).as_ref().map(|l| l.verify_url.clone());
    open_in_browser(&app, &url.ok_or("invalid: no sign-in is in progress")?)
}

// ---------------------------------------------------------------- backup

/// Settings keys that never go to the backup and are never replaced by a restore: per-machine
/// state (window places, the capture source, the portal grant) and the transient scan history.
const LOCAL_ONLY: &[&str] = &[
    "windowPositions",
    "nativeWindowBounds",
    "capture",
    "lastSelectedSource",
    "notebookEditRequest",
    "lastSeenVersion",
    "hasCompletedOnboarding",
    "scannedTextHistory",
    "serverSettings",
    "endpoint",
];

/// A secret by its name: the DeepL key, an AnkiConnect key, any API key, token, secret or
/// password. Matched on any level of the document, so a key added later is covered too.
fn is_private(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k == "key"
        || k.ends_with("apikey")
        || k.ends_with("api_key")
        || k.ends_with("accesskey")
        || k.ends_with("authkey")
        || k.ends_with("connectkey")
        || k.contains("token")
        || k.contains("secret")
        || k.contains("password")
}

/// A copy of `value` without any private key, at any depth.
fn strip_private(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(k, _)| !is_private(k))
                .map(|(k, v)| (k.clone(), strip_private(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(strip_private).collect()),
        other => other.clone(),
    }
}

/// `settings.json` as it is backed up: no secrets, no per-machine keys.
fn backup_settings(settings: &Value) -> Value {
    let mut out = strip_private(settings);
    if let Some(map) = out.as_object_mut() {
        for key in LOCAL_ONLY {
            map.remove(*key);
        }
    }
    out
}

/// Put `local`'s private keys back into `restored`, at the same places.
fn keep_private(local: &Value, restored: &mut Value) {
    let (Some(local), Some(restored)) = (local.as_object(), restored.as_object_mut()) else {
        return;
    };
    for (key, value) in local {
        if is_private(key) {
            restored.insert(key.clone(), value.clone());
        } else if let Some(inner) = restored.get_mut(key) {
            keep_private(value, inner);
        }
    }
}

/// The settings a restore writes: the backup's, keeping this machine's secrets and per-machine keys.
fn restore_settings(local: &Value, backup: &Value) -> Value {
    let mut out = backup_settings(backup);
    if !out.is_object() {
        return local.clone();
    }
    keep_private(local, &mut out);
    if let (Some(map), Some(local)) = (out.as_object_mut(), local.as_object()) {
        for key in LOCAL_ONLY {
            if let Some(value) = local.get(*key) {
                map.insert((*key).to_string(), value.clone());
            }
        }
    }
    out
}

/// A backup path as the contract allows it: relative, `/`-separated, 1–6 segments of
/// `[A-Za-z0-9._-]`, never `.` or `..`.
pub fn valid_backup_path(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    (1..=6).contains(&segments.len())
        && segments.iter().all(|s| {
            !s.is_empty()
                && *s != "."
                && *s != ".."
                && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        })
}

/// Whether a backed-up path is one of the files Kimochi keeps, in its data folder's layout.
fn known_backup_file(path: &str) -> bool {
    if !valid_backup_path(path) {
        return false;
    }
    let parts: Vec<&str> = path.split('/').collect();
    matches!(
        parts.as_slice(),
        ["sessions.json" | "presets.json" | "stats.json"]
            | ["sessions", _, "lines.json" | "notebook.json"]
            | ["sessions", _, "images", _]
    )
}

fn session_ids(manifest: &Value) -> Vec<String> {
    manifest
        .get("sessions")
        .and_then(Value::as_array)
        .map(|sessions| {
            sessions
                .iter()
                .filter_map(|s| s.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// `sessions.json` after a restore: the backup's sessions joined to this machine's by id. A
/// session only this machine has stays; one only the backup has is added; one both have takes
/// whichever was changed last (`updatedAt`). Returns the manifest and the ids whose files come
/// from the backup.
fn merge_manifest(local: Option<&Value>, backup: &Value) -> (Value, HashSet<String>) {
    let empty = Vec::new();
    let local_sessions = local
        .and_then(|l| l.get("sessions"))
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let backup_sessions = backup.get("sessions").and_then(Value::as_array).unwrap_or(&empty);
    let by_id = |list: &Vec<Value>| -> HashMap<String, Value> {
        list.iter()
            .filter_map(|s| Some((s.get("id")?.as_str()?.to_string(), s.clone())))
            .collect()
    };
    let backup_by_id = by_id(backup_sessions);
    let updated = |s: &Value| s.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0);
    let mut taken = HashSet::new();
    let mut seen = HashSet::new();
    let mut sessions = Vec::new();
    for session in local_sessions {
        let Some(id) = session.get("id").and_then(Value::as_str) else { continue };
        seen.insert(id.to_string());
        match backup_by_id.get(id) {
            Some(remote) if updated(remote) > updated(session) => {
                taken.insert(id.to_string());
                sessions.push(remote.clone());
            }
            _ => sessions.push(session.clone()),
        }
    }
    for session in backup_sessions {
        let Some(id) = session.get("id").and_then(Value::as_str) else { continue };
        if seen.insert(id.to_string()) {
            taken.insert(id.to_string());
            sessions.push(session.clone());
        }
    }
    let ids: HashSet<&str> = sessions.iter().filter_map(|s| s.get("id")?.as_str()).collect();
    let active = [local, Some(backup)]
        .into_iter()
        .flatten()
        .filter_map(|m| m.get("activeId").and_then(Value::as_str))
        .find(|id| ids.contains(id))
        .map(str::to_string)
        .or_else(|| sessions.first().and_then(|s| s.get("id")?.as_str().map(str::to_string)))
        .unwrap_or_default();
    (json!({ "version": 1, "activeId": active, "sessions": sessions }), taken)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn backup_options() -> (bool, bool) {
    let Some(account) = ACCOUNT.get() else { return (false, false) };
    let Some(service) = account.app.try_state::<Shared>() else { return (false, false) };
    (
        service.settings.get_or("accountBackup.prefs", false),
        service.settings.get_or("accountBackup.sessions", false),
    )
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The preferences document `PUT /api/v1/prefs` takes.
fn prefs_document(account: &Account) -> Result<Value, String> {
    let service = account.app.try_state::<Shared>().ok_or("native: Kimochi is still starting")?;
    Ok(json!({
        "version": 1,
        "settings": backup_settings(&service.settings.all()),
        "presets": read_json(&account.local_dir.join("presets.json")).map(|p| strip_private(&p)),
        "stats": read_json(&account.local_dir.join("stats.json")),
    }))
}

/// The session files to back up, by backup path, from `sessions.json`'s sessions.
fn session_files(local_dir: &Path) -> BTreeMap<String, PathBuf> {
    let mut files = BTreeMap::new();
    let manifest_path = local_dir.join("sessions.json");
    let Some(manifest) = read_json(&manifest_path) else { return files };
    files.insert("sessions.json".to_string(), manifest_path);
    for sid in session_ids(&manifest) {
        if !valid_backup_path(&sid) {
            continue;
        }
        let dir = local_dir.join("sessions").join(&sid);
        for name in ["lines.json", "notebook.json"] {
            if dir.join(name).is_file() {
                files.insert(format!("sessions/{sid}/{name}"), dir.join(name));
            }
        }
        if let Ok(images) = std::fs::read_dir(dir.join("images")) {
            for entry in images.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let path = format!("sessions/{sid}/images/{name}");
                if entry.path().is_file() && valid_backup_path(&path) {
                    files.insert(path, entry.path());
                }
            }
        }
    }
    files
}

/// Cheap: the files' sizes and modification times plus the preferences' hash. Equal to the
/// last backup's means there is nothing to upload.
fn fingerprint(account: &Account, prefs: bool, sessions: bool) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{prefs}{sessions}"));
    if prefs {
        if let Ok(doc) = prefs_document(account) {
            hasher.update(serde_json::to_vec(&doc).unwrap_or_default());
        }
    }
    if sessions {
        for (path, file) in session_files(&account.local_dir) {
            let meta = std::fs::metadata(&file).ok();
            let modified = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            hasher.update(format!("{path}:{}:{modified};", meta.map(|m| m.len()).unwrap_or(0)));
        }
    }
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn progress(phase: &str, done: usize, total: usize, error: Option<&str>) {
    let Some(account) = ACCOUNT.get() else { return };
    let _ = account.app.emit(
        "account-backup",
        json!({ "phase": phase, "done": done, "total": total, "error": error }),
    );
}

struct Running;
impl Running {
    fn claim() -> Result<Self, String> {
        let account = account()?;
        if account.backup_running.swap(true, Ordering::SeqCst) {
            return Err("busy: a backup or restore is already running".into());
        }
        announce();
        Ok(Running)
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        if let Some(account) = ACCOUNT.get() {
            account.backup_running.store(false, Ordering::SeqCst);
        }
        announce();
    }
}

#[derive(Deserialize)]
struct RemoteFile {
    path: String,
    sha256: String,
}

#[derive(Deserialize)]
struct RemoteList {
    files: Vec<RemoteFile>,
}

fn remote_list(http: &reqwest::blocking::Client, base: &str, token: &str) -> Result<RemoteList, String> {
    let response = http
        .get(format!("{base}/api/v1/backup"))
        .bearer_auth(token)
        .send()
        .map_err(|_| OFFLINE.to_string())?;
    if !response.status().is_success() {
        return Err(failure(cloud::Feature::Backup, base, response));
    }
    response
        .json()
        .map_err(|_| "native: Kimochi cloud sent an unreadable backup list".to_string())
}

fn download(http: &reqwest::blocking::Client, base: &str, token: &str, path: &str) -> Result<Vec<u8>, String> {
    let response = http
        .get(format!("{base}/api/v1/backup/files/{path}"))
        .bearer_auth(token)
        .send()
        .map_err(|_| OFFLINE.to_string())?;
    if !response.status().is_success() {
        return Err(failure(cloud::Feature::Backup, base, response));
    }
    response
        .bytes()
        .map(|b| b.to_vec())
        .map_err(|_| "native: a backed-up file could not be downloaded".to_string())
}

fn upload(http: &reqwest::blocking::Client, base: &str, token: &str, path: &str, bytes: Vec<u8>) -> Result<(), String> {
    let response = http
        .put(format!("{base}/api/v1/backup/files/{path}"))
        .bearer_auth(token)
        .header("X-Content-SHA256", sha256_hex(&bytes))
        .header("Content-Type", "application/octet-stream")
        .body(bytes)
        .send()
        .map_err(|_| OFFLINE.to_string())?;
    if !response.status().is_success() {
        return Err(failure(cloud::Feature::Backup, base, response));
    }
    Ok(())
}

/// Back up what the settings ask for, uploading only what changed. `force` (Back up now) skips
/// the "nothing changed since the last backup" shortcut and compares with the server instead.
fn backup_blocking(force: bool) -> Result<Value, String> {
    let account = account()?;
    // The backup belongs to the server it started on, even if the server is switched meanwhile.
    let base = base()?;
    let stored = stored_for(&base).ok_or("invalid: sign in to back up")?;
    let token = stored.token;
    let (prefs, sessions) = backup_options();
    if !prefs && !sessions {
        return Err("invalid: turn on backup of preferences or sessions first".into());
    }
    let print = fingerprint(account, prefs, sessions);
    let mut memo = stored.backup;
    if !force && memo.fingerprint.as_deref() == Some(print.as_str()) {
        return Ok(status_value());
    }
    if force {
        memo.prefs_hash = None;
    }
    let _running = Running::claim()?;
    let result = run_backup(account, &base, &token, prefs, sessions, &memo);
    let finished = now_ms();
    let _ = update(&base, |stored| {
        stored.map(|mut s| {
            match &result {
                Ok(prefs_hash) => {
                    s.backup.last_backup_at = Some(finished);
                    s.backup.last_error = None;
                    s.backup.fingerprint = Some(print.clone());
                    if prefs_hash.is_some() {
                        s.backup.prefs_hash = prefs_hash.clone();
                    }
                }
                Err(e) => s.backup.last_error = Some(e.trim_start_matches("native: ").to_string()),
            }
            s
        })
    });
    match result {
        Ok(_) => {
            progress("done", 1, 1, None);
            usage_changed();
            Ok(status_value())
        }
        Err(e) => {
            progress("error", 0, 0, Some(e.trim_start_matches("native: ")));
            Err(e)
        }
    }
}

/// Returns the preferences hash uploaded (or kept).
fn run_backup(account: &Account, base: &str, token: &str, prefs: bool, sessions: bool, memo: &BackupMemo) -> Result<Option<String>, String> {
    let http = client(Duration::from_secs(120))?;
    progress("scanning", 0, 0, None);
    let mut prefs_hash = None;
    if prefs {
        let doc = prefs_document(account)?;
        let bytes = serde_json::to_vec(&json!({ "prefs": doc })).map_err(|e| e.to_string())?;
        if bytes.len() > PREFS_LIMIT {
            return Err("native: Your preferences are too large to back up (over 256 KB).".into());
        }
        let hash = sha256_hex(&bytes);
        if memo.prefs_hash.as_deref() != Some(hash.as_str()) {
            let response = http
                .put(format!("{base}/api/v1/prefs"))
                .bearer_auth(token)
                .header("Content-Type", "application/json")
                .body(bytes)
                .send()
                .map_err(|_| OFFLINE.to_string())?;
            if !response.status().is_success() {
                return Err(failure(cloud::Feature::Backup, base, response));
            }
        }
        prefs_hash = Some(hash);
    }
    if !sessions {
        progress("uploading", 1, 1, None);
        return Ok(prefs_hash);
    }
    let remote = remote_list(&http, base, token)?;
    let remote: HashMap<String, String> = remote.files.into_iter().map(|f| (f.path, f.sha256)).collect();
    let files = session_files(&account.local_dir);
    // sessions.json goes last, after the files it names, and joined to the backup's own list so
    // a second computer backing up never drops the first one's sessions from it.
    let mut changed: Vec<(String, Vec<u8>)> = Vec::new();
    let mut manifest: Option<Vec<u8>> = None;
    for (path, file) in &files {
        let Ok(meta) = std::fs::metadata(file) else { continue };
        if meta.len() > FILE_LIMIT {
            continue; // the server refuses files over 50 MB; skip rather than fail the rest
        }
        let Ok(bytes) = std::fs::read(file) else { continue };
        if path == "sessions.json" {
            manifest = Some(bytes);
            continue;
        }
        if remote.get(path).map(String::as_str) != Some(sha256_hex(&bytes).as_str()) {
            changed.push((path.clone(), bytes));
        }
    }
    if let Some(local) = manifest {
        let local_value: Option<Value> = serde_json::from_slice(&local).ok();
        let merged = match (remote.get("sessions.json"), local_value) {
            (Some(remote_hash), Some(local_value)) if *remote_hash != sha256_hex(&local) => {
                let remote_manifest = download(&http, base, token, "sessions.json")
                    .ok()
                    .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
                match remote_manifest {
                    Some(remote_manifest) => {
                        let mut joined = union_manifest(&local_value, &remote_manifest);
                        if let Some(active) = local_value.get("activeId") {
                            joined["activeId"] = active.clone();
                        }
                        serde_json::to_vec(&joined).unwrap_or(local)
                    }
                    None => local,
                }
            }
            _ => local,
        };
        if remote.get("sessions.json").map(String::as_str) != Some(sha256_hex(&merged).as_str()) {
            changed.push(("sessions.json".into(), merged));
        }
    }
    let total = changed.len();
    progress("uploading", 0, total, None);
    for (done, (path, bytes)) in changed.into_iter().enumerate() {
        upload(&http, base, token, &path, bytes)?;
        progress("uploading", done + 1, total, None);
    }
    Ok(prefs_hash)
}

/// Both lists' sessions; this computer's copy wins where both have one.
fn union_manifest(local: &Value, remote: &Value) -> Value {
    let mut sessions: Vec<Value> = local.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
    let ids: HashSet<String> = session_ids(local).into_iter().collect();
    for session in remote.get("sessions").and_then(Value::as_array).into_iter().flatten() {
        if session.get("id").and_then(Value::as_str).is_some_and(|id| !ids.contains(id)) {
            sessions.push(session.clone());
        }
    }
    let mut out = local.clone();
    out["sessions"] = Value::Array(sessions);
    out
}

#[tauri::command]
pub async fn account_backup_now() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| backup_blocking(true))
        .await
        .map_err(|e| e.to_string())?
}

/// Every minute: once the data folder has changed since the last backup and then stayed the
/// same for two minutes (or fifteen minutes have passed with changes), back it up.
fn spawn_auto_backup() {
    std::thread::spawn(|| {
        let mut seen: Option<String> = None;
        let mut settled_since = Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(60));
            let Some(account) = ACCOUNT.get() else { continue };
            let (prefs, sessions) = backup_options();
            // The server in use now: its sign-in and its memo of the last backup.
            let Some(stored) = base().ok().and_then(|base| stored_for(&base)) else { continue };
            if !(prefs || sessions) || account.backup_running.load(Ordering::SeqCst) {
                continue;
            }
            let print = fingerprint(account, prefs, sessions);
            let memo = stored.backup;
            if memo.fingerprint.as_deref() == Some(print.as_str()) {
                seen = Some(print);
                continue;
            }
            if seen.as_deref() != Some(print.as_str()) {
                seen = Some(print);
                settled_since = Instant::now();
                let overdue = memo
                    .last_backup_at
                    .is_none_or(|at| now_ms().saturating_sub(at) >= 15 * 60 * 1000);
                if !overdue {
                    continue;
                }
            } else if settled_since.elapsed() < Duration::from_secs(110) {
                continue;
            }
            let _ = backup_blocking(false);
        }
    });
}

// ---------------------------------------------------------------- restore

/// Download the backup into a staging folder, then restart: the webviews hold the Log's data in
/// memory, so the files are put in place at the next launch, before any window opens.
#[tauri::command]
pub async fn account_restore(app: AppHandle, prefs: bool, sessions: bool) -> Result<(), String> {
    if !prefs && !sessions {
        return Err("invalid: choose preferences, sessions or both to restore".into());
    }
    tauri::async_runtime::spawn_blocking(move || restore_blocking(prefs, sessions))
        .await
        .map_err(|e| e.to_string())??;
    progress("restarting", 1, 1, None);
    std::thread::sleep(Duration::from_millis(600));
    crate::shutdown_platform();
    app.restart();
}

fn restore_blocking(prefs: bool, sessions: bool) -> Result<(), String> {
    let account = account()?;
    let base = base()?;
    let token = token_for(&base).ok_or("invalid: sign in to restore a backup")?;
    let _running = Running::claim()?;
    let result = (|| -> Result<(), String> {
        let http = client(Duration::from_secs(120))?;
        let staging = account.local_dir.join(RESTORE_DIR);
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(staging.join("files")).map_err(|e| e.to_string())?;
        progress("downloading", 0, 0, None);
        let mut found = false;
        if prefs {
            let response = http
                .get(format!("{base}/api/v1/prefs"))
                .bearer_auth(&token)
                .send()
                .map_err(|_| OFFLINE.to_string())?;
            match response.status().as_u16() {
                404 => {}
                s if (200..300).contains(&s) => {
                    let body: Value = response.json().map_err(|_| "native: the backed-up preferences are unreadable")?;
                    let doc = body.get("prefs").cloned().unwrap_or(Value::Null);
                    if doc.is_object() {
                        std::fs::write(staging.join("prefs.json"), serde_json::to_vec(&doc).map_err(|e| e.to_string())?)
                            .map_err(|e| e.to_string())?;
                        found = true;
                    }
                }
                _ => return Err(failure(cloud::Feature::Backup, &base, response)),
            }
        }
        if sessions {
            let list = remote_list(&http, &base, &token)?;
            let wanted: Vec<RemoteFile> = list
                .files
                .into_iter()
                .filter(|f| known_backup_file(&f.path) && (f.path == "sessions.json" || f.path.starts_with("sessions/")))
                .collect();
            let total = wanted.len();
            progress("downloading", 0, total, None);
            for (done, file) in wanted.iter().enumerate() {
                let bytes = download(&http, &base, &token, &file.path)?;
                if !sha256_hex(&bytes).eq_ignore_ascii_case(&file.sha256) {
                    return Err(format!("native: {} did not download intact; try again.", file.path));
                }
                let target = staged_path(&staging.join("files"), &file.path);
                if let Some(dir) = target.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
                progress("downloading", done + 1, total, None);
            }
            found |= total > 0;
        }
        if !found {
            let _ = std::fs::remove_dir_all(&staging);
            return Err("invalid: there is no backup to restore yet".into());
        }
        std::fs::write(
            staging.join(RESTORE_MARKER),
            serde_json::to_vec(&json!({ "prefs": prefs, "sessions": sessions, "at": now_ms() })).unwrap_or_default(),
        )
        .map_err(|e| e.to_string())
    })();
    if let Err(e) = &result {
        progress("error", 0, 0, Some(e.trim_start_matches("native: ")));
    }
    result
}

/// `root` joined with an already validated backup path.
fn staged_path(root: &Path, path: &str) -> PathBuf {
    path.split('/').fold(root.to_path_buf(), |dir, part| dir.join(part))
}

/// Put a downloaded restore in place. Runs at launch, before `settings.json` is loaded and before
/// any window exists. A failure leaves the staging folder renamed for inspection and the data
/// folder as it was where the failure happened.
pub fn apply_pending_restore(data_dir: &Path, local_dir: &Path) {
    let staging = local_dir.join(RESTORE_DIR);
    if !staging.join(RESTORE_MARKER).is_file() {
        if staging.exists() {
            let _ = std::fs::remove_dir_all(&staging); // an interrupted download
        }
        return;
    }
    match apply_restore(&staging, data_dir, local_dir) {
        Ok(()) => {
            let _ = std::fs::remove_dir_all(&staging);
        }
        Err(e) => {
            eprintln!("account: the restore could not be applied: {e}");
            let _ = std::fs::rename(&staging, local_dir.join(format!("restore-failed-{}", now_ms())));
        }
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("restore-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn apply_restore(staging: &Path, data_dir: &Path, local_dir: &Path) -> Result<(), String> {
    if let Some(doc) = read_json(&staging.join("prefs.json")) {
        if let Some(backup) = doc.get("settings").filter(|s| s.is_object()) {
            let file = data_dir.join("settings.json");
            let local = read_json(&file).unwrap_or_else(|| Value::Object(Map::new()));
            let merged = restore_settings(&local, backup);
            write_atomic(&file, &serde_json::to_vec(&merged).map_err(|e| e.to_string())?)?;
        }
        for name in ["presets", "stats"] {
            let Some(value) = doc.get(name).filter(|v| v.is_object()) else { continue };
            let mut value = value.clone();
            if name == "presets" {
                // Presets are stored without secrets; keep the local file's, if any.
                if let Some(local) = read_json(&local_dir.join("presets.json")) {
                    keep_private(&local, &mut value);
                }
            }
            write_atomic(
                &local_dir.join(format!("{name}.json")),
                &serde_json::to_vec(&value).map_err(|e| e.to_string())?,
            )?;
        }
    }
    let files = staging.join("files");
    let Some(backup_manifest) = read_json(&files.join("sessions.json")) else { return Ok(()) };
    let local_manifest = read_json(&local_dir.join("sessions.json"));
    let (merged, taken) = merge_manifest(local_manifest.as_ref(), &backup_manifest);
    for sid in &taken {
        if !valid_backup_path(sid) {
            continue;
        }
        let from = files.join("sessions").join(sid);
        if !from.is_dir() {
            continue;
        }
        let to = local_dir.join("sessions").join(sid);
        for name in ["lines.json", "notebook.json"] {
            if from.join(name).is_file() {
                let bytes = std::fs::read(from.join(name)).map_err(|e| e.to_string())?;
                write_atomic(&to.join(name), &bytes)?;
            }
        }
        std::fs::create_dir_all(to.join("images")).map_err(|e| e.to_string())?;
        if let Ok(images) = std::fs::read_dir(from.join("images")) {
            for entry in images.flatten() {
                let bytes = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
                write_atomic(&to.join("images").join(entry.file_name()), &bytes)?;
            }
        }
    }
    // A session the backup lists without files gets empty ones, as a new session would.
    if let Some(sessions) = merged.get("sessions").and_then(Value::as_array) {
        for sid in sessions.iter().filter_map(|s| s.get("id")?.as_str()) {
            if !valid_backup_path(sid) {
                continue;
            }
            let dir = local_dir.join("sessions").join(sid);
            if !dir.join("lines.json").exists() {
                write_atomic(&dir.join("lines.json"), br#"{"version":1,"lines":[]}"#)?;
            }
            let _ = std::fs::create_dir_all(dir.join("images"));
        }
    }
    write_atomic(
        &local_dir.join("sessions.json"),
        &serde_json::to_vec(&merged).map_err(|e| e.to_string())?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_stripped_at_any_depth() {
        let settings = json!({
            "appearance": "dark",
            "hotkeys": { "scan": { "accelerator": "Cmd+J" } },
            "superTexthooker": { "deeplApiKey": "secret-1", "ankiConnectKey": "secret-2", "fontSizePx": 16 },
            "capture": { "portalRestoreToken": "t" },
            "voice": { "apiKey": "x", "voiceId": "keep" },
            "windowPositions": { "log": [1, 2] },
            "scannedTextHistory": ["a"],
        });
        let out = backup_settings(&settings);
        let text = out.to_string();
        for secret in ["secret-1", "secret-2", "portalRestoreToken", "apiKey"] {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        assert_eq!(out["superTexthooker"]["fontSizePx"], 16);
        assert_eq!(out["voice"]["voiceId"], "keep");
        assert_eq!(out["hotkeys"]["scan"]["accelerator"], "Cmd+J", "hotkeys is not a key");
        assert!(out.get("windowPositions").is_none());
        assert!(out.get("scannedTextHistory").is_none());
    }

    #[test]
    fn a_restore_keeps_this_machines_secrets_and_places() {
        let local = json!({
            "superTexthooker": { "deeplApiKey": "mine", "fontSizePx": 14 },
            "windowPositions": { "log": [5, 5] },
            "appearance": "light",
        });
        let backup = json!({
            "superTexthooker": { "deeplApiKey": "", "fontSizePx": 20 },
            "windowPositions": { "log": [9, 9] },
            "appearance": "dark",
        });
        let out = restore_settings(&local, &backup);
        assert_eq!(out["superTexthooker"]["deeplApiKey"], "mine");
        assert_eq!(out["superTexthooker"]["fontSizePx"], 20);
        assert_eq!(out["appearance"], "dark");
        assert_eq!(out["windowPositions"]["log"], json!([5, 5]));
    }

    #[test]
    fn backup_paths_follow_the_contract() {
        for ok in ["sessions.json", "sessions/abc-123/lines.json", "sessions/a/images/x_1.png", "a/b/c/d/e/f"] {
            assert!(valid_backup_path(ok), "{ok}");
        }
        for bad in ["", "/abs", "a//b", "../x", "sessions/../x", "a/./b", "a b", "a/b/c/d/e/f/g", "é", "a\\b", "x/"] {
            assert!(!valid_backup_path(bad), "{bad}");
        }
        assert!(known_backup_file("sessions/s1/notebook.json"));
        assert!(known_backup_file("sessions/s1/images/1.png"));
        assert!(!known_backup_file("settings.json"));
        assert!(!known_backup_file("sessions/s1/other.json"));
        assert!(!known_backup_file("sessions/s1/images/deeper/x.png"));
    }

    #[test]
    fn restored_sessions_merge_by_id() {
        let local = json!({
            "version": 1,
            "activeId": "only-local",
            "sessions": [
                { "id": "only-local", "updatedAt": 5 },
                { "id": "both-newer-here", "updatedAt": 50 },
                { "id": "both-newer-there", "updatedAt": 10 },
            ]
        });
        let backup = json!({
            "version": 1,
            "activeId": "only-backup",
            "sessions": [
                { "id": "both-newer-here", "updatedAt": 40, "name": "backup" },
                { "id": "both-newer-there", "updatedAt": 20, "name": "backup" },
                { "id": "only-backup", "updatedAt": 1 },
            ]
        });
        let (merged, taken) = merge_manifest(Some(&local), &backup);
        let ids: Vec<&str> = merged["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["only-local", "both-newer-here", "both-newer-there", "only-backup"]);
        assert_eq!(merged["activeId"], "only-local");
        assert_eq!(merged["sessions"][2]["name"], "backup");
        assert!(merged["sessions"][1].get("name").is_none(), "the newer local copy stays");
        let mut taken: Vec<_> = taken.into_iter().collect();
        taken.sort();
        assert_eq!(taken, ["both-newer-there", "only-backup"]);

        let (fresh, taken) = merge_manifest(None, &backup);
        assert_eq!(fresh["activeId"], "only-backup");
        assert_eq!(taken.len(), 3);
    }

    #[test]
    fn a_backup_never_drops_another_computers_sessions() {
        let local = json!({ "version": 1, "activeId": "a", "sessions": [{ "id": "a", "name": "here" }] });
        let remote = json!({ "version": 1, "activeId": "b", "sessions": [{ "id": "a", "name": "there" }, { "id": "b" }] });
        let out = union_manifest(&local, &remote);
        assert_eq!(out["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(out["sessions"][0]["name"], "here");
        assert_eq!(out["activeId"], "a");
    }

    #[test]
    fn deep_links_name_the_account_page() {
        assert_eq!(deep_link_page("kimochi://account"), Some("account"));
        assert_eq!(deep_link_page("kimochi:///account?x=1"), Some("account"));
        assert_eq!(deep_link_page("kimochi://account/devices"), Some("account"));
        assert_eq!(deep_link_page("kimochi://"), Some(""));
        assert_eq!(deep_link_page("https://account"), None);
    }

    #[test]
    fn a_restore_is_applied_from_staging() {
        let root = std::env::temp_dir().join(format!("kimochi-restore-test-{}", now_ms()));
        let (data, local) = (root.join("data"), root.join("local"));
        let staging = local.join(RESTORE_DIR);
        std::fs::create_dir_all(staging.join("files/sessions/s2/images")).unwrap();
        std::fs::create_dir_all(local.join("sessions/s1")).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("settings.json"), r#"{"superTexthooker":{"deeplApiKey":"k"},"appearance":"light"}"#).unwrap();
        std::fs::write(local.join("sessions.json"), r#"{"version":1,"activeId":"s1","sessions":[{"id":"s1","updatedAt":1}]}"#).unwrap();
        std::fs::write(local.join("sessions/s1/lines.json"), "local").unwrap();
        std::fs::write(
            staging.join("prefs.json"),
            r#"{"version":1,"settings":{"appearance":"dark","superTexthooker":{}},"stats":{"version":1}}"#,
        )
        .unwrap();
        std::fs::write(staging.join("files/sessions.json"), r#"{"version":1,"activeId":"s2","sessions":[{"id":"s2","updatedAt":3}]}"#).unwrap();
        std::fs::write(staging.join("files/sessions/s2/lines.json"), "restored").unwrap();
        std::fs::write(staging.join("files/sessions/s2/images/a.png"), "png").unwrap();
        std::fs::write(staging.join(RESTORE_MARKER), "{}").unwrap();

        apply_pending_restore(&data, &local);

        let settings = read_json(&data.join("settings.json")).unwrap();
        assert_eq!(settings["appearance"], "dark");
        assert_eq!(settings["superTexthooker"]["deeplApiKey"], "k");
        assert_eq!(read_json(&local.join("stats.json")).unwrap()["version"], 1);
        let manifest = read_json(&local.join("sessions.json")).unwrap();
        assert_eq!(manifest["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(manifest["activeId"], "s1");
        assert_eq!(std::fs::read_to_string(local.join("sessions/s1/lines.json")).unwrap(), "local");
        assert_eq!(std::fs::read_to_string(local.join("sessions/s2/lines.json")).unwrap(), "restored");
        assert_eq!(std::fs::read_to_string(local.join("sessions/s2/images/a.png")).unwrap(), "png");
        assert!(!staging.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn each_server_keeps_its_own_account_file() {
        // Kimochi cloud keeps the file every earlier version wrote, so a sign-in carries over.
        assert_eq!(file_name(settings::CLOUD_SERVER), FILE);
        assert_eq!(file_name(settings::LOCAL_SERVER), LOCAL_FILE);
        assert_ne!(file_name(settings::CLOUD_SERVER), file_name(settings::LOCAL_SERVER));
        // Any other base gets a stable name of its own, never one of the two above.
        let other = file_name("http://127.0.0.1:8787");
        assert_eq!(other, file_name("http://127.0.0.1:8787"));
        assert!(other.starts_with("account-") && other.ends_with(".json"));
        assert_ne!(other, FILE);
        assert_ne!(other, LOCAL_FILE);
        assert_ne!(other, file_name("http://127.0.0.1:8788"));
    }

    #[test]
    fn the_slot_follows_the_server_base() {
        let dir = std::env::temp_dir().join(format!("kimochi-account-slots-{}", now_ms()));
        let cloud = Stored { token: "kmc_cloud".into(), ..Default::default() };
        let local = Stored { token: "kmc_local".into(), ..Default::default() };
        persist(Some(&cloud), &dir.join(FILE)).unwrap();
        persist(Some(&local), &dir.join(LOCAL_FILE)).unwrap();
        let slot = Mutex::new(Slot { file: PathBuf::new(), stored: None });
        let token = |base: &str| {
            let mut slot = lock(&slot);
            select(&mut slot, &dir, base);
            slot.stored.as_ref().map(|s| s.token.clone())
        };
        assert_eq!(token(settings::CLOUD_SERVER).as_deref(), Some("kmc_cloud"));
        assert_eq!(token(settings::LOCAL_SERVER).as_deref(), Some("kmc_local"));
        assert_eq!(token(settings::CLOUD_SERVER).as_deref(), Some("kmc_cloud"));
        // Signing out of one server leaves the other's sign-in alone.
        std::fs::remove_file(dir.join(LOCAL_FILE)).unwrap();
        assert_eq!(token(settings::LOCAL_SERVER), None);
        assert_eq!(token(settings::CLOUD_SERVER).as_deref(), Some("kmc_cloud"));
        // A base with no file is signed out.
        assert_eq!(token("http://127.0.0.1:8787"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_account_file_is_private() {
        let dir = std::env::temp_dir().join(format!("kimochi-account-test-{}", now_ms()));
        let file = dir.join(FILE);
        let stored = Stored { token: "kmc_test".into(), ..Default::default() };
        persist(Some(&stored), &file).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        persist(None, &file).unwrap();
        assert!(!file.exists());
        persist(None, &file).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
