//! Mouse buttons as action shortcuts: middle click, back and forward (#19).
//!
//! The global-shortcut API registers keys only, so a bound button is caught by a platform
//! input hook instead (Windows: the mouse guard's `WH_MOUSE_LL`; macOS: a `CGEventTap` that
//! exists only while a button is bound, see `platform::sync_mouse_buttons`). Those hooks run on
//! the system's input path, so they read nothing here but two atomics (`armed`, `step`) and hand
//! the press to a channel; `fire`, which may lock and dispatch, runs on a delivery thread.
//!
//! With nothing bound the hooks see an empty mask and pass every event on untouched.
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use tauri::Manager;

/// The buttons that can be bound, as bit positions in the masks below.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Middle = 0,
    Back = 1,
    Forward = 2,
}

impl Button {
    pub const ALL: [Button; 3] = [Button::Middle, Button::Back, Button::Forward];

    pub const fn bit(self) -> u8 {
        1 << self as u8
    }

    /// The accelerator Settings stores for the button. Mouse buttons stand alone: no modifiers.
    pub const fn accelerator(self) -> &'static str {
        match self {
            Button::Middle => "MouseMiddle",
            Button::Back => "MouseBack",
            Button::Forward => "MouseForward",
        }
    }

    pub fn parse(accelerator: &str) -> Option<Button> {
        let accelerator = accelerator.trim();
        Button::ALL.into_iter().find(|button| button.accelerator().eq_ignore_ascii_case(accelerator))
    }

    pub fn from_index(index: u8) -> Option<Button> {
        Button::ALL.get(usize::from(index)).copied()
    }
}

/// What a hook does with one button transition.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Hand it on to the system and the application under the pointer.
    Pass,
    /// Swallow it: the release of a press that was swallowed.
    Swallow,
    /// Swallow it and run the bound action: a press of a bound button.
    Fire,
}

/// One button transition against the bound buttons (`armed`) and the presses this hook has
/// swallowed and not yet seen released (`owned`, updated in place). Pure, so it is tested here.
///
/// - Injected events (another tool's `SendInput`, a remapper, a macro) always pass, untouched
///   and uncounted: Kimochi must never eat input another program synthesised.
/// - A press is swallowed only while its button is bound; its release is swallowed exactly when
///   its press was, even if the binding went away in between (Settings started recording, the
///   shortcut was cleared). The game never sees half a click.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub fn step(owned: &mut u8, armed: u8, button: Button, down: bool, injected: bool) -> Step {
    if injected {
        return Step::Pass;
    }
    let bit = button.bit();
    if down {
        if armed & bit == 0 {
            // An unbound press clears any stale claim, so its release is not swallowed.
            *owned &= !bit;
            return Step::Pass;
        }
        *owned |= bit;
        return Step::Fire;
    }
    if *owned & bit != 0 {
        *owned &= !bit;
        return Step::Swallow;
    }
    Step::Pass
}

/// The buttons with a live binding. Zero while nothing is bound and while shortcuts are
/// suspended for recording, so a bound button can be recorded again.
static ARMED: AtomicU8 = AtomicU8::new(0);
/// The action bound to each button, read only off the hook thread.
static ACTIONS: Mutex<[Option<String>; 3]> = Mutex::new([None, None, None]);

/// The armed mask; the one thing a hook reads.
pub fn armed() -> u8 {
    ARMED.load(Ordering::Relaxed)
}

/// Disarm every button (suspend for recording, or before re-registering). Platform hooks stay
/// as they are, so a press already swallowed still has its release swallowed.
pub fn disarm() {
    ARMED.store(0, Ordering::Relaxed);
}

/// Bind `bindings` (action, button) and arm them. Installs or removes the platform hook as the
/// set becomes non-empty or empty; an error means the buttons cannot fire and nothing is armed.
pub fn bind(app: &tauri::AppHandle, bindings: &[(String, Button)]) -> Result<(), String> {
    let mut actions: [Option<String>; 3] = [None, None, None];
    let mut mask = 0;
    for (name, button) in bindings {
        actions[*button as usize] = Some(name.clone());
        mask |= button.bit();
    }
    disarm();
    *ACTIONS.lock().unwrap_or_else(|p| p.into_inner()) = actions;
    crate::platform::sync_mouse_buttons(app, mask != 0)?;
    ARMED.store(mask, Ordering::Relaxed);
    Ok(())
}

