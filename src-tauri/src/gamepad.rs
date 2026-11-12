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
    // gilrs reports a controller it cannot read (Windows.Gaming.Input's id or reading failing)
    // only through `log`, then skips it: without this a pad that is listed but never presses
    // leaves nothing behind.
    install_gilrs_log();
    let mut gilrs = match Gilrs::new() {
        Ok(gilrs) => gilrs,
        Err(e) => {
            crate::debug_report::record_now(json!({
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
        let mut deck = crate::platform::deck_input::Reader::with_desktop();
        #[cfg(target_os = "linux")]
        let mut previous_system_menu = false;
        let mut previous: Vec<bool> = vec![false; STANDARD.len()];
        // The stick positions last sent in a `controller-nav` event.
        let mut reported = [(0.0, 0.0); 2];
        // The last `gamepad` event and when it went out, so an unchanged state is not resent
        // every tick to every window.
        let mut broadcast: Option<(Value, Instant)> = None;
        let mut last_tick = Instant::now();
        // The controllers last recorded as connected, so the diagnostics log names each change.
        let mut logged_pads: Option<Vec<String>> = None;
        let mut raw = RawEventLog::default();
        loop {
            // Wake as soon as input arrives rather than on a fixed frame, so a stick sweeping
            // the controller menu is reported the moment it moves. The timeout keeps hotplug
            // and settings current while nothing is pressed; MIN_TICK lets a burst of events
            // settle into one tick instead of one tick each.
            if let Some(event) = gilrs.next_event_blocking(Some(IDLE_TICK)) {
                raw.note(&gilrs, &event);
            }
            let since = last_tick.elapsed();
            if since < MIN_TICK {
                std::thread::sleep(MIN_TICK - since);
            }
            last_tick = Instant::now();
            // Drain the queue so connect/disconnect and button state stay current.
            while let Some(event) = gilrs.next_event() {
                raw.note(&gilrs, &event);
            }
            if !service.settings.get_or("gamepadSettings.enabled", true) {
                BUTTONS_HELD.store(false, Ordering::SeqCst);
                LOOKUP_HELD.store(false, Ordering::SeqCst);
                hand_back_when_released(&app);
                continue;
            }
            let preferred: Option<usize> = service
                .settings
                .get_or("gamepadSettings.preferredGamepadIndex", None);
            let pads: Vec<_> = gilrs.gamepads().collect();
            let names: Vec<String> = pads.iter().filter(|(_, pad)| pad.is_connected()).map(|(_, pad)| pad.name().to_owned()).collect();
            if logged_pads.as_ref() != Some(&names) {
                // Always on disk, not only in the Debug panel: which pads, and how gilrs reads
                // each, is the first question for "listed but no button lights up".
                crate::debug_report::record_now(json!({
                    "check": "gamepad",
                    "connected": names,
                    "backend": BACKEND,
                    "pads": pads.iter().enumerate().map(|(index, (_, pad))| describe_pad(index, pad)).collect::<Vec<_>>(),
                }));
                logged_pads = Some(names);
            }
            let devices: Vec<_> = pads
                .iter()
                .enumerate()
                .map(|(index, (_, pad))| {
                    let mut device = json!({
                        "index": index,
                        "id": pad.name(),
                        "connected": pad.is_connected(),
                        // gilrs normalises to a standard layout, which is what the
                        // stored button indices assume.
                        "mapping": "standard",
                        "buttons": STANDARD.len(),
                        "axes": 4,
                        "timestamp": 0,
                    });
                    if let (Some(device), Some(raw)) = (device.as_object_mut(), raw_activity(pad).as_object()) {
                        device.extend(raw.clone());
                    }
                    device
                })
                .collect();
            let last_pressed = raw.last_pressed.and_then(|id| pads.iter().position(|(pad, _)| *pad == id));
            let active = pick_active(preferred, pads.len(), last_pressed);
            raw.active = active.and_then(|index| pads.get(index)).map(|(id, _)| *id);
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
            // The Deck's own buttons, active or not: the lookup button is read there too.
            #[allow(unused_mut)]
            let mut physical: Option<Vec<bool>> = None;
            #[cfg(target_os = "linux")]
            let (devices, active, buttons, axes) = {
                let sample = deck.poll();
                let mut devices = devices;
                if let Some(sample) = sample {
                    physical = Some(sample.buttons.clone());
                    let index = devices.len();
                    // The standard 17, then the back grips and trackpad clicks (deck_input.rs).
                    devices.push(json!({"index": index, "id": "Steam Deck physical controller",
                        "connected": true, "mapping": "standard", "buttons": sample.buttons.len(),
                        "axes": 4, "timestamp": 0, "source": "steam-deck-hidraw"}));
                    if !crate::platform::gamescope::active() {
                        // Desktop Mode: Steam's layout already turns the standard buttons into
                        // keys and the mouse for a desktop window, or into its virtual pad (read
                        // above) for a game, so reading them here too would act on presses twice.
                        // Only what the pad lacks is added after them: the back grips and the
                        // trackpad clicks, which Steam's layouts leave unbound.
                        let buttons = with_deck_extras(buttons, &sample.buttons);
                        (devices, active, buttons, axes)
                    } else if preferred.is_none() || preferred == Some(index) {
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
            let lookup: Option<usize> = service.settings.get_or("gamepadSettings.lookupButton", None);
            LOOKUP_HELD.store(
                !navigating() && lookup_button_held(lookup, &buttons, physical.as_deref()),
                Ordering::SeqCst,
            );
            hand_back_when_released(&app);
            // `overlayNavigation`: the overlay's controller menu or reading has the controller, so
            // a focused panel must not act on the same presses (ui/panel-controller.js). Opening
            // it brings Kimochi to the front, and the Log window can be the one with focus.
            let state = json!({
                "gamepads": devices,
                "activeGamepadIndex": active,
                "buttonStates": buttons,
                "axisStates": axes.iter().map(|value| broadcast_axis(*value)).collect::<Vec<_>>(),
                "overlayNavigation": navigating(),
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
            let stale = broadcast.as_ref().is_none_or(|(last, at)| {
                let since = at.elapsed();
                since >= RESEND_UNCHANGED
                    || (*last != state
                        && (since >= STICK_TICK || last["buttonStates"] != state["buttonStates"]))
            });
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

/// The gilrs backend this build reads controllers with.
const BACKEND: &str = if cfg!(windows) { "windows-gaming-input" } else if cfg!(target_os = "macos") { "iokit" } else { "evdev" };

/// One controller as gilrs sees it, for the diagnostics log. The uuid and ids name the model,
/// never the person.
fn describe_pad(index: usize, pad: &gilrs::Gamepad) -> Value {
    json!({
        "index": index,
        "name": pad.name(),
        "osName": pad.os_name(),
        "connected": pad.is_connected(),
        "vendor": pad.vendor_id().map(|id| format!("{id:04x}")),
        "product": pad.product_id().map(|id| format!("{id:04x}")),
        "uuid": pad.uuid().iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
        "mapping": format!("{:?}", pad.mapping_source()),
        "power": format!("{:?}", pad.power_info()),
    })
}

/// The controller the poll reads, by position among the connected ones: the primary chosen in
/// Settings while it is connected, else the one a button was last pressed on, else the first.
///
/// Following the last press is what makes "listed but nothing lights up" go away when the first
/// controller in the list is a silent one: the virtual pad of Steam Input, DS4Windows or ViGEm
/// beside the real controller, a receiver, a wheel, or a keyboard that also reports a gamepad.
fn pick_active(preferred: Option<usize>, count: usize, last_pressed: Option<usize>) -> Option<usize> {
    preferred
        .filter(|index| *index < count)
        .or(last_pressed.filter(|index| *index < count))
        .or((count > 0).then_some(0))
}

/// Below this an axis is at rest in the raw activity Settings shows.
const RAW_AXIS_SHOWN: f32 = 0.5;

/// What a controller is sending right now, whatever the standard layout makes of it: every button
/// held by its raw code (with the standard index it reads as, or none), and every axis pushed past
/// half way, rounded to a half so a resting stick does not resend the state. Settings shows it
/// under the button test, so a press that never reaches the standard buttons is still seen.
fn raw_activity(pad: &gilrs::Gamepad) -> Value {
    use gilrs::ev::AxisOrBtn;
    let mut buttons: Vec<Value> = pad
        .state()
        .buttons()
        .filter(|(_, data)| data.is_pressed())
        .map(|(code, _)| {
            let standard = match pad.axis_or_btn_name(code) {
                Some(AxisOrBtn::Btn(button)) => STANDARD.iter().position(|b| *b == button),
                _ => None,
            };
            json!({ "code": code.to_string(), "standard": standard })
        })
        .collect();
    let mut axes: Vec<Value> = pad
        .state()
        .axes()
        .filter(|(_, data)| data.value().is_finite() && data.value().abs() >= RAW_AXIS_SHOWN)
        .map(|(code, data)| {
            let name = match pad.axis_or_btn_name(code) {
                Some(AxisOrBtn::Axis(axis)) => Some(format!("{axis:?}")),
                Some(AxisOrBtn::Btn(button)) => Some(format!("{button:?}")),
                None => None,
            };
            json!({ "code": code.to_string(), "name": name, "value": (data.value() * 2.0).round() / 2.0 })
        })
        .collect();
    // The state is a hash map: a stable order keeps an unchanged state from looking changed.
    let by_code = |a: &Value, b: &Value| a["code"].as_str().cmp(&b["code"].as_str());
    buttons.sort_by(by_code);
    axes.sort_by(by_code);
    json!({
        "name": pad.name(),
        "mappingSource": format!("{:?}", pad.mapping_source()),
        "vendor": pad.vendor_id().map(|id| format!("{id:04x}")),
        "product": pad.product_id().map(|id| format!("{id:04x}")),
        "rawButtons": buttons,
        "rawAxes": axes,
    })
}

/// How many raw button and axis events verbose logging records one by one per run; after that
/// `vitals` only counts them.
const RAW_BUTTON_EVENTS: u32 = 40;
const RAW_AXIS_EVENTS: u32 = 10;

/// What gilrs itself delivers, before the standard layout. A pad whose presses arrive as
/// `Unknown` buttons (a mapping gilrs lacks) reads as never pressed; a pad that sends nothing at
/// all points at the backend or at something holding the controller (Steam Input, remappers).
///
/// Always: which controller was pressed last (it becomes the active one while no primary is
/// chosen), and, once per controller, its first press and its first press the standard layout
/// cannot name. Verbose: the first raw events one by one.
#[derive(Default)]
struct RawEventLog {
    buttons: u32,
    axes: u32,
    /// The controller a button was last pressed on.
    last_pressed: Option<gilrs::GamepadId>,
    /// The controller the poll read at the last tick, to say whether a press reached it.
    active: Option<gilrs::GamepadId>,
    first_press: Vec<gilrs::GamepadId>,
    first_unmapped: Vec<gilrs::GamepadId>,
}

/// A button press as gilrs reports it: the button it was mapped to (`Unknown` when the layout has
/// no name for it) and its raw code. Axis-only D-pads and analog triggers arrive here too, turned
/// into presses by gilrs's filters and mapping.
fn pressed_button(event: &gilrs::EventType) -> Option<(Button, gilrs::ev::Code)> {
    match *event {
        gilrs::EventType::ButtonPressed(button, code) => Some((button, code)),
        _ => None,
    }
}

impl RawEventLog {
    fn note(&mut self, gilrs: &Gilrs, event: &gilrs::Event) {
        use gilrs::EventType;
        if let Some((button, code)) = pressed_button(&event.event) {
            self.last_pressed = Some(event.id);
            let pad = gilrs.gamepad(event.id);
            let unmapped = button == Button::Unknown;
            let first = !self.first_press.contains(&event.id);
            let first_unmapped = unmapped && !self.first_unmapped.contains(&event.id);
            if first || first_unmapped {
                if first {
                    self.first_press.push(event.id);
                }
                if first_unmapped {
                    self.first_unmapped.push(event.id);
                }
                // On disk without verbose logging: whether presses arrive at all, on which
                // controller, and whether the standard layout can name them.
                crate::debug_report::record_now(json!({
                    "check": if first { "gamepad-first-press" } else { "gamepad-unmapped-press" },
                    "pad": usize::from(event.id),
                    "name": pad.name(),
                    "active": self.active.is_none_or(|active| active == event.id),
                    "button": format!("{button:?}"),
                    "code": code.to_string(),
                    "standardIndex": STANDARD.iter().position(|b| *b == button),
                    "mapping": format!("{:?}", pad.mapping_source()),
                }));
            }
        }
        if !crate::debug_report::verbose() {
            return;
        }
        let (kind, detail) = match event.event {
            EventType::ButtonPressed(button, code)
            | EventType::ButtonRepeated(button, code)
            | EventType::ButtonReleased(button, code) => {
                ("button", json!({ "button": format!("{button:?}"), "code": code.to_string() }))
            }
            EventType::ButtonChanged(button, value, code) => {
                ("button", json!({ "button": format!("{button:?}"), "value": value, "code": code.to_string() }))
            }
            EventType::AxisChanged(axis, value, code) => {
                ("axis", json!({ "axis": format!("{axis:?}"), "value": value, "code": code.to_string() }))
            }
            _ => {
                crate::debug_report::count("gamepad-other-event");
                crate::debug_report::trace_now(json!({
                    "check": "gamepad-raw", "event": format!("{:?}", event.event), "pad": usize::from(event.id),
                }));
                return;
            }
        };
        let (budget, limit) = if kind == "button" {
            crate::debug_report::count("gamepad-button-event");
            (&mut self.buttons, RAW_BUTTON_EVENTS)
        } else {
            crate::debug_report::count("gamepad-axis-event");
            (&mut self.axes, RAW_AXIS_EVENTS)
        };
        if *budget >= limit {
            return;
        }
        *budget += 1;
        let pad = gilrs.gamepad(event.id);
        let name = format!("{:?}", event.event);
        let mut value = json!({
            "check": "gamepad-raw",
            "event": name.split('(').next().unwrap_or_default(),
            "pad": usize::from(event.id),
            "name": pad.name(),
            // False: the controller pressed is not the one being read (a primary is chosen).
            "active": self.active.is_none_or(|active| active == event.id),
            // What the standard layout reads right after it: empty while a button is down means
            // the press never reaches the buttons Kimochi binds.
            "standardPressed": STANDARD.iter().enumerate().filter(|(_, b)| pad.is_pressed(**b)).map(|(i, _)| i).collect::<Vec<_>>(),
        });
        if let (Some(target), Some(extra)) = (value.as_object_mut(), detail.as_object()) {
            target.extend(extra.clone());
        }
        if *budget == limit {
            value["last"] = json!(true);
        }
        crate::debug_report::trace_now(value);
    }
}

/// Forwards gilrs's own warnings and errors to the diagnostics log; everything else is dropped.
struct GilrsLog;

impl log::Log for GilrsLog {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Warn && metadata.target().starts_with("gilrs")
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            crate::debug_report::record_now(json!({
                "check": "gamepad-backend",
                "level": record.level().as_str(),
                "target": record.target(),
                "message": record.args().to_string(),
            }));
        }
    }
    fn flush(&self) {}
}

fn install_gilrs_log() {
    static LOGGER: GilrsLog = GilrsLog;
    // Nothing else in Kimochi installs a `log` logger; if something ever does, it keeps its place.
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Warn);
    }
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
/// Stick movement alone goes out at most this often; a button change goes out at once.
const STICK_TICK: Duration = Duration::from_millis(16);
/// Below this a stick is at rest in `gamepad` events: the Deck's sticks jitter around zero
/// in every report (about 230 a second), which otherwise woke every window each time.
const BROADCAST_DEADZONE: f64 = 0.08;

/// A stick axis as windows see it: at rest inside the dead zone, else in steps of 0.02.
fn broadcast_axis(value: f64) -> f64 {
    if !value.is_finite() || value.abs() < BROADCAST_DEADZONE {
        0.0
    } else {
        (value * 50.0).round() / 50.0
    }
}

/// Controller navigation: the overlay's radial menu is open and the controller drives it.
static NAV: AtomicBool = AtomicBool::new(false);
/// The application that was in front when the menu took activation, to hand it back.
static NAV_RETURN: Mutex<Option<u32>> = Mutex::new(None);

/// Whether any button on the active controller was down at the last poll.
static BUTTONS_HELD: AtomicBool = AtomicBool::new(false);

/// Whether the lookup button (`gamepadSettings.lookupButton`) is held: the pointer poll then
/// reads it as the lookup key held (`overlayLookupKey`, Shift by default), so a reader with only a
/// controller (a Steam Deck's trackpad and buttons) looks words up by holding it and moving the
/// pointer. Never while the controller menu has the controller.
static LOOKUP_HELD: AtomicBool = AtomicBool::new(false);

pub fn lookup_held() -> bool {
    LOOKUP_HELD.load(Ordering::Relaxed)
}

/// The active controller's standard buttons, then the Deck's own buttons after them (the back
/// grips and trackpad clicks, `deck_input.rs`), so they can be bound in Desktop Mode too.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn with_deck_extras(mut buttons: Vec<bool>, deck: &[bool]) -> Vec<bool> {
    buttons.resize(STANDARD.len(), false);
    buttons.extend(deck.iter().skip(STANDARD.len()));
    buttons
}

/// The lookup button is down on the active controller or, on a Steam Deck, on the Deck's own
/// controller (the back grips are only there).
fn lookup_button_held(button: Option<usize>, active: &[bool], physical: Option<&[bool]>) -> bool {
    let Some(button) = button else { return false };
    let down = |states: &[bool]| states.get(button).copied().unwrap_or(false);
    down(active) || physical.is_some_and(down)
}
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
        // No global keys in Gaming Mode either: the overlay reads only the controller there
        // (ui/overlay.js `padOnly`), and Steam types the D-pad as arrow keys too, so a grab on
        // them took the overlay's keyboard focus at every press. The blur cancelled Hachidori's
        // lookup in flight, and the word showed nothing.
        let local_keys = {
            #[cfg(target_os="linux")] { (!take_focus && crate::platform::gnome::eligible_popup_session()) || crate::platform::gamescope::active() }
            #[cfg(not(target_os="linux"))] { false }
        };
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
                {
                    let service = handle.state::<Shared>().inner().clone();
                    crate::record(&handle, &service, json!({ "check": "controller-nav-focus", "activation": crate::platform::last_self_activation() }));
                }
            });
        }
        let previous = *remembered;
        // Never with NAV_RETURN held: from a background thread, registering waits for the
        // main thread, which may itself be waiting for NAV_RETURN here (a deadlock that
        // froze Gaming Mode with the overlay holding Gamescope's input).
        drop(remembered);
        if !was && !local_keys {
            if let Err(e) = crate::hotkeys::set_nav_keys(app, true) {
                log(
                    app,
                    json!({ "check": "controller-nav", "keys": "failed", "detail": e }),
                );
            }
        }
        return previous;
    }
    let previous = remembered.take();
    drop(remembered);
    if was {
        let _ = crate::hotkeys::set_nav_keys(app, false);
    }
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
    // Gamescope never makes Kimochi the active window on its X display while the game keeps
    // the base layer, so this would end every controller menu a moment after it opened.
    // Losing input there is handled by platform/linux/gamescope.rs (Steam's buttons, focus).
    #[cfg(target_os = "linux")]
    if crate::platform::gamescope::active() {
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
    let pressed: Vec<usize> = rising.iter().enumerate().filter(|(_, r)| **r).map(|(i, _)| i).collect();
    // Verbose only: a debug report then says what each press did, and why a scan didn't follow.
    let trace = |outcome: &str| {
        crate::debug_report::trace(app, json!({
            "check": "gamepad-press", "pressed": pressed, "panelFocused": focused, "outcome": outcome,
        }));
    };
    if let Some(name) = chord_to_fire(&bindings, held, rising) {
        trace(name);
        actions::dispatch(app, service, name);
        return;
    }
    let enabled = service.settings.get_or("autoScanSettings.enabled", false);
    let auto: Option<usize> = service
        .settings
        .get_or("autoScanSettings.gamepadButton", None);
    let Some(index) = auto.filter(|index| rising.get(*index).copied().unwrap_or(false)) else {
        trace("none");
        return;
    };
    // The controller works Kimochi's own window while one is in front (usePanelController).
    if focused { trace("auto-scan skipped: a Kimochi window has focus"); return; }
    // The switch gates the button; with it off a saved button does nothing.
    if !enabled { trace("auto-scan skipped: switched off"); return; }
    let delay = service
        .settings
        .get_or::<f64>("autoScanSettings.scanDelay", 500.0)
        .clamp(0.0, 10_000.0);
    trace("auto-scan queued");
    let revision = PANEL_FOCUS_REVISION.load(Ordering::SeqCst);
    let app = app.clone();
    let service = service.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(delay as u64));
        let (current, focused, navigation, suspended) = (
            PANEL_FOCUS_REVISION.load(Ordering::SeqCst), panel_focused(), navigating(), crate::hotkeys::suspended(),
        );
        if !delayed_scan_allowed(revision, current, focused, navigation, suspended) {
            crate::debug_report::trace(&app, json!({
                "check": "gamepad-press", "pressed": [index], "outcome": "auto-scan cancelled",
                "focusChanged": revision != current, "panelFocused": focused,
                "navigating": navigation, "suspended": suspended,
            }));
            return;
        }
        actions::dispatch(&app, &service, "triggerScan");
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn resting_stick_jitter_is_not_broadcast() {
        assert_eq!(broadcast_axis(0.0025), 0.0);
        assert_eq!(broadcast_axis(-0.07), 0.0);
        assert_eq!(broadcast_axis(0.501), 0.5);
        assert_eq!(broadcast_axis(-1.0), -1.0);
        assert_eq!(broadcast_axis(f64::NAN), 0.0);
    }
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
    fn the_lookup_button_is_read_from_either_controller() {
        let grip = vec![false; 23].into_iter().enumerate().map(|(i, _)| i == 17).collect::<Vec<_>>();
        assert!(lookup_button_held(Some(17), &states(&[]), Some(&grip)));
        assert!(!lookup_button_held(Some(17), &states(&[]), None));
        assert!(lookup_button_held(Some(5), &states(&[5]), None));
        assert!(!lookup_button_held(None, &states(&[5]), Some(&grip)));
        assert!(!lookup_button_held(Some(40), &states(&[5]), Some(&grip)));
    }

    #[test]
    fn desktop_mode_adds_only_the_decks_own_buttons() {
        let mut deck = vec![false; 23];
        deck[0] = true; // A: Steam's layout reports it (or types a key); not read twice.
        deck[18] = true; // R4
        let buttons = with_deck_extras(states(&[2]), &deck);
        assert_eq!(buttons.len(), 23);
        assert!(!buttons[0] && buttons[2] && buttons[18]);
        // No pad connected: the standard part is empty, the grips still read.
        let buttons = with_deck_extras(Vec::new(), &deck);
        assert_eq!(buttons.iter().position(|b| *b), Some(18));
    }

    #[test]
    fn the_controller_pressed_last_is_read_unless_a_primary_is_chosen() {
        // Nothing pressed yet: the first one, as before.
        assert_eq!(pick_active(None, 2, None), Some(0));
        // A virtual pad listed first stays silent; the real one, second, was pressed.
        assert_eq!(pick_active(None, 2, Some(1)), Some(1));
        // A chosen primary wins while it is connected...
        assert_eq!(pick_active(Some(0), 2, Some(1)), Some(0));
        // ...and when it is gone the last pressed (or the first) takes over.
        assert_eq!(pick_active(Some(3), 2, Some(1)), Some(1));
        assert_eq!(pick_active(Some(3), 2, None), Some(0));
        // The pressed one was unplugged since.
        assert_eq!(pick_active(None, 1, Some(1)), Some(0));
        assert_eq!(pick_active(None, 0, Some(0)), None);
        assert_eq!(pick_active(Some(0), 0, None), None);
    }

    #[test]
    fn connecting_a_controller_does_not_make_it_the_one_in_use() {
        // (gilrs builds raw codes only from backend events, so a press can't be made here.)
        use gilrs::EventType;
        assert!(pressed_button(&EventType::Connected).is_none());
        assert!(pressed_button(&EventType::Disconnected).is_none());
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
