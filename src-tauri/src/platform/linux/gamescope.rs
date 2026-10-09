//! Gamescope-specific XWayland renderer with independent public portal capture.
//! Only Kimochi's own overlay properties change; Steam windows are never modified.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use x11rb::{
    connection::Connection,
    protocol::xproto::{AtomEnum, ConnectionExt as _, PropMode},
    wrapper::ConnectionExt as _,
};

static EDITING: AtomicBool = AtomicBool::new(false);

pub fn active() -> bool {
    kimochi_capture::gamescope_portal_now()
}
pub fn handles(window: &tauri::WebviewWindow) -> bool {
    active() && (window.label() == "overlay" || controls(window))
}
fn controls(window: &tauri::WebviewWindow) -> bool {
    crate::panels::spec(window.label()).is_some()
        && !matches!(window.label(), "crop-host" | "controller-host")
}
/// Browser zoom is local to Gaming Mode controls; capture and annotation
/// coordinates continue using the unzoomed GTK/output scale.
pub fn controls_zoom(window: &tauri::WebviewWindow) -> f64 {
    if !active() || !controls(window) { return 1.; }
    let gtk_scale = super::x11::scale();
    let desired = std::env::var("KIMOCHI_GAMESCOPE_UI_SCALE").ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && (1. ..=4.).contains(value))
        .unwrap_or(gtk_scale);
    desired / gtk_scale
}

