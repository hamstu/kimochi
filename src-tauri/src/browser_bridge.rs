//! The browser bridge: Kimochi's end of the Kimochi browser extension (`browser-extension/`).
//!
//! The extension picks a picture on a web page (a manga page, a game's screenshot), sends its
//! pixels here, and gets back the lines Kimochi read in it, with their places, to lay over the
//! picture for the browser's own dictionary pop-up. Kimochi draws nothing itself in this mode
//! (input source `browser`): the picture is read by the user's OCR engine and filters, its text
//! reaches the Log like any scan's, and the boxes go back to the page.
//!
//! **Transport.** A WebSocket on `127.0.0.1` (`PORT`; a development build has its own), served
//! by a plain thread per connection (`tungstenite`, as `texthooker.rs`). No native-messaging
//! host is needed: an extension's service worker may open a loopback WebSocket itself.
//!
//! **Who may connect.** Any web page can open a WebSocket to `127.0.0.1`, but it cannot choose
//! its `Origin` header: the handshake is refused unless the origin is one of the extension's
//! (`ORIGINS`), so a page can neither have Kimochi read pictures nor read what it returns.
//!
//! **One scan.** `scan` from the extension → the PNG becomes a frame in the frame store → the
//! overlay window hears `browser-scan` and runs its normal pipeline on that frame (the selected
//! engine through `ocr_frame`, normalising, Drop lines and the other filters, the Log through
//! `history_add`) without drawing it → it hands the visible lines to `browser_scan_result` →
//! they go back to the tab as `result`. The protocol is in COMMANDS.md ("Browser bridge").
use crate::state::{Image, Shared};
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{Message, WebSocket};

/// The release app's port; a development build uses the next one, so both can run.
pub const PORT: u16 = if cfg!(dev) { 27641 } else { 27640 };
/// The path the extension connects to.
const PATH: &str = "/kimochi-browser";
/// The extension's origins: the id its manifest key gives an unpacked copy. A store listing gets
/// its own id, added here when it exists.
pub const ORIGINS: &[&str] = &["chrome-extension://njmbcglmnbcahkianbcjhgacoghfjibi"];
/// The setting that turns the bridge on (Settings → Browser).
pub const ENABLED_KEY: &str = "browserExtension.enabled";
/// The input source the Log and the overlay know this mode by.
pub const INPUT_SOURCE: &str = "browser";
const PROTOCOL: u64 = 1;
/// The stylesheet the overlay draws its text boxes with (`ui/overlay-text.css`).
const OVERLAY_CSS: &str = include_str!("../../ui/overlay-text.css");
/// The largest picture accepted, encoded. The extension scales pictures to 4096 px at most.
const MAX_PNG_BYTES: usize = 48 * 1024 * 1024;
/// How long a scan may wait for the overlay before the extension is told it failed.
const SCAN_TIMEOUT: Duration = Duration::from_secs(90);
/// Between reads of a connection, to send what is queued for it.
const POLL: Duration = Duration::from_millis(25);

struct Client {
    id: u64,
    tx: Sender<String>,
    browser: String,
}

struct Pending {
    client: u64,
    /// The extension's own id for this scan.
    id: Value,
    started: Instant,
    /// The Log session its lines go to.
    session: Option<String>,
}

#[derive(Default)]
struct Inner {
    clients: Vec<Client>,
    pending: HashMap<u64, Pending>,
    /// The page last read from: shown on the source card.
    page: Option<Value>,
    last_scan: Option<Value>,
    /// The settings last sent, so only a change goes out.
    sent_settings: Option<Value>,
    /// The Log's sessions (`[{id, name}]`) and its open one, as the Log last reported them
    /// (`browser_sessions`): the Log owns them.
    sessions: Vec<Value>,
    active_session: Option<String>,
    /// The OCR engines the sidebar lists and the selected one (`browser_engines`), for the
    /// tabs' model menus: `{engines: [{id, name, tagline, runs, icon}], selected}`.
    engines: Value,
    /// Requests to the Log (`browser-session`) waiting for its answer.
    session_requests: HashMap<u64, Sender<Result<String, String>>>,
}

pub struct Bridge {
    app: tauri::AppHandle,
    inner: Mutex<Inner>,
    listening: AtomicBool,
    port_error: Mutex<Option<String>>,
    next_client: AtomicU64,
    next_request: AtomicU64,
    generation: AtomicU64,
}

static BRIDGE: OnceLock<Arc<Bridge>> = OnceLock::new();

fn bridge() -> Option<&'static Arc<Bridge>> {
    BRIDGE.get()
}

