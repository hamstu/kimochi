// ankiconnect.rs — Kimochi's AnkiConnect client (https://git.foosoft.net/alex/anki-connect),
// the relay the dictionary extensions' AnkiConnect requests take, and the connection check
// behind Settings → Anki. Kimochi's own calls (the Yomitan API pop-up) go to the user's
// `superTexthooker.ankiConnectUrl` (default http://127.0.0.1:8765), with the optional
// `superTexthooker.ankiConnectKey` (a private setting: never synced, profile::is_private). The
// extensions' requests go where the extension's own Anki settings say, with its own key.
//
// Why a relay: a request from a webview carries the page's Origin (tauri://localhost,
// http://tauri.localhost on Windows, hachidori://localhost, …), and plugin-http forwards it.
// AnkiConnect's default webCorsOriginList (["http://localhost"]) refuses those origins with
// HTTP 403. A request from Rust has no Origin, which AnkiConnect always admits, so the
// extensions' requests are re-sent from here (host/anki-relay.js routes them), unchanged.
//
// All calls use the classic endpoint (`/`, API version 6) that every AnkiConnect release
// serves; 26.10's JSON-RPC endpoint (`/api/v1`) is not used.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::settings::Settings;
use crate::state::Shared;

pub const DEFAULT_URL: &str = "http://127.0.0.1:8765";
const VERSION: u8 = 6;
/// Kimochi's own calls (deck lists, adding a card).
const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// The extensions' calls: a media upload or a large `multi` can take a while.
const RELAY_TIMEOUT: Duration = Duration::from_secs(60);
/// The connection check runs every few seconds while Settings → Anki is open.
const CHECK_TIMEOUT: Duration = Duration::from_secs(3);

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // AnkiConnect is on this computer (or the user's network): a system proxy can only
            // get in the way.
            .no_proxy()
            .build()
            .expect("reqwest client")
    })
}

