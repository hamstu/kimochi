//! Hachidori's loopback origin (docs/HACHIDORI_IMPORT_THREADS.md).
//!
//! Hachidori imports on several threads only in a cross-origin-isolated document. No webview
//! gives a custom-scheme page that (`platform::CROSS_ORIGIN_ISOLATION`: WebKit never isolates
//! one, WebView2 isolates it but cannot load a worker's own workers from it), but all of them
//! isolate an ordinary HTTP page that sends COOP/COEP. So Hachidori's files are also served over
//! HTTP on `127.0.0.1`, by this module, and its origin becomes `http://127.0.0.1:<port>`.
//!
//! **The port is part of the origin**, and the engine's dictionaries live in that origin's
//! IndexedDB, so the port is chosen once and kept (`extension-origins.json` in the app data
//! directory, one entry per build flavor: a dev build and a bundle can run side by side and keep
//! separate WebKit stores anyway). The listener is bound before any window is built; when the
//! port cannot be had the session never names that origin, so another process holding it can
//! never serve code into Kimochi's windows.
//!
//! **Migration.** Dictionaries imported before this live in the scheme origin's storage
//! (`hachidori://localhost`, `http://hachidori.localhost` on Windows).
//! Until they have been copied, the session keeps that origin (single thread, exactly as before)
//! and a hidden window (`ext-migrate-hachidori`) copies the origin's IndexedDB databases and
//! localStorage: first as a top-level page on the old origin (first-party, so it sees the real
//! data), through native into a staging directory, then as a top-level page on the loopback
//! origin, which rebuilds the databases and checks every record and byte. Only a verified copy
//! of the exact `dictionaryState` the storage file still describes switches the *next* launch to
//! the loopback origin. The old origin's data is never touched. A copy on a machine where the
//! loopback page is not isolated is recorded as unsupported and never switches. After the
//! switch, `chrome.storage` (a native file, origin-free) already carries every setting.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};

/// The engine served this way. 10ten needs no isolation.
pub const ENGINE: &str = "hachidori";
/// Whether this platform serves Hachidori from loopback: where WebKit cannot isolate a scheme.
pub const SUPPORTED: bool = !cfg!(target_os = "android");
/// The hidden window that copies the old origin's storage.
pub const MIGRATE_WINDOW: &str = "ext-migrate-hachidori";
/// The page it runs on both origins (`host/ext-migrate.html`, served as a host page).
pub const MIGRATE_PAGE: &str = "/__kimochi/ext-migrate.html";
const STATE_FILE: &str = "extension-origins.json";
/// Below every OS's ephemeral range (macOS 49152+, Linux 32768+), so an outgoing connection
/// never holds it. A dev build and a bundle each have their own.
const PREFERRED_PORT: u16 = if cfg!(dev) { 27632 } else { 27631 };
/// Tried in turn when the preferred port is taken on the first run (before any data lives on it).
const ALTERNATES: u16 = 24;
/// A copy that has failed this often is not retried; the old origin keeps working.
const MAX_ATTEMPTS: u32 = 3;
/// How long the copy may take before it is abandoned.
const MIGRATION_TIMEOUT_SECS: u64 = 20 * 60;
/// The flavor key in the state file.
const FLAVOR: &str = if cfg!(dev) { "dev" } else { "release" };

/// This launch's origin for Hachidori.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Session {
    /// The custom scheme, as before (unsupported platform, data not yet copied, or no port).
    Legacy,
    /// `http://127.0.0.1:<port>`.
    Loopback(u16),
    /// The data lives on the loopback origin but its port could not be bound: Hachidori does not
    /// start rather than show an empty dictionary list or load another process's pages.
    Unavailable(String),
}

/// WebKitGTK exposes `SharedArrayBuffer`, and (2.52) lets a page post shared WASM memory to a
/// worker, only with this JavaScriptCore option, even on a cross-origin-isolated page. Its web
/// processes read it from the environment they inherit, so it is set before any is started.
/// Measured on Ubuntu 24.04 (WebKitGTK 2.52.6) and Arch (2.54.1): without it Hachidori's
/// `supportsSharedWasmMemory` is false on the loopback origin too. Respects a value already set.
pub fn prepare_environment() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("JSC_useSharedArrayBuffer").is_none() {
        std::env::set_var("JSC_useSharedArrayBuffer", "1");
    }
}