/// Start the bridge (when its setting is on) and keep it in step with the setting.
pub fn install(app: &tauri::AppHandle) {
    let bridge = BRIDGE.get_or_init(|| {
        Arc::new(Bridge {
            app: app.clone(),
            inner: Mutex::new(Inner::default()),
            listening: AtomicBool::new(false),
            port_error: Mutex::new(None),
            next_client: AtomicU64::new(1),
            next_request: AtomicU64::new(1),
            generation: AtomicU64::new(0),
        })
    });
    bridge.clone().apply_enabled();
}

fn service(app: &tauri::AppHandle) -> Option<Shared> {
    app.try_state::<Shared>().map(|state| state.inner().clone())
}

fn enabled(app: &tauri::AppHandle) -> bool {
    service(app).is_none_or(|service| service.settings.get_or(ENABLED_KEY, true))
}

fn input_source(service: &Shared) -> String {
    service
        .settings
        .get_path(&["superTexthooker", "inputSource"])
        .ok()
        .flatten()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "ocr".into())
}

impl Bridge {
    fn apply_enabled(self: Arc<Self>) {
        let wanted = enabled(&self.app);
        let running = self.listening.load(Ordering::SeqCst);
        if wanted && !running {
            self.clone().start();
        } else if !wanted && running {
            self.stop();
        }
        self.emit_status();
    }

