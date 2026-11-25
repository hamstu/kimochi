//! Global shortcuts, using Electron's accelerator syntax unchanged.
//!
//! `global-hotkey` accepts `CommandOrControl` (mapping to Super on macOS) and digit
//! names such as `8`, so `CommandOrControl+Shift+8` and the rest of
//! `src/shared/defaults.ts` register without translation.
use crate::actions;
use crate::mouse_buttons::Button as MouseButton;
use crate::settings::{merged_hotkeys, Settings};
use crate::state::Shared;
use serde_json::{json, Value};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// The longest a suspension can last without being lifted, in case the window that asked
/// for it goes away without saying so. Recording a shortcut takes seconds, not minutes.
const SUSPEND_LIMIT: Duration = Duration::from_secs(120);

/// Which action shortcuts are registered, and whether they are suspended while Settings
/// records a new shortcut or gamepad button. Only the action shortcuts are tracked, so
/// suspending never touches the region editor's Escape / Return keys.
struct Registry {
    suspended: bool,
    /// Bumped on every suspend, so a stale safety timer cannot lift a newer suspension.
    generation: u64,
    active: Vec<Shortcut>,
}

static REGISTRY: Mutex<Registry> = Mutex::new(Registry { suspended: false, generation: 0, active: Vec::new() });

fn lock() -> std::sync::MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether actions are suspended; the gamepad poller checks this before dispatching.
pub fn suspended() -> bool {
    lock().suspended
}

/// Re-register every enabled shortcut. Failures are reported per key rather than
/// aborting the set, so one bad accelerator cannot disable the others silently.
///
/// While suspended this only clears the old set: a save during recording must not bring
/// the shortcuts back early, and `suspend(false)` registers the saved set afterwards.
pub fn apply(app: &tauri::AppHandle, settings: &Arc<Settings>) -> Value {
    #[cfg(target_os = "linux")]
    if crate::platform::capabilities()["session"]["backend"] == "wayland" {
        return crate::platform::shortcuts::apply(app, settings, suspended());
    }
    let mut registry = lock();
    let _ = app.global_shortcut().unregister_all();
    registry.active.clear();
    crate::mouse_buttons::disarm();
    // That also took the overlay's own key (Escape) with it.
    #[cfg(target_os = "windows")]
    ESCAPE_OWNED.store(false, Ordering::SeqCst);
    #[cfg(not(target_os = "windows"))]
    KEYS_OWNED.store(0, Ordering::SeqCst);
    let report = if registry.suspended {
        json!({ "registered": [], "failed": [], "suspended": true })
    } else {
        register(app, settings, &mut registry)
    };
    // And the region editor's and the controller menu's keys: put back any still in use. After
    // the reader's own shortcuts, so one of theirs on the same keys comes first.
    let _ = sync_keys(app);
    report
}

/// Suspend (`true`) or restore (`false`) the action shortcuts and gamepad actions, so a
/// combination pressed while recording is captured instead of firing. Restoring returns
/// the same report as `apply`. Both directions are idempotent.
pub fn suspend(app: &tauri::AppHandle, settings: &Arc<Settings>, on: bool) -> Value {
    #[cfg(target_os = "linux")]
    if crate::platform::capabilities()["session"]["backend"] == "wayland" {
        let mut registry = lock();
        registry.suspended = on;
        registry.generation += 1;
        let generation = registry.generation;
        drop(registry);
        if on {
            let app = app.clone();
            let settings = settings.clone();
            std::thread::spawn(move || {
                std::thread::sleep(SUSPEND_LIMIT);
                if lock().generation == generation {
                    resume(&app, &settings);
                }
            });
        }
        return crate::platform::shortcuts::apply(app, settings, on);
    }
    let mut registry = lock();
    if on {
        registry.generation += 1;
        let generation = registry.generation;
        registry.suspended = true;
        crate::mouse_buttons::disarm();
        let shortcuts = app.global_shortcut();
        for shortcut in registry.active.drain(..) {
            let _ = shortcuts.unregister(shortcut);
        }
        drop(registry);
        // Safety net: never leave the shortcuts off if nobody restores them.
        let app = app.clone();
        let settings = settings.clone();
        std::thread::spawn(move || {
            std::thread::sleep(SUSPEND_LIMIT);
            if lock().generation == generation {
                resume(&app, &settings);
            }
        });
        return json!({ "registered": [], "failed": [], "suspended": true });
    }
    if !registry.suspended {
        // Already live; report the current set without re-registering it.
        return json!({ "registered": [], "failed": [], "suspended": false, "unchanged": true });
    }
    registry.suspended = false;
    let shortcuts = app.global_shortcut();
    for shortcut in registry.active.drain(..) {
        let _ = shortcuts.unregister(shortcut);
    }
    register(app, settings, &mut registry)
}