/// A user-entered AnkiConnect address, validated. Plain HTTP to any host is allowed (a LAN
/// Anki is a real setup); the port must be given, since AnkiConnect never listens on 80.
pub fn parse_url(raw: &str) -> Result<reqwest::Url, String> {
    let raw = raw.trim();
    let example = format!("Use an address like {DEFAULT_URL}.");
    let url = reqwest::Url::parse(raw).map_err(|_| format!("“{raw}” is not an address. {example}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("The address must start with http:// or https://. {example}"));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(format!("The address has no host. {example}"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The address must not contain a user name or password.".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(format!("The address must not have a query or fragment. {example}"));
    }
    if url.port().is_none() && url.scheme() == "http" {
        return Err(format!("The address needs a port: AnkiConnect listens on 8765 unless its webBindPort says otherwise. {example}"));
    }
    if url.path().trim_end_matches('/') == "/api/v1" {
        return Err(format!("Leave out /api/v1: Kimochi uses AnkiConnect's classic endpoint. {example}"));
    }
    Ok(url)
}

/// The configured address and API key (an empty key is no key).
pub fn configured(settings: &Settings) -> (String, Option<String>) {
    let reader = settings.get("superTexthooker").ok().flatten().unwrap_or(Value::Null);
    let url = reader
        .get("ankiConnectUrl")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_URL)
        .to_string();
    let key = reader
        .get("ankiConnectKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    (url, key)
}

/// What went wrong on the way to an answer.
#[derive(Debug, PartialEq)]
enum Failure {
    /// Nothing listens there (or the host does not resolve).
    Refused,
    Timeout,
    /// An HTTP error status from whatever answered.
    Status(u16),
    /// Something answered with a body that is not AnkiConnect's.
    NotAnkiConnect(String),
    /// AnkiConnect answered with an error.
    Api(String),
    Other(String),
}

impl Failure {
    fn message(&self, url: &reqwest::Url) -> String {
        match self {
            Failure::Refused => format!("AnkiConnect is not answering at {url}. Is Anki open?"),
            Failure::Timeout => format!("AnkiConnect at {url} did not answer in time."),
            Failure::Status(403) => format!("AnkiConnect at {url} refused the request (HTTP 403)."),
            Failure::Status(status) => format!("{url} answered HTTP {status}, which is not AnkiConnect."),
            Failure::NotAnkiConnect(_) => format!("{url} answered, but it is not AnkiConnect."),
            Failure::Api(error) => error.clone(),
            Failure::Other(error) => error.clone(),
        }
    }
}

fn transport(error: reqwest::Error) -> Failure {
    if error.is_timeout() {
        Failure::Timeout
    } else if error.is_connect() {
        Failure::Refused
    } else {
        Failure::Other(error.to_string())
    }
}

/// One classic-endpoint request; the envelope's `result`, or why there is none.
async fn post(url: &reqwest::Url, body: &Value, timeout: Duration) -> Result<Value, Failure> {
    let res = client().post(url.clone()).timeout(timeout).json(body).send().await.map_err(transport)?;
    let status = res.status();
    if !status.is_success() {
        return Err(Failure::Status(status.as_u16()));
    }
    let text = res.text().await.map_err(transport)?;
    let envelope: Value =
        serde_json::from_str(&text).map_err(|_| Failure::NotAnkiConnect(text.chars().take(120).collect()))?;
    let Some(object) = envelope.as_object().filter(|o| o.contains_key("result") && o.contains_key("error")) else {
        return Err(Failure::NotAnkiConnect(text.chars().take(120).collect()));
    };
    match object.get("error") {
        Some(Value::Null) | None => Ok(object.get("result").cloned().unwrap_or(Value::Null)),
        Some(Value::String(error)) => Err(Failure::Api(error.clone())),
        Some(other) => Err(Failure::Api(other.to_string())),
    }
}

fn request(action: &str, params: Value, key: Option<&str>) -> Value {
    let mut body = json!({ "action": action, "version": VERSION, "params": params });
    if let Some(key) = key {
        body["key"] = json!(key);
    }
    body
}

async fn call<R: for<'de> Deserialize<'de>>(
    settings: &Settings,
    url: &str,
    action: &str,
    params: Value,
) -> Result<R, String> {
    let url = parse_url(url)?;
    let (_, key) = configured(settings);
    let result = post(&url, &request(action, params, key.as_deref()), CALL_TIMEOUT)
        .await
        .map_err(|failure| failure.message(&url))?;
    serde_json::from_value(result).map_err(|e| format!("ankiconnect: unexpected result: {e}"))
}

/// One request to the AnkiConnect at `url` with `key`, for Kimochi's own follow-up calls to a
/// card an extension or the pop-up added (sentence audio).
pub(crate) async fn action(url: &str, key: Option<&str>, action: &str, params: Value) -> Result<Value, String> {
    let url = parse_url(url)?;
    post(&url, &request(action, params, key), RELAY_TIMEOUT).await.map_err(|failure| failure.message(&url))
}

#[tauri::command]
pub async fn anki_probe(state: tauri::State<'_, Shared>, url: String) -> Result<u64, String> {
    let started = Instant::now();
    let _v: u32 = call(&state.settings, &url, "version", json!({})).await?;
    Ok(started.elapsed().as_millis() as u64)
}

#[tauri::command]
pub async fn anki_deck_names(state: tauri::State<'_, Shared>, url: String) -> Result<Vec<String>, String> {
    call(&state.settings, &url, "deckNames", json!({})).await
}

#[tauri::command]
pub async fn anki_model_names(state: tauri::State<'_, Shared>, url: String) -> Result<Vec<String>, String> {
    call(&state.settings, &url, "modelNames", json!({})).await
}

#[tauri::command]
pub async fn anki_model_field_names(
    state: tauri::State<'_, Shared>,
    url: String,
    model_name: String,
) -> Result<Vec<String>, String> {
    call(&state.settings, &url, "modelFieldNames", json!({ "modelName": model_name })).await
}

#[tauri::command]
pub async fn anki_find_notes(state: tauri::State<'_, Shared>, url: String, query: String) -> Result<Vec<u64>, String> {
    call(&state.settings, &url, "findNotes", json!({ "query": query })).await
}

#[tauri::command]
pub async fn anki_gui_browse(state: tauri::State<'_, Shared>, url: String, query: String) -> Result<Vec<u64>, String> {
    call(&state.settings, &url, "guiBrowse", json!({ "query": query })).await
}

#[tauri::command]
pub async fn anki_store_media_file(
    state: tauri::State<'_, Shared>,
    url: String,
    filename: String,
    data_base64: String,
) -> Result<String, String> {
    call(
        &state.settings,
        &url,
        "storeMediaFile",
        json!({ "filename": filename, "data": data_base64 }),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // a command's arguments are its parameters, by name
pub async fn anki_add_note(
    state: tauri::State<'_, Shared>,
    url: String,
    deck: String,
    model: String,
    fields: HashMap<String, String>,
    tags: Vec<String>,
    allow_duplicate: Option<bool>,
    term: Option<String>,
    reading: Option<String>,
) -> Result<u64, String> {
    let allow = allow_duplicate.unwrap_or(false);
    let deck_name = deck.clone();
    let named: Vec<(String, String)> = fields.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    // Card enhancement's tags, with any the pop-up sent.
    let mut tags = tags;
    for tag in crate::card_tags::current(&state.settings) {
        if !tags.iter().any(|t| t.eq_ignore_ascii_case(&tag)) {
            tags.push(tag);
        }
    }
    let params = json!({
        "note": {
            "deckName": deck,
            "modelName": model,
            "fields": fields,
            "tags": tags,
            "options": {
                "allowDuplicate": allow,
                "duplicateScope": "deck"
            }
        }
    });
    let result: Value = call(&state.settings, &url, "addNote", params).await?;
    let note_id = result
        .as_u64()
        .ok_or_else(|| "addNote returned non-numeric id".to_string())?;
    // The Anki tab's record of the session's cards: the pop-up names its term.
    let (found, found_reading) = crate::anki_cards::card_term(&named);
    let term = term.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).unwrap_or(found);
    crate::anki_cards::record(crate::anki_cards::NewCard {
        note_id,
        term,
        reading: reading.or(found_reading),
        deck: Some(deck_name),
        via: "kimochi",
        engine: crate::anki_cards::KIMOCHI_ENGINE.into(),
    });
    Ok(note_id)
}

// ---------------------------------------------------------------- relay

/// What AnkiConnect answered, for host/anki-relay.js to rebuild as a `Response`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayReply {
    pub status: u16,
    pub body: String,
}

/// The body of a classic AnkiConnect request, as the extension wrote it (its API key included):
/// an object with a string `action`. Anything else is refused, so the relay cannot carry other
/// traffic.
fn relay_body(body: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(body).map_err(|_| "not an AnkiConnect request".to_string())?;
    if !value.get("action").is_some_and(Value::is_string) {
        return Err("not an AnkiConnect request".into());
    }
    Ok(value)
}

#[cfg(test)]
async fn relay(url: &str, body: &str) -> Result<RelayReply, String> {
    relay_request(url, &relay_body(body)?).await
}

async fn relay_request(url: &str, request: &Value) -> Result<RelayReply, String> {
    let url = parse_url(url)?;
    let res = client()
        .post(url.clone())
        .timeout(RELAY_TIMEOUT)
        .json(request)
        .send()
        .await
        .map_err(|e| transport(e).message(&url))?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| transport(e).message(&url))?;
    Ok(RelayReply { status, body })
}

