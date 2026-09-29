//! Native window lifecycle, pinning, placement and bounds recovery.
//! Mirrors the semantics of the Electron build's `src/main/native-windows.ts`.
use crate::native;
use crate::settings::Settings;
use kimochi_capture::Rect;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{Emitter, Manager, WebviewWindow};

/// One label-parameterised React page backs every ordinary panel, matching the
/// Electron build's single `panel.html` that switched on the snapshot kind.
const PANEL_PAGE: &str = "app/panel.html";

pub struct PanelSpec {
    pub label: &'static str,
    pub title: &'static str,
    /// Path inside `dist/`. Every window is same-origin at `tauri://localhost`.
    pub url: &'static str,
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
    pub resizable: bool,
    /// Electron starts controls and Log pinned; every other panel unpinned.
    pub pinned: bool,
    /// Built during setup rather than on first show.
    pub eager: bool,
    /// Kimochi's own panels draw their own title bars; a hosted third-party page
    /// (Yomitan settings) keeps the system frame.
    pub decorated: bool,
    /// Embedded asset injected at document start, for all frames. Resolved through
    /// Tauri's asset resolver at creation time, so this crate does not have to
    /// compile against a file another workstream owns.
    pub init_asset: Option<&'static str>,
}

const fn panel(
    label: &'static str,
    title: &'static str,
    url: &'static str,
    width: f64,
    height: f64,
) -> PanelSpec {
    PanelSpec {
        label,
        title,
        url,
        width,
        height,
        min_width: 320.,
        min_height: 240.,
        resizable: true,
        pinned: false,
        eager: false,
        decorated: false,
        init_asset: None,
    }
}

/// Sizes come from Electron's `panels` table so a first launch looks the same.
pub static PANELS: &[PanelSpec] = &[
    PanelSpec {
        min_width: 410.,
        // The controller is fixed-width and sizes to its menu rows.
        min_height: 28.,
        resizable: false,
        pinned: true,
        eager: true,
        ..panel("controller", "Kimochi", PANEL_PAGE, 410., 150.)
    },
    PanelSpec {
        pinned: true,
        eager: true,
        // The Log runs the original Yomitan frontend over its scanned text. That
        // frontend builds a real `Popup`, whose iframe navigates to the extension's
        // own `popup.html`; the `Display` inside it needs `chrome.*` from its very
        // first script. Importing the shim from the page only reaches the top frame,
        // so without this the popup frame throws, the FrameClient handshake never
        // completes, and lookup fails silently while the window still reports the
        // backend as reachable.
        init_asset: Some("/spike/panel-shim.js"),
        ..panel("log", "Log", PANEL_PAGE, 720., 440.)
    },
    // Crop editing lives inside the picker (`open_source_picker({editCurrent:true})`),
    // so there is no separate crop window as there was in Electron.
    // Compact: a three-column tile grid and a crop preview. It opens beside the
    // controller (see `place_source_picker`), so it must not dwarf it.
    PanelSpec {
        min_width: 440.,
        min_height: 400.,
        ..panel(
            "source-picker",
            "Select Source",
            "app/source-picker.html",
            520.,
            560.,
        )
    },
    PanelSpec {
        min_width: 820.,
        min_height: 560.,
        ..panel("settings", "Settings", PANEL_PAGE, 1000., 760.)
    },
    PanelSpec {
        min_width: 600.,
        min_height: 440.,
        ..panel("notebook", "Notebook", PANEL_PAGE, 820., 700.)
    },
    panel("capture", "Capture Preview", PANEL_PAGE, 480., 420.),
    panel("debug", "Debug Info", PANEL_PAGE, 380., 620.),
    panel("stream", "Capture Debug", PANEL_PAGE, 640., 740.),
    panel(
        "welcome",
        "Welcome to Kimochi",
        "app/welcome.html",
        800.,
        640.,
    ),
    PanelSpec {
        resizable: false,
        // The width is also what `tray.rs` centres under the tray icon, so the minimum must
        // not exceed it or the popover sits off-centre.
        min_width: 280.,
        ..panel(
            "tray-popover",
            "Kimochi",
            "app/tray-popover.html",
            280.,
            460.,
        )
    },
    PanelSpec {
        // The real distributed Yomitan settings page, in its own native window like
        // Electron's `createYomitanWindow`, framed by Kimochi's own panel chrome: the
        // React panel draws the title bar and loads `/settings.html` in an iframe.
        // Every frame gets the panel shim (as in the Log), never the overlay's
        // backend-hosting `host/shim.js`: a second backend on the same IndexedDB is
        // the one thing that must not happen.
        min_width: 720.,
        min_height: 480.,
        init_asset: Some("/spike/panel-shim.js"),
        ..panel("yomitan", "Yomitan settings", PANEL_PAGE, 960., 680.)
    },
    // The POC's `ui/sources.html` is deliberately NOT registered. Its file is kept for
    // history, but there is exactly one source UX now — `source-picker` — and offering
    // the old screen as a second, stale path would be worse than removing it.
    PanelSpec {
        eager: true,
        ..panel(
            "fixture",
            "Kimochi Japanese Fixture",
            "ui/fixture.html",
            640.,
            400.,
        )
    },
];

