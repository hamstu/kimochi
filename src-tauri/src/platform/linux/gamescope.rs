//! Gamescope-specific XWayland renderer with independent public portal capture.
//! Only Kimochi's own overlay properties change; Steam windows are never modified.
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use tauri::{Emitter, Manager};
use x11rb::{
    connection::Connection,
    protocol::xproto::{AtomEnum, ConnectionExt as _, PropMode},
    wrapper::ConnectionExt as _,
};

static EDITING: AtomicBool = AtomicBool::new(false);
static CONTROL_OWNER: Mutex<Option<String>> = Mutex::new(None);
static ROUTED_AWAY: AtomicBool = AtomicBool::new(false);
static YIELDING: AtomicBool = AtomicBool::new(false);

fn set_control_owner(owner: &mut Option<String>, label: &str, focused: bool) {
    if focused { *owner = Some(label.to_owned()); }
    else if owner.as_deref() == Some(label) { *owner = None; }
}
fn owns_input(navigation: bool, controls: bool, yielding: bool, managed: bool) -> bool {
    !yielding && (navigation || (controls && !managed))
}
/// External overlays need the watchdog because Steam reads HID directly.
/// A registered ordinary Steam app uses Steam's own foreground routing, just
/// like the session harness: do not suspend its launcher while using controls.
pub fn refresh_input_lease() -> Result<(), String> {
    let controls = CONTROL_OWNER.lock().unwrap_or_else(|e| e.into_inner()).is_some();
    let routed_here = super::gamescope_focus::owns_input(std::process::id());
    super::steam_input::update(routed_here && owns_input(crate::gamepad::navigating(), controls, YIELDING.load(Ordering::SeqCst), managed()))
}
pub fn control_focus(window: &tauri::WebviewWindow, focused: bool) {
    if !active() || !controls(window) { return; }
    if focused && !YIELDING.load(Ordering::SeqCst) && super::gamescope_focus::owns_input(std::process::id()) {
        YIELDING.store(false, Ordering::SeqCst);
        ROUTED_AWAY.store(false, Ordering::SeqCst);
    }
    set_control_owner(&mut CONTROL_OWNER.lock().unwrap_or_else(|e| e.into_inner()), window.label(), focused);
    if let Err(error) = refresh_input_lease() { eprintln!("Gamescope controls input: {error}"); }
}
/// Renew only from the live, focused control document. If it hangs, the existing
/// independent watchdog resumes Steam; native polling never renews this lease.
pub fn control_heartbeat(window: &tauri::WebviewWindow) -> Result<(), String> {
    if !active() || !controls(window) { return Ok(()); }
    if !super::gamescope_focus::owns_input(std::process::id()) {
        ROUTED_AWAY.store(true, Ordering::SeqCst);
        return Ok(());
    }
    if YIELDING.load(Ordering::SeqCst) {
        if !ROUTED_AWAY.swap(false, Ordering::SeqCst) { return Ok(()); }
        YIELDING.store(false, Ordering::SeqCst);
    }
    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        set_control_owner(&mut CONTROL_OWNER.lock().unwrap_or_else(|e| e.into_inner()), window.label(), true);
        refresh_input_lease()?;
    }
    Ok(())
}

