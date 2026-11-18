//! Games that run as administrator (#216).
//!
//! Windows' User Interface Privilege Isolation hides an elevated window's input from every
//! process with fewer rights: while such a game is in front, `GetAsyncKeyState` reads Shift as up
//! and the low-level keyboard hook receives nothing (platform/windows/mod.rs `cursor`), so the
//! overlay's Shift gate never opens and its words stay click-through. Genshin Impact, among
//! others, always runs elevated. Kimochi cannot read those keys from below, so when the chosen
//! source belongs to an elevated process it offers to start again as administrator
//! (`relaunch_elevated`), which reads them like any other window's.
//!
//! The check runs when a source is chosen (`notify`, from `commit_source`, the command line and
//! the startup restore) and, for a display source, after a scan for the window in front
//! (`notify_foreground`). The main window asks `source_elevation` for the answer, also on
//! load, so a restore that finished before the page listened is still shown.

use serde_json::{json, Value};

/// Settings key: application names the reader told not to ask about again.
pub const SKIP_KEY: &str = "elevationPromptSkipped";

/// What Kimochi can tell about a process's rights relative to its own. Only Windows tells
/// them apart; elsewhere everything is `Unknown`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rights {
    /// Its token says it is elevated.
    Elevated,
    /// Its token is closed to us, though it runs in our session: higher rights than ours
    /// (elevated, or a protected process), which hide its input just the same.
    Locked,
    /// Same rights as ours (or fewer).
    Same,
    /// Gone, another session, or nothing to go on.
    Unknown,
}

impl Rights {
    fn as_str(self) -> &'static str {
        match self {
            Rights::Elevated => "elevated",
            Rights::Locked => "locked",
            Rights::Same => "same",
            Rights::Unknown => "unknown",
        }
    }
    fn above_ours(self) -> bool {
        matches!(self, Rights::Elevated | Rights::Locked)
    }
}

/// How the token query went, for [`classify`]. Read only on Windows (and in the tests).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenRead {
    Elevated(bool),
    Denied,
    Failed,
}

/// A process's rights from what Windows answered about it. `opened`: the process could be
/// opened at all (`PROCESS_QUERY_LIMITED_INFORMATION`, which an elevated process grants).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn classify(opened: bool, token: TokenRead, same_session: bool) -> Rights {
    if !opened {
        return Rights::Unknown;
    }
    match token {
        TokenRead::Elevated(true) => Rights::Elevated,
        TokenRead::Elevated(false) => Rights::Same,
        TokenRead::Denied if same_session => Rights::Locked,
        _ => Rights::Unknown,
    }
}

/// Whether to offer the restart: the source has more rights than Kimochi, Kimochi is not
/// already elevated, and the reader has not said no for this application.
pub fn should_offer(self_elevated: bool, rights: Rights, skipped: bool) -> bool {
    !self_elevated && rights.above_ours() && !skipped
}

