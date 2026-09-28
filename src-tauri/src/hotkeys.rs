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
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Re-register every enabled shortcut. Failures are reported per key rather than
/// aborting the set, so one bad accelerator cannot disable the others silently.
pub fn apply(app: &tauri::AppHandle, settings: &Arc<Settings>) -> Value {
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
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
            Ok(()) => registered.push(name),
            Err(e) => failed
                .push(json!({"name": name, "accelerator": accelerator, "error": e.to_string()})),
        }
    }
    json!({ "registered": registered, "failed": failed })
}
