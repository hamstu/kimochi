//! The `keytrigger` sidecar from the Electron tree: line-delimited JSON on stdout,
//! carrying key events and frontmost-window changes.
//!
//! Key events need macOS Accessibility permission. That state is reported honestly
//! through `snapshot()` rather than the feature quietly doing nothing, and this module
//! never triggers a permission prompt — asking is an explicit user action.
use crate::actions;
use crate::native;
use crate::state::Shared;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{Emitter, Manager};

fn binary_name() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "keytrigger-darwin-arm64"
    } else {
        "keytrigger-darwin-amd64"
    }
}

/// Bundled resource first, then this project’s bin directory for development.
fn binary_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let name = binary_name();
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("bin").join(name));
    let repo = Some(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../bin")
            .join(name),
    );
    [bundled, repo]
        .into_iter()
        .flatten()
        .find(|path| path.exists())
}

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
    service.view.lock().unwrap().accessibility = native::accessibility_trusted();
    let Some(path) = binary_path(app) else {
        service.log(json!({
            "check": "watcher",
            "status": "unavailable",
            "detail": format!("{} was not found; keyboard auto-scan and focus tracking are off", binary_name()),
        }));
        return;
    };
    let app = app.clone();
    let service = service.clone();
    std::thread::spawn(move || {
        let child = Command::new(&path)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match child {
            Ok(child) => child,
            Err(e) => {
                service
                    .log(json!({"check": "watcher", "status": "failed", "detail": e.to_string()}));
                return;
            }
        };
        let Some(stdout) = child.stdout.take() else {
            return;
        };
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            handle(&app, &service, &event);
        }
        let _ = child.wait();
        service.log(json!({"check": "watcher", "status": "exited"}));
    });
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
                "windowTitle": event.get("windowTitle"),
                "appPath": event.get("appPath"),
            }),
        );
        return;
    }
    if event.get("action").and_then(Value::as_str) != Some("down") {
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
