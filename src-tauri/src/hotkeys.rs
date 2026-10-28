//! Global shortcuts, using Electron's accelerator syntax unchanged.
//!
//! `global-hotkey` accepts `CommandOrControl` (mapping to Super on macOS) and digit
//! names such as `8`, so `CommandOrControl+Shift+8` and the rest of
//! `src/shared/defaults.ts` register without translation.
use crate::actions;
use crate::settings::{merged_hotkeys, Settings};
use crate::state::Shared;
use serde_json::{json, Value};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(not(target_os = "windows"))]
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

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

static REGISTRY: Mutex<Registry> = Mutex::new(Registry {
    suspended: false,
    generation: 0,
    active: Vec::new(),
});

fn lock() -> std::sync::MutexGuard<'static, Registry> {
    REGISTRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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
    // That also took the region editor's and the controller menu's keys; put back any
    // still in use.
    let _ = sync_keys(app);
    if registry.suspended {
        return json!({ "registered": [], "failed": [], "suspended": true });
    }
    register(app, settings, &mut registry)
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
            let app = app.clone(); let settings = settings.clone();
            std::thread::spawn(move || {
                std::thread::sleep(SUSPEND_LIMIT);
                if lock().generation == generation { resume(&app, &settings); }
            });
        }
        return crate::platform::shortcuts::apply(app, settings, on);
    }
    let mut registry = lock();
    if on {
        registry.generation += 1;
        let generation = registry.generation;
        registry.suspended = true;
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

fn register(app: &tauri::AppHandle, settings: &Arc<Settings>, registry: &mut Registry) -> Value {
    let shortcuts = app.global_shortcut();
    let mut registered = Vec::new();
    let mut failed = Vec::new();
    for (name, definition) in merged_hotkeys(settings) {
        if definition.get("enabled") == Some(&Value::Bool(false)) {
            continue;
        }
        let Some(accelerator) = definition.get("accelerator").and_then(Value::as_str) else {
            failed.push(json!({"name": name, "accelerator": null, "error": "no accelerator"}));
            continue;
        };
        let parsed = match Shortcut::from_str(accelerator) {
            Ok(parsed) => parsed,
            Err(e) => {
                failed.push(
                    json!({"name": name, "accelerator": accelerator, "error": e.to_string()}),
                );
                continue;
            }
        };
        let action = name.clone();
        let result = shortcuts.on_shortcut(parsed, move |app, _shortcut, event| {
            // Fire on press only: the plugin reports release as a second event.
            if event.state != ShortcutState::Pressed {
                return;
            }
            let service = app.state::<Shared>().inner().clone();
            actions::dispatch(app, &service, &action);
        });
        match result {
            Ok(()) => {
                registry.active.push(parsed);
                registered.push(name)
            }
            Err(e) => failed
                .push(json!({"name": name, "accelerator": accelerator, "error": e.to_string()})),
        }
    }
    json!({ "registered": registered, "failed": failed })
}

/// Whether the region editor's keys and the controller menu's keys are wanted. Atomics, not
/// a lock: the key handlers read these on the main thread while `sync_keys` may be waiting
/// on that same thread to register a key.
static REGION_KEYS: AtomicBool = AtomicBool::new(false);
static NAV_KEYS: AtomicBool = AtomicBool::new(false);
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

/// Register exactly the keys that the region editor and the controller menu want between
/// them. Escape and Return are shared, so one handler serves both owners and decides at
/// press time who hears about it; releasing one owner's keys never takes the other's.
#[cfg(target_os = "windows")]
fn sync_keys(_app: &tauri::AppHandle) -> Result<(), String> {
    crate::platform::set_keyboard_guard(REGION_KEYS.load(Ordering::SeqCst), NAV_KEYS.load(Ordering::SeqCst));
    Ok(())
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
    let _serial = KEYS_SYNC
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let shortcuts = app.global_shortcut();
    for key in ["Escape", "Enter", "Space", "Up", "Down", "Left", "Right"] {
        let parsed = Shortcut::from_str(key).map_err(|e| e.to_string())?;
        let wanted = (REGION_KEYS.load(Ordering::SeqCst) && REGION_KEY_NAMES.contains(&key))
            || (NAV_KEYS.load(Ordering::SeqCst) && NAV_KEY_NAMES.contains(&key));
        if !wanted {
            if shortcuts.is_registered(parsed) {
                let _ = shortcuts.unregister(parsed);
            }
            continue;
        }
        if shortcuts.is_registered(parsed) {
            continue;
        }
        shortcuts
            .on_shortcut(parsed, move |app, _shortcut, event| {
                let pressed = event.state == ShortcutState::Pressed;
                let kind = if pressed { "keydown" } else { "keyup" };
                if REGION_KEYS.load(Ordering::SeqCst)
                    && REGION_KEY_NAMES.contains(&key)
                    && (pressed || key == "Space")
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
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
