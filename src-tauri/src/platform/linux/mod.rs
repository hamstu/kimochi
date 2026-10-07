//! Linux desktop integration: the same contract as `platform::macos`, for two very
//! different sessions, detected once at startup (`session()`):
//!
//! - **X11** (plan Phase 6, near parity): `x11rb` for the pointer, displays (RandR),
//!   the source catalog (EWMH), focus, icons and activation; GTK (through Tauri) plus
//!   EWMH properties for overlay panels; XInput 2 raw events for trigger keys.
//! - **Wayland** (plan Phase 7, reduced tier): every query that Wayland does not answer
//!   answers "nothing" (`None`, empty, or `Err("unsupported on Wayland: …")`) and
//!   `capabilities()` says so. Capture uses the ScreenCast/PipeWire portal. Native
//!   overlays require optional GTK layer-shell and compositor support; otherwise
//!   overlays are disabled. Global shortcuts use the desktop portal.
//!
//! **Coordinates are desktop units throughout**: X11 root-window pixels divided by
//! GDK's window scale, which is exactly what Tauri's logical coordinates are on X11 (and
//! what `platform::desktop_unit()` calls `Points`: one unit is one CSS pixel; with GDK
//! scaling off, which is almost every X11 desktop, a unit is a root pixel). X11 has no
//! per-monitor scale, so this one plane is exact on every monitor.
//! `DisplayInfo::scale_factor` is the GDK scale (device pixels per unit), never a
//! coordinate factor, as on macOS. `panel_pointer` is window-local in the same units,
//! which are that window's CSS pixels.
//!
//! Ids: windows are `x11:window:{xid}:{pid}` (decimal xid; `x11:window:{xid}` for a
//! client without `_NET_WM_PID`), displays `x11:display:{randr output id}`, minted by
//! `kimochi_capture::x11`, the module the capture backend uses too.
//!
//! Threading: the X11 queries share one `Sync` connection and are safe from any
//! thread. Window functions go through Tauri's thread-safe setters plus X11 requests,
//! and are called from the main thread as on macOS. `observe_workspace` must be called
//! on the main (GTK) thread, which is where its callbacks run.
use super::{AppIdentity, DisplayInfo, PointerSample};
use kimochi_capture::{Rect, SourceId};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::OnceLock;

pub mod dictionary_images;
mod keytrigger;
pub mod gnome;
mod layer;
pub mod shortcuts;
mod rules;
mod window;
mod workspace;
mod x11;

pub use keytrigger::{key_trigger_status, start_key_trigger, stop_key_trigger};
use rules::{Backend, Session};
pub use window::{
    activate_process, activate_self, bounds, inspect, make_panel, order_front, panel_cursor,
    panel_pointer, place, promote_to_key, set_input_regions,
};
pub use workspace::observe_workspace;

const WAYLAND: &str = "unsupported on Wayland";

/// The session, detected from the environment on first use.
pub(crate) fn session() -> &'static Session {
    static SESSION: OnceLock<Session> = OnceLock::new();
    SESSION.get_or_init(|| rules::detect_session(|k| std::env::var(k).ok()))
}

/// Whether this process uses the reduced, ordinary-window reader tier.
pub fn wayland_overlay_unavailable() -> bool {
    session().backend == Backend::Wayland && !layer::available()
}

pub fn initialize_wayland_overlay() { layer::initialize(); }
pub fn wayland_layer_overlay() -> bool { layer::available() }

fn on_x11() -> bool {
    session().backend == Backend::X11
}

// ---------------------------------------------------------------- pointer

/// Pointer position, primary button and held modifiers from one `QueryPointer`.
/// `None` on Wayland (no global pointer) and when the pointer is on another X screen.
pub fn cursor() -> Option<PointerSample> {
    if on_x11() {
        x11::cursor()
    } else {
        None
    }
}

// ---------------------------------------------------------------- displays

pub fn displays() -> Vec<Rect> {
    display_infos().into_iter().map(|d| d.bounds).collect()
}