/// Whether `app` is in the "don't ask again" list (matched without case).
pub fn is_skipped(list: &[String], app: &str) -> bool {
    !app.is_empty() && list.iter().any(|name| name.eq_ignore_ascii_case(app))
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{classify, Rights, TokenRead};
    use windows::core::PWSTR;
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, ERROR_CANCELLED, HANDLE, HWND, WAIT_TIMEOUT};
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
        WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, SW_SHOWNORMAL};

    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    fn token_elevated(process: HANDLE) -> TokenRead {
        let mut token = HANDLE::default();
        if let Err(error) = unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } {
            return if error.code() == ERROR_ACCESS_DENIED.to_hresult() {
                TokenRead::Denied
            } else {
                TokenRead::Failed
            };
        }
        let token = Owned(token);
        let mut elevation = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let read = unsafe {
            GetTokenInformation(
                token.0,
                TokenElevation,
                Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            )
        };
        match read {
            Ok(()) => TokenRead::Elevated(elevation.TokenIsElevated != 0),
            Err(_) => TokenRead::Failed,
        }
    }

    fn session_of(pid: u32) -> Option<u32> {
        let mut session = 0u32;
        unsafe { ProcessIdToSessionId(pid, &mut session) }.ok().map(|()| session)
    }

    pub fn self_elevated() -> bool {
        matches!(token_elevated(unsafe { GetCurrentProcess() }), TokenRead::Elevated(true))
    }

    pub fn process_rights(pid: u32) -> Rights {
        if pid == 0 || pid == std::process::id() {
            return Rights::Unknown;
        }
        let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
            return classify(false, TokenRead::Failed, false);
        };
        let process = Owned(process);
        let token = token_elevated(process.0);
        let same_session = session_of(pid).is_some_and(|s| Some(s) == session_of(unsafe { GetCurrentProcessId() }));
        classify(true, token, same_session)
    }

    /// Its image file stem (`GenshinImpact`), the name `lastSelectedSource.appName` uses.
    pub fn process_name(pid: u32) -> Option<String> {
        let process = Owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?);
        let mut buf = vec![0u16; 1024];
        let mut size = buf.len() as u32;
        unsafe { QueryFullProcessImageNameW(process.0, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size) }
            .ok()?;
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        let file = path.rsplit(['\\', '/']).next().unwrap_or(&path);
        let stem = file.rsplit_once('.').map_or(file, |(stem, _)| stem);
        (!stem.is_empty()).then(|| stem.to_string())
    }

    /// The process that owns the window in front, if it is not Kimochi's.
    pub fn foreground_pid() -> Option<u32> {
        let window: HWND = unsafe { GetForegroundWindow() };
        if window.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
        (pid != 0 && pid != std::process::id()).then_some(pid)
    }

    /// Start this executable again as administrator. Windows shows its consent prompt; `Ok`
    /// once the new copy is running, `Err("cancelled: …")` when the reader declined it.
    pub fn launch_elevated() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| format!("native: {e}"))?;
        let file = HSTRING::from(exe.as_os_str());
        let params = HSTRING::from(format!("{}={}", super::RELAUNCH_FLAG, std::process::id()));
        let verb = HSTRING::from("runas");
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOASYNC,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        match unsafe { ShellExecuteExW(&mut info) } {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERROR_CANCELLED.to_hresult() => {
                Err("cancelled: Windows did not give Kimochi administrator rights".into())
            }
            Err(error) => Err(format!("native: could not restart as administrator: {error}")),
        }
    }

    /// Wait (bounded) for the copy that started this one to exit, so the single-instance
    /// check below finds no other copy and does not hand this launch back to it.
    pub fn wait_for_exit(pid: u32, limit: std::time::Duration) {
        let Ok(process) = (unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }) else {
            return;
        };
        let process = Owned(process);
        let waited = unsafe { WaitForSingleObject(process.0, limit.as_millis() as u32) };
        if waited == WAIT_TIMEOUT {
            eprintln!("kimochi: the previous copy (pid {pid}) is still running; starting anyway");
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::Rights;
    pub fn self_elevated() -> bool {
        false
    }
    pub fn process_rights(_pid: u32) -> Rights {
        Rights::Unknown
    }
    pub fn foreground_pid() -> Option<u32> {
        None
    }
    pub fn process_name(_pid: u32) -> Option<String> {
        None
    }
    pub fn launch_elevated() -> Result<(), String> {
        Err("not applicable: only Windows runs games as administrator this way".into())
    }
    pub fn wait_for_exit(_pid: u32, _limit: std::time::Duration) {}
}

pub use imp::launch_elevated;

/// The argument an elevated restart carries: `--elevated-relaunch=<pid of the copy it replaces>`.
pub const RELAUNCH_FLAG: &str = "--elevated-relaunch";

/// In `main`, before the single-instance plugin: a copy started by `relaunch_elevated` waits for
/// the one it replaces to quit (which it does as soon as this one is running).
pub fn wait_for_previous_copy() {
    let pid = std::env::args()
        .skip(1)
        .find_map(|arg| arg.strip_prefix(RELAUNCH_FLAG)?.strip_prefix('=')?.parse::<u32>().ok());
    if let Some(pid) = pid {
        imp::wait_for_exit(pid, std::time::Duration::from_secs(15));
    }
}

