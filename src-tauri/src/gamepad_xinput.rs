//! Controllers read through XInput instead of gilrs (`gamepadSettings.xinput`, Windows only).
//!
//! gilrs reads Windows controllers through Windows.Gaming.Input, which can list a controller and
//! then deliver nothing for it; its XInput backend is a compile-time alternative to that one, not
//! something a build can hold both of. XInput itself is one call per controller, so it is polled
//! here directly: only XInput controllers (Xbox pads and whatever presents itself as one), at most
//! four, but read whether or not a window of Kimochi has focus.
use super::{pick_active, Tick, RAW_AXIS_SHOWN, RAW_BUTTON_EVENTS, STANDARD};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use windows::Win32::UI::Input::XboxController::{XInputGetState, XINPUT_STATE};

pub const BACKEND: &str = "xinput";

/// XInput's user indices.
const SLOTS: usize = 4;
/// How often an empty slot is asked again: asking one costs far more than reading a controller.
const RETRY_EMPTY: Duration = Duration::from_secs(1);
/// `XINPUT_GAMEPAD_TRIGGER_THRESHOLD`: past this a trigger counts as pressed.
const TRIGGER_PRESSED: u8 = 30;

/// XInput's button bits in the standard order (`STANDARD`). The triggers (6, 7) are analog, and
/// `XInputGetState` never reports the Guide button (16).
const BITS: [u16; 17] = [
    0x1000, 0x2000, 0x4000, 0x8000, 0x0100, 0x0200, 0, 0, 0x0020, 0x0010, 0x0040, 0x0080, 0x0001, 0x0002, 0x0004,
    0x0008, 0,
];
/// XInput's names for the same buttons: the raw codes the button test and the log show.
const NAMES: [&str; 17] = [
    "A", "B", "X", "Y", "LeftShoulder", "RightShoulder", "LeftTrigger", "RightTrigger", "Back", "Start", "LeftThumb",
    "RightThumb", "DPadUp", "DPadDown", "DPadLeft", "DPadRight", "Guide",
];
/// The sticks, as `axes` orders them: XInput's field and the name gilrs gives the same axis.
const STICKS: [(&str, &str); 4] =
    [("ThumbLX", "LeftStickX"), ("ThumbLY", "LeftStickY"), ("ThumbRX", "RightStickX"), ("ThumbRY", "RightStickY")];
const TRIGGERS: [(&str, &str); 2] = [("LeftTrigger", "LeftZ"), ("RightTrigger", "RightZ")];

/// One controller's `XINPUT_GAMEPAD`.
#[derive(Clone, Copy, Default, PartialEq)]
struct State {
    buttons: u16,
    triggers: [u8; 2],
    /// Left x, left y, right x, right y; y is positive up, as gilrs reports it.
    sticks: [i16; 4],
}

impl State {
    fn standard(&self) -> [bool; 17] {
        let mut pressed = BITS.map(|bit| self.buttons & bit != 0);
        pressed[6] = self.triggers[0] > TRIGGER_PRESSED;
        pressed[7] = self.triggers[1] > TRIGGER_PRESSED;
        pressed
    }

    fn axes(&self) -> [f64; 4] {
        self.sticks.map(|value| (f64::from(value) / 32767.0).max(-1.0))
    }

    /// The same shape as gilrs's `raw_activity`: buttons held by XInput's name, and sticks and
    /// triggers pushed past half way, rounded to a half.
    fn raw_activity(&self) -> (Vec<Value>, Vec<Value>) {
        let buttons = self
            .standard()
            .iter()
            .enumerate()
            .filter(|(_, pressed)| **pressed)
            .map(|(index, _)| json!({ "code": NAMES[index], "standard": index }))
            .collect();
        let half = |value: f64| (value * 2.0).round() / 2.0;
        let shown = |value: &f64| value.abs() >= f64::from(RAW_AXIS_SHOWN);
        let sticks = self.axes().into_iter().zip(STICKS);
        let triggers = self.triggers.map(|value| f64::from(value) / 255.0).into_iter().zip(TRIGGERS);
        let axes = sticks
            .chain(triggers)
            .filter(|(value, _)| shown(value))
            .map(|(value, (code, name))| json!({ "code": code, "name": name, "value": half(value) }))
            .collect();
        (buttons, axes)
    }
}

