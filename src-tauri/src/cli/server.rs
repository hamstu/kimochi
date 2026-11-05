//! The running app's side of the command line: a loopback listener that answers the `kimochi`
//! command (cli/client.rs). See endpoint.rs for the file it publishes and the wire format, and
//! COMMANDS.md → "Command line" for every method.
//!
//! Everything here goes through the same paths as the app's own windows: settings through
//! `apply_setting` (so `settings:changed` and its side effects follow), actions through
//! `actions::dispatch`, sources through `sources`, and the Log's sessions through the Log's own
//! request channel (`reader:request` / `reader:response`, frontend/texthooker/host.ts), because
//! the Log window is the only writer of its files.
use super::endpoint::{self, Endpoint, Request, MAX_REQUEST, PROTOCOL};
use crate::state::Shared;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Listener, Manager};

/// The longest `scan --wait` may wait for a result.
const SCAN_WAIT_MAX: Duration = Duration::from_secs(120);
/// How long the Log may take to answer once it is up.
const LOG_REPLY: Duration = Duration::from_secs(15);
/// How long a request waits for the Log window to finish loading (a cold start).
const LOG_READY: Duration = Duration::from_secs(30);

/// Start listening and publish the endpoint. Failures are recorded, never fatal: the app runs
/// the same without its command line.
pub fn start(app: &tauri::AppHandle) -> Result<Value, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let endpoint = Endpoint {
        port,
        token: token()?,
        pid: std::process::id(),
        version: app.package_info().version.to_string(),
        flavor: endpoint::FLAVOR.to_string(),
        protocol: PROTOCOL,
    };
    let path = endpoint::endpoint_path(endpoint::FLAVOR).ok_or("no data folder")?;
    let bytes = serde_json::to_vec_pretty(&endpoint).map_err(|e| e.to_string())?;
    crate::account::write_private(&path, Some(&bytes))?;
    let app = app.clone();
    let token = endpoint.token.clone();
    std::thread::Builder::new()
        .name("kimochi-cli".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let (app, token) = (app.clone(), token.clone());
                let _ = std::thread::Builder::new()
                    .name("kimochi-cli-request".into())
                    .spawn(move || serve(&app, &token, stream));
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(json!({ "check": "cli-listener", "port": port, "endpoint": path }))
}

/// Remove the endpoint file at exit, if it is still ours (a newer launch may have replaced it).
pub fn stop() {
    let Some(path) = endpoint::endpoint_path(endpoint::FLAVOR) else { return };
    let ours = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Endpoint>(&bytes).ok())
        .is_some_and(|e| e.pid == std::process::id());
    if ours {
        let _ = std::fs::remove_file(path);
    }
}

fn token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("random: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Equal without saying how much matched.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn serve(app: &tauri::AppHandle, token: &str, stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut line = String::new();
    if BufReader::new((&stream).take(MAX_REQUEST)).read_line(&mut line).is_err() {
        return;
    }
    let _ = stream.set_read_timeout(None);
    let mut out = &stream;
    let request: Request = match serde_json::from_str(&line) {
        Ok(request) => request,
        Err(_) => return,
    };
    if !same(&request.token, token) {
        let _ = reply(&mut out, Err("invalid: wrong token. Is this the Kimochi that wrote the endpoint file?".into()));
        return;
    }
    if request.method == "watch" {
        watch(app, &stream, &request.params);
        return;
    }
    let result = handle(app, &request.method, &request.params);
    let _ = reply(&mut out, result);
}

