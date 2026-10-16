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
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

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
        #[cfg(target_os = "linux")]
        let mut deck = crate::platform::deck_input::Reader::new();
        #[cfg(target_os = "linux")]
        let mut previous_system_menu = false;
        let mut previous: Vec<bool> = vec![false; STANDARD.len()];
        // The stick positions last sent in a `controller-nav` event.
        let mut reported = [(0.0, 0.0); 2];
        // The last `gamepad` event and when it went out, so an unchanged state is not resent
        // every tick to every window.
        let mut broadcast: Option<(Value, Instant)> = None;
        let mut last_tick = Instant::now();
        loop {
            // Wake as soon as input arrives rather than on a fixed frame, so a stick sweeping
            // the controller menu is reported the moment it moves. The timeout keeps hotplug
            // and settings current while nothing is pressed; MIN_TICK lets a burst of events
            // settle into one tick instead of one tick each.
            let _ = gilrs.next_event_blocking(Some(IDLE_TICK));
            let since = last_tick.elapsed();
            if since < MIN_TICK {
                std::thread::sleep(MIN_TICK - since);
            }
            last_tick = Instant::now();
            // Drain the queue so connect/disconnect and button state stay current.
            while gilrs.next_event().is_some() {}
            if !service.settings.get_or("gamepadSettings.enabled", true) {
                BUTTONS_HELD.store(false, Ordering::SeqCst);
                hand_back_when_released(&app);
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
            #[cfg(target_os = "linux")]
            let (devices, active, buttons, axes) = {
                let sample = deck.poll();
                let mut devices = devices;
                if let Some(sample) = sample {
                    let index = devices.len();
                    devices.push(json!({"index": index, "id": "Steam Deck physical controller",
                        "connected": true, "mapping": "standard", "buttons": STANDARD.len(),
                        "axes": 4, "timestamp": 0, "source": "steam-deck-hidraw"}));
                    if preferred.is_none() || preferred == Some(index) {
                        (devices, Some(index), sample.buttons, sample.axes)
                    } else { (devices, active, buttons, axes) }
                } else { (devices, active, buttons, axes) }
            };
            #[cfg(target_os = "linux")]
            if crate::platform::gamescope::active() {
                let system_menu = deck.system_menu();
                if system_menu && !previous_system_menu {
                    crate::platform::gamescope::yield_to_steam(&app);
                    set_navigation(&app, false, false);
                }
                previous_system_menu = system_menu;
            }
            BUTTONS_HELD.store(buttons.contains(&true), Ordering::SeqCst);
            hand_back_when_released(&app);
            let state = json!({
                "gamepads": devices,
                "activeGamepadIndex": active,
                "buttonStates": buttons,
                "axisStates": axes,
            });
            #[cfg(target_os = "linux")]
            let state = {
                let mut state = state;
                if crate::platform::gamescope::active() {
                    state["controlsInputOwner"] = json!(crate::platform::gamescope::controls_routed());
                }
                state
            };
            // Every change goes out, and the unchanged state now and then, so a window opened
            // since still learns what is connected.
            let stale = broadcast
                .as_ref()
                .is_none_or(|(last, at)| *last != state || at.elapsed() >= RESEND_UNCHANGED);
            if stale {
                let _ = app.emit("gamepad", &state);
                broadcast = Some((state, Instant::now()));
            }
            // While the controller menu is open the controller drives the menu instead: the
            // overlay gets every change and nothing is dispatched, the menu's own chord
            // included (the overlay sees it pressed and closes itself).
            if navigating() {
                #[cfg(target_os = "linux")]
                if crate::platform::gamescope::active() && (!deck.connected() || deck.system_menu()) {
                    crate::platform::steam_input::handoff();
                    set_navigation(&app, false, false);
                    let _ = app.emit("controller-nav-cancel", json!({"reason": "Steam system button or physical controller disconnected"}));
                    previous = buttons;
                    continue;
                }
                let sticks = [stick(axes[0], axes[1]), stick(axes[2], axes[3])];
                if let Some(payload) = nav_report(&previous, &buttons, &mut reported, sticks) {
                    let _ = app.emit("controller-nav", payload);
                }
                previous = buttons;
                continue;
            }
            reported = [(0.0, 0.0); 2];
            // Rising edge only: holding a button must not repeat the action. While Settings
            // records a binding the press is still emitted above, so it can be assigned, but
            // it does not fire whatever the button is bound to now.
            let rising: Vec<bool> = buttons
                .iter()
                .zip(&previous)
                .map(|(now, before)| *now && !*before)
                .collect();
            if rising.contains(&true) && !crate::hotkeys::suspended() {
                dispatch_for_buttons(&app, &service, &buttons, &rising);
            }
            previous = buttons;
        }
    });
}

