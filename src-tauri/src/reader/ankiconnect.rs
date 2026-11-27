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
// extensions' requests are re-sent from here (host/anki-relay.js routes them), unchanged but
// for the names of media files the server stored under another name (relay_media.rs).
//
// All calls use the classic endpoint (`/`, API version 6) that every AnkiConnect release
// serves; 26.10's JSON-RPC endpoint (`/api/v1`) is not used.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::relay_media::StoredNames;
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
            // AnkiConnect closes the connection after every answer without saying so (no
            // `Connection: close`), so a pooled connection is usually already dead: the next
            // request on it failed with "error sending request", often on a LAN address. A new
            // connection per request costs nothing at this rate.
            .pool_max_idle_per_host(0)
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
        return Err(format!(
            "The address needs a port: AnkiConnect listens on 8765 unless its webBindPort says otherwise. {example}"
        ));
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
        Failure::Other(with_causes(&error))
    }
}

/// reqwest's own message ("error sending request for url (…)") leaves out why; add the causes.
fn with_causes(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !message.contains(&text) {
            message = format!("{message}: {text}");
        }
        source = cause.source();
    }
    message
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

/// Store `data` (base64) as `filename` in the media folder of the AnkiConnect at `url`, and return
/// the name it was stored under, which is the one a field must reference. Anki keeps the name
/// unless a different file already has it; Manatan SRS converts every file and names it after its
/// content (`kimochi_1.mp3` becomes `mtn_<hash>.webm`, a `.jpg` becomes `.avif`), so a field
/// naming the file that was sent shows nothing there.
pub(crate) async fn store_media(url: &str, key: Option<&str>, filename: &str, data: String) -> Result<String, String> {
    let stored = action(url, key, "storeMediaFile", json!({ "filename": filename, "data": data })).await?;
    Ok(stored_name(&stored, filename))
}