/// One flavor's record in the state file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// The loopback origin is the engine's home from now on.
    #[serde(default)]
    pub switched: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration: Option<Migration>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Migration {
    /// `copied`, `failed`, `stale` (the data changed during the copy) or `unsupported`.
    pub status: String,
    /// The port the copy was written to (its origin).
    pub port: u16,
    /// `fingerprint()` of the storage file's `dictionaryState` when the copy was taken.
    #[serde(default)]
    pub fingerprint: String,
    #[serde(default)]
    pub records: u64,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub at: u64,
}

/// What `decide` resolved for this launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub session: Session,
    /// Copy the old origin's data to this port during the session.
    pub migrate_to: Option<u16>,
    /// The entry to write back.
    pub entry: Entry,
    /// Why, for the log.
    pub reason: &'static str,
}

/// The launch decision, from the saved entry, the port actually bound (if any), the storage
/// file's current `dictionaryState` fingerprint and whether it lists any dictionary.
pub fn decide(saved: &Entry, bound: Option<u16>, fingerprint: &str, has_dictionaries: bool) -> Decision {
    let mut entry = saved.clone();
    if entry.switched {
        return match bound {
            Some(port) if Some(port) == entry.port => Decision { session: Session::Loopback(port), migrate_to: None, entry, reason: "switched" },
            _ => Decision {
                session: Session::Unavailable(format!(
                    "Hachidori's local port {} is in use by another program",
                    entry.port.map_or_else(|| "?".into(), |p| p.to_string())
                )),
                migrate_to: None,
                entry,
                reason: "port-unavailable",
            },
        };
    }
    let Some(port) = bound else {
        return Decision { session: Session::Legacy, migrate_to: None, entry, reason: "no-port" };
    };
    // Before the switch the port may still move: nothing lives on it yet.
    if entry.port != Some(port) {
        entry.port = Some(port);
        entry.migration = None;
    }
    if !has_dictionaries {
        entry.switched = true;
        return Decision { session: Session::Loopback(port), migrate_to: None, entry, reason: "nothing-to-copy" };
    }
    match &entry.migration {
        Some(m) if m.status == "copied" && m.port == port && m.fingerprint == fingerprint => {
            entry.switched = true;
            Decision { session: Session::Loopback(port), migrate_to: None, entry, reason: "copied" }
        }
        Some(m) if m.status == "unsupported" => Decision { session: Session::Legacy, migrate_to: None, entry, reason: "unsupported" },
        Some(m) if m.status == "failed" && m.attempts >= MAX_ATTEMPTS => {
            Decision { session: Session::Legacy, migrate_to: None, entry, reason: "gave-up" }
        }
        _ => Decision { session: Session::Legacy, migrate_to: Some(port), entry, reason: "copy-pending" },
    }
}

/// A stable digest of the storage file's `dictionaryState` (empty when there is none).
pub fn fingerprint(state: Option<&Value>) -> String {
    use sha2::Digest;
    match state {
        None | Some(Value::Null) => String::new(),
        Some(value) => {
            let digest = sha2::Sha256::digest(value.to_string().as_bytes());
            digest.iter().map(|b| format!("{b:02x}")).collect()
        }
    }
}

/// `dictionaryState` from `chrome-local-hachidori.json` (`{local: {...}}`), if any.
fn dictionary_state(app: &tauri::AppHandle) -> Option<Value> {
    let file = crate::extensions::storage_file(Some(ENGINE)).ok()?;
    let path = app.path().app_data_dir().ok()?.join(file);
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value.get("local")?.get("dictionaryState").cloned()
}

fn has_dictionaries(state: Option<&Value>) -> bool {
    state
        .and_then(|s| s.get("dictionaries"))
        .and_then(Value::as_array)
        .is_some_and(|list| !list.is_empty())
}

#[derive(Default)]
struct Live {
    session: Option<Session>,
    migrate_to: Option<u16>,
    entry: Entry,
    staging: Option<PathBuf>,
    /// Export totals, `ext_migration_exported`.
    exported: Option<Totals>,
    fingerprint_at_start: String,
    parts: u64,
    started: Option<std::time::Instant>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Totals {
    pub records: u64,
    pub bytes: u64,
}

fn live() -> &'static Mutex<Live> {
    static LIVE: OnceLock<Mutex<Live>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(Live::default()))
}

fn lock() -> std::sync::MutexGuard<'static, Live> {
    live().lock().unwrap_or_else(|p| p.into_inner())
}

/// This launch's session, `Legacy` until `install` has run.
pub fn session() -> Session {
    lock().session.clone().unwrap_or(Session::Legacy)
}

