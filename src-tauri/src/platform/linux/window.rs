//! Kimochi's own windows on Linux: placement, panels, raising, focus and activation.
//!
//! Ordinary state (position, size, visibility, keep-above, skip-taskbar, focusability)
//! goes through Tauri's window API, which tao turns into the GTK calls that own those
//! hints (`gtk_window_set_keep_above`, `_set_skip_taskbar_hint`/`_pager_hint`,
//! `_set_accept_focus`). GTK rewrites `WM_HINTS` and `_NET_WM_STATE` itself, so setting
//! them behind its back would be undone; only what GTK does not manage after realize
//! (`_NET_WM_WINDOW_TYPE`, `_NET_WM_USER_TIME`) and what it has no API for (raise without
//! focus, EWMH activation) are sent over X11 directly, addressed by the window's X id
//! from `raw-window-handle` (tao reports `Xlib` handles on X11).
//!
//! Placement is in Tauri *logical* coordinates, which on X11 are root pixels / GDK
//! scale, the same desktop units `x11.rs` reports. On Wayland Tauri cannot position a
//! window at all (`set_position` is ignored by the protocol); `place` still sets the
//! size, and `bounds` reports what GTK believes, which for position is (0, 0).
//!
//! Threading: Tauri's setters are thread-safe (they are posted to the event loop), and
//! the X11 requests use the shared, `Sync` query connection, so every function here may
//! run on any thread. They are still called from the main thread, as on macOS.
use super::{session, x11, Backend};
use kimochi_capture::Rect;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;

/// Labels of the windows `make_panel` converted, for `promote_to_key`'s focus restore.
static PANELS: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// Labels whose blur handler is installed.
static HOOKED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn insert(set: &Mutex<Option<HashSet<String>>>, label: &str) -> bool {
    set.lock()
        .unwrap()
        .get_or_insert_with(HashSet::new)
        .insert(label.to_string())
}

fn contains(set: &Mutex<Option<HashSet<String>>>, label: &str) -> bool {
    set.lock()
        .unwrap()
        .as_ref()
        .is_some_and(|s| s.contains(label))
}

const WAYLAND_PANEL: &str = "unsupported on Wayland: a window cannot be kept above others or made \
non-activating without layer-shell; the reader runs as an ordinary window";

/// The X11 window id of one of our windows.
pub(super) fn xid(w: &tauri::WebviewWindow) -> Result<u32, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let handle = w.window_handle().map_err(|e| format!("native: {e}"))?;
    match handle.as_raw() {
        RawWindowHandle::Xlib(h) => u32::try_from(h.window).map_err(|e| e.to_string()),
        RawWindowHandle::Xcb(h) => Ok(h.window.get()),
        _ => Err("native: not an X11 window".into()),
    }
}

/// Place by Tauri's logical coordinates (desktop units on X11).
pub fn place(w: &tauri::WebviewWindow, r: Rect) -> Result<(), String> {
    if w.label() == "log" && super::gnome::eligible_popup_session() {
        // Set before first map, so the bridge never races the first lookup.
        w.set_title("Kimochi · log").map_err(|e| e.to_string())?;
    }
    if session().backend == Backend::Wayland && w.is_resizable().unwrap_or(false) {
        // A tiling compositor can allocate less than a panel's preferred minimum.
        // GTK then keeps a wider WebView than the displayed surface, squashing
        // pixels and offsetting hit targets. Resizable panels must fit their tile.
        w.set_min_size(Some(tauri::LogicalSize::new(1., 1.)))
            .map_err(|e| e.to_string())?;
    }
    if super::layer::available() {
        super::layer::place(w, r)?;
        if w.label() == "overlay" { return Ok(()); }
    }
    w.set_position(tauri::LogicalPosition::new(r.x, r.y))
        .map_err(|e| e.to_string())?;
    w.set_size(tauri::LogicalSize::new(r.width, r.height))
        .map_err(|e| e.to_string())
}

pub fn bounds(w: &tauri::WebviewWindow) -> Result<Rect, String> {
    // Native input shapes need the popup's mapped origin; startup must also allow
    // unmapped windows. Explicit popup-anchor queries remain strict in window_bounds.
    if w.label() == "popup-host" && super::gnome::desktop_popup() {
        if let Ok(rect) = super::gnome::own_bounds(w) { return Ok(rect); }
    }
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let position = if super::layer::available() {
        tauri::LogicalPosition::new(0., 0.)
    } else { w
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale) };
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

/// Window-local CSS pixels of the pointer when it is over this window and nothing
/// else is above it there (see `x11::pointer_in` for click-through windows). Wayland
/// hides the global pointer: always `None` there.
pub fn panel_pointer(w: &tauri::WebviewWindow) -> Result<Option<(f64, f64)>, String> {
    match session().backend {
        Backend::Wayland => Ok(None),
        Backend::X11 => {
            let zoom = super::gamescope::controls_zoom(w);
            Ok(x11::pointer_in(xid(w)?).map(|(x, y)| (x / zoom, y / zoom)))
        },
    }
}