/// Lift a suspension if one is in place; used when a window hides or the timer runs out.
pub fn resume(app: &tauri::AppHandle, settings: &Arc<Settings>) {
    if suspended() {
        suspend(app, settings, false);
    }
}

/// Take `shortcut` for `action`, firing it on press (the plugin reports release as a second event).
fn bind(app: &tauri::AppHandle, shortcut: Shortcut, action: &str) -> Result<(), String> {
    let action = action.to_string();
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            let service = app.state::<Shared>().inner().clone();
            actions::dispatch(app, &service, &action);
        })
        .map_err(|e| e.to_string())
}

/// The modifier the overlay's lookup key holds (`overlayLookupKey`: shift by default).
fn lookup_modifier(key: Option<&str>) -> Modifiers {
    match key {
        Some("ctrl") => Modifiers::CONTROL,
        Some("alt") => Modifiers::ALT,
        Some("meta") => Modifiers::SUPER,
        _ => Modifiers::SHIFT,
    }
}

/// The shortcuts a press can be: as pressed, and, when the lookup key is held for reading, also
/// without it, so a shortcut's key still fires while Shift is held over a word. Ids, as the plugin
/// compares shortcuts.
fn press_candidates(pressed: Shortcut, lookup: Modifiers) -> Vec<u32> {
    let mut ids = vec![pressed.id()];
    if pressed.mods.contains(lookup) {
        ids.push(Shortcut::new(Some(pressed.mods - lookup), pressed.key).id());
    }
    ids
}

/// A key press Windows never matched against the shortcuts, because the overlay's keyboard guard
/// swallowed it with the pointer on the overlay's text (`mouseguard.rs`): fire the live shortcut
/// it is, if any. True when one fired.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn fire_swallowed(app: &tauri::AppHandle, accelerator: &str) -> bool {
    let Ok(pressed) = Shortcut::from_str(accelerator) else { return false };
    let service = app.state::<Shared>().inner().clone();
    let lookup = service.settings.get("overlayLookupKey").ok().flatten();
    // As pressed, and without the lookup key held for reading (Shift+Escape is Escape here).
    let candidates = press_candidates(pressed, lookup_modifier(lookup.as_ref().and_then(Value::as_str)));
    let is = |accelerator: &str| Shortcut::from_str(accelerator).is_ok_and(|key| candidates.contains(&key.id()));
    // Escape is no setting's shortcut: over the overlay's text it clears what the overlay shows.
    if is("Escape") {
        return dismiss_overlay(app);
    }
    let action = {
        let registry = lock();
        if registry.suspended {
            return false;
        }
        let live: Vec<(String, u32)> = merged_hotkeys(&service.settings)
            .into_iter()
            .filter_map(|(name, definition)| {
                let shortcut = Shortcut::from_str(definition.get("accelerator")?.as_str()?).ok()?;
                (definition.get("enabled") != Some(&Value::Bool(false)) && registry.active.contains(&shortcut))
                    .then_some((name, shortcut.id()))
            })
            .collect();
        // The press as it was first, then without the lookup key: a shortcut that has the key in it
        // (Shift+F8 with Shift as the lookup key) wins over one without (F8).
        candidates.iter().find_map(|id| live.iter().find(|(_, live)| live == id).map(|(name, _)| name.clone()))
    };
    let Some(action) = action else { return false };
    crate::record(app, &service, json!({ "check": "shortcut-under-pointer", "name": action, "pressed": accelerator }));
    actions::dispatch(app, &service, &action);
    true
}