/// `http://127.0.0.1:<port>`.
pub fn origin_of(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// The loopback origin Hachidori uses this session, if it does.
pub fn origin(id: &str) -> Option<String> {
    match session() {
        Session::Loopback(port) if id == ENGINE => Some(origin_of(port)),
        _ => None,
    }
}

/// Why Hachidori cannot start this session, if it cannot.
pub fn unavailable(id: &str) -> Option<String> {
    match session() {
        Session::Unavailable(reason) if id == ENGINE => Some(reason),
        _ => None,
    }
}

/// The loopback origin a pending copy writes to.
fn migration_origin() -> Option<String> {
    lock().migrate_to.map(origin_of)
}

/// Whether `url` is on this session's loopback origin, or (for the copy window) the target.
pub fn is_loopback_url(url: &tauri::Url) -> bool {
    let port = {
        let live = lock();
        match live.session {
            Some(Session::Loopback(port)) => Some(port),
            _ => live.migrate_to,
        }
    };
    port.is_some_and(|port| url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(port))
}

fn state_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(STATE_FILE))
}

fn load_entry(path: &Path) -> Entry {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v.get(ENGINE)?.get(FLAVOR).cloned())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn save_entry(app: &tauri::AppHandle, entry: &Entry) {
    let Some(path) = state_path(app) else { return };
    let mut all = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    if !all.get(ENGINE).is_some_and(Value::is_object) {
        all[ENGINE] = json!({});
    }
    all[ENGINE][FLAVOR] = serde_json::to_value(entry).unwrap_or(Value::Null);
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec_pretty(&all).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Binds `127.0.0.1:<port>`: the saved port only once data may live on it, else the preferred
/// port or the next free one after it.
fn bind(saved: &Entry) -> Option<(TcpListener, u16)> {
    let first = saved.port.unwrap_or(PREFERRED_PORT);
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", first)) {
        return Some((listener, first));
    }
    if saved.switched {
        return None;
    }
    (1..=ALTERNATES).find_map(|offset| {
        let port = PREFERRED_PORT.checked_add(offset)?;
        if port == first {
            return None;
        }
        TcpListener::bind(("127.0.0.1", port)).ok().map(|l| (l, port))
    })
}

/// Decides this launch's origin and starts the server. Before any window is built (the windows'
/// preludes name the origin), from `setup`. Returns a record for the log.
pub fn install(app: &tauri::AppHandle) -> Value {
    if !SUPPORTED {
        lock().session = Some(Session::Legacy);
        return json!({ "check": "hachidori-origin", "session": "scheme", "reason": "isolated-scheme" });
    }
    let Some(path) = state_path(app) else {
        lock().session = Some(Session::Legacy);
        return json!({ "check": "hachidori-origin", "session": "scheme", "reason": "no-data-dir" });
    };
    let saved = load_entry(&path);
    // `KIMOCHI_HACHIDORI_THREADS=0` keeps Hachidori on its scheme (no copy, no move) for a machine
    // where the loopback origin misbehaves. Only before the move: afterwards the dictionaries
    // chrome.storage describes live on the loopback origin, and starting on the scheme would make
    // the host reset that list.
    if !crate::platform::hachidori_threads_allowed() && !saved.switched {
        lock().session = Some(Session::Legacy);
        return json!({ "check": "hachidori-origin", "session": "scheme", "reason": "KIMOCHI_HACHIDORI_THREADS=0" });
    }
    let bound = bind(&saved);
    let state = dictionary_state(app);
    let decision = decide(&saved, bound.as_ref().map(|(_, p)| *p), &fingerprint(state.as_ref()), has_dictionaries(state.as_ref()));
    if decision.entry != saved {
        save_entry(app, &decision.entry);
    }
    let serve = match (&decision.session, decision.migrate_to) {
        (Session::Loopback(port), _) => Some(*port),
        (_, Some(port)) => Some(port),
        _ => None,
    };
    if let (Some(port), Some((listener, _))) = (serve, bound) {
        if let Err(error) = serve_on(app, listener, port) {
            lock().session = Some(Session::Legacy);
            return json!({ "check": "hachidori-origin", "session": "scheme", "reason": "server-failed", "error": error });
        }
        if let Err(error) = add_capabilities(app, port) {
            lock().session = Some(Session::Legacy);
            return json!({ "check": "hachidori-origin", "session": "scheme", "reason": "capability-failed", "error": error });
        }
    }
    let record = json!({
        "check": "hachidori-origin",
        "session": match &decision.session { Session::Legacy => "scheme", Session::Loopback(_) => "loopback", Session::Unavailable(_) => "unavailable" },
        "reason": decision.reason,
        "port": decision.entry.port,
        "flavor": FLAVOR,
        "migrateTo": decision.migrate_to,
        "error": match &decision.session { Session::Unavailable(r) => Some(r.clone()), _ => None },
    });
    let mut live = lock();
    live.session = Some(decision.session);
    live.migrate_to = decision.migrate_to;
    live.entry = decision.entry;
    record
}