/// A no-op that succeeds. The macOS version exists because WebKit stops updating the
/// cursor over a window of an inactive app; X11 delivers pointer motion to every window
/// regardless of focus, so WebKitGTK sets the right cursor itself, even over a panel that
/// never takes focus (`nativeHoverWorkaround: false`).
pub fn panel_cursor(_w: &tauri::WebviewWindow, _kind: &str) -> Result<(), String> {
    Ok(())
}

/// Native click-through on X11: an XShape *input* region (`ShapeRectangles`,
/// `SK::INPUT`, `SO::SET`) on the window's X window, so the server itself sends the
/// pointer to us inside `regions` (window-local CSS pixels) and to whatever is
/// underneath everywhere else, with no polling latency. The bounding (painted) shape
/// is untouched. `None` restores the default input shape (the whole window).
///
/// `Ok(true)` means the shape is now the input shape and the caller must leave the
/// window's `set_ignore_cursor_events` alone from then on: tao implements that setter
/// with a GDK input shape too (a 1x1 region for "ignore", GDK's default for "don't"),
/// sent on GDK's own connection, so calling it would overwrite this one, in an order
/// neither connection controls. A `SET` here replaces whatever GDK last installed.
///
/// A reparenting window manager puts the window in a frame; Mutter, KWin, Xfwm and
/// the compositors copy the client's input shape to the frame (they must, for tao's
/// own click-through to work), which is the same reliance `set_ignore_cursor_events`
/// has. `Ok(false)` on Wayland and on a server without SHAPE 1.1: the caller keeps
/// polling.
pub fn set_input_regions(
    w: &tauri::WebviewWindow,
    regions: Option<&[Rect]>,
) -> Result<bool, String> {
    if super::layer::available() || (w.label() == "popup-host" && super::gnome::eligible_popup_session()) {
        return super::layer::input_regions(w, regions);
    }
    if session().backend != Backend::X11 || !x11::has_input_shape() {
        return Ok(false);
    }
    x11::set_input_shape(xid(w)?, regions)?;
    Ok(true)
}

pub fn inspect(w: &tauri::WebviewWindow) -> Result<Value, String> {
    let s = session();
    let mut value = json!({
        "platform": "linux",
        "session": s.backend.as_str(),
        "compositor": s.compositor,
        "is_key": w.is_focused().unwrap_or(false),
        "visible": w.is_visible().unwrap_or(false),
        "panel": contains(&PANELS, w.label()),
    });
    if s.backend == Backend::X11 {
        if let Ok(id) = xid(w) {
            value["x11"] = x11::describe(id);
        }
    }
    Ok(value)
}

/// Show and raise without focusing. tao's `show` is `gtk_widget_show_all` (a map, never
/// `present`), and a panel maps without focus (`make_panel` cleared accept-focus and set
/// `_NET_WM_USER_TIME = 0`); the raise is a restack request, not an activation.
pub fn order_front(w: &tauri::WebviewWindow) -> Result<(), String> {
    if super::gamescope::handles(w) { return super::gamescope::show(w); }
    w.show().map_err(|e| e.to_string())?;
    if session().backend == Backend::X11 {
        x11::raise(xid(w)?)?;
    }
    Ok(())
}

/// Give the window the keyboard, for the explicit editing action (plan §11 decision 6).
///
/// **This activates Kimochi's window** — X11 has no "key window of an inactive
/// application" — so it must never run on hover (`HOVER_PROMOTES_KEY` is false here).
/// A panel stops refusing focus for the duration, and refuses it again as soon as it
/// loses focus, so passive hovering after editing stays passive. Returns whether
/// activation was requested; the window manager grants it asynchronously.
///
/// Wayland: an application cannot take focus by itself (xdg-activation needs a token
/// from a user action the compositor saw), so this answers `false`; the reader is an
/// ordinary window there and a click focuses it.
pub fn promote_to_key(w: &tauri::WebviewWindow) -> Result<bool, String> {
    if session().backend == Backend::Wayland {
        return Ok(false);
    }
    if !w.is_visible().unwrap_or(false) || w.is_focused().unwrap_or(false) {
        return Ok(false);
    }
    let label = w.label().to_string();
    if contains(&PANELS, &label) {
        w.set_focusable(true).map_err(|e| e.to_string())?;
        if insert(&HOOKED, &label) {
            let window = w.clone();
            w.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = window.set_focusable(false);
                }
            });
        }
        // GTK's new WM_HINTS travel on GDK's own connection, which flushes on the next
        // main-loop iteration; an activation sent now on ours could reach the window
        // manager first and be refused for a window that still says input=False.
        let window = xid(w)?;
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let _ = x11::activate_window(window);
        });
        return Ok(true);
    }
    x11::activate_window(xid(w)?)?;
    Ok(true)
}