fn reply(out: &mut impl Write, result: Result<Value, String>) -> std::io::Result<()> {
    let value = match result {
        Ok(result) => json!({ "ok": true, "result": result }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    out.write_all(&bytes)?;
    out.flush()
}

fn service(app: &tauri::AppHandle) -> Result<Shared, String> {
    app.try_state::<Shared>().map(|s| s.inner().clone()).ok_or_else(|| "busy: Kimochi is still starting".into())
}

fn str_param<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params[key].as_str().ok_or_else(|| format!("invalid: missing {key}"))
}

fn handle(app: &tauri::AppHandle, method: &str, params: &Value) -> Result<Value, String> {
    let service = service(app)?;
    match method {
        "ping" => Ok(json!({ "version": app.package_info().version.to_string(), "pid": std::process::id() })),
        "status" => Ok(status(app, &service)),
        "settings.get" => match params["key"].as_str() {
            Some(key) => Ok(service.settings.get(key)?.unwrap_or(Value::Null)),
            None => Ok(service.settings.all()),
        },
        "settings.set" => {
            let key = str_param(params, "key")?;
            if key.is_empty() {
                return Err("invalid: an empty key".into());
            }
            crate::apply_setting(app, &service.settings, key, params["value"].clone())?;
            Ok(service.settings.get(key)?.unwrap_or(Value::Null))
        }
        "action" => {
            let name = str_param(params, "name")?;
            if !crate::actions::ACTIONS.contains(&name) {
                return Err(format!("invalid: unknown action {name:?}. Run `kimochi action --list`."));
            }
            crate::actions::dispatch(app, &service, name);
            Ok(json!({ "action": name }))
        }
        "actions" => Ok(json!(crate::actions::ACTIONS)),
        "toggle" => toggle(app, &service, str_param(params, "flag")?, params["to"].as_str().unwrap_or("toggle")),
        "scan" => scan(app, &service, params),
        "ocr.engines" => Ok(engines(app, &service)),
        "ocr.set" => set_engine(app, &service, str_param(params, "engine")?),
        "source.list" => crate::sources::catalog().map(Value::from),
        "source.set" => {
            let id = find_source(str_param(params, "query")?)?;
            crate::sources::select_keeping_crop(&service, &id)?;
            Ok(source_now(&service))
        }
        "source.clear" => crate::sources::clear(&service),
        "source.choose" => crate::choose_source(app, &service.settings),
        "open" => open(app, &service, params["view"].as_str().unwrap_or("log"), params["page"].as_str()),
        "quit" => {
            crate::record(app, &service, json!({ "check": "app-quit", "window": "cli", "at": crate::now_ms() }));
            let app = app.clone();
            // After the reply has gone.
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(150));
                crate::shutdown_platform();
                app.exit(0);
            });
            Ok(json!({ "quitting": true }))
        }
        "log.recent" => {
            let limit = params["limit"].as_u64().unwrap_or(20).min(10_000) as usize;
            let dir = crate::account::active_profile_dir().ok_or("busy: the Log is still loading")?;
            Ok(json!(crate::log_lines::recent(&dir, limit)))
        }
        "log.add" => {
            let text = str_param(params, "text")?;
            if text.trim().is_empty() {
                return Err("invalid: nothing to add".into());
            }
            log_ready(app)?;
            let ingest = format!("cli-{}", token()?.get(..16).unwrap_or_default());
            reader_call(app, "host", "ingest", json!([text, "cli", crate::now_ms() as u64, ingest]), None, LOG_REPLY)?;
            Ok(json!({ "added": true }))
        }
        "session.list" => Ok(sessions_now()),
        "session.switch" => {
            let snapshot = log_ready(app)?;
            let session = find_session(&snapshot["sessions"], str_param(params, "query")?)?;
            reader_call(app, "sessions", "switchSession", json!([session["id"]]), None, LOG_REPLY)
        }
        "session.new" => {
            log_ready(app)?;
            let name = params["name"].as_str().map(str::trim).filter(|n| !n.is_empty());
            reader_call(app, "sessions", "createSession", json!([name]), None, LOG_REPLY)
        }
        "session.rename" => {
            let snapshot = log_ready(app)?;
            let manifest = &snapshot["sessions"];
            let session = match params["query"].as_str() {
                Some(query) => find_session(manifest, query)?,
                None => active_session(manifest).ok_or("invalid: no session is open")?,
            };
            let name = str_param(params, "name")?.trim();
            if name.is_empty() {
                return Err("invalid: a session needs a name".into());
            }
            reader_call(app, "sessions", "renameSession", json!([session["id"], name]), None, LOG_REPLY)?;
            Ok(json!({ "id": session["id"], "name": name }))
        }
        _ => Err(format!("invalid: unknown method {method:?}. This kimochi command may be newer than the app.")),
    }
}

