//! Gamescope has multiple X servers. GTK focus on :0 alone does not mean the
//! compositor is routing input there: the game can own :1 at the same time.
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _};

fn display_number(display: &str) -> Option<&str> {
    let number = display.rsplit_once(':')?.1.split('.').next()?;
    (!number.is_empty() && number.bytes().all(|c| c.is_ascii_digit())).then_some(number)
}
fn routes_to_owner(local: &str, mouse: &str, keyboard: &str, focused_pid: Option<u32>, owner: u32) -> bool {
    let Some(local) = display_number(local) else { return false; };
    display_number(mouse) == Some(local) && display_number(keyboard) == Some(local)
        && focused_pid == Some(owner)
}

/// Unknown ownership fails open: do not stop Steam unless input is demonstrably
/// routed to Kimochi. Shared by the app and its independent recovery processes.
pub(super) fn owns_input(owner: u32) -> bool {
    let Some(d) = super::x11::desktop() else { return false; };
    // Steam menus share :0 with the managed app. XGetInputFocus may still
    // point at our GTK window while Gamescope routes the controller to Steam.
    let steam = d.conn.intern_atom(true, b"GAMESCOPE_FOCUSED_APP").ok()
        .and_then(|cookie| cookie.reply().ok())
        .and_then(|atom| d.property32(d.root, atom.atom, AtomEnum::CARDINAL))
        .and_then(|values| values.first().copied());
    if steam == Some(769) { return false; }
    let display = |name: &[u8]| -> Option<String> {
        let atom = d.conn.intern_atom(true, name).ok()?.reply().ok()?.atom;
        if atom == 0 { return None; }
        let value = d.property(d.root, atom, AtomEnum::ANY, 64)?.value;
        String::from_utf8(value.split(|v| *v == 0).next()?.to_vec()).ok()
    };
    let Some(mouse) = display(b"GAMESCOPE_MOUSE_FOCUS_DISPLAY") else { return false; };
    let Some(keyboard) = display(b"GAMESCOPE_KEYBOARD_FOCUS_DISPLAY") else { return false; };
    let local = std::env::var("DISPLAY").unwrap_or_default();
    let Some(mut window) = d.conn.get_input_focus().ok().and_then(|c| c.reply().ok()).map(|r| r.focus) else { return false; };
    // Include GTK file choosers and child windows, not just registered webviews.
    for _ in 0..8 {
        if let Some(pid) = d.pid(window) {
            return routes_to_owner(&local, &mouse, &keyboard, Some(pid), owner);
        }
        let Some(parent) = d.conn.query_tree(window).ok().and_then(|c| c.reply().ok()).map(|r| r.parent) else { return false; };
        if parent == 0 || parent == window { return false; }
        window = parent;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_x11_focus_cannot_keep_game_input_blocked() {
        assert!(routes_to_owner(":0", ":0", ":0", Some(42), 42));
        // GTK/X11 can still report PID 42 on :0 after Gamescope routes to :1.
        assert!(!routes_to_owner(":0", ":1", ":1", Some(42), 42));
        assert!(!routes_to_owner(":0", ":1", ":0", Some(42), 42));
        assert!(!routes_to_owner(":0", ":0", ":1", Some(42), 42));
    }
    #[test]
    fn steam_and_unknown_focus_never_authorize_a_pause() {
        assert!(!routes_to_owner(":0", ":0", ":0", Some(99), 42));
        assert!(!routes_to_owner(":0", ":0", ":0", None, 42));
        assert!(!routes_to_owner(":0", "", ":0", Some(42), 42));
        assert!(!routes_to_owner("invalid", ":0", ":0", Some(42), 42));
        assert!(routes_to_owner(":0.0", ":0", ":0.0", Some(42), 42));
    }
}
