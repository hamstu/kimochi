//! Native window lifecycle, pinning, placement and bounds recovery.
//! Mirrors the semantics of the Electron build's `src/main/native-windows.ts`.
use crate::platform;
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
    #[cfg(target_os = "linux")]
    PanelSpec {pinned:true,min_width:1.,min_height:1.,resizable:false,
        ..panel("controller-host", "Kimochi · controller-host", "ui/gnome-controller-host.html", 520., 520.)},
    #[cfg(target_os = "linux")]
    PanelSpec {
        pinned: true,
        min_width: 1., min_height: 1.,
        ..panel("crop-host", "Kimochi · crop-host", "ui/gnome-crop-host.html", 640., 480.)
    },
    // The main window: the Log, with the Controller's rows as a collapsible sidebar and the
    // Notebook as a second view. It keeps the `log` label because that label is also its
    // texthooker ownership, its Yomitan frame band and its popup host.
    PanelSpec {
        pinned: true,
        eager: true,
        min_width: 480.,
        min_height: 280.,
        // The Log runs the original Yomitan frontend over its scanned text. That
        // frontend builds a real `Popup`, whose iframe navigates to the extension's
        // own `popup.html`; the `Display` inside it needs `chrome.*` from its very
        // first script. Importing the shim from the page only reaches the top frame,
        // so without this the popup frame throws, the FrameClient handshake never
        // completes, and lookup fails silently while the window still reports the
        // backend as reachable.
        init_asset: Some("/spike/panel-shim.js"),
        ..panel("log", "Kimochi", PANEL_PAGE, 900., 560.)
    },
    PanelSpec {
        min_width: 820.,
        min_height: 560.,
        ..panel("settings", "Settings", PANEL_PAGE, 1000., 760.)
    },
    // Capture preview, debug info and the capture debugger, one tab each.
    PanelSpec {
        min_width: 480.,
        min_height: 420.,
        ..panel("diagnostics", "Diagnostics", PANEL_PAGE, 680., 720.)
    },
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
    // The POC's `ui/sources.html` is deliberately NOT registered: sources are chosen in the
    // main window's sidebar, and offering the old screen as a second, stale path would be
    // worse than removing it.
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
    // Japanese with a small gap between each stem and its ending, so cloud OCR returns
    // the halves of a word as separate chunks: the source for checking that a lookup
    // in ungrouped words mode still runs on into the next chunk. Opened from the menu.
    panel(
        "fixture-chunks",
        "Kimochi Split-Word Fixture",
        "ui/fixture-chunks.html",
        760.,
        560.,
    ),
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
        Some(rect) => rect,
        None => {
            let area = platform::desktop_display_infos()
                .first()
                .map(|d| d.work_area)
                .unwrap_or(Rect {
                    x: 0.,
                    y: 0.,
                    width: spec.width,
                    height: spec.height,
                });
            Rect {
                x: area.x + if spec.label == MAIN { 40. } else { 260. },
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
    platform::clamp_to_visible(rect)
}

fn pinned_default(settings: &Settings, spec: &PanelSpec) -> bool {
    settings.get_or(&format!("nativeWindowPinned.{}", spec.label), spec.pinned)
}

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

/// Proof that the holder runs in a main-thread event-loop turn of its own (or in `setup`),
/// never inside a synchronous command or an event callback. Only this module makes one, and
/// creating a window takes one, so the compiler keeps window creation off the paths where
/// WebView2 deadlocks.
///
/// Tauri documents that building a webview window from a synchronous command or event
/// handler deadlocks on Windows: WebView2 finishes creating a controller by pumping messages,
/// which cannot happen while the IPC (or event) callback that asked for it is still on the
/// stack. A job enqueued with `run_on_main_thread` runs from a later loop turn, after that
/// callback returned, which is also exactly where Tauri itself builds a window requested from
/// another thread.
pub struct MainTurn(());

/// How a request that may need to create `label` has to run.
#[derive(Debug, PartialEq, Eq)]
enum Dispatch {
    /// Nothing will be created: run in the caller's own turn, as before.
    Inline,
    /// Creation is needed: run in a later main-thread turn.
    Deferred,
}

fn dispatch_for(is_panel: bool, exists: bool) -> Dispatch {
    if is_panel && !exists {
        Dispatch::Deferred
    } else {
        Dispatch::Inline
    }
}

/// Runs `job` with `label` ready, from an event callback (tray, menu, single instance).
///
/// When the panel already exists nothing is created, so the job runs inline exactly as it
/// always has. Otherwise it is enqueued on the main thread and runs once the callback returns.
pub fn with_panel(
    app: &tauri::AppHandle,
    label: &str,
    job: impl FnOnce(&tauri::AppHandle, &MainTurn) + Send + 'static,
) {
    let exists = app.get_webview_window(label).is_some();
    match dispatch_for(spec(label).is_some(), exists) {
        Dispatch::Inline => job(app, &MainTurn(())),
        Dispatch::Deferred => {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || job(&handle, &MainTurn(())));
        }
    }
}