// ------------------------------------------------------------------------- the server

#[derive(Clone)]
struct Server {
    app: tauri::AppHandle,
    port: u16,
    allowed: std::sync::Arc<Vec<String>>,
}

/// The origins whose pages may load Hachidori's files: the loopback origin itself, the app's
/// pages (content scripts, the Settings frame), Hachidori's scheme origin (the copy's export page
/// goes on to the import page, and WebView2 sends it as the Referer) and, in a dev build, the dev
/// server.
fn allowed_origins(app: &tauri::AppHandle, port: u16) -> Vec<String> {
    let mut allowed = vec![
        origin_of(port),
        crate::platform::app_origin().to_string(),
        crate::platform::scheme_origin(ENGINE),
    ];
    if cfg!(dev) {
        if let Some(url) = &app.config().build.dev_url {
            allowed.push(url.origin().ascii_serialization());
        }
    }
    allowed
}

/// `scheme://host[:port]` of an `Origin` or `Referer` value, as browsers write origins.
fn origin_of_header(value: &str) -> Option<String> {
    let url = tauri::Url::parse(value).ok()?;
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

/// Who may ask: the `Host` must be this listener (no DNS-rebound name), and a request that
/// says where it comes from (`Origin`, `Referer`) must come from Kimochi. Returns the origin to
/// echo in `Access-Control-Allow-Origin`, or why the request is refused.
pub fn admit(host: Option<&str>, origin: Option<&str>, referer: Option<&str>, port: u16, allowed: &[String]) -> Result<Option<String>, &'static str> {
    if host != Some(format!("127.0.0.1:{port}").as_str()) {
        return Err("host");
    }
    let from_origin = match origin {
        Some(value) => Some(origin_of_header(value).filter(|o| allowed.contains(o)).ok_or("origin")?),
        None => None,
    };
    if let Some(value) = referer {
        let referer = origin_of_header(value).ok_or("referer")?;
        if !allowed.contains(&referer) {
            return Err("referer");
        }
    }
    Ok(from_origin)
}

fn serve_on(app: &tauri::AppHandle, listener: TcpListener, port: u16) -> Result<(), String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let server = Server { app: app.clone(), port, allowed: std::sync::Arc::new(allowed_origins(app, port)) };
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("kimochi: hachidori loopback listener: {error}");
                return;
            }
        };
        let router = axum::Router::new().fallback(handle).with_state(server);
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("kimochi: hachidori loopback server stopped: {error}");
        }
    });
    Ok(())
}

async fn handle(
    axum::extract::State(server): axum::extract::State<Server>,
    request: axum::extract::Request,
) -> axum::response::Response {
    use axum::http::{header, Method, StatusCode};
    let headers = request.headers();
    let text = |name: header::HeaderName| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let refuse = |status: StatusCode| {
        axum::response::Response::builder().status(status).body(axum::body::Body::empty()).unwrap_or_default()
    };
    let echo = match admit(text(header::HOST).as_deref(), text(header::ORIGIN).as_deref(), text(header::REFERER).as_deref(), server.port, &server.allowed) {
        Ok(echo) => echo,
        Err(why) => {
            report(&server.app, json!({ "check": "hachidori-loopback-refused", "why": why, "path": request.uri().path() }));
            return refuse(StatusCode::FORBIDDEN);
        }
    };
    let method = request.method().clone();
    let mut builder = axum::response::Response::builder()
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::VARY, "Origin")
        .header("X-Content-Type-Options", "nosniff");
    for (name, value) in crate::extensions::isolation_headers(ENGINE, true) {
        builder = builder.header(name, value);
    }
    if let Some(origin) = &echo {
        builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.as_str());
    }
    if method == Method::OPTIONS {
        return builder
            .status(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
            .body(axum::body::Body::empty())
            .unwrap_or_default();
    }
    if method != Method::GET && method != Method::HEAD {
        return refuse(StatusCode::METHOD_NOT_ALLOWED);
    }
    let path = request.uri().path().to_string();
    let app = server.app.clone();
    let found = tauri::async_runtime::spawn_blocking(move || crate::extensions::lookup(&app, ENGINE, &path)).await.ok().flatten();
    match found {
        Some((mime, bytes)) => builder
            .header(header::CONTENT_TYPE, mime)
            .header(header::CONTENT_LENGTH, bytes.len())
            .body(if method == Method::HEAD { axum::body::Body::empty() } else { axum::body::Body::from(bytes) })
            .unwrap_or_default(),
        None => builder.status(StatusCode::NOT_FOUND).body(axum::body::Body::empty()).unwrap_or_default(),
    }
}