/// A dictionary extension's AnkiConnect request (host/anki-relay.js), sent from here without the
/// webview's Origin to the address its own Anki settings name (`url`, validated like the one in
/// Settings → Anki), and otherwise as it was: the extension's settings stay in charge. A card it
/// adds is recorded in the open session (`anki_cards`), given its line's audio afterwards when
/// sentence audio is on (`sentence_audio`), and card enhancement's tags (`card_tags`).
#[tauri::command]
pub async fn anki_connect_relay(app: tauri::AppHandle, url: String, body: String) -> Result<RelayReply, String> {
    let request = relay_body(&body)?;
    let reply = relay_request(&url, &request).await?;
    crate::anki_cards::after_relay(&app, &url, &request, reply.status, &reply.body);
    crate::sentence_audio::after_relay(&app, &url, &request, reply.status, &reply.body);
    crate::card_tags::after_relay(&app, &url, &request, reply.status, &reply.body);
    Ok(reply)
}

// ---------------------------------------------------------------- connection check

/// What Settings → Anki shows about the connection.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    #[serde(rename_all = "camelCase")]
    Connected { url: String, version: u64, latency_ms: u64, key_required: bool },
    /// AnkiConnect has an apiKey set and Kimochi has none.
    KeyRequired { url: String },
    /// Kimochi's key is not the one AnkiConnect has.
    KeyRejected { url: String },
    /// Nothing answers there. `suggestion`: the default address, when AnkiConnect answers there.
    NotRunning { url: String, suggestion: Option<String> },
    Timeout { url: String },
    /// Something else answers there: a wrong port.
    NotAnkiConnect { url: String, detail: String, suggestion: Option<String> },
    /// HTTP 403, or AnkiConnect denied permission.
    Blocked { url: String, status: u16 },
    InvalidUrl { url: String, error: String },
    Error { url: String, message: String },
}

