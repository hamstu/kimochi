//! Hachidori's Sharing → Link, through Kimochi (COMMANDS.md "Hachidori's loopback origin").
//!
//! A Hachidori relay (the Anki add-on's, or the standalone hachidori-relay) admits a WebSocket on
//! `/link` only from `chrome-extension://…`, `moz-extension://…` or the native Hoshidicts apps'
//! `hoshi://hoshidicts`, and answers anything else with 403. Hachidori inside Kimochi is served
//! from `http://127.0.0.1:<port>`, and a page cannot choose the `Origin` its WebSocket sends, so
//! linking failed with Hachidori's "No shared Hachidori answered at …".
//!
//! So Hachidori's background page opens its link socket to this route instead, on its own origin
//! (`host/ext/relay-link.js` rewrites `ws://<relay>/link` to
//! `ws://127.0.0.1:<port>/__kimochi/relay-link?to=<relay>`). Here the upgrade is repeated to the
//! relay with the native apps' origin, the relay's answer is passed back, and from then on bytes
//! are copied both ways untouched: no frame is parsed, so the link costs one loopback hop and
//! nothing per message. Only the loopback origin's own pages reach this route (`loopback.rs`), and
//! it only ever opens a relay's `/link`, the endpoint the native apps may use.
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// The route on the loopback origin.
pub const PATH: &str = "/__kimochi/relay-link";
/// The origin the relay admits to `/link` from a native app.
pub const ORIGIN: &str = "hoshi://hoshidicts";
/// The only endpoint opened on the relay.
const LINK_PATH: &str = "/link";
/// Hachidori gives a connection 5 s (sharing-client.js `CONNECT_WAIT_MS`); answer within that.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const HEAD_TIMEOUT: Duration = Duration::from_secs(4);
/// The relay's upgrade answer is a few hundred bytes.
const MAX_HEAD: usize = 16 * 1024;
/// Copy buffers: dictionary lists and settings snapshots arrive in large messages.
const BUFFER: usize = 64 * 1024;

/// The relay a bridge request names: `to=<host>:<port>` in the query, as `host:port`.
pub fn target(query: Option<&str>) -> Result<String, &'static str> {
    let query = query.ok_or("no relay")?;
    let to = tauri::Url::parse(&format!("http://bridge/?{query}"))
        .ok()
        .and_then(|url| url.query_pairs().find(|(k, _)| k == "to").map(|(_, v)| v.into_owned()))
        .ok_or("no relay")?;
    let url = tauri::Url::parse(&format!("ws://{to}/")).map_err(|_| "bad relay")?;
    let host = url.host_str().filter(|h| !h.is_empty()).ok_or("bad relay")?;
    let port = url.port().ok_or("no port")?;
    if !url.username().is_empty() || url.password().is_some() || url.path() != "/" || url.query().is_some() {
        return Err("bad relay");
    }
    Ok(format!("{host}:{port}"))
}

/// The upgrade sent to the relay: the client's key (so the relay's accept is the one the client
/// checks), its subprotocols and extensions, and the native apps' origin.
pub fn upstream_request(to: &str, headers: &HeaderMap) -> Result<String, &'static str> {
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let key = get("sec-websocket-key").ok_or("no key")?;
    let mut request = format!(
        "GET {LINK_PATH} HTTP/1.1\r\nHost: {to}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: {}\r\nOrigin: {ORIGIN}\r\n",
        get("sec-websocket-version").unwrap_or("13")
    );
    for name in ["sec-websocket-protocol", "sec-websocket-extensions"] {
        if let Some(value) = get(name) {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    request.push_str("\r\n");
    Ok(request)
}

/// A relay's answer to the upgrade.
#[derive(Debug, PartialEq, Eq)]
pub struct Head {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

impl Head {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// Where the head ends (after its blank line), once the whole head is in `buf`.
pub fn head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

pub fn parse_head(head: &[u8]) -> Option<Head> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let status = lines.next()?.split(' ').nth(1)?.parse().ok()?;
    let headers = lines
        .filter(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':').map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned())))
        .collect();
    Some(Head { status, headers })
}