// Panel actions and the synchronous editor/navigation commands run on GTK's
// thread. A newly built hidden control panel has no native X handle until realized.
fn input(window: &tauri::WebviewWindow, on: bool) -> Result<(), String> {
    use glib::object::ObjectType as _;
    unsafe extern "C" {
        fn gtk_widget_realize(widget: *mut std::ffi::c_void);
    }
    let gtk = window.gtk_window().map_err(|e| e.to_string())?;
    unsafe {
        gtk_widget_realize(gtk.as_ptr().cast());
    }
    if controls(window) {
        // Gamescope presents controls as a fixed fullscreen view. GTK's fallback
        // move/resize emulation can retain a touchscreen grab on an off-screen
        // input-only window; there is no desktop frame to resize here.
        window.set_resizable(false).map_err(|e| e.to_string())?;
        window.set_zoom(controls_zoom(window)).map_err(|e| e.to_string())?;
        // At 2x scale the Deck is 640x400 logical pixels. A panel's desktop
        // minimum (Yomitan: 720x480) otherwise forces compositor rescaling while
        // XWayland still reports the larger viewport, offsetting touch targets.
        window.set_min_size(Some(tauri::LogicalSize::new(1., 1.)))
            .map_err(|e| e.to_string())?;
        if let Some(monitor) = super::x11::monitors().first() {
            let scale = super::x11::scale();
            let rect = monitor.rect;
            window.set_position(tauri::LogicalPosition::new(
                f64::from(rect.x) / scale, f64::from(rect.y) / scale,
            )).map_err(|e| e.to_string())?;
            window.set_size(tauri::LogicalSize::new(
                f64::from(rect.width) / scale, f64::from(rect.height) / scale,
            )).map_err(|e| e.to_string())?;
        }

    }
    window.set_focusable(on).map_err(|e| e.to_string())?;
    property(window, b"STEAM_OVERLAY", u32::from(on))?;
    property(window, b"STEAM_INPUT_FOCUS", u32::from(on))?;
    if on && controls(window) { super::gamescope_touch::show(window.app_handle()); }
    Ok(())
}
fn hide_controls(window: &tauri::WebviewWindow) -> Result<(), String> {
    for other in window.app_handle().webview_windows().into_values() {
        if other.label() != window.label()
            && controls(&other)
            && other.is_visible().unwrap_or(false)
        {
            input(&other, false)?;
            other.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub fn scene_capture() -> bool {
    active() && std::env::var("KIMOCHI_GAMESCOPE_HIDE_FOR_CAPTURE").as_deref() != Ok("1")
}
pub fn editing() -> bool {
    EDITING.load(Ordering::SeqCst)
}

fn property(window: &tauri::WebviewWindow, name: &[u8], value: u32) -> Result<(), String> {
    let d = super::x11::desktop().ok_or("Gamescope: no XWayland connection")?;
    let atom = d
        .conn
        .intern_atom(false, name)
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .atom;
    d.conn
        .change_property32(
            PropMode::REPLACE,
            super::window::xid(window)?,
            atom,
            AtomEnum::CARDINAL,
            &[value],
        )
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    d.conn.flush().map_err(|e| e.to_string())
}

pub fn make_overlay(window: &tauri::WebviewWindow) -> Result<(), String> {
    property(window, b"GAMESCOPE_EXTERNAL_OVERLAY", 1)?;
    // Gamescope renders one full-output external overlay. Keep its geometry
    // independent from the source stream's pixel dimensions and ordinary panels.
    if let Some(monitor) = super::x11::monitors().first() {
        let scale = super::x11::scale();
        let r = monitor.rect;
        window
            .set_position(tauri::LogicalPosition::new(
                f64::from(r.x) / scale,
                f64::from(r.y) / scale,
            ))
            .map_err(|e| e.to_string())?;
        window
            .set_size(tauri::LogicalSize::new(
                f64::from(r.width) / scale,
                f64::from(r.height) / scale,
            ))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Explicit editor/controller reading mode owns input until closed. Passive
/// annotations remain external overlays without a keyboard focus request.
pub fn keyboard(window: &tauri::WebviewWindow, on: bool) -> Result<(), String> {
    if !handles(window) {
        return Ok(());
    }
    if !on { super::steam_input::update(false)?; }
    if on {
        hide_controls(window)?;
    }
    input(window, on)?;
    EDITING.store(on, Ordering::SeqCst);
    Ok(())
}
pub fn is_visible(window: &tauri::WebviewWindow) -> bool {
    window.is_visible().unwrap_or(false)
}
pub fn show(window: &tauri::WebviewWindow) -> Result<(), String> {
    if active() && window.label() == "overlay" {
        // Gamescope caches external-overlay buffers independently of X mapping.
        // Its opacity property handler explicitly repaints the composition.
        property(window, b"_NET_WM_WINDOW_OPACITY", u32::MAX)?;
    }
    if active() && controls(window) {
        // Only one own control panel requests Steam-overlay focus at a time.
        hide_controls(window)?;
        let _ = window.app_handle().emit("controller-nav-cancel", ());
        input(window, true)?;
    }
    window.show().map_err(|e| e.to_string())
}
pub fn hide(window: &tauri::WebviewWindow) -> Result<(), String> {
    if active() && window.label() == "overlay" {
        let _ = window.emit("controller-nav-cancel", ());
        property(window, b"_NET_WM_WINDOW_OPACITY", 0)?;
    }
    if active() && controls(window) {
        input(window, false)?;
    } else if handles(window) {
        keyboard(window, false)?;
    }
    window.hide().map_err(|e| e.to_string())
}
/// XWayland destroy/disconnect passes the focused lifecycle probes; no native
/// wl_surface workaround or delayed GTK teardown is needed on this transport.
pub fn prepare_exit(app: &tauri::AppHandle, _code: i32) -> bool {
    if active() {
        let _ = super::steam_input::update(false);
        super::gamescope_touch::stop();
        for window in app.webview_windows().into_values() {
            if handles(&window) {
                let _ = input(&window, false);
            }
        }
    }
    false
}

/// Release every control view before Steam handles its system-menu buttons.
/// Keep passive annotations mapped, but stop requesting keyboard/input focus.
pub fn yield_to_steam(app: &tauri::AppHandle) {
    super::steam_input::handoff();
    let app = app.clone();
    let dispatch = app.clone();
    let _ = dispatch.run_on_main_thread(move || {
        for window in app.webview_windows().into_values() {
            if controls(&window) {
                let _ = hide(&window);
            } else if window.label() == "overlay" {
                let _ = keyboard(&window, false);
            }
        }
        let _ = app.emit("controller-nav-cancel", ());
    });
}
