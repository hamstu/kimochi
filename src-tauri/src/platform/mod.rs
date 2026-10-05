//! The desktop integration layer: everything that talks to the operating system's
//! window server, input state, workspace and system settings.
//!
//! One module per OS implements the same set of free functions (the contract below);
//! this module re-exports the one for the build target, so call sites read
//! `platform::cursor()` on every OS. Types and policy shared by every implementation
//! (display descriptions, pointer samples, `clamp_to_visible`, the app origin) live here
//! and are never duplicated per OS.
//!
//! Per-OS contract (every implementation exports exactly these):
//!
//! ```text
//! cursor() -> Option<PointerSample>
//! displays() -> Vec<Rect>
//! display_infos() -> Vec<DisplayInfo>                 // fills `source_id` via display_source_id
//! display_source_id(display_id: u32) -> String
//! with_pool<R>(f: impl FnOnce() -> R) -> R
//! place(&WebviewWindow, Rect) -> Result<(), String>
//! bounds(&WebviewWindow) -> Result<Rect, String>
//! panel_pointer(&WebviewWindow) -> Result<Option<(f64, f64)>, String>
//! panel_cursor(&WebviewWindow, kind: &str) -> Result<(), String>
//! inspect(&WebviewWindow) -> Result<Value, String>
//! order_front(&WebviewWindow) -> Result<(), String>
//! promote_to_key(&WebviewWindow) -> Result<bool, String>
//! make_panel(&WebviewWindow) -> Result<bool, String>
//! picker_sources() -> Result<Vec<Source>, String>
//! window_bounds(&SourceId) -> Option<(Rect, bool)>
//! front_window() -> Option<FrontWindow>
//! frontmost_app() -> Option<String>
//! frontmost_pid() -> Option<u32>
//! app_icon_png(&AppIdentity, target: isize) -> Option<Vec<u8>>
//! key_trigger_status() -> KeyTriggerStatus
//! start_key_trigger(&AppHandle, on_line: Box<dyn Fn(Value) + Send + Sync>) -> Result<(), String>
//! observe_workspace(on_sleep, on_wake, on_activate)
//! activate_self() -> Result<(), String>
//! activate_process(pid: u32) -> Result<(), String>
//! open_capture_settings() -> Result<(), String>
//! open_input_settings() -> Result<(), String>
//! run_cli(program, args, stdin, cwd) -> Result<Child, String>
//! capabilities() -> Value
//! ```
use kimochi_capture::Rect;
use serde::Serialize;
use serde_json::{json, Value};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use unsupported::*;

/// One display, in desktop coordinates (top-left origin).
#[derive(Serialize, Clone, Debug)]
pub struct DisplayInfo {
    pub id: u32,
    /// The complete source id for capturing this display. The UI uses it as is and
    /// never builds one from `id`.
    pub source_id: String,
    pub bounds: Rect,
    /// Excludes the menu bar and Dock, like Electron's `workArea`.
    pub work_area: Rect,
    pub scale_factor: f64,
}

/// The modifier keys held while a cursor sample was taken.
///
/// Yomitan's scan trigger is a modifier, and a modifier is only ever reported to the
/// window that has the keyboard — which, while somebody is reading their game, is
/// their game. Carrying the modifiers alongside the pointer is what lets the scanner
/// behave exactly as it does in a browser without any window having to take focus
/// first. Named as the DOM names them, because that is where they are going.
#[derive(Serialize, Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Modifiers {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

/// Where the pointer is (desktop coordinates), whether the primary button is down,
/// and which modifiers are held, all from one sample.
#[derive(Clone, Copy, Debug)]
pub struct PointerSample {
    pub x: f64,
    pub y: f64,
    pub down: bool,
    pub modifiers: Modifiers,
}

/// The frontmost window of the frontmost application.
///
/// `window` is `None` when that application has no ordinary window on screen (a
/// menu-bar agent, or every window minimised): still an answer about who has focus,
/// matching no real window.
#[derive(Clone, Debug)]
pub struct FrontWindow {
    pub window: Option<kimochi_capture::SourceId>,
    pub pid: u32,
}

/// How a source's application is identified when looking up its icon.
#[derive(Clone, Debug, Default)]
#[allow(dead_code)] // Each OS reads the half it resolves icons by.
pub struct AppIdentity {
    pub name: String,
    /// The owning process, for OSes that resolve icons by executable. macOS matches by
    /// `name` and ignores it.
    pub pid: Option<u32>,
}

/// Whether global key events can be watched, and if not, why and what to do.
#[derive(Serialize, Clone, Debug)]
pub struct KeyTriggerStatus {
    pub available: bool,
    /// `"granted" | "denied" | "notRequired" | "unsupported"`.
    pub permission: &'static str,
    /// `None` (serialised as `null`) when the UI's own copy applies, as on macOS.
    pub reason: Option<String>,
    pub remediation: Option<String>,
}