/// The current source's rights, for the main window (`source_elevation`):
/// `{sourceId, kind, name, app, rights, selfElevated, skipped, offer}`. A display source is
/// judged by the window in front.
pub fn status(service: &crate::state::Service) -> Value {
    let self_elevated = imp::self_elevated();
    let selection = service.selection.lock().unwrap().clone();
    let saved = service.settings.get("lastSelectedSource").ok().flatten().unwrap_or(Value::Null);
    let skipped_list: Vec<String> = service.settings.get_or(SKIP_KEY, Vec::new());
    let Some(source_id) = selection else {
        return json!({ "sourceId": null, "selfElevated": self_elevated, "offer": false });
    };
    let parsed = kimochi_capture::SourceId::parse(&source_id);
    let window = parsed.as_ref().is_some_and(|id| id.is_window());
    let (pid, kind) =
        if window { (parsed.as_ref().and_then(|id| id.pid()), "window") } else { (imp::foreground_pid(), "display") };
    let rights = pid.map_or(Rights::Unknown, imp::process_rights);
    let app = if window {
        saved.get("appName").and_then(Value::as_str).map(str::to_string)
    } else {
        pid.and_then(imp::process_name)
    }
    .unwrap_or_default();
    let name = if window { saved.get("name").and_then(Value::as_str).unwrap_or(&app).to_string() } else { app.clone() };
    let skipped = is_skipped(&skipped_list, &app);
    json!({
        "sourceId": source_id,
        "kind": kind,
        "name": name,
        "app": app,
        "rights": rights.as_str(),
        "selfElevated": self_elevated,
        "skipped": skipped,
        "offer": should_offer(self_elevated, rights, skipped),
    })
}

/// Tell the main window when the chosen source runs with more rights than Kimochi, and bring
/// the window forward so the reader sees the offer.
pub fn notify(app: &tauri::AppHandle, service: &crate::state::Shared) {
    if !cfg!(target_os = "windows") {
        return;
    }
    let status = status(service);
    crate::record(app, service, json!({ "check": "source-elevation", "status": status.clone() }));
    if status["offer"] != json!(true) {
        return;
    }
    use tauri::Emitter;
    let _ = app.emit_to(crate::panels::MAIN, "source-elevation", status);
    let settings = service.settings.clone();
    crate::panels::with_panel(app, crate::panels::MAIN, move |app, turn| {
        let _ = crate::panels::act(turn, app, &settings, crate::panels::MAIN, "show", None);
    });
}

/// After a scan of a display source: the same offer for the window in front, once per
/// application each run (a display shows whatever is in front, which changes all the time).
pub fn notify_foreground(app: &tauri::AppHandle, service: &crate::state::Shared) {
    use std::collections::HashSet;
    use std::sync::Mutex;
    static ASKED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    if !cfg!(target_os = "windows") {
        return;
    }
    let is_display = service
        .selection
        .lock()
        .unwrap()
        .as_deref()
        .and_then(kimochi_capture::SourceId::parse)
        .is_some_and(|id| id.is_display());
    if !is_display {
        return;
    }
    let Some(pid) = imp::foreground_pid() else { return };
    if !imp::process_rights(pid).above_ours() || imp::self_elevated() {
        return;
    }
    let name = imp::process_name(pid).unwrap_or_default();
    if !ASKED.lock().unwrap().get_or_insert_with(HashSet::new).insert(name) {
        return;
    }
    notify(app, service);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_readable_token_decides() {
        assert_eq!(classify(true, TokenRead::Elevated(true), true), Rights::Elevated);
        assert_eq!(classify(true, TokenRead::Elevated(false), true), Rights::Same);
    }

    #[test]
    fn a_closed_token_in_our_session_means_more_rights() {
        assert_eq!(classify(true, TokenRead::Denied, true), Rights::Locked);
        // Another session (a service): its input is not the reader's game.
        assert_eq!(classify(true, TokenRead::Denied, false), Rights::Unknown);
        assert_eq!(classify(false, TokenRead::Denied, true), Rights::Unknown);
        assert_eq!(classify(true, TokenRead::Failed, true), Rights::Unknown);
    }

    #[test]
    fn the_offer_needs_higher_rights_an_unelevated_kimochi_and_no_skip() {
        assert!(should_offer(false, Rights::Elevated, false));
        assert!(should_offer(false, Rights::Locked, false));
        assert!(!should_offer(true, Rights::Elevated, false));
        assert!(!should_offer(false, Rights::Same, false));
        assert!(!should_offer(false, Rights::Unknown, false));
        assert!(!should_offer(false, Rights::Elevated, true));
    }

    #[test]
    fn skipped_apps_match_without_case() {
        let list = vec!["GenshinImpact".to_string()];
        assert!(is_skipped(&list, "genshinimpact"));
        assert!(!is_skipped(&list, "StarRail"));
        assert!(!is_skipped(&list, ""));
    }
}