pub fn spec(label: &str) -> Option<&'static PanelSpec> {
    PANELS.iter().find(|p| p.label == label)
}

fn saved_bounds(settings: &Settings, spec: &PanelSpec) -> Rect {
    let key = format!("nativeWindowBounds.{}", spec.label);
    let saved: Option<Rect> = settings
        .get(&key)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok());
    let mut rect = match saved {
        // The controller's width is owned by the spec, never by a stale saved value.
        Some(mut rect) if spec.label == "controller" => {
            rect.width = spec.width;
            rect
        }
        Some(rect) => rect,
        None => {
            let area = native::display_infos()
                .first()
                .map(|d| d.work_area)
                .unwrap_or(Rect {
                    x: 0.,
                    y: 0.,
                    width: spec.width,
                    height: spec.height,
                });
            Rect {
                x: area.x
                    + if spec.label == "controller" {
                        40.
                    } else {
                        260.
                    },
                y: area.y + 40.,
                width: spec.width,
                height: spec.height,
            }
        }
    };
    // Tauri's minimum constrains later user resizes, but does not repair a smaller
    // frame restored from settings. Apply the current spec before display clamping.
    rect.width = rect.width.max(spec.min_width);
    rect.height = rect.height.max(spec.min_height);
    native::clamp_to_visible(rect)
}

fn pinned_default(settings: &Settings, spec: &PanelSpec) -> bool {
    settings.get_or(&format!("nativeWindowPinned.{}", spec.label), spec.pinned)
}

/// Returns the window, creating it on first use. Panels are hidden when created;
/// `show` is a separate action, matching Electron's create-then-sync flow.
/// Frame-id bands, one per window that runs the original extension.
///
/// Yomitan addresses a frame by a bare number — `crossFrame.invoke(frameId, ...)` —
/// with the tab implied. That is fine inside one browser tab and useless across
/// native windows, where every window would otherwise start numbering at zero and
/// "frame 0" would name three different documents. Giving each window a band makes a
/// frame id name exactly one frame on the whole desktop, so the bridge can route it.
///
/// The overlay is deliberately absent: it hosts the real backend with its own
/// numbering, and it is a popup *client* at most, never addressed by id from outside.
pub const FRAME_BANDS: &[(&str, u32)] = &[("log", 1000), ("yomitan", 2000), ("popup-host", 3000)];

pub const FRAME_BAND_SIZE: u32 = 1000;

/// Windows whose dictionary popup is rendered in the popup window instead of inside
/// themselves.
///
/// The Log is the case this exists for: its popup was clipped to a 720-point-wide
/// window, and a nested lookup was pinned flat against its top edge. The Yomitan
/// settings page is deliberately absent — its popup preview is *meant* to be inside
/// the page it is previewing.
fn popup_host_for(label: &str) -> Option<&'static str> {
    matches!(label, "log").then_some("popup-host")
}