/// Runs `job` on the main thread in its own loop turn and returns its result. This is the
/// path for async commands: they run on a Tokio worker, the job then gets the main thread
/// that the platform helpers (direct AppKit calls) and window creation need.
pub async fn on_main_turn<T: Send + 'static>(
    app: &tauri::AppHandle,
    job: impl FnOnce(&tauri::AppHandle, &MainTurn) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let handle = app.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(job(&handle, &MainTurn(())));
    })
    .map_err(|e| format!("native: {e}"))?;
    rx.await.map_err(|e| format!("native: {e}"))?
}

/// `act` from an async command.
pub async fn act_async(
    app: &tauri::AppHandle,
    settings: &Arc<Settings>,
    label: String,
    action: String,
    rect: Option<Rect>,
) -> Result<Value, String> {
    let store = settings.clone();
    on_main_turn(app, move |app, turn| act(turn, app, &store, &label, &action, rect)).await
}

/// `set_content_height` from an async command.
pub async fn set_content_height_async(
    app: &tauri::AppHandle,
    settings: &Arc<Settings>,
    label: String,
    height: f64,
) -> Result<(), String> {
    let store = settings.clone();
    on_main_turn(app, move |app, turn| {
        set_content_height(turn, app, &store, &label, height)
    })
    .await
}

/// Builds the panels marked `eager`. For `setup` only, which runs before the event loop and
/// outside any command or callback.
pub fn create_eager(app: &tauri::AppHandle, settings: &Arc<Settings>) -> Result<(), String> {
    let turn = MainTurn(());
    for spec in PANELS.iter().filter(|spec| spec.eager) {
        ensure(&turn, app, settings, spec.label)?;
    }
    Ok(())
}

