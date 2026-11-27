//! Clipboard output and the texthooker WebSocket **server**.
//!
//! This has to live in Rust: `texthooker-ui` connects to Kimochi, so the app hosts
//! the server, and a webview cannot listen on a port. Mirrors
//! `src/main/texthooker.ts`, including restarting only when the toggle or URL
//! changes and warning rather than throwing when the port is taken.
use crate::settings::Settings;
use serde_json::json;

use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tungstenite::WebSocket;

type Client = Arc<Mutex<WebSocket<std::net::TcpStream>>>;

/// Bound on the WebSocket handshake and on each send. A texthooker client that stops
/// reading must not be able to stall the app.
const IO_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
struct Server {
    port: u16,
    clients: Vec<Client>,
}

pub struct Texthooker {
    settings: Arc<Settings>,
    server: Arc<Mutex<Option<Server>>>,
    /// Bumped on every stop so an accept loop from a previous configuration exits.
    generation: Arc<AtomicU64>,
    log: Arc<dyn Fn(serde_json::Value) + Send + Sync>,
}

fn parse_port(url: &str) -> Option<u16> {
    let port = url.rsplit(':').next()?;
    let port: u16 = port.trim_end_matches('/').parse().ok()?;
    (port > 0).then_some(port)
}

impl Texthooker {
    pub fn new(settings: Arc<Settings>, log: Arc<dyn Fn(serde_json::Value) + Send + Sync>) -> Self {
        Self { settings, server: Arc::new(Mutex::new(None)), generation: Arc::new(AtomicU64::new(0)), log }
    }

    /// Send scans over WebSocket.
    fn sends_scans(&self) -> bool {
        self.settings.get_or("texthookerSettings.sendToWebSocket", false)
    }

    /// Send hooked lines over WebSocket.
    fn sends_hooked_lines(&self) -> bool {
        self.settings.get_or("texthookerSettings.sendHookedLines", false)
    }

    /// The server runs while either switch is on; both share its URL.
    fn enabled(&self) -> bool {
        self.sends_scans() || self.sends_hooked_lines()
    }

    fn url(&self) -> String {
        self.settings.get_or("texthookerSettings.webSocketUrl", "ws://localhost:6677".to_string())
    }

    pub fn start(&self) {
        if !self.enabled() {
            return;
        }
        let Some(port) = parse_port(&self.url()) else {
            (self.log)(json!({
                "check": "texthooker",
                "status": "invalid-url",
                "detail": format!("{:?} has no usable port", self.url()),
            }));
            return;
        };
        if self.server.lock().unwrap().as_ref().is_some_and(|s| s.port == port) {
            return;
        }
        self.stop();
        let listener = match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => listener,
            Err(e) => {
                // A taken port is a warning, never a crash: another texthooker may
                // already own it and the rest of the app must keep working.
                (self.log)(json!({
                    "check": "texthooker",
                    "status": "unavailable",
                    "detail": format!("port {port} could not be opened: {e}"),
                }));
                return;
            }
        };
        if listener.set_nonblocking(true).is_err() {
            return;
        }
        *self.server.lock().unwrap() = Some(Server { port, clients: Vec::new() });
        let generation = self.generation.load(Ordering::SeqCst);
        let current = self.generation.clone();
        let server = self.server.clone();
        let log = self.log.clone();
        std::thread::spawn(move || {
            while current.load(Ordering::SeqCst) == generation {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        // Bound the handshake and every later write. Without these a
                        // single stalled peer would block this accept loop from ever
                        // noticing a shutdown, and would later hold the client lock
                        // for as long as it refused to read.
                        let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
                        let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
                        if let Ok(socket) = tungstenite::accept(stream) {
                            // The handshake can take a while; the server may have been
                            // stopped or reconfigured meanwhile.
                            if current.load(Ordering::SeqCst) != generation {
                                break;
                            }
                            if let Some(server) = server.lock().unwrap().as_mut() {
                                server.clients.push(Arc::new(Mutex::new(socket)));
                            }
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    Err(_) => break,
                }
            }
            log(json!({"check": "texthooker", "status": "stopped"}));
        });
        (self.log)(json!({"check": "texthooker", "status": "listening", "port": port}));
    }

    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(server) = self.server.lock().unwrap().take() {
            for client in server.clients {
                if let Ok(mut socket) = client.lock() {
                    let _ = socket.close(None);
                }
            }
        }
    }

    /// Restart only when the toggle or the URL actually changed, matching Electron.
    pub fn settings_changed(&self) {
        let running = self.server.lock().unwrap().as_ref().map(|s| s.port);
        let wanted = self.enabled().then(|| parse_port(&self.url())).flatten();
        if running == wanted {
            return;
        }
        self.stop();
        if wanted.is_some() {
            self.start();
        }
    }

    /// An OCR scan: copied when Copy scans to clipboard is on, sent when Send scans over
    /// WebSocket is.
    pub fn publish(&self, text: &str) {
        if text.trim().is_empty() {
            return;
        }
        if self.settings.get_or("texthookerSettings.copyToClipboard", false) {
            match arboard::Clipboard::new().and_then(|mut c| c.set_text(text.to_string())) {
                Ok(()) => {}
                Err(e) => (self.log)(json!({
                    "check": "texthooker",
                    "status": "clipboard-failed",
                    "detail": e.to_string(),
                })),
            }
        }
        if self.sends_scans() {
            self.broadcast(text);
        }
    }

    /// A line the Log took in from the Text Hooker: sent when Send hooked lines over WebSocket
    /// is on. The Log copies it to the clipboard itself.
    pub fn publish_hooked(&self, text: &str) {
        if !text.trim().is_empty() && self.sends_hooked_lines() {
            self.broadcast(text);
        }
    }

    fn broadcast(&self, text: &str) {
        // Take a snapshot and send outside the server lock: a slow client must not be
        // able to block `settings_changed` or another `publish`.
        let clients: Vec<Client> = match self.server.lock().unwrap().as_ref() {
            Some(server) => server.clients.clone(),
            None => return,
        };
        let mut dead: Vec<Client> = Vec::new();
        for client in clients {
            let ok = match client.lock() {
                Ok(mut socket) => {
                    socket.send(tungstenite::Message::Text(text.into())).and_then(|()| socket.flush()).is_ok()
                }
                Err(_) => false,
            };
            if !ok {
                dead.push(client);
            }
        }
        if dead.is_empty() {
            return;
        }
        // Drop clients that have gone away rather than retrying them forever.
        if let Some(server) = self.server.lock().unwrap().as_mut() {
            server.clients.retain(|client| !dead.iter().any(|d| Arc::ptr_eq(d, client)));
        }
    }
}

