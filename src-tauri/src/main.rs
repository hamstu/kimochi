// A release build on Windows is a GUI app: no console window behind it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod reader;
use base64::Engine;
use capture_unavailable::UnavailableBackend;

mod actions;
mod activity;
mod application_context;
mod capture_unavailable;
mod engine_probe;
mod gamepad;
mod history_merge;
mod hotkeys;
mod manga_ocr;
mod meiki_ocr;
#[cfg(target_os = "windows")]
#[path = "platform/windows/oneocr.rs"]
mod oneocr;
#[cfg(target_os = "macos")]
#[path = "platform/macos/livetext.rs"]
mod livetext;
mod model_store;
mod platform;
mod ocr_result;
mod panels;
mod scan_trace;
mod settings;
mod sources;
mod state;
mod text_observer;
mod texthooker;
mod tray;
mod watcher;

use kimochi_capture::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use settings::Settings;
use state::{
    classify_pointer, dismissed, source_focus, Image, Modifiers, PointerHistory, Region, Service,
    Shared, SourceFocus, View,
};
use std::{
    collections::HashMap,
    sync::{atomic::AtomicBool, atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};

type Reply<T> = std::result::Result<T, String>;

/// The POC's preference shape, retained so its existing UI keeps working. It is a
/// typed view over the generic settings store, not a second source of truth.
#[derive(Clone, Serialize, Deserialize)]
struct Prefs {
    endpoint: String,
    source: Option<Value>,
    crop: Option<Crop>,
    controller_pin: bool,
    log_pin: bool,
}

fn err(e: CaptureError) -> String {
    sources::err(e)
}

/// Settings-backed store for the xdg-desktop-portal ScreenCast restore token.
struct PortalTokens(Arc<Settings>);

const PORTAL_TOKEN_KEY: &str = "capture.portalRestoreToken";

impl kimochi_capture::TokenStore for PortalTokens {
    fn get(&self) -> Option<String> {
        Some(self.0.get_or::<String>(PORTAL_TOKEN_KEY, String::new())).filter(|t| !t.is_empty())
    }

    fn set(&self, token: Option<&str>) {
        let _ = self
            .0
            .set(PORTAL_TOKEN_KEY, token.map_or(Value::Null, |t| json!(t)));
    }
}

fn path(app: &tauri::AppHandle, name: &str) -> Reply<std::path::PathBuf> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.join(name))
}

fn save(app: &tauri::AppHandle, name: &str, v: &impl Serialize) -> Reply<()> {
    let p = path(app, name)?;
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(v).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(tmp, p).map_err(|e| e.to_string())
}

#[tauri::command]
fn reader_settings_patch(app: tauri::AppHandle, state: State<Shared>, patch: Value) -> Reply<()> {
    let mut patch = patch
        .as_object()
        .ok_or("invalid: expected settings object")?
        .clone();
    // Dictionary settings are authoritative; legacy reader presets cannot replace them.
    patch.remove("yomitanApiUrl");
    patch.remove("dictionaryMode");
    let value = state.settings.update_path(&["superTexthooker"], |old| {
        let mut value = old.and_then(Value::as_object).cloned().unwrap_or_default();
        value.remove("yomitanApiUrl");
        value.remove("dictionaryMode");
        value.extend(patch.clone());
        Value::Object(value)
    })?;
    app.emit(
        "settings:changed",
        json!({"key":"superTexthooker", "value":value}),
    )
    .map_err(|e| e.to_string())?;
    if let Some(pinned) = patch.get("alwaysOnTop").and_then(Value::as_bool) {
        panels::act_existing(
            &app,
            &state.settings,
            panels::MAIN,
            if pinned { "pin" } else { "unpin" },
            None,
        )?;
    }
    Ok(())
}

