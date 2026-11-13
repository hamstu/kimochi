// yomitan.rs — invoke wrappers around the local yomitan-api host.
//
// We don't try to type the responses on the Rust side — we pass through serde_json::Value
// so the frontend can deal with the field shapes it cares about. This keeps the Rust code
// simple and resilient to host version differences.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
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
    let req = TokenizeRequest { text: &body.text, scan_length: body.scan_length };
    let res = client().post(&url).json(&req).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.json::<Value>().await.map_err(|e| e.to_string())
}

pub async fn ankifields_value(base_url: &str, text: &str, include_media: bool) -> Result<Value, String> {
    if include_media {
        return ankifields_first(base_url, text, include_media, MAX_ENTRIES).await;
    }
    let key = (base_url.trim_end_matches('/').to_string(), text.to_string());
    let cell = {
        let mut cache = entries_cache().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        cache.retain(|_, (at, _)| at.elapsed() < ENTRIES_KEPT);
        if cache.len() >= ENTRIES_MAX {
            cache.clear();
        }
        cache
            .entry(key.clone())
            .or_insert_with(|| (std::time::Instant::now(), Arc::new(tokio::sync::OnceCell::new())))
            .1
            .clone()
    };
    let result =
        cell.get_or_init(|| async { ankifields_first(&key.0, &key.1, false, MAX_ENTRIES).await }).await.clone();
    if result.is_err() {
        // Not kept: the API may answer the next time.
        let mut cache = entries_cache().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if cache.get(&key).is_some_and(|(_, kept)| Arc::ptr_eq(kept, &cell)) {
            cache.remove(&key);
        }
    }
    result
}

/// A word's entries (without media) asked for in the last `ENTRIES_KEPT`, by (API address, word),
/// or still on their way: the scanner asks for a word's entries as soon as it knows the word
/// (`yomitan_prefetch`), while it waits to see whether the pointer stays, and the pop-up then
/// opens on that answer instead of asking again; going back to a word shows it at once. Kept
/// briefly, so a dictionary changed in Yomitan shows within a minute.
type EntriesCell = Arc<tokio::sync::OnceCell<Result<Value, String>>>;
const ENTRIES_KEPT: Duration = Duration::from_secs(60);
const ENTRIES_MAX: usize = 300;

/// (API address, word) → when asked, and the answer.
type EntriesCache = Mutex<HashMap<(String, String), (std::time::Instant, EntriesCell)>>;

fn entries_cache() -> &'static EntriesCache {
    static CACHE: OnceLock<EntriesCache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Start fetching `term`'s entries, for the pop-up that may open on it (`ankifields_value`).
#[tauri::command]
pub fn yomitan_prefetch(base_url: String, term: String) {
    let term = term.trim().to_string();
    if term.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _ = ankifields_value(&base_url, &term, false).await;
    });
}

/// The first `max_entries` entries of a lookup. With media, Yomitan fetches the audio of every
/// entry it returns, trying its audio sources in turn (online ones too) for each, so fewer
/// entries come back much sooner.
pub async fn ankifields_first(
    base_url: &str,
    text: &str,
    include_media: bool,
    max_entries: u32,
) -> Result<Value, String> {
    let url = format!("{}/ankiFields", base_url.trim_end_matches('/'));
    let req = AnkiFieldsRequest { markers: ANKI_MARKERS, max_entries, field_type: "term", include_media, text };
    let res = client().post(&url).json(&req).send().await.map_err(|e| e.to_string())?;
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
    max_entries: Option<u32>,
) -> Result<Value, String> {
    let max_entries = max_entries.unwrap_or(MAX_ENTRIES).clamp(1, MAX_ENTRIES);
    ankifields_first(&base_url, &text, include_media.unwrap_or(false), max_entries).await
}

#[tauri::command]
pub async fn yomitan_probe(base_url: String) -> Result<u64, String> {
    let url = format!("{}/tokenize", base_url.trim_end_matches('/'));
    let started = std::time::Instant::now();
    let res = client()
        .post(&url)
        .json(&TokenizeRequest { text: "テスト", scan_length: 10 })
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let _ = res.json::<Value>().await.map_err(|e| e.to_string())?;
    Ok(started.elapsed().as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// The scanner's prefetch and the pop-up ask for the same word at almost the same time: one
    /// request answers both, and the answer is kept. A failure is not kept, and media is never.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_words_entries_are_fetched_once_while_kept_and_a_failure_is_not_kept() {
        use crate::reader::ankiconnect::tests::serve;
        let failing = Arc::new(AtomicBool::new(true));
        let fail = failing.clone();
        let (url, seen) = serve(move |_| {
            if fail.swap(false, Ordering::SeqCst) {
                (500, "{}".into())
            } else {
                (200, r#"{"fields":[]}"#.into())
            }
        });
        assert!(ankifields_value(&url, "猫", false).await.is_err());
        let (a, b) = tokio::join!(ankifields_value(&url, "猫", false), ankifields_value(&url, "猫", false));
        assert!(a.is_ok() && b.is_ok());
        assert!(ankifields_value(&url, "猫", false).await.is_ok());
        assert_eq!(seen.lock().unwrap().len(), 2, "the failure, then one request for all three");
        let _ = ankifields_value(&url, "猫", true).await;
        let _ = ankifields_value(&url, "猫", true).await;
        assert_eq!(seen.lock().unwrap().len(), 4, "with media, asked each time");
    }
}
