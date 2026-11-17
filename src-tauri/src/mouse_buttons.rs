//! Mouse buttons as action shortcuts: middle click, back and forward (#19).
//!
//! The global-shortcut API registers keys only, so a bound button is caught by a platform
//! input hook instead (Windows: the mouse guard's `WH_MOUSE_LL`; macOS: a `CGEventTap` that
//! exists only while a button is bound, see `platform::sync_mouse_buttons`). Those hooks run on
//! the system's input path, so they read nothing here but two atomics (`armed`, `step`) and hand
//! the press to a channel; `fire`, which may lock and dispatch, runs on a delivery thread.
//!
//! With nothing bound the hooks see an empty mask and pass every event on untouched.
//!
//! A button can also be the overlay's lookup key (`overlayLookupKey` naming one, #204): held, it
//! does what holding Shift does. The same hooks see it (`lookup_step`): a press over Kimochi's own
//! text is kept from the application under the pointer, any other press reaches it as usual, and
//! the cursor poll reads whether it is held (`platform::lookup_button_down`).
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
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
/// The buttons bound as shortcuts (armed or suspended), so the lookup key knows whether the
/// platform hook is still wanted without it.
static BOUND: AtomicU8 = AtomicU8::new(0);
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
    BOUND.store(mask, Ordering::Relaxed);
    // The hook stays while the lookup key is a button, even with no shortcut bound to one.
    let lookup = lookup() != 0 && cfg!(any(target_os = "windows", target_os = "macos"));
    let synced = crate::platform::sync_mouse_buttons(app, mask != 0 || lookup);
    if mask != 0 {
        synced?;
    }
    ARMED.store(mask, Ordering::Relaxed);
    Ok(())
}

/// The button that is the overlay's lookup key, as its bit (`Button::bit`), or 0 while the
/// lookup key is a keyboard modifier. Set from `overlayLookupKey` by the cursor poll.
static LOOKUP: AtomicU8 = AtomicU8::new(0);
/// Whether the pointer is over Kimochi's own text (the overlay's words, the hook card, a
/// dictionary pop-up), so a lookup press there is kept from the application underneath.
/// Written by the cursor poll every tick, read by the hooks.
static OVER_OWN: AtomicBool = AtomicBool::new(false);
/// A lookup press a hook swallowed, not yet released: the system's own button state does not
/// see it (Windows), so the cursor poll reads it here.
static LOOKUP_SWALLOWED: AtomicBool = AtomicBool::new(false);

/// The overlay's lookup key (`overlayLookupKey`) when it names a mouse button.
pub fn lookup_button(key: &str) -> Option<Button> {
    Button::parse(key)
}

/// Make `button` the lookup key (or none). Called by the cursor poll when the setting changes.
/// The platform hook is installed for it if it can be (macOS: a tap, with Accessibility); if it
/// cannot, the button still looks up, read from the system's button state, and its click also
/// reaches the application under the pointer.
pub fn set_lookup(app: &tauri::AppHandle, button: Option<Button>) {
    let bit = button.map_or(0, Button::bit);
    let previous = LOOKUP.swap(bit, Ordering::Relaxed);
    if bit == 0 {
        if previous != 0 && BOUND.load(Ordering::Relaxed) == 0 {
            // Nothing left for a hook to catch (only macOS's tap actually goes).
            let _ = crate::platform::sync_mouse_buttons(app, false);
            LOOKUP_SWALLOWED.store(false, Ordering::Relaxed);
        }
        return;
    }
    // Again on every call (the poll re-reads the setting every quarter second), so a tap refused
    // for want of Accessibility starts once it is allowed. Cheap while it runs.
    if cfg!(any(target_os = "windows", target_os = "macos")) {
        let _ = crate::platform::sync_mouse_buttons(app, true);
    }
}

/// The lookup button's bit, or 0; what a hook reads.
pub fn lookup() -> u8 {
    LOOKUP.load(Ordering::Relaxed)
}

pub fn set_over_own(over: bool) {
    OVER_OWN.store(over, Ordering::Relaxed);
}

/// Whether a lookup press is being held that a hook kept from the system.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub fn lookup_swallowed() -> bool {
    LOOKUP_SWALLOWED.load(Ordering::Relaxed)
}