/// Ordinary controls own controller actions while focused; overlay navigation is separate.
static PANEL_FOCUS: Mutex<Option<String>> = Mutex::new(None);
static PANEL_FOCUS_REVISION: AtomicU64 = AtomicU64::new(0);

fn update_panel_focus(owner: &mut Option<String>, label: &str, focused: bool) -> bool {
    if focused {
        if owner.as_deref() == Some(label) { return false; }
        *owner = Some(label.to_owned());
        true
    } else if owner.as_deref() == Some(label) {
        *owner = None;
        true
    } else { false }
}

pub fn panel_focus(label: &str, focused: bool) {
    if !matches!(label, "log" | "settings" | "diagnostics" | "dictionary" | "welcome") { return; }
    let mut owner = PANEL_FOCUS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if update_panel_focus(&mut owner, label, focused) {
        PANEL_FOCUS_REVISION.fetch_add(1, Ordering::SeqCst);
    }
}

/// Whether one of Kimochi's ordinary windows (main, Settings, Diagnostics, Dictionary,
/// onboarding) has the keyboard. Never the overlay or the pop-up.
pub fn panel_focused() -> bool {
    #[cfg(target_os = "linux")]
    if crate::platform::gamescope::managed() && !crate::platform::gamescope::controls_routed() { return false; }
    PANEL_FOCUS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_some()
}

fn panel_action_allowed(name: &str, focused: bool) -> bool {
    !focused || name == "openControllerMenu"
}

fn delayed_scan_allowed(queued: u64, current: u64, focused: bool, navigation: bool, suspended: bool) -> bool {
    queued == current && !focused && !navigation && !suspended
}

/// The longest the poll waits for input before looking again anyway.
const IDLE_TICK: Duration = Duration::from_millis(16);
/// The shortest gap between ticks: input is picked up within this, at most 250 times a second.
const MIN_TICK: Duration = Duration::from_millis(4);
/// How often an unchanged `gamepad` state is sent again.
const RESEND_UNCHANGED: Duration = Duration::from_millis(500);

/// Controller navigation: the overlay's radial menu is open and the controller drives it.
static NAV: AtomicBool = AtomicBool::new(false);
/// The application that was in front when the menu took activation, to hand it back.
static NAV_RETURN: Mutex<Option<u32>> = Mutex::new(None);

/// Whether any button on the active controller was down at the last poll.
static BUTTONS_HELD: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
pub fn buttons_held() -> bool { BUTTONS_HELD.load(Ordering::SeqCst) }
/// The application to reactivate once every button is up, and when navigation ended.
static PENDING_RETURN: Mutex<Option<(u32, Instant)>> = Mutex::new(None);
/// The longest the game waits for its focus back while a button stays down.
const RETURN_WAIT_LIMIT: Duration = Duration::from_millis(1500);

fn pending_return() -> std::sync::MutexGuard<'static, Option<(u32, Instant)>> {
    PENDING_RETURN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn reactivate(app: &tauri::AppHandle, pid: u32) {
    let _ = app.run_on_main_thread(move || {
        let _ = crate::platform::activate_process(pid);
    });
}

