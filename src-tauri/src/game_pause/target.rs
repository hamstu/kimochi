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
//! - Gamescope sources carry Steam's app id as well, which the Linux backend prefers;
//! - every window source is used only while that window is still open as the process it was listed
//!   for (a minimised one counts), since a closed game's pid can soon name an unrelated process;
//! - a display source (or none) names no game: never the app that happens to be in front.
use super::backend::GameRef;
use kimochi_capture::{Platform, SourceId};

/// The game for the current selection. `selection` is the selected source id string (if any),
/// `steam_app_id` Gamescope's focused app in Gaming Mode, `x11_host_pid` the X server's pid for
/// an X11 window id, and `window_live` whether a window source is still open as the process its id
/// names. Without a window selection there is no pid: the app in front could be
/// anything (a browser, a call), and is never paused.
pub fn game_ref(
    selection: Option<&str>,
    steam_app_id: Option<u32>,
    x11_host_pid: &dyn Fn(u32) -> Option<u32>,
    window_live: &dyn Fn(&SourceId) -> bool,
) -> GameRef {
    let parsed = selection.and_then(SourceId::parse);
    let (pid, window) = match &parsed {
        Some(id @ SourceId::Window { platform, pid, .. }) => {
            let window = id.handle().parse::<u64>().ok();
            let pid = match platform {
                Platform::Portal => None,
                // The X server's record names a client slot, which the next client gets once the
                // game's closes: the window must still be the one listed.
                Platform::X11 => id.handle_u32().filter(|_| window_live(id)).and_then(x11_host_pid),
                Platform::Gamescope => pid.filter(|pid| *pid > 0 && window_live(id)),
                // The pid was read when the source was listed; the window must still be its.
                _ => pid.filter(|_| window_live(id)),
            };
            (pid, window)
        }
        // A display, or nothing selected.
        _ => (None, None),
    };
    GameRef { pid, source: selection.map(str::to_owned), window, steam_app_id, title: None }
}

#[cfg(test)]
mod tests {
    use super::game_ref;

    fn none(_: u32) -> Option<u32> {
        None
    }

    fn open(_: &kimochi_capture::SourceId) -> bool {
        true
    }

    #[test]
    fn untrusted_pids_are_left_out() {
        // A portal window never has a pid, and nothing falls back to the frontmost for it.
        assert_eq!(game_ref(Some("portal:window:57"), None, &none, &open).pid, None);
        // X11: the X server's pid, never the window's claim (a Flatpak sandbox pid here).
        let xres = |xid: u32| (xid == 4_194_311).then_some(31_337);
        assert_eq!(game_ref(Some("x11:window:4194311:2"), None, &xres, &open).pid, Some(31_337));
        assert_eq!(game_ref(Some("x11:window:4194311:2"), None, &none, &open).pid, None);
        // Gamescope's 0 means unknown.
        assert_eq!(game_ref(Some("gamescope:window:1234:0"), Some(1234), &none, &open).pid, None);
    }

    #[test]
    fn trusted_pids_and_no_frontmost_fallback() {
        assert_eq!(game_ref(Some("macos:window:88:4242"), None, &none, &open).pid, Some(4242));
        assert_eq!(game_ref(Some("windows:window:131234:777"), None, &none, &open).pid, Some(777));
        // A display source or no selection: never whatever app is in front.
        assert_eq!(game_ref(Some("macos:display:1"), None, &none, &open).pid, None);
        assert_eq!(game_ref(None, None, &none, &open).pid, None);
    }

    #[test]
    fn a_closed_window_names_no_pid() {
        // The game closed (or the handle now belongs to another process): its old pid may already
        // name something else, so there is none.
        let closed = |_: &kimochi_capture::SourceId| false;
        assert_eq!(game_ref(Some("windows:window:131234:777"), None, &none, &closed).pid, None);
        assert_eq!(game_ref(Some("macos:window:88:4242"), None, &none, &closed).pid, None);
        // Linux too: an X11 window's client slot passes to the next client, a Wayland or Gamescope
        // id's pid was read when it was listed. (Gamescope still names the game by app id.)
        let xres = |xid: u32| (xid == 4_194_311).then_some(31_337);
        assert_eq!(game_ref(Some("x11:window:4194311:2"), None, &xres, &closed).pid, None);
        assert_eq!(game_ref(Some("wayland:window:1069298374:4242"), None, &none, &closed).pid, None);
        let gamescope = game_ref(Some("gamescope:window:1234:99"), Some(1234), &none, &closed);
        assert_eq!((gamescope.pid, gamescope.steam_app_id), (None, Some(1234)));
        assert_eq!(game_ref(Some("wayland:window:1069298374:4242"), None, &none, &open).pid, Some(4242));
    }
}