fn register(app: &tauri::AppHandle, settings: &Arc<Settings>, registry: &mut Registry) -> Value {
    let mut registered = Vec::new();
    let mut failed = Vec::new();
    let mut buttons: Vec<(String, MouseButton)> = Vec::new();
    for (name, definition) in merged_hotkeys(settings) {
        if definition.get("enabled") == Some(&Value::Bool(false)) {
            continue;
        }
        let Some(accelerator) = definition.get("accelerator").and_then(Value::as_str) else {
            failed.push(json!({"name": name, "accelerator": null, "error": "no accelerator"}));
            continue;
        };
        // No keys: a menu item with only a controller chord, or none yet. Nothing to register.
        if accelerator.is_empty() && actions::is_menu_item(&name) {
            continue;
        }
        // Mouse buttons are caught by the platform's input hook, not registered as shortcuts.
        if let Some(button) = MouseButton::parse(accelerator) {
            if buttons.iter().any(|(_, bound)| *bound == button) {
                failed.push(json!({"name": name, "accelerator": accelerator,
                    "error": "this mouse button is already bound"}));
            } else {
                buttons.push((name, button));
            }
            continue;
        }
        let parsed = match Shortcut::from_str(accelerator) {
            Ok(parsed) => parsed,
            Err(e) => {
                failed.push(json!({"name": name, "accelerator": accelerator, "error": e.to_string()}));
                continue;
            }
        };
        match bind(app, parsed, &name) {
            Ok(()) => {
                registry.active.push(parsed);
                registered.push(name)
            }
            Err(e) => failed.push(json!({"name": name, "accelerator": accelerator, "error": e.to_string()})),
        }
    }
    // Always, even with no button bound: an empty set removes a hook that is no longer needed.
    match crate::mouse_buttons::bind(app, &buttons) {
        Ok(()) => registered.extend(buttons.into_iter().map(|(name, _)| name)),
        Err(error) => failed.extend(
            buttons
                .into_iter()
                .map(|(name, button)| json!({"name": name, "accelerator": button.accelerator(), "error": error})),
        ),
    }
    json!({ "registered": registered, "failed": failed })
}

/// Whether the region editor's keys and the controller menu's keys are wanted. Atomics, not
/// a lock: the key handlers read these on the main thread while `sync_keys` may be waiting
/// on that same thread to register a key.
static REGION_KEYS: AtomicBool = AtomicBool::new(false);
static NAV_KEYS: AtomicBool = AtomicBool::new(false);
/// Whether Escape resumes the game (the reader paused it with Pause game).
static PAUSE_KEYS: AtomicBool = AtomicBool::new(false);
/// Escape while the reader has the game paused and neither the region editor nor the controller
/// menu has it: the overlay resumes the game. From the global shortcut here, or Windows' keyboard hook.
pub fn pause_escape(app: &tauri::AppHandle) {
    let _ = app.emit("pause-escape", json!({}));
}
/// Serialises `sync_keys`, so two callers cannot both decide to register the same key.
#[cfg(not(target_os = "windows"))]
static KEYS_SYNC: Mutex<()> = Mutex::new(());

#[cfg(not(target_os = "windows"))]
const REGION_KEY_NAMES: [&str; 3] = ["Escape", "Enter", "Space"];
#[cfg(not(target_os = "windows"))]
const NAV_KEY_NAMES: [&str; 7] = ["Up", "Down", "Left", "Right", "Enter", "Escape", "Space"];

/// Escape and Return for the region editor, as global shortcuts while it is open.
///
/// The overlay is a borderless non-activating panel, which AppKit will not make key, so
/// it never receives the keyboard; the reader's game keeps it. Registering these keys
/// for the editor's lifetime delivers them anyway, without activating anything, and
/// releasing them afterwards hands them straight back to the game. Space reports both
/// press and release (held, it moves a box being drawn); the others only presses.
pub fn set_region_keys(app: &tauri::AppHandle, on: bool) -> Result<(), String> {
    REGION_KEYS.store(on, Ordering::SeqCst);
    sync_keys(app)
}

/// The arrows, Return, Escape and Space for the controller menu, as global shortcuts while it
/// is open, delivered as `controller-key` events (Space switches word and character steps). The same bargain as `set_region_keys`, and
/// like those keys they are not action shortcuts, so `suspend` never touches them. The
/// arrows report release as well, so the overlay can stop its key repeat.
pub fn set_nav_keys(app: &tauri::AppHandle, on: bool) -> Result<(), String> {
    NAV_KEYS.store(on, Ordering::SeqCst);
    sync_keys(app)
}

/// Escape while the reader has the game paused (Pause game), delivered as `pause-escape`: the game cannot
/// take it then, and it would only reach the game on resume. The region editor and the
/// controller menu keep Escape while they are open.
pub fn set_pause_keys(app: &tauri::AppHandle, on: bool) -> Result<(), String> {
    if PAUSE_KEYS.swap(on, Ordering::SeqCst) == on {
        return Ok(());
    }
    sync_keys(app)
}

