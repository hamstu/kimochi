//! Native gamepad polling.
//!
//! This lives in Rust rather than the webview on purpose: the whole point of the
//! feature is to fire while a *game* holds focus, and the overlay that would host a
//! browser gamepad module is deliberately unfocused and click-through — exactly the
//! condition where WebKit is least likely to report devices. Keeping it here also
//! guarantees a single owner, so one button press cannot fire two scans.
use crate::actions;
use crate::state::Shared;
use gilrs::{Button, Gilrs};
use serde_json::json;
use std::time::Duration;
use tauri::Emitter;

/// W3C "standard" gamepad mapping order, so `gamepadButton` indices stored by the
/// Electron build keep pointing at the same physical buttons.
const STANDARD: [Button; 17] = [
    Button::South,
    Button::East,
    Button::West,
    Button::North,
    Button::LeftTrigger,
    Button::RightTrigger,
    Button::LeftTrigger2,
    Button::RightTrigger2,
    Button::Select,
    Button::Start,
    Button::LeftThumb,
    Button::RightThumb,
    Button::DPadUp,
    Button::DPadDown,
    Button::DPadLeft,
    Button::DPadRight,
    Button::Mode,
];

pub fn start(app: &tauri::AppHandle, service: &Shared) {
    let mut gilrs = match Gilrs::new() {
        Ok(gilrs) => gilrs,
        Err(e) => {
            service.log(json!({
                "check": "gamepad",
                "status": "unavailable",
                "detail": e.to_string(),
            }));
            return;
        }
    };
    let app = app.clone();
    let service = service.clone();
    std::thread::spawn(move || {
        let mut previous: Vec<bool> = vec![false; STANDARD.len()];
        loop {
            std::thread::sleep(Duration::from_millis(16));
            // Drain the queue so connect/disconnect and button state stay current.
            while gilrs.next_event().is_some() {}
            if !service.settings.get_or("gamepadSettings.enabled", true) {
                continue;
            }
            let preferred: Option<usize> = service
                .settings
                .get_or("gamepadSettings.preferredGamepadIndex", None);
            let pads: Vec<_> = gilrs.gamepads().collect();
            let devices: Vec<_> = pads
                .iter()
                .enumerate()
                .map(|(index, (_, pad))| {
                    json!({
                        "index": index,
                        "id": pad.name(),
                        "connected": pad.is_connected(),
                        // gilrs normalises to a standard layout, which is what the
                        // stored button indices assume.
                        "mapping": "standard",
                        "buttons": STANDARD.len(),
                        "axes": 4,
                        "timestamp": 0,
                    })
                })
                .collect();
            let active = preferred
                .filter(|index| *index < pads.len())
                .or_else(|| pads.iter().position(|(_, pad)| pad.is_connected()));
            let (buttons, axes) = match active.and_then(|index| pads.get(index)) {
                Some((_, pad)) => (
                    STANDARD
                        .iter()
                        .map(|button| pad.is_pressed(*button))
                        .collect::<Vec<_>>(),
                    vec![
                        f64::from(pad.value(gilrs::Axis::LeftStickX)),
                        f64::from(pad.value(gilrs::Axis::LeftStickY)),
                        f64::from(pad.value(gilrs::Axis::RightStickX)),
                        f64::from(pad.value(gilrs::Axis::RightStickY)),
                    ],
                ),
                None => (vec![false; STANDARD.len()], vec![0.0; 4]),
            };
            let _ = app.emit(
                "gamepad",
                json!({
                    "gamepads": devices,
                    "activeGamepadIndex": active,
                    "buttonStates": buttons,
                    "axisStates": axes,
                }),
            );
            // Rising edge only: holding a button must not repeat the action. While Settings
            // records a binding the press is still emitted above, so it can be assigned, but
            // it does not fire whatever the button is bound to now.
            let suspended = crate::hotkeys::suspended();
            for (index, pressed) in buttons.iter().enumerate() {
                if *pressed && !previous[index] && !suspended {
                    dispatch_for_button(&app, &service, index);
                }
            }
            previous = buttons;
        }
    });
}

fn dispatch_for_button(app: &tauri::AppHandle, service: &Shared, index: usize) {
    let index = index as u64;
    for name in actions::HOTKEY_ACTIONS {
        let bound: Option<u64> = service
            .settings
            .get_or(&format!("hotkeys.{name}.gamepadButton"), None);
        if bound == Some(index) {
            actions::dispatch(app, service, name);
            return;
        }
    }
    let auto: Option<u64> = service
        .settings
        .get_or("autoScanSettings.gamepadButton", None);
    if auto == Some(index) {
        let delay = service
            .settings
            .get_or::<f64>("autoScanSettings.scanDelay", 500.0)
            .clamp(0.0, 10_000.0);
        let app = app.clone();
        let service = service.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay as u64));
            actions::dispatch(&app, &service, "triggerScan");
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_mapping_matches_the_web_gamepad_order() {
        // Indices stored by the Electron build must keep their meaning.
        assert_eq!(STANDARD[0], Button::South);
        assert_eq!(STANDARD[9], Button::Start);
        assert_eq!(STANDARD[12], Button::DPadUp);
        assert_eq!(STANDARD.len(), 17);
    }
}
