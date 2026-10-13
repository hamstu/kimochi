//! The X11 half of the Linux adapter: one shared connection, and every query and EWMH
//! request the contract needs. Catalog facts (monitors, client windows, ids, the
//! listing rule) come from `kimochi_capture::x11`, so this module and the capture
//! backend agree on every id and rectangle.
//!
//! Units: everything returned is in *desktop units*, root pixels divided by GDK's
//! window scale (`scale()`), which is what Tauri's logical coordinates are on X11.
use super::super::{FrontWindow, Modifiers, PointerSample};
use super::rules;
use kimochi_capture::x11::{display_source_id, window_source_id, Desktop, Monitor, WindowKind};
use kimochi_capture::{Platform, Rect, Source, SourceId};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    AtomEnum, ClientMessageEvent, ConfigureWindowAux, ConnectionExt as _, EventMask, StackMode,
    Window,
};
use x11rb::rust_connection::RustConnection;

/// The process-wide query connection, opened on first use. `None` when no X server
/// can be reached (then every X11 query answers "nothing"). `RustConnection` is
/// `Sync`, so any thread may use it; nothing here holds the server grabbed.
pub(super) fn desktop() -> Option<&'static Desktop> {
    static DESKTOP: OnceLock<Option<Desktop>> = OnceLock::new();
    DESKTOP
        .get_or_init(|| match Desktop::connect() {
            Ok(d) => Some(d),
            Err(e) => {
                eprintln!("platform: {e}");
                None
            }
        })
        .as_ref()
}

/// GDK's window scale, re-read at most every few seconds: the cursor poll asks for it
/// at frame rate, and it only changes when the user changes display scaling.
pub(super) fn scale() -> f64 {
    static CACHE: Mutex<Option<(Instant, f64)>> = Mutex::new(None);
    let mut cache = CACHE.lock().unwrap();
    if let Some((at, value)) = *cache {
        if at.elapsed() < Duration::from_secs(5) {
            return value;
        }
    }
    let value = desktop().map_or(1., Desktop::scale);
    *cache = Some((Instant::now(), value));
    value
}

fn to_desktop(v: i16) -> f64 {
    f64::from(v) / scale()
}

// ---------------------------------------------------------------- pointer

pub fn cursor() -> Option<PointerSample> {
    let d = desktop()?;
    let reply = d.conn.query_pointer(d.root).ok()?.reply().ok()?;
    if !reply.same_screen {
        return None;
    }
    let held = rules::held_state(u16::from(reply.mask));
    Some(PointerSample {
        x: to_desktop(reply.root_x),
        y: to_desktop(reply.root_y),
        down: held.primary,
        modifiers: Modifiers {
            shift: held.shift,
            ctrl: held.ctrl,
            alt: held.alt,
            meta: held.meta,
        },
    })
}

// ---------------------------------------------------------------- displays

pub fn monitors() -> Vec<Monitor> {
    desktop().map(Desktop::monitors).unwrap_or_default()
}

/// The EWMH work area of the current desktop, root pixels.
pub fn workarea() -> Option<rules::Area> {
    let d = desktop()?;
    let current = d
        .property32(d.root, d.atoms._NET_CURRENT_DESKTOP, AtomEnum::CARDINAL)
        .and_then(|v| v.first().copied())
        .unwrap_or(0);
    let values = d.property32(d.root, d.atoms._NET_WORKAREA, AtomEnum::CARDINAL)?;
    rules::workarea_for_desktop(&values, current as usize)
        .or_else(|| rules::workarea_for_desktop(&values, 0))
}

pub fn display_source_id_of(id: u32) -> String {
    display_source_id(id).to_string()
}

// ---------------------------------------------------------------- windows

/// An X11 window id of ours or anyone's, from a source id: `None` for another
/// platform's id, a malformed handle, or a window whose pid no longer matches (xids
/// are recycled).
fn resolve(id: &SourceId) -> Option<Window> {
    if id.platform() != Platform::X11 || !id.is_window() {
        return None;
    }
    let window = id.handle_u32()?;
    if let Some(pid) = id.pid() {
        if desktop()?.pid(window) != Some(pid) {
            return None;
        }
    }
    Some(window)
}

pub fn picker_sources() -> Result<Vec<Source>, String> {
    let d = desktop().ok_or("native: could not connect to the X server")?;
    Ok(d.sources(std::process::id()))
}