/// Register exactly the keys that the region editor and the controller menu want between
/// them. Escape and Return are shared, so one handler serves both owners and decides at
/// press time who hears about it; releasing one owner's keys never takes the other's.
#[cfg(target_os = "windows")]
fn sync_keys(app: &tauri::AppHandle) -> Result<(), String> {
    crate::platform::set_keyboard_guard(
        REGION_KEYS.load(Ordering::SeqCst),
        NAV_KEYS.load(Ordering::SeqCst),
        PAUSE_KEYS.load(Ordering::SeqCst),
    );
    // The region editor's and the controller menu's keys go through the keyboard guard here, so
    // Escape as a shortcut is the overlay's dismissal alone. The guard itself swallows keys with
    // the pointer on the overlay's text and hands Escape on (`fire_swallowed`); this is the rest.
    let escape = Shortcut::from_str("Escape").map_err(|e| e.to_string())?;
    sync_owned(app, escape, escape_wanted(), &ESCAPE_OWNED, |app| {
        dismiss_overlay(app);
    })
}

/// Whether Escape is registered here, for the overlay, rather than as one of the reader's own
/// shortcuts on the same key (`sync_owned`).
#[cfg(target_os = "windows")]
static ESCAPE_OWNED: AtomicBool = AtomicBool::new(false);

/// Hold `shortcut` for `pressed` while `wanted`, and let it go after: only a registration made
/// here (`owned`). One of the reader's own shortcuts on the same keys is neither taken (the
/// overlay goes without) nor removed when the overlay is done with the keys.
#[cfg(target_os = "windows")]
fn sync_owned(
    app: &tauri::AppHandle,
    shortcut: Shortcut,
    wanted: bool,
    owned: &'static AtomicBool,
    pressed: fn(&tauri::AppHandle),
) -> Result<(), String> {
    let shortcuts = app.global_shortcut();
    if wanted && !owned.load(Ordering::SeqCst) {
        if shortcuts.is_registered(shortcut) {
            return Ok(());
        }
        shortcuts
            .on_shortcut(shortcut, move |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    pressed(app);
                }
            })
            .map_err(|e| e.to_string())?;
        owned.store(true, Ordering::SeqCst);
    } else if !wanted && owned.swap(false, Ordering::SeqCst) {
        let _ = shortcuts.unregister(shortcut);
    }
    Ok(())
}

/// Whether a pop-up is open on the overlay (`set_popup_open`): it makes Escape the overlay's,
/// wherever the pointer is.
static POPUP_OPEN: AtomicBool = AtomicBool::new(false);

/// Whether Escape is the overlay's now (a pop-up is open): it closes that before it resumes a
/// game paused with Pause game.
pub fn escape_wanted() -> bool {
    POPUP_OPEN.load(Ordering::SeqCst)
}

/// A pop-up opened on the overlay (`true`), or the last one closed: Escape is the overlay's while
/// one is open, wherever the pointer is, and the game's again once none is.
pub fn set_popup_open(app: &tauri::AppHandle, open: bool) -> Result<(), String> {
    if POPUP_OPEN.swap(open, Ordering::SeqCst) == open {
        return Ok(());
    }
    sync_keys(app)
}

/// Escape for the overlay: clear what it shows (pop-ups, lit text), unless the region editor or
/// the controller menu owns Escape (theirs comes first).
fn dismiss_overlay(app: &tauri::AppHandle) -> bool {
    if REGION_KEYS.load(Ordering::SeqCst) || NAV_KEYS.load(Ordering::SeqCst) {
        return false;
    }
    let service = app.state::<Shared>().inner().clone();
    actions::dispatch(app, &service, "dismissOverlay");
    true
}