// ------------------------------------------------------------------------------ status

fn status(app: &tauri::AppHandle, service: &Shared) -> Value {
    let snapshot = crate::snapshot_value(service);
    let settings = &service.settings;
    let reader = settings.get("superTexthooker").ok().flatten().unwrap_or(Value::Null);
    let input = reader["inputSource"].as_str().map(str::to_string).unwrap_or_else(|| {
        if reader["clipboardEnabled"] == json!(true) { "clipboard" } else { "ocr" }.to_string()
    });
    json!({
        "running": true,
        "pid": std::process::id(),
        "version": app.package_info().version.to_string(),
        "source": without_icon(&snapshot["source"]),
        "cropEnabled": snapshot["cropEnabled"],
        "ocrEngine": settings.get_or::<String>("ocrMode", String::new()),
        "input": input,
        "dictionary": settings.get("yomitanSettings").ok().flatten().map(|v| v["popupType"].clone()),
        "autoOcr": snapshot["autoOcrEnabled"],
        "scanning": snapshot["isScanning"],
        "overlay": snapshot["overlayVisible"],
        "textOverlay": snapshot["textOverlayVisible"],
        "status": snapshot["status"],
        "lastScan": scan_text(&snapshot["scan"]),
        "session": active_session(&sessions_now()),
        "profileDir": crate::account::active_profile_dir(),
    })
}

/// The published scan's text, or null.
fn scan_text(scan: &Value) -> Value {
    let ocr = &scan["ocr"];
    if let Some(text) = ocr["fullText"].as_str() {
        return json!(text);
    }
    match ocr["textAnnotations"].as_array() {
        Some(list) => json!(list.iter().filter_map(|a| a["description"].as_str()).collect::<Vec<_>>().join("\n")),
        None => Value::Null,
    }
}

fn source_now(service: &Shared) -> Value {
    let snapshot = crate::snapshot_value(service);
    json!({ "source": without_icon(&snapshot["source"]), "cropEnabled": snapshot["cropEnabled"] })
}

/// A source descriptor without its app icon (a data URL of a few KB that no script wants).
pub fn without_icon(source: &Value) -> Value {
    let mut source = source.clone();
    if let Some(map) = source.as_object_mut() {
        map.remove("icon");
    }
    source
}

// ------------------------------------------------------------------------------ view toggles

/// The snapshot field and the action that flips it, for each switch the CLI can set.
fn flag_of(flag: &str) -> Option<(&'static str, &'static str)> {
    match flag {
        "autoOcr" => Some(("autoOcrEnabled", "toggleAutoOcr")),
        "overlay" => Some(("overlayVisible", "toggleOverlay")),
        "textOverlay" => Some(("textOverlayVisible", "toggleTextOverlay")),
        _ => None,
    }
}