/// `storeMediaFile`'s answer: the stored name, or the one sent when an older AnkiConnect answered
/// without one.
fn stored_name(result: &Value, sent: &str) -> String {
    result.as_str().map(str::trim).filter(|name| !name.is_empty()).unwrap_or(sent).to_string()
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
    let stored: Value =
        call(&state.settings, &url, "storeMediaFile", json!({ "filename": filename, "data": data_base64 })).await?;
    Ok(stored_name(&stored, &filename))
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
    let note_id = result.as_u64().ok_or_else(|| "addNote returned non-numeric id".to_string())?;
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

/// One relayed request, with media files named on each side as that side knows them.
struct Relayed {
    /// The request as it went to AnkiConnect.
    sent: Value,
    /// AnkiConnect's answer.
    answered: RelayReply,
    /// The answer for the extension.
    reply: RelayReply,
}

/// Relays `request` to the AnkiConnect at `url`. A media file that server stored under another
/// name than the extension sent keeps the sent name towards the extension and the stored one
/// towards the server (`names`, relay_media.rs); everything else passes as it is.
async fn relay_named(names: &Mutex<StoredNames>, url: &str, request: &Value) -> Result<Relayed, String> {
    let server = parse_url(url)?.to_string();
    let lock = || names.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let sent = lock().outgoing(&server, request).unwrap_or_else(|| request.clone());
    let answered = relay_request(url, &sent).await?;
    let body = if answered.status == 200 { lock().incoming(&server, request, &answered.body) } else { None };
    let reply = RelayReply { status: answered.status, body: body.unwrap_or_else(|| answered.body.clone()) };
    Ok(Relayed { sent, answered, reply })
}

/// A dictionary extension's AnkiConnect request (host/anki-relay.js), sent from here without the
/// webview's Origin to the address its own Anki settings name (`url`, validated like the one in
/// Settings → Anki), and otherwise as it was: the extension's settings stay in charge. Only the
/// names of media files change, where the server stored a file under another name than the
/// extension sent (relay_media.rs). A card it adds is recorded in the open session
/// (`anki_cards`), given its line's audio afterwards when sentence audio is on
/// (`sentence_audio`), and card enhancement's tags (`card_tags`).
#[tauri::command]
pub async fn anki_connect_relay(app: tauri::AppHandle, url: String, body: String) -> Result<RelayReply, String> {
    let request = relay_body(&body)?;
    let Relayed { sent, answered, reply } = relay_named(super::relay_media::shared(), &url, &request).await?;
    // What follows a card reads the note as AnkiConnect got it.
    crate::anki_cards::after_relay(&app, &url, &sent, answered.status, &answered.body);
    crate::sentence_audio::after_relay(&app, &url, &sent, answered.status, &answered.body);
    crate::card_tags::after_relay(&app, &url, &sent, answered.status, &answered.body);
    crate::screenshots::after_relay(&app, &url, &sent, answered.status, &answered.body);
    Ok(reply)
}

// ---------------------------------------------------------------- connection check

/// What Settings → Anki shows about the connection.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    #[serde(rename_all = "camelCase")]
    Connected {
        url: String,
        version: u64,
        latency_ms: u64,
        key_required: bool,
    },
    /// AnkiConnect has an apiKey set and Kimochi has none.
    KeyRequired {
        url: String,
    },
    /// Kimochi's key is not the one AnkiConnect has.
    KeyRejected {
        url: String,
    },
    /// Nothing answers there. `suggestion`: the default address, when AnkiConnect answers there.
    NotRunning {
        url: String,
        suggestion: Option<String>,
    },
    Timeout {
        url: String,
    },
    /// Something else answers there: a wrong port.
    NotAnkiConnect {
        url: String,
        detail: String,
        suggestion: Option<String>,
    },
    /// HTTP 403, or AnkiConnect denied permission.
    Blocked {
        url: String,
        status: u16,
    },
    InvalidUrl {
        url: String,
        error: String,
    },
    Error {
        url: String,
        message: String,
    },
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
        Err(Failure::Refused) => {
            return Status::NotRunning { url: shown, suggestion: suggest(&parsed, fallback).await }
        }
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
        for ok in [
            "http://127.0.0.1:8765",
            "http://localhost:8770/",
            " http://[::1]:9000 ",
            "https://anki.example",
            "http://192.168.1.5:8765",
        ] {
            assert!(parse_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "8765",
            "127.0.0.1:8765",
            "ftp://127.0.0.1:8765",
            "http://127.0.0.1",
            "http://u:p@127.0.0.1:8765",
            "http://127.0.0.1:8765/?x=1",
            "http://127.0.0.1:8765/api/v1",
            "http://127.0.0.1:99999",
        ] {
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
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
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

    /// Like AnkiConnect's own server: it answers without `Connection: close`, then closes the
    /// connection anyway (here a moment later, so a client reusing it always loses the race).
    fn serve_closing_silently() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let (mut buf, mut chunk) = (Vec::new(), [0u8; 4096]);
                // The whole request, as AnkiConnect reads it: unread bytes would make the close a reset.
                while let Ok(n @ 1..) = stream.read(&mut chunk) {
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    let Some((head, body)) = text.split_once("\r\n\r\n") else { continue };
                    let length = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if body.len() >= length {
                        break;
                    }
                }
                let answer = json!({ "result": 6, "error": null }).to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{answer}",
                    answer.len()
                );
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        url
    }

    #[tokio::test]
    async fn a_connection_ankiconnect_closed_is_never_reused() {
        let url = serve_closing_silently();
        for _ in 0..3 {
            assert_eq!(action(&url, None, "version", json!({})).await, Ok(json!(6)));
        }
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
        assert!(
            relay("localhost:8765", r#"{"action":"version"}"#).await.is_err(),
            "the extension's address is validated"
        );
        assert!(relay(&closed_port(), r#"{"action":"version"}"#).await.unwrap_err().contains("not answering"));
    }

    /// Manatan SRS (#286) stores `kimochi_1.mp3` as `mtn_<hash>.webm`, as its own server does
    /// (checked against Manatan 6.3.27), so a field must name what `storeMediaFile` answered.
    #[tokio::test]
    async fn a_media_file_is_named_as_it_was_stored() {
        let (manatan, seen) = serve(|body| {
            let request: Value = serde_json::from_str(body).unwrap();
            assert_eq!(request["version"], 6, "Manatan answers without the envelope below version 5");
            let stored = match request["params"]["filename"].as_str().unwrap() {
                "kimochi_1.mp3" => "mtn_b00348a8f180d1e2518131d7d770c463.webm",
                _ => "mtn_d6b9f5f8d1e8db3e4c1825bf7ea22c58.avif",
            };
            (200, json!({ "result": stored, "error": null }).to_string())
        });
        let stored = store_media(&manatan, None, "kimochi_1.mp3", "AAAA".into()).await.unwrap();
        assert_eq!(stored, "mtn_b00348a8f180d1e2518131d7d770c463.webm");
        let stored = store_media(&manatan, Some("k"), "kimochi_1.jpg", "AAAA".into()).await.unwrap();
        assert_eq!(stored, "mtn_d6b9f5f8d1e8db3e4c1825bf7ea22c58.avif");
        let request = seen.lock().unwrap().last().cloned().unwrap();
        assert!(request.contains(r#""data":"AAAA""#) && request.contains(r#""key":"k""#), "{request}");

        // Anki keeps the name; an AnkiConnect that answers no name keeps the one sent.
        let (anki, _) = serve(|body| {
            let request: Value = serde_json::from_str(body).unwrap();
            (200, json!({ "result": request["params"]["filename"], "error": null }).to_string())
        });
        assert_eq!(store_media(&anki, None, "kimochi_2.mp3", "AAAA".into()).await.unwrap(), "kimochi_2.mp3");
        let (silent, _) = serve(|_| (200, json!({ "result": null, "error": null }).to_string()));
        assert_eq!(store_media(&silent, None, "kimochi_3.mp3", "AAAA".into()).await.unwrap(), "kimochi_3.mp3");
        let (refusing, _) = serve(|_| (200, json!({ "result": null, "error": "unsupported audio" }).to_string()));
        assert_eq!(
            store_media(&refusing, None, "kimochi_4.mp3", "AAAA".into()).await.unwrap_err(),
            "unsupported audio"
        );
    }

    /// A stand-in for Manatan SRS's AnkiConnect: it names every stored file after its content,
    /// has no `getMediaFilesNames`, and answers a `multi` call by call.
    fn fake_manatan(body: &str) -> (u16, String) {
        fn answer(call: &Value) -> Value {
            match call["action"].as_str().unwrap_or("") {
                "storeMediaFile" => {
                    let data = call["params"]["data"].as_str().unwrap_or("");
                    json!({ "result": format!("mtn_{:08x}.avif", data.len()), "error": null })
                }
                "multi" => {
                    let answers: Vec<Value> =
                        call["params"]["actions"].as_array().unwrap().iter().map(answer).collect();
                    json!({ "result": answers, "error": null })
                }
                "addNote" => json!({ "result": 1795635391945u64, "error": null }),
                _ => json!({ "result": null, "error": "unsupported action" }),
            }
        }
        (200, answer(&serde_json::from_str(body).unwrap()).to_string())
    }

    /// The body of the last request `seen` holds.
    fn last_body(seen: &Arc<Mutex<Vec<String>>>) -> Value {
        let request = seen.lock().unwrap().last().cloned().unwrap();
        serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap()
    }

    /// Hachidori 0.5.2 adding a card whose definition holds a dictionary image (its
    /// anki-worker.js `prepareAdd`): the image goes up in a `multi`, and the note is added only
    /// when the answer is the name it sent. Manatan SRS answered another name, and the card was
    /// refused with "Anki stored media under a different filename".
    #[tokio::test]
    async fn the_relay_keeps_an_extensions_media_names_and_sends_the_stored_ones() {
        let (manatan, seen) = serve(fake_manatan);
        let names = Mutex::new(StoredNames::default());
        let image = format!("hachidori_{}.png", "ab".repeat(32));

        let upload = json!({ "action": "multi", "version": 6, "params": { "actions": [
            { "action": "storeMediaFile", "version": 6, "params": { "filename": image, "data": "AAAA", "deleteExisting": false } },
        ] } });
        let relayed = relay_named(&names, &manatan, &upload).await.unwrap();
        assert_eq!(relayed.sent, upload, "the file is stored under the name the extension chose");
        assert_eq!(
            serde_json::from_str::<Value>(&relayed.answered.body).unwrap()["result"][0]["result"],
            "mtn_00000004.avif"
        );
        assert_eq!(serde_json::from_str::<Value>(&relayed.reply.body).unwrap()["result"][0]["result"], image);

        let add = json!({ "action": "addNote", "version": 6, "params": { "note": {
            "deckName": "Mining", "modelName": "Manatan-NoteType",
            "fields": { "Expression": "注目", "MainDefinition": format!("<img src=\"{image}\"> notice") },
        } } });
        let relayed = relay_named(&names, &manatan, &add).await.unwrap();
        assert_eq!(serde_json::from_str::<Value>(&relayed.reply.body).unwrap()["result"], 1795635391945u64);
        assert_eq!(relayed.reply.body, relayed.answered.body, "a reply that names no file is the server's own");
        let wire = last_body(&seen);
        assert_eq!(wire, relayed.sent);
        assert_eq!(wire["params"]["note"]["fields"]["MainDefinition"], "<img src=\"mtn_00000004.avif\"> notice");
        assert_eq!(wire["params"]["note"]["fields"]["Expression"], "注目");

        // Its check that a file is there, on a server without one: answered from what was stored.
        let exists =
            |name: &str| json!({ "action": "getMediaFilesNames", "version": 6, "params": { "pattern": name } });
        let relayed = relay_named(&names, &manatan, &exists(&image)).await.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&relayed.reply.body).unwrap(),
            json!({ "result": [image], "error": null })
        );
        let relayed = relay_named(&names, &manatan, &exists("hachidori_other.png")).await.unwrap();
        assert_eq!(serde_json::from_str::<Value>(&relayed.reply.body).unwrap(), json!({ "result": [], "error": null }));

        // An AnkiConnect that keeps names is relayed byte for byte.
        let (anki, seen) = serve(|body| {
            let request: Value = serde_json::from_str(body).unwrap();
            (200, format!("{{\"result\": {}, \"error\": null}}", request["params"]["filename"]))
        });
        let store =
            json!({ "action": "storeMediaFile", "version": 6, "params": { "filename": image, "data": "AAAA" } });
        let relayed = relay_named(&names, &anki, &store).await.unwrap();
        assert_eq!(relayed.reply.body, format!("{{\"result\": \"{image}\", \"error\": null}}"));
        relay_named(&names, &anki, &add).await.unwrap();
        assert_eq!(last_body(&seen), add, "Manatan's names stay with Manatan");
        // A failed request is the server's answer as it came.
        let (down, _) = serve(|_| (500, "oops".into()));
        let relayed = relay_named(&names, &down, &store).await.unwrap();
        assert_eq!((relayed.reply.status, relayed.reply.body.as_str()), (500, "oops"));
    }

    /// Against a real server that renames what it stores, opt-in:
    /// `KIMOCHI_MANATAN_E2E_URL=http://127.0.0.1:8765 cargo test --bin kimochi manatan_e2e -- --ignored`
    /// with Manatan SRS's AnkiConnect extension on, a throwaway collection and a deck named
    /// `Kimochi E2E`. Adds one note the way Hachidori does and reads it back from the server.
    #[tokio::test]
    #[ignore]
    async fn manatan_e2e() {
        let url = std::env::var("KIMOCHI_MANATAN_E2E_URL").expect("KIMOCHI_MANATAN_E2E_URL");
        let names = Mutex::new(StoredNames::default());
        let result = |reply: &RelayReply| {
            let value: Value = serde_json::from_str(&reply.body).unwrap();
            assert!(value["error"].is_null(), "{value}");
            value["result"].clone()
        };
        // An 8×8 red PNG, under a name of Hachidori's making.
        let png =
            "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
        let image = format!("hachidori_{stamp:064x}.png");
        let upload = json!({ "action": "multi", "version": 6, "params": { "actions": [
            { "action": "storeMediaFile", "version": 6, "params": { "filename": image, "data": png, "deleteExisting": false } },
        ] } });
        let relayed = relay_named(&names, &url, &upload).await.unwrap();
        assert_eq!(result(&relayed.reply)[0]["result"], image, "the extension is answered with its own name");
        let stored = result(&relayed.answered)[0]["result"].as_str().unwrap().to_string();
        assert_ne!(stored, image, "this server keeps names: nothing to check");

        let add = json!({ "action": "addNote", "version": 6, "params": { "note": {
            "deckName": "Kimochi E2E", "modelName": "Basic", "tags": ["kimochi-e2e"],
            "options": { "allowDuplicate": true },
            "fields": { "Front": format!("注目 {stamp}"), "Back": format!("<img src=\"{image}\"> notice") },
        } } });
        let note = result(&relay_named(&names, &url, &add).await.unwrap().reply);
        let note = note.as_u64().expect("a note id");

        // What the server holds: the note names the stored file, and the file is there.
        let info = action(&url, None, "notesInfo", json!({ "notes": [note] })).await.unwrap();
        assert_eq!(info[0]["fields"]["Back"]["value"], format!("<img src=\"{stored}\"> notice"));
        let file = action(&url, None, "retrieveMediaFile", json!({ "filename": stored })).await.unwrap();
        assert!(file.as_str().is_some_and(|data| !data.is_empty()), "{file}");
        // What the extension reads back: the name it wrote.
        let info = json!({ "action": "notesInfo", "version": 6, "params": { "notes": [note] } });
        let read = result(&relay_named(&names, &url, &info).await.unwrap().reply);
        assert_eq!(read[0]["fields"]["Back"]["value"], format!("<img src=\"{image}\"> notice"));
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
        let can =
            relayed(json!({ "action": "canAddNotesWithErrorDetail", "version": 2, "params": { "notes": [note] } }))
                .await;
        assert_eq!(can[0]["canAdd"], true, "{can}");
        let id = relayed(json!({ "action": "addNote", "version": 2, "params": { "note": note } })).await;
        assert!(id.as_u64().is_some(), "{id}");
        // Hachidori's (anki.js, API version 6, a multi).
        let found = relayed(json!({ "action": "multi", "version": 6, "params": { "actions": [{ "action": "findNotes", "params": { "query": format!("\"Front:{word}\"") } }] } })).await;
        assert_eq!(found[0][0], id, "{found}");

        // Kimochi's own client, through the same validation and key.
        let url_ = parse_url(&url).unwrap();
        let names =
            post(&url_, &request("modelFieldNames", json!({ "modelName": "Basic" }), key), CALL_TIMEOUT).await.unwrap();
        assert_eq!(names, json!(["Front", "Back"]));
    }
}