/// Keeps the clipboard write path honest about its own failure mode.
impl std::fmt::Debug for Texthooker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Texthooker")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Ask the OS for a free port, then release it for the server to claim.
    fn free_port() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind ephemeral");
        listener.local_addr().expect("local addr").port()
    }

    fn hooker(port: u16) -> Texthooker {
        hooker_with(port, "sendToWebSocket")
    }

    /// A texthooker serving on `port` with only the switch `key` on (the test's settings file
    /// may be left from an earlier run on the same port, so both are set).
    fn hooker_with(port: u16, key: &str) -> Texthooker {
        let settings = Arc::new(crate::settings::Settings::load(
            std::env::temp_dir().join(format!("kimochi-texthooker-test-{port}.json")),
        ));
        settings
            .set_many(&[
                (&["texthookerSettings", "sendToWebSocket"], json!(key == "sendToWebSocket")),
                (&["texthookerSettings", "sendHookedLines"], json!(key == "sendHookedLines")),
                (&["texthookerSettings", "webSocketUrl"], json!(format!("ws://127.0.0.1:{port}"))),
            ])
            .expect("settings");
        Texthooker::new(settings, Arc::new(|_| {}))
    }

    /// Start `hooker` on `port` and connect a client to it, once the server has registered it.
    fn connect(hooker: &Texthooker, port: u16) -> WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>> {
        hooker.start();
        let mut client = None;
        for _ in 0..50 {
            if let Ok((socket, _)) = tungstenite::connect(format!("ws://127.0.0.1:{port}")) {
                client = Some(socket);
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let client = client.expect("client should connect to the texthooker server");
        // Give the accept loop a moment to register the connection.
        for _ in 0..50 {
            if hooker.server.lock().unwrap().as_ref().is_some_and(|s| !s.clients.is_empty()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        client
    }

    /// Loopback only, no external network: a real client connects and receives a real
    /// frame, which is the part that unit-testing `parse_port` alone would miss.
    #[test]
    fn publishes_text_to_a_connected_local_client() {
        let port = free_port();
        let hooker = hooker(port);
        let mut client = connect(&hooker, port);
        hooker.publish("日本語");
        let message = client.read().expect("read frame");
        assert_eq!(message.into_text().unwrap().as_str(), "日本語");
        hooker.stop();
    }

    /// Each switch sends only its own lines: with only Send hooked lines on, a scan is not sent
    /// and a hooked line is; the next frame the client reads is the hooked line.
    #[test]
    fn hooked_lines_and_scans_follow_their_own_switches() {
        for (key, sent) in [("sendHookedLines", "「おはよう」"), ("sendToWebSocket", "スキャン")] {
            let port = free_port();
            let texthooker = hooker_with(port, key);
            let mut client = connect(&texthooker, port);
            texthooker.publish("スキャン");
            texthooker.publish_hooked("「おはよう」");
            let message = client.read().expect("read frame");
            assert_eq!(message.into_text().unwrap().as_str(), sent, "with only {key} on");
            texthooker.stop();
        }
    }

    #[test]
    fn blank_text_is_never_published() {
        let port = free_port();
        let hooker = hooker(port);
        hooker.start();
        // No client, no panic, and nothing is sent for whitespace-only input.
        hooker.publish("   ");
        hooker.stop();
    }

    #[test]
    fn ports_are_parsed_from_websocket_urls() {
        assert_eq!(parse_port("ws://localhost:6677"), Some(6677));
        assert_eq!(parse_port("ws://127.0.0.1:1234/"), Some(1234));
        assert_eq!(parse_port("ws://localhost"), None);
        assert_eq!(parse_port("ws://localhost:0"), None);
        assert_eq!(parse_port("nonsense"), None);
    }
}