/// Set a switch on, off, or to the other state, and report where it ended up. The overlay owns
/// Auto OCR and the text overlay and writes them back (`view_flags`), so their new state is
/// waited for rather than assumed.
fn toggle(app: &tauri::AppHandle, service: &Shared, flag: &str, to: &str) -> Result<Value, String> {
    let (field, action) = flag_of(flag).ok_or_else(|| format!("invalid: unknown switch {flag:?}"))?;
    let current = || crate::snapshot_value(service)[field].as_bool().unwrap_or(false);
    let before = current();
    let want = match to {
        "on" | "show" => true,
        "off" | "hide" => false,
        "toggle" => !before,
        other => return Err(format!("invalid: {other:?}; use on, off or toggle")),
    };
    if flag == "autoOcr" && want && service.selection.lock().unwrap().is_none() {
        return Err(format!("invalid: no source is selected. Choose one first: {}", choose_hint(service)));
    }
    if want != before {
        crate::actions::dispatch(app, service, action);
        let deadline = Instant::now() + Duration::from_secs(3);
        while current() != want && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let now = current();
    if now != want {
        return Err(format!("busy: {flag} did not change; is the overlay loaded? (it is {})", if now { "on" } else { "off" }));
    }
    Ok(json!({ flag: now }))
}

// ------------------------------------------------------------------------------ scanning

fn scan(app: &tauri::AppHandle, service: &Shared, params: &Value) -> Result<Value, String> {
    if service.selection.lock().unwrap().is_none() && !texthooking(service) {
        return Err(format!("invalid: no source is selected. Choose one first: {}", choose_hint(service)));
    }
    let before = service.view.lock().unwrap().revision;
    crate::actions::dispatch(app, service, "triggerScan");
    if params["wait"] != json!(true) {
        return Ok(json!({ "started": true }));
    }
    let limit = params["timeout"].as_f64().map(Duration::from_secs_f64).unwrap_or(Duration::from_secs(30)).min(SCAN_WAIT_MAX);
    let deadline = Instant::now() + limit;
    loop {
        {
            let view = service.view.lock().unwrap();
            if view.revision > before && !view.scanning {
                if let Some(scan) = view.scan.as_ref() {
                    return Ok(json!({
                        "text": scan_text(scan),
                        "engine": scan["ocr"]["engine"],
                        "id": scan["id"],
                    }));
                }
            }
        }
        if Instant::now() >= deadline {
            let status = service.view.lock().unwrap().status.clone();
            return Err(format!("timeout: no scan result yet ({status})"));
        }
        std::thread::sleep(Duration::from_millis(80));
    }
}

/// How to choose a source here: by name, or where the system's own picker is the only way
/// (Wayland, Gaming Mode), in Kimochi.
fn choose_hint(service: &Shared) -> &'static str {
    let picker_only = service
        .backend
        .lock()
        .is_ok_and(|backend| backend.capabilities().system_picker_required);
    if picker_only {
        "`kimochi source choose`, or in Kimochi."
    } else {
        "`kimochi source set <name>`, or `kimochi source choose`."
    }
}

/// Whether the Text Hooker is the input (no OCR source needed to "scan").
fn texthooking(service: &Shared) -> bool {
    service.settings.get("superTexthooker").ok().flatten().is_some_and(|v| v["inputSource"] == json!("hook"))
}

fn engines(app: &tauri::AppHandle, service: &Shared) -> Value {
    let capabilities = crate::capabilities_value(app, service);
    json!({
        "selected": service.settings.get_or::<String>("ocrMode", String::new()),
        "engines": capabilities["ocrEngines"],
    })
}