#[tauri::command]
fn reader_notebook_ack(
    app: tauri::AppHandle,
    state: State<Shared>,
    request_id: String,
) -> Reply<bool> {
    let matched = acknowledge_notebook_request(&state.settings, &request_id)?;
    if matched {
        app.emit(
            "settings:changed",
            json!({"key":"notebookEditRequest", "value": Value::Null}),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(matched)
}

fn acknowledge_notebook_request(settings: &Settings, request_id: &str) -> Reply<bool> {
    let mut matched = false;
    settings.update_path(&["notebookEditRequest"], |stored| {
        if stored
            .and_then(|value| value.get("requestId"))
            .and_then(Value::as_str)
            == Some(request_id)
        {
            matched = true;
            Value::Null
        } else {
            stored.cloned().unwrap_or(Value::Null)
        }
    })?;
    Ok(matched)
}

// ---------------------------------------------------------------- settings

#[tauri::command]
fn settings_get(state: State<Shared>, key: String) -> Reply<Option<Value>> {
    state.settings.get(&key)
}

#[tauri::command]
fn settings_set(
    app: tauri::AppHandle,
    state: State<Shared>,
    key: String,
    value: Value,
) -> Reply<()> {
    state.settings.set(&key, value.clone())?;
    let _ = app.emit("settings:changed", json!({ "key": key, "value": value }));
    if key.starts_with("texthookerSettings") {
        if let Some(texthooker) = app.try_state::<Arc<texthooker::Texthooker>>() {
            texthooker.settings_changed();
        }
    }
    if key.starts_with("hotkeys") {
        hotkeys::apply(&app, &state.settings);
    }
    // Choosing a local engine whose models are missing starts their download (the pickers
    // only save that choice after the user confirms the download).
    if key == "ocrMode" {
        if let Some(mode) = value.as_str() {
            model_store::on_engine_selected(&app, mode);
        }
    }
    Ok(())
}

#[tauri::command]
fn settings_all(state: State<Shared>) -> Value {
    state.settings.all()
}

// ---------------------------------------------------------------- POC compat

#[tauri::command]
fn preferences(state: State<Shared>) -> Prefs {
    let s = &state.settings;
    Prefs {
        // The resolved endpoint, so the POC UI shows what a scan will actually use.
        endpoint: settings::resolve_endpoint(s),
        source: s.get("lastSelectedSource").ok().flatten(),
        crop: current_crop(&state),
        controller_pin: s.get_or("nativeWindowPinned.controller", true),
        log_pin: s.get_or("nativeWindowPinned.log", true),
    }
}

/// Rules shared by every service URL, whoever configured it: an `http`/`https` scheme,
/// no credentials, and no query string — a query is how an API key ends up in a URL,
/// and nothing here has a reason to put one there.
fn validate_url_basics(raw: &str) -> Reply<reqwest::Url> {
    let url = reqwest::Url::parse(raw).map_err(|_| "invalid: not a URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("invalid: use an http:// or https:// URL".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("invalid: remove the credentials from the URL".into());
    }
    if url.query().is_some() {
        return Err("invalid: remove the query string from the URL".into());
    }
    if url.host_str().is_none() {
        return Err("invalid: the URL has no host".into());
    }
    Ok(url)
}

/// The OCR endpoint, which the app will call on its own schedule during auto-OCR.
/// Plain HTTP is confined to loopback so a background scan cannot ship captured pixels
/// across a network in the clear.
fn validate_service_url(raw: &str) -> Reply<reqwest::Url> {
    let url = validate_url_basics(raw)?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() == "http" && !loopback {
        return Err("invalid: use HTTPS, or HTTP on localhost".into());
    }
    Ok(url)
}

/// A dictionary API address the user typed into the Dictionary tab.
///
/// Plain HTTP to any host is allowed here, including a LAN address, which is what the
/// Electron build did. This is the user pointing the app at their own server, not
/// unsolicited outbound browsing: it is reachable only from our own panels, carries no
/// captured pixels, and only ever sends the term being looked up.
fn validate_configured_api_url(raw: &str) -> Reply<reqwest::Url> {
    validate_url_basics(raw)
}

#[tauri::command]
fn save_preferences(app: tauri::AppHandle, state: State<Shared>, prefs: Prefs) -> Reply<()> {
    validate_service_url(&prefs.endpoint)
        .map_err(|e| e.replace("invalid: ", "invalid: OCR endpoint — "))?;
    state.settings.set_many(&[
        (&["endpoint"], json!(prefs.endpoint)),
        (
            &["nativeWindowPinned", "controller"],
            json!(prefs.controller_pin),
        ),
        (&["nativeWindowPinned", "log"], json!(prefs.log_pin)),
    ])?;
    if let Some(crop) = prefs.crop {
        if let Some((kind, name, app_name)) = selected_descriptor(&state) {
            let context = if kind == "screen" { application_context::current(&state) } else { None };
            let key = application_context::crop_key(context.as_ref(), state::descriptor_key(&kind, &name, app_name.as_deref()));
            state
                .settings
                .set_path(&["cropRegions", &key], serde_json::to_value(crop).unwrap())?;
        }
    }
    let _ = panels::act_existing(
        &app,
        &state.settings,
        panels::MAIN,
        if prefs.log_pin { "pin" } else { "unpin" },
        None,
    );
    Ok(())
}

fn selected_descriptor(service: &Service) -> Option<(String, String, Option<String>)> {
    let record = service.settings.get("lastSelectedSource").ok().flatten()?;
    Some((
        // Records written before this normalisation may still say "display".
        state::descriptor_type(record.get("type")?.as_str()?).to_string(),
        record.get("name")?.as_str()?.to_string(),
        record
            .get("appName")
            .and_then(Value::as_str)
            .map(str::to_string),
    ))
}

fn current_crop(service: &Service) -> Option<Crop> {
    let (kind, name, app) = selected_descriptor(service)?;
    sources::saved_crop(service, &kind, &name, app.as_deref())
}

// ---------------------------------------------------------------- view state

#[tauri::command]
fn report(app: tauri::AppHandle, state: State<Shared>, value: Value) {
    record(&app, &state, value);
}

/// Put one diagnostic in the in-memory log *and* on disk.
///
/// Extension diagnostics contain dictionary metadata; OCR/user screen text is never
/// logged by scan, and captured pixels are never logged at all. Native callers use
/// this rather than `Service::log`, which only feeds the Debug panel and so cannot
/// record anything that happens before a window is there to read it.
fn record(app: &tauri::AppHandle, service: &Shared, value: Value) {
    use std::io::Write;
    service.log(value.clone());
    if let Ok(p) = path(app, "evidence.jsonl") {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
        {
            let _ = writeln!(f, "{value}");
        }
    }
}

#[tauri::command]
fn storage_load(app: tauri::AppHandle) -> Reply<Value> {
    match std::fs::read(path(&app, "chrome-local.json")?) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn storage_save(app: tauri::AppHandle, value: Value) -> Reply<()> {
    save(&app, "chrome-local.json", &value)
}

/// The always-present window that owns the Yomitan backend and the OCR text.
const OVERLAY: &str = "overlay";

/// The window the original dictionary popup is rendered in.
///
/// Borderless, transparent and always on top, sized to the popup rather than to a
/// display: the popup is a small floating thing, and a screen-sized invisible window
/// that swallowed clicks whenever its hit regions were wrong would be a much worse
/// failure than a misplaced popup.
const POPUP_HOST: &str = "popup-host";

fn snapshot_value(service: &Service) -> Value {
    // Capture reading identity once so headers and crop cannot describe different games.
    let context = application_context::current(service);
    let crop = selected_descriptor(service).and_then(|(kind, name, app)| sources::saved_crop_with_context(service, &kind, &name, app.as_deref(), context.as_ref()));
    let source = application_context::source_with_context(service, context.as_ref());
    let v = service.view.lock().unwrap();
    json!({
        "revision": v.revision,
        "scan": v.scan,
        "status": v.status,
        "logs": v.logs,
        "interactive": v.interactive,
        "regions": v.regions,
        "sourceFocus": v.source_focus,
        "origin": v.origin,
        "dictionary": v.dictionary,
        "dismiss": v.dismiss,
        "source": source.map(with_source_kind),
        "applicationContext": context,
        "crop": crop,
        "cropEnabled": crop.is_some(),
        "isScanning": v.scanning,
        "autoOcrEnabled": v.auto_ocr,
        "overlayVisible": v.overlay_visible,
        "textOverlayVisible": v.text_overlay_visible,
        "debugOverlayVisible": v.debug_overlay_visible,
        // Raw and unfiltered: consumers decide what our own windows mean.
        "frontmostApp": v.frontmost_app,
        "accessibility": v.accessibility,
        "action": v.last_action.as_ref().map(|name| json!({"name": name, "seq": v.action_seq})),
    })
}

#[tauri::command]
fn application_context_get(state: State<Shared>) -> Value {
    json!({"available": application_context::available(), "context": application_context::current(&state)})
}

#[tauri::command]
fn application_context_set(state: State<Shared>, context: Option<application_context::ApplicationContext>) -> Reply<Value> {
    application_context::set_override(&state, context)?;
    let mut view = state.view.lock().unwrap();
    view.scan = None;
    view.regions.clear();
    view.revision += 1;
    drop(view);
    Ok(application_context_get(state))
}

#[tauri::command]
fn snapshot(state: State<Shared>) -> Value {
    snapshot_value(&state)
}

#[tauri::command]
fn select_source(state: State<Shared>, id: String) {
    let mut selection = state.selection.lock().unwrap();
    if selection.as_ref() != Some(&id) {
        let mut v = state.view.lock().unwrap();
        v.scan = None;
        v.regions.clear();
        v.revision += 1;
    }
    *selection = Some(id);
}

#[tauri::command]
fn selected_source(state: State<Shared>) -> Option<String> {
    state.selection.lock().unwrap().clone()
}

/// Publish the calling window's interactive rectangles, replacing its previous set.
///
/// Keyed by the caller rather than global: the overlay owns the words it drew and the
/// popup host owns the dictionary, and a press has to be attributable to one of them.
#[tauri::command]
fn regions(window: tauri::WebviewWindow, state: State<Shared>, rects: Vec<Region>) {
    let usable: Vec<Region> = rects
        .into_iter()
        .filter(Region::usable)
        .take(2000)
        .collect();
    #[cfg(target_os = "linux")]
    let usable = if window.label() == OVERLAY && platform::wayland_overlay_unavailable() {
        let _ = window.hide();
        Vec::new()
    } else { usable };
    #[cfg(target_os = "linux")]
    if window.label() == OVERLAY {
        // Linux overlays start hidden. Map X11 panels as well as native Wayland
        // layers when they publish words or editor regions, and hide empty surfaces.
        let visible = !usable.is_empty()
            && (state.view.lock().unwrap().overlay_visible || platform::region_editing())
            && !platform::capture::suppressed();
        if visible && platform::wayland_overlay_unavailable() {
            // A hide action disables input; restore whole-window input on show.
            let _ = window.set_ignore_cursor_events(false);
        }
        if platform::gamescope::is_visible(&window) != visible {
            let result = if visible {
                platform::gamescope::show(&window)
            } else {
                platform::capture::mark_hidden();
                platform::gamescope::hide(&window)
            };
            if let Err(error) = result {
                eprintln!("Linux overlay visibility: {error}");
            } else if visible && !platform::wayland_layer_overlay() {
                // GTK can discard a hidden X11 window's requested size on first map.
                // Reapply its already resolved display bounds after showing it.
                let origin = state.view.lock().unwrap().origin;
                if let Some(rect) = origin {
                    if let Err(error) = platform::desktop_place(&window, rect) {
                        eprintln!("Linux overlay placement: {error}");
                    }
                }
            }
        }
    }
    let mut v = state.view.lock().unwrap();
    if usable.is_empty() {
        v.regions.remove(window.label());
    } else {
        v.regions.insert(window.label().to_string(), usable);
    }
}

#[tauri::command]
fn dictionary(state: State<Shared>, open: bool) {
    state.view.lock().unwrap().dictionary = open;
}

#[tauri::command]
fn view_flags(state: State<Shared>, flags: HashMap<String, bool>) {
    let mut v = state.view.lock().unwrap();
    for (name, value) in flags {
        match name.as_str() {
            "autoOcrEnabled" => v.auto_ocr = value,
            "textOverlayVisible" => v.text_overlay_visible = value,
            "debugOverlayVisible" => v.debug_overlay_visible = value,
            "overlayVisible" => v.overlay_visible = value,
            _ => {}
        }
    }
}

#[tauri::command]
fn clear(state: State<Shared>) {
    let mut v = state.view.lock().unwrap();
    v.revision += 1;
    v.scan = None;
    v.regions.clear();
    drop(v);
    state.images.lock().unwrap().clear();
}

// ---------------------------------------------------------------- windows

#[tauri::command]
fn panel_pointer(window: tauri::WebviewWindow) -> Reply<Option<(f64, f64)>> {
    // Window-local CSS pixels straight from the OS module on every platform (macOS
    // points are CSS pixels; Windows divides by the window's DPI itself), so no desktop
    // conversion applies here.
    platform::panel_pointer(&window)
}

#[tauri::command]
fn panel_cursor(window: tauri::WebviewWindow, kind: String) -> Reply<()> {
    platform::panel_cursor(&window, &kind)
}

// Async, so a panel built on first use is never created inside the IPC callback that asked
// for it (WebView2 deadlocks there). The work itself still runs on the main thread, in a
// loop turn of its own; see `panels::MainTurn`.
#[tauri::command]
async fn panel(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    label: String,
    action: String,
    rect: Option<Rect>,
) -> Reply<Value> {
    #[cfg(target_os = "linux")]
    if platform::capture::suppressed() && platform::capture::annotation_window(&label)
        && matches!(action.as_str(), "show" | "show_inactive")
    {
        return Err("busy: annotations are temporarily hidden for capture".into());
    }
    #[cfg(target_os = "linux")]
    if label == OVERLAY && platform::wayland_overlay_unavailable()
        && matches!(action.as_str(), "show" | "show_inactive")
    {
        return Err("Native overlay is unavailable on this Wayland compositor".into());
    }
    #[cfg(target_os = "linux")]
    if platform::capture::annotation_window(&label) && action == "hide"
        && app.get_webview_window(&label).is_some_and(|w| w.is_visible().unwrap_or(false)) {
        platform::capture::mark_hidden();
    }
    let settings = state.settings.clone();
    panels::act_async(&app, &settings, label, action, rect).await
}

/// Start a native window drag. Synchronous on purpose: tao's macOS `drag_window` turns
/// `NSApp.currentEvent` into the drag, and that is only the title-bar mouse-down while
/// this IPC callback is still running. Dragging never creates a window, so it does not
/// need the deferred creation path that `panel` uses.
#[tauri::command]
fn panel_drag(app: tauri::AppHandle, state: State<'_, Shared>, label: String) -> Reply<Value> {
    panels::act_existing(&app, &state.settings, &label, "drag", None)
}

#[tauri::command]
async fn panel_content_height(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    label: String,
    height: f64,
) -> Reply<()> {
    let settings = state.settings.clone();
    panels::set_content_height_async(&app, &settings, label, height).await
}

#[tauri::command]
fn place_overlay(app: tauri::AppHandle, state: State<Shared>, rect: Rect) -> Reply<()> {
    // `rect` and the stored origin are desktop points, the space the cursor poll compares
    // hit regions in.
    platform::desktop_place(
        &app.get_webview_window(OVERLAY)
            .ok_or("native: overlay missing")?,
        rect,
    )?;
    state.view.lock().unwrap().origin = Some(rect);
    Ok(())
}

#[tauri::command]
async fn gnome_overlay(app: tauri::AppHandle, state: State<'_ , Shared>, operation: String, payload: Value) -> Reply<Value> {
    #[cfg(target_os = "linux")]
    { let service=state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {let result=platform::gnome::request(&operation,payload.clone())?;
            if operation=="track"&&payload["operation"]=="match"&&!result.is_null(){if let Some(id)=payload["sourceId"].as_str(){platform::gnome::refresh_identity(&service,id);}}
            if matches!(operation.as_str(),"update"|"install")&&result["live"]==true {hotkeys::apply(&app,&service.settings);}
            Ok(result)
        }).await.map_err(|e|e.to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    { let _ = (app,state,operation, payload); Err("GNOME overlay is Linux-only".into()) }
}

#[tauri::command]
fn desktop() -> Vec<Rect> {
    platform::desktop_displays()
}

/// Route Escape and Return to the region editor while it is open; see `hotkeys::set_region_keys`.
#[tauri::command]
fn region_keys(app: tauri::AppHandle, on: bool) -> Reply<()> {
    #[cfg(target_os = "linux")]
    if platform::wayland_layer_overlay() || platform::gamescope::active() {
        let window = app.get_webview_window("overlay").ok_or("overlay unavailable")?;
        return platform::region_keyboard(&window, on);
    }
    hotkeys::set_region_keys(&app, on)
}

/// Open (`true`) or close the controller menu's navigation mode; see
/// `gamepad::set_navigation`. `take_focus` (default on) takes activation from the game so it
/// stops reading the controller; the application that had it is reactivated on close.
#[tauri::command]
fn controller_nav(app: tauri::AppHandle, active: bool, take_focus: Option<bool>) -> Value {
    #[cfg(target_os = "linux")]
    if platform::gamescope::active() {
        let previous = gamepad::set_navigation(&app, active, false);
        let result = platform::steam_input::update(active)
            .and_then(|()| app.get_webview_window("overlay").ok_or_else(|| "overlay unavailable".to_owned()))
            .and_then(|window| platform::gamescope::keyboard(&window, active));
        return json!({"previousPid": previous, "gamescopeInput": result.is_ok(), "error": result.err()});
    }
    let previous = gamepad::set_navigation(&app, active, take_focus.unwrap_or(true));
    json!({ "previousPid": previous })
}

/// The display under the pointer, for Quick Shot: the region is drawn where the
/// reader is looking, not on whichever display holds the chosen source.
#[tauri::command]
fn pointer_display() -> Option<platform::DisplayInfo> {
    let platform::PointerSample { x, y, .. } = platform::desktop_cursor()?;
    let displays = platform::desktop_display_infos();
    displays
        .iter()
        .find(|d| {
            let b = &d.bounds;
            x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height
        })
        .or_else(|| displays.first())
        .cloned()
}

/// Bring a window source's application to the front. Window ids carry the owning process
/// (`macos:window:<window>:<pid>`); a display has nothing to bring forward.
#[tauri::command]
async fn activate_source(app: tauri::AppHandle, source_id: String) -> Reply<()> {
    #[cfg(target_os = "linux")]
    if source_id.starts_with("portal:window:") && platform::gnome::eligible_popup_session() {
        return platform::gnome::request("track", json!({"operation":"activate","sourceId":source_id})).map(|_| ());
    }
    let pid = SourceId::parse(&source_id)
        .filter(|id| id.is_window() && id.is_local())
        .and_then(|id| id.pid())
        .filter(|pid| *pid > 0)
        .ok_or("invalid: only a window source can be brought to the front")?;
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(platform::activate_process(pid));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// Where the pointer is, in desktop points, and the display it is on. Quick Shot polls this to
/// keep its hint beside the cursor and to follow the cursor onto another display: the overlay
/// covers one display and sees no pointer events outside it.
#[tauri::command]
fn pointer_location() -> Option<Value> {
    let platform::PointerSample { x, y, .. } = platform::desktop_cursor()?;
    let display = platform::desktop_display_infos().into_iter().find(|d| {
        let b = &d.bounds;
        x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height
    });
    Some(json!({ "x": x, "y": y, "display": display }))
}

/// The calling window's own bounds, in desktop points.
///
/// The dictionary bridge needs this to translate one window's client coordinates
/// into the desktop, which is the only space two native windows share.
#[tauri::command]
fn window_bounds(window: tauri::WebviewWindow) -> Reply<Rect> {
    #[cfg(target_os = "linux")]
    if matches!(window.label(), "log" | "popup-host") && platform::gnome::eligible_popup_session() {
        return platform::gnome::own_bounds(&window);
    }
    platform::desktop_bounds(&window)
}

/// Move, size and show the popup window, in desktop points.
///
/// Driven by the popup host itself, from the geometry the original `Popup` computed:
/// Yomitan decides where the popup goes and how big it is, and this is how that
/// decision reaches a window instead of an absolutely positioned iframe. Placement is
/// not clamped here — the original code has already clamped it to the work area of
/// the display the scanned text is on, and clamping again against a different display
/// would fight it.
#[tauri::command]
fn popup_window(app: tauri::AppHandle, rect: Option<Rect>, visible: bool) -> Reply<()> {
    let window = app
        .get_webview_window(POPUP_HOST)
        .ok_or("native: the popup window is missing")?;
    #[cfg(target_os = "linux")]
    if platform::gnome::eligible_popup_session() {
        if !visible { window.hide().map_err(|e| e.to_string())?; return Ok(()); }
        if !platform::gnome::desktop_popup() {
            let _ = window.hide();
            return Err("GNOME dictionary popup integration is unavailable".into());
        }
        if let Some(rect) = rect {
            // Validate bounded placement before resizing/mapping. Shell finishes it
            // when the Wayland surface appears; GTK does not activate it on map.
            platform::gnome::request("own-window", json!({"label":"popup-host","rect":rect}))?;
            window.set_size(tauri::LogicalSize::new(rect.width, rect.height)).map_err(|e| e.to_string())?;
        }
        if visible { window.show().map_err(|e| e.to_string())?; }
        else { window.hide().map_err(|e| e.to_string())?; }
        return Ok(());
    }
    if let Some(rect) = rect {
        if rect.width > 0. && rect.height > 0. {
            platform::desktop_place(&window, rect)?;
        }
    }
    #[cfg(target_os = "linux")]
    if platform::gamescope::handles(&window) {
        return if visible { platform::gamescope::show(&window) } else { platform::gamescope::hide(&window) };
    }
    let shown = window.is_visible().unwrap_or(false);
    if visible && !shown {
        // Ordered front rather than shown: Tauri's `show` is `makeKeyAndOrderFront:`,
        // which would take the keyboard away from the window the reader is scanning
        // the moment a popup opened, and stop them moving to the next word.
        platform::order_front(&window)?;
    } else if !visible && shown {
        window.hide().map_err(|e| format!("native: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn displays() -> Vec<platform::DisplayInfo> {
    platform::desktop_display_infos()
}

#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    {
        platform::stop_mouse_guard();
        platform::stop_key_trigger();
    }
    #[cfg(target_os = "linux")]
    platform::stop_key_trigger();
    #[cfg(target_os = "linux")]
    platform::shortcuts::stop();
    app.exit(0);
}

/// Relays JSON between window labels. Deliberately generic: no Yomitan knowledge
/// lives in Rust, and the extension host builds its RPC on top of this.
#[tauri::command]
fn ext_relay(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<Shared>,
    target: Option<String>,
    payload: Value,
) -> Reply<()> {
    // A sequence per sender, so a receiver can tell a resend from a new message.
    // Event delivery is not guaranteed to be exactly-once, and the extension host's
    // cross-frame ports are not idempotent: a duplicated acknowledgement fails the
    // whole invocation with "already acknowledged".
    let seq = {
        let mut counters = state.relay_seq.lock().unwrap();
        let counter = counters.entry(window.label().to_string()).or_insert(0);
        *counter += 1;
        *counter
    };
    // The address travels in the message, and every receiver checks it.
    //
    // A webview's JS `listen` registers for *any* target, so `emit_to` is not the
    // filter it looks like: every window receives every relay. That was invisible
    // while the only traffic was request/response with the overlay — an answer for
    // another window matched no pending request and was dropped — and became fatal
    // the moment two windows carried a stateful port between them, because each end
    // received its own messages back and answered them.
    let message = json!({
        "from": window.label(),
        "to": target,
        "seq": seq,
        "payload": payload,
    });
    app.emit("ext-relay", message)
        .map_err(|e| format!("native: {e}"))
}

// ---------------------------------------------------------------- source picker

#[tauri::command]
async fn source_catalog(app: tauri::AppHandle, state: State<'_, Shared>) -> Reply<Vec<Value>> {
    let started = Instant::now();
    let result = tauri::async_runtime::spawn_blocking(sources::catalog)
        .await
        .map_err(|e| e.to_string())??;
    report(
        app,
        state,
        json!({"check":"source-catalog", "sources":result.len(), "metadataMs":started.elapsed().as_secs_f64()*1000.}),
    );
    Ok(result)
}

#[tauri::command]
async fn source_icon(state: State<'_, Shared>, app_name: String) -> Reply<Value> {
    let service = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sources::icon(&service, &app_name))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn source_thumbnail(state: State<'_, Shared>, source_id: String) -> Reply<Value> {
    let service = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sources::thumbnail(&service, &source_id))
        .await
        .map_err(|e| e.to_string())?
}

/// The selected window's pixels for the overlay's hover outline. See `sources::hover_preview`.
#[tauri::command]
async fn source_hover_preview(state: State<'_, Shared>, source_id: String) -> Reply<Value> {
    let service = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sources::hover_preview(&service, &source_id))
        .await
        .map_err(|e| e.to_string())?
}

/// The chosen source's current pixels for the sidebar's live preview. See `sources::live_thumbnail`.
#[tauri::command]
async fn source_live_thumbnail(state: State<'_, Shared>, source_id: String) -> Reply<Value> {
    let service = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sources::live_thumbnail(&service, &source_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn source_preview(state: State<'_, Shared>, source_id: String) -> Reply<Value> {
    let service = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sources::preview(&service, &source_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn commit_source(
    state: State<'_, Shared>,
    source_id: String,
    crop: Option<Crop>,
    keep_crop: Option<bool>,
) -> Reply<Value> {
    let service = state.inner().clone();
    let keep = keep_crop.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        if keep && crop.is_none() {
            sources::select_keeping_crop(&service, &source_id)
        } else {
            sources::commit(&service, &source_id, crop)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Choose a new source: the main window comes forward with its sidebar's Change source menu
/// open on the grid of windows and displays. There is no separate picker window; regions are
/// drawn over the source itself (the overlay's `setCropArea`).
#[tauri::command]
fn open_source_picker(app: tauri::AppHandle, state: State<Shared>) -> Reply<Value> {
    choose_source(&app, &state.settings)
}

pub fn choose_source(app: &tauri::AppHandle, settings: &Arc<Settings>) -> Reply<Value> {
    let info = panels::act_existing(app, settings, panels::MAIN, "show", None)?;
    let _ = app.emit("main:choose-source", json!({}));
    Ok(info)
}

// ---------------------------------------------------------------- capture

#[tauri::command]
async fn enumerate(state: State<'_, Shared>) -> Reply<Vec<Source>> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        s.backend
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .enumerate()
            .map(|sources| {
                let geometry = platform::DesktopGeometry::current();
                sources
                    .into_iter()
                    .map(|s| geometry.source_to_desktop(s))
                    .collect()
            })
            .map_err(err)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn permission(state: State<'_, Shared>) -> Reply<bool> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(s.backend
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .request_permission())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// "Choose in system picker": opens the system picker (the Wayland ScreenCast portal) and
/// selects what the user shares, as choosing a tile in the grid would.
///
/// Waits as long as the user takes. The backend is out of its mutex meanwhile (see
/// `sources::pick_source`), so other commands answer at once: captures with `busy:`.
/// Replies `{picked: true, source, selection}` or `{picked: false, reason, message}`;
/// `invalid:` on a backend that lists sources itself.
#[tauri::command]
async fn capture_pick_source(app: tauri::AppHandle, state: State<'_, Shared>, fresh: Option<bool>) -> Reply<Value> {
    #[cfg(target_os = "linux")]
    if fresh.unwrap_or(true) {
        if platform::gnome::eligible_popup_session() {
            let _ = platform::gnome::request("track", json!({"operation":"clear"}));
        }
        let mut backend = state.backend.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if backend.capabilities().system_picker_required {
            backend.close();
            let _ = state.settings.set(PORTAL_TOKEN_KEY, Value::Null);
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = fresh;
    let service = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || sources::pick_source(&service))
        .await
        .map_err(|e| e.to_string())??;
    #[cfg(target_os = "linux")]
    let result = if result["picked"] == json!(false) && result["reason"] != "busy" {
        match kimochi_capture::last_portal_pick_error().filter(|error| error != "cancelled") {
            Some(error) => {
                record(&app, &state, json!({"check":"portal-pick-failed","error":error}));
                json!({"picked":false,"reason":"error","message":error})
            }
            None => result,
        }
    } else { result };
    if result["picked"] == json!(true) {
        // Authorization is `granted` now that a session is live: say so once, here, and
        // record it so `permission_status` does not announce the same change again.
        let (service, handle) = (state.inner().clone(), app.clone());
        let payload = tauri::async_runtime::spawn_blocking(move || {
            let permission = service
                .backend
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .permission()
                .to_string();
            *LAST_PERMISSION.lock().unwrap_or_else(|p| p.into_inner()) =
                Some((permission, platform::key_trigger_status().permission));
            capabilities_value(&handle, &service)
        })
        .await
        .map_err(|e| e.to_string())?;
        let _ = app.emit("platform-capabilities", payload);
    }
    Ok(result)
}

/// How long one local observation may take before it is abandoned.
///
/// Warm observations measure about 35ms on rendered fixtures; this is a fence
/// against a wedged engine, not a working budget. On expiry the analysis is
/// cancelled for real, not merely stopped being waited for.
const OBSERVE_TIMEOUT: Duration = Duration::from_millis(1500);

/// A native capture with no network, no OCR and no view-state mutation.
///
/// This is the primitive the overlay's OCR orchestrator builds on. It deliberately
/// does not touch `revision`, `scan` or `regions`: it runs as often as twice a second
/// and bumping the revision would force the overlay to re-render every word box.
///
/// With `observe`, the same pixels are also hashed and read by the local text
/// observer before this returns, so one round trip answers every question the
/// scheduler has about a frame. That matters for more than speed: the browser
/// side used to fetch the frame's PNG back over the `capture:` protocol to hash
/// it, and something in that fetch-decode-canvas sequence threw `Load failed`,
/// which took change detection with it. The failing step was never identified,
/// so the sequence is gone rather than fixed.
#[tauri::command]
async fn capture_frame(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    request: CaptureRequest,
    observe: Option<bool>,
    observer_mode: Option<String>,
) -> Reply<Value> {
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Err("busy: a capture is already running; retry shortly".into());
    }
    let _guard = ScanGuard(state.inner().clone());
    let service = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut backend = service
            .backend
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let frame = backend.capture(&request).map_err(|error| {
            let error = sources::err_for(&request.source_id, error);
            service.images.lock().unwrap().capture_error = Some(error.clone());
            error
        })?;
        // Release the capture lock before observing: an observation must not hold
        // up the next capture, and the frame owns its own pixels from here.
        drop(backend);

        let mut observation = Value::Null;
        let mut observer_error = Value::Null;
        let mut observer_unsupported = false;
        let mut hash = Value::Null;
        let mut fingerprint = Value::Null;
        if observe.unwrap_or(false) {
            fingerprint = Value::from(kimochi_capture::hash::content_fingerprint(&frame));
            if observer_mode.as_deref() == Some("image") {
                hash =
                    kimochi_capture::dhash_rgba(&frame.pixels, frame.info.width, frame.info.height)
                        .map_or(Value::Null, Value::from);
            } else {
                let mut observer = service
                    .observer
                    .lock()
                    .map_err(|_| "busy: the local observer is poisoned".to_string())?;
                match observer.observe(&frame, OBSERVE_TIMEOUT) {
                    Ok(read) => {
                        observation = serde_json::to_value(&read).map_err(|e| e.to_string())?;
                        // Per line, how strongly its text stands out: what tells text that is
                        // still fading or drawing in from text that has settled.
                        if let Some(lines) = observation["lines"].as_array_mut() {
                            for (value, line) in lines.iter_mut().zip(&read.lines) {
                                value["ink"] = Value::from(ink_signature(
                                    &frame, line.x, line.y, line.width, line.height,
                                ));
                            }
                        }
                    }
                    Err(error) => {
                        // Two of these codes are standing facts about this session
                        // rather than transient failures, and the scheduler treats
                        // the two kinds very differently: one turns automatic mode
                        // off with an explanation, the other backs off and retries.
                        //
                        // "unsupported" means there is no engine here. "stalled"
                        // means the engine took a request and never gave it back, so
                        // nothing more can safely be started on this observer until
                        // the app restarts — retrying would only report the same
                        // refusal every tick.
                        observer_unsupported = matches!(error.code, "unsupported" | "stalled");
                        observer_error = Value::from(error.message);
                    }
                }
            }
        }

        let info = serde_json::to_value(platform::desktop_frame_info(&frame.info))
            .map_err(|e| e.to_string())?;
        // One id space shared with `scan`, so `ocr_frame` can pick this exact frame up.
        let id = service
            .images
            .lock()
            .unwrap()
            .put_latest(Image::captured(frame, info.clone()));
        if std::env::var_os("KIMOCHI_CAPTURE_AUDIT").is_some() {
            record(
                &app,
                &service,
                json!({"type":"capture-audit", "id":id,
                "at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default().as_millis() as u64,
                "captureMs":info["total_ms"], "width":info["width"], "height":info["height"],
                "observerMs":observation["duration_ms"], "observerError":observer_error}),
            );
        }
        Ok(json!({
            "id": id,
            "info": info,
            "url": platform::capture_url(&id.to_string()),
            "hash": hash,
            "contentFingerprint": fingerprint,
            "observation": observation,
            "observerError": observer_error,
            "observerUnsupported": observer_unsupported,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cells along a line in its ink signature.
const INK_CELLS: usize = 8;

/// How strongly the text in a box stands out, cell by cell along the line: the spread of
/// brightness in each cell, rounded to whole levels. A fade-in raises it, a typewriter fills
/// cells one by one, and settled text holds it still, whatever the words read as. Sampled on
/// every other pixel; a line costs microseconds.
fn ink_signature(frame: &kimochi_capture::Frame, x: f64, y: f64, w: f64, h: f64) -> Vec<u8> {
    let (fw, fh) = (frame.info.width as f64, frame.info.height as f64);
    let left = x.max(0.0).min(fw) as usize;
    let top = y.max(0.0).min(fh) as usize;
    let right = (x + w).max(0.0).min(fw) as usize;
    let bottom = (y + h).max(0.0).min(fh) as usize;
    if right <= left || bottom <= top {
        return Vec::new();
    }
    let vertical = (bottom - top) as f64 > (right - left) as f64 * 1.5;
    let stride = frame.info.stride;
    let mut sums = [(0f64, 0f64, 0u32); INK_CELLS];
    for row in (top..bottom).step_by(2) {
        for column in (left..right).step_by(2) {
            let i = row * stride + column * 4;
            let Some(p) = frame.pixels.get(i..i + 3) else { continue };
            let luma = 0.299 * f64::from(p[0]) + 0.587 * f64::from(p[1]) + 0.114 * f64::from(p[2]);
            let along = if vertical {
                (row - top) * INK_CELLS / (bottom - top)
            } else {
                (column - left) * INK_CELLS / (right - left)
            };
            let cell = &mut sums[along.min(INK_CELLS - 1)];
            cell.0 += luma;
            cell.1 += luma * luma;
            cell.2 += 1;
        }
    }
    sums.iter()
        .map(|&(sum, squares, n)| {
            if n == 0 {
                return 0;
            }
            let mean = sum / f64::from(n);
            (squares / f64::from(n) - mean * mean).max(0.0).sqrt().round().min(255.0) as u8
        })
        .collect()
}

/// Read the latest real capture, independent of whether OCR accepted its text.
/// Hidden panels do not retain/encode preview frames and never initiate captures.
#[tauri::command]
fn capture_preview(app: tauri::AppHandle, state: State<'_, Shared>) -> Reply<Value> {
    if !app
        .get_webview_window("diagnostics")
        .is_some_and(|w| w.is_visible().unwrap_or(false))
    {
        return Ok(Value::Null);
    }
    let mut images = state.images.lock().map_err(|e| e.to_string())?;
    let error = images.capture_error.clone();
    let frame = images.live_preview().map(|(id, image)| {
        json!({
            "id": id, "info": image.info, "url": platform::capture_url(&format!("live/{id}"))
        })
    });
    Ok(json!({"frame":frame, "error":error}))
}

/// Keep a settling candidate's frame alive, or let it go.
///
/// The scheduler pins the frame a candidate is settling on and releases it once
/// the recogniser has answered — never before, because the overlay pins what it
/// publishes and an early release would let the next probe evict the image the
/// published scan points at.
#[tauri::command]
async fn retain_frame(state: State<'_, Shared>, id: u64, retain: bool) -> Reply<bool> {
    let mut images = state
        .images
        .lock()
        .map_err(|_| "busy: the image store is poisoned".to_string())?;
    Ok(if retain {
        images.pin_candidate(id)
    } else {
        images.release_candidate(id)
    })
}

/// What the local text observer can do on this machine.
///
/// Read once at startup so the overlay can say "automatic scanning is not
/// available here" in plain words, instead of discovering it one failed tick at a
/// time.
#[tauri::command]
async fn observer_status(state: State<'_, Shared>) -> Reply<Value> {
    let status = state
        .observer
        .lock()
        .map_err(|_| "busy: the local observer is poisoned".to_string())?
        .status();
    serde_json::to_value(&status).map_err(|e| e.to_string())
}

struct ScanGuard(Shared);
impl Drop for ScanGuard {
    fn drop(&mut self) {
        self.0.scanning.store(false, Ordering::SeqCst);
        self.0.view.lock().unwrap().scanning = false;
    }
}

/// The legacy native scan path also honors local native OCR selections.
fn native_ocr(app: &tauri::AppHandle, settings: &Settings, image: &Image) -> Reply<Value> {
    let mode = settings.get_or::<String>("ocrMode", "cloud".into());
    match mode.as_str() {
        #[cfg(target_os = "macos")]
        "livetext" => return livetext::recognize(image),
        #[cfg(not(target_os = "macos"))]
        "livetext" => return Err("Apple Live Text is available on macOS only.".into()),
        _ => {}
    }
    let png = image.png()?;
    match mode.as_str() {
        "meikiocr" | "local" => meiki_ocr::recognize(app, &png),
        "mangaocr" => manga_ocr::recognize(app, &png),
        #[cfg(target_os = "windows")]
        "oneocr" => oneocr::recognize(app, &png),
        #[cfg(not(target_os = "windows"))]
        "oneocr" => Err("OneOCR is available on Windows only.".into()),
        _ => post_ocr(settings, &png),
    }
}

/// POST one PNG using the shared cloud endpoint validation.
fn post_ocr(settings: &Settings, png: &[u8]) -> Reply<Value> {
    let endpoint = settings::resolve_endpoint(settings);
    let image = base64::engine::general_purpose::STANDARD.encode(png);
    let client = reqwest::blocking::Client::builder()
        .user_agent("Kimochi-POC/0.1")
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| "native: could not initialize OCR HTTP client")?;
    let response = client
        .post(endpoint)
        .json(&json!({ "imageBase64": image }))
        .send()
        .map_err(|_| "native: OCR network request failed (connection/TLS/timeout)")?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        // The server's own explanation (a Vision quota error, say) is the only
        // useful part; the bare status code alone reads as a mystery.
        let detail = response.json::<Value>().ok().and_then(|body| {
            body.get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        return Err(match detail {
            Some(detail) => format!("native: OCR HTTP {status}: {detail}"),
            None => format!("native: OCR HTTP {status}"),
        });
    }
    let value: Value = response
        .json()
        .map_err(|_| "native: OCR endpoint returned invalid JSON")?;
    if !value.get("textAnnotations").is_some_and(Value::is_array) {
        return Err("native: OCR response missing textAnnotations".into());
    }
    Ok(value)
}

/// The engines `ocr_frame` can dispatch to in this build: the portable ones, plus
/// the OS engine of the OS this was built for.
fn native_engine_known(engine: &str) -> bool {
    matches!(engine, "cloud" | "meikiocr" | "mangaocr")
        || (cfg!(target_os = "windows") && engine == "oneocr")
        || (cfg!(target_os = "macos") && engine == "livetext")
}

/// OCR a frame that has already been captured, by id.
///
/// This is what the change-detection loop must use: recapturing after the gate has
/// passed would OCR a *different* image than the one that was compared, and would pair
/// the returned text with geometry it does not belong to.
#[tauri::command]
async fn ocr_frame(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    id: u64,
    engine: Option<String>,
) -> Reply<Value> {
    let engine = engine.unwrap_or_else(|| "cloud".into());
    if !native_engine_known(&engine) {
        return Err(format!("invalid: unknown native OCR engine {engine}"));
    }
    let service = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let image = {
            let images = service.images.lock().unwrap();
            let image = images
                .frame(id)
                .ok_or("gone: that frame has been replaced; capture again before running OCR")?;
            image.clone()
        };
        // Encoding is outside the frame-store lock so observations can continue.
        let png = image.png()?;
        let info = image.info.clone();
        if let Ok(p) = path(&app, "last-ocr-frame.png") {
            let _ = std::fs::write(p, &png);
        }
        let started = std::time::Instant::now();
        let value = match engine.as_str() {
            "meikiocr" | "local" => meiki_ocr::recognize(&app, &png)?,
            "mangaocr" => manga_ocr::recognize(&app, &png)?,
            #[cfg(target_os = "windows")]
            "oneocr" => oneocr::recognize(&app, &png)?,
            #[cfg(target_os = "macos")]
            "livetext" => livetext::recognize(&image)?,
            _ => post_ocr(&service.settings, &png)?,
        };
        let count = value["textAnnotations"].as_array().map_or(0, Vec::len);
        record(
            &app,
            &service,
            json!({
                "check": "ocr-debug", "id": id, "info": info,
                "pngBytes": png.len(),
                "ms": started.elapsed().as_millis() as u64, "annotations": count,
                "fullTextLen": value["fullText"].as_str().map_or(0, |t| t.chars().count()),
                "keys": value.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()),
            }),
        );
        let result = json!({ "id": id, "info": info, "ocr": value });
        service.log(json!({
            "check": "ocr-frame",
            "id": id,
            "annotations": count,
            "engine": engine,
            "backend": result["ocr"]["backend"],
        }));
        // Deliberately does NOT publish. A result that arrives after the source
        // changed has to be dropped by the caller's freshness guard, and self-
        // publishing here would resurrect it through the snapshot even when the
        // caller correctly discarded the direct return value.
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Human status line for a finished scan, matching the Rust `scan` path's wording so
/// the controller reads the same whichever backend produced the text.
fn ready_status(count: usize) -> String {
    format!("Scan ready · {count} text annotations")
}

/// A result for a frame already published is a no-op: the overlay may publish more
/// than once for one frame, and bumping the revision would tear down and re-render
/// every word box for no change.
fn should_publish(published: Option<u64>, frame_id: u64) -> bool {
    published != Some(frame_id)
}

/// Publish scan lifecycle state. The caller that ran the scan owns this.
///
/// `capture_frame` and `ocr_frame` are both pure, and the browser-side backends
/// (OwOCR) never reach `ocr_frame` at all, so without this the controller's
/// `isScanning` and `status` and the capture/debug panels' `snapshot().scan` would
/// never reflect a normal migrated scan. Rust does no OCR here, writes no history and
/// re-runs nothing.
///
/// Publication is the caller's job precisely because only the caller knows whether an
/// OCR followed and whether the result is still current: a result that arrives after
/// the source changed must be dropped by the caller's freshness guard, and it cannot be
/// dropped if Rust already published it.
///
/// Every field is optional and an omitted field leaves its state untouched:
/// - `scanning` — sets the busy flag.
/// - `status` — sets the status line. Separate from `publish`, so a mid-scan status
///   update does not bump the revision and force every window to re-render.
/// - `publish` — when true, replaces `view.scan` with `scan` and bumps the revision.
///   `scan: null` with `publish: true` clears the result, like `clear`.
///
/// `scan` is validated loosely: text-only engines legitimately send
/// `{id, info, ocr: {fullText, textAnnotations: []}}` with no geometry. When it carries
/// a numeric `id`, that frame is pinned so the Capture Preview keeps resolving it, and
/// a repeated publish of the same frame is ignored rather than re-rendering.
#[tauri::command]
fn scan_state(
    state: State<Shared>,
    scanning: Option<bool>,
    status: Option<String>,
    scan: Option<Value>,
    publish: Option<bool>,
) -> Reply<Value> {
    let frame_id = scan
        .as_ref()
        .and_then(|value| value.get("id"))
        .and_then(Value::as_u64);
    if publish == Some(true) {
        if let Some(id) = frame_id {
            // Pin before publishing: the Capture Preview resolves `scan.id` through the
            // `capture:` protocol long after later probe frames have arrived.
            if !state.images.lock().unwrap().pin_published(id) {
                return Err("gone: cannot publish an evicted capture frame".into());
            }
        }
    }
    let mut view = state.view.lock().unwrap();
    let mut published = false;
    if let Some(scanning) = scanning {
        view.scanning = scanning;
    }
    if let Some(status) = status {
        view.status = status;
    }
    if publish == Some(true) {
        let fresh = frame_id.is_none_or(|id| should_publish(view.published_frame, id));
        if fresh {
            view.published_frame = frame_id;
            match scan {
                Some(Value::Null) | None => {
                    view.scan = None;
                    view.regions.clear();
                }
                Some(value) => view.scan = Some(value),
            }
            view.revision += 1;
            published = true;
        }
    }
    Ok(json!({ "revision": view.revision, "published": published }))
}

/// Read-only permission check. Unlike `permission()`, this never prompts, so the
/// welcome flow can render the real state without triggering a system dialog.
#[tauri::command]
fn permission_status(app: tauri::AppHandle, state: State<Shared>) -> Reply<String> {
    let permission = state
        .backend
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .permission()
        .to_string();
    // The UI polls this; a Screen Recording or Accessibility grant or revocation is
    // what changes the capabilities.
    let now = (permission.clone(), platform::key_trigger_status().permission);
    let changed = {
        let mut last = LAST_PERMISSION.lock().unwrap_or_else(|p| p.into_inner());
        let changed = last.as_ref().is_some_and(|was| *was != now);
        *last = Some(now);
        changed
    };
    if changed {
        let _ = app.emit("platform-capabilities", capabilities_value(&app, &state));
    }
    Ok(permission)
}

/// The capture and key-trigger permissions last reported, so a change is announced once.
static LAST_PERMISSION: Mutex<Option<(String, &'static str)>> = Mutex::new(None);

/// Why the capture backend could not be created, if it could not.
static CAPTURE_UNAVAILABLE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// The persisted source descriptor, plus `kind` ("window" | "display") from its id,
/// so the UI never parses a source id itself.
fn with_source_kind(mut source: Value) -> Value {
    let kind = source
        .get("sourceId")
        .and_then(Value::as_str)
        .and_then(SourceId::parse)
        .map(|id| if id.is_window() { "window" } else { "display" })
        .or_else(|| {
            source.get("type").and_then(Value::as_str).map(|t| match t {
                "window" => "window",
                _ => "display",
            })
        });
    if let (Some(object), Some(kind)) = (source.as_object_mut(), kind) {
        object.insert("kind".into(), json!(kind));
    }
    source
}

/// What this OS and build can do, for the UI to render honestly instead of sniffing
/// the user agent. See CROSS_PLATFORM_PLAN.md §3.3 and `platform::capabilities_payload`.
fn capabilities_value(app: &tauri::AppHandle, service: &Shared) -> Value {
    let (capture_permission, capture) = {
        let backend = service
            .backend
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (backend.permission().to_string(), backend.capabilities())
    };
    let observer = service
        .observer
        .lock()
        .ok()
        .and_then(|observer| serde_json::to_value(observer.status()).ok())
        .unwrap_or(Value::Null);
    let mut payload = platform::capabilities_payload(platform::DynamicCapabilities {
        capture_permission,
        capture,
        capture_reason: CAPTURE_UNAVAILABLE.get().cloned(),
        observer,
        meikiocr: meiki_ocr::availability(app),
        mangaocr: manga_ocr::availability(app),
    });
    #[cfg(target_os = "windows")]
    {
        payload["ocrEngines"]["oneocr"] = oneocr::capability(app);
    }
    #[cfg(target_os = "macos")]
    {
        payload["ocrEngines"]["livetext"] = livetext::capability();
    }
    // An engine held back only by its models stays selectable: choosing it asks to download them.
    for engine in model_store::Engine::ALL {
        if let Some(state) = model_store::gate(app, engine) {
            payload["ocrEngines"][engine.key()]["model"] = json!(state);
        }
    }
    payload
}

#[tauri::command]
async fn platform_capabilities(app: tauri::AppHandle, state: State<'_, Shared>) -> Reply<Value> {
    let service = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || capabilities_value(&app, &service))
        .await
        .map_err(|e| e.to_string())
}

/// Announce the capabilities once the app is up. Later changes are announced by
/// `permission_status` as the UI polls it.
fn spawn_capabilities_watch(handle: tauri::AppHandle, service: Shared) {
    std::thread::spawn(move || {
        let permission = service
            .backend
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .permission()
            .to_string();
        LAST_PERMISSION
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_or_insert((permission, platform::key_trigger_status().permission));
        let payload = capabilities_value(&handle, &service);
        let _ = handle.emit("platform-capabilities", payload);
    });
}

#[tauri::command]
async fn scan(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    request: CaptureRequest,
    ocr: bool,
) -> Reply<Value> {
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Err("busy: a capture is already running; retry shortly".into());
    }
    let _guard = ScanGuard(state.inner().clone());
    let s = state.inner().clone();
    {
        let mut v = s.view.lock().unwrap();
        v.scanning = true;
        v.status = if ocr {
            "Capturing → OCR…"
        } else {
            "Capturing preview…"
        }
        .into();
        v.regions.clear();
    }
    let a = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Reply<Value> {
        {
            let mut backend = s
                .backend
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let start = Instant::now();
            let frame = backend
                .capture(&request)
                .map_err(|e| sources::err_for(&request.source_id, e))?;
            // The frame owns its pixels: release the backend before encoding and OCR,
            // which take far longer than the capture, so previews are not held up.
            drop(backend);
            let info = serde_json::to_value(platform::desktop_frame_info(&frame.info))
                .map_err(|e| e.to_string())?;
            // Pixels are kept (encoded lazily, on the first PNG read): an engine that
            // reads RGBA skips the round trip, and the preview encodes once as before.
            let id = s
                .images
                .lock()
                .unwrap()
                .put_latest(Image::captured(frame, info.clone()));
            let mut result = json!({"id": id, "info": info, "ocr": null});
            if ocr {
                let image = {
                    let images = s.images.lock().unwrap();
                    images
                        .frame(id)
                        .ok_or("gone: the captured frame was replaced mid-scan")?
                        .clone()
                };
                result["ocr"] = native_ocr(&a, &s.settings, &image)?;
            }
            let count = result["ocr"]["textAnnotations"]
                .as_array()
                .map_or(0, Vec::len);
            s.log(json!({
                "check": "native-capture-ocr",
                "id": id,
                "info": result["info"],
                "ocr": ocr,
                "annotations": count,
                "elapsed_ms": start.elapsed().as_secs_f64() * 1000.,
            }));
            s.images.lock().unwrap().pin_published(id);
            let mut v = s.view.lock().unwrap();
            v.revision += 1;
            v.published_frame = Some(id);
            v.scan = Some(result.clone());
            v.status = if ocr && result["ocr"]["geometry"] == false {
                if result["ocr"]["fullText"]
                    .as_str()
                    .is_some_and(|t| !t.is_empty())
                {
                    "Scan ready · text only, this engine returns no positions".into()
                } else {
                    "Scan ready · no text recognized".into()
                }
            } else if ocr {
                ready_status(count)
            } else {
                "Preview ready · OCR not requested".into()
            };
            Ok(result)
        }
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    if let Err(e) = &result {
        let mut v = state.view.lock().unwrap();
        v.status = e.clone();
        v.scan = None;
        v.revision += 1;
        v.published_frame = None;
        v.regions.clear();
    }
    result
}

/// Track a source's geometry so the overlay can follow it across moves and displays.
#[tauri::command]
fn watch_source(app: tauri::AppHandle, state: State<Shared>, source_id: Option<String>) {
    *state.watching.lock().unwrap() = source_id;
    let _ = app.emit(
        "source-watch",
        json!({"watching": state.watching.lock().unwrap().clone()}),
    );
}

// ---------------------------------------------------------------- output

#[tauri::command]
fn texthooker_send(app: tauri::AppHandle, text: String) -> Reply<()> {
    app.try_state::<Arc<texthooker::Texthooker>>()
        .ok_or("native: texthooker unavailable")?
        .publish(&text);
    Ok(())
}

#[tauri::command]
fn trigger_action(app: tauri::AppHandle, state: State<Shared>, name: String) -> Reply<()> {
    if !actions::ACTIONS.contains(&name.as_str()) {
        return Err(format!("invalid: unknown action {name:?}"));
    }
    actions::dispatch(&app, state.inner(), &name);
    Ok(())
}

#[tauri::command]
fn tray_action(app: tauri::AppHandle, state: State<Shared>, action: String) -> Reply<()> {
    tray::dispatch(&app, state.inner(), &action)
}

const HISTORY_LIMIT: usize = 50;
const HISTORY_KEY: [&str; 1] = ["scannedTextHistory"];

/// Monotonic within a run; combined with the launch timestamp and pid it stays unique
/// across restarts too. Wall-clock alone is not enough: two entries added in the same
/// millisecond would collide, and a colliding id makes `history_delete` remove more
/// than the entry the user clicked.
static HISTORY_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn history_id() -> String {
    let seq = HISTORY_SEQ.fetch_add(1, Ordering::SeqCst);
    format!("{}-{}-{seq}", std::process::id(), now_millis())
}

/// Add, delete and clear all edit the list inside one held settings lock, so the
/// overlay and the Log panel cannot lose each other's writes to a read-modify-write
/// window.
fn edit_history(
    app: &tauri::AppHandle,
    service: &Service,
    edit: impl FnOnce(&mut Vec<Value>),
) -> Reply<Value> {
    let value = service.settings.update_path(&HISTORY_KEY, |current| {
        let mut list = current
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        edit(&mut list);
        list.truncate(HISTORY_LIMIT);
        Value::Array(list)
    })?;
    let _ = app.emit(
        "settings:changed",
        json!({ "key": "scannedTextHistory", "value": value }),
    );
    Ok(value)
}

#[tauri::command]
fn history_add(
    app: tauri::AppHandle,
    state: State<Shared>,
    text: String,
    detached: Option<bool>,
    groups: Option<Vec<ocr_result::OcrGroup>>,
    engine: Option<String>,
    merge: Option<bool>,
) -> Reply<Value> {
    if text.trim().is_empty() {
        return Err("invalid: history entries cannot be empty".into());
    }
    if let Some(groups) = &groups {
        let mut ids = std::collections::HashSet::new();
        if groups.len() > 1024 || groups.iter().any(|g| !g.validate() || !ids.insert(&g.id)) {
            return Err("invalid: OCR groups need unique IDs, text and valid boxes".into());
        }
    }
    // A Quick Shot is not from the chosen source, so it must not carry that source's
    // name: the reader would switch sessions to match a window nobody scanned.
    let source = if detached.unwrap_or(false) {
        Value::Null
    } else {
        application_context::source(&state).unwrap_or(Value::Null)
    };
    let now = now_millis();
    let mut entry = json!({ "id": history_id(), "text": text, "timestamp": now, "source": source, "groups": groups, "engine": engine });
    // Merging is decided inside the history lock, against the list as it is now; see
    // history_merge.rs. A replaced entry is named on the new one so the reader's log can
    // swap its lines rather than keep the fragment.
    let mut skipped = false;
    edit_history(&app, &state, |list| {
        if merge.unwrap_or(false) {
            let forgotten = history_merge::forgotten_until();
            match history_merge::decide(&text, &entry["source"], now as u64, forgotten, list) {
                history_merge::Merge::Skip => {
                    skipped = true;
                    return;
                }
                history_merge::Merge::Replace(ids) => {
                    list.retain(|old| {
                        !old.get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| ids.iter().any(|gone| gone == id))
                    });
                    entry["replaces"] = json!(ids);
                }
                history_merge::Merge::Add => {}
            }
        }
        list.insert(0, entry.clone());
    })?;
    if skipped {
        entry["skipped"] = json!(true);
    }
    Ok(entry)
}

#[tauri::command]
fn history_delete(app: tauri::AppHandle, state: State<Shared>, id: String) -> Reply<()> {
    edit_history(&app, &state, |list| {
        list.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(id.as_str()));
    })?;
    Ok(())
}

#[tauri::command]
fn history_clear(app: tauri::AppHandle, state: State<Shared>) -> Reply<()> {
    edit_history(&app, &state, Vec::clear)?;
    Ok(())
}

/// The reader cleared its log: what it showed is no longer there to duplicate. Scans merge
/// only with entries written after this (see history_merge.rs), and the automatic scanners
/// are told to forget what they published, so the same text scanned again reaches the log.
#[tauri::command]
fn history_merge_reset(app: tauri::AppHandle) {
    history_merge::forget_before(now_millis() as u64);
    let _ = app.emit("history:merge-reset", ());
}

#[tauri::command]
fn hotkeys_load(state: State<Shared>) -> Value {
    Value::Object(settings::merged_hotkeys(&state.settings))
}

#[tauri::command]
fn hotkeys_save(app: tauri::AppHandle, state: State<Shared>, hotkeys: Value) -> Reply<Value> {
    state.settings.set("hotkeys", hotkeys)?;
    Ok(hotkeys::apply(&app, &state.settings))
}

#[tauri::command]
fn hotkeys_reapply(app: tauri::AppHandle, state: State<Shared>) -> Value {
    hotkeys::apply(&app, &state.settings)
}

/// Pause the action shortcuts and gamepad actions while Settings records a new binding, so
/// pressing a combination that is already bound is captured instead of firing; `false`
/// restores them and returns the registration report. See `hotkeys::suspend`.
#[tauri::command]
fn hotkeys_suspend(app: tauri::AppHandle, state: State<Shared>, suspended: bool) -> Value {
    hotkeys::suspend(&app, &state.settings, suspended)
}

/// POST JSON to a user-configured Yomitan-compatible API and return its JSON.
///
/// Electron fetched these from the main process, so any address worked. Routing them
/// through the HTTP plugin instead would force the capability file to enumerate ports,
/// and the Dictionary tab's URL field is free text. Validation lives here, next to the
/// OCR endpoint's, rather than in an allow-list that cannot express "whatever the user
/// configured".
///
/// Not callable from `overlay`: that window hosts the Yomitan extension's own code, and
/// a general outbound-request command does not belong to third-party script. That
/// panel-only boundary is what makes the permissive URL rule safe — the caller is
/// always our own UI acting on an address the user configured.
#[tauri::command]
async fn yomitan_request(window: tauri::WebviewWindow, url: String, body: Value) -> Reply<Value> {
    if window.label() == OVERLAY {
        return Err("invalid: yomitan_request is not available to the extension host".into());
    }
    let url = validate_configured_api_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .user_agent("Kimochi/0.1")
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "native: could not initialize HTTP client")?;
        let response = client
            .post(url)
            .json(&body)
            .send()
            .map_err(|e| format!("native: request failed ({e})"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "native: HTTP {} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("")
            ));
        }
        response
            .json()
            .map_err(|_| "native: endpoint returned invalid JSON".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Largest response `extension_fetch` will hand back: well above any word's audio.
const EXTENSION_FETCH_LIMIT: u64 = 32 * 1024 * 1024;

/// A cross-origin read for the Yomitan backend, as a browser grants an extension's own
/// background page (see `host/audio-bridge.js`): dictionary audio from a local audio server,
/// a custom URL or a custom JSON list, none of which send CORS headers.
///
/// Deliberately narrow. Only the overlay — the one window hosting the backend — may call it.
/// Only GET and HEAD, so it reads and never acts. Anonymous: no cookie store, no credentials
/// in the URL, no page Origin. Bounded in time and size. Unlike `yomitan_request`, any host:
/// an audio source is whatever URL the reader configured in Yomitan, and its query string is
/// the term being looked up.
#[tauri::command]
async fn extension_fetch(
    window: tauri::WebviewWindow,
    url: String,
    method: Option<String>,
) -> Reply<Value> {
    if window.label() != OVERLAY {
        return Err("invalid: extension_fetch belongs to the extension host".into());
    }
    let url = reqwest::Url::parse(&url).map_err(|_| "invalid: not a URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("invalid: use an http:// or https:// URL".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("invalid: remove the credentials from the URL".into());
    }
    let head = match method.as_deref().unwrap_or("GET") {
        "GET" => false,
        "HEAD" => true,
        other => return Err(format!("invalid: {other} is not a read")),
    };
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        use std::io::Read as _;
        let client = reqwest::blocking::Client::builder()
            .user_agent("Kimochi/0.1")
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "native: could not initialize HTTP client")?;
        let request = if head {
            client.head(url)
        } else {
            client.get(url)
        };
        let response = request
            .send()
            .map_err(|e| format!("native: request failed ({e})"))?;
        let status = response.status();
        let headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                // Set-Cookie never reaches the page: the request was anonymous.
                if name == reqwest::header::SET_COOKIE {
                    return None;
                }
                Some((name.to_string(), value.to_str().ok()?.to_string()))
            })
            .collect();
        let mut body = Vec::new();
        if !head {
            response
                .take(EXTENSION_FETCH_LIMIT + 1)
                .read_to_end(&mut body)
                .map_err(|e| format!("native: could not read the response ({e})"))?;
            if body.len() as u64 > EXTENSION_FETCH_LIMIT {
                return Err("native: the response is too large".into());
            }
        }
        Ok(json!({
            "status": status.as_u16(),
            "statusText": status.canonical_reason().unwrap_or(""),
            "headers": headers,
            "body": base64::engine::general_purpose::STANDARD.encode(&body),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn system_state(state: State<Shared>) -> Value {
    let view = state.view.lock().unwrap();
    json!({
        "frontmostApp": view.frontmost_app,
        "accessibility": view.accessibility,
        "displays": platform::desktop_display_infos(),
    })
}

/// Opens the Screen Recording pane. Requesting permission is an explicit user
/// action; nothing in this app probes or prompts on its own.
#[tauri::command]
fn open_screen_capture_preferences() -> Reply<()> {
    platform::open_capture_settings()
}

/// Opens the settings that let the key trigger see global keys (Accessibility on macOS).
#[tauri::command]
fn open_accessibility_preferences() -> Reply<()> {
    platform::open_input_settings()
}

fn main() {
    #[cfg(target_os = "linux")]
    if platform::steam_input::run_watchdog() { return; }
    // Before anything claims a shortcut, the gamepad or a capture stream: any other copy
    // of Kimochi, of any build, is asked to quit first. See platform/macos/instance.rs.
    #[cfg(target_os = "macos")]
    platform::instance::take_over();
    let builder = tauri::Builder::default();
    // Elsewhere the first instance wins and a second launch just brings back its main
    // panel. Registered before every other plugin, as the plugin requires.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(service) = app.try_state::<Shared>() {
            let settings = service.settings.clone();
            let initial = settings.get("hasCompletedOnboarding").ok().flatten();
            let _ = panels::act_existing(app, &settings, onboarding_panel(initial.as_ref()), "show", None);
        }
    }));
    builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Asynchronous, and answered from a worker thread: a captured image is PNG-encoded on
        // request, which for a full-size window takes long enough to stall every window if it
        // ran on the main thread (a region drag stuttered each time the picture refreshed).
        .register_asynchronous_uri_scheme_protocol("capture", move |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let not_found = || {
                    tauri::http::Response::builder()
                        .status(404)
                        .body(Vec::new())
                        .unwrap()
                };
                let Some(service) = app.try_state::<Shared>() else {
                    responder.respond(
                        tauri::http::Response::builder()
                            .status(503)
                            .body(Vec::new())
                            .unwrap(),
                    );
                    return;
                };
                let path = request.uri().path().trim_start_matches('/').to_string();
                let found = {
                    let images = service.images.lock().unwrap();
                    match path.strip_prefix("preview/") {
                        Some(token) => token.parse().ok().and_then(|t| images.preview(t)),
                        None => match path.strip_prefix("live/") {
                            Some(id) => id.parse().ok().and_then(|id| images.live_image(id)),
                            None => match path.strip_prefix("hover/") {
                                Some(token) => {
                                    token.parse().ok().and_then(|t| images.hover_image(t))
                                }
                                None => path.parse().ok().and_then(|id| images.frame(id)),
                            },
                        },
                    }
                    .cloned()
                };
                let response = match found.and_then(|image| image.png().ok()) {
                    Some(png) => tauri::http::Response::builder()
                        .header("Content-Type", "image/png")
                        .header("Cache-Control", "no-store")
                        // Kimochi's own pages are another origin to this scheme; without this
                        // an `<img>` still loads but `fetch` (to keep a copy) is refused.
                        .header("Access-Control-Allow-Origin", "*")
                        .body(png)
                        .unwrap(),
                    None => not_found(),
                };
                responder.respond(response);
            });
        })
        .invoke_handler(tauri::generate_handler![
            application_context_get,
            application_context_set,
            reader_settings_patch,
            reader_notebook_ack,
            reader::vndb::vndb_search_vns,
            reader::vndb::vndb_characters_by_vn,
            reader::vndb::vndb_fetch_image,
            reader::yomitan::yomitan_tokenize,
            reader::yomitan::yomitan_ankifields,
            reader::yomitan::yomitan_probe,
            reader::translate::deepl_translate,
            reader::explain::explain_cancel,
            reader::explain::explain_run,
            reader::yomitan_install::install_yomitan_native_host,
            reader::popover::show_popover,
            reader::popover::reader_popup_ready,
            reader::popover::reader_popup_focus,
            reader::popover::hide_popover,
            reader::ankiconnect::anki_probe,
            reader::ankiconnect::anki_deck_names,
            reader::ankiconnect::anki_model_names,
            reader::ankiconnect::anki_model_field_names,
            reader::ankiconnect::anki_find_notes,
            reader::ankiconnect::anki_gui_browse,
            reader::ankiconnect::anki_store_media_file,
            reader::ankiconnect::anki_add_note,
            #[cfg(target_os = "linux")]
            platform::dictionary_images::linux_dictionary_image,
            report,
            scan_trace::scan_trace,
            storage_load,
            storage_save,
            snapshot,
            panel_pointer,
            panel_cursor,
            select_source,
            selected_source,
            preferences,
            save_preferences,
            enumerate,
            permission,
            capture_pick_source,
            regions,
            place_overlay,
            desktop,
            displays,
            panel,
            panel_drag,
            panel_content_height,
            dictionary,
            view_flags,
            clear,
            scan,
            capture_frame,
            capture_preview,
            retain_frame,
            observer_status,
            ocr_frame,
            scan_state,
            permission_status,
            watch_source,
            settings_get,
            settings_set,
            settings_all,
            source_catalog,
            source_thumbnail,
            source_icon,
            source_preview,
            source_hover_preview,
            source_live_thumbnail,
            commit_source,
            open_source_picker,
            pointer_display,
            pointer_location,
            activate_source,
            extension_fetch,
            region_keys,
            controller_nav,
            hotkeys_load,
            hotkeys_save,
            hotkeys_reapply,
            hotkeys_suspend,
            trigger_action,
            tray_action,
            texthooker_send,
            history_add,
            history_delete,
            history_clear,
            history_merge_reset,
            ext_relay,
            window_bounds,
            popup_window,
            yomitan_request,
            system_state,
            app_quit,
            open_screen_capture_preferences,
            open_accessibility_preferences,
            platform_capabilities,
            gnome_overlay,
            activity::activity_post,
            model_store::model_status,
            model_store::model_download_start,
            model_store::model_download_pause,
            model_store::model_download_resume,
            model_store::model_download_retry,
            model_store::model_download_cancel,
            model_store::model_delete,
        ])
        .setup(move |app| {
            #[cfg(target_os = "linux")]
            platform::initialize_wayland_overlay();
            let handle = app.handle().clone();
            #[cfg(target_os = "linux")]
            platform::gnome::start(handle.clone());
            let store = Arc::new(Settings::load(path(&handle, "settings.json")?));
            // Before anything asks whether a local engine's models are ready.
            model_store::install(&handle).map_err(std::io::Error::other)?;
            // The Wayland portal's restore token lives in settings so the picker is not
            // shown again on every launch. A no-op store everywhere else.
            kimochi_capture::set_portal_token_store(Box::new(PortalTokens(store.clone())));
            // Capture may be unavailable (an OS without a backend yet): the reader,
            // dictionary, texthooker and settings still start, and the UI is told why.
            let (backend, capture_unavailable) = match platform_backend() {
                Ok(backend) => (backend, None),
                Err(e) => (
                    Box::new(UnavailableBackend::new(e.message.clone())) as Box<dyn CaptureBackend>,
                    Some(e.message),
                ),
            };
            #[cfg(target_os = "linux")]
            let backend = platform::capture::protect(handle.clone(), backend);
            let service: Shared = Arc::new(Service {
                backend: Mutex::new(backend),
                observer: Mutex::new(text_observer::local_observer(&handle)),
                images: Mutex::new(Default::default()),
                settings: store.clone(),
                selection: Mutex::new(None),
                watching: Mutex::new(None),
                relay_seq: Mutex::new(HashMap::new()),
                scanning: AtomicBool::new(false),
                thumbnails: Mutex::new(HashMap::new()),
                icons: Mutex::new(HashMap::new()),
                view: Mutex::new(View {
                    status: "Choose a source; preview before sending to OCR.".into(),
                    overlay_visible: true,
                    text_overlay_visible: true,
                    accessibility: platform::key_trigger_status().permission == "granted",
                    frontmost_app: platform::frontmost_app(),
                    ..View::default()
                }),
            });
            app.manage(service.clone());
            if let Some(report) = platform::instance_report() {
                service.log(report);
            }
            if let Some(reason) = capture_unavailable {
                let _ = CAPTURE_UNAVAILABLE.set(reason.clone());
                service.log(json!({
                    "check": "capture-backend",
                    "status": "unavailable",
                    "detail": reason,
                }));
            }
            app.manage(meiki_ocr::MeikiState::default());
            app.manage(manga_ocr::MangaState::default());

            let reader_popup_builder = tauri::WebviewWindowBuilder::new(
                app,
                "reader-popup",
                tauri::WebviewUrl::App("app/reader-popup.html".into()),
            )
            .title("Dictionary")
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .visible(false)
            .focused(false)
            .accept_first_mouse(true)
            .skip_taskbar(true)
            .inner_size(500., 380.)
            .content_protected(true)
            .initialization_script_for_all_frames(platform::platform_prelude());
            #[cfg(target_os = "linux")]
            let reader_popup_builder = reader_popup_builder.focusable(platform::wayland_overlay_unavailable());
            let reader_popup = reader_popup_builder.build()?;
            make_panel(&handle, &service, &reader_popup);
            // Opt-in native regression: only the API popup, no source restore or OCR.
            #[cfg(debug_assertions)]
            if std::env::var_os("KIMOCHI_READER_POPUP_SMOKE").is_some() {
                let smoke_app = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let result = reader::popover::smoke(smoke_app.clone()).await;
                    eprintln!("reader-popup-smoke: {result:?}");
                    smoke_app.exit(if result.is_ok() { 0 } else { 1 });
                });
                return Ok(());
            }

            let logger = {
                let service = service.clone();
                Arc::new(move |value: Value| service.log(value)) as Arc<dyn Fn(Value) + Send + Sync>
            };
            let hooker = Arc::new(texthooker::Texthooker::new(store.clone(), logger));
            hooker.start();
            app.manage(hooker);

            spawn_source_restore(service.clone());

            panels::create_eager(&handle, &store)?;
            // Shared first-run omission: every platform previously ignored the persisted flag.
            let initial_panel = onboarding_panel(store.get("hasCompletedOnboarding")?.as_ref());
            panels::with_panel(&handle, initial_panel, {
                let store = store.clone();
                let initial_panel = initial_panel.to_string();
                move |app, turn| {
                    let action = if initial_panel == panels::MAIN { "show_inactive" } else { "show" };
                    let _ = panels::act(turn, app, &store, &initial_panel, action, None);
                }
            });

            let overlay_builder = tauri::WebviewWindowBuilder::new(
                app,
                OVERLAY,
                tauri::WebviewUrl::App("ui/overlay.html".into()),
            )
            .title("Kimochi OCR Overlay")
            // This WebView owns the automatic observer and dictionary backend even
            // when the reader is in another app. macOS 14+ supports this policy.
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
            .decorations(false)
            .transparent(true)
            .accept_first_mouse(true)
            .resizable(false)
            .shadow(false)
            .always_on_top(true)
            .content_protected(true)
            .focused(false)
            .inner_size(1728., 1117.)
            // Only the overlay hosts the Yomitan backend. Panels get the relay shim
            // instead, so there is never a second writer on the same IndexedDB.
            .initialization_script_for_all_frames(platform::platform_prelude())
            .initialization_script_for_all_frames(include_str!("../../host/shim.js"))
            .on_navigation({
                // `tauri dev` loads every page from `build.devUrl` (the Vite dev server in
                // `vite.dev.config.ts`) rather than the `tauri://` protocol, so a dev build must
                // also accept that origin or the overlay's own page is blocked and the
                // dictionary backend never starts.
                // Bundles (custom-protocol) stay locked to the app origin
                // (`tauri://localhost` on macOS; see `platform::app_origin`).
                let dev_origin = if cfg!(dev) {
                    app.config().build.dev_url.as_ref().map(|u| u.origin())
                } else {
                    None
                };
                move |u| {
                    u.as_str() == "about:blank"
                        || platform::is_app_url(u)
                        || dev_origin
                            .as_ref()
                            .is_some_and(|origin| &u.origin() == origin)
                }
            });
            #[cfg(target_os = "linux")]
            let overlay_builder = {
                let overlay_builder = overlay_builder.focusable(false);
                if platform::wayland_layer_overlay() {
                    overlay_builder.visible(false).resizable(true).inner_size(1., 1.)
                } else {
                    // Unsupported Wayland keeps only the hidden OCR host, never a detached reader.
                    overlay_builder.visible(false)
                }
            };
            let overlay = overlay_builder.build()?;
            #[cfg(target_os = "linux")]
            let ignore_cursor_events = !platform::wayland_overlay_unavailable();
            #[cfg(not(target_os = "linux"))]
            let ignore_cursor_events = true;
            #[cfg(target_os = "linux")]
            if !platform::wayland_layer_overlay() {
                overlay.set_ignore_cursor_events(ignore_cursor_events)?;
            }
            #[cfg(not(target_os = "linux"))]
            overlay.set_ignore_cursor_events(ignore_cursor_events)?;
            // Pointing at a word must not rearrange the reader's desktop, and clicking
            // one must not take the keyboard out of their game. See `platform::make_panel`.
            make_panel(&handle, &service, &overlay);

            // The dictionary popup's own window. Small, borderless and always on top,
            // so the original popup renders as a floating native window instead of an
            // iframe clipped to whichever panel happened to own the scanned text.
            //
            // It is a real window and takes the mouse normally — there is no invisible
            // surface over the desktop to get wrong. It never takes focus on its own:
            // the reader is pointing at a word in another window.
            {
                let asset = app
                    .asset_resolver()
                    .get("/spike/panel-shim.js".into())
                    .ok_or_else(|| {
                        std::io::Error::other("popup host needs /spike/panel-shim.js")
                    })?;
                let shim = String::from_utf8(asset.bytes)
                    .map_err(|_| std::io::Error::other("panel-shim.js is not valid UTF-8"))?;
                let window_builder = tauri::WebviewWindowBuilder::new(
                    app,
                    POPUP_HOST,
                    tauri::WebviewUrl::App("ui/popup-host.html".into()),
                )
                .title("Dictionary")
                .decorations(false)
                .transparent(true)
                .accept_first_mouse(true)
                .resizable(false)
                .shadow(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .inner_size(400., 250.)
                .initialization_script_for_all_frames(platform::platform_prelude())
                .initialization_script_for_all_frames(panels::label_prelude(POPUP_HOST) + &shim);
                #[cfg(target_os = "linux")]
                let window_builder = window_builder.focusable(platform::wayland_overlay_unavailable());
                let window = window_builder.build()?;
                let _ = window.set_content_protected(true);
                // The dictionary is hovered and clicked while the reader stays in their
                // game; a panel is what lets it be used without activating this app.
                make_panel(&handle, &service, &window);
            }

            // The app menu belongs in the macOS menu bar. Elsewhere a window menu would be
            // attached to every window, including the transparent overlay.
            #[cfg(target_os = "macos")]
            {
                let menu = tauri::menu::Menu::default(app.handle())?;
                let panel_menu = tauri::menu::SubmenuBuilder::new(app, "Panels")
                    .text("log", "Kimochi")
                    .text("choose-source", "Select Source")
                    .text("settings", "Settings")
                    .text("yomitan", "Yomitan")
                    .text("diagnostics", "Diagnostics")
                    .text("fixture", "Japanese Fixture")
                    .text("fixture-chunks", "Split-Word Fixture")
                    .build()?;
                menu.append(&panel_menu)?;
                app.set_menu(menu)?;
            }
            {
                let store = store.clone();
                app.on_menu_event(move |app, event| {
                    let label = event.id().as_ref();
                    if label == "choose-source" {
                        let _ = choose_source(app, &store);
                    } else if panels::spec(label).is_some() {
                        // A lazy panel is built in a later main-thread turn, never inside
                        // this callback; an existing one is shown at once, as before.
                        let (store, target) = (store.clone(), label.to_string());
                        panels::with_panel(app, label, move |app, turn| {
                            let _ = panels::act(turn, app, &store, &target, "show", None);
                        });
                    }
                });
            }

            tray::setup(&handle, &store).map_err(std::io::Error::other)?;
            let shortcuts = hotkeys::apply(&handle, &store);
            record(
                &handle,
                &service,
                json!({ "check": "hotkeys-applied", "result": shortcuts }),
            );
            watcher::start(&handle, &service);
            gamepad::start(&handle, &service);

            {
                // Sleep and wake: the macOS equivalent of Electron's powerMonitor.
                let sleep_handle = handle.clone();
                let wake_handle = handle.clone();
                let activate_handle = handle.clone();
                let activate_service = service.clone();
                platform::observe_workspace(
                    move || {
                        let _ = sleep_handle.emit("system-suspend", json!({}));
                    },
                    move || {
                        let _ = wake_handle.emit("system-resume", json!({}));
                    },
                    move |name| {
                        activate_service.view.lock().unwrap().frontmost_app = Some(name.clone());
                        let _ = activate_handle.emit(
                            "frontmost-app",
                            json!({ "appName": name, "pid": platform::frontmost_pid_for(&name) }),
                        );
                    },
                );
            }

            spawn_state_broadcast(handle.clone(), service.clone());
            #[cfg(target_os = "windows")]
            match platform::start_mouse_guard(&handle) {
                Ok(()) => service.log(json!({"check": "overlay-click-guard", "installed": true})),
                Err(error) => service.log(json!({"check": "overlay-click-guard", "error": error})),
            }
            spawn_cursor_poll(handle.clone(), service.clone());
            spawn_source_watch(handle.clone(), service.clone());
            spawn_focus_watch(handle.clone(), service.clone());
            #[cfg(target_os = "windows")]
            platform::start_fullscreen_watch(&handle, service.clone());
            spawn_display_watch(handle.clone(), store.clone());
            // No download starts at launch: a local engine selected before its models were
            // downloaded (an upgrade from a build that bundled them) reports `absent`, and the
            // user starts it from Settings → OCR, where the button names the size.
            spawn_capabilities_watch(handle.clone(), service.clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Kimochi runtime")
        .run(|app, event| {
            #[cfg(target_os = "linux")]
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                if platform::gamescope::prepare_exit(app, code.unwrap_or(0)) { api.prevent_exit(); }
            }
            // Every quit path (tray, menu, main window, app_quit) ends here: pause model
            // downloads so their partial files are kept and resumed next launch.
            if let tauri::RunEvent::Exit = event {
                model_store::shutdown(app);
            }
        });
}

/// Only an explicitly completed setup skips onboarding; absent or malformed values are first run.
fn onboarding_panel(completed: Option<&Value>) -> &'static str {
    if completed.and_then(Value::as_bool) == Some(true) { panels::MAIN } else { "welcome" }
}

/// Resolve the previously selected source against a fresh enumeration, off the UI
/// thread.
///
/// Capture source ids are session-scoped, so the persisted id is a hint, not an
/// address. Copying it straight into the selection would claim a restore that has not
/// happened, and on a recycled id it would silently point at a different window. When
/// the description cannot be resolved unambiguously the app stays unselected and says
/// so, which is the honest outcome.
///
/// Enumeration needs Screen Recording, but does not prompt for it: capture-core
/// preflights the permission and returns an error instead of opening a dialog.
fn spawn_source_restore(service: Shared) {
    std::thread::spawn(move || {
        #[cfg(target_os = "linux")]
        if platform::gamescope::active()
            && service.backend.lock().is_ok_and(|backend| backend.capabilities().system_picker_required)
        {
            // Gamescope shares its composed game screen without a picker UI.
            // Its portal may provide no restore token, so saved source ids alone
            // cannot restore a stream. Reopen sharing even on first launch.
            service.set_status("Selecting the Gaming Mode screen…");
            match sources::pick_source(&service) {
                Ok(result) if result["picked"] == json!(true) => {
                    service.set_status("Gaming Mode screen selected.");
                    service.log(json!({"check":"gaming-mode-source-select","status":"selected"}));
                }
                Ok(result) => {
                    let message = kimochi_capture::last_portal_pick_error()
                        .unwrap_or_else(|| result["message"].as_str().unwrap_or("Screen sharing was not selected.").to_string());
                    service.set_status(format!("Gaming Mode screen not selected: {message} Choose Source to retry."));
                    service.log(json!({"check":"gaming-mode-source-select","status":"not-selected","reason":result["reason"],"message":message}));
                }
                Err(error) => {
                    service.set_status(format!("Could not select the Gaming Mode screen: {error}. Choose Source to retry."));
                    service.log(json!({"check":"gaming-mode-source-select","status":"error","error":error}));
                }
            }
            return;
        }
        let Some(saved) = service
            .settings
            .get("lastSelectedSource")
            .ok()
            .flatten()
            .filter(|v| v.is_object())
        else {
            return;
        };
        #[cfg(target_os = "linux")]
        if service.backend.lock().is_ok_and(|backend| backend.capabilities().system_picker_required)
            && !service.settings.get_or::<String>(PORTAL_TOKEN_KEY, String::new()).is_empty()
        {
            service.set_status("Restoring the previous screen share…");
            match sources::pick_source(&service) {
                Ok(result) if result["picked"] == json!(true) => {
                    service.set_status("Restored the previous screen share.");
                }
                Ok(result) => service.set_status(format!("Screen share not restored: {} Choose New Source to share again.", kimochi_capture::last_portal_pick_error().as_deref().unwrap_or(result["message"].as_str().unwrap_or("Sharing was cancelled.")))),
                Err(error) => service.set_status(format!("Could not restore screen share: {error}. Choose New Source to share again.")),
            }
            return;
        }
        let live = match service.backend.lock() {
            Ok(mut backend) => match backend.enumerate() {
                Ok(live) => live,
                Err(e) => {
                    service.set_status(format!(
                        "Could not restore the previous source ({}). Choose a source.",
                        e.message
                    ));
                    return;
                }
            },
            Err(_) => return,
        };
        let name = saved
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("the previous source")
            .to_string();
        match sources::resolve_saved_source(&saved, &live) {
            sources::Restored::Exact(id) | sources::Restored::Matched(id) => {
                *service.selection.lock().unwrap() = Some(id.clone());
                // Persist the live id so the next launch starts from a current hint.
                let _ = service
                    .settings
                    .set_path(&["lastSelectedSource", "sourceId"], json!(id));
                service.set_status(format!("Restored source · {name}"));
            }
            sources::Restored::Ambiguous => service.set_status(format!(
                "Several sources match {name}; choose the one you want."
            )),
            sources::Restored::Gone => {
                service.set_status(format!("{name} is no longer available; choose a source."))
            }
        }
    });
}

/// Re-class a finished window as a non-activating panel, and record the outcome.
///
/// Recorded rather than silently attempted: whether this window activates the app when
/// it is clicked is the difference between a reader's window order staying still and
/// being rewritten under them, and the failure is invisible from the outside.
fn make_panel(app: &tauri::AppHandle, service: &Shared, window: &tauri::WebviewWindow) {
    let value = match platform::make_panel(window) {
        Ok(converted) => json!({
            "check": "window-panel",
            "window": window.label(),
            "panel": converted,
        }),
        Err(error) => json!({
            "check": "window-panel-failed",
            "window": window.label(),
            "error": error,
            "note": "Clicking this window will activate the app, which reorders every window it owns.",
        }),
    };
    record(app, service, value);
}

/// Emits `state` (the full snapshot) whenever anything a panel renders has changed.
///
/// Panels would otherwise poll `snapshot()` on a timer; a cheap fingerprint means the
/// payload is only built and sent when it would actually differ.
fn spawn_state_broadcast(handle: tauri::AppHandle, service: Shared) {
    std::thread::spawn(move || {
        let mut previous = String::new();
        let mut previous_context = application_context::current(&service).map(|c| c.id);
        loop {
            std::thread::sleep(Duration::from_millis(100));
            let context = application_context::current(&service).map(|c| c.id);
            if context != previous_context {
                previous_context = context;
                let mut view = service.view.lock().unwrap();
                view.scan = None;
                view.regions.clear();
                view.revision += 1;
            }
            let fingerprint = {
                let v = service.view.lock().unwrap();
                format!(
                    "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{:?}|{:?}",
                    v.revision,
                    v.action_seq,
                    v.scanning,
                    v.auto_ocr,
                    v.overlay_visible,
                    v.text_overlay_visible,
                    v.debug_overlay_visible,
                    v.dictionary,
                    v.dismiss,
                    v.logs.len(),
                    v.accessibility,
                    (&v.status, &v.frontmost_app),
                    v.source_focus,
                )
            };
            if fingerprint == previous {
                continue;
            }
            previous = fingerprint;
            let _ = handle.emit("state", snapshot_value(&service));
        }
    });
}

/// The windows whose published regions can become a native input region.
const NATIVE_INPUT_WINDOWS: [&str; 2] = [OVERLAY, POPUP_HOST];

/// Whether one window's click-through is a native input region or the poll's toggle.
#[derive(Debug)]
enum InputShape {
    /// Not asked yet: the window did not exist when the poll last looked.
    Unknown,
    /// The OS has no native regions (macOS, Windows, Wayland): the poll toggles
    /// `set_ignore_cursor_events`, as it always has.
    Polled,
    /// The window server hit-tests the published regions itself (X11 SHAPE). The poll
    /// never calls `set_ignore_cursor_events` on it: on X11 that setter is an input
    /// shape too, sent on GDK's connection, and would overwrite this one.
    Native {
        /// Window bounds then local rectangles, as last applied, so the shape is only
        /// rewritten when one of them changes.
        applied: Option<Vec<[f64; 4]>>,
        /// The last attempt failed (already logged once).
        failing: bool,
    },
}

/// Bring every native-region window's input shape up to date with what its window
/// published, and return the windows that just turned out to have no native regions
/// after all (the caller hands them back to the poll).
///
/// The poll thread is the only writer, on purpose: regions are replaced by the
/// `regions` command but also cleared from several other places (a new source, `clear`,
/// a lost capture), and the overlay's input also depends on its visibility flag. Reading
/// the settled state here once per frame covers all of them, and one writer cannot apply
/// two updates out of order. Hit-testing itself is native, so the only latency left is
/// up to one frame after the rectangles change.
///
/// `refresh` rewrites the shapes even when unchanged, in case GTK reset a window's
/// input shape behind our back (it does not today; this keeps a wrong shape short-lived).
fn sync_input_shapes(
    handle: &tauri::AppHandle,
    service: &Service,
    shapes: &mut HashMap<&'static str, InputShape>,
    refresh: bool,
) -> Vec<&'static str> {
    let mut fell_back = Vec::new();
    for label in NATIVE_INPUT_WINDOWS {
        let state = shapes.entry(label).or_insert(InputShape::Unknown);
        if matches!(state, InputShape::Polled) {
            continue;
        }
        let Some(window) = handle.get_webview_window(label) else {
            continue;
        };
        if matches!(state, InputShape::Unknown) {
            // Probing with "nothing is interactive" is harmless everywhere: where it is
            // applied, the real regions follow below in the same frame.
            *state = match platform::set_input_regions(&window, Some(&[])) {
                Ok(true) => InputShape::Native {
                    applied: None,
                    failing: false,
                },
                Ok(false) => InputShape::Polled,
                Err(e) => {
                    eprintln!("input regions: {label}: {e}; polling instead");
                    InputShape::Polled
                }
            };
        }
        let InputShape::Native { applied, failing } = state else {
            continue;
        };
        let wanted: Vec<Region> = {
            let v = service.view.lock().unwrap();
            if label == OVERLAY && !v.overlay_visible {
                Vec::new()
            } else {
                v.regions.get(label).cloned().unwrap_or_default()
            }
        };
        // Regions are desktop points; the shape is window-local CSS pixels, which are
        // the same size as desktop points.
        let Ok(bounds) = platform::desktop_bounds(&window) else {
            continue;
        };
        let local: Vec<Rect> = wanted
            .iter()
            .map(|r| Rect {
                x: r.x - bounds.x,
                y: r.y - bounds.y,
                width: r.width,
                height: r.height,
            })
            .collect();
        let key: Vec<[f64; 4]> = std::iter::once(bounds)
            .chain(local.iter().copied())
            .map(|r| [r.x, r.y, r.width, r.height])
            .collect();
        if !refresh && applied.as_ref() == Some(&key) {
            continue;
        }
        match platform::set_input_regions(&window, Some(&local)) {
            Ok(true) => {
                *applied = Some(key);
                *failing = false;
            }
            Ok(false) => {
                *state = InputShape::Polled;
                fell_back.push(label);
            }
            Err(e) => {
                // Retried on the next change or refresh; logged once per failing run.
                if !*failing {
                    eprintln!("input regions: {label}: {e}");
                }
                *failing = true;
            }
        }
    }
    fell_back
}

/// 16 ms native cursor poll driving overlay click-through. It does not test pixel
/// alpha and does not wait for an unrelated foreground-app event, which is what keeps
/// capture alive through a mouse drag.
///
/// Where the OS supports native input regions (`sync_input_shapes`), the poll keeps the
/// window's shape in step with its regions instead of toggling click-through, and still
/// does everything else: dismissal, focus, and the `pointer` event.
fn spawn_cursor_poll(handle: tauri::AppHandle, service: Shared) {
    std::thread::spawn(move || {
        let mut history: HashMap<String, PointerHistory> = HashMap::new();
        let mut was_down = false;
        let mut last_point: Option<(f64, f64)> = None;
        let mut was_over_overlay = false;
        let mut noted_focus: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut last_modifiers = Modifiers::default();
        let mut last_buttons = false;
        let mut ticks: u64 = 0;
        let mut shapes: HashMap<&'static str, InputShape> = HashMap::new();
        loop {
            std::thread::sleep(Duration::from_millis(16));
            ticks = ticks.wrapping_add(1);
            if handle.get_webview_window(OVERLAY).is_none() {
                break;
            }
            #[cfg(target_os = "windows")]
            platform::update_mouse_guard(&handle, &service);
            // About every two seconds, rewrite native shapes even when unchanged.
            let refresh = ticks.is_multiple_of(125);
            for label in sync_input_shapes(&handle, &service, &mut shapes, refresh) {
                // Handed back to the poll: click-through until a verdict says otherwise,
                // and no history, so the next interactive verdict counts as a change.
                history.remove(label);
                if let Some(window) = handle.get_webview_window(label) {
                    let _ = window.set_ignore_cursor_events(true);
                }
            }
            if let Some(platform::PointerSample {
                x,
                y,
                down,
                modifiers,
            }) = platform::desktop_cursor()
            {
                if down && !was_down {
                    reader::popover::pointer_down(&handle, x, y);
                }
                let moved = last_point.is_none_or(|(px, py)| px != x || py != y);
                last_point = Some((x, y));
                let mut changed: Vec<(String, bool)> = Vec::new();
                let mut focus: Vec<String> = Vec::new();
                {
                    let mut v = service.view.lock().unwrap();
                    // The overlay is the one window whose regions survive being
                    // hidden, because hiding it is a view flag rather than a close.
                    let hidden: Vec<&str> = if v.overlay_visible {
                        vec![]
                    } else {
                        vec![OVERLAY]
                    };
                    if dismissed(&v.regions, &hidden, x, y, down, was_down) {
                        v.dismiss += 1;
                    }
                    let mut interactive_anywhere = false;
                    for (label, rects) in &v.regions {
                        let was = *history.get(label).unwrap_or(&PointerHistory::default());
                        let verdict = classify_pointer(
                            rects,
                            !hidden.contains(&label.as_str()),
                            x,
                            y,
                            down,
                            moved,
                            was,
                        );
                        interactive_anywhere |= verdict.interactive;
                        if verdict.interactive != was.interactive {
                            changed.push((label.clone(), verdict.interactive));
                        }
                        if verdict.take_focus {
                            focus.push(label.clone());
                        }
                        history.insert(
                            label.clone(),
                            PointerHistory {
                                interactive: verdict.interactive,
                                down,
                                over_target: verdict.over_target,
                            },
                        );
                    }
                    // A window that stopped publishing rectangles has no claim left —
                    // and has to be told, or it keeps the mouse it was last granted.
                    // The dictionary's window does exactly this between two lookups:
                    // it stays on screen with nothing in it, and an empty window that
                    // still swallows clicks is worse than one that is merely there.
                    for (label, was) in history.iter() {
                        if was.interactive && !v.regions.contains_key(label) {
                            changed.push((label.clone(), false));
                        }
                    }
                    history.retain(|label, _| v.regions.contains_key(label));
                    v.interactive = interactive_anywhere;
                }
                was_down = down;
                // What the overlay cannot see for itself: where the pointer is, and
                // which modifiers are held.
                //
                // The reader's own application owns both while they read. The overlay
                // is click-through everywhere except over the words, so it sees no
                // `mousemove`, and it is not the key window, so it sees no `keydown` —
                // which is the whole reason a scan used to need a click first. Sent
                // here instead, the original scanner behaves exactly as it does in a
                // browser and no window has to take focus to make a lookup happen.
                //
                // Bounded rather than streamed: only while the overlay has something
                // to light up, only over the display it covers, and at half the poll's
                // rate while merely moving. A modifier or a button going up or down is
                // sent at once — holding Shift without moving is how a reader asks for
                // the word already under the pointer.
                let due = (moved && ticks.is_multiple_of(2))
                    || modifiers != last_modifiers
                    || down != last_buttons;
                if due {
                    last_modifiers = modifiers;
                    last_buttons = down;
                    let (wanted, over, blocked) = {
                        let v = service.view.lock().unwrap();
                        (
                            v.regions.contains_key(OVERLAY) && v.overlay_visible,
                            v.origin.is_some_and(|o| {
                                x >= o.x && y >= o.y && x < o.x + o.width && y < o.y + o.height
                            }),
                            // The dictionary floats above the overlay, so a point
                            // inside it is over the popup's own text, not over the word
                            // underneath. Scanning through it would look up whatever
                            // the popup happens to be covering.
                            v.regions.iter().any(|(label, rects)| {
                                label != OVERLAY && rects.iter().any(|r| r.contains(x, y))
                            }),
                        )
                    };
                    if wanted && (over || was_over_overlay) {
                        let _ = handle.emit(
                            "pointer",
                            json!({
                                "x": x,
                                "y": y,
                                "over": over,
                                "blocked": blocked,
                                "down": down,
                                "shift": modifiers.shift,
                                "ctrl": modifiers.ctrl,
                                "alt": modifiers.alt,
                                "meta": modifiers.meta,
                            }),
                        );
                    }
                    was_over_overlay = over;
                }
                for (label, interactive) in changed {
                    // A native input region already routes the pointer; toggling here
                    // would overwrite it (see `InputShape::Native`).
                    if matches!(shapes.get(label.as_str()), Some(InputShape::Native { .. })) {
                        continue;
                    }
                    if let Some(window) = handle.get_webview_window(&label) {
                        let _ = window.set_ignore_cursor_events(!interactive);
                    }
                }
                // Arriving on the dictionary is what takes the keyboard — a reader
                // whose pointer has reached it has reached for it. Resting on it does
                // not, scanned text does not ask for focus at all, and nothing else on
                // the transparent desktop does either.
                for label in focus {
                    let app = handle.clone();
                    let service = service.clone();
                    let first = noted_focus.insert(label.clone());
                    let _ = handle.run_on_main_thread(move || {
                        let Some(w) = app.get_webview_window(&label) else {
                            return;
                        };
                        // On macOS a non-activating panel can take the keyboard while
                        // the game stays active, so arriving is enough. Elsewhere taking
                        // the keyboard activates Kimochi, which must stay an explicit
                        // editing action (reader_popup_focus), never a hover.
                        let taken = if platform::HOVER_PROMOTES_KEY {
                            platform::promote_to_key(&w)
                        } else {
                            Ok(false)
                        };
                        // Once per window per session. Whether a non-activating panel
                        // can be given the keyboard while another application stays
                        // active is AppKit's answer, not ours, and "the dictionary
                        // ignores the keyboard" reads identically either way.
                        if first {
                            record(
                                &app,
                                &service,
                                json!({
                                    "check": "window-took-focus",
                                    "window": w.label(),
                                    "taken": taken.as_ref().ok(),
                                    "error": taken.err(),
                                }),
                            );
                        }
                    });
                }
            }
        }
    });
}

/// Watches whether the captured window is still the one in front, and still there.
///
/// Separate from `spawn_source_watch`, which follows where a window *is*: this follows
/// whether its text should be on screen at all. Both are polls because macOS has no
/// notification for "a different window of the same application came forward" — the
/// workspace notification fires per *application*, and a reader with two windows of one
/// app open would keep seeing text from the wrong one.
///
/// Changes are announced immediately rather than waiting for the next view broadcast:
/// text that belongs to a window the reader just left should go at once, and its click
/// targets with it.
fn spawn_focus_watch(handle: tauri::AppHandle, service: Shared) {
    std::thread::spawn(move || {
        let own_pid = std::process::id();
        let mut previous: Option<SourceFocus> = None;
        loop {
            let watching = service.watching.lock().unwrap().clone();
            let watched = watching
                .as_deref()
                .and_then(SourceId::parse)
                .filter(|id| id.is_window() && id.is_local());
            let bounds = watched.as_ref().and_then(platform::window_bounds);
            let current = source_focus(
                watching.as_deref(),
                platform::front_window(),
                own_pid,
                bounds,
                previous.unwrap_or_default(),
            );
            if previous != Some(current) {
                previous = Some(current);
                service.view.lock().unwrap().source_focus = current;
                let _ = handle.emit("source-focus", current);
            }
            // Controller mode's keys are global; switching to any other app ends it.
            let source_pid = watched.as_ref().and_then(SourceId::pid);
            gamepad::release_if_elsewhere(&handle, platform::frontmost_pid(), source_pid);
            std::thread::sleep(Duration::from_millis(150));
        }
    });
}

/// Pulls panels back onto a live display when the screen layout changes, so
/// unplugging a monitor cannot strand a window offscreen. AppKit placement has to run
/// on the main thread, hence the hop.
fn spawn_display_watch(handle: tauri::AppHandle, settings: Arc<Settings>) {
    std::thread::spawn(move || {
        let layout = || {
            platform::desktop_displays()
                .iter()
                .map(|r| format!("{},{},{},{}", r.x, r.y, r.width, r.height))
                .collect::<Vec<_>>()
                .join(";")
        };
        let mut previous = layout();
        loop {
            std::thread::sleep(Duration::from_millis(1000));
            let current = layout();
            if current == previous {
                continue;
            }
            previous = current;
            // The popup's window belongs to the work area of the display the scanned
            // text is on, so a rearranged desktop changes where it may be placed.
            let _ = handle.emit("display-layout", json!({}));
            let handle_for_main = handle.clone();
            let settings = settings.clone();
            let _ = handle.run_on_main_thread(move || {
                panels::recover_bounds(&handle_for_main, &settings);
            });
        }
    });
}

/// Follows the tracked window's geometry. Polls CoreGraphics for one window id
/// rather than re-enumerating shareable content, which would be far too expensive at
/// this cadence.
fn spawn_source_watch(handle: tauri::AppHandle, service: Shared) {
    std::thread::spawn(move || {
        let mut last: Option<(Rect, bool)> = None;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let watching = service.watching.lock().unwrap().clone();
            let Some(source_id) = watching else {
                last = None;
                continue;
            };
            let Some(window) = SourceId::parse(&source_id).filter(|id| id.is_window()) else {
                continue;
            };
            let Some((rect, on_screen)) = platform::desktop_window_bounds(&window) else {
                continue;
            };
            let changed = last.is_none_or(|(prev, was_on)| {
                was_on != on_screen
                    || (prev.x - rect.x).abs() > 0.5
                    || (prev.y - rect.y).abs() > 0.5
                    || (prev.width - rect.width).abs() > 0.5
                    || (prev.height - rect.height).abs() > 0.5
            });
            if changed {
                last = Some((rect, on_screen));
                let _ = handle.emit(
                    "source-bounds",
                    json!({ "sourceId": source_id, "bounds": rect, "onScreen": on_screen }),
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn onboarding_requires_an_explicit_completion_flag() {
        assert_eq!(super::onboarding_panel(None), "welcome");
        assert_eq!(super::onboarding_panel(Some(&serde_json::json!(false))), "welcome");
        assert_eq!(super::onboarding_panel(Some(&serde_json::json!("true"))), "welcome");
        assert_eq!(super::onboarding_panel(Some(&serde_json::json!(true))), crate::panels::MAIN);
    }

    use super::*;

    #[test]
    fn the_selected_source_carries_its_kind() {
        let window = with_source_kind(json!({"sourceId": "macos:window:1:2", "type": "window"}));
        assert_eq!(window["kind"], "window");
        let display = with_source_kind(json!({"sourceId": "macos:display:1", "type": "screen"}));
        assert_eq!(display["kind"], "display");
        let legacy = with_source_kind(json!({"type": "screen"}));
        assert_eq!(legacy["kind"], "display");
    }

    #[test]
    fn notebook_ack_cannot_clear_a_newer_request() {
        let path =
            std::env::temp_dir().join(format!("kimochi-notebook-ack-{}.json", std::process::id()));
        let settings = Settings::load(path.clone());
        settings
            .set(
                "notebookEditRequest",
                json!({"requestId":"new", "entryId":"cat", "sessionId":"game"}),
            )
            .unwrap();
        assert!(!acknowledge_notebook_request(&settings, "old").unwrap());
        assert_eq!(
            settings.get("notebookEditRequest").unwrap().unwrap()["requestId"],
            "new"
        );
        assert!(acknowledge_notebook_request(&settings, "new").unwrap());
        assert_eq!(
            settings.get("notebookEditRequest").unwrap(),
            Some(Value::Null)
        );
        assert!(!acknowledge_notebook_request(&settings, "new").unwrap());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_repeated_result_for_one_frame_is_not_republished() {
        // The overlay may publish more than once for a frame; only the first counts,
        // so an echo cannot bump the revision and force a full re-render.
        assert!(should_publish(None, 7));
        assert!(should_publish(Some(6), 7));
        assert!(!should_publish(Some(7), 7));
    }

    #[test]
    fn a_result_without_a_frame_id_always_publishes() {
        // Text-only engines may send a result with no id; dedup must not swallow it.
        let no_id: Option<u64> = None;
        assert!(no_id.is_none_or(|id| should_publish(Some(7), id)));
    }

    #[test]
    fn ready_status_matches_the_rust_scan_wording() {
        assert_eq!(ready_status(18), "Scan ready · 18 text annotations");
        assert_eq!(ready_status(0), "Scan ready · 0 text annotations");
    }

    #[test]
    fn history_ids_are_distinct_even_within_one_millisecond() {
        let ids: std::collections::HashSet<String> = (0..2000).map(|_| history_id()).collect();
        // A colliding id would make history_delete remove more than one entry.
        assert_eq!(ids.len(), 2000);
    }

    #[test]
    fn concurrent_history_edits_are_all_preserved() {
        let settings = Arc::new(Settings::load(
            std::env::temp_dir().join(format!("kimochi-history-test-{}.json", std::process::id())),
        ));
        settings.set("scannedTextHistory", json!([])).unwrap();
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let settings = settings.clone();
                std::thread::spawn(move || {
                    for i in 0..5 {
                        settings
                            .update_path(&HISTORY_KEY, |current| {
                                let mut list = current
                                    .and_then(Value::as_array)
                                    .cloned()
                                    .unwrap_or_default();
                                list.insert(0, json!({"id": format!("{t}-{i}")}));
                                list.truncate(HISTORY_LIMIT);
                                Value::Array(list)
                            })
                            .unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let list = settings.get("scannedTextHistory").unwrap().unwrap();
        // 40 writes, none lost to another thread's read-modify-write window.
        assert_eq!(list.as_array().unwrap().len(), 40);
    }

    #[test]
    fn history_is_capped_and_keeps_the_newest() {
        let settings = Arc::new(Settings::load(
            std::env::temp_dir().join(format!("kimochi-history-cap-{}.json", std::process::id())),
        ));
        for i in 0..HISTORY_LIMIT + 10 {
            settings
                .update_path(&HISTORY_KEY, |current| {
                    let mut list = current
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    list.insert(0, json!({"id": i.to_string()}));
                    list.truncate(HISTORY_LIMIT);
                    Value::Array(list)
                })
                .unwrap();
        }
        let list = settings.get("scannedTextHistory").unwrap().unwrap();
        let list = list.as_array().unwrap();
        assert_eq!(list.len(), HISTORY_LIMIT);
        assert_eq!(list[0]["id"], (HISTORY_LIMIT + 9).to_string());
    }

    #[test]
    fn ocr_endpoint_confines_plain_http_to_loopback() {
        // Auto-OCR calls this on a timer and it carries captured pixels, so plain HTTP
        // off-host stays refused.
        assert!(validate_service_url("https://example.test/detect-text").is_ok());
        assert!(validate_service_url("http://localhost:3000/detect-text").is_ok());
        assert!(validate_service_url("http://127.0.0.1:3000/detect-text").is_ok());
        assert!(validate_service_url("http://192.168.1.50:3000/detect-text").is_err());
        assert!(validate_service_url("https://192.168.1.50:3000/detect-text").is_ok());
    }

    #[test]
    fn configured_dictionary_api_accepts_plain_http_including_lan() {
        // Electron parity: the user is pointing the app at their own server.
        assert!(validate_configured_api_url("http://192.168.1.50:8765/tokenize").is_ok());
        assert!(validate_configured_api_url("http://my-nas.local:19633/tokenize").is_ok());
        assert!(validate_configured_api_url("http://10.0.0.7:5000/termEntries").is_ok());
        assert!(validate_configured_api_url("http://localhost:19633/tokenize").is_ok());
        assert!(validate_configured_api_url("https://dict.example.test/tokenize").is_ok());
    }

    #[test]
    fn every_service_url_rejects_credentials_query_and_odd_schemes() {
        for check in [validate_service_url, validate_configured_api_url] {
            assert!(check("https://user:pw@example.test/x").is_err());
            assert!(check("https://example.test/x?key=secret").is_err());
            assert!(check("ftp://example.test/x").is_err());
            assert!(check("file:///etc/passwd").is_err());
            assert!(check("not a url").is_err());
        }
    }
}