/// Give the game its focus back once the button that closed the menu is up. Handed back while
/// B or A is still down, the game would see that button released and act on it.
fn hand_back_when_released(app: &tauri::AppHandle) {
    let mut pending = pending_return();
    let Some((pid, since)) = *pending else { return };
    // On macOS the menu's keys are global shortcuts, which a game reading the keyboard
    // directly (OpenEmu) still sees: the key that closed the menu waits too.
    #[cfg(target_os = "macos")]
    let held = BUTTONS_HELD.load(Ordering::SeqCst) || crate::platform::menu_keys_held();
    #[cfg(not(target_os = "macos"))]
    let held = BUTTONS_HELD.load(Ordering::SeqCst);
    if held && since.elapsed() < RETURN_WAIT_LIMIT {
        return;
    }
    *pending = None;
    reactivate(app, pid);
}

pub fn navigating() -> bool {
    NAV.load(Ordering::SeqCst)
}

/// Turn controller navigation on or off; the `controller_nav` command. Idempotent both ways.
///
/// On: gamepad input is reported as `controller-nav` instead of dispatching, the arrows,
/// Return and Escape arrive as `controller-key`, and — with `take_focus` — Kimochi takes
/// activation from the game so the game stops reading the same controller, with the overlay
/// made key so the keys land there. The application that was in front is remembered.
///
/// Off: all of that is undone, and the remembered application is reactivated, once no
/// controller button is down, so it never sees the release of the button that closed the menu.
///
/// Returns the remembered process id. Activation is scheduled on the main thread rather
/// than waited for, so this is safe to call from anywhere, including that thread.
pub fn set_navigation(app: &tauri::AppHandle, active: bool, take_focus: bool) -> Option<u32> {
    let mut remembered = NAV_RETURN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let was = NAV.swap(active, Ordering::SeqCst);
    if active {
        // Reopened before the game got its focus back: it is still the one to return to.
        if let Some((pid, _)) = pending_return().take() {
            remembered.get_or_insert(pid);
        }
        let local_keys = {
            #[cfg(target_os="linux")] { !take_focus && crate::platform::gnome::eligible_popup_session() }
            #[cfg(not(target_os="linux"))] { false }
        };
        if !was && !local_keys {
            if let Err(e) = crate::hotkeys::set_nav_keys(app, true) {
                log(
                    app,
                    json!({ "check": "controller-nav", "keys": "failed", "detail": e }),
                );
            }
        }
        // Taking activation stops games that read controllers only in the foreground.
        // Keyboard navigation takes it too: Windows' low-level hook keeps the menu's keys out
        // of the game, but macOS's global shortcuts don't stop a game that reads the keyboard
        // directly (OpenEmu). (Linux decides for itself, through its callers.)
        if take_focus {
            let ours = std::process::id();
            if let Some(pid) = crate::platform::frontmost_pid().filter(|pid| *pid != ours) {
                *remembered = Some(pid);
            }
            let handle = app.clone();
            // The overlay is what takes focus, never the main window: the menu is drawn
            // over the game, and the reader's other windows stay behind it.
            // The overlay is made key first: it is on every Space, so the activation that
            // follows finds a window of ours on the Space being shown and stays there, where
            // activating with the main window as the only candidate switched to its Space.
            let _ = app.run_on_main_thread(move || {
                let overlay = handle.get_webview_window("overlay");
                if let Some(overlay) = overlay.as_ref() {
                    let _ = crate::platform::promote_to_key(overlay);
                }
                let _ = crate::platform::activate_self(overlay.as_ref());
                if let Some(overlay) = overlay {
                    let _ = crate::platform::promote_to_key(&overlay);
                }
                #[cfg(target_os = "macos")]
                let service = handle.state::<Shared>().inner().clone();
                crate::record(&handle, &service, json!({ "check": "controller-nav-focus", "activation": crate::platform::last_self_activation() }));
            });
        }
        return *remembered;
    }
    if was {
        let _ = crate::hotkeys::set_nav_keys(app, false);
    }
    let previous = remembered.take();
    if let Some(pid) = previous {
        #[cfg(target_os = "macos")]
        let held = BUTTONS_HELD.load(Ordering::SeqCst) || crate::platform::menu_keys_held();
        #[cfg(not(target_os = "macos"))]
        let held = BUTTONS_HELD.load(Ordering::SeqCst);
        if held {
            *pending_return() = Some((pid, Instant::now()));
        } else {
            reactivate(app, pid);
        }
    }
    previous
}