const KEY_ERROR: &str = "valid api key must be provided";

/// Asks AnkiConnect at `url` who it is, without changing anything: `requestPermission` (which
/// needs no key and reports whether one is required), then `version` with the key. When nothing
/// or something else answers and `fallback` differs, `fallback` is tried for a suggestion.
async fn check(url: &str, key: Option<&str>, fallback: Option<&str>) -> Status {
    let shown = url.trim().to_string();
    let parsed = match parse_url(url) {
        Ok(parsed) => parsed,
        Err(error) => return Status::InvalidUrl { url: shown, error },
    };
    let started = Instant::now();
    let permission = post(&parsed, &request("requestPermission", json!({}), None), CHECK_TIMEOUT).await;
    let key_required = match &permission {
        Ok(result) => {
            if result.get("permission").and_then(Value::as_str) == Some("denied") {
                return Status::Blocked { url: shown, status: 403 };
            }
            // `requireApikey` on the classic endpoint; spelled `requireApiKey` on JSON-RPC.
            ["requireApikey", "requireApiKey"].iter().any(|k| result.get(*k).and_then(Value::as_bool) == Some(true))
        }
        // An AnkiConnect older than requestPermission: `version` below decides.
        Err(Failure::Api(_)) => false,
        Err(Failure::Refused) => return Status::NotRunning { url: shown, suggestion: suggest(&parsed, fallback).await },
        Err(Failure::Timeout) => return Status::Timeout { url: shown },
        Err(Failure::Status(403)) => return Status::Blocked { url: shown, status: 403 },
        Err(Failure::Status(status)) => {
            let detail = format!("HTTP {status}");
            return Status::NotAnkiConnect { url: shown, detail, suggestion: suggest(&parsed, fallback).await };
        }
        Err(Failure::NotAnkiConnect(detail)) => {
            let detail = detail.clone();
            return Status::NotAnkiConnect { url: shown, detail, suggestion: suggest(&parsed, fallback).await };
        }
        Err(Failure::Other(message)) => return Status::Error { url: shown, message: message.clone() },
    };
    match post(&parsed, &request("version", json!({}), key), CHECK_TIMEOUT).await {
        Ok(version) => Status::Connected {
            url: shown,
            version: version.as_u64().unwrap_or(0),
            latency_ms: started.elapsed().as_millis() as u64,
            key_required,
        },
        Err(Failure::Api(error)) if error.contains(KEY_ERROR) => {
            if key.is_some() {
                Status::KeyRejected { url: shown }
            } else {
                Status::KeyRequired { url: shown }
            }
        }
        Err(Failure::Status(status)) => Status::Blocked { url: shown, status },
        Err(failure) => Status::Error { url: shown, message: failure.message(&parsed) },
    }
}