pub fn active() -> bool {
    kimochi_capture::gamescope_portal_now()
}
/// Steam keeps this process alive as the registered app, rather than a thin launcher.
pub fn managed() -> bool {
    active() && std::env::var("KIMOCHI_STEAM_MANAGED").as_deref() == Ok("1")
        && super::gamescope_handoff::own_id().is_some()
}
pub(super) fn managed_controls(window: &tauri::WebviewWindow) -> bool {
    managed() && controls(window)
}
pub(super) fn prepare_control(window: &tauri::WebviewWindow) -> Result<(),String> {
    window.set_focusable(true).map_err(|e|e.to_string())?;
    window.set_skip_taskbar(false).map_err(|e|e.to_string())?;
    window.set_always_on_top(false).map_err(|e|e.to_string())?;
    property(window,b"STEAM_GAME",super::gamescope_handoff::own_id().ok_or("Steam app ID unavailable")?)?;
    Ok(())
}
pub fn start() { super::gamescope_handoff::start(); }
pub fn controls_routed() -> bool {
    managed() && !crate::gamepad::navigating()
        && CONTROL_OWNER.lock().unwrap_or_else(|e|e.into_inner()).is_some()
        && super::gamescope_focus::owns_input(std::process::id())
}
pub fn return_to_game(app: &tauri::AppHandle) {
    return_to(app, None);
}
/// Hand input back to Steam and show `target` (a running app ID), or the game.
pub fn return_to(app: &tauri::AppHandle, target: Option<u32>) {
    if !managed() {
        yield_to_steam(app);
        if let Some(target) = target {
            if let Err(error) = super::gamescope_handoff::select(target) { eprintln!("Gamescope switch: {error}"); }
        }
        return;
    }
    let Some(game) = target.or_else(super::gamescope_handoff::game_id) else {
        eprintln!("Gamescope return: select a running game through Steam first"); return;
    };
    YIELDING.store(true,Ordering::SeqCst);
    ROUTED_AWAY.store(false,Ordering::SeqCst);
    *CONTROL_OWNER.lock().unwrap_or_else(|e|e.into_inner())=None;
    let _=super::steam_input::update(false);
    let app=app.clone();
    let dispatch=app.clone();
    let _=dispatch.run_on_main_thread(move || {
        for window in app.webview_windows().into_values() {
            if controls(&window) {
                crate::gamepad::panel_focus(window.label(),false);
                if window.label() != "log" { let _=window.hide(); }
            } else if window.label()=="overlay" { let _=keyboard(&window,false); }
        }
        if let Some(main)=app.get_webview_window("log") { let _=main.show(); }
        if let Err(error)=super::gamescope_handoff::select(game) { eprintln!("Gamescope return: {error}"); }
        let _=app.emit("controller-nav-cancel",());
    });
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
    if managed_controls(window) {
        prepare_control(window)?;
        property(window,b"STEAM_OVERLAY",0)?;
        property(window,b"STEAM_INPUT_FOCUS",0)?;
        if on { super::gamescope_touch::show(window.app_handle()); }
        return Ok(());
    }
    window.set_focusable(on).map_err(|e| e.to_string())?;
    if window.label() == "overlay" {
        // Guarded before it is claimed, so a claim is never left without its guard.
        if on { super::input_guard::renew(super::window::xid(window)?); } else { super::input_guard::release(); }
    }
    property(window, b"STEAM_OVERLAY", u32::from(on))?;
    property(window, b"STEAM_INPUT_FOCUS", u32::from(on))?;
    if on && controls(window) { super::gamescope_touch::show(window.app_handle()); }
    Ok(())
}
fn hide_controls(window: &tauri::WebviewWindow) -> Result<(), String> {
    for other in window.app_handle().webview_windows().into_values() {
        if other.label() != window.label()
            && controls(&other)
            && !(managed() && other.label() == "log")
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
    if on { YIELDING.store(false, Ordering::SeqCst); }
    if on {
        hide_controls(window)?;
    }
    if on && managed() && window.label()=="overlay" {
        if let Some(game)=super::gamescope_handoff::game_id() { super::gamescope_handoff::select(game)?; }
    }
    input(window, on)?;
    EDITING.store(on, Ordering::SeqCst);
    refresh_input_lease()
}
static REGION: AtomicBool = AtomicBool::new(false);
/// The crop editor is open over the game: the overlay takes touch while it is
/// (gamescope_touch.rs), so a finger can draw, move and resize the box.
pub fn region_editing() -> bool {
    REGION.load(Ordering::SeqCst)
}
pub fn region_keyboard(window: &tauri::WebviewWindow, on: bool) -> Result<(), String> {
    REGION.store(on, Ordering::SeqCst);
    keyboard(window, on)?;
    if on && handles(window) {
        super::gamescope_touch::show(window.app_handle());
    }
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
        input(window, true)?;
        YIELDING.store(false, Ordering::SeqCst);
        control_focus(window, true);
        let _ = window.app_handle().emit("controller-nav-cancel", ());
    }
    window.show().map_err(|e| e.to_string())?;
    if managed_controls(window) {
        super::gamescope_handoff::select(super::gamescope_handoff::own_id().ok_or("Steam app ID unavailable")?)?;
        window.set_focus().map_err(|e|e.to_string())?;
    }
    Ok(())
}
pub fn hide(window: &tauri::WebviewWindow) -> Result<(), String> {
    if managed_controls(window) && window.label()=="log" {
        return_to_game(window.app_handle());
        return Ok(());
    }
    if active() && window.label() == "overlay" {
        let _ = window.emit("controller-nav-cancel", ());
        property(window, b"_NET_WM_WINDOW_OPACITY", 0)?;
    }
    if active() && controls(window) {
        control_focus(window, false);
        input(window, false)?;
    } else if handles(window) {
        keyboard(window, false)?;
    }
    window.hide().map_err(|e| e.to_string())?;
    if managed_controls(window) {
        if let Some(main)=window.app_handle().get_webview_window("log") { show(&main)?; }
    }
    Ok(())
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
    YIELDING.store(true, Ordering::SeqCst);
    *CONTROL_OWNER.lock().unwrap_or_else(|e| e.into_inner()) = None;
    super::steam_input::handoff();
    let app = app.clone();
    let dispatch = app.clone();
    let _ = dispatch.run_on_main_thread(move || {
        for window in app.webview_windows().into_values() {
            if controls(&window) && !managed() {
                let _ = hide(&window);
            } else if window.label() == "overlay" {
                let _ = keyboard(&window, false);
            }
        }
        let _ = app.emit("controller-nav-cancel", ());
    });
}

#[cfg(test)]
mod input_tests {
    use super::*;
    #[test]
    fn closing_radial_keeps_focused_controls_owned() {
        assert!(owns_input(true, false, false, false));
        assert!(owns_input(true, true, false, false));
        assert!(owns_input(false, true, false, false));
        assert!(!owns_input(false, false, false, false));
        assert!(!owns_input(true, true, true, false));
    }
    #[test]
    fn steam_managed_controls_leave_steam_running_but_modal_overlay_blocks() {
        assert!(!owns_input(false, true, false, true));
        assert!(owns_input(true, true, false, true));
        assert!(owns_input(true, false, false, true));
        assert!(!owns_input(true, true, true, true));
    }
    #[test]
    fn late_blur_does_not_release_the_new_control_window() {
        let mut owner = None;
        set_control_owner(&mut owner, "log", true);
        set_control_owner(&mut owner, "dictionary", true);
        set_control_owner(&mut owner, "log", false);
        assert_eq!(owner.as_deref(), Some("dictionary"));
        set_control_owner(&mut owner, "dictionary", false);
        assert_eq!(owner, None);
    }
}