/// Run the action bound to a swallowed press. Called on a delivery thread, never the hook's.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub fn fire(app: &tauri::AppHandle, index: u8) {
    let Some(button) = Button::from_index(index) else { return };
    if armed() & button.bit() == 0 || crate::hotkeys::suspended() {
        return;
    }
    let action = ACTIONS.lock().unwrap_or_else(|p| p.into_inner())[button as usize].clone();
    if let Some(action) = action {
        let service = app.state::<crate::state::Shared>().inner().clone();
        crate::actions::dispatch(app, &service, &action);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerators_name_the_three_buttons() {
        assert_eq!(Button::parse("MouseMiddle"), Some(Button::Middle));
        assert_eq!(Button::parse("MouseBack"), Some(Button::Back));
        assert_eq!(Button::parse("MouseForward"), Some(Button::Forward));
        assert_eq!(Button::parse("mouseback"), Some(Button::Back));
        for key in ["", "Insert", "F8", "Mouse", "MouseLeft", "MouseRight", "Shift+MouseBack", "Mouse4"] {
            assert_eq!(Button::parse(key), None, "{key}");
        }
        assert_eq!(Button::parse("CommandOrControl+Shift+8"), None);
        for button in Button::ALL {
            assert_eq!(Button::parse(button.accelerator()), Some(button));
        }
        for button in Button::ALL {
            assert_eq!(Button::from_index(button as u8), Some(button));
        }
        assert_eq!(Button::from_index(3), None);
    }

    #[test]
    fn nothing_bound_passes_everything() {
        let mut owned = 0;
        for button in Button::ALL {
            for down in [true, false] {
                assert_eq!(step(&mut owned, 0, button, down, false), Step::Pass);
            }
        }
        assert_eq!(owned, 0);
    }

    #[test]
    fn a_bound_button_is_swallowed_down_and_up() {
        let mut owned = 0;
        let armed = Button::Back.bit();
        assert_eq!(step(&mut owned, armed, Button::Back, true, false), Step::Fire);
        assert_eq!(step(&mut owned, armed, Button::Back, false, false), Step::Swallow);
        assert_eq!(owned, 0);
        // Other buttons are untouched.
        assert_eq!(step(&mut owned, armed, Button::Forward, true, false), Step::Pass);
        assert_eq!(step(&mut owned, armed, Button::Forward, false, false), Step::Pass);
        assert_eq!(step(&mut owned, armed, Button::Middle, true, false), Step::Pass);
    }

    #[test]
    fn a_release_follows_its_press_when_the_binding_changes_in_between() {
        // Pressed while bound, released after Settings disarmed it: the release is still eaten.
        let mut owned = 0;
        assert_eq!(step(&mut owned, Button::Middle.bit(), Button::Middle, true, false), Step::Fire);
        assert_eq!(step(&mut owned, 0, Button::Middle, false, false), Step::Swallow);
        // Pressed before it was bound, released after: the release reaches the application.
        let mut owned = 0;
        assert_eq!(step(&mut owned, 0, Button::Middle, true, false), Step::Pass);
        assert_eq!(step(&mut owned, Button::Middle.bit(), Button::Middle, false, false), Step::Pass);
    }

    #[test]
    fn injected_input_is_never_swallowed_or_counted() {
        let mut owned = 0;
        let armed = Button::Forward.bit();
        assert_eq!(step(&mut owned, armed, Button::Forward, true, true), Step::Pass);
        assert_eq!(step(&mut owned, armed, Button::Forward, false, true), Step::Pass);
        assert_eq!(owned, 0);
        // A physical press keeps its claim through an injected release.
        assert_eq!(step(&mut owned, armed, Button::Forward, true, false), Step::Fire);
        assert_eq!(step(&mut owned, armed, Button::Forward, false, true), Step::Pass);
        assert_eq!(step(&mut owned, armed, Button::Forward, false, false), Step::Swallow);
    }

    #[test]
    fn an_unbound_press_drops_a_stale_claim() {
        // A release lost to the system (a hook timeout) must not make the next unbound
        // click lose its release.
        let mut owned = 0;
        assert_eq!(step(&mut owned, Button::Back.bit(), Button::Back, true, false), Step::Fire);
        assert_eq!(step(&mut owned, 0, Button::Back, true, false), Step::Pass);
        assert_eq!(step(&mut owned, 0, Button::Back, false, false), Step::Pass);
    }
}