#[cfg(not(target_os = "windows"))]
fn sync_keys(app: &tauri::AppHandle) -> Result<(), String> {
    // Off the main thread, (un)registering blocks until the main thread runs it, while
    // holding KEYS_SYNC, which the main thread may be waiting for: hand the whole sync over
    // instead. It reads the wanted keys when it runs, so the latest request wins.
    if std::thread::current().name() != Some("main") {
        let handle = app.clone();
        return app
            .run_on_main_thread(move || {
                if let Err(error) = sync_keys(&handle) {
                    eprintln!("Controller keys: {error}");
                }
            })
            .map_err(|e| e.to_string());
    }
    let _serial = KEYS_SYNC.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let shortcuts = app.global_shortcut();
    for (index, key) in ["Escape", "Enter", "Space", "Up", "Down", "Left", "Right"].into_iter().enumerate() {
        let parsed = Shortcut::from_str(key).map_err(|e| e.to_string())?;
        let wanted = (REGION_KEYS.load(Ordering::SeqCst) && REGION_KEY_NAMES.contains(&key))
            || (NAV_KEYS.load(Ordering::SeqCst) && NAV_KEY_NAMES.contains(&key))
            || (key == "Escape" && (PAUSE_KEYS.load(Ordering::SeqCst) || escape_wanted()));
        // Only what was registered here (`KEYS_OWNED`): one of the reader's own shortcuts on the
        // same key is neither taken nor removed.
        let bit = 1u8 << index;
        let owned = KEYS_OWNED.load(Ordering::SeqCst) & bit != 0;
        if !wanted {
            if owned {
                let _ = shortcuts.unregister(parsed);
                KEYS_OWNED.fetch_and(!bit, Ordering::SeqCst);
            }
            continue;
        }
        if owned || shortcuts.is_registered(parsed) {
            continue;
        }
        shortcuts
            .on_shortcut(parsed, move |app, _shortcut, event| {
                let pressed = event.state == ShortcutState::Pressed;
                let kind = if pressed { "keydown" } else { "keyup" };
                // One Escape for every owner: the overlay's dismissal when neither of the others has
                // it (`dismiss_overlay` checks), so a modal editor or menu still hears its own.
                if key == "Escape"
                    && pressed
                    && escape_wanted()
                    && !REGION_KEYS.load(Ordering::SeqCst)
                    && !NAV_KEYS.load(Ordering::SeqCst)
                    && dismiss_overlay(app)
                {
                    return;
                }
                if REGION_KEYS.load(Ordering::SeqCst) && REGION_KEY_NAMES.contains(&key) && (pressed || key == "Space")
                {
                    // The DOM's names: the editor replays these as keyboard events.
                    let name = if key == "Space" { " " } else { key };
                    let _ = app.emit("region-key", json!({ "key": name, "type": kind }));
                }
                if NAV_KEYS.load(Ordering::SeqCst) && NAV_KEY_NAMES.contains(&key) {
                    let name = match key {
                        "Up" => "ArrowUp",
                        "Down" => "ArrowDown",
                        "Left" => "ArrowLeft",
                        "Right" => "ArrowRight",
                        other => other,
                    };
                    if pressed || name.starts_with("Arrow") {
                        let _ = app.emit("controller-key", json!({ "key": name, "type": kind }));
                    }
                }
                if pressed
                    && key == "Escape"
                    && PAUSE_KEYS.load(Ordering::SeqCst)
                    && !REGION_KEYS.load(Ordering::SeqCst)
                    && !NAV_KEYS.load(Ordering::SeqCst)
                {
                    pause_escape(app);
                }
            })
            .map_err(|e| e.to_string())?;
        KEYS_OWNED.fetch_or(bit, Ordering::SeqCst);
    }
    Ok(())
}

/// Which of the region editor's, the controller menu's and the overlay's keys (`sync_keys`, by
/// their place in its list) are registered here rather than as the reader's own shortcuts.
#[cfg(not(target_os = "windows"))]
static KEYS_OWNED: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_press_with_the_lookup_key_held_also_counts_without_it() {
        let x = Shortcut::from_str("X").unwrap().id();
        let shift_x = Shortcut::from_str("Shift+X").unwrap();
        // Shift held over a word to read it, then X: a shortcut on X.
        assert!(press_candidates(shift_x, lookup_modifier(None)).contains(&x));
        assert!(press_candidates(shift_x, lookup_modifier(Some("shift"))).contains(&shift_x.id()));
        // Another lookup key: Shift is part of the shortcut pressed, not taken off.
        assert!(!press_candidates(shift_x, lookup_modifier(Some("ctrl"))).contains(&x));
        let ctrl_x = Shortcut::from_str("Control+X").unwrap();
        assert!(press_candidates(ctrl_x, lookup_modifier(Some("ctrl"))).contains(&x));
        // Nothing held: only the press itself.
        assert_eq!(press_candidates(Shortcut::from_str("X").unwrap(), Modifiers::SHIFT), vec![x]);
        // Shift+F8 (Scan) pressed over text is still Shift+F8.
        let scan = Shortcut::from_str("Shift+F8").unwrap();
        assert!(press_candidates(scan, Modifiers::SHIFT).contains(&scan.id()));
        // Escape with Shift held over the text is the overlay's Escape (`fire_swallowed`).
        let escape = Shortcut::from_str("Escape").unwrap().id();
        let shift_escape = Shortcut::from_str("Shift+Escape").unwrap();
        assert!(press_candidates(shift_escape, lookup_modifier(None)).contains(&escape));
    }

    #[test]
    fn keys_that_stand_alone_parse() {
        // What Settings records for a key on its own (`standsAlone` in accelerator.ts, #19).
        for accelerator in ["Insert", "Pause", "ScrollLock", "F8", "Shift+F8", "Shift+ScrollLock"] {
            assert!(Shortcut::from_str(accelerator).is_ok(), "{accelerator}");
        }
    }
}