/// Keep a rectangle inside a live display's work area, shrinking it first if the
/// display is smaller. Mirrors Electron's `clampBounds`, so an unplugged monitor can
/// never strand a saved window offscreen.
pub fn clamp_to_visible(rect: Rect) -> Rect {
    clamp_within(rect, &display_infos())
}

fn clamp_within(rect: Rect, screens: &[DisplayInfo]) -> Rect {
    if screens.is_empty() {
        return rect;
    }
    let overlap = |a: &Rect, b: &Rect| {
        let w = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
        let h = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
        w.max(0.0) * h.max(0.0)
    };
    let area = screens
        .iter()
        .max_by(|a, b| {
            overlap(&rect, &a.work_area)
                .partial_cmp(&overlap(&rect, &b.work_area))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|s| s.work_area)
        .unwrap();
    let width = rect.width.min(area.width);
    let height = rect.height.min(area.height);
    Rect {
        width,
        height,
        x: rect.x.max(area.x).min(area.x + area.width - width),
        y: rect.y.max(area.y).min(area.y + area.height - height),
    }
}

/// Whether the pointer arriving on the dictionary may take the keyboard. True only
/// where a window can become key without activating the application (an AppKit
/// non-activating panel). Elsewhere `promote_to_key` activates Kimochi, so it is
/// reserved for the explicit editing action the reader asks for.
pub const HOVER_PROMOTES_KEY: bool = cfg!(target_os = "macos");

/// The origin Kimochi's own pages are served from. WKWebView serves the custom
/// `tauri` scheme as is; WebView2 and WebKitGTK map it to `http://tauri.localhost`.
pub fn app_origin() -> &'static str {
    if cfg!(target_os = "macos") {
        "tauri://localhost"
    } else {
        "http://tauri.localhost"
    }
}

/// Whether a navigation target is one of Kimochi's own pages (bundled build origin).
pub fn is_app_url(url: &tauri::Url) -> bool {
    let origin = app_origin();
    let (scheme, host) = origin.split_once("://").unwrap_or((origin, ""));
    url.scheme() == scheme && url.host_str() == Some(host)
}

/// An initialization script defining `window.__KIMOCHI_PLATFORM__ = {os, arch}`.
/// Registered first on every webview, before `host/shim.js` and the panel shims, which
/// read it for Yomitan's `getPlatformInfo` instead of sniffing the user agent.
pub fn platform_prelude() -> String {
    let info = json!({"os": std::env::consts::OS, "arch": std::env::consts::ARCH});
    format!(";(function(){{try{{window.__KIMOCHI_PLATFORM__={info};}}catch(e){{}}}})();\n")
}

/// A URL on the `capture:` protocol, as a page loads it on this OS.
pub fn capture_url(path: &str) -> String {
    let path = path.trim_start_matches('/');
    if cfg!(target_os = "macos") {
        format!("capture://localhost/{path}")
    } else {
        format!("http://capture.localhost/{path}")
    }
}