/// Controller navigation belongs to the game and to Kimochi, and to nothing else.
///
/// While it is on, the arrows, Return and Escape are global shortcuts, which swallow those
/// keys in every application. So the moment some other application comes to the front — the
/// reader switched away — navigation ends on its own: the keys are given back, the app it
/// would have returned to is forgotten (they went somewhere else on purpose), and the overlay
/// is told with `controller-nav-cancel` so it closes the menu or read-along mode.
///
/// `front` is the frontmost application's pid, `source` the pid owning the selected window.
pub fn release_if_elsewhere(app: &tauri::AppHandle, front: Option<u32>, source: Option<u32>) {
    // The reader went somewhere else while the game waited for a button to come up: leave
    // them there.
    if front.is_some_and(|front| front != std::process::id()) {
        pending_return().take();
    }
    if !navigating() {
        return;
    }
    let Some(front) = front else { return };
    let returning_to = *NAV_RETURN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if front == std::process::id() || Some(front) == returning_to || Some(front) == source {
        return;
    }
    NAV_RETURN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    set_navigation(app, false, false);
    log(
        app,
        json!({ "check": "controller-nav", "cancelled": "another application came to the front", "frontmost": front }),
    );
    let _ = app.emit("controller-nav-cancel", json!({ "frontmost": front }));
}

fn log(app: &tauri::AppHandle, entry: Value) {
    app.state::<Shared>().inner().log(entry);
}

/// Inside this radius a stick reads as centred; worn sticks rarely rest at exactly zero.
const DEADZONE: f64 = 0.25;
/// The smallest stick movement worth an event.
const STICK_STEP: f64 = 0.02;

/// A stick position in [-1, 1] on both axes, rounded to two places, with a radial deadzone.
/// `y` is positive *up*, as gilrs reports it — the opposite of screen coordinates.
fn stick(x: f64, y: f64) -> (f64, f64) {
    if x.hypot(y) < DEADZONE {
        return (0.0, 0.0);
    }
    let round = |v: f64| (v.clamp(-1.0, 1.0) * 100.0).round() / 100.0;
    (round(x), round(y))
}

/// The `controller-nav` payload for this tick, or `None` when nothing worth reporting
/// changed: no button edge, and neither stick moved by `STICK_STEP` since it was last
/// reported (a stick returning to centre is always reported). `reported` holds the stick
/// positions last sent and is updated when this returns a payload.
fn nav_report(
    previous: &[bool],
    buttons: &[bool],
    reported: &mut [(f64, f64); 2],
    sticks: [(f64, f64); 2],
) -> Option<Value> {
    let indices = |test: &dyn Fn(bool, bool) -> bool| -> Vec<usize> {
        buttons
            .iter()
            .zip(previous)
            .enumerate()
            .filter(|(_, (now, before))| test(**now, **before))
            .map(|(index, _)| index)
            .collect()
    };
    let pressed = indices(&|now, before| now && !before);
    let released = indices(&|now, before| !now && before);
    let moved = sticks.iter().zip(reported.iter()).any(|(now, last)| {
        let centred = *now == (0.0, 0.0) && *last != (0.0, 0.0);
        centred || (now.0 - last.0).abs() >= STICK_STEP || (now.1 - last.1).abs() >= STICK_STEP
    });
    if pressed.is_empty() && released.is_empty() && !moved {
        return None;
    }
    *reported = sticks;
    let held = indices(&|now, _| now);
    let [(x, y), (rx, ry)] = sticks;
    Some(json!({
        "pressed": pressed,
        "released": released,
        "held": held,
        "stick": { "x": x, "y": y },
        "rstick": { "x": rx, "y": ry },
    }))
}