pub fn window_bounds(id: &SourceId) -> Option<(Rect, bool)> {
    let d = desktop()?;
    let window = resolve(id)?;
    let info = d.window_info(window)?;
    Some((info.rect.to_desktop(scale()), info.on_screen()))
}

/// The active window and its process. A window that is not one a reader could be
/// reading (a dock, the desktop, a tiny or unmapped surface) still answers with its
/// pid and no window, as on macOS and Windows. `None` when nothing is active or the
/// active client never said which process it is.
pub fn front_window() -> Option<FrontWindow> {
    let d = desktop()?;
    let active = d.active_window()?;
    let info = d.window_info(active)?;
    let pid = info.pid?;
    let readable = info.on_screen() && matches!(info.kind, WindowKind::Normal | WindowKind::Dialog);
    Some(FrontWindow {
        window: readable.then(|| window_source_id(active, Some(pid))),
        pid,
    })
}

pub fn frontmost_pid() -> Option<u32> {
    let d = desktop()?;
    d.pid(d.active_window()?)
}

pub fn frontmost_app() -> Option<String> {
    frontmost_pid().and_then(kimochi_capture::x11::process_name)
}

/// Every client window owned by `pid`, front to back.
fn windows_of(d: &Desktop, pid: u32) -> Vec<Window> {
    d.clients()
        .into_iter()
        .filter(|&w| d.pid(w) == Some(pid))
        .collect()
}

/// PNG of an application's icon from `_NET_WM_ICON` on one of its windows, the
/// representation closest to `target` pixels. Found by pid when known, else by process
/// name. `None` for an app whose windows carry no icon (many games): the UI then shows
/// its generic glyph.
pub fn app_icon_png(name: &str, pid: Option<u32>, target: isize) -> Option<Vec<u8>> {
    let d = desktop()?;
    let candidates: Vec<Window> = match pid {
        Some(pid) => windows_of(d, pid),
        None => d
            .clients()
            .into_iter()
            .filter(|&w| {
                d.pid(w)
                    .and_then(kimochi_capture::x11::process_name)
                    .is_some_and(|n| n.eq_ignore_ascii_case(name))
            })
            .collect(),
    };
    let target = target.clamp(1, 1024) as u32;
    for window in candidates {
        let Some(data) = d.property32(window, d.atoms._NET_WM_ICON, AtomEnum::CARDINAL) else {
            continue;
        };
        let Some((w, h, pixels)) = rules::pick_icon(&data, target) else {
            continue;
        };
        return encode_png(w, h, &rules::argb_to_rgba(pixels));
    }
    None
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(bytes)
}

// ---------------------------------------------------------------- EWMH requests

/// Send an EWMH client message about `window` to the root (where the window manager
/// listens), as `_NET_WM_*` requests must be.
fn client_message(d: &Desktop, window: Window, kind: u32, data: [u32; 5]) -> Result<(), String> {
    let event = ClientMessageEvent::new(32, window, kind, data);
    d.conn
        .send_event(
            false,
            d.root,
            EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
            event,
        )
        .map_err(|e| e.to_string())?;
    d.conn.flush().map_err(|e| e.to_string())
}

/// Ask the window manager to activate (raise, focus, un-minimise, switch workspace
/// to) `window`. Source indication 2 ("pager") is what taskbars send, which focus
/// stealing prevention lets through; a normal application (1) is often refused.
pub fn activate_window(window: Window) -> Result<(), String> {
    let d = desktop().ok_or("native: no X server")?;
    client_message(d, window, d.atoms._NET_ACTIVE_WINDOW, [2, 0, 0, 0, 0])
}

/// Raise without focusing: `_NET_RESTACK_WINDOW` (Above, no sibling) for window
/// managers that honour it, and a plain `ConfigureWindow` for those that do not (they
/// see it as a ConfigureRequest and usually grant it for override-free windows).
pub fn raise(window: Window) -> Result<(), String> {
    let d = desktop().ok_or("native: no X server")?;
    client_message(d, window, d.atoms._NET_RESTACK_WINDOW, [2, 0, 0, 0, 0])?;
    d.conn
        .configure_window(
            window,
            &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
        )
        .map_err(|e| e.to_string())?;
    d.conn.flush().map_err(|e| e.to_string())
}