/// The lowest standard button down now that was not before.
fn newly_pressed(before: Option<&State>, now: &State) -> Option<usize> {
    let before = before.map(State::standard).unwrap_or_default();
    now.standard().iter().zip(before).position(|(now, before)| *now && !before)
}

fn name(slot: usize) -> String {
    format!("XInput controller {}", slot + 1)
}

fn get_state(slot: usize) -> Option<State> {
    let mut state = XINPUT_STATE::default();
    // SAFETY: `state` is a valid XINPUT_STATE for the call to fill, and any index is accepted
    // (one out of range is an error return).
    let result = unsafe { XInputGetState(slot as u32, &mut state) };
    let pad = state.Gamepad;
    (result == 0).then_some(State {
        buttons: pad.wButtons.0,
        triggers: [pad.bLeftTrigger, pad.bRightTrigger],
        sticks: [pad.sThumbLX, pad.sThumbLY, pad.sThumbRX, pad.sThumbRY],
    })
}

#[derive(Default)]
pub struct Reader {
    slots: [Option<State>; SLOTS],
    /// When each empty slot is asked again.
    retry: [Option<Instant>; SLOTS],
    /// The slot a button was last pressed on: the active one while no primary is chosen.
    last_pressed: Option<usize>,
    first_press: [bool; SLOTS],
    /// Button changes traced one by one (verbose logging), up to `RAW_BUTTON_EVENTS`.
    traced: u32,
}