/// The single-instance startup report, for the app log. Only macOS coordinates
/// instances itself (`macos::instance`); elsewhere `tauri-plugin-single-instance` does.
pub fn instance_report() -> Option<Value> {
    #[cfg(target_os = "macos")]
    {
        macos::instance::report()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Spawn a prepared command with stdout/stderr piped and `stdin` (if any) written on a
/// helper thread and then closed, so a large prompt cannot deadlock against a full pipe.
#[allow(dead_code)] // Not every OS module uses it.
pub(crate) fn spawn_cli(
    mut command: std::process::Command,
    stdin: Option<&str>,
) -> Result<std::process::Child, String> {
    use std::io::Write;
    use std::process::Stdio;
    command
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let text = text.to_string();
        std::thread::spawn(move || {
            let _ = pipe.write_all(text.as_bytes());
        });
    }
    Ok(child)
}

/// Deep-merge `overlay` into `base`: objects merge key by key, anything else replaces.
fn merge(base: &mut Value, overlay: Value) {
    match (base, overlay) {
        (Value::Object(base), Value::Object(overlay)) => {
            for (key, value) in overlay {
                merge(base.entry(key).or_insert(Value::Null), value);
            }
        }
        (base, overlay) => *base = overlay,
    }
}

/// Everything `platform_capabilities` reports that is not owned by the OS module.
pub struct DynamicCapabilities {
    /// The capture backend's `permission()`.
    pub capture_permission: String,
    /// The capture backend's `capabilities()`.
    pub capture: kimochi_capture::Capabilities,
    /// Why capture is unavailable, when the backend could not be created.
    pub capture_reason: Option<String>,
    pub observer: Value,
    /// `(available, reason)` for the bundled MeikiOCR runtime and models.
    pub meikiocr: (bool, Option<String>),
    /// `(available, reason)` for the bundled Manga OCR models.
    pub mangaocr: (bool, Option<String>),
}

/// The full `platform_capabilities` payload (see CROSS_PLATFORM_PLAN.md §3.3).
///
/// Conservative defaults first, then the OS module's `capabilities()` merged over them,
/// then the live values only the app knows (capture permission, key trigger, OCR assets,
/// the observer, our own pid). An OS module only has to report what it supports.
pub fn capabilities_payload(dynamic: DynamicCapabilities) -> Value {
    let mut payload = json!({
        "os": std::env::consts::OS,
        "osVersion": "",
        "arch": std::env::consts::ARCH,
        "keys": {"primaryModifier": "ctrl", "labels": "words", "superName": "Super"},
        "capture": {
            "authorization": "unsupported",
            "canOpenSettings": false,
            "restartAfterGrant": false,
            "pickerRequired": false,
            "windowCapture": false,
            "excludesOwnWindows": false,
        },
        "sources": {
            "catalog": false,
            "thumbnails": false,
            "icons": false,
            "followWindowBounds": false,
            "foregroundTracking": false,
        },
        "overlay": {
            "passive": false,
            "inputRegions": "wholeWindowOnly",
            "nonActivating": false,
            "nativeHoverWorkaround": false,
        },
        "input": {"globalShortcuts": false},
        "ownAppNames": ["Kimochi", "kimochi"],
        "tray": false,
        "gamepad": false,
    });
    merge(&mut payload, capabilities());
    let accelerators = payload
        .as_object_mut()
        .and_then(|o| o.remove("ocrAccelerators"))
        .unwrap_or(Value::Null);
    if dynamic.capture.backend == "none" {
        payload["capture"]["authorization"] = json!("unsupported");
        payload["capture"]["windowCapture"] = json!(false);
        payload["capture"]["canOpenSettings"] = json!(false);
        payload["capture"]["restartAfterGrant"] = json!(false);
    } else {
        payload["capture"]["authorization"] = json!(match dynamic.capture_permission.as_str() {
            "granted" => "granted",
            "notRequired" | "not-required" => "notRequired",
            "promptOnSelect" | "prompt-on-select" => "promptOnSelect",
            "unsupported" => "unsupported",
            _ => "denied",
        });
        payload["capture"]["pickerRequired"] = json!(dynamic.capture.system_picker_required);
    }
    payload["capture"]["reason"] = json!(dynamic.capture_reason);
    payload["input"]["keyTrigger"] = serde_json::to_value(key_trigger_status()).unwrap_or(Value::Null);
    let engine = |(available, reason): (bool, Option<String>), accelerator: &Value| {
        let mut entry = json!({ "available": available });
        if available && accelerator.is_string() {
            entry["accelerator"] = accelerator.clone();
        }
        if let Some(reason) = reason {
            entry["reason"] = json!(reason);
        }
        entry
    };
    payload["ocrEngines"] = json!({
        "cloud": {"available": true},
        "websocket": {"available": true},
        "meikiocr": engine(dynamic.meikiocr, &accelerators["meikiocr"]),
        "mangaocr": engine(dynamic.mangaocr, &accelerators["mangaocr"]),
    });
    payload["observer"] = dynamic.observer;
    payload["ownPids"] = json!([std::process::id()]);
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn clamp_is_identity_without_displays() {
        let r = rect(10., 20., 30., 40.);
        let clamped = clamp_within(r, &[]);
        assert_eq!((clamped.width, clamped.height), (30., 40.));
        assert_eq!((clamped.x, clamped.y), (10., 20.));
    }

    #[test]
    fn clamp_pulls_a_stranded_window_onto_the_display_it_overlaps_most() {
        let screen = |x: f64| DisplayInfo {
            id: 1,
            source_id: String::new(),
            bounds: rect(x, 0., 1000., 800.),
            work_area: rect(x, 25., 1000., 775.),
            scale_factor: 2.,
        };
        let clamped = clamp_within(rect(1900., -50., 300., 200.), &[screen(0.), screen(1000.)]);
        assert_eq!((clamped.x, clamped.y), (1700., 25.));
        let shrunk = clamp_within(rect(0., 0., 5000., 5000.), &[screen(0.)]);
        assert_eq!((shrunk.width, shrunk.height), (1000., 775.));
    }

    #[test]
    fn app_origin_and_capture_urls_match_the_webview() {
        if cfg!(target_os = "macos") {
            assert_eq!(app_origin(), "tauri://localhost");
            assert_eq!(capture_url("preview/3"), "capture://localhost/preview/3");
            assert!(is_app_url(&"tauri://localhost/ui/overlay.html".parse().unwrap()));
            assert!(!is_app_url(&"https://localhost/".parse().unwrap()));
        } else {
            assert_eq!(app_origin(), "http://tauri.localhost");
            assert_eq!(capture_url("live/7"), "http://capture.localhost/live/7");
            assert!(is_app_url(&"http://tauri.localhost/ui/overlay.html".parse().unwrap()));
        }
    }

    #[test]
    fn merge_replaces_leaves_and_keeps_siblings() {
        let mut base = json!({"a": {"x": 1, "y": 2}, "b": false});
        merge(&mut base, json!({"a": {"y": 3}, "b": true, "c": []}));
        assert_eq!(base, json!({"a": {"x": 1, "y": 3}, "b": true, "c": []}));
    }
}
