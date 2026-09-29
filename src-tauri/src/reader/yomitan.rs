// yomitan.rs — invoke wrappers around the local yomitan-api host.
//
// We don't try to type the responses on the Rust side — we pass through serde_json::Value
// so the frontend can deal with the field shapes it cares about. This keeps the Rust code
// simple and resilient to host version differences.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;

const HTTP_TIMEOUT: Duration = Duration::from_secs(6);

/// /ankiFields returns one entry per (match length, reading) — longest match
/// first, then progressively shorter sub-terms down to single characters,
/// mirroring the Yomitan extension's own popup. 32 comfortably covers the
/// deepest real-world compounds.
const MAX_ENTRIES: u32 = 32;

const ANKI_MARKERS: &[&str] = &[
    "expression",
    "reading",
    "glossary",
    "dictionary",
    "frequencies",
    "pitch-accents",
    "part-of-speech",
    "tags",
    "conjugation",
    "audio",
    "sentence",
    "sentence-furigana",
];

#[derive(Deserialize)]
pub struct TokenizeBody {
    pub text: String,
    #[serde(default = "default_scan_length")]
    pub scan_length: u32,
}

fn default_scan_length() -> u32 {
    10
}

#[derive(Serialize)]
struct TokenizeRequest<'a> {
    text: &'a str,
    #[serde(rename = "scanLength")]
    scan_length: u32,
}

#[derive(Serialize)]
struct AnkiFieldsRequest<'a> {
    markers: &'a [&'a str],
    #[serde(rename = "maxEntries")]
    max_entries: u32,
    #[serde(rename = "type")]
    field_type: &'a str,
    #[serde(rename = "includeMedia")]
    include_media: bool,
    text: &'a str,
}

/// One shared client so requests reuse pooled keep-alive connections to the
/// local host. Building a client per request forced a fresh TCP connection
/// each time, which the rapid-fire scan mode turned into connection churn.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(60))
            .build()
            .expect("reqwest client")
    })
}

#[tauri::command]
pub async fn yomitan_tokenize(base_url: String, body: TokenizeBody) -> Result<Value, String> {
    let url = format!("{}/tokenize", base_url.trim_end_matches('/'));
    let req = TokenizeRequest {
        text: &body.text,
        scan_length: body.scan_length,
    };
    let res = client()
        .post(&url)
        .json(&req)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.json::<Value>().await.map_err(|e| e.to_string())
}

pub async fn ankifields_value(
    base_url: &str,
    text: &str,
    include_media: bool,
) -> Result<Value, String> {
    let url = format!("{}/ankiFields", base_url.trim_end_matches('/'));
    let req = AnkiFieldsRequest {
        markers: ANKI_MARKERS,
        max_entries: MAX_ENTRIES,
        field_type: "term",
        include_media,
        text,
    };
    let res = client()
        .post(&url)
        .json(&req)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.json::<Value>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn yomitan_ankifields(
    base_url: String,
    text: String,
    include_media: Option<bool>,
) -> Result<Value, String> {
    ankifields_value(&base_url, &text, include_media.unwrap_or(false)).await
}

#[tauri::command]
pub async fn yomitan_probe(base_url: String) -> Result<u64, String> {
    let url = format!("{}/tokenize", base_url.trim_end_matches('/'));
    let started = std::time::Instant::now();
    let res = client()
        .post(&url)
        .json(&TokenizeRequest {
            text: "テスト",
            scan_length: 10,
        })
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let _ = res.json::<Value>().await.map_err(|e| e.to_string())?;
    Ok(started.elapsed().as_millis() as u64)
}
