//! "Keep the mouse cursor visible in games" (Windows): many games hide the system cursor
//! (`ShowCursor(FALSE)`, `SetCursor(NULL)`, a blank cursor), so a reader cannot see where the
//! pointer is for a hover lookup. With the setting on, Kimochi loads its cursor hook
//! (`voicehook/cursor`, `kimochi-cursorhook-<arch>.dll`) into the selected game window's process
//! and holds the named event `Local\kimochi_cursor_<pid>`; the hook keeps the cursor showing while
//! the event exists. Turned off, another window selected, or Kimochi quit: the event is closed and
//! the game hides its cursor again as it meant to (the DLL stays loaded, idle, until the game exits).
//!
//! The game is the selected capture window only, never whatever is in front, and the setting
//! applies to it alone. Each game process is injected at most once per run: a refusal (a
//! protected or elevated game) is reported and not retried for that process.
use serde_json::{json, Value};
use std::sync::Mutex;

/// The setting (machine-local, off by default).
#[cfg_attr(not(windows), allow(dead_code))]
pub const SETTING: &str = "showGameCursor";

#[derive(Default)]
struct State {
    /// The game whose cursor is kept visible now, and our handle to its event.
    held: Option<(u32, usize)>,
    /// Game processes the hook was loaded into (or refused by), this run.
    #[cfg_attr(not(windows), allow(dead_code))]
    tried: Vec<u32>,
    /// Why the hook could not be loaded into the current game, for Settings.
    error: Option<String>,
}
static STATE: Mutex<State> = Mutex::new(State { held: None, tried: Vec::new(), error: None });

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Settings → the cursor row: whether this build can do it, and what happened.
#[tauri::command]
pub fn game_cursor_status() -> Value {
    let state = state();
    json!({
        "supported": cfg!(windows),
        "active": state.held.map(|(pid, _)| pid),
        "error": state.error,
    })
}

/// Starts following the setting and the selected window (Windows only).
pub fn start(app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        let app = app.clone();
        std::thread::Builder::new()
            .name("game-cursor".into())
            .spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                windows::tick(&app);
            })
            .ok();
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// The selected window's process, when it is a Windows window still open as that process.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn selected_pid(selection: Option<&str>, window_open: &dyn Fn(&kimochi_capture::SourceId) -> bool) -> Option<u32> {
    use kimochi_capture::{Platform, SourceId};
    let id = SourceId::parse(selection?)?;
    match &id {
        SourceId::Window { platform: Platform::Windows, pid: Some(pid), .. }
            if *pid != std::process::id() && *pid > 4 && window_open(&id) =>
        {
            Some(*pid)
        }
        _ => None,
    }
}

#[cfg(windows)]
mod windows {
    use super::{selected_pid, state, SETTING};
    use std::os::windows::process::CommandExt;
    use tauri::Manager;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Threading::CreateEventW;

    fn wanted(app: &tauri::AppHandle) -> Option<u32> {
        let shared = app.try_state::<crate::state::Shared>()?;
        if !shared.settings.get_or(SETTING, false) {
            return None;
        }
        let selection = shared.selection.lock().ok()?.clone();
        selected_pid(selection.as_deref(), &|id| crate::platform::window_bounds(id).is_some())
    }

    fn close(event: usize) {
        unsafe {
            let _ = CloseHandle(HANDLE(event as *mut _));
        }
    }

    pub fn tick(app: &tauri::AppHandle) {
        let want = wanted(app);
        let mut s = state();
        if let Some((pid, event)) = s.held {
            if want == Some(pid) {
                return;
            }
            close(event);
            s.held = None;
            s.error = None;
        }
        let Some(pid) = want else { return };
        // Never load anything into a game Kimochi has paused; the next tick tries again.
        if crate::game_pause::app::holds_pid(pid) {
            return;
        }
        let name: Vec<u16> = format!("Local\\kimochi_cursor_{pid}").encode_utf16().chain([0]).collect();
        let Ok(event) = (unsafe { CreateEventW(None, true, false, PCWSTR(name.as_ptr())) }) else {
            return;
        };
        s.held = Some((pid, event.0 as usize));
        if s.tried.contains(&pid) {
            return;
        }
        s.tried.push(pid);
        drop(s);
        let result = inject(app, pid);
        if let Some(shared) = app.try_state::<crate::state::Shared>() {
            crate::record(
                app,
                &shared,
                serde_json::json!({"check": "game-cursor", "pid": pid, "ok": result.is_ok(), "error": result.as_ref().err()}),
            );
        }
        if let Err(e) = result {
            let mut s = state();
            if let Some((held, event)) = s.held {
                if held == pid {
                    close(event);
                    s.held = None;
                }
            }
            s.error = Some(e);
        }
    }

    /// Loads the cursor hook into `pid` with the text hook helper of its bitness, from a staged
    /// copy (as the voice hook is, so updating Kimochi never finds the DLL locked by a game).
    fn inject(app: &tauri::AppHandle, pid: u32) -> Result<(), String> {
        let target = crate::text_hook::process::target(pid)?;
        let arch = if target.bits == 32 { "x86" } else { "x64" };
        let helper = crate::text_hook::hookd_path(app)?.with_file_name(format!("kimochi-hookd-{arch}.exe"));
        let dll = helper.with_file_name(format!("kimochi-cursorhook-{arch}.dll"));
        if !dll.is_file() {
            return Err("The cursor hook is missing from this build of Kimochi.".into());
        }
        let staged =
            crate::sentence_audio::voice_hook::staged_dll(&dll, &crate::sentence_audio::voice_hook::base_dir())?;
        let output = std::process::Command::new(helper)
            .args(["inject", "--pid", &pid.to_string(), "--dll"])
            .arg(staged)
            .creation_flags(0x0800_0000)
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!("The cursor hook could not be loaded: {}", String::from_utf8_lossy(&output.stdout).trim()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::selected_pid;

    #[test]
    fn only_an_open_windows_window_names_the_game() {
        let open = |_: &kimochi_capture::SourceId| true;
        let closed = |_: &kimochi_capture::SourceId| false;
        assert_eq!(selected_pid(Some("windows:window:131234:777"), &open), Some(777));
        // Closed (its pid may name another process by now), a display, nothing, another OS.
        assert_eq!(selected_pid(Some("windows:window:131234:777"), &closed), None);
        assert_eq!(selected_pid(Some("windows:display:1"), &open), None);
        assert_eq!(selected_pid(None, &open), None);
        assert_eq!(selected_pid(Some("macos:window:88:4242"), &open), None);
        // Kimochi itself, never.
        let own = format!("windows:window:1:{}", std::process::id());
        assert_eq!(selected_pid(Some(&own), &open), None);
    }
}