fn set_engine(app: &tauri::AppHandle, service: &Shared, engine: &str) -> Result<Value, String> {
    let engine = if engine == "local" { "meikiocr" } else { engine };
    let report = engines(app, service);
    let known = &report["engines"][engine];
    if known.is_null() {
        let names: Vec<&String> = report["engines"].as_object().map(|m| m.keys().collect()).unwrap_or_default();
        return Err(format!("invalid: unknown engine {engine:?}; this computer has {}", names.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
    }
    // An engine held back only by its models stays selectable: choosing it downloads them.
    if known["available"] != json!(true) && known["model"].is_null() {
        let reason = known["reason"].as_str().unwrap_or("it is not available on this computer");
        return Err(format!("invalid: {engine}: {reason}"));
    }
    crate::apply_setting(app, &service.settings, "ocrMode", json!(engine))?;
    Ok(json!({ "selected": engine, "model": known["model"] }))
}

/// One source of the catalog by id, or by window title or app name.
fn find_source(query: &str) -> Result<String, String> {
    let catalog = crate::sources::catalog()?;
    let field = |s: &Value, k: &str| s[k].as_str().unwrap_or_default().to_string();
    if let Some(exact) = catalog.iter().find(|s| field(s, "id") == query) {
        return Ok(field(exact, "id"));
    }
    let wanted = query.to_lowercase();
    let pick = |test: &dyn Fn(&Value) -> bool| catalog.iter().filter(|s| test(s)).collect::<Vec<_>>();
    let exact = pick(&|s| field(s, "name").to_lowercase() == wanted || field(s, "app").to_lowercase() == wanted);
    let matches = if exact.is_empty() {
        pick(&|s| field(s, "name").to_lowercase().contains(&wanted) || field(s, "app").to_lowercase().contains(&wanted))
    } else {
        exact
    };
    match matches.as_slice() {
        [one] => Ok(field(one, "id")),
        [] => Err(format!("gone: no window or display matches {query:?}. See `kimochi source list`.")),
        many => Err(format!(
            "invalid: {query:?} matches {} sources; use one's id:\n{}",
            many.len(),
            many.iter().map(|s| format!("  {}  {} ({})", field(s, "id"), field(s, "name"), field(s, "app"))).collect::<Vec<_>>().join("\n")
        )),
    }
}

// ------------------------------------------------------------------------------ windows

fn open(app: &tauri::AppHandle, service: &Shared, view: &str, page: Option<&str>) -> Result<Value, String> {
    let settings = &service.settings;
    let main = crate::panels::MAIN;
    match view {
        "main" | "app" => crate::panels::act_existing(app, settings, main, "show", None).map(|_| ()),
        "log" | "notebook" | "anki" => crate::panels::act_existing(app, settings, main, "show", None).map(|_| {
            let _ = app.emit("main:show-view", json!({ "view": view }));
        }),
        "settings" => crate::tray::open_settings(app, page),
        "sources" | "source-picker" => crate::choose_source(app, settings).map(|_| ()),
        "mini" => crate::panels::act_existing(app, settings, main, "mini", None)
            .and_then(|_| crate::panels::act_existing(app, settings, main, "show", None))
            .map(|_| ()),
        "expand" => crate::panels::act_existing(app, settings, main, "expand", None).map(|_| ()),
        "dictionary" => {
            let settings = settings.clone();
            crate::panels::with_panel(app, "dictionary", move |app, turn| {
                let _ = crate::panels::act(turn, app, &settings, "dictionary", "show", None);
            });
            Ok(())
        }
        other => Err(format!("invalid: unknown view {other:?}; use log, notebook, anki, settings, sources, mini or dictionary")),
    }?;
    crate::tray::sync_mini(app);
    Ok(json!({ "opened": view }))
}

// ------------------------------------------------------------------------------ the Log

/// The Log's session manifest as it is on disk (the Log writes it a moment after each change).
fn sessions_now() -> Value {
    crate::account::active_profile_dir()
        .and_then(|dir| crate::profile::read_json(&dir.join("sessions.json")))
        .unwrap_or(Value::Null)
}

fn active_session(manifest: &Value) -> Option<Value> {
    let active = manifest["activeId"].as_str()?;
    manifest["sessions"].as_array()?.iter().find(|s| s["id"] == json!(active)).cloned()
}

/// A session by id, by name, or by the only name containing `query` (ignoring case).
pub fn find_session(manifest: &Value, query: &str) -> Result<Value, String> {
    let sessions = manifest["sessions"].as_array().cloned().unwrap_or_default();
    let name = |s: &Value| s["name"].as_str().unwrap_or_default().to_lowercase();
    if let Some(found) = sessions.iter().find(|s| s["id"] == json!(query)) {
        return Ok(found.clone());
    }
    let wanted = query.trim().to_lowercase();
    let exact: Vec<&Value> = sessions.iter().filter(|s| name(s) == wanted).collect();
    let matches = if exact.is_empty() { sessions.iter().filter(|s| name(s).contains(&wanted)).collect() } else { exact };
    match matches.as_slice() {
        [one] => Ok((*one).clone()),
        [] => Err(format!("gone: no session matches {query:?}. See `kimochi session list`.")),
        many => Err(format!(
            "invalid: {query:?} matches {} sessions: {}",
            many.len(),
            many.iter().map(|s| format!("{:?}", s["name"].as_str().unwrap_or_default())).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// Wait until the Log window answers, and return its snapshot (sessions, lines, stats).
fn log_ready(app: &tauri::AppHandle) -> Result<Value, String> {
    let deadline = Instant::now() + LOG_READY;
    loop {
        match reader_call(app, "host", "snapshot", json!([]), None, Duration::from_secs(2)) {
            Ok(snapshot) => return Ok(snapshot),
            Err(error) if Instant::now() >= deadline => return Err(format!("busy: the Log did not answer ({error})")),
            Err(_) => std::thread::sleep(Duration::from_millis(250)),
        }
    }
}

/// One request to the Log window (host.ts `reader:request`), answered by `reader:response`.
fn reader_call(
    app: &tauri::AppHandle,
    module: &str,
    method: &str,
    args: Value,
    session_id: Option<&str>,
    timeout: Duration,
) -> Result<Value, String> {
    let id = format!("cli-{}", token()?.get(..24).unwrap_or_default());
    let (tx, rx) = mpsc::channel::<Value>();
    let wanted = id.clone();
    let listener = app.listen_any("reader:response", move |event| {
        if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {
            if payload["id"] == json!(wanted) {
                let _ = tx.send(payload);
            }
        }
    });
    let sent = app.emit(
        "reader:request",
        json!({ "id": id, "module": module, "method": method, "args": args, "sessionId": session_id }),
    );
    let answer = sent.map_err(|e| format!("native: {e}")).and_then(|_| {
        rx.recv_timeout(timeout).map_err(|_| "timeout: the Log did not answer".to_string())
    });
    app.unlisten(listener);
    let answer = answer?;
    match answer["error"].as_str() {
        Some(error) => Err(error.trim_start_matches("Error: ").to_string()),
        None => Ok(answer.get("value").cloned().unwrap_or(Value::Null)),
    }
}

// ------------------------------------------------------------------------------ watch

const WATCHABLE: &[&str] = &["scan", "line", "source", "state", "session", "action"];

/// Stream events as JSON lines until the client goes away.
fn watch(app: &tauri::AppHandle, stream: &TcpStream, params: &Value) {
    let wanted: Vec<String> = match params["events"].as_array() {
        Some(list) if !list.is_empty() => list.iter().filter_map(|e| e.as_str().map(str::to_string)).collect(),
        _ => WATCHABLE.iter().map(|s| s.to_string()).collect(),
    };
    if let Some(unknown) = wanted.iter().find(|e| !WATCHABLE.contains(&e.as_str())) {
        let _ = reply(&mut &*stream, Err(format!("invalid: unknown event {unknown:?}; use {}", WATCHABLE.join(", "))));
        return;
    }
    let Ok(service) = service(app) else { return };
    let wants = |name: &str| wanted.iter().any(|w| w == name);
    let (tx, rx) = mpsc::channel::<Value>();
    let mut listeners = Vec::new();

    if wants("scan") || wants("source") || wants("state") {
        let tx = tx.clone();
        let (scan, source, state) = (wants("scan"), wants("source"), wants("state"));
        // Listeners are `Fn`: what was last seen lives behind a lock.
        let seen = std::sync::Mutex::new(Seen::of(&crate::snapshot_value(&service)));
        listeners.push(app.listen_any("state", move |event| {
            let Ok(snapshot) = serde_json::from_str::<Value>(event.payload()) else { return };
            let now = Seen::of(&snapshot);
            let mut last = seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let scanning = snapshot["isScanning"].as_bool().unwrap_or(false);
            if scan && now.scan_id != last.scan_id && !now.scan_id.is_null() && !scanning {
                let _ = tx.send(json!({
                    "event": "scan",
                    "text": scan_text(&snapshot["scan"]),
                    "engine": snapshot["scan"]["ocr"]["engine"],
                    "id": now.scan_id,
                }));
            }
            if source && now.source != last.source {
                let _ = tx.send(json!({ "event": "source", "source": without_icon(&snapshot["source"]) }));
            }
            if state && now.flags != last.flags {
                let _ = tx.send(json!({
                    "event": "state",
                    "autoOcr": snapshot["autoOcrEnabled"],
                    "overlay": snapshot["overlayVisible"],
                    "textOverlay": snapshot["textOverlayVisible"],
                    "scanning": snapshot["isScanning"],
                }));
            }
            // A result published mid-scan is reported once the scan has finished.
            if scanning {
                last.source = now.source;
                last.flags = now.flags;
            } else {
                *last = now;
            }
        }));
    }

    if wants("line") || wants("session") {
        let tx = tx.clone();
        let (lines, sessions) = (wants("line"), wants("session"));
        let log = std::sync::Mutex::new(LogSeen::from_disk());
        listeners.push(app.listen_any("reader:snapshot", move |event| {
            let Ok(snapshot) = serde_json::from_str::<Value>(event.payload()) else { return };
            let events = log.lock().unwrap_or_else(std::sync::PoisonError::into_inner).update(&snapshot);
            for event in events {
                let keep = match event["event"].as_str() {
                    Some("line") => lines,
                    Some("session") => sessions,
                    _ => false,
                };
                if keep {
                    let _ = tx.send(event);
                }
            }
        }));
    }

    if wants("action") {
        let tx = tx.clone();
        listeners.push(app.listen_any("hotkey", move |event| {
            if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {
                let _ = tx.send(json!({ "event": "action", "name": payload["name"] }));
            }
        }));
    }
    drop(tx);

    let mut out = stream;
    let mut alive = reply(&mut out, Ok(json!({ "watching": wanted }))).is_ok();
    let mut checked = Instant::now();
    while alive {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(mut event) => {
                event["at"] = json!(crate::now_ms() as u64);
                let mut bytes = serde_json::to_vec(&event).unwrap_or_default();
                bytes.push(b'\n');
                alive = out.write_all(&bytes).and_then(|_| out.flush()).is_ok();
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        // A client that has gone sends nothing, so look for its end of the stream now and then.
        if alive && checked.elapsed() > Duration::from_secs(2) {
            checked = Instant::now();
            alive = still_connected(stream);
        }
    }
    for listener in listeners {
        app.unlisten(listener);
    }
}

fn still_connected(stream: &TcpStream) -> bool {
    if stream.set_nonblocking(true).is_err() {
        return false;
    }
    let mut byte = [0u8; 1];
    let alive = match stream.peek(&mut byte) {
        Ok(0) => false,
        Ok(_) => true,
        Err(e) => e.kind() == std::io::ErrorKind::WouldBlock,
    };
    let _ = stream.set_nonblocking(false);
    alive
}

/// What `watch` compares between two `state` events.
struct Seen {
    scan_id: Value,
    source: Value,
    flags: Value,
}

impl Seen {
    fn of(snapshot: &Value) -> Self {
        Seen {
            scan_id: snapshot["scan"]["id"].clone(),
            source: snapshot["source"]["sourceId"].clone(),
            flags: json!([snapshot["autoOcrEnabled"], snapshot["overlayVisible"], snapshot["textOverlayVisible"]]),
        }
    }
}

/// The Log as `watch` last saw it: the open session and its newest line.
pub struct LogSeen {
    session: Option<String>,
    last_line: u64,
}

impl LogSeen {
    fn from_disk() -> Self {
        let dir = crate::account::active_profile_dir();
        let session = dir.as_deref().and_then(crate::anki_cards::active_session);
        let last_line = match (&dir, &session) {
            (Some(dir), Some(sid)) => crate::profile::read_json(&dir.join("sessions").join(sid).join("lines.json"))
                .map(|file| max_line_id(&file["lines"]))
                .unwrap_or(0),
            _ => 0,
        };
        LogSeen { session, last_line }
    }

    /// The events a new Log snapshot means: a session change, or the lines added since.
    pub fn update(&mut self, snapshot: &Value) -> Vec<Value> {
        let manifest = &snapshot["sessions"];
        let active = manifest["activeId"].as_str().map(str::to_string);
        let lines = &snapshot["lines"];
        let mut events = Vec::new();
        if active != self.session {
            self.session = active;
            self.last_line = max_line_id(lines);
            let session = active_session(manifest).unwrap_or(Value::Null);
            events.push(json!({ "event": "session", "id": session["id"], "name": session["name"] }));
            return events;
        }
        for line in lines.as_array().into_iter().flatten() {
            let id = line["id"].as_u64().unwrap_or(0);
            if id > self.last_line {
                events.push(json!({
                    "event": "line",
                    "id": line["uid"].as_str().map(str::to_string).unwrap_or_else(|| format!("{}-{id}", self.session.as_deref().unwrap_or_default())),
                    "text": line["text"],
                    "source": line["source"],
                    "timestamp": line["ts"],
                    "session": self.session,
                }));
            }
        }
        self.last_line = self.last_line.max(max_line_id(lines));
        events
    }
}

fn max_line_id(lines: &Value) -> u64 {
    lines.as_array().into_iter().flatten().filter_map(|l| l["id"].as_u64()).max().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Value {
        json!({"activeId": "b", "sessions": [
            {"id": "a", "name": "Persona 5"},
            {"id": "b", "name": "Final Fantasy VII"},
            {"id": "c", "name": "Final Fantasy X"},
        ]})
    }

    #[test]
    fn sessions_are_found_by_id_name_or_unique_part() {
        assert_eq!(find_session(&manifest(), "a").unwrap()["name"], "Persona 5");
        assert_eq!(find_session(&manifest(), "final fantasy vii").unwrap()["id"], "b");
        assert_eq!(find_session(&manifest(), "persona").unwrap()["id"], "a");
        assert!(find_session(&manifest(), "fantasy").unwrap_err().starts_with("invalid:"));
        assert!(find_session(&manifest(), "zelda").unwrap_err().starts_with("gone:"));
    }

    #[test]
    fn watch_reports_new_lines_and_session_changes_but_not_history() {
        let mut log = LogSeen { session: Some("b".into()), last_line: 2 };
        let snapshot = |active: &str, ids: &[u64]| {
            let mut m = manifest();
            m["activeId"] = json!(active);
            json!({"sessions": m, "lines": ids.iter().map(|id| json!({"id": id, "text": format!("line {id}"), "source": "ocr", "ts": id})).collect::<Vec<_>>()})
        };
        assert!(log.update(&snapshot("b", &[1, 2])).is_empty());
        let added = log.update(&snapshot("b", &[1, 2, 3, 4]));
        assert_eq!(added.iter().map(|e| e["text"].clone()).collect::<Vec<_>>(), [json!("line 3"), json!("line 4")]);
        assert_eq!(added[0]["id"], "b-3");
        let switched = log.update(&snapshot("a", &[1, 2, 3, 4, 5, 6, 7]));
        assert_eq!(switched, [json!({"event": "session", "id": "a", "name": "Persona 5"})]);
        assert_eq!(log.update(&snapshot("a", &[1, 2, 3, 4, 5, 6, 7, 8]))[0]["text"], "line 8");
    }

    #[test]
    fn tokens_are_long_and_compared_whole() {
        let a = token().unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, token().unwrap());
        assert!(same(&a, &a.clone()));
        assert!(!same(&a, &a[..63]));
    }
}