/// Returns the window, creating it on first use. Panels are hidden when created;
/// `show` is a separate action, matching Electron's create-then-sync flow. Creation needs a
/// `MainTurn`; see there for why.
fn ensure(
    _turn: &MainTurn,
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
            .visible(false)
            .initialization_script_for_all_frames(platform::platform_prelude());
    #[cfg(target_os = "linux")]
    if matches!(spec.label, "crop-host" | "controller-host") {
        if !crate::platform::gnome::eligible_popup_session() {
            return Err("GNOME crop host requires supported GNOME Wayland".into());
        }
        builder = builder.transparent(true).background_color(tauri::window::Color(0, 0, 0, 0)).skip_taskbar(true);
    }
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
    platform::desktop_place(&window, bounds)?;
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
        tauri::WindowEvent::CloseRequested { api, .. } if spec.label == MAIN => {
            // The main window is the app: closing it quits, like any single-window Mac app.
            api.prevent_close();
            save_bounds(&store, &owned, spec);
            handle.exit(0);
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // Closing hides; only the main window quits. Reopening restores native bounds.
            api.prevent_close();
            save_bounds(&store, &owned, spec);
            // A hidden Settings window can no longer finish recording a shortcut.
            crate::hotkeys::resume(&handle, &store);
            #[cfg(target_os = "linux")]
            let _ = platform::gamescope::hide(&owned);
            #[cfg(not(target_os = "linux"))]
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
    if let Ok(rect) = platform::desktop_bounds(window) {
        let _ = settings.set(
            &format!("nativeWindowBounds.{}", spec.label),
            json!({"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height}),
        );
    }
}

pub fn info(window: &WebviewWindow) -> Result<Value, String> {
    Ok(json!({
        "label": window.label(),
        "native": platform::inspect(window)?,
        "bounds": platform::desktop_bounds(window)?,
        "scale": window.scale_factor().map_err(|e| e.to_string())?,
        "pinned": window.is_always_on_top().map_err(|e| e.to_string())?,
        "focused": window.is_focused().map_err(|e| e.to_string())?,
        "resizable": window.is_resizable().map_err(|e| e.to_string())?,
        "visible": window.is_visible().map_err(|e| e.to_string())?,
    }))
}

/// Applies a window action, creating the panel first if it is not built yet.
pub fn act(
    turn: &MainTurn,
    app: &tauri::AppHandle,
    settings: &Arc<Settings>,
    label: &str,
    action: &str,
    rect: Option<Rect>,
) -> Result<Value, String> {
    let existed = app.get_webview_window(label).is_some();
    let window = ensure(turn, app, settings, label)?;
    apply(app, settings, &window, existed, label, action, rect)
}

/// Applies a window action to a panel that must already exist, and never creates one. For
/// synchronous commands and event callbacks that address an eager window (the main window
/// is built in `setup` and is never destroyed: closing it quits).
pub fn act_existing(
    app: &tauri::AppHandle,
    settings: &Arc<Settings>,
    label: &str,
    action: &str,
    rect: Option<Rect>,
) -> Result<Value, String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("native: {label} window is not open yet"))?;
    apply(app, settings, &window, true, label, action, rect)
}

fn apply(
    app: &tauri::AppHandle,
    settings: &Arc<Settings>,
    window: &WebviewWindow,
    existed: bool,
    label: &str,
    action: &str,
    rect: Option<Rect>,
) -> Result<Value, String> {
    let native_err = |e: tauri::Error| format!("native: {e}");
    match action {
        #[cfg(target_os = "linux")]
        "hide" if platform::gamescope::handles(window) => platform::gamescope::hide(window)?,
        #[cfg(target_os = "linux")]
        "show" | "show_inactive" if platform::gamescope::handles(window) => platform::gamescope::show(window)?,
        "show" => {
            if label == YOMITAN && !window.is_visible().unwrap_or(false) {
                place_on_main_display(app, window, existed, YOMITAN)?;
            }
            window.show().map_err(native_err)?;
            window.set_focus().map_err(native_err)?;
        }
        // Passive updates must never steal focus from the source application.
        "show_inactive" => window.show().map_err(native_err)?,
        "hide" => window.hide().map_err(native_err)?,
        #[cfg(target_os = "linux")]
        "drag" if platform::gamescope::handles(window) => {},
        "drag" => window.start_dragging().map_err(native_err)?,
        "place" => {
            let rect = rect.ok_or("invalid: place requires bounds")?;
            platform::desktop_place(window, platform::clamp_to_visible(rect))?;
            // Reassert the flag: programmatic placement has been observed to turn
            // resizing back on for windows that must stay fixed.
            let resizable = spec(label).is_some_and(|s| s.resizable);
            window.set_resizable(resizable).map_err(native_err)?;
            save_bounds(settings, window, spec(label).unwrap());
        }
        #[cfg(target_os = "linux")]
        "minimize" if platform::gamescope::handles(window) => platform::gamescope::hide(window)?,
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
    let mut state = info(window)?;
    #[cfg(target_os = "linux")]
    if platform::gamescope::handles(window) {
        state["visible"] = json!(platform::gamescope::is_visible(window));
    }
    // `is_always_on_top` reads back the old level until AppKit has applied the new one, so
    // report what was asked for; otherwise the pin button shows the previous state.
    if action == "pin" || action == "unpin" {
        state["pinned"] = json!(action == "pin");
    }
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

/// The main window (the Log with its Controller sidebar).
pub const MAIN: &str = "log";
const YOMITAN: &str = "yomitan";

/// Centres a large panel (Yomitan settings) on the display the main window is on, or
/// the display under the cursor when it is hidden, clamped to its work
/// area. A window resized this session keeps its size and a new
/// one starts at the spec size, not a frame restored from an older build.
fn place_on_main_display(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    existed: bool,
    label: &str,
) -> Result<(), String> {
    let spec = spec(label).ok_or("invalid: unknown panel spec")?;
    let (width, height) = match platform::desktop_bounds(window) {
        Ok(current) if existed => (current.width, current.height),
        _ => (spec.width, spec.height),
    };
    let displays = platform::desktop_display_infos();
    let (x, y) = app
        .get_webview_window(MAIN)
        .filter(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .and_then(|w| platform::desktop_bounds(&w).ok())
        .map(|r| (r.x + r.width / 2., r.y + r.height / 2.))
        .or_else(|| platform::desktop_cursor().map(|p| (p.x, p.y)))
        .unwrap_or((0., 0.));
    let Some(area) = work_area_at(&displays, x, y) else {
        return Ok(());
    };
    platform::desktop_place(window, centred(width, height, area))
}

/// The work area of the display containing a desktop point (top-left points), or the
/// nearest display when the point is in a gap between them.
fn work_area_at(displays: &[platform::DisplayInfo], x: f64, y: f64) -> Option<Rect> {
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

/// A fixed-size panel (the tray popover) grows to fit its rows.
fn set_content_height(
    turn: &MainTurn,
    app: &tauri::AppHandle,
    settings: &Arc<Settings>,
    label: &str,
    height: f64,
) -> Result<(), String> {
    let spec = spec(label).ok_or_else(|| format!("invalid: unknown panel {label:?}"))?;
    if spec.resizable || !height.is_finite() {
        return Ok(());
    }
    let window = ensure(turn, app, settings, label)?;
    let current = platform::desktop_bounds(&window)?;
    let next = platform::clamp_to_visible(Rect {
        width: spec.width,
        height: height.max(spec.min_height).ceil(),
        ..current
    });
    if (next.width - current.width).abs() > 0.5
        || (next.height - current.height).abs() > 0.5
        || (next.y - current.y).abs() > 0.5
    {
        platform::desktop_place(&window, next)?;
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
        if let Ok(rect) = platform::desktop_bounds(&window) {
            let clamped = platform::clamp_to_visible(rect);
            if (clamped.x - rect.x).abs() > 0.5 || (clamped.y - rect.y).abs() > 0.5 {
                let _ = platform::desktop_place(&window, clamped);
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
    fn a_large_panel_centres_on_its_display_and_fits_small_displays() {
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
    fn only_a_missing_panel_defers_to_a_later_main_thread_turn() {
        // An existing window is acted on in the caller's turn, exactly as before; only a
        // panel that has to be built waits for the callback to return.
        assert_eq!(dispatch_for(true, true), Dispatch::Inline);
        assert_eq!(dispatch_for(true, false), Dispatch::Deferred);
        // Not a panel (the overlay, or an unknown label): nothing to create, so `act`
        // answers (or errors) immediately.
        assert_eq!(dispatch_for(false, true), Dispatch::Inline);
        assert_eq!(dispatch_for(false, false), Dispatch::Inline);
    }

    #[test]
    fn electron_pin_defaults_are_preserved() {
        assert!(spec("log").unwrap().pinned);
        assert!(!spec("settings").unwrap().pinned);
        assert!(!spec("diagnostics").unwrap().pinned);
    }

    #[test]
    fn settings_and_main_have_content_sized_defaults_and_minimums() {
        let settings = spec("settings").unwrap();
        assert_eq!((settings.width, settings.height), (1000., 760.));
        assert_eq!((settings.min_width, settings.min_height), (820., 560.));

        let main = spec(MAIN).unwrap();
        assert!(main.eager, "the main window opens at launch");
        assert!(
            !spec("diagnostics").unwrap().eager,
            "Diagnostics opens only on demand"
        );
    }

    #[test]
    fn retired_windows_are_gone() {
        for label in ["controller", "notebook", "capture", "debug", "stream"] {
            assert!(
                spec(label).is_none(),
                "{label} should be part of another window"
            );
        }
    }

    #[test]
    fn tray_and_linux_controller_hosts_are_fixed_size() {
        for spec in PANELS {
            let expected = !matches!(spec.label, "tray-popover")
                && !(cfg!(target_os = "linux") && spec.label == "controller-host");
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
            assert!(
                !spec.decorated,
                "{} should use Kimochi's own chrome",
                spec.label
            );
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
