//! One dispatch point for every user action, whatever triggered it: a global
//! shortcut, a gamepad button, a keyboard auto-scan trigger, the tray, or a panel
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
    // Commands, bindable to a shortcut or a gamepad button.
    "triggerScan",
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
];

/// The subset that can be bound to a shortcut or a gamepad button.
pub const HOTKEY_ACTIONS: &[&str] = &[
    "triggerScan",
    "toggleOverlay",
    "setCropArea",
    "playAudio",
    "selectAndScan",
];

/// Commands that bring the overlay back if it is hidden, so a shortcut never appears
/// to do nothing. Deliberately excludes the toggles and the hover affordances: forcing
/// the overlay open because the pointer crossed the controller's Source button would be
/// a worse bug than the one this behaviour fixes.
const RESTORES_OVERLAY: &[&str] = &["triggerScan", "setCropArea", "playAudio", "selectAndScan"];

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
    if let Some(visible) = visibility {
        if let Some(overlay) = app.get_webview_window("overlay") {
            let _ = if visible {
                overlay.show()
            } else {
                overlay.hide()
            };
            if !visible {
                // Hidden overlays must not keep swallowing clicks.
                let _ = overlay.set_ignore_cursor_events(true);
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