/// Mark a window as a utility panel that must not take focus when mapped:
/// `_NET_WM_WINDOW_TYPE_UTILITY` and `_NET_WM_USER_TIME = 0` (EWMH: "do not focus on
/// map"). Both are read by the window manager when it manages the window; changing the
/// type of an already-managed window is honoured by Mutter and KWin, ignored by some
/// smaller window managers (the other panel properties are set through GTK and work
/// everywhere).
pub fn mark_panel(window: Window) -> Result<(), String> {
    use x11rb::wrapper::ConnectionExt as _;
    let d = desktop().ok_or("native: no X server")?;
    d.conn
        .change_property32(
            x11rb::protocol::xproto::PropMode::REPLACE,
            window,
            d.atoms._NET_WM_WINDOW_TYPE,
            AtomEnum::ATOM,
            &[d.atoms._NET_WM_WINDOW_TYPE_UTILITY],
        )
        .map_err(|e| e.to_string())?;
    d.conn
        .change_property32(
            x11rb::protocol::xproto::PropMode::REPLACE,
            window,
            d.atoms._NET_WM_USER_TIME,
            AtomEnum::CARDINAL,
            &[0],
        )
        .map_err(|e| e.to_string())?;
    d.conn.flush().map_err(|e| e.to_string())
}

/// The top-level window (the window manager's frame, or the window itself when
/// unmanaged) that contains `window`.
pub fn toplevel_of(window: Window) -> Option<Window> {
    let d = desktop()?;
    let mut current = window;
    for _ in 0..16 {
        let tree = d.conn.query_tree(current).ok()?.reply().ok()?;
        if tree.parent == tree.root || tree.parent == 0 {
            return Some(current);
        }
        current = tree.parent;
    }
    None
}

/// Where the pointer is inside `window`, in desktop units, if `window` is the
/// top-level the pointer is over. The server answers with the top-level whose *input
/// region* contains the pointer, so other windows above ours occlude it, and a window
/// that is currently click-through (an empty input shape, which is how tao implements
/// `set_ignore_cursor_events`) never has the pointer — the same limit as `WindowFromPoint`
/// on Windows.
pub fn pointer_in(window: Window) -> Option<(f64, f64)> {
    let d = desktop()?;
    let at = d.conn.query_pointer(d.root).ok()?.reply().ok()?;
    if !at.same_screen || at.child == 0 {
        return None;
    }
    let top = toplevel_of(window)?;
    if at.child != top && at.child != window {
        return None;
    }
    let local = d
        .conn
        .translate_coordinates(d.root, window, at.root_x, at.root_y)
        .ok()?
        .reply()
        .ok()?;
    let geometry = d.conn.get_geometry(window).ok()?.reply().ok()?;
    let (x, y) = (f64::from(local.dst_x), f64::from(local.dst_y));
    if !rules::inside(x, y, f64::from(geometry.width), f64::from(geometry.height)) {
        return None;
    }
    let s = scale();
    Some((x / s, y / s))
}

// ---------------------------------------------------------------- input shapes

/// Whether the X server has the SHAPE extension (version 1.1+, which added input
/// shapes; every server of the last twenty years). Asked once.
pub fn has_input_shape() -> bool {
    use x11rb::connection::RequestConnection as _;
    use x11rb::protocol::shape::ConnectionExt as _;
    static HAS: OnceLock<bool> = OnceLock::new();
    *HAS.get_or_init(|| {
        let Some(d) = desktop() else {
            return false;
        };
        let present = d
            .conn
            .extension_information(x11rb::protocol::shape::X11_EXTENSION_NAME)
            .ok()
            .flatten()
            .is_some();
        present
            && d.conn
                .shape_query_version()
                .ok()
                .and_then(|c| c.reply().ok())
                .is_some_and(|v| (v.major_version, v.minor_version) >= (1, 1))
    })
}

