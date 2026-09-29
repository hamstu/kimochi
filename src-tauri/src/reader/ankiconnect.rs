// ankiconnect.rs — thin HTTP client + Tauri commands for AnkiConnect
// (https://github.com/FooSoft/anki-connect). Mirrors the request/response
// envelope used by the anki-remote-mining sibling project. All calls POST JSON
// to the user-configured base URL (default http://127.0.0.1:8765).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const VERSION: u8 = 6;

#[derive(Serialize)]
struct Request<'a, T: Serialize> {
    action: &'a str,
    version: u8,
    params: T,
}

#[derive(Deserialize)]
struct Response<T> {
    result: Option<T>,
    error: Option<String>,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .expect("reqwest client")
}

async fn call<P: Serialize, R: for<'de> Deserialize<'de>>(
    url: &str,
    action: &str,
    params: P,
) -> Result<R, String> {
    let body = Request {
        action,
        version: VERSION,
        params,
    };
    let res = client()
        .post(url.trim_end_matches('/'))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("unreachable: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let parsed: Response<R> = res.json().await.map_err(|e| e.to_string())?;
    if let Some(err) = parsed.error {
        return Err(err);
    }
    parsed
        .result
        .ok_or_else(|| "ankiconnect: missing result".to_string())
}

#[tauri::command]
pub async fn anki_probe(url: String) -> Result<u64, String> {
    let started = std::time::Instant::now();
    let _v: u32 = call(&url, "version", json!({})).await?;
    Ok(started.elapsed().as_millis() as u64)
}

#[tauri::command]
pub async fn anki_deck_names(url: String) -> Result<Vec<String>, String> {
    call(&url, "deckNames", json!({})).await
}

#[tauri::command]
pub async fn anki_model_names(url: String) -> Result<Vec<String>, String> {
    call(&url, "modelNames", json!({})).await
}

#[tauri::command]
pub async fn anki_model_field_names(
    url: String,
    model_name: String,
) -> Result<Vec<String>, String> {
    call(&url, "modelFieldNames", json!({ "modelName": model_name })).await
}

#[tauri::command]
pub async fn anki_find_notes(url: String, query: String) -> Result<Vec<u64>, String> {
    call(&url, "findNotes", json!({ "query": query })).await
}

#[tauri::command]
pub async fn anki_gui_browse(url: String, query: String) -> Result<Vec<u64>, String> {
    call(&url, "guiBrowse", json!({ "query": query })).await
}

#[tauri::command]
pub async fn anki_store_media_file(
    url: String,
    filename: String,
    data_base64: String,
) -> Result<String, String> {
    call(
        &url,
        "storeMediaFile",
        json!({ "filename": filename, "data": data_base64 }),
    )
    .await
}

#[tauri::command]
pub async fn anki_add_note(
    url: String,
    deck: String,
    model: String,
    fields: HashMap<String, String>,
    tags: Vec<String>,
    allow_duplicate: Option<bool>,
) -> Result<u64, String> {
    let allow = allow_duplicate.unwrap_or(false);
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
    let result: Value = call(&url, "addNote", params).await?;
    result
        .as_u64()
        .ok_or_else(|| "addNote returned non-numeric id".to_string())
}
