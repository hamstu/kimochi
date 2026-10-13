//! One dispatch point for every user action, whatever triggered it: a global
//! shortcut, a gamepad button, the gamepad auto-scan trigger, the tray, or a panel
//! calling `trigger_action`. Keeping it single means two input paths can never fire
//! two different code paths for the same action.
use crate::state::Shared;
use serde_json::json;
use tauri::{Emitter, Manager};

/// Every name `trigger_action` accepts. Deliberately one central list: the
/// command-contract test reads it and compares it against the action names the
/// frontend actually calls, so a button cannot ship against an action that does not
/// exist.
pub const ACTIONS: &[&str] = &[
    // Commands. Only `triggerScan` and `openControllerMenu` are bindable now; the rest are
    // still reached from the tray, the panels and the overlay's radial menu.
    "triggerScan",
    "openControllerMenu",
    "toggleOverlay",
    "setCropArea",
    "playAudio",
    "selectAndScan",
    // View toggles. Rust does NOT flip these flags — the overlay owns the state and
    // writes it back through `view_flags`. Flipping here as well would toggle twice
    // and leave the switch looking dead in a more confusing way than not working.
    "toggleAutoOcr",
    "toggleTextOverlay",
    "toggleDebugOverlay",
    // Hover affordances. Cosmetic, emit-only.
    "hoverSelectRegionOn",
    "hoverSelectRegionOff",
    "hoverSourceOn",
    "hoverSourceOff",
    "hoverSourceDismiss",
];

/// The subset that can be bound to a shortcut or a gamepad button. The order also breaks
/// ties between gamepad chords of the same size: the earlier action wins.
pub const HOTKEY_ACTIONS: &[&str] = &["triggerScan", "openControllerMenu"];

/// Commands that bring the overlay back if it is hidden, so a shortcut never appears
/// to do nothing. Deliberately excludes the toggles and the hover affordances: forcing
/// the overlay open because the pointer crossed the controller's Source button would be
/// a worse bug than the one this behaviour fixes.
const RESTORES_OVERLAY: &[&str] = &[
    "triggerScan",
    "openControllerMenu",
    "setCropArea",
    "playAudio",
    "selectAndScan",
];

pub fn dispatch(app: &tauri::AppHandle, service: &Shared, name: &str) {
    let visibility = {
        let mut view = service.view.lock().unwrap();
        view.action_seq += 1;
        view.last_action = Some(name.to_string());
        if name == "toggleOverlay" {
            view.overlay_visible = !view.overlay_visible;
            Some(view.overlay_visible)
        } else if RESTORES_OVERLAY.contains(&name) {
            view.overlay_visible = true;
            Some(true)
        } else {
            // Pure pass-through: emit and touch nothing.
            None
        }
    };
    #[cfg(target_os = "linux")]
    let visibility = if crate::platform::wayland_overlay_unavailable() {
        // The GTK overlay host stays hidden on this path. GNOME Shell uses the
        // logical view flags; do not map/hide or change input on an unrealized
        // GTK window (Tao's CursorIgnoreEvents(true) unwraps its absent GDK window).
        None
    } else { visibility };
    #[cfg(target_os = "linux")]
    let visibility = if crate::platform::capture::suppressed() { None } else { visibility };
    if let Some(visible) = visibility {
        if let Some(overlay) = app.get_webview_window("overlay") {
            let _ = if visible {
                overlay.show()
            } else {
                #[cfg(target_os = "linux")]
                if overlay.is_visible().unwrap_or(false) { crate::platform::capture::mark_hidden(); }
                overlay.hide()
            };
            if !visible {
                // Hidden overlays must not keep swallowing clicks.
                let _ = overlay.set_ignore_cursor_events(true);
                // Nor keep the controller and the arrow keys away from the game. Off this
                // thread: a keyboard shortcut runs us inside the shortcut plugin's handler,
                // which holds the lock that unregistering the navigation keys needs.
                if crate::gamepad::navigating() {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        crate::gamepad::set_navigation(&app, false, false);
                    });
                }
            }
        }
    }
    let seq = service.view.lock().unwrap().action_seq;
    let _ = app.emit("hotkey", json!({ "name": name, "seq": seq }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bindable_action_is_dispatchable() {
        for name in HOTKEY_ACTIONS {
            assert!(ACTIONS.contains(name), "{name}");
        }
        // The controller menu lives in the overlay, so opening it must show the overlay.
        assert!(RESTORES_OVERLAY.contains(&"openControllerMenu"));
    }

    #[test]
    fn toggles_and_hovers_have_no_overlay_side_effect() {
        for name in [
            "toggleAutoOcr",
            "toggleTextOverlay",
            "toggleDebugOverlay",
            "hoverSelectRegionOn",
            "hoverSelectRegionOff",
            "hoverSourceOn",
            "hoverSourceOff",
        ] {
            assert!(ACTIONS.contains(&name), "{name} must be dispatchable");
            assert!(
                !RESTORES_OVERLAY.contains(&name),
                "{name} must not force the overlay open"
            );
        }
        // toggleOverlay is handled on its own branch and is not in the restore list.
        assert!(!RESTORES_OVERLAY.contains(&"toggleOverlay"));
    }
}