/// Which binding a tick's presses fire: among the chords that are fully held and include a
/// button pressed this tick, the one with the most buttons, so LS + RS beats a binding on
/// LS alone. Ties go to the earliest binding, which callers list in `HOTKEY_ACTIONS` order.
fn chord_to_fire<'a>(
    bindings: &[(&'a str, Vec<usize>)],
    held: &[bool],
    rising: &[bool],
) -> Option<&'a str> {
    let is = |states: &[bool], index: &usize| states.get(*index).copied().unwrap_or(false);
    let mut best: Option<(&str, usize)> = None;
    for (name, chord) in bindings {
        if chord.is_empty()
            || !chord.iter().all(|b| is(held, b))
            || !chord.iter().any(|b| is(rising, b))
        {
            continue;
        }
        if best.is_none_or(|(_, size)| chord.len() > size) {
            best = Some((name, chord.len()));
        }
    }
    best.map(|(name, _)| name)
}

fn dispatch_for_buttons(app: &tauri::AppHandle, service: &Shared, held: &[bool], rising: &[bool]) {
    let focused = panel_focused();
    let hotkeys = crate::settings::merged_hotkeys(&service.settings);
    let bindings: Vec<(&str, Vec<usize>)> = actions::HOTKEY_ACTIONS
        .iter()
        .filter_map(|name| {
            if !panel_action_allowed(name, focused) { return None; }
            let definition = hotkeys.get(*name)?;
            if definition.get("enabled") == Some(&Value::Bool(false)) {
                return None;
            }
            Some((*name, crate::settings::gamepad_chord(definition)))
        })
        .collect();
    if let Some(name) = chord_to_fire(&bindings, held, rising) {
        actions::dispatch(app, service, name);
        return;
    }
    if focused { return; }
    // The Auto-scan switch gates the button; with it off a saved button does nothing.
    if !service.settings.get_or("autoScanSettings.enabled", false) { return; }
    let auto: Option<usize> = service
        .settings
        .get_or("autoScanSettings.gamepadButton", None);
    if auto.is_some_and(|index| rising.get(index).copied().unwrap_or(false)) {
        let delay = service
            .settings
            .get_or::<f64>("autoScanSettings.scanDelay", 500.0)
            .clamp(0.0, 10_000.0);
        let revision = PANEL_FOCUS_REVISION.load(Ordering::SeqCst);
        let app = app.clone();
        let service = service.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay as u64));
            if !delayed_scan_allowed(revision, PANEL_FOCUS_REVISION.load(Ordering::SeqCst),
                panel_focused(), navigating(), crate::hotkeys::suspended()) { return; }
            actions::dispatch(&app, &service, "triggerScan");
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_focus_transfer_ignores_late_blur_from_previous_window() {
        let mut owner = None;
        assert!(update_panel_focus(&mut owner, "log", true));
        assert!(update_panel_focus(&mut owner, "dictionary", true));
        assert!(!update_panel_focus(&mut owner, "log", false));
        assert_eq!(owner.as_deref(), Some("dictionary"));
        assert!(update_panel_focus(&mut owner, "dictionary", false));
        assert!(owner.is_none());
    }

    #[test]
    fn focused_controls_suppress_scan_bindings_but_preserve_menu_chord() {
        let bindings = [("triggerScan", vec![0]), ("openControllerMenu", vec![10, 11])];
        let allowed: Vec<_> = bindings.into_iter().filter(|(name, _)| panel_action_allowed(name, true)).collect();
        assert_eq!(chord_to_fire(&allowed, &states(&[0]), &states(&[0])), None);
        assert_eq!(chord_to_fire(&allowed, &states(&[10, 11]), &states(&[11])), Some("openControllerMenu"));
        assert!(panel_action_allowed("triggerScan", false));
    }

    #[test]
    fn queued_scan_is_cancelled_when_controls_acquire_then_release_focus() {
        assert!(delayed_scan_allowed(1, 1, false, false, false));
        assert!(!delayed_scan_allowed(1, 3, false, false, false));
        assert!(!delayed_scan_allowed(1, 1, true, false, false));
        assert!(!delayed_scan_allowed(1, 1, false, true, false));
        assert!(!delayed_scan_allowed(1, 1, false, false, true));
    }

    #[test]
    fn standard_mapping_matches_the_web_gamepad_order() {
        // Indices stored by the Electron build must keep their meaning.
        assert_eq!(STANDARD[0], Button::South);
        assert_eq!(STANDARD[9], Button::Start);
        assert_eq!(STANDARD[12], Button::DPadUp);
        assert_eq!(STANDARD.len(), 17);
    }

    fn states(indices: &[usize]) -> Vec<bool> {
        (0..STANDARD.len()).map(|i| indices.contains(&i)).collect()
    }

    #[test]
    fn the_largest_fully_held_chord_fires() {
        let bindings = [
            ("triggerScan", vec![10]),
            ("openControllerMenu", vec![10, 11]),
        ];
        // RS joins a held LS: both chords include the new press, the larger one wins.
        assert_eq!(
            chord_to_fire(&bindings, &states(&[10, 11]), &states(&[11])),
            Some("openControllerMenu")
        );
        // LS alone fires the single-button binding.
        assert_eq!(
            chord_to_fire(&bindings, &states(&[10]), &states(&[10])),
            Some("triggerScan")
        );
        // Holding a chord without a new press fires nothing.
        assert_eq!(
            chord_to_fire(&bindings, &states(&[10, 11]), &states(&[])),
            None
        );
        // A partly held chord fires nothing on its own.
        let menu_only = [("openControllerMenu", vec![10, 11])];
        assert_eq!(
            chord_to_fire(&menu_only, &states(&[11]), &states(&[11])),
            None
        );
        // A press unrelated to a held chord does not fire it.
        assert_eq!(
            chord_to_fire(&menu_only, &states(&[0, 10, 11]), &states(&[0])),
            None
        );
    }

    #[test]
    fn chord_ties_go_to_the_first_binding_and_empty_chords_never_fire() {
        let bindings = [
            ("triggerScan", vec![]),
            ("openControllerMenu", vec![4, 5]),
            ("later", vec![5, 6]),
        ];
        assert_eq!(
            chord_to_fire(&bindings, &states(&[4, 5, 6]), &states(&[5])),
            Some("openControllerMenu")
        );
    }

    #[test]
    fn sticks_have_a_radial_deadzone_and_two_decimals() {
        assert_eq!(stick(0.2, 0.1), (0.0, 0.0));
        assert_eq!(stick(0.0, 0.3), (0.0, 0.3));
        assert_eq!(stick(0.123_456, -0.987_654), (0.12, -0.99));
        assert_eq!(stick(1.5, 0.0), (1.0, 0.0));
    }

    #[test]
    fn nav_reports_edges_and_stick_movement_only() {
        let mut reported = [(0.0, 0.0); 2];
        let still = [(0.0, 0.0); 2];
        assert!(nav_report(&states(&[]), &states(&[]), &mut reported, still).is_none());

        let report = nav_report(&states(&[10]), &states(&[0, 10]), &mut reported, still).unwrap();
        assert_eq!(report["pressed"], json!([0]));
        assert_eq!(report["released"], json!([]));
        assert_eq!(report["held"], json!([0, 10]));

        let tilted = [(0.5, 0.0), (0.0, 0.0)];
        let report = nav_report(&states(&[]), &states(&[]), &mut reported, tilted).unwrap();
        assert_eq!(report["stick"], json!({"x": 0.5, "y": 0.0}));
        // Less than a step since the last report: nothing.
        let nudged = [(0.51, 0.0), (0.0, 0.0)];
        assert!(nav_report(&states(&[]), &states(&[]), &mut reported, nudged).is_none());
        // Back to centre is always reported.
        let report = nav_report(&states(&[]), &states(&[]), &mut reported, still).unwrap();
        assert_eq!(report["stick"], json!({"x": 0.0, "y": 0.0}));
        assert_eq!(report["released"], json!([]));
    }
}
