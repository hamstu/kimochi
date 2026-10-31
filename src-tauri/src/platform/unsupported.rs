//! The platform contract for an OS with no native integration yet (Linux until its
//! adapters land). Every query answers "nothing", every action fails with a reason, and
//! nothing panics, so the reader, dictionary, texthooker and settings still work.
use super::{AppIdentity, DisplayInfo, FrontWindow, PointerSample};
use kimochi_capture::{Platform, Rect, SourceId};
use serde_json::{json, Value};
use std::path::Path;

const UNSUPPORTED: &str = "unsupported: not available on this platform yet";

pub fn cursor() -> Option<PointerSample> {
    None
}

pub fn displays() -> Vec<Rect> {
    Vec::new()
}

pub fn display_infos() -> Vec<DisplayInfo> {
    Vec::new()
}

#[allow(dead_code)] // Part of the contract; nothing lists displays here yet.
pub fn display_source_id(display_id: u32) -> String {
    SourceId::display(Platform::current(), display_id).to_string()
}

pub fn with_pool<R>(f: impl FnOnce() -> R) -> R {
    f()
}

/// Ordinary windows still have to be placeable without native help, so placement and
/// bounds go through Tauri's own (physical-pixel) window API.
pub fn place(w: &tauri::WebviewWindow, r: Rect) -> Result<(), String> {
    w.set_position(tauri::LogicalPosition::new(r.x, r.y))
        .map_err(|e| e.to_string())?;
    w.set_size(tauri::LogicalSize::new(r.width, r.height))
        .map_err(|e| e.to_string())
}

pub fn bounds(w: &tauri::WebviewWindow) -> Result<Rect, String> {
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let position = w
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let size = w
        .outer_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    Ok(Rect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

pub fn panel_pointer(_w: &tauri::WebviewWindow) -> Result<Option<(f64, f64)>, String> {
    Ok(None)
}

pub fn panel_cursor(_w: &tauri::WebviewWindow, _kind: &str) -> Result<(), String> {
    Ok(())
}

pub fn inspect(w: &tauri::WebviewWindow) -> Result<Value, String> {
    Ok(json!({
        "platform": std::env::consts::OS,
        "is_key": w.is_focused().unwrap_or(false),
    }))
}

pub fn order_front(w: &tauri::WebviewWindow) -> Result<(), String> {
    w.show().map_err(|e| e.to_string())
}

/// No native input regions: the shared cursor poll toggles click-through.
pub fn set_input_regions(
    _w: &tauri::WebviewWindow,
    _regions: Option<&[Rect]>,
) -> Result<bool, String> {
    Ok(false)
}

pub fn promote_to_key(_w: &tauri::WebviewWindow) -> Result<bool, String> {
    Ok(false)
}

pub fn make_panel(_w: &tauri::WebviewWindow) -> Result<bool, String> {
    Ok(false)
}

pub fn picker_sources() -> Result<Vec<kimochi_capture::Source>, String> {
    Err(UNSUPPORTED.into())
}

pub fn source_spaces(_: &[kimochi_capture::Source]) -> std::collections::HashMap<String, String> {
    Default::default()
}

pub fn window_bounds(_id: &SourceId) -> Option<(Rect, bool)> {
    None
}

pub fn front_window() -> Option<FrontWindow> {
    None
}

pub fn frontmost_app() -> Option<String> {
    None
}

pub fn frontmost_pid() -> Option<u32> {
    None
}

pub fn app_icon_png(_app: &AppIdentity, _target: isize) -> Option<Vec<u8>> {
    None
}

pub fn observe_workspace(
    _on_sleep: impl Fn() + 'static,
    _on_wake: impl Fn() + 'static,
    _on_activate: impl Fn(String) + 'static,
) {
}

pub fn activate_self(_prefer: Option<&tauri::WebviewWindow>) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

pub fn activate_process(_pid: u32) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

pub fn activate_window(_id: &SourceId) -> Result<Value, String> {
    Err(UNSUPPORTED.into())
}

pub fn window_fullscreen(_id: &SourceId) -> Option<bool> {
    None
}

pub fn accessibility_status() -> Option<bool> {
    None
}

/// Mouse buttons as action shortcuts (`mouse_buttons`) are not available on this platform.
pub fn sync_mouse_buttons(_app: &tauri::AppHandle, wanted: bool) -> Result<(), String> {
    if wanted {
        return Err("mouse buttons can't be shortcuts on this platform".into());
    }
    Ok(())
}

pub fn request_accessibility() -> Result<bool, String> {
    Err(UNSUPPORTED.into())
}

pub fn open_capture_settings() -> Result<(), String> {
    Err("not applicable".into())
}

pub fn run_cli(
    program: &str,
    args: &[&str],
    stdin: Option<&str>,
    cwd: Option<&Path>,
) -> Result<std::process::Child, String> {
    let mut command = std::process::Command::new(program);
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    super::spawn_cli(command, stdin)
}

pub fn capabilities() -> Value {
    json!({
        "os": std::env::consts::OS,
        "keys": {"primaryModifier": "ctrl", "labels": "words", "superName": "Super", "mouseButtons": "unsupported"},
        "input": {"globalShortcuts": false},
        "tray": true,
        "gamepad": true,
        "ocrAccelerators": {"meikiocr": "cpu", "mangaocr": "cpu", "ppocr": "cpu"},
    })
}