// ------------------------------------------------------------------- capabilities

/// The loopback pages are a remote origin to Tauri, so the static capabilities (local origins
/// only) do not reach them. The extension window gets what `capabilities/extension-windows.json`
/// gives it, for exactly this origin, plus the `kimochi-ext` commands its host calls instead of
/// the app commands (remote origins never reach app commands); the copy window only those.
fn add_capabilities(app: &tauri::AppHandle, port: u16) -> Result<(), String> {
    for capability in runtime_capabilities(port)? {
        app.add_capability(capability.to_string()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The two runtime capabilities, for exactly `http://127.0.0.1:<port>`.
pub fn runtime_capabilities(port: u16) -> Result<[Value; 2], String> {
    let base: Value = serde_json::from_str(include_str!("../capabilities/extension-windows.json")).map_err(|e| e.to_string())?;
    let mut permissions = base["permissions"].as_array().cloned().unwrap_or_default();
    permissions.push(json!("kimochi-ext:default"));
    let remote = json!({ "urls": [format!("{}/*", origin_of(port))] });
    Ok([
        json!({
            "identifier": "extension-window-loopback",
            "windows": [crate::extensions::window_label(ENGINE)],
            "remote": remote,
            "permissions": permissions,
        }),
        json!({
            "identifier": "extension-migration-loopback",
            "windows": [MIGRATE_WINDOW],
            "remote": remote,
            "permissions": ["kimochi-ext:default"],
        }),
    ])
}

/// For the extension window's top document on the loopback origin: the host sends its app
/// commands (`extensions::EXTENSION_WINDOW_COMMANDS`) to the same commands of the `kimochi-ext`
/// plugin (`main.rs`), which the remote origin may reach (host/ext/primitives.js `extCommand`).
/// Tauri's own `__TAURI_INTERNALS__.invoke` is frozen, so the host does the renaming.
pub fn ipc_prelude() -> String {
    ";(function(){try{window.__kimochiExtCommandPrefix='plugin:kimochi-ext|';}catch(e){}})();\n".into()
}

// ---------------------------------------------------------------------- migration

fn report(app: &tauri::AppHandle, value: Value) {
    eprintln!("kimochi: {value}");
    let _ = app.emit("kimochi-loopback-report", &value);
    if let Some(service) = app.try_state::<crate::Shared>() {
        crate::record(app, &service, value);
    }
}

fn staging_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("extension-migration").join(format!("{ENGINE}-{FLAVOR}")))
}

/// Starts the copy when this session has one pending: the hidden window on the old origin.
pub fn start_migration(_turn: &crate::panels::MainTurn, app: &tauri::AppHandle) -> Result<bool, String> {
    let Some(target) = migration_origin() else { return Ok(false) };
    if app.get_webview_window(MIGRATE_WINDOW).is_some() {
        return Ok(false);
    }
    let legacy = crate::platform::scheme_origin(ENGINE);
    let url: tauri::Url = format!("{legacy}{MIGRATE_PAGE}?step=export").parse().map_err(|e| format!("native: {e}"))?;
    let allowed_legacy = legacy.clone();
    tauri::WebviewWindowBuilder::new(app, MIGRATE_WINDOW, tauri::WebviewUrl::CustomProtocol(url))
        .title("Kimochi Hachidori storage copy")
        .visible(false)
        .focused(false)
        .focusable(false)
        .skip_taskbar(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .inner_size(1., 1.)
        .content_protected(true)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .on_navigation(move |u| {
            u.as_str() == "about:blank"
                || (u.as_str().starts_with(&allowed_legacy) && u.path() == MIGRATE_PAGE)
                || (u.as_str().starts_with(&target) && u.path() == MIGRATE_PAGE)
        })
        .build()
        .map_err(|e| format!("native: {e}"))?;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(MIGRATION_TIMEOUT_SECS));
        if handle.get_webview_window(MIGRATE_WINDOW).is_some() {
            finish(&handle, Err("the copy did not finish in time".into()));
        }
    });
    report(app, json!({ "check": "hachidori-migration", "phase": "started", "to": migration_origin() }));
    Ok(true)
}

fn require_copy_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == MIGRATE_WINDOW {
        Ok(())
    } else {
        Err("invalid: only Kimochi's storage copy window may do this".into())
    }
}