/// `fallback`, when it is another address and AnkiConnect answers there.
async fn suggest(tried: &reqwest::Url, fallback: Option<&str>) -> Option<String> {
    let fallback = parse_url(fallback?).ok()?;
    if fallback == *tried {
        return None;
    }
    match post(&fallback, &request("requestPermission", json!({}), None), CHECK_TIMEOUT).await {
        Ok(_) | Err(Failure::Api(_)) => Some(fallback.as_str().trim_end_matches('/').to_string()),
        Err(_) => None,
    }
}

/// The connection check for Settings → Anki: the given address and key (an address being
/// edited), or the configured ones.
#[tauri::command]
pub async fn anki_connect_status(
    state: tauri::State<'_, Shared>,
    url: Option<String>,
    key: Option<String>,
) -> Result<Status, String> {
    let (saved_url, saved_key) = configured(&state.settings);
    let url = url.unwrap_or(saved_url);
    let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).or(saved_key);
    Ok(check(&url, key.as_deref(), Some(DEFAULT_URL)).await)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    #[test]
    fn addresses_are_validated() {
        for ok in ["http://127.0.0.1:8765", "http://localhost:8770/", " http://[::1]:9000 ", "https://anki.example", "http://192.168.1.5:8765"] {
            assert!(parse_url(ok).is_ok(), "{ok}");
        }
        for bad in ["", "8765", "127.0.0.1:8765", "ftp://127.0.0.1:8765", "http://127.0.0.1", "http://u:p@127.0.0.1:8765", "http://127.0.0.1:8765/?x=1", "http://127.0.0.1:8765/api/v1", "http://127.0.0.1:99999"] {
            assert!(parse_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_relay_carries_only_ankiconnect_requests_as_the_extension_wrote_them() {
        let sent = r#"{"action":"multi","version":6,"params":{"actions":[{"action":"version","key":"theirs"}]},"key":"theirs"}"#;
        let body = relay_body(sent).unwrap();
        assert_eq!(body, serde_json::from_str::<Value>(sent).unwrap(), "the extension's key and API version are kept");
        for refused in ["", "[]", "{}", r#"{"action":1}"#, "not json"] {
            assert!(relay_body(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn the_configured_address_and_key_come_from_the_reader_settings() {
        let dir = std::env::temp_dir().join(format!("kimochi-anki-{}", std::process::id()));
        let settings = Settings::load(dir.join("settings.json"));
        assert_eq!(configured(&settings), (DEFAULT_URL.to_string(), None));
        settings
            .set("superTexthooker", json!({ "ankiConnectUrl": "http://127.0.0.1:8770", "ankiConnectKey": " k " }))
            .unwrap();
        assert_eq!(configured(&settings), ("http://127.0.0.1:8770".to_string(), Some("k".to_string())));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A one-request-at-a-time HTTP server answering every request with `reply(body)`, and
    /// recording each request's raw headers and body.
    pub(crate) fn serve(reply: impl Fn(&str) -> (u16, String) + Send + 'static) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let request = loop {
                    let n = stream.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break String::from_utf8_lossy(&buf).to_string();
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let length = head
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        if body.len() >= length {
                            break text;
                        }
                    }
                };
                let body = request.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
                log.lock().unwrap().push(request.clone());
                let (status, answer) = reply(&body);
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                    answer.len()
                );
            }
        });
        (url, seen)
    }

    /// AnkiConnect's classic endpoint as 26.10 answers it, with an optional apiKey.
    fn fake_ankiconnect(api_key: Option<&'static str>) -> impl Fn(&str) -> (u16, String) {
        move |body| {
            let request: Value = serde_json::from_str(body).unwrap_or(Value::Null);
            let action = request["action"].as_str().unwrap_or("");
            if action == "requestPermission" {
                return (200, json!({ "result": { "permission": "granted", "requireApikey": api_key.is_some(), "version": 6 }, "error": null }).to_string());
            }
            if request.get("key").and_then(Value::as_str) != api_key {
                return (200, json!({ "result": null, "error": KEY_ERROR }).to_string());
            }
            (200, json!({ "result": 6, "error": null }).to_string())
        }
    }

    fn closed_port() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        url
    }

    #[tokio::test]
    async fn the_check_tells_each_situation_apart() {
        let (anki, _) = serve(fake_ankiconnect(None));
        assert!(matches!(check(&anki, None, None).await, Status::Connected { version: 6, key_required: false, .. }));

        let (keyed, _) = serve(fake_ankiconnect(Some("secret")));
        assert_eq!(check(&keyed, None, None).await, Status::KeyRequired { url: keyed.clone() });
        assert_eq!(check(&keyed, Some("wrong"), None).await, Status::KeyRejected { url: keyed.clone() });
        assert!(matches!(check(&keyed, Some("secret"), None).await, Status::Connected { key_required: true, .. }));

        let closed = closed_port();
        assert_eq!(check(&closed, None, None).await, Status::NotRunning { url: closed.clone(), suggestion: None });
        // Nothing on the configured port, AnkiConnect on the default one: suggest it.
        assert_eq!(
            check(&closed, None, Some(&anki)).await,
            Status::NotRunning { url: closed.clone(), suggestion: Some(anki.clone()) }
        );

        let (web, _) = serve(|_| (200, "<html>hello</html>".into()));
        assert!(matches!(check(&web, None, Some(&anki)).await, Status::NotAnkiConnect { suggestion: Some(_), .. }));
        let (missing, _) = serve(|_| (404, String::new()));
        assert!(matches!(check(&missing, None, None).await, Status::NotAnkiConnect { .. }));
        let (forbidden, _) = serve(|_| (403, String::new()));
        assert_eq!(check(&forbidden, None, None).await, Status::Blocked { url: forbidden.clone(), status: 403 });
        assert!(matches!(check("localhost:8765", None, None).await, Status::InvalidUrl { .. }));
    }

    #[tokio::test]
    async fn the_relay_sends_no_origin_and_returns_ankiconnects_answer() {
        let (anki, seen) = serve(fake_ankiconnect(Some("secret")));
        let reply = relay(&anki, r#"{"action":"version","version":2,"params":{},"key":"secret"}"#).await.unwrap();
        assert_eq!(reply.status, 200);
        assert_eq!(serde_json::from_str::<Value>(&reply.body).unwrap()["result"], 6);
        let request = seen.lock().unwrap().last().cloned().unwrap();
        assert!(!request.to_ascii_lowercase().contains("\r\norigin:"), "{request}");
        assert!(request.contains(r#""key":"secret""#), "{request}");
        assert!(relay(&anki, "{}").await.is_err());
        assert!(relay("localhost:8765", r#"{"action":"version"}"#).await.is_err(), "the extension's address is validated");
        assert!(relay(&closed_port(), r#"{"action":"version"}"#).await.unwrap_err().contains("not answering"));
    }

    /// Against a real AnkiConnect, opt-in: `KIMOCHI_ANKI_E2E_URL=http://127.0.0.1:8771
    /// [KIMOCHI_ANKI_E2E_KEY=…] cargo test --bin kimochi anki_e2e -- --ignored`. Point it at a
    /// throwaway Anki profile: it adds a deck and a note. Shows that a request with Kimochi's
    /// webview Origin is refused by a default config, and the same request through the relay is not.
    #[tokio::test]
    #[ignore]
    async fn anki_e2e() {
        let url = std::env::var("KIMOCHI_ANKI_E2E_URL").expect("KIMOCHI_ANKI_E2E_URL");
        let key = std::env::var("KIMOCHI_ANKI_E2E_KEY").ok().filter(|k| !k.is_empty());
        let key = key.as_deref();
        let status = check(&url, key, None).await;
        assert!(matches!(status, Status::Connected { version: 6, .. }), "{status:?}");
        if key.is_some() {
            assert_eq!(check(&url, None, None).await, Status::KeyRequired { url: url.clone() });
            assert_eq!(check(&url, Some("wrong"), None).await, Status::KeyRejected { url: url.clone() });
        }

        // What plugin-http sent before: the same body with the webview's Origin.
        let mut direct = json!({ "action": "deckNames", "version": 2, "params": {} });
        if let Some(key) = key {
            direct["key"] = json!(key);
        }
        let refused = client().post(&url).header("Origin", "tauri://localhost").json(&direct).send().await.unwrap();
        assert_eq!(refused.status().as_u16(), 403, "a default webCorsOriginList refuses tauri://localhost");

        // Yomitan's calls (anki-connect.js, API version 2), relayed with the key the extension puts in.
        let relayed = |mut body: Value| {
            let url = url.clone();
            async move {
                // As the extensions do: AnkiConnect checks the key on each action of a `multi` too.
                if let Some(key) = key {
                    body["key"] = json!(key);
                    for action in body["params"]["actions"].as_array_mut().into_iter().flatten() {
                        action["key"] = json!(key);
                    }
                }
                let reply = relay(&url, &body.to_string()).await.unwrap();
                assert_eq!(reply.status, 200, "{}", reply.body);
                let value: Value = serde_json::from_str(&reply.body).unwrap();
                // Version 6 wraps the result in {result, error}; version 2 (Yomitan's) does not.
                if value.as_object().is_some_and(|o| o.contains_key("result") && o.contains_key("error")) {
                    assert!(value["error"].is_null(), "{value}");
                    value["result"].clone()
                } else {
                    value
                }
            }
        };
        relayed(json!({ "action": "createDeck", "version": 2, "params": { "deck": "Kimochi E2E" } })).await;
        let decks = relayed(json!({ "action": "deckNames", "version": 2, "params": {} })).await;
        assert!(decks.as_array().unwrap().iter().any(|d| d == "Kimochi E2E"), "{decks}");
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
        let word = format!("猫{stamp}");
        let note = json!({ "deckName": "Kimochi E2E", "modelName": "Basic", "fields": { "Front": word, "Back": "cat" }, "tags": ["kimochi-e2e"] });
        let can = relayed(json!({ "action": "canAddNotesWithErrorDetail", "version": 2, "params": { "notes": [note] } })).await;
        assert_eq!(can[0]["canAdd"], true, "{can}");
        let id = relayed(json!({ "action": "addNote", "version": 2, "params": { "note": note } })).await;
        assert!(id.as_u64().is_some(), "{id}");
        // Hachidori's (anki.js, API version 6, a multi).
        let found = relayed(json!({ "action": "multi", "version": 6, "params": { "actions": [{ "action": "findNotes", "params": { "query": format!("\"Front:{word}\"") } }] } })).await;
        assert_eq!(found[0][0], id, "{found}");

        // Kimochi's own client, through the same validation and key.
        let url_ = parse_url(&url).unwrap();
        let names = post(&url_, &request("modelFieldNames", json!({ "modelName": "Basic" }), key), CALL_TIMEOUT).await.unwrap();
        assert_eq!(names, json!(["Front", "Back"]));
    }
}