/// One transition of the lookup button (`lookup`, a bit) against the hook's swallowed presses
/// (`owned`, updated in place). `None` when `button` is not the lookup button (the shortcut
/// bindings decide then). Pure but for `LOOKUP_SWALLOWED`, which follows `owned`.
///
/// - A press over Kimochi's own text (`over_own`) is swallowed: the game never sees the click
///   that asked for a lookup. Anywhere else it passes, so the button keeps working in every
///   other application (a middle click in a browser still opens a link in a new tab).
/// - A release is swallowed exactly when its press was, even if the lookup key changed since.
/// - Injected input (a remapper, a macro) is never swallowed; it still counts as held, read from
///   the system's button state, since that is how many mouse utilities send side buttons.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub fn lookup_step(
    owned: &mut u8,
    lookup: u8,
    over_own: bool,
    button: Button,
    down: bool,
    injected: bool,
) -> Option<Step> {
    let bit = button.bit();
    let step = if down {
        if lookup & bit == 0 {
            return None;
        }
        if over_own && !injected {
            *owned |= bit;
            Step::Swallow
        } else {
            *owned &= !bit;
            Step::Pass
        }
    } else if *owned & bit != 0 {
        *owned &= !bit;
        Step::Swallow
    } else if lookup & bit != 0 {
        Step::Pass
    } else {
        return None;
    };
    LOOKUP_SWALLOWED.store(*owned & lookup != 0, Ordering::Relaxed);
    Some(step)
}

/// `lookup_step` with the live lookup button and pointer: what a hook calls.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub fn lookup_transition(owned: &mut u8, button: Button, down: bool, injected: bool) -> Option<Step> {
    let lookup = lookup();
    if lookup == 0 && *owned == 0 {
        return None;
    }
    lookup_step(owned, lookup, OVER_OWN.load(Ordering::Relaxed), button, down, injected)
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
    fn the_lookup_button_is_kept_from_the_game_only_over_kimochis_text() {
        let lookup = Button::Middle.bit();
        let mut owned = 0;
        // Over the overlay's words: press and release both swallowed.
        assert_eq!(lookup_step(&mut owned, lookup, true, Button::Middle, true, false), Some(Step::Swallow));
        assert_eq!(lookup_step(&mut owned, lookup, false, Button::Middle, false, false), Some(Step::Swallow));
        assert_eq!(owned, 0);
        // Anywhere else: the application under the pointer gets its middle click.
        assert_eq!(lookup_step(&mut owned, lookup, false, Button::Middle, true, false), Some(Step::Pass));
        // Moving onto the words while held does not eat a release whose press went through.
        assert_eq!(lookup_step(&mut owned, lookup, true, Button::Middle, false, false), Some(Step::Pass));
        // Other buttons are left to the shortcut bindings.
        assert_eq!(lookup_step(&mut owned, lookup, true, Button::Back, true, false), None);
        assert_eq!(lookup_step(&mut owned, lookup, true, Button::Back, false, false), None);
    }

    #[test]
    fn a_lookup_release_follows_its_press_when_the_key_changes_in_between() {
        let mut owned = 0;
        assert_eq!(lookup_step(&mut owned, Button::Back.bit(), true, Button::Back, true, false), Some(Step::Swallow));
        // The lookup key went back to Shift while the button was held: its release is still eaten.
        assert_eq!(lookup_step(&mut owned, 0, true, Button::Back, false, false), Some(Step::Swallow));
        assert_eq!(owned, 0);
        assert_eq!(lookup_step(&mut owned, 0, true, Button::Back, true, false), None);
    }

    #[test]
    fn injected_lookup_presses_are_never_swallowed() {
        let mut owned = 0;
        let lookup = Button::Forward.bit();
        assert_eq!(lookup_step(&mut owned, lookup, true, Button::Forward, true, true), Some(Step::Pass));
        assert_eq!(lookup_step(&mut owned, lookup, true, Button::Forward, false, true), Some(Step::Pass));
        assert_eq!(owned, 0);
    }

    #[test]
    fn a_lookup_key_names_a_button_or_a_modifier() {
        assert_eq!(lookup_button("MouseMiddle"), Some(Button::Middle));
        assert_eq!(lookup_button("MouseBack"), Some(Button::Back));
        assert_eq!(lookup_button("MouseForward"), Some(Button::Forward));
        for key in ["shift", "ctrl", "alt", "meta", ""] {
            assert_eq!(lookup_button(key), None, "{key}");
        }
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
