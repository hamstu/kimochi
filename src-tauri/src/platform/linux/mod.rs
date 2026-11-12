//! Linux desktop integration: the same contract as `platform::macos`, for two very
//! different sessions, detected once at startup (`session()`):
//!
//! - **X11** (plan Phase 6, near parity): `x11rb` for the pointer, displays (RandR),
//!   the source catalog (EWMH), focus, icons and activation; GTK (through Tauri) plus
//!   EWMH properties for overlay panels.
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
use std::sync::{Mutex, OnceLock};

pub mod dictionary_images;
pub mod gnome;
pub mod gamescope;
pub mod gaming_sources;
pub mod gaming_launch;
pub mod steam_input;
mod gamescope_touch;
mod gamescope_focus;
mod gamescope_handoff;
mod input_guard;
mod controller_neutral;
pub mod deck_input;
pub mod hyprland;
mod hyprland_binds;
pub mod kwin;
pub mod native;
pub mod tracking;
pub mod shift;
mod layer;
pub mod screens;
pub mod shortcuts;
pub mod icons;
mod rules;
mod window;
mod workspace;
mod x11;
pub mod webkit_timers;

use rules::{Backend, Session};
pub use window::{
    activate_process, activate_self, activate_window, bounds, inspect, make_panel, order_front, panel_cursor,
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

/// An X11 session (including XWayland under gamescope), where windows have real frames.
pub(crate) fn x11_session() -> bool {
    on_x11()
}

// ---------------------------------------------------------------- pointer

/// Pointer position, primary button and held modifiers: one `QueryPointer` on X11; on GNOME the
/// Shell's own report (`gnome::pointer_sample`) while its shared overlay is up; elsewhere on
/// Wayland the compositor's pointer and a Shift source (`wayland_pointer_feed`). `None` where there is
/// neither (then the overlay's text takes the mouse, Shift or not) and when the pointer is on
/// another X screen.
pub fn cursor() -> Option<PointerSample> {
    if on_x11() {
        x11::cursor()
    } else if gnome::shared_overlay() {
        gnome::pointer_sample()
    } else {
        wayland_cursor()
    }
}

/// Whether the pointer poll needs positions without Shift held: its gate is still open (the
/// reader glides along a line after letting go, `state::ShiftGate`). Without Shift and without
/// it, the Wayland feed reports the modifiers alone and asks the compositor for nothing.
static POINTER_DEMAND: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn pointer_demand(on: bool) {
    POINTER_DEMAND.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// Wayland's stand-in for a global pointer: the compositor's cursor over a layer-shell overlay
/// (KWin's script bridge, Hyprland's IPC) and Shift from `shift.rs`. With both, the overlay's
/// words let clicks through until Shift is held, exactly as on macOS, Windows and X11.
pub fn wayland_pointer_feed() -> Option<shift::Source> {
    if on_x11() || !layer::available() || !tracking::available() {
        return None;
    }
    shift::source()
}

/// Whether every modifier can be read, so `overlayLookupKey` may be other than Shift: X11 and
/// XWayland (KDE Plasma) can; Hyprland's portal relays Shift alone. Elsewhere nothing is gated.
pub fn lookup_keys_readable() -> bool {
    on_x11() || wayland_pointer_feed() != Some(shift::Source::Portal)
}

/// Whether the feed's Shift needs relaying to the overlay's `linux-dictionary-modifier` listeners
/// (the portal source already sends its own edges).
pub fn relays_shift() -> bool {
    wayland_pointer_feed() == Some(shift::Source::XWayland)
}

/// Positions are asked for at most this often (KWin answers on its compositor thread).
const POINTER_EVERY: std::time::Duration = std::time::Duration::from_millis(12);

fn wayland_cursor() -> Option<PointerSample> {
    use std::time::Instant;
    // Where the pointer was last seen: far off-screen until it has been, so nothing is "under" it.
    static LAST: Mutex<Option<(f64, f64, Instant)>> = Mutex::new(None);
    wayland_pointer_feed()?;
    let (modifiers, down) = shift::read()?;
    let mut last = LAST.lock().ok()?;
    // Any modifier: the lookup key (`overlayLookupKey`) may be Ctrl, Alt or Meta. A controller's
    // lookup button stands in for it (`gamepad::lookup_held`).
    let held = modifiers.shift || modifiers.ctrl || modifiers.alt || modifiers.meta || crate::gamepad::lookup_held();
    let wanted = held || down || POINTER_DEMAND.load(std::sync::atomic::Ordering::Relaxed);
    let stale = last.is_none_or(|(_, _, at)| at.elapsed() >= POINTER_EVERY);
    if wanted && stale {
        if let Some(point) = tracking::pointer() {
            if let (Some(x), Some(y)) = (point["x"].as_f64(), point["y"].as_f64()) {
                *last = Some((x, y, Instant::now()));
            }
        }
    }
    let (x, y) = last.map_or((-1e6, -1e6), |(x, y, _)| (x, y));
    Some(PointerSample { x, y, down, modifiers })
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
/// X11 unmaps windows on other workspaces, so the picker never lists one to name.
pub fn source_spaces(_: &[kimochi_capture::Source]) -> std::collections::HashMap<String, String> {
    Default::default()
}

pub fn picker_sources() -> Result<Vec<kimochi_capture::Source>, String> {
    if gaming_sources::active() {
        Ok(gaming_sources::sources())
    } else if on_x11() {
        x11::picker_sources()
    } else if native::active() {
        native::picker_sources()
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
    } else if native::is_source(&id.to_string()) && !gnome::eligible_popup_session() {
        native::window_bounds(id)
    } else if gnome::eligible_popup_session() {
        // Binds a native source to its window first (by id); a portal one must be linked.
        gnome::ensure_bound(&id.to_string());
        let value = gnome::request("track", json!({"operation":"status","sourceId":id.to_string()})).ok()?;
        let rect = serde_json::from_value(value["bounds"].clone()).ok()?;
        Some((rect, value["visible"].as_bool().unwrap_or(false)))
    } else if tracking::available() {
        tracking::tracked(&id.to_string())
    } else {
        None
    }
}

pub fn front_window() -> Option<super::FrontWindow> {
    if on_x11() {
        x11::front_window()
    } else if native::active() {
        native::front_window()
    } else {
        None
    }
}

/// The active window's process name (executable file name: `firefox`, `kimochi`).
pub fn frontmost_app() -> Option<String> {
    if on_x11() {
        x11::frontmost_app()
    } else if native::active() {
        native::frontmost_app()
    } else {
        None
    }
}

pub fn frontmost_pid() -> Option<u32> {
    if on_x11() {
        x11::frontmost_pid()
    } else if native::active() {
        native::frontmost_pid()
    } else {
        None
    }
}

/// `_NET_WM_ICON` of one of the app's windows, as PNG. `None` on Wayland and for apps
/// without an icon property (the UI falls back to its glyph). GNOME resolves the
/// paired native app through its installed GIcon.
pub fn app_icon_png(app: &AppIdentity, target: isize) -> Option<Vec<u8>> {
    if gaming_sources::active() {
        gaming_sources::icon_png(&app.name, target)
    } else if on_x11() {
        x11::app_icon_png(&app.name, app.pid, target)
    } else if native::active() {
        native::app_icon_png(&app.name, app.pid, target).or_else(|| gnome::paired_app_icon_png(&app.name, target))
    } else {
        gnome::paired_app_icon_png(&app.name, target)
    }
}

// ---------------------------------------------------------------- system links

/// Linux leaves "is it full screen" to the shared rule (the window fills its display).
pub fn window_fullscreen(_id: &SourceId) -> Option<bool> {
    None
}

/// Linux has no permission like macOS's Accessibility: `None`.
pub fn accessibility_status() -> Option<bool> {
    None
}

/// Mouse buttons as action shortcuts (`mouse_buttons`) are not available on Linux.
/// No hook here: the portal and X11 shortcuts take keys only, and catching a button for every
/// application would need raw input access Kimochi does not ask for.
pub fn sync_mouse_buttons(_app: &tauri::AppHandle, wanted: bool) -> Result<(), String> {
    if wanted {
        return Err("mouse buttons can't be shortcuts on Linux".into());
    }
    Ok(())
}

pub fn request_accessibility() -> Result<bool, String> {
    Err("unsupported: Linux has no Accessibility permission to grant".into())
}

pub fn open_capture_settings() -> Result<(), String> {
    Err("not applicable: Linux has no screen recording setting to open".into())
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
/// merges it over the shared defaults and fills capture authorization, OCR engines
/// and observer state.
pub fn capabilities() -> Value {
    let s = session();
    let x11 = s.backend == Backend::X11;
    // Gaming Mode reads Gamescope's apps directly when its PipeWire node is there; the
    // portal (one composed screen, no catalog) is the fallback.
    let gaming = gaming_sources::active();
    // The compositor's own capture API (no system picker, sources by window identity).
    let native = !gaming && !x11 && native::active();
    let portal = !gaming && !native && (gamescope::active() || !x11);
    let gnome_status = gnome::status();
    let gnome = gnome_status["available"].as_bool().unwrap_or(false);
    let tracking = gnome && gnome_status["windowTracking"].as_bool().unwrap_or(false);
    let feed = wayland_pointer_feed();
    json!({
        "os": "linux",
        "osVersion": os_version(),
        "arch": std::env::consts::ARCH,
        "session": {
            "backend": s.backend.as_str(),
            "compositor": s.compositor,
            "layerShell": s.layer_shell,
            "nativeLayerShell": layer::available(),
            "nativeGamescope": gamescope::active(),
            "captureBackend": if gaming { "gamescope-pipewire" } else if native { match native::driver() { Some("mutter") => "native-mutter", Some("kwin") => "native-kwin", _ => "native-ext" } } else if portal { "xdg-portal-pipewire" } else { "x11-getimage" },
            "nativeGnomeShell": gnome,
            "xwayland": s.xwayland || gamescope::active(),
        },
        "keys": {"primaryModifier": "ctrl", "labels": "words", "superName": "Super", "mouseButtons": "unsupported"},
        "capture": {
            "authorization": if !portal { "granted" } else { "promptOnSelect" },
            "canOpenSettings": false,
            "restartAfterGrant": false,
            "pickerRequired": portal,
            // X11 and portal window streams support capture; Wayland tracking is deferred.
            "windowCapture": true,
            // A native window's stream shows that window alone: nothing to hide for captures.
            "isolatedWindows": native,
            // X has no capture exclusion list: a display capture includes our overlay.
            "excludesOwnWindows": false,
            "overlayExclusion": if gamescope::scene_capture() { "compositorScene" } else { "hideDuringCapture" },
        },
        "sources": {
            "catalog": !portal,
            "thumbnails": !portal,
            "icons": !portal || tracking,
            // A Gaming Mode app fills the output; nothing moves to follow.
            "followWindowBounds": !gaming && (!portal || tracking || tracking::available()),
            "foregroundTracking": !gaming && !portal,
            // Native sources name their windows: bounds, focus and activation need no linking.
            "nativeWindows": native,
            // Whether `activate_source` can bring a window source forward: a portal stream's
            // window is anonymous, so only GNOME's Shell integration, KWin's script bridge (KDE
            // Plasma) or Gamescope can.
            "activateWindow": gaming || native || !portal || gnome::eligible_popup_session() || tracking::can_activate(),
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
            // Whether the pointer poll reads Shift, so the words let clicks through until it is
            // held (`View::live_regions`): always on X11; on Wayland where `shift.rs` has a source
            // and the compositor reports the pointer (KDE Plasma, Hyprland).
            "shiftGate": x11 || feed.is_some() || gnome::shared_overlay(),
            "shiftSource": if x11 { Some("x11") } else if gnome::shared_overlay() { Some("gnome-shell") } else { feed.map(shift::Source::as_str) },
            // A layer overlay sees no Shift (keyboard NONE). Where nothing relays it, the overlay's
            // text looks up on hover instead (host/linux-scan-input.js): KDE Plasma with Legacy
            // X11 App Support turned off, and Hyprland until its Shift binds have delivered a
            // press (`hyprland_binds`; none at all when the Shift keys are bound to something else).
            "lookupOnHover": !x11 && layer::available() && matches!(s.compositor.as_deref(), Some("KDE" | "Hyprland")) && feed.is_none(),
            "nativeHoverWorkaround": false,
        },
        "input": {"globalShortcuts": x11 || shortcuts::available(), "globalShortcutBackend": if x11 { "x11" } else if shortcuts::report()["backend"] == "gnome-shell" { "gnome-shell" } else { "portal" }, "globalShortcutReport": if x11 { Value::Null } else { shortcuts::report() }, "globalShortcutRemediation": if x11 { None } else { shortcuts::hyprland_remediation() }},
        // The executable's file name, which is what `frontmost_app` and focus events
        // report for this app.
        "ownAppNames": ["Kimochi", "kimochi"],
        "tray": true,
        "gamepad": true,
        "ocrAccelerators": {"meikiocr": "cpu", "mangaocr": "cpu", "ppocr": "cpu"},
    })
}

/// Where Kimochi's own ordinary windows are (`labels`, those `cover` blanks out of screen
/// captures), in the space a captured screen's `source_bounds` are in; `None` where `cover`'s own
/// record of them is right (X11). GNOME's Shell knows; on a layer-shell desktop KWin's bridge or
/// Hyprland's IPC does, and with neither nothing is blanked: a Wayland window's own frame is
/// always at the origin (`own_frames_reliable`), which would blank a made-up corner of the screen.
pub fn own_frames(app: &tauri::AppHandle, labels: &[&str]) -> Option<Vec<Rect>> {
    if let Some(frames) = gnome::own_frames(app, labels) {
        return Some(frames);
    }
    (!on_x11()).then(|| tracking::own_frames().unwrap_or_default())
}

pub fn region_editing() -> bool { gamescope::editing() || layer::region_editing() }
pub fn region_keyboard(window: &tauri::WebviewWindow, on: bool) -> Result<(), String> {
    if gamescope::active() { gamescope::region_keyboard(window, on) } else { layer::region_keyboard(window, on) }
}

pub mod capture;