/// Ends the copy: records the outcome, removes the staging files and closes the window.
fn finish(app: &tauri::AppHandle, outcome: Result<(Totals, bool), String>) {
    let (entry, record) = {
        let mut live = lock();
        let port = live.migrate_to.unwrap_or_default();
        let fingerprint_now = fingerprint(dictionary_state(app).as_ref());
        let previous = live.entry.migration.clone().unwrap_or_default();
        let attempts = if previous.port == port { previous.attempts } else { 0 } + 1;
        let mut migration = Migration { port, attempts, at: crate::now_ms() as u64, ..Migration::default() };
        let record = match outcome {
            Ok((totals, true)) if live.fingerprint_at_start == fingerprint_now => {
                migration.status = "copied".into();
                migration.fingerprint = fingerprint_now;
                migration.records = totals.records;
                migration.bytes = totals.bytes;
                migration.attempts = 0;
                json!({ "check": "hachidori-migration", "phase": "copied", "records": totals.records, "bytes": totals.bytes, "port": port, "ms": live.started.map(|s| s.elapsed().as_millis() as u64), "next": "the next launch uses the loopback origin" })
            }
            Ok((_, true)) => {
                migration.status = "stale".into();
                migration.attempts = previous.attempts;
                json!({ "check": "hachidori-migration", "phase": "stale", "detail": "the dictionaries changed during the copy; it runs again next launch" })
            }
            Ok((totals, false)) => {
                migration.status = "unsupported".into();
                json!({ "check": "hachidori-migration", "phase": "unsupported", "records": totals.records, "detail": "the loopback page is not cross-origin isolated here; Hachidori stays on its scheme" })
            }
            Err(error) => {
                migration.status = "failed".into();
                migration.error = Some(error.clone());
                json!({ "check": "hachidori-migration", "phase": "failed", "error": error, "attempts": attempts, "detail": "Hachidori keeps its current storage; nothing was changed" })
            }
        };
        live.entry.migration = Some(migration);
        live.exported = None;
        live.parts = 0;
        if let Some(dir) = live.staging.take() {
            let _ = std::fs::remove_dir_all(dir);
        }
        (live.entry.clone(), record)
    };
    save_entry(app, &entry);
    report(app, record);
    crate::panels::later(app, move |app, _| {
        if let Some(window) = app.get_webview_window(MIGRATE_WINDOW) {
            let _ = window.destroy();
        }
    });
}

/// The copy window starts its export: a fresh staging directory. Answers where to go next.
#[tauri::command]
pub fn ext_migration_begin(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    require_copy_window(&window)?;
    let to = migration_origin().ok_or("invalid: no copy is pending")?;
    let dir = staging_dir(&app)?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("native: {e}"))?;
    let mut live = lock();
    live.staging = Some(dir);
    live.parts = 0;
    live.exported = None;
    live.fingerprint_at_start = fingerprint(dictionary_state(&app).as_ref());
    live.started = Some(std::time::Instant::now());
    Ok(json!({ "to": to, "page": MIGRATE_PAGE }))
}

/// One exported part (a database's schema, a record, localStorage), as opaque bytes.
#[tauri::command]
pub fn ext_migration_put(window: tauri::WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<u64, String> {
    require_copy_window(&window)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("invalid: a part is sent as raw bytes".into());
    };
    let mut live = lock();
    if live.exported.is_some() {
        return Err("invalid: the export is already complete".into());
    }
    let dir = live.staging.clone().ok_or("invalid: no export is running")?;
    let index = live.parts;
    std::fs::write(dir.join(format!("{index}.bin")), bytes).map_err(|e| format!("native: {e}"))?;
    live.parts += 1;
    Ok(index)
}

/// The export is complete: its totals, which the import must reproduce.
#[tauri::command]
pub fn ext_migration_exported(window: tauri::WebviewWindow, records: u64, bytes: u64) -> Result<Value, String> {
    require_copy_window(&window)?;
    let mut live = lock();
    live.staging.as_ref().ok_or("invalid: no export is running")?;
    live.exported = Some(Totals { records, bytes });
    Ok(json!({ "parts": live.parts }))
}

/// For the import page: how many parts there are and what they add up to.
#[tauri::command]
pub fn ext_migration_manifest(window: tauri::WebviewWindow) -> Result<Value, String> {
    require_copy_window(&window)?;
    let live = lock();
    let totals = live.exported.ok_or("invalid: nothing was exported")?;
    Ok(json!({ "parts": live.parts, "records": totals.records, "bytes": totals.bytes }))
}