/// Connect to the relay and make the upgrade: the open stream, the relay's head, and whatever
/// arrived after the head (the relay may speak first).
async fn open(to: &str, request: &str) -> Result<(TcpStream, Head, Vec<u8>), &'static str> {
    let mut stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(to))
        .await
        .map_err(|_| "connect timed out")?
        .map_err(|_| "unreachable")?;
    let _ = stream.set_nodelay(true);
    stream.write_all(request.as_bytes()).await.map_err(|_| "unreachable")?;
    let mut buf = Vec::with_capacity(1024);
    let end = tokio::time::timeout(HEAD_TIMEOUT, async {
        let mut chunk = [0u8; 2048];
        loop {
            if let Some(end) = head_end(&buf) {
                return Ok(end);
            }
            if buf.len() > MAX_HEAD {
                return Err("bad answer");
            }
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return Err("closed"),
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
    })
    .await
    .map_err(|_| "answer timed out")??;
    let head = parse_head(&buf[..end]).ok_or("bad answer")?;
    Ok((stream, head, buf.split_off(end)))
}

fn status_only(status: StatusCode) -> axum::response::Response {
    axum::response::Response::builder().status(status).body(axum::body::Body::empty()).unwrap_or_default()
}

/// Answer a bridge request from the loopback origin (admitted by `loopback.rs`). `report` gets one
/// record per connection attempt.
pub async fn bridge(
    mut request: axum::extract::Request,
    report: impl Fn(Value) + Send + 'static,
) -> axum::response::Response {
    let started = Instant::now();
    // Hachidori retries a failed link every 10 s for as long as it is set to link: a failure is
    // recorded when it differs from the last outcome, a success always.
    let report = move |value: Value| {
        static LAST: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);
        let mut key = value.clone();
        if let Some(record) = key.as_object_mut() {
            record.remove("ms");
        }
        let changed = LAST.lock().map(|mut last| last.replace(key.clone()) != Some(key)).unwrap_or(true);
        if changed || value["ok"] == true {
            report(value);
        }
    };
    let upgrade = request
        .headers()
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    if !upgrade {
        return status_only(StatusCode::BAD_REQUEST);
    }
    let to = match target(request.uri().query()) {
        Ok(to) => to,
        Err(why) => {
            report(json!({ "check": "hachidori-relay-link", "ok": false, "why": why }));
            return status_only(StatusCode::BAD_REQUEST);
        }
    };
    let Ok(upstream_head) = upstream_request(&to, request.headers()) else {
        return status_only(StatusCode::BAD_REQUEST);
    };
    let (upstream, head, early) = match open(&to, &upstream_head).await {
        Ok(opened) => opened,
        Err(why) => {
            report(json!({ "check": "hachidori-relay-link", "ok": false, "to": to, "why": why }));
            return status_only(StatusCode::BAD_GATEWAY);
        }
    };
    if head.status != 101 {
        // The relay's refusal (403 for a refused origin, 503 with no sharing Hachidori), as is:
        // the socket fails exactly as a direct one would.
        report(json!({ "check": "hachidori-relay-link", "ok": false, "to": to, "status": head.status }));
        return status_only(StatusCode::from_u16(head.status).unwrap_or(StatusCode::BAD_GATEWAY));
    }
    let Some(accept) = head.header("sec-websocket-accept").and_then(|v| HeaderValue::from_str(v).ok()) else {
        report(json!({ "check": "hachidori-relay-link", "ok": false, "to": to, "why": "no accept" }));
        return status_only(StatusCode::BAD_GATEWAY);
    };
    let on_upgrade = hyper::upgrade::on(&mut request);
    let mut response = axum::response::Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::UPGRADE, "websocket")
        .header(header::CONNECTION, "Upgrade")
        .header(header::SEC_WEBSOCKET_ACCEPT, accept);
    for name in [header::SEC_WEBSOCKET_PROTOCOL, header::SEC_WEBSOCKET_EXTENSIONS] {
        if let Some(value) = head.header(name.as_str()).and_then(|v| HeaderValue::from_str(v).ok()) {
            response = response.header(name, value);
        }
    }
    report(
        json!({ "check": "hachidori-relay-link", "ok": true, "to": to, "ms": started.elapsed().as_millis() as u64 }),
    );
    tokio::spawn(async move {
        let Ok(upgraded) = on_upgrade.await else { return };
        let mut client = hyper_util::rt::TokioIo::new(upgraded);
        let mut upstream = upstream;
        if !early.is_empty() && client.write_all(&early).await.is_err() {
            return;
        }
        let _ = tokio::io::copy_bidirectional_with_sizes(&mut client, &mut upstream, BUFFER, BUFFER).await;
    });
    response.body(axum::body::Body::empty()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener as StdListener;

    #[test]
    fn the_target_is_a_host_and_port() {
        assert_eq!(target(Some("to=127.0.0.1%3A8771")), Ok("127.0.0.1:8771".into()));
        assert_eq!(target(Some("to=192.168.1.20:8771")), Ok("192.168.1.20:8771".into()));
        assert_eq!(target(Some("to=desk.local:9000")), Ok("desk.local:9000".into()));
        assert_eq!(target(Some("to=%5B%3A%3A1%5D%3A8771")), Ok("[::1]:8771".into()));
        assert_eq!(target(None), Err("no relay"));
        assert_eq!(target(Some("x=1")), Err("no relay"));
        assert_eq!(target(Some("to=127.0.0.1")), Err("no port"));
        assert!(target(Some("to=127.0.0.1:8771/admin")).is_err());
        assert!(target(Some("to=me%40127.0.0.1:8771")).is_err());
        assert!(target(Some("to=127.0.0.1:8771%3Fa%3Db")).is_err());
    }

    #[test]
    fn the_relay_sees_the_native_origin_and_the_clients_key() {
        let mut headers = HeaderMap::new();
        headers.insert("sec-websocket-key", HeaderValue::from_static("dGhlIHNhbXBsZSBub25jZQ=="));
        headers.insert("sec-websocket-version", HeaderValue::from_static("13"));
        headers.insert("origin", HeaderValue::from_static("http://127.0.0.1:27631"));
        let request = upstream_request("127.0.0.1:8771", &headers).unwrap();
        assert!(request.starts_with("GET /link HTTP/1.1\r\nHost: 127.0.0.1:8771\r\n"));
        assert!(request.contains("\r\nOrigin: hoshi://hoshidicts\r\n"));
        assert!(request.contains("\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"));
        assert!(!request.contains("27631"));
        assert!(request.ends_with("\r\n\r\n"));
        assert_eq!(upstream_request("127.0.0.1:8771", &HeaderMap::new()), Err("no key"));
    }

    #[test]
    fn heads_are_read_whole() {
        let raw =
            b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: abc=\r\n\r\n\x81\x02hi";
        let end = head_end(raw).unwrap();
        let head = parse_head(&raw[..end]).unwrap();
        assert_eq!(head.status, 101);
        assert_eq!(head.header("sec-websocket-accept"), Some("abc="));
        assert_eq!(&raw[end..], b"\x81\x02hi");
        assert_eq!(head_end(b"HTTP/1.1 101 OK\r\nUpgrade: websocket\r\n"), None);
    }

    /// A relay stand-in: admits `/link` only from the native origin, like the real one, then
    /// echoes every message.
    fn fake_relay() -> u16 {
        let listener = StdListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || {
                    let check = |req: &tungstenite::handshake::server::Request, res| {
                        let origin = req.headers().get("origin").and_then(|v| v.to_str().ok());
                        if req.uri().path() == "/link" && origin == Some(ORIGIN) {
                            Ok(res)
                        } else {
                            let mut refused = tungstenite::handshake::server::ErrorResponse::new(None);
                            *refused.status_mut() = StatusCode::FORBIDDEN;
                            Err(refused)
                        }
                    };
                    let Ok(mut socket) = tungstenite::accept_hdr(stream, check) else { return };
                    while let Ok(message) = socket.read() {
                        if message.is_close() || socket.send(message).is_err() {
                            break;
                        }
                    }
                });
            }
        });
        port
    }

    async fn serve_bridge() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let router = axum::Router::new()
            .route(PATH, axum::routing::get(|request: axum::extract::Request| bridge(request, |_| {})));
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        port
    }

    fn connect(
        bridge: u16,
        to: &str,
    ) -> Result<tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>, tungstenite::Error>
    {
        use tungstenite::client::IntoClientRequest;
        let mut request = format!("ws://127.0.0.1:{bridge}{PATH}?to={to}").into_client_request().unwrap();
        request.headers_mut().insert("origin", HeaderValue::from_static("http://127.0.0.1:27631"));
        tungstenite::connect(request).map(|(socket, _)| socket)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_link_goes_through_with_the_native_origin_and_echoes() {
        let relay = fake_relay();
        let bridge = serve_bridge().await;
        tokio::task::spawn_blocking(move || {
            // Directly, a page's origin is refused, as by the real relay.
            use tungstenite::client::IntoClientRequest;
            let mut direct = format!("ws://127.0.0.1:{relay}/link").into_client_request().unwrap();
            direct.headers_mut().insert("origin", HeaderValue::from_static("http://127.0.0.1:27631"));
            assert!(tungstenite::connect(direct).is_err());

            let mut socket = connect(bridge, &format!("127.0.0.1:{relay}")).expect("bridged link opens");
            let big = "x".repeat(3 * BUFFER + 17);
            for text in ["{\"kind\":\"hello\"}", big.as_str()] {
                socket.send(tungstenite::Message::text(text)).unwrap();
                assert_eq!(socket.read().unwrap(), tungstenite::Message::text(text));
            }
            socket.close(None).unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_unreachable_relay_fails_the_socket() {
        let bridge = serve_bridge().await;
        let closed = StdListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        tokio::task::spawn_blocking(move || {
            match connect(bridge, &format!("127.0.0.1:{closed}")) {
                Err(tungstenite::Error::Http(response)) => assert_eq!(response.status(), StatusCode::BAD_GATEWAY),
                other => panic!("expected 502, got {:?}", other.map(|_| ())),
            }
            match connect(bridge, "127.0.0.1") {
                Err(tungstenite::Error::Http(response)) => assert_eq!(response.status(), StatusCode::BAD_REQUEST),
                other => panic!("expected 400, got {:?}", other.map(|_| ())),
            }
        })
        .await
        .unwrap();
    }

    /// Against a real relay: `KIMOCHI_RELAY_TEST=127.0.0.1:8775 cargo test relay_link -- --ignored`.
    /// Hachidori's hello goes through and the relay's hello comes back.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn a_real_relay_answers_hachidoris_hello() {
        let to = std::env::var("KIMOCHI_RELAY_TEST").expect("KIMOCHI_RELAY_TEST=<host:port>");
        let bridge = serve_bridge().await;
        tokio::task::spawn_blocking(move || {
            let mut socket = connect(bridge, &to).expect("bridged link opens");
            let hello = json!({ "kind": "hello", "protocol": 1, "version": "0.3.0", "name": "Kimochi test", "capabilities": [] });
            let started = Instant::now();
            socket.send(tungstenite::Message::text(hello.to_string())).unwrap();
            loop {
                let message = socket.read().unwrap();
                let Ok(text) = message.to_text() else { continue };
                let frame: Value = serde_json::from_str(text).unwrap_or_default();
                eprintln!("relay said {} in {:?}", &text[..text.len().min(200)], started.elapsed());
                if frame["kind"] == "hello" || frame["kind"] == "bye" {
                    assert_eq!(frame["kind"], "hello", "{text}");
                    break;
                }
            }
            // Round trips once linked: a ping each, through the bridge.
            let mut times = Vec::new();
            for _ in 0..50 {
                let at = Instant::now();
                socket.send(tungstenite::Message::Ping(Vec::new().into())).unwrap();
                while !matches!(socket.read().unwrap(), tungstenite::Message::Pong(_)) {}
                times.push(at.elapsed());
            }
            times.sort();
            eprintln!("ping round trip through the bridge: median {:?}, max {:?}", times[25], times[49]);
        })
        .await
        .unwrap();
    }
}