/// RandR monitors, primary first, with the EWMH work area clipped to each.
///
/// Wayland: empty. GDK could list outputs, but not where they are relative to one
/// another in any space the app can place windows in, and an empty list makes
/// `clamp_to_visible` a no-op rather than a wrong clamp.
pub fn display_infos() -> Vec<DisplayInfo> {
    if !on_x11() {
        return Vec::new();
    }
    let scale = x11::scale();
    let workarea = x11::workarea();
    x11::monitors()
        .into_iter()
        .map(|m| {
            let r = m.rect;
            let [x, y, w, h] = rules::work_area([r.x, r.y, r.width, r.height], workarea);
            let unit = |v: i32| f64::from(v) / scale;
            DisplayInfo {
                id: m.id,
                source_id: display_source_id(m.id),
                bounds: Rect {
                    x: unit(r.x),
                    y: unit(r.y),
                    width: unit(r.width),
                    height: unit(r.height),
                },
                work_area: Rect {
                    x: unit(x),
                    y: unit(y),
                    width: unit(w),
                    height: unit(h),
                },
                scale_factor: scale,
            }
        })
        .collect()
}

/// `x11:display:{id}`, the id capture-core's X11 backend resolves.
pub fn display_source_id(display_id: u32) -> String {
    x11::display_source_id_of(display_id)
}

/// macOS needs an autorelease pool around AppKit work; nothing here does.
pub fn with_pool<R>(f: impl FnOnce() -> R) -> R {
    f()
}

// ---------------------------------------------------------------- sources

/// Displays, then listable windows front to back (`kimochi_capture::x11::Desktop::
/// sources`). X11 needs no permission to list windows. Wayland has no inventory: the
/// system picker chooses (`pickerRequired`).
pub fn picker_sources() -> Result<Vec<kimochi_capture::Source>, String> {
    if on_x11() {
        x11::picker_sources()
    } else {
        Err(format!(
            "{WAYLAND}: sources are chosen in the system picker"
        ))
    }
}

/// Live geometry and visibility of one window source; cheap enough for the source watch.
pub fn window_bounds(id: &SourceId) -> Option<(Rect, bool)> {
    if on_x11() {
        x11::window_bounds(id)
    } else if gnome::eligible_popup_session() {
        let value = gnome::request("track", json!({"operation":"status","sourceId":id.to_string()})).ok()?;
        let rect = serde_json::from_value(value["bounds"].clone()).ok()?;
        Some((rect, value["visible"].as_bool().unwrap_or(false)))
    } else {
        None
    }
}

pub fn front_window() -> Option<super::FrontWindow> {
    if on_x11() {
        x11::front_window()
    } else {
        None
    }
}

/// The active window's process name (executable file name: `firefox`, `kimochi`).
pub fn frontmost_app() -> Option<String> {
    if on_x11() {
        x11::frontmost_app()
    } else {
        None
    }
}

pub fn frontmost_pid() -> Option<u32> {
    if on_x11() {
        x11::frontmost_pid()
    } else {
        None
    }
}

/// `_NET_WM_ICON` of one of the app's windows, as PNG. `None` on Wayland and for apps
/// without an icon property (the UI falls back to its glyph). GNOME resolves the
/// paired native app through its installed GIcon.
pub fn app_icon_png(app: &AppIdentity, target: isize) -> Option<Vec<u8>> {
    if on_x11() {
        x11::app_icon_png(&app.name, app.pid, target)
    } else {
        gnome::paired_app_icon_png(&app.name, target)
    }
}

// ---------------------------------------------------------------- system links

pub fn open_capture_settings() -> Result<(), String> {
    Err("not applicable: Linux has no screen recording setting to open".into())
}

pub fn open_input_settings() -> Result<(), String> {
    Err("not applicable: Linux has no input monitoring setting to open".into())
}