/// Publishes what the extension host has to know before it evaluates.
///
/// The host derives this window's tab identity from the label, and its frame numbering
/// from the band, and it does so while it is evaluating. A page that sets those itself
/// is already too late for an injected host, and every panel shares one URL — so
/// without this every window would fall back to the same pathname and collide.
/// Emitting it for subframes too keeps a popup frame on its opener's identity.
pub fn label_prelude(label: &str) -> String {
    let bands: Vec<_> = FRAME_BANDS.iter().map(|(l, b)| (*l, *b)).collect();
    format!(
        ";(function(){{try{{\
window.__kimochiPanelLabel={};\
window.__kimochiFrameBase={};\
window.__kimochiFrameBands={};\
window.__kimochiFrameBandSize={};\
window.__kimochiPopupHost={};\
}}catch(e){{}}}})();\n",
        serde_json::to_string(label).unwrap_or_else(|_| "\"panel\"".into()),
        frame_base(label),
        serde_json::to_string(
            &bands
                .into_iter()
                .collect::<std::collections::BTreeMap<_, _>>()
        )
        .unwrap_or_else(|_| "{}".into()),
        FRAME_BAND_SIZE,
        serde_json::to_string(&popup_host_for(label)).unwrap_or_else(|_| "null".into()),
    )
}

/// The first frame id this window may use. Zero for windows outside the bridge.
pub fn frame_base(label: &str) -> u32 {
    FRAME_BANDS
        .iter()
        .find(|(l, _)| *l == label)
        .map_or(0, |(_, base)| *base)
}

pub fn ensure(
    app: &tauri::AppHandle,
    settings: &Arc<Settings>,
    label: &str,
) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(label) {
        return Ok(window);
    }
    let spec = spec(label).ok_or_else(|| format!("invalid: unknown panel {label:?}"))?;
    let bounds = saved_bounds(settings, spec);
    let pinned = pinned_default(settings, spec);
    // Deliberately never sets a data store identifier: every webview must share one
    // WKWebsiteDataStore so `tauri://localhost` resolves to the same IndexedDB in
    // every window. A per-window store would silently split the Yomitan dictionary
    // database between the overlay's backend and the settings window.
    let mut builder =
        tauri::WebviewWindowBuilder::new(app, spec.label, tauri::WebviewUrl::App(spec.url.into()))
            .title(spec.title)
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
            .inner_size(spec.width, spec.height)
            .min_inner_size(spec.min_width, spec.min_height)
            .decorations(spec.decorated)
            .background_color(tauri::window::Color(0x19, 0x19, 0x19, 0xff))
            // Deliver the activating click to the WKWebView too, including the header
            // mousedown that starts a native window drag.
            .accept_first_mouse(true)
            .resizable(spec.resizable)
            .maximizable(spec.resizable)
            .always_on_top(pinned)
            .visible(false);
    if let Some(path) = spec.init_asset {
        let asset = app.asset_resolver().get(path.into()).ok_or_else(|| {
            format!(
                "invalid: {} needs {path}, which is not in the bundle",
                spec.label
            )
        })?;
        let script = String::from_utf8(asset.bytes)
            .map_err(|_| format!("invalid: {path} is not valid UTF-8"))?;
        builder = builder.initialization_script_for_all_frames(label_prelude(spec.label) + &script);
    }
    let window = builder.build().map_err(|e| format!("native: {e}"))?;
    // Keep Kimochi's own panels out of captures of the display they sit on, where the
    // OS honours it. This is the same mechanism as Electron's setContentProtection.
    let _ = window.set_content_protected(true);
    native::place(&window, bounds)?;
    attach_events(app, settings, &window, spec);
    Ok(window)
}

fn attach_events(
    app: &tauri::AppHandle,
    settings: &Arc<Settings>,
    window: &WebviewWindow,
    spec: &'static PanelSpec,
) {
    let handle = app.clone();
    let store = settings.clone();
    let owned = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            save_bounds(&store, &owned, spec);
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // Closing hides; only Quit exits. Reopening restores native bounds.
            api.prevent_close();
            save_bounds(&store, &owned, spec);
            let _ = owned.hide();
            let _ = handle.emit("panel:closed", json!({ "label": spec.label }));
        }
        _ => {}
    });
}

