// vndb.rs — thin proxy for VNDB's Kana API. We go through Rust so the image
// CDN (which doesn't send Access-Control-Allow-Origin) is reachable from the
// webview, and so we can honor rate limits + timeouts uniformly.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const VN_URL: &str = "https://api.vndb.org/kana/vn";
const CHARACTER_URL: &str = "https://api.vndb.org/kana/character";
const USER_AGENT: &str = "super-texthooker (https://github.com/anthropics)";

const VN_FIELDS: &str =
    "title,alttitle,titles.title,titles.lang,titles.official,image.url,image.sexual,released";
const CHAR_FIELDS: &str =
    "name,original,aliases,description,image.url,image.sexual,vns.id,vns.role,vns.title";

const VN_PAGE_SIZE: u16 = 15;
const CHAR_PAGE_SIZE: u16 = 100;
const CHAR_MAX_PAGES: u16 = 4; // up to 400 chars per VN — more than enough

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("client build failed: {e}"))
}

async fn post_json(client: &reqwest::Client, url: &str, body: &Value) -> Result<Value, String> {
    let resp = client
        .post(url)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("vndb request failed: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("vndb read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("vndb HTTP {}: {}", status.as_u16(), text));
    }
    serde_json::from_str::<Value>(&text).map_err(|e| format!("vndb JSON parse failed: {e}"))
}

#[tauri::command]
pub async fn vndb_search_vns(query: String) -> Result<Value, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(json!({ "results": [], "more": false }));
    }
    let client = client()?;
    let body = json!({
        "filters": ["search", "=", q],
        "fields": VN_FIELDS,
        "results": VN_PAGE_SIZE,
        "sort": "searchrank",
    });
    post_json(&client, VN_URL, &body).await
}

/// Fetch all characters linked to the given VN id (e.g. "v3770"). Paginates
/// up to CHAR_MAX_PAGES * CHAR_PAGE_SIZE results.
#[tauri::command]
pub async fn vndb_characters_by_vn(vn_id: String) -> Result<Value, String> {
    let id = vn_id.trim();
    if id.is_empty() {
        return Ok(json!({ "results": [], "more": false }));
    }
    let client = client()?;
    let mut all: Vec<Value> = Vec::new();
    let mut more = false;

    for page in 1..=CHAR_MAX_PAGES {
        let body = json!({
            "filters": ["vn", "=", ["id", "=", id]],
            "fields": CHAR_FIELDS,
            "results": CHAR_PAGE_SIZE,
            "page": page,
            "sort": "name",
        });
        let resp = post_json(&client, CHARACTER_URL, &body).await?;
        if let Some(arr) = resp.get("results").and_then(|v| v.as_array()) {
            for item in arr {
                all.push(item.clone());
            }
        }
        more = resp.get("more").and_then(|v| v.as_bool()).unwrap_or(false);
        if !more {
            break;
        }
    }

    Ok(json!({ "results": all, "more": more }))
}

#[derive(Serialize)]
pub struct FetchedImage {
    /// Base64-encoded raw bytes.
    pub base64: String,
    /// Detected extension from content-type ("jpg", "png", "webp", etc.).
    pub ext: String,
}

#[tauri::command]
pub async fn vndb_fetch_image(url: String) -> Result<FetchedImage, String> {
    // Only allow VNDB's own image hosts to limit surprise SSRF surface.
    let allowed = url.starts_with("https://t.vndb.org/")
        || url.starts_with("https://s.vndb.org/")
        || url.starts_with("https://s2.vndb.org/");
    if !allowed {
        return Err(format!("refusing non-VNDB image host: {url}"));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("vndb image request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("vndb image HTTP {}", status.as_u16()));
    }

    let ext = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| match ct.split(';').next().unwrap_or(ct).trim() {
            "image/jpeg" => "jpg",
            "image/png" => "png",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => "jpg",
        })
        .unwrap_or("jpg")
        .to_string();

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("vndb image read failed: {e}"))?;

    Ok(FetchedImage {
        base64: STANDARD.encode(&bytes),
        ext,
    })
}