/// Spawn a CLI directly (no login shell), resolved on `PATH` by the standard library,
/// in its own process group so a caller can signal the whole tree it starts.
pub fn run_cli(
    program: &str,
    args: &[&str],
    stdin: Option<&str>,
    cwd: Option<&Path>,
) -> Result<std::process::Child, String> {
    use std::os::unix::process::CommandExt;
    let mut command = std::process::Command::new(program);
    command.args(args).process_group(0);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    super::spawn_cli(command, stdin)
}

// ---------------------------------------------------------------- capabilities

fn os_version() -> String {
    std::fs::read_to_string("/etc/os-release")
        .or_else(|_| std::fs::read_to_string("/usr/lib/os-release"))
        .map(|s| rules::os_version(&s))
        .unwrap_or_default()
}

/// The Linux-specific part of `platform_capabilities`; `platform::capabilities_payload`
/// merges it over the shared defaults and fills capture authorization, key trigger, OCR
/// engines and observer state.
pub fn capabilities() -> Value {
    let s = session();
    let x11 = s.backend == Backend::X11;
    let gnome_status = gnome::status();
    let gnome = gnome_status["available"].as_bool().unwrap_or(false);
    let tracking = gnome && gnome_status["windowTracking"].as_bool().unwrap_or(false);
    json!({
        "os": "linux",
        "osVersion": os_version(),
        "arch": std::env::consts::ARCH,
        "session": {
            "backend": s.backend.as_str(),
            "compositor": s.compositor,
            "layerShell": s.layer_shell,
            "nativeLayerShell": layer::available(),
            "nativeGnomeShell": gnome,
            "xwayland": s.xwayland,
        },
        "keys": {"primaryModifier": "ctrl", "labels": "words", "superName": "Super"},
        "capture": {
            "authorization": if x11 { "granted" } else { "promptOnSelect" },
            "canOpenSettings": false,
            "restartAfterGrant": false,
            "pickerRequired": !x11,
            // X11 and portal window streams support capture; Wayland tracking is deferred.
            "windowCapture": true,
            // X has no capture exclusion list: a display capture includes our overlay.
            "excludesOwnWindows": false,
            "overlayExclusion": "hideDuringCapture",
        },
        "sources": {
            "catalog": x11,
            "thumbnails": x11,
            "icons": x11 || tracking,
            "followWindowBounds": x11 || tracking,
            "foregroundTracking": x11,
        },
        "overlay": {
            "available": x11 || layer::available() || gnome,
            "reason": if !x11 && !layer::available() && !gnome { Some("Native overlay unavailable: this compositor does not support layer-shell, or gtk-layer-shell is not installed.") } else { None },
            "passive": x11 || layer::available() || gnome,
            // X11 with SHAPE: `set_input_regions` installs an XShape input region and
            // the cursor poll stops toggling click-through. Without SHAPE the shared
            // poll toggles it, as on macOS and Windows.
            "inputRegions": if layer::available() || gnome {
                "native"
            } else if !x11 {
                "wholeWindowOnly"
            } else if x11::has_input_shape() {
                "native"
            } else {
                "poll"
            },
            "nonActivating": x11 || layer::available() || gnome,
            "nativeHoverWorkaround": false,
        },
        "input": {"globalShortcuts": x11 || shortcuts::available(), "globalShortcutBackend": if x11 { "x11" } else if shortcuts::report()["backend"] == "gnome-shell" { "gnome-shell" } else { "portal" }, "globalShortcutReport": if x11 { Value::Null } else { shortcuts::report() }, "globalShortcutRemediation": if !x11 && s.compositor.as_deref().unwrap_or("").to_ascii_lowercase().contains("hypr") { Some("On Hyprland, set key combinations in your compositor configuration. Changing a shortcut here does not update those desktop bindings.") } else { None }},
        // The executable's file name, which is what `frontmost_app` and focus events
        // report for this app.
        "ownAppNames": ["Kimochi", "kimochi"],
        "tray": true,
        "gamepad": true,
        "ocrAccelerators": {"meikiocr": "cpu", "mangaocr": "cpu"},
    })
}

pub use layer::{region_editing, region_keyboard};

pub mod capture;