impl Reader {
    /// Polls the four slots and reports the connected ones, in slot order, as gilrs's are.
    pub fn read(&mut self, preferred: Option<usize>, logged: &mut Option<Vec<String>>) -> Tick {
        let now = Instant::now();
        // Records waiting to learn whether their controller is the one read: `(slot, record, always)`.
        let mut pending: Vec<(usize, Value, bool)> = Vec::new();
        for slot in 0..SLOTS {
            if self.slots[slot].is_none() && self.retry[slot].is_some_and(|at| now < at) {
                continue;
            }
            let state = get_state(slot);
            self.retry[slot] = state.is_none().then_some(now + RETRY_EMPTY);
            let before = std::mem::replace(&mut self.slots[slot], state);
            let Some(state) = state else { continue };
            if let Some(button) = newly_pressed(before.as_ref(), &state) {
                self.last_pressed = Some(slot);
                if !std::mem::replace(&mut self.first_press[slot], true) {
                    pending.push((slot, json!({
                        "check": "gamepad-first-press",
                        "pad": slot,
                        "name": name(slot),
                        "button": format!("{:?}", STANDARD[button]),
                        "code": NAMES[button],
                        "standardIndex": button,
                        "mapping": "Driver",
                    }), true));
                }
            }
            let changed = before.is_none_or(|before| before.standard() != state.standard());
            if changed && crate::debug_report::verbose() {
                crate::debug_report::count("gamepad-button-event");
                if self.traced < RAW_BUTTON_EVENTS {
                    self.traced += 1;
                    let held = state.standard();
                    pending.push((slot, json!({
                        "check": "gamepad-raw",
                        "event": "ButtonsChanged",
                        "pad": slot,
                        "name": name(slot),
                        "standardPressed": (0..held.len()).filter(|index| held[*index]).collect::<Vec<_>>(),
                        "last": self.traced == RAW_BUTTON_EVENTS,
                    }), false));
                }
            }
        }
        let connected: Vec<(usize, State)> =
            self.slots.iter().enumerate().filter_map(|(slot, state)| state.map(|state| (slot, state))).collect();
        super::log_pads(logged, connected.iter().map(|(slot, _)| name(*slot)).collect(), BACKEND, || {
            connected
                .iter()
                .enumerate()
                .map(|(index, (slot, _))| json!({ "index": index, "name": name(*slot), "slot": slot, "connected": true }))
                .collect()
        });
        let devices = connected
            .iter()
            .enumerate()
            .map(|(index, (slot, state))| {
                let (buttons, axes) = state.raw_activity();
                json!({
                    "index": index,
                    "id": name(*slot),
                    "connected": true,
                    "mapping": "standard",
                    "buttons": STANDARD.len(),
                    "axes": 4,
                    "timestamp": 0,
                    "name": name(*slot),
                    // XInput has one fixed layout and does not say which model it is talking to.
                    "mappingSource": "Driver",
                    "vendor": null,
                    "product": null,
                    "rawButtons": buttons,
                    "rawAxes": axes,
                })
            })
            .collect();
        let last_pressed = self.last_pressed.and_then(|slot| connected.iter().position(|(other, _)| *other == slot));
        let active = pick_active(preferred, connected.len(), last_pressed);
        let read = active.and_then(|index| connected.get(index));
        for (slot, mut record, always) in pending {
            record["active"] = json!(read.is_some_and(|(read, _)| *read == slot));
            if always {
                crate::debug_report::record_now(record);
            } else {
                crate::debug_report::trace_now(record);
            }
        }
        let mut tick = Tick::empty(BACKEND);
        tick.devices = devices;
        tick.active = active;
        if let Some((_, state)) = read {
            tick.buttons = state.standard().to_vec();
            tick.axes = state.axes().to_vec();
        }
        tick
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gilrs::Button;

    #[test]
    fn xinput_buttons_land_on_the_standard_indices() {
        let pressed = |state: State| -> Vec<Button> {
            state.standard().iter().zip(STANDARD).filter(|(down, _)| **down).map(|(_, button)| button).collect()
        };
        let buttons = |buttons: u16| State { buttons, ..State::default() };
        assert_eq!(pressed(buttons(0x1000)), [Button::South]);
        assert_eq!(pressed(buttons(0x2000 | 0x8000)), [Button::East, Button::North]);
        assert_eq!(pressed(buttons(0x0020 | 0x0010)), [Button::Select, Button::Start]);
        assert_eq!(pressed(buttons(0x0040 | 0x0080)), [Button::LeftThumb, Button::RightThumb]);
        assert_eq!(pressed(buttons(0x0001 | 0x0008)), [Button::DPadUp, Button::DPadRight]);
        assert_eq!(pressed(buttons(0x0100)), [Button::LeftTrigger]);
        // The triggers are analog: pressed past XInput's own threshold.
        assert_eq!(pressed(State { triggers: [TRIGGER_PRESSED, 255], ..State::default() }), [Button::RightTrigger2]);
        assert!(pressed(State::default()).is_empty());
    }

    #[test]
    fn sticks_are_scaled_to_one_with_up_positive() {
        let state = State { sticks: [32767, -32768, 0, 16384], ..State::default() };
        let axes = state.axes();
        assert_eq!(axes[0], 1.0);
        assert_eq!(axes[1], -1.0);
        assert_eq!(axes[2], 0.0);
        assert!((axes[3] - 0.5).abs() < 0.001);
    }

    #[test]
    fn raw_input_names_what_is_held_and_pushed() {
        let state = State { buttons: 0x1000, triggers: [255, 10], sticks: [0, -32768, 9000, 0] };
        let (buttons, axes) = state.raw_activity();
        assert_eq!(buttons, [json!({"code": "A", "standard": 0}), json!({"code": "LeftTrigger", "standard": 6})]);
        assert_eq!(
            axes,
            [
                json!({"code": "ThumbLY", "name": "LeftStickY", "value": -1.0}),
                json!({"code": "LeftTrigger", "name": "LeftZ", "value": 1.0}),
            ]
        );
        assert_eq!(State::default().raw_activity(), (vec![], vec![]));
    }

    #[test]
    fn only_a_new_press_counts_as_pressed() {
        let a = State { buttons: 0x1000, ..State::default() };
        let a_and_b = State { buttons: 0x3000, ..State::default() };
        assert_eq!(newly_pressed(None, &a), Some(0));
        assert_eq!(newly_pressed(Some(&a), &a), None);
        assert_eq!(newly_pressed(Some(&a), &a_and_b), Some(1));
        assert_eq!(newly_pressed(Some(&a_and_b), &a), None);
        assert_eq!(newly_pressed(None, &State::default()), None);
    }
}
