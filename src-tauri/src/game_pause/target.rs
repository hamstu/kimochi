//! Which game a pause is for: the selected window's process, else the frontmost window's, plus
//! what Gaming Mode knows. OS-specific tree walking is the backend's (`Backend::plan`).
//!
//! The pid must be a host pid Kimochi can trust; when unsure it is left out, and the backend
//! refuses with `NoPid` rather than stop some other process:
//! - a portal source carries no pid (the portal never says whose window it is);
//! - an X11 window's `_NET_WM_PID` is the client's own claim, a pid in its namespace for a
//!   sandboxed (Flatpak) app: the X server's record of the client (X-Resource) is used instead,
//!   and nothing when the server cannot say;
//! - a Wayland window named by the compositor (GNOME's extension, KWin) carries the host pid the
//!   compositor read from the client's socket;
//! - Gamescope sources carry Steam's app id as well, which the Linux backend prefers.
use super::backend::GameRef;
use kimochi_capture::{Platform, SourceId};

/// The game for the current selection. `selection` is the selected source id string (if any),
/// `frontmost` the frontmost window's pid, used only without a window selection (callers pass
/// `None` where it is not a trustworthy host pid), `steam_app_id` Gamescope's focused app in Gaming
/// Mode, and `x11_host_pid` the X server's pid for an X11 window id.
pub fn game_ref(
    selection: Option<&str>,
    frontmost: Option<u32>,
    steam_app_id: Option<u32>,
    x11_host_pid: &dyn Fn(u32) -> Option<u32>,
) -> GameRef {
    let parsed = selection.and_then(SourceId::parse);
    let (pid, window) = match &parsed {
        Some(id @ SourceId::Window { platform, pid, .. }) => {
            let window = id.handle().parse::<u64>().ok();
            let pid = match platform {
                Platform::Portal => None,
                Platform::X11 => id.handle_u32().and_then(x11_host_pid),
                Platform::Gamescope => pid.filter(|pid| *pid > 0),
                _ => *pid,
            };
            (pid, window)
        }
        // A display, or nothing selected: the window in front.
        _ => (frontmost, None),
    };
    GameRef { pid, source: selection.map(str::to_owned), window, steam_app_id, title: None }
}

#[cfg(test)]
mod tests {
    use super::game_ref;

    fn none(_: u32) -> Option<u32> {
        None
    }

    #[test]
    fn untrusted_pids_are_left_out() {
        // A portal window never has a pid, and nothing falls back to the frontmost for it.
        assert_eq!(game_ref(Some("portal:window:57"), Some(9), None, &none).pid, None);
        // X11: the X server's pid, never the window's claim (a Flatpak sandbox pid here).
        let xres = |xid: u32| (xid == 4_194_311).then_some(31_337);
        assert_eq!(game_ref(Some("x11:window:4194311:2"), None, None, &xres).pid, Some(31_337));
        assert_eq!(game_ref(Some("x11:window:4194311:2"), None, None, &none).pid, None);
        // Gamescope's 0 means unknown.
        assert_eq!(game_ref(Some("gamescope:window:1234:0"), None, Some(1234), &none).pid, None);
    }

    #[test]
    fn trusted_pids_and_the_frontmost_fallback() {
        assert_eq!(game_ref(Some("macos:window:88:4242"), Some(9), None, &none).pid, Some(4242));
        assert_eq!(game_ref(Some("windows:window:131234:777"), None, None, &none).pid, Some(777));
        assert_eq!(game_ref(None, Some(9), None, &none).pid, Some(9));
    }
}