/// Replace `window`'s input shape: with the union of `regions` (window-local CSS
/// pixels, converted with GDK's scale and clamped to the window's current size), or,
/// for `None`, with the default (the whole window takes input). The bounding shape,
/// which is what is painted, is never touched.
///
/// Checked rather than fire-and-forget, so a bad window id is an `Err` here instead of
/// an asynchronous error nobody reads; it costs one round trip per change.
pub fn set_input_shape(window: Window, regions: Option<&[Rect]>) -> Result<(), String> {
    use x11rb::protocol::shape::{ConnectionExt as _, SK, SO};
    use x11rb::protocol::xproto::{ClipOrdering, Rectangle};
    let d = desktop().ok_or("native: no X server")?;
    let cookie = match regions {
        None => d
            .conn
            .shape_mask(SO::SET, SK::INPUT, window, 0, 0, x11rb::NONE)
            .map_err(|e| e.to_string())?,
        Some(regions) => {
            let geometry = d
                .conn
                .get_geometry(window)
                .map_err(|e| e.to_string())?
                .reply()
                .map_err(|e| e.to_string())?;
            let css: Vec<[f64; 4]> = regions
                .iter()
                .map(|r| [r.x, r.y, r.width, r.height])
                .collect();
            let rects: Vec<Rectangle> =
                rules::input_shape(&css, scale(), (geometry.width, geometry.height))
                    .into_iter()
                    .map(|r| Rectangle {
                        x: r.x,
                        y: r.y,
                        width: r.width,
                        height: r.height,
                    })
                    .collect();
            d.conn
                .shape_rectangles(
                    SO::SET,
                    SK::INPUT,
                    ClipOrdering::UNSORTED,
                    window,
                    0,
                    0,
                    &rects,
                )
                .map_err(|e| e.to_string())?
        }
    };
    cookie
        .check()
        .map_err(|e| format!("native: input shape: {e}"))
}

/// Names of a window's `_NET_WM_STATE` and `_NET_WM_WINDOW_TYPE` atoms, its WM_HINTS
/// input flag and map state, for `inspect`.
pub fn describe(window: Window) -> serde_json::Value {
    let Some(d) = desktop() else {
        return serde_json::Value::Null;
    };
    let names = |atoms: Vec<u32>| -> Vec<String> {
        atoms
            .into_iter()
            .filter_map(|a| {
                let reply = d.conn.get_atom_name(a).ok()?.reply().ok()?;
                Some(String::from_utf8_lossy(&reply.name).into_owned())
            })
            .collect()
    };
    // WM_HINTS: flags, input, ... ; InputHint is flag bit 0.
    let accepts_input = d
        .property32(window, u32::from(AtomEnum::WM_HINTS), AtomEnum::WM_HINTS)
        .and_then(|v| (v.len() >= 2 && v[0] & 1 != 0).then_some(v[1] != 0));
    let viewable = d
        .conn
        .get_window_attributes(window)
        .ok()
        .and_then(|c| c.reply().ok())
        .map(|a| a.map_state == x11rb::protocol::xproto::MapState::VIEWABLE);
    serde_json::json!({
        "xid": window,
        "toplevel": toplevel_of(window),
        "viewable": viewable,
        "wm_state": names(d.wm_state(window)),
        "window_type": names(
            d.property32(window, d.atoms._NET_WM_WINDOW_TYPE, AtomEnum::ATOM).unwrap_or_default()
        ),
        "accepts_input": accepts_input,
        "active": d.active_window() == Some(window),
    })
}

/// Our own top-level client windows that the window manager will focus (not utility
/// panels), front to back.
pub fn own_windows() -> Vec<Window> {
    let Some(d) = desktop() else {
        return Vec::new();
    };
    windows_of(d, std::process::id())
        .into_iter()
        .filter(|&w| {
            let types = d
                .property32(w, d.atoms._NET_WM_WINDOW_TYPE, AtomEnum::ATOM)
                .unwrap_or_default();
            !types.contains(&d.atoms._NET_WM_WINDOW_TYPE_UTILITY)
        })
        .collect()
}

/// The frontmost window of a process, if it has one the window manager manages.
pub fn front_window_of(pid: u32) -> Option<Window> {
    windows_of(desktop()?, pid).into_iter().next()
}

/// A fresh connection for a thread that blocks on events (the workspace observer): the
/// shared query connection must never be blocked in `wait_for_event`.
pub fn event_connection() -> Result<(RustConnection, Window), String> {
    let (conn, screen) = x11rb::connect(None).map_err(|e| e.to_string())?;
    let root = conn.setup().roots.get(screen).ok_or("no X screen")?.root;
    Ok((conn, root))
}

#[allow(dead_code)] // Used by `inspect` callers that want the id form.
pub fn source_id_of(window: Window) -> Option<String> {
    let pid = desktop()?.pid(window);
    Some(window_source_id(window, pid).to_string())
}
