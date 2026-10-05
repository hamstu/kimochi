//! The `keytrigger` sidecar from the Electron tree: line-delimited JSON on stdout,
//! carrying key events and frontmost-window changes.
//!
//! The platform layer owns the process (`platform::start_key_trigger`); this module owns
//! what the events mean.
//!
//! Key events need macOS Accessibility permission. That state is reported honestly
//! through `snapshot()` rather than the feature quietly doing nothing, and this module
//! never triggers a permission prompt — asking is an explicit user action.
use crate::actions;
use crate::platform;
use crate::state::Shared;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::Emitter;

/// Keys the user listed in `autoScanSettings.triggerKeys`, lowercased.
fn trigger_keys(service: &Shared) -> Vec<String> {
    service
        .settings
        .get_or::<String>("autoScanSettings.triggerKeys", String::new())
        .split(',')
        .map(|k| k.trim().to_lowercase())
        .filter(|k| !k.is_empty())
        .collect()
}

pub fn start(app: &tauri::AppHandle, service: &Shared) {
    // The view keeps its historical name: on macOS this is the Accessibility grant.
    service.view.lock().unwrap().accessibility = platform::key_trigger_status().permission == "granted";
    let on_line = {
        let app = app.clone();
        let service = service.clone();
        Box::new(move |event: Value| handle(&app, &service, &event))
    };
    if let Err(detail) = platform::start_key_trigger(app, on_line) {
        service.log(json!({
            "check": "watcher",
            "status": "unavailable",
            "detail": detail,
        }));
    }
}

fn handle(app: &tauri::AppHandle, service: &Shared, event: &Value) {
    if event.get("type").and_then(Value::as_str) == Some("windowFocus") {
        let name = event
            .get("appName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        service.view.lock().unwrap().frontmost_app = Some(name.clone());
        // Emitted raw and unfiltered. Consumers decide what Kimochi's own windows
        // mean for them; this layer must not collapse "Kimochi is frontmost" and
        // "no signal yet" into the same value.
        let _ = app.emit(
            "frontmost-app",
            json!({
                "appName": name,
                "pid": platform::frontmost_pid(),
                "windowTitle": event.get("windowTitle"),
                "appPath": event.get("appPath"),
            }),
        );
        return;
    }
    if event.get("action").and_then(Value::as_str) != Some("down") {
        return;
    }
    // The in-process Windows hook reports key repeat as further "down" events tagged
    // `repeat`; a held trigger key is one press, not a scan per repeat. The macOS
    // sidecar never sets the field.
    if event.get("repeat").and_then(Value::as_bool) == Some(true) {
        return;
    }
    let Some(key) = event.get("key").and_then(Value::as_str) else {
        return;
    };
    if !service.settings.get_or("autoScanSettings.enabled", false) {
        return;
    }
    let key = key.to_lowercase();
    if !trigger_keys(service).contains(&key) {
        return;
    }
    // Electron waits `scanDelay` so the game has drawn the new text before capture.
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