/// One staged part, as raw bytes.
#[tauri::command]
pub fn ext_migration_get(window: tauri::WebviewWindow, index: u64) -> Result<tauri::ipc::Response, String> {
    require_copy_window(&window)?;
    let dir = {
        let live = lock();
        if live.exported.is_none() || index >= live.parts {
            return Err("invalid: no such part".into());
        }
        live.staging.clone().ok_or("invalid: nothing was exported")?
    };
    let bytes = std::fs::read(dir.join(format!("{index}.bin"))).map_err(|e| format!("native: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The import page verified its copy: the totals it read back, and whether its page is
/// cross-origin isolated (the reason for the move at all).
#[tauri::command]
pub fn ext_migration_done(app: tauri::AppHandle, window: tauri::WebviewWindow, records: u64, bytes: u64, isolated: bool) -> Result<(), String> {
    require_copy_window(&window)?;
    let exported = lock().exported.ok_or("invalid: nothing was exported")?;
    let got = Totals { records, bytes };
    if got != exported {
        finish(&app, Err(format!("the copy does not match: read back {records} records / {bytes} bytes of {} / {}", exported.records, exported.bytes)));
        return Ok(());
    }
    finish(&app, Ok((got, isolated)));
    Ok(())
}

/// Either page gave up.
#[tauri::command]
pub fn ext_migration_failed(app: tauri::AppHandle, window: tauri::WebviewWindow, error: String) -> Result<(), String> {
    require_copy_window(&window)?;
    finish(&app, Err(error));
    Ok(())
}

/// The `kimochi-ext` commands only the copy window may call.
pub const MIGRATION_COMMANDS: &[&str] = &[
    "ext_migration_begin",
    "ext_migration_put",
    "ext_migration_exported",
    "ext_migration_manifest",
    "ext_migration_get",
    "ext_migration_done",
    "ext_migration_failed",
];

/// The `kimochi-ext` plugin's guard: the extension windows may call the relay commands
/// (`extensions::EXTENSION_WINDOW_COMMANDS`), the copy window only the copy's.
pub fn plugin_command_allowed(label: &str, command: &str) -> Result<(), String> {
    let allowed = if label == MIGRATE_WINDOW {
        MIGRATION_COMMANDS.contains(&command)
    } else {
        crate::extensions::is_extension_window(label) && crate::extensions::EXTENSION_WINDOW_COMMANDS.contains(&command)
    };
    if allowed {
        Ok(())
    } else {
        Err(format!("invalid: {command} is not available to {label}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copied(port: u16, fingerprint: &str) -> Entry {
        Entry {
            port: Some(port),
            switched: false,
            migration: Some(Migration { status: "copied".into(), port, fingerprint: fingerprint.into(), ..Migration::default() }),
        }
    }

    #[test]
    fn a_fresh_install_moves_at_once() {
        let d = decide(&Entry::default(), Some(27631), "", false);
        assert_eq!(d.session, Session::Loopback(27631));
        assert!(d.entry.switched);
        assert_eq!(d.entry.port, Some(27631));
        assert_eq!(d.migrate_to, None);
    }

    #[test]
    fn existing_dictionaries_stay_until_a_verified_copy_of_the_same_state() {
        let d = decide(&Entry::default(), Some(27631), "abc", true);
        assert_eq!(d.session, Session::Legacy);
        assert_eq!(d.migrate_to, Some(27631));
        assert!(!d.entry.switched);
        // The copy matches what the storage file still describes: switch.
        let d = decide(&copied(27631, "abc"), Some(27631), "abc", true);
        assert_eq!(d.session, Session::Loopback(27631));
        assert!(d.entry.switched);
        // The dictionaries changed since the copy: copy again, stay.
        let d = decide(&copied(27631, "abc"), Some(27631), "def", true);
        assert_eq!((d.session, d.migrate_to), (Session::Legacy, Some(27631)));
        // The copy went to another port than this launch got: it is another origin.
        let d = decide(&copied(27631, "abc"), Some(27633), "abc", true);
        assert_eq!((d.session.clone(), d.migrate_to), (Session::Legacy, Some(27633)));
        assert_eq!(d.entry.migration, None);
    }

    #[test]
    fn failures_and_unsupported_webviews_keep_the_scheme() {
        let mut e = copied(27631, "abc");
        e.migration.as_mut().unwrap().status = "unsupported".into();
        assert_eq!(decide(&e, Some(27631), "abc", true).session, Session::Legacy);
        assert_eq!(decide(&e, Some(27631), "abc", true).migrate_to, None);
        e.migration.as_mut().unwrap().status = "failed".into();
        e.migration.as_mut().unwrap().attempts = 1;
        assert_eq!(decide(&e, Some(27631), "abc", true).migrate_to, Some(27631));
        e.migration.as_mut().unwrap().attempts = MAX_ATTEMPTS;
        assert_eq!(decide(&e, Some(27631), "abc", true).migrate_to, None);
        assert_eq!(decide(&Entry::default(), None, "abc", true).session, Session::Legacy);
    }

    #[test]
    fn after_the_switch_the_port_is_the_data() {
        let e = Entry { port: Some(27631), switched: true, migration: None };
        assert_eq!(decide(&e, Some(27631), "x", true).session, Session::Loopback(27631));
        assert!(matches!(decide(&e, None, "x", true).session, Session::Unavailable(_)));
        assert!(matches!(decide(&e, Some(27640), "x", true).session, Session::Unavailable(_)));
    }

    #[test]
    fn only_kimochi_pages_may_load_from_the_loopback_origin() {
        let allowed = vec!["http://127.0.0.1:27631".to_string(), "tauri://localhost".to_string(), "http://hachidori.localhost".to_string()];
        let host = Some("127.0.0.1:27631");
        assert_eq!(admit(host, None, None, 27631, &allowed), Ok(None));
        assert_eq!(admit(host, Some("tauri://localhost"), Some("tauri://localhost/ui/overlay.html"), 27631, &allowed), Ok(Some("tauri://localhost".into())));
        assert_eq!(admit(host, Some("http://127.0.0.1:27631"), None, 27631, &allowed), Ok(Some("http://127.0.0.1:27631".into())));
        // The copy's export page (Windows) moving on to the import page.
        assert_eq!(admit(host, None, Some("http://hachidori.localhost/__kimochi/ext-migrate.html?step=export"), 27631, &allowed), Ok(None));
        assert_eq!(admit(host, Some("https://evil.example"), None, 27631, &allowed), Err("origin"));
        assert_eq!(admit(host, Some("null"), None, 27631, &allowed), Err("origin"));
        assert_eq!(admit(host, None, Some("https://evil.example/x"), 27631, &allowed), Err("referer"));
        // A DNS-rebound name, or another port.
        assert_eq!(admit(Some("evil.example:27631"), None, None, 27631, &allowed), Err("host"));
        assert_eq!(admit(Some("127.0.0.1:1"), None, None, 27631, &allowed), Err("host"));
        assert_eq!(admit(None, None, None, 27631, &allowed), Err("host"));
    }

    #[test]
    fn the_plugin_guard_keeps_each_window_to_its_commands() {
        assert!(plugin_command_allowed("ext-hachidori", "ext_relay_bytes").is_ok());
        assert!(plugin_command_allowed("ext-hachidori", "ext_migration_put").is_err());
        assert!(plugin_command_allowed(MIGRATE_WINDOW, "ext_migration_put").is_ok());
        assert!(plugin_command_allowed(MIGRATE_WINDOW, "ext_relay").is_err());
        assert!(plugin_command_allowed("overlay", "ext_relay").is_err());
    }

    #[test]
    fn runtime_capabilities_reach_exactly_the_loopback_origin() {
        let [window, copy] = runtime_capabilities(27631).unwrap();
        let file: Value = serde_json::from_str(include_str!("../capabilities/extension-windows.json")).unwrap();
        assert_eq!(window["windows"], json!(["ext-hachidori"]));
        assert_eq!(window["remote"], json!({ "urls": ["http://127.0.0.1:27631/*"] }));
        let mut expected = file["permissions"].as_array().unwrap().clone();
        expected.push(json!("kimochi-ext:default"));
        assert_eq!(window["permissions"], Value::Array(expected));
        assert_eq!(copy["windows"], json!([MIGRATE_WINDOW]));
        assert_eq!(copy["remote"], window["remote"]);
        assert_eq!(copy["permissions"], json!(["kimochi-ext:default"]));
    }

    #[test]
    fn the_ipc_prelude_names_the_plugin() {
        assert!(ipc_prelude().contains("window.__kimochiExtCommandPrefix='plugin:kimochi-ext|'"));
    }

    #[test]
    fn fingerprints_follow_the_state() {
        assert_eq!(fingerprint(None), "");
        let a = json!({"revision": 1, "dictionaries": [{"id": "x"}]});
        let b = json!({"revision": 2, "dictionaries": [{"id": "x"}]});
        assert_eq!(fingerprint(Some(&a)), fingerprint(Some(&a.clone())));
        assert_ne!(fingerprint(Some(&a)), fingerprint(Some(&b)));
        assert!(has_dictionaries(Some(&a)));
        assert!(!has_dictionaries(Some(&json!({"dictionaries": []}))));
        assert!(!has_dictionaries(None));
    }
}