/// Make a finished window a passive overlay panel on X11: a utility window that is
/// kept above, left out of the taskbar and pager, and never given focus by clicks or
/// mapping (`WM_HINTS.input = False` via GTK's accept-focus, `_NET_WM_USER_TIME = 0`).
/// Pointer events still reach it, so hover and clicks work while the reader's game
/// keeps the keyboard.
///
/// `KIMOCHI_NO_PANEL=1` skips it, as on macOS. Wayland: `Err` (see `WAYLAND_PANEL`).
pub fn make_panel(w: &tauri::WebviewWindow) -> Result<bool, String> {
    if std::env::var_os("KIMOCHI_NO_PANEL").is_some() {
        return Ok(false);
    }
    if session().backend == Backend::Wayland {
        if w.label() == "popup-host" && super::gnome::eligible_popup_session() {
            use glib::object::ObjectType as _;
            unsafe extern "C" { fn gtk_window_set_focus_on_map(window: *mut std::ffi::c_void, focus: i32); }
            let gtk = w.gtk_window().map_err(|e| e.to_string())?;
            // A small dictionary window may take focus on an explicit click, never on map.
            unsafe { gtk_window_set_focus_on_map(gtk.as_ptr().cast(), 0) };
            w.set_title("Kimochi · popup-host").map_err(|e| e.to_string())?;
            w.set_skip_taskbar(true).map_err(|e| e.to_string())?;
            insert(&PANELS, w.label());
            return Ok(true);
        }
        if super::layer::make_panel(w)? {
            insert(&PANELS, w.label());
            return Ok(true);
        }
        return Err(WAYLAND_PANEL.into());
    }
    // A hidden GTK window has no GDK/X11 handle until realized. Realizing creates
    // that handle without mapping the window, so the utility type precedes first show.
    use glib::object::ObjectType as _;
    unsafe extern "C" {
        fn gtk_widget_realize(widget: *mut std::ffi::c_void);
    }
    let gtk_window = w.gtk_window().map_err(|e| e.to_string())?;
    // make_panel is called on the main thread during window setup only.
    unsafe { gtk_widget_realize(gtk_window.as_ptr().cast()) };
    if super::gamescope::managed_controls(w) {
        super::gamescope::prepare_control(w)?;
        return Ok(false);
    }
    w.set_focusable(false).map_err(|e| e.to_string())?;
    w.set_skip_taskbar(true).map_err(|e| e.to_string())?;
    w.set_always_on_top(true).map_err(|e| e.to_string())?;
    // Best effort: the GTK half above is what keeps focus out; the window type only
    // changes how the window manager decorates and stacks it.
    if let Err(e) = xid(w).and_then(x11::mark_panel) {
        eprintln!(
            "platform: could not mark {} as a utility window: {e}",
            w.label()
        );
    }
    if super::gamescope::active() && w.label() == "overlay" {
        super::gamescope::make_overlay(w)?;
    }
    insert(&PANELS, w.label());
    Ok(true)
}

/// Activate Kimochi through the window manager (`_NET_ACTIVE_WINDOW`): `prefer` (the
/// overlay the menu is drawn on) if there is one, so the main window stays behind the
/// game. The window manager answers asynchronously and may refuse a utility window, so
/// if Kimochi is still not in front a moment later its frontmost ordinary window is
/// activated instead, which at least stops the game reading the controller.
pub fn activate_self(prefer: Option<&tauri::WebviewWindow>) -> Result<(), String> {
    match session().backend {
        Backend::Wayland => Err(
            "unsupported on Wayland: applications cannot activate themselves without an activation token"
                .into(),
        ),
        Backend::X11 => {
            let fallback = || {
                let window = x11::own_windows()
                    .into_iter()
                    .next()
                    .ok_or("native: Kimochi has no window to activate")?;
                x11::activate_window(window)
            };
            let Some(window) = prefer.filter(|w| w.is_visible().unwrap_or(false)) else {
                return fallback();
            };
            if window.is_focused().unwrap_or(false) {
                return Ok(());
            }
            promote_to_key(window)?;
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                if x11::frontmost_pid() != Some(std::process::id()) {
                    let _ = fallback();
                }
            });
            Ok(())
        }
    }
}

/// Bring a window source to the front. Linux goes by its process, as before.
pub fn activate_window(id: &kimochi_capture::SourceId) -> Result<serde_json::Value, String> {
    activate_process(id.pid().filter(|pid| *pid > 0).ok_or("invalid: the window has no process")?)
        .map(|()| serde_json::json!({ "process": true }))
}

/// Activate another process's frontmost window (returning focus to the game).
pub fn activate_process(pid: u32) -> Result<(), String> {
    match session().backend {
        Backend::Wayland => {
            Err("unsupported on Wayland: other applications' windows cannot be activated".into())
        }
        Backend::X11 => {
            let window = x11::front_window_of(pid)
                .ok_or_else(|| format!("native: process {pid} has no window"))?;
            x11::activate_window(window)
        }
    }
}