    fn start(self: Arc<Self>) {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(listener) => listener,
            Err(error) => {
                // Another copy of Kimochi (or anything else) holds the port: the rest of the app
                // keeps working, and Settings says why the extension can't connect.
                *self.port_error.lock().unwrap() = Some(format!("Port {PORT} is in use: {error}"));
                self.log(json!({"check": "browser-bridge", "status": "unavailable", "port": PORT, "error": error.to_string()}));
                return;
            }
        };
        if listener.set_nonblocking(true).is_err() {
            return;
        }
        *self.port_error.lock().unwrap() = None;
        self.listening.store(true, Ordering::SeqCst);
        let generation = self.generation.load(Ordering::SeqCst);
        self.log(json!({"check": "browser-bridge", "status": "listening", "port": PORT}));
        let bridge = self.clone();
        std::thread::Builder::new()
            .name("browser-bridge".into())
            .spawn(move || {
                while bridge.generation.load(Ordering::SeqCst) == generation {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let bridge = bridge.clone();
                            let _ = std::thread::Builder::new()
                                .name("browser-bridge-client".into())
                                .spawn(move || bridge.serve(stream, generation));
                        }
                        Err(error) if error.kind() == ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(100));
                        }
                        Err(_) => break,
                    }
                }
            })
            .ok();
    }

    fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.listening.store(false, Ordering::SeqCst);
        let mut inner = self.inner.lock().unwrap();
        // Dropping each sender ends its connection's loop, which closes the socket.
        inner.clients.clear();
        inner.pending.clear();
        drop(inner);
        self.log(json!({"check": "browser-bridge", "status": "stopped"}));
    }

    fn log(&self, value: Value) {
        if let Some(service) = service(&self.app) {
            service.log(value);
        }
    }

    /// One connection, on its own thread, until either side closes it.
    fn serve(self: Arc<Self>, stream: TcpStream, generation: u64) {
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let mut socket = match tungstenite::accept_hdr(stream, check_handshake) {
            Ok(socket) => socket,
            Err(error) => {
                self.log(json!({"check": "browser-bridge", "status": "refused", "error": error.to_string()}));
                return;
            }
        };
        let _ = socket.get_ref().set_read_timeout(Some(POLL));
        let (tx, rx) = mpsc::channel::<String>();
        let id = self.next_client.fetch_add(1, Ordering::SeqCst);
        self.inner.lock().unwrap().clients.push(Client { id, tx: tx.clone(), browser: String::new() });
        self.emit_status();
        self.run(&mut socket, id, &rx, generation);
        let _ = socket.close(None);
        let _ = socket.flush();
        let mut inner = self.inner.lock().unwrap();
        inner.clients.retain(|client| client.id != id);
        inner.pending.retain(|_, pending| pending.client != id);
        if inner.clients.is_empty() {
            inner.page = None;
        }
        drop(inner);
        self.emit_status();
    }

    fn run(&self, socket: &mut WebSocket<TcpStream>, client: u64, rx: &Receiver<String>, generation: u64) {
        loop {
            if self.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            loop {
                match rx.try_recv() {
                    Ok(text) => {
                        if socket.send(Message::Text(text.into())).is_err() {
                            return;
                        }
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    // The bridge dropped this client (stopped).
                    Err(mpsc::TryRecvError::Disconnected) => return,
                }
            }
            match socket.read() {
                Ok(Message::Text(text)) => self.receive(client, text.as_str()),
                Ok(Message::Close(_)) => return,
                Ok(_) => {}
                Err(tungstenite::Error::Io(error))
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    self.expire();
                }
                Err(_) => return,
            }
        }
    }

    fn send_to(&self, client: u64, message: Value) {
        let inner = self.inner.lock().unwrap();
        if let Some(client) = inner.clients.iter().find(|c| c.id == client) {
            let _ = client.tx.send(message.to_string());
        }
    }

    fn broadcast(&self, message: &Value) {
        let text = message.to_string();
        for client in &self.inner.lock().unwrap().clients {
            let _ = client.tx.send(text.clone());
        }
    }

    fn receive(&self, client: u64, text: &str) {
        let Ok(message) = serde_json::from_str::<Value>(text) else { return };
        match message["type"].as_str() {
            Some("hello") => {
                let browser = message["browser"].as_str().unwrap_or_default().to_string();
                if let Some(entry) = self.inner.lock().unwrap().clients.iter_mut().find(|c| c.id == client) {
                    entry.browser = browser;
                }
                self.send_to(
                    client,
                    json!({
                        "type": "welcome",
                        "protocol": PROTOCOL,
                        "app": {"name": "Kimochi", "version": self.app.package_info().version.to_string(), "dev": cfg!(dev)},
                        "settings": self.settings_value(),
                        // The overlay's own look, so the page draws Kimochi's boxes rather than a copy
                        // of them; the values it reads (colour, strength, theme) come with `settings`.
                        "css": OVERLAY_CSS,
                        "sessions": self.sessions_value(),
                        "engines": self.inner.lock().unwrap().engines.clone(),
                    }),
                );
                self.emit_status();
            }
            Some("ping") => self.send_to(client, json!({"type": "pong"})),
            Some("scan") => {
                if let Err(error) = self.scan(client, &message) {
                    self.send_to(client, json!({"type": "error", "id": message["id"], "message": error}));
                }
            }
            Some("stop") => {
                self.inner.lock().unwrap().page = None;
                self.emit_status();
            }
            // Which session a page goes to, when the reader hasn't chosen: one remembered for it
            // or a page like it, else none yet (a new session is made at its first reading).
            Some("page") => {
                let session = self.known_session(&message["url"], &message["title"]);
                self.send_to(client, json!({"type": "page", "id": message["id"], "session": session}));
            }
            // The reader chose a session for this page.
            Some("assign") => {
                if let Some(session) = message["session"].as_str().filter(|id| self.session_exists(id)) {
                    self.remember(&message["url"], &message["title"], session);
                }
            }
            Some("createSession") => {
                let name = message["name"].as_str().map(str::trim).filter(|n| !n.is_empty()).map(str::to_string);
                let reply = match self.ask_log(json!({"op": "create", "name": name})) {
                    Ok(session) => {
                        self.remember(&message["url"], &message["title"], &session);
                        json!({"type": "sessionCreated", "id": message["id"], "session": session})
                    }
                    Err(error) => json!({"type": "sessionCreated", "id": message["id"], "error": error}),
                };
                self.send_to(client, reply);
            }
            // A model picked in a tab's menu: chosen in the app, as the sidebar chooses it.
            Some("setEngine") => {
                if let Some(mode) = message["id"].as_str() {
                    let _ = self.app.emit("browser-engine-choose", json!({"mode": mode}));
                }
            }
            // The toolbar's Open Kimochi, while connected: bring the main window forward.
            Some("show") => crate::account::bring_forward(&self.app, false),
            Some("renameSession") => {
                if let (Some(session), Some(name)) = (message["session"].as_str(), message["name"].as_str()) {
                    let name = name.trim();
                    if !name.is_empty() && self.session_exists(session) {
                        let _ = self.ask_log(json!({"op": "rename", "id": session, "name": name}));
                    }
                }
            }
            _ => {}
        }
    }

    fn scan(&self, client: u64, message: &Value) -> Result<(), String> {
        let service = service(&self.app).ok_or("Kimochi is still starting")?;
        let encoded = message["png"].as_str().ok_or("No picture came with the scan")?;
        if encoded.len() > MAX_PNG_BYTES * 4 / 3 + 4 {
            return Err("That picture is too large".into());
        }
        let png = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "The picture could not be decoded".to_string())?;
        let (width, height) = image::ImageReader::new(std::io::Cursor::new(&png))
            .with_guessed_format()
            .map_err(|e| e.to_string())?
            .into_dimensions()
            .map_err(|_| "That isn't a picture Kimochi can read".to_string())?;
        let page = json!({
            "title": message["page"]["title"].as_str().unwrap_or_default(),
            "url": message["page"]["url"].as_str().unwrap_or_default(),
        });
        let info = json!({
            "width": width, "height": height,
            "full_width": width, "full_height": height,
            "scale_factor": 1.0,
            "source": "browser",
            "page": page,
        });
        let frame = service.images.lock().unwrap().put_latest(Image::encoded(png, info.clone()));
        let reason = message["reason"].as_str().unwrap_or("select").to_string();
        // Picking a picture (or reading it again) says the reader wants Kimochi on the browser:
        // switch to it. An automatic update never switches a reader who has moved on.
        if reason != "auto" {
            self.switch_to_browser(&service);
        } else if input_source(&service) != INPUT_SOURCE {
            return Err("Kimochi is reading another source".into());
        }
        let session = self.session_for(&message["session"], &page);
        let request = self.next_request.fetch_add(1, Ordering::SeqCst);
        {
            let mut inner = self.inner.lock().unwrap();
            inner.pending.insert(
                request,
                Pending { client, id: message["id"].clone(), started: Instant::now(), session: session.clone() },
            );
            inner.page = Some(page.clone());
        }
        self.emit_status();
        self.app
            .emit(
                "browser-scan",
                json!({"request": request, "frame": {"id": frame, "info": info}, "reason": reason, "page": page, "session": session}),
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn switch_to_browser(&self, service: &Shared) {
        if input_source(service) == INPUT_SOURCE {
            return;
        }
        let Ok(value) = service.settings.update_path(&["superTexthooker"], |old| {
            let mut value = old.and_then(Value::as_object).cloned().unwrap_or_default();
            value.insert("inputSource".into(), json!(INPUT_SOURCE));
            Value::Object(value)
        }) else {
            return;
        };
        let _ = self.app.emit("settings:changed", json!({"key": "superTexthooker", "value": value}));
        crate::sync::local_changed();
    }

    /// A scan the overlay never answered.
    fn expire(&self) {
        let expired: Vec<(u64, Pending)> = {
            let mut inner = self.inner.lock().unwrap();
            let ids: Vec<u64> = inner
                .pending
                .iter()
                .filter(|(_, pending)| pending.started.elapsed() > SCAN_TIMEOUT)
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter().filter_map(|id| inner.pending.remove(&id).map(|p| (id, p))).collect()
        };
        for (_, pending) in expired {
            self.send_to(pending.client, json!({"type": "error", "id": pending.id, "message": "Kimochi took too long to read that"}));
        }
    }

    fn finish(&self, request: u64, result: Result<Value, String>) -> bool {
        let Some(pending) = self.inner.lock().unwrap().pending.remove(&request) else {
            return false;
        };
        let ms = pending.started.elapsed().as_millis() as u64;
        match result {
            Ok(result) => {
                let lines = result["lines"].as_array().map_or(0, Vec::len);
                self.inner.lock().unwrap().last_scan = Some(json!({"lines": lines, "ms": ms, "at": now_ms()}));
                let mut message = json!({"type": "result", "id": pending.id, "ms": ms, "session": pending.session});
                if let (Some(target), Some(source)) = (message.as_object_mut(), result.as_object()) {
                    for (key, value) in source {
                        target.insert(key.clone(), value.clone());
                    }
                }
                self.send_to(pending.client, message);
            }
            Err(error) => {
                self.send_to(pending.client, json!({"type": "error", "id": pending.id, "message": error}));
            }
        }
        self.emit_status();
        true
    }

    // ------------------------------------------------------------ sessions

    fn sessions_value(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        json!({"sessions": inner.sessions, "active": inner.active_session})
    }

    fn session_exists(&self, id: &str) -> bool {
        self.inner.lock().unwrap().sessions.iter().any(|s| s["id"] == json!(id))
    }

    /// The pages read before and the sessions they went to (`browserExtension.pages`).
    fn pages(&self) -> Vec<PageMemory> {
        service(&self.app)
            .and_then(|service| service.settings.get("browserExtension.pages").ok().flatten())
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default()
    }

    fn known_session(&self, url: &Value, title: &Value) -> Option<String> {
        let ids: Vec<String> = {
            let inner = self.inner.lock().unwrap();
            inner.sessions.iter().filter_map(|s| s["id"].as_str().map(str::to_string)).collect()
        };
        matched_session(&self.pages(), url.as_str().unwrap_or_default(), title.as_str().unwrap_or_default(), &ids)
    }

    fn remember(&self, url: &Value, title: &Value, session: &str) {
        let Some(service) = service(&self.app) else { return };
        let url = url.as_str().unwrap_or_default();
        if url.is_empty() {
            return;
        }
        let pages = remembered(self.pages(), url, title.as_str().unwrap_or_default(), session, now_ms());
        if service.settings.set("browserExtension.pages", json!(pages)).is_ok() {
            let _ = self.app.emit("settings:changed", json!({"key": "browserExtension.pages", "value": pages}));
        }
    }

    /// The session a scan's lines go to: the one the tab chose, else the one remembered for the
    /// page or a page like it, else a new one (named for the day, as the Log names them). None
    /// when the Log hasn't said which sessions there are (the lines go to its open one).
    fn session_for(&self, requested: &Value, page: &Value) -> Option<String> {
        if self.inner.lock().unwrap().sessions.is_empty() {
            return None;
        }
        if let Some(id) = requested.as_str().filter(|id| self.session_exists(id)) {
            return Some(id.to_string());
        }
        if let Some(id) = self.known_session(&page["url"], &page["title"]) {
            return Some(id);
        }
        let created = self.ask_log(json!({"op": "create"})).ok()?;
        self.remember(&page["url"], &page["title"], &created);
        Some(created)
    }

    /// Ask the Log to make or rename a session (`browser-session`), and wait for its answer
    /// (`browser_session_reply`). Runs on a connection's own thread.
    fn ask_log(&self, mut request: Value) -> Result<String, String> {
        let id = self.next_request.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.inner.lock().unwrap().session_requests.insert(id, tx);
        request["request"] = json!(id);
        if let Err(error) = self.app.emit("browser-session", request) {
            self.inner.lock().unwrap().session_requests.remove(&id);
            return Err(error.to_string());
        }
        let answer = rx.recv_timeout(Duration::from_secs(10));
        self.inner.lock().unwrap().session_requests.remove(&id);
        answer.unwrap_or_else(|_| Err("The Log didn't answer".into()))
    }

    /// What the page needs to draw boxes the way the overlay would.
    fn settings_value(&self) -> Value {
        let Some(service) = service(&self.app) else { return json!({}) };
        let settings = &service.settings;
        let auto_ocr = service.view.lock().unwrap().auto_ocr;
        json!({
            "autoOcr": auto_ocr,
            "clickThrough": settings.get_or("overlayClickThrough", true),
            "overlayStyle": settings.get("overlayStyle").ok().flatten().unwrap_or(Value::Null),
            "appearance": settings.get_or("appearance", "system".to_string()),
            "grouping": settings.get_or("textOverlayGrouping.enabled", false),
            "active": input_source(&service) == INPUT_SOURCE,
        })
    }

    /// Send the settings to every tab when they changed; tell them when Kimochi left the browser.
    fn settings_changed(&self) {
        let settings = self.settings_value();
        let previous = {
            let mut inner = self.inner.lock().unwrap();
            if inner.sent_settings.as_ref() == Some(&settings) {
                return;
            }
            inner.sent_settings.replace(settings.clone())
        };
        self.broadcast(&json!({"type": "settings", "settings": settings}));
        let was_active = previous.as_ref().is_some_and(|p| p["active"] == json!(true));
        if was_active && settings["active"] != json!(true) {
            self.broadcast(&json!({"type": "ended"}));
            self.inner.lock().unwrap().page = None;
        }
        self.emit_status();
    }

    fn status(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        let browsers: Vec<&str> = inner.clients.iter().map(|c| browser_name(&c.browser)).collect();
        json!({
            "enabled": enabled(&self.app),
            "listening": self.listening.load(Ordering::SeqCst),
            "port": PORT,
            "error": *self.port_error.lock().unwrap(),
            "connected": inner.clients.len(),
            "browsers": browsers,
            "page": inner.page,
            "lastScan": inner.last_scan,
            "reading": !inner.pending.is_empty(),
        })
    }

    fn emit_status(&self) {
        let _ = self.app.emit("browser-bridge", self.status());
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// A short name for a user agent, for Settings ("Chrome", "Edge", …).
fn browser_name(agent: &str) -> &'static str {
    if agent.contains("Edg/") {
        "Edge"
    } else if agent.contains("OPR/") {
        "Opera"
    } else if agent.contains("Vivaldi") {
        "Vivaldi"
    } else if agent.contains("Brave") {
        "Brave"
    } else if agent.contains("Chrome/") {
        "Chrome"
    } else if agent.contains("Firefox/") {
        "Firefox"
    } else {
        "Browser"
    }
}

/// Only the extension, on the bridge's path. (Its shape is tungstenite's handshake callback.)
#[allow(clippy::result_large_err)]
fn check_handshake(request: &Request, response: Response) -> Result<Response, ErrorResponse> {
    let origin = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if request.uri().path() != PATH || !origin_allowed(origin) {
        let mut refusal = ErrorResponse::new(Some("Only the Kimochi extension may connect".into()));
        *refusal.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
        return Err(refusal);
    }
    Ok(response)
}

fn origin_allowed(origin: &str) -> bool {
    let origin = origin.trim_end_matches('/');
    ORIGINS.contains(&origin)
}

// ---------------------------------------------------------------- hooks from the rest of the app

/// A setting changed (`settings_set`, `reader_settings_patch`, Sync): start or stop the server,
/// and pass on what the page draws with.
pub fn on_setting(key: &str) {
    let Some(bridge) = bridge() else { return };
    if key == ENABLED_KEY || key == "browserExtension" {
        bridge.clone().apply_enabled();
    }
    bridge.settings_changed();
}

/// A view flag changed (Auto OCR).
pub fn on_view_flags() {
    if let Some(bridge) = bridge() {
        bridge.settings_changed();
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn browser_bridge_status() -> Value {
    bridge().map_or(json!({"enabled": false, "listening": false}), |bridge| bridge.status())
}

/// The overlay's answer to `browser-scan`: the lines to draw (`{lines, groups, width, height,
/// engine}`), or why there are none.
#[tauri::command]
pub fn browser_scan_result(request: u64, result: Option<Value>, error: Option<String>) -> Result<bool, String> {
    let bridge = bridge().ok_or("native: the browser bridge is not running")?;
    let outcome = match (result, error) {
        (_, Some(error)) => Err(error),
        (Some(result), None) => Ok(result),
        (None, None) => Err("Kimochi could not read that".into()),
    };
    Ok(bridge.finish(request, outcome))
}

/// The Log's sessions, sent by the Log whenever they change (and when it starts): every tab's
/// session menu follows them.
#[tauri::command]
pub fn browser_sessions(sessions: Vec<Value>, active: Option<String>) -> Result<(), String> {
    let bridge = bridge().ok_or("native: the browser bridge is not running")?;
    let sessions: Vec<Value> = sessions
        .into_iter()
        .filter_map(|s| Some(json!({"id": s["id"].as_str()?, "name": s["name"].as_str().unwrap_or_default()})))
        .collect();
    {
        let mut inner = bridge.inner.lock().unwrap();
        if inner.sessions == sessions && inner.active_session == active {
            return Ok(());
        }
        inner.sessions = sessions;
        inner.active_session = active;
    }
    bridge.broadcast(&json!({"type": "sessions", "sessions": bridge.sessions_value()}));
    Ok(())
}

/// The OCR engines as the sidebar lists them, and the selected one: sent by the main window
/// whenever either changes (frontend/main/BrowserEngines.tsx).
#[tauri::command]
pub fn browser_engines(engines: Vec<Value>, selected: String) -> Result<(), String> {
    let bridge = bridge().ok_or("native: the browser bridge is not running")?;
    let value = json!({"engines": engines, "selected": selected});
    {
        let mut inner = bridge.inner.lock().unwrap();
        if inner.engines == value {
            return Ok(());
        }
        inner.engines = value.clone();
    }
    bridge.broadcast(&json!({"type": "engines", "engines": value}));
    Ok(())
}

/// The Log's answer to `browser-session`: the session made or renamed, or why not.
#[tauri::command]
pub fn browser_session_reply(request: u64, id: Option<String>, error: Option<String>) -> Result<(), String> {
    let bridge = bridge().ok_or("native: the browser bridge is not running")?;
    if let Some(tx) = bridge.inner.lock().unwrap().session_requests.remove(&request) {
        let _ = tx.send(match (id, error) {
            (Some(id), None) => Ok(id),
            (_, error) => Err(error.unwrap_or_else(|| "The Log couldn't do that".into())),
        });
    }
    Ok(())
}

/// Ask the page to read its picture again (the main window's Scan button, the scan shortcut).
#[tauri::command]
pub fn browser_rescan() -> Result<bool, String> {
    let bridge = bridge().ok_or("native: the browser bridge is not running")?;
    let any = !bridge.inner.lock().unwrap().clients.is_empty();
    bridge.broadcast(&json!({"type": "rescan"}));
    Ok(any)
}

/// The folder to load in the browser (chrome://extensions → Load unpacked), shown in the file
/// manager. A development build uses the repository's copy; a bundle copies its own into the
/// app data directory, a place that outlives updates (Load unpacked keeps pointing at it, and
/// each Kimochi update refreshes it here).
#[tauri::command]
#[allow(deprecated)] // the shell plugin's `open` is the opener the app already uses
pub fn browser_extension_folder(app: tauri::AppHandle, reveal: Option<bool>) -> Result<String, String> {
    let folder = extension_folder(&app)?;
    if reveal.unwrap_or(true) {
        use tauri_plugin_shell::ShellExt;
        app.shell()
            .open(folder.to_string_lossy().to_string(), None)
            .map_err(|e| format!("native: could not open the folder: {e}"))?;
    }
    Ok(folder.to_string_lossy().to_string())
}

fn extension_folder(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if cfg!(dev) {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../browser-extension/extension");
        return repo.canonicalize().map_err(|e| format!("native: {e}"));
    }
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("browser-extension");
    let target = app.path().app_data_dir().map_err(|e| e.to_string())?.join("browser-extension");
    copy_dir(&bundled, &target).map_err(|e| format!("native: could not copy the extension: {e}"))?;
    Ok(target)
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- which session a page goes to

/// A page read before and the session its lines went to.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct PageMemory {
    pub url: String,
    pub title: String,
    pub session: String,
    pub at: u64,
}

/// How many pages are remembered; the oldest go first.
const MAX_PAGES: usize = 300;

/// Numbers say which page or chapter, not which work: `…/chapter-12/page-3` and `第12話 (3/20)`
/// are the same work as chapter 13's. Every run of digits (ASCII or full-width) becomes `#`.
fn without_numbers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_number = false;
    for c in text.chars() {
        if c.is_ascii_digit() || ('０'..='９').contains(&c) {
            if !in_number {
                out.push('#');
            }
            in_number = true;
        } else {
            in_number = false;
            out.push(c);
        }
    }
    out
}

/// A URL as host and path, numbers out, without its fragment, query values or trailing slash.
fn url_key(url: &str) -> (String, String) {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let rest = rest.split('#').next().unwrap_or_default();
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (host, path) = path.split_once('/').unwrap_or((path, ""));
    let mut keys: Vec<&str> = query.split('&').filter_map(|pair| pair.split('=').next()).filter(|k| !k.is_empty()).collect();
    keys.sort_unstable();
    let host = host.trim_start_matches("www.").to_lowercase();
    let path = without_numbers(path.trim_end_matches('/'));
    (host, if keys.is_empty() { path } else { format!("{path}?{}", keys.join("&")) })
}

fn title_key(title: &str) -> String {
    without_numbers(&title.to_lowercase()).split_whitespace().collect::<Vec<_>>().join(" ")
}

/// How alike two titles are, 0–1: shared character pairs (Dice), which works for Japanese titles
/// with no spaces as well as for English ones.
fn similarity(a: &str, b: &str) -> f64 {
    let pairs = |s: &str| -> Vec<(char, char)> {
        let chars: Vec<char> = s.chars().filter(|c| !c.is_whitespace()).collect();
        chars.windows(2).map(|w| (w[0], w[1])).collect()
    };
    let (a, mut b) = (pairs(a), pairs(b));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let total = a.len() + b.len();
    let mut shared = 0;
    for pair in &a {
        if let Some(i) = b.iter().position(|p| p == pair) {
            b.swap_remove(i);
            shared += 1;
        }
    }
    2.0 * shared as f64 / total as f64
}

/// The session remembered for this page, or for the page most like it: the same address with
/// only numbers changed, else the same site and title with only numbers changed, else the same
/// site and a title that is mostly the same. The most recent wins a tie. Only live sessions.
pub fn matched_session(pages: &[PageMemory], url: &str, title: &str, live: &[String]) -> Option<String> {
    let (host, path) = url_key(url);
    let title = title_key(title);
    let mut best: Option<(f64, u64, &str)> = None;
    for page in pages.iter().filter(|p| live.contains(&p.session)) {
        let (page_host, page_path) = url_key(&page.url);
        if page_host != host {
            continue;
        }
        let page_title = title_key(&page.title);
        let score = if page_path == path {
            3.0
        } else if !title.is_empty() && page_title == title {
            2.0
        } else {
            let alike = similarity(&page_title, &title);
            if alike >= 0.75 { 1.0 + alike / 2.0 - 0.5 } else { continue }
        };
        if best.is_none_or(|(s, at, _)| score > s || (score == s && page.at > at)) {
            best = Some((score, page.at, &page.session));
        }
    }
    best.map(|(_, _, session)| session.to_string())
}

/// The list with this page's session recorded: its old entry replaced, newest first, capped.
pub fn remembered(mut pages: Vec<PageMemory>, url: &str, title: &str, session: &str, at: u64) -> Vec<PageMemory> {
    let key = url_key(url);
    pages.retain(|p| url_key(&p.url) != key);
    pages.insert(0, PageMemory { url: url.into(), title: title.into(), session: session.into(), at });
    pages.truncate(MAX_PAGES);
    pages
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(url: &str, title: &str, session: &str, at: u64) -> PageMemory {
        PageMemory { url: url.into(), title: title.into(), session: session.into(), at }
    }

    #[test]
    fn page_numbers_do_not_change_the_session() {
        let live = vec!["a".to_string(), "b".to_string()];
        let pages = vec![page("https://reader.example.com/manga/123/chapter-4/page/2?lang=ja", "よつばと！ 第4話 (2/20)", "a", 1)];
        assert_eq!(matched_session(&pages, "https://reader.example.com/manga/123/chapter-5/page/17?lang=ja", "x", &live).as_deref(), Some("a"));
        assert_eq!(matched_session(&pages, "https://reader.example.com/view?id=9", "よつばと！ 第5話 (17/20)", &live).as_deref(), Some("a"));
        assert_eq!(matched_session(&pages, "https://other.example.org/manga/123/chapter-5/page/17?lang=ja", "よつばと！ 第4話", &live), None);
    }

    #[test]
    fn a_mostly_alike_title_matches_and_a_different_one_does_not() {
        let live = vec!["a".to_string()];
        let pages = vec![page("https://site.jp/a", "ドラゴンクエスト 攻略 - 町の人の会話", "a", 1)];
        assert_eq!(matched_session(&pages, "https://site.jp/b", "ドラゴンクエスト 攻略 - 町の人の会話集", &live).as_deref(), Some("a"));
        assert_eq!(matched_session(&pages, "https://site.jp/c", "天気予報", &live), None);
    }

    #[test]
    fn deleted_sessions_and_older_entries_lose() {
        let pages = vec![page("https://s.jp/x", "T", "gone", 9), page("https://s.jp/x", "T", "old", 1), page("https://s.jp/x", "T", "new", 5)];
        let live = vec!["old".to_string(), "new".to_string()];
        assert_eq!(matched_session(&pages, "https://s.jp/x", "T", &live).as_deref(), Some("new"));
    }

    #[test]
    fn remembering_replaces_the_page_and_caps_the_list() {
        let mut pages = Vec::new();
        for i in 0..400 {
            pages = remembered(pages, &format!("https://s.jp/work{}/x", ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"][i % 10].repeat(i / 10 + 1)), "t", "s", i as u64);
        }
        assert_eq!(pages.len(), MAX_PAGES);
        let pages = remembered(vec![page("https://s.jp/ch/1", "t", "a", 1)], "https://s.jp/ch/2", "t", "b", 2);
        assert_eq!(pages, vec![page("https://s.jp/ch/2", "t", "b", 2)]);
    }

    #[test]
    fn only_the_extension_origin_is_allowed() {
        assert!(origin_allowed("chrome-extension://njmbcglmnbcahkianbcjhgacoghfjibi"));
        assert!(origin_allowed("chrome-extension://njmbcglmnbcahkianbcjhgacoghfjibi/"));
        assert!(!origin_allowed("https://example.com"));
        assert!(!origin_allowed("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(!origin_allowed(""));
        assert!(!origin_allowed("null"));
    }

    #[test]
    fn names_browsers() {
        assert_eq!(browser_name("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/156.0 Safari/537.36"), "Chrome");
        assert_eq!(browser_name("Mozilla/5.0 Chrome/156.0 Safari/537.36 Edg/156.0"), "Edge");
    }

    fn handshake(origin: Option<&str>, path: &str) -> bool {
        let mut builder = Request::builder().uri(format!("ws://127.0.0.1{path}"));
        if let Some(origin) = origin {
            builder = builder.header("Origin", origin);
        }
        let request = builder.body(()).unwrap();
        check_handshake(&request, Response::new(())).is_ok()
    }

    #[test]
    fn handshake_needs_origin_and_path() {
        assert!(handshake(Some(ORIGINS[0]), PATH));
        assert!(!handshake(Some(ORIGINS[0]), "/"));
        assert!(!handshake(Some("http://localhost:3000"), PATH));
        assert!(!handshake(None, PATH));
    }
}