fn save_bounds(settings: &Arc<Settings>, window: &WebviewWindow, spec: &PanelSpec) {
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    if let Ok(rect) = native::bounds(window) {
        let _ = settings.set(
            &format!("nativeWindowBounds.{}", spec.label),
            json!({"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height}),
        );
    }
}

pub fn info(window: &WebviewWindow) -> Result<Value, String> {
    Ok(json!({
        "label": window.label(),
        "native": native::inspect(window)?,
        "bounds": native::bounds(window)?,
        "scale": window.scale_factor().map_err(|e| e.to_string())?,
        "pinned": window.is_always_on_top().map_err(|e| e.to_string())?,
        "focused": window.is_focused().map_err(|e| e.to_string())?,
        "resizable": window.is_resizable().map_err(|e| e.to_string())?,
        "visible": window.is_visible().map_err(|e| e.to_string())?,
    }))
}

pub fn act(
    app: &tauri::AppHandle,
    settings: &Arc<Settings>,
    label: &str,
    action: &str,
    rect: Option<Rect>,
) -> Result<Value, String> {
    let existed = app.get_webview_window(label).is_some();
    let window = ensure(app, settings, label)?;
    let native_err = |e: tauri::Error| format!("native: {e}");
    match action {
        "show" => {
            if label == SOURCE_PICKER && !window.is_visible().unwrap_or(false) {
                place_source_picker(app, &window, existed)?;
            }
            if label == YOMITAN && !window.is_visible().unwrap_or(false) {
                place_on_controller_display(app, &window, existed, YOMITAN)?;
            }
            window.show().map_err(native_err)?;
            window.set_focus().map_err(native_err)?;
        }
        // Passive updates must never steal focus from the source application.
        "show_inactive" => window.show().map_err(native_err)?,
        "hide" => window.hide().map_err(native_err)?,
        "drag" => window.start_dragging().map_err(native_err)?,
        "place" => {
            let rect = rect.ok_or("invalid: place requires bounds")?;
            native::place(&window, native::clamp_to_visible(rect))?;
            // Reassert the flag: programmatic placement has been observed to turn
            // resizing back on for windows that must stay fixed.
            let resizable = spec(label).is_some_and(|s| s.resizable);
            window.set_resizable(resizable).map_err(native_err)?;
            save_bounds(settings, &window, spec(label).unwrap());
        }
        "minimize" => window.minimize().map_err(native_err)?,
        "restore" => {
            window.unminimize().map_err(native_err)?;
            window.show().map_err(native_err)?;
        }
        "pin" | "unpin" => {
            let pinned = action == "pin";
            window.set_always_on_top(pinned).map_err(native_err)?;
            settings.set(&format!("nativeWindowPinned.{label}"), json!(pinned))?;
        }
        "inspect" => {}
        _ => return Err(format!("invalid: unknown window action {action:?}")),
    }
    let state = info(&window)?;
    if action != "inspect" {
        let _ = app.emit(
            "panel:state",
            json!({
                "label": label,
                "visible": state["visible"],
                "pinned": state["pinned"],
                "bounds": state["bounds"],
            }),
        );
    }
    Ok(state)
}

const SOURCE_PICKER: &str = "source-picker";
/// Space between the controller and the source picker that pops out beside it.
const PICKER_GAP: f64 = 8.;

/// Positions the source picker as it opens, from every path (controller, tray
/// popover, app menu):
///
/// - controller on screen: beside it, on the side with room (right first), top-aligned
///   with it, on the controller's display;
/// - otherwise: centred on the display under the cursor.
///
/// Either way the frame is kept inside that display's work area. A picker the user
/// has resized this session keeps its size; a newly created one uses the compact
/// spec size rather than a larger frame restored from an older build.
fn place_source_picker(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    existed: bool,
) -> Result<(), String> {
    let spec = spec(SOURCE_PICKER).ok_or("invalid: source picker spec")?;
    let (width, height) = match native::bounds(window) {
        Ok(current) if existed => (current.width, current.height),
        _ => (spec.width, spec.height),
    };
    let displays = native::display_infos();
    let controller = app
        .get_webview_window("controller")
        .filter(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .and_then(|w| native::bounds(&w).ok());
    let rect = if let Some(anchor) = controller {
        let (cx, cy) = (anchor.x + anchor.width / 2., anchor.y + anchor.height / 2.);
        let Some(area) = work_area_at(&displays, cx, cy) else {
            return Ok(());
        };
        beside(anchor, width, height, area, PICKER_GAP)
    } else {
        let (x, y) = native::cursor().map_or((0., 0.), |(x, y, _, _)| (x, y));
        let Some(area) = work_area_at(&displays, x, y) else {
            return Ok(());
        };
        centred(width, height, area)
    };
    native::place(window, rect)
}

const YOMITAN: &str = "yomitan";

/// Centres a large panel (Yomitan settings) on the display the controller is on, or
/// the display under the cursor when the controller is hidden, clamped to its work
/// area. As with the picker, a window resized this session keeps its size and a new
/// one starts at the spec size, not a frame restored from an older build.
fn place_on_controller_display(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    existed: bool,
    label: &str,
) -> Result<(), String> {
    let spec = spec(label).ok_or("invalid: unknown panel spec")?;
    let (width, height) = match native::bounds(window) {
        Ok(current) if existed => (current.width, current.height),
        _ => (spec.width, spec.height),
    };
    let displays = native::display_infos();
    let (x, y) = app
        .get_webview_window("controller")
        .filter(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .and_then(|w| native::bounds(&w).ok())
        .map(|r| (r.x + r.width / 2., r.y + r.height / 2.))
        .or_else(|| native::cursor().map(|(x, y, _, _)| (x, y)))
        .unwrap_or((0., 0.));
    let Some(area) = work_area_at(&displays, x, y) else {
        return Ok(());
    };
    native::place(window, centred(width, height, area))
}

/// The work area of the display containing a desktop point (top-left points), or the
/// nearest display when the point is in a gap between them.
fn work_area_at(displays: &[native::DisplayInfo], x: f64, y: f64) -> Option<Rect> {
    let distance = |r: &Rect| {
        let dx = (r.x - x).max(0.).max(x - (r.x + r.width));
        let dy = (r.y - y).max(0.).max(y - (r.y + r.height));
        dx * dx + dy * dy
    };
    displays
        .iter()
        .min_by(|a, b| {
            distance(&a.bounds)
                .partial_cmp(&distance(&b.bounds))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|d| d.work_area)
}

/// A `width` × `height` frame next to `anchor`: to its right when that fits in
/// `area`, else to its left, else against whichever edge has more room. Top-aligned
/// with the anchor and clamped vertically, so it is never clipped.
fn beside(anchor: Rect, width: f64, height: f64, area: Rect, gap: f64) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    let right = anchor.x + anchor.width + gap;
    let room_right = area.x + area.width - right;
    let room_left = anchor.x - gap - area.x;
    let x = if room_right >= width {
        right
    } else if room_left >= width {
        anchor.x - gap - width
    } else if room_right >= room_left {
        area.x + area.width - width
    } else {
        area.x
    };
    let y = anchor.y.max(area.y).min(area.y + area.height - height);
    Rect {
        x,
        y,
        width,
        height,
    }
}

fn centred(width: f64, height: f64, area: Rect) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    Rect {
        x: (area.x + (area.width - width) / 2.).round(),
        y: (area.y + (area.height - height) / 2.).round(),
        width,
        height,
    }
}

/// The controller is fixed-width and grows to fit its menu rows.
pub fn set_content_height(
    app: &tauri::AppHandle,
    settings: &Arc<Settings>,
    label: &str,
    height: f64,
) -> Result<(), String> {
    let spec = spec(label).ok_or_else(|| format!("invalid: unknown panel {label:?}"))?;
    if spec.resizable || !height.is_finite() {
        return Ok(());
    }
    let window = ensure(app, settings, label)?;
    let current = native::bounds(&window)?;
    let next = native::clamp_to_visible(Rect {
        width: spec.width,
        height: height.max(spec.min_height).ceil(),
        ..current
    });
    if (next.width - current.width).abs() > 0.5
        || (next.height - current.height).abs() > 0.5
        || (next.y - current.y).abs() > 0.5
    {
        native::place(&window, next)?;
    }
    Ok(())
}

/// Pull every open panel back onto a live display. Called when the display layout
/// changes, so unplugging a monitor cannot leave a window unreachable.
pub fn recover_bounds(app: &tauri::AppHandle, settings: &Arc<Settings>) {
    for spec in PANELS {
        let Some(window) = app.get_webview_window(spec.label) else {
            continue;
        };
        if window.is_minimized().unwrap_or(false) {
            continue;
        }
        if let Ok(rect) = native::bounds(&window) {
            let clamped = native::clamp_to_visible(rect);
            if (clamped.x - rect.x).abs() > 0.5 || (clamped.y - rect.y).abs() > 0.5 {
                let _ = native::place(&window, clamped);
                save_bounds(settings, &window, spec);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect {
        x: 0.,
        y: 25.,
        width: 1440.,
        height: 875.,
    };
    const fn at(x: f64, y: f64) -> Rect {
        Rect {
            x,
            y,
            width: 410.,
            height: 150.,
        }
    }

    #[test]
    fn source_picker_opens_to_the_right_of_the_controller_when_it_fits() {
        let r = beside(at(40., 65.), 520., 560., AREA, 8.);
        assert_eq!((r.x, r.y, r.width, r.height), (458., 65., 520., 560.));
    }

    #[test]
    fn source_picker_flips_left_near_the_right_edge() {
        let r = beside(at(1000., 65.), 520., 560., AREA, 8.);
        assert_eq!((r.x, r.y), (472., 65.));
    }

    #[test]
    fn source_picker_is_clamped_to_the_work_area() {
        // Low on the display: top-aligned would clip, so it moves up.
        let r = beside(at(40., 800.), 520., 560., AREA, 8.);
        assert_eq!(r.y, AREA.y + AREA.height - 560.);
        // No room either side: pinned to the edge with more room, still inside.
        let narrow = Rect {
            width: 800.,
            ..AREA
        };
        let r = beside(at(100., 65.), 520., 560., narrow, 8.);
        assert_eq!(r.x, 800. - 520.);
        // A display on the left of the primary (negative x) works the same way.
        let left = Rect { x: -1440., ..AREA };
        let r = beside(at(-1400., 65.), 520., 560., left, 8.);
        assert_eq!(r.x, -1400. + 410. + 8.);
    }

    #[test]
    fn source_picker_centres_without_a_controller_and_fits_small_displays() {
        let r = centred(520., 560., AREA);
        assert_eq!((r.x, r.y), (460., 183.));
        let tiny = Rect {
            width: 400.,
            height: 300.,
            ..AREA
        };
        let r = centred(520., 560., tiny);
        assert_eq!((r.x, r.y, r.width, r.height), (0., 25., 400., 300.));
    }

    #[test]
    fn electron_pin_defaults_are_preserved() {
        assert!(spec("controller").unwrap().pinned);
        assert!(spec("log").unwrap().pinned);
        assert!(!spec("settings").unwrap().pinned);
        assert!(!spec("notebook").unwrap().pinned);
        assert!(!spec("source-picker").unwrap().pinned);
    }

    #[test]
    fn settings_and_notebook_have_content_sized_defaults_and_minimums() {
        let settings = spec("settings").unwrap();
        assert_eq!((settings.width, settings.height), (1000., 760.));
        assert_eq!((settings.min_width, settings.min_height), (820., 560.));

        let notebook = spec("notebook").unwrap();
        assert_eq!((notebook.width, notebook.height), (820., 700.));
        assert_eq!((notebook.min_width, notebook.min_height), (600., 440.));
        assert!(!notebook.eager, "Notebook should be created only when opened");
    }

    #[test]
    fn only_the_controller_and_popover_are_fixed_size() {
        for spec in PANELS {
            let expected = !matches!(spec.label, "controller" | "tray-popover");
            assert_eq!(spec.resizable, expected, "{} resizable", spec.label);
        }
    }

    #[test]
    fn react_panels_do_not_collide_with_yomitan_paths() {
        // Yomitan owns the dist root, so our own pages must stay under a prefix. The
        // `yomitan` window is a panel too; it loads Yomitan's settings page (at its real
        // path) in an iframe.
        for spec in PANELS {
            assert!(
                spec.url.starts_with("ui/") || spec.url.starts_with("app/"),
                "{} escapes its prefix: {}",
                spec.label,
                spec.url
            );
        }
    }

    #[test]
    fn panels_draw_their_own_frame_and_only_extension_hosts_get_a_shim() {
        for spec in PANELS {
            assert!(!spec.decorated, "{} should use Kimochi's own chrome", spec.label);
            // Exactly the windows that run the original extension in a subframe.
            assert_eq!(
                spec.init_asset.is_some(),
                matches!(spec.label, "yomitan" | "log"),
                "{}",
                spec.label
            );
        }
    }
}
