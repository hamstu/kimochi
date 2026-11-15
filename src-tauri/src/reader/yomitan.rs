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
    lane(&base_url).touch();
    tokenize(&base_url, &body.text, body.scan_length).await
}

async fn tokenize(base_url: &str, text: &str, scan_length: u32) -> Result<Value, String> {
    let url = format!("{}/tokenize", base_url.trim_end_matches('/'));
    let req = TokenizeRequest { text, scan_length };
    let res = client().post(&url).json(&req).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let mut value = res.json::<Value>().await.map_err(|e| e.to_string())?;
    trim_tokenize(&mut value);
    Ok(value)
}

/// What the scanner (`wordAtStart` in ui/scan-text.ts) and the word cursor (`tokensFromParse` in
/// ui/word-nav.js) read of a `/tokenize` answer: each chunk's `source`, each segment's `text` and
/// `reading`, whether a token has `headwords`, and each headword's `term`, `reading` and
/// `sources`. Yomitan also puts every frequency and pitch dictionary's data on every candidate
/// headword: with many dictionaries a 16-character window's answer runs to hundreds of KB, all
/// of it crossing to the webview for nothing. Those are dropped here.
fn trim_tokenize(value: &mut Value) {
    let Some(chunks) = value.as_array_mut() else { return };
    for chunk in chunks {
        let Some(content) = chunk.get_mut("content").and_then(Value::as_array_mut) else { continue };
        for token in content.iter_mut().filter_map(Value::as_array_mut) {
            for segment in token.iter_mut() {
                let Some(groups) = segment.get_mut("headwords").and_then(Value::as_array_mut) else { continue };
                for headword in groups.iter_mut().filter_map(Value::as_array_mut).flatten() {
                    if let Some(fields) = headword.as_object_mut() {
                        fields.retain(|key, _| matches!(key.as_str(), "term" | "reading" | "sources"));
                    }
                }
            }
        }
    }
}

/// How many entries a word's first answer carries. Yomitan renders every marker of every entry it
/// returns, so its time (and the answer's size) grows with the entries: a word with many shorter
/// sub-term matches (この先, そんな) across many dictionaries takes it hundreds of milliseconds
/// for 32 and a quarter of that for 4 (over 40 common words: 59 ms median for 32, 54 for 4, 35
/// for 2). A pop-up shows one or two entries before it scrolls, so it opens on two; the rest
/// follow (`Stage::All`) once it is showing.
pub const FIRST_ENTRIES: u32 = 2;

/// Which of a word's entries a lookup asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Stage {
    /// The first `FIRST_ENTRIES`: what the pop-up opens on.
    First,
    /// Every entry, up to `MAX_ENTRIES`.
    All,
}

impl Stage {
    fn max_entries(self) -> u32 {
        match self {
            Stage::First => FIRST_ENTRIES,
            Stage::All => MAX_ENTRIES,
        }
    }
}

/// Why a lookup was not sent: something newer was asked while it waited its turn.
pub const DROPPED: &str = "dropped: a newer word was asked for first";

/// One lookup at a time per Yomitan API, and only lookups still wanted.
///
/// Yomitan does a lookup's work as soon as it arrives, and nothing can stop it once it has: the
/// helpers that carry it (the official one, and the one Kimochi installs) relay one message at a
/// time, and even one that relays them all at once leaves Yomitan sharing one thread between them.
/// A glide over a line used to ask for every word it crossed (the scanner's prefetch, and a
/// pop-up per word), so the word the pointer came to rest on waited behind all of them: seconds,
/// with many dictionaries. Here a lookup waits its turn (`gate`) without being sent, and when its
/// turn comes it is sent only if it is still wanted; otherwise it is dropped, never reaching
/// Yomitan. A prefetch is wanted while it is the newest one (`latest`) or its word is the newest
/// pop-up's (`showing`); a pop-up's lookup while that pop-up is the newest at its level.
struct Lane {
    gate: tokio::sync::Semaphore,
    latest: std::sync::atomic::AtomicU64,
    showing: Mutex<Option<String>>,
    /// When the reader last caused a request (a tokenize, a prefetch, a pop-up): warming
    /// (`yomitan_warm`) waits until they have been quiet for `WARM_IDLE`.
    touched: Mutex<std::time::Instant>,
    /// The newest warm: an older one stops at its next word.
    warm: std::sync::atomic::AtomicU64,
}

impl Lane {
    fn touch(&self) {
        *self.touched.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = std::time::Instant::now();
    }

    fn quiet_for(&self) -> Duration {
        self.touched.lock().unwrap_or_else(std::sync::PoisonError::into_inner).elapsed()
    }
}

fn lane(base_url: &str) -> Arc<Lane> {
    static LANES: OnceLock<Mutex<HashMap<String, Arc<Lane>>>> = OnceLock::new();
    let mut lanes = LANES.get_or_init(Default::default).lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    lanes
        .entry(base_url.trim_end_matches('/').to_string())
        .or_insert_with(|| {
            Arc::new(Lane {
                gate: tokio::sync::Semaphore::new(1),
                latest: std::sync::atomic::AtomicU64::new(0),
                showing: Mutex::new(None),
                touched: Mutex::new(std::time::Instant::now()),
                warm: std::sync::atomic::AtomicU64::new(0),
            })
        })
        .clone()
}

/// The newest pop-up's word: its prefetch is never dropped, since the pop-up is waiting for it.
pub fn set_showing(base_url: &str, term: &str) {
    let lane = lane(base_url);
    lane.touch();
    *lane.showing.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(term.to_string());
}

/// A word's entries at `stage`, from the cache or asked for in turn; `wanted` says, when the
/// lookup's turn comes, whether it is still worth sending. If another caller's lookup of the same
/// word was dropped while this one waited on it, this one asks again (when still wanted).
pub async fn entries(
    base_url: &str,
    text: &str,
    stage: Stage,
    wanted: &(dyn Fn() -> bool + Send + Sync),
) -> Result<Value, String> {
    loop {
        match entries_once(base_url, text, stage, wanted).await {
            Err(error) if error == DROPPED && wanted() => continue,
            result => return result,
        }
    }
}

/// A word's entries at `stage` if they are already here (asked for and answered).
pub fn entries_ready(base_url: &str, text: &str, stage: Stage) -> Option<Value> {
    let key = (base_url.trim_end_matches('/').to_string(), text.to_string(), stage);
    let cache = entries_cache().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let (at, cell) = cache.get(&key)?;
    if at.elapsed() >= ENTRIES_KEPT {
        return None;
    }
    cell.get().and_then(|result| result.as_ref().ok().cloned())
}

async fn entries_once(
    base_url: &str,
    text: &str,
    stage: Stage,
    wanted: &(dyn Fn() -> bool + Send + Sync),
) -> Result<Value, String> {
    let key = (base_url.trim_end_matches('/').to_string(), text.to_string(), stage);
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
    let result = cell
        .get_or_init(|| async {
            let lane = lane(&key.0);
            let _turn = lane.gate.acquire().await.map_err(|e| e.to_string())?;
            if !wanted() {
                return Err(DROPPED.to_string());
            }
            ankifields_first(&key.0, &key.1, false, stage.max_entries()).await
        })
        .await
        .clone();
    if result.is_err() {
        // Not kept: the API may answer the next time, and a dropped lookup was never asked.
        let mut cache = entries_cache().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if cache.get(&key).is_some_and(|(_, kept)| Arc::ptr_eq(kept, &cell)) {
            cache.remove(&key);
        }
    }
    result
}

/// Every entry of a lookup with their media (audio, dictionary images): never kept, and outside
/// the lane, since Yomitan may take seconds over it (it downloads each entry's audio).
pub async fn ankifields_media(base_url: &str, text: &str) -> Result<Value, String> {
    ankifields_first(base_url, text, true, MAX_ENTRIES).await
}

/// A word's entries (without media) asked for in the last `ENTRIES_KEPT`, by (API address, word,
/// stage), or still on their way: the scanner asks for a word's entries as soon as it knows the
/// word (`yomitan_prefetch`), while it waits to see whether the pointer stays, and the pop-up then
/// opens on that answer instead of asking again; going back to a word shows it at once. Kept
/// briefly, so a dictionary changed in Yomitan shows within a minute.
type EntriesCell = Arc<tokio::sync::OnceCell<Result<Value, String>>>;
const ENTRIES_KEPT: Duration = Duration::from_secs(60);
const ENTRIES_MAX: usize = 300;

/// (API address, word, stage) → when asked, and the answer.
type EntriesCache = Mutex<HashMap<(String, String, Stage), (std::time::Instant, EntriesCell)>>;

fn entries_cache() -> &'static EntriesCache {
    static CACHE: OnceLock<EntriesCache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Start fetching `term`'s first entries, for the pop-up that may open on it. Sent in turn, and
/// only if, when its turn comes, no newer word has been prefetched since (the pointer has moved on)
/// or it is the word the newest pop-up shows.
#[tauri::command]
pub fn yomitan_prefetch(base_url: String, term: String) {
    let term = term.trim().to_string();
    if term.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(prefetch(base_url, term));
}

/// The prefetch's lookup. Its ticket is taken now, so prefetches asked in order are newest-last
/// however their tasks are scheduled.
fn prefetch(base_url: String, term: String) -> impl std::future::Future<Output = ()> {
    use std::sync::atomic::Ordering;
    let lane = lane(&base_url);
    lane.touch();
    let ticket = lane.latest.fetch_add(1, Ordering::SeqCst) + 1;
    async move {
        let wanted = || {
            lane.latest.load(Ordering::SeqCst) == ticket
                || lane.showing.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_deref() == Some(&term)
        };
        let _ = entries_once(&base_url, &term, Stage::First, &wanted).await;
    }
}

/// How long the reader's requests must have been quiet before warming sends one.
const WARM_IDLE: Duration = Duration::from_millis(250);
/// At most this many words are warmed for one screen of text, and this much text is read.
const WARM_WORDS: usize = 80;
const WARM_CHARS: usize = 1200;

/// Warm the first entries of every word in `texts` (the overlay's boxes, in reading order), so
/// pointing at any of them opens its pop-up from the cache instead of waiting on Yomitan.
///
/// Background work that must never cost the reader anything: each request (a box's `/tokenize`,
/// then each word's first entries) waits until the lane is free and the reader's own requests have
/// been quiet for `WARM_IDLE`, and a newer warm (new text on screen) stops this one at its next
/// step. The most a hover can then wait for warming is the one request already sent.
#[tauri::command]
pub fn yomitan_warm(base_url: String, texts: Vec<String>) {
    use std::sync::atomic::Ordering;
    let lane = lane(&base_url);
    let ticket = lane.warm.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(warm(base_url, texts, lane, ticket));
}

async fn warm(base_url: String, texts: Vec<String>, lane: Arc<Lane>, ticket: u64) {
    use std::sync::atomic::Ordering;
    let current = || lane.warm.load(Ordering::SeqCst) == ticket;
    // Until the lane is free and the reader quiet; false once a newer warm took over.
    let idle = || async {
        loop {
            if !current() {
                return false;
            }
            if lane.gate.available_permits() > 0 && lane.quiet_for() >= WARM_IDLE {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    };
    let mut seen = std::collections::HashSet::new();
    let mut budget = WARM_CHARS;
    for text in texts {
        let text: String = text.trim().chars().take(budget).collect();
        if text.is_empty() {
            continue;
        }
        budget = budget.saturating_sub(text.chars().count());
        if !idle().await {
            return;
        }
        let Ok(parsed) = tokenize(&base_url, &text, 16).await else { return };
        for word in words_of_parse(&parsed, &text) {
            if seen.len() >= WARM_WORDS {
                return;
            }
            if !seen.insert(word.clone()) || entries_ready(&base_url, &word, Stage::First).is_some() {
                continue;
            }
            if !idle().await {
                return;
            }
            // Sent only if, when its turn comes, the reader is still quiet and no newer warm began.
            let quiet = || current() && lane.quiet_for() >= WARM_IDLE;
            let _ = entries_once(&base_url, &word, Stage::First, &quiet).await;
        }
        if budget == 0 {
            return;
        }
    }
}

/// The words a pointer resting at each token's start would look up, from a `/tokenize` of the
/// whole `text`: per token with headwords, the widest of its text and its headwords'
/// `originalText` that starts there (as `wordAtStart` in ui/scan-text.ts picks).
fn words_of_parse(parsed: &Value, text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut offset = 0;
    for chunk in parsed.as_array().into_iter().flatten() {
        if chunk.get("source").and_then(Value::as_str).is_some_and(|s| s != "scanning-parser") {
            continue;
        }
        for token in chunk.get("content").and_then(Value::as_array).into_iter().flatten() {
            let segments = token.as_array().map(Vec::as_slice).unwrap_or_default();
            let value: String = segments.iter().filter_map(|s| s.get("text").and_then(Value::as_str)).collect();
            if value.is_empty() {
                continue;
            }
            let Some(found) = text[offset..].find(&value) else { break };
            let start = offset + found;
            offset = start + value.len();
            let Some(groups) = segments.first().and_then(|s| s.get("headwords")).and_then(Value::as_array) else {
                continue;
            };
            let rest = &text[start..];
            let mut widest = value.clone();
            for headword in groups.iter().filter_map(Value::as_array).flatten() {
                for source in headword.get("sources").and_then(Value::as_array).into_iter().flatten() {
                    if let Some(original) = source.get("originalText").and_then(Value::as_str) {
                        if original.chars().count() > widest.chars().count()
                            && original.starts_with(&value)
                            && rest.starts_with(original)
                        {
                            widest = original.to_string();
                        }
                    }
                }
            }
            words.push(widest);
        }
    }
    words
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

    const ALWAYS: &(dyn Fn() -> bool + Send + Sync) = &|| true;

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
        assert!(entries(&url, "猫", Stage::First, ALWAYS).await.is_err());
        let (a, b) = tokio::join!(entries(&url, "猫", Stage::First, ALWAYS), entries(&url, "猫", Stage::First, ALWAYS));
        assert!(a.is_ok() && b.is_ok());
        assert!(entries(&url, "猫", Stage::First, ALWAYS).await.is_ok());
        assert!(entries_ready(&url, "猫", Stage::First).is_some());
        assert_eq!(seen.lock().unwrap().len(), 2, "the failure, then one request for all three");
        assert!(entries(&url, "猫", Stage::All, ALWAYS).await.is_ok());
        assert_eq!(seen.lock().unwrap().len(), 3, "every entry is its own request");
        assert!(seen.lock().unwrap()[1].contains(r#""maxEntries":2"#));
        assert!(seen.lock().unwrap()[2].contains(r#""maxEntries":32"#));
        let _ = ankifields_media(&url, "猫").await;
        let _ = ankifields_media(&url, "猫").await;
        assert_eq!(seen.lock().unwrap().len(), 5, "with media, asked each time");
    }

    /// A glide: while one word's lookup runs, the pointer crosses three more. Only the newest of
    /// them is sent; the two it passed are dropped without reaching the API, unless the newest
    /// pop-up shows one of them.
    #[tokio::test(flavor = "multi_thread")]
    async fn prefetches_the_pointer_has_passed_are_never_sent() {
        use crate::reader::ankiconnect::tests::serve;
        let (url, seen) = serve(|_| {
            std::thread::sleep(Duration::from_millis(150));
            (200, r#"{"fields":[]}"#.into())
        });
        let first = tokio::spawn(prefetch(url.clone(), "この".into()));
        tokio::time::sleep(Duration::from_millis(30)).await; // この is in flight
        let passed = [prefetch(url.clone(), "先".into()), prefetch(url.clone(), "に".into())];
        set_showing(&url, "先");
        let newest = prefetch(url.clone(), "進む".into());
        let ([a, b], c) = (passed, newest);
        tokio::join!(a, b, c);
        first.await.unwrap();
        let asked: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.split(r#""text":""#).nth(1).unwrap_or("").split('"').next().unwrap_or("").to_string())
            .collect();
        assert_eq!(asked, ["この", "先", "進む"], "に was passed and dropped; 先 is the pop-up's word");
        assert!(entries_ready(&url, "に", Stage::First).is_none(), "a dropped lookup is not kept");
    }

    /// The scanner and the word cursor's fields stay; every headword's frequencies and pitch go.
    #[test]
    fn a_tokenize_answer_keeps_what_the_scanner_reads() {
        let mut value = serde_json::json!([{
            "id": "scan", "source": "scanning-parser", "dictionary": null, "index": 0,
            "content": [
                [{"text": "書", "reading": "か", "headwords": [[{
                    "term": "書き込む", "reading": "かきこむ",
                    "sources": [{"originalText": "書き込み", "transformedText": "書き込み", "deinflectedText": "書き込む", "matchType": "exact", "matchSource": "term", "isPrimary": true}],
                    "frequencies": [{"dictionary": "JPDB", "frequency": 12000}],
                    "pronunciations": [{"dictionary": "NHK", "pitches": [0]}]
                }]]}, {"text": "き込み", "reading": "きこみ"}],
                [{"text": "、", "reading": ""}]
            ]
        }]);
        trim_tokenize(&mut value);
        let headword = &value[0]["content"][0][0]["headwords"][0][0];
        assert_eq!(headword.as_object().unwrap().keys().collect::<Vec<_>>(), ["reading", "sources", "term"]);
        assert_eq!(headword["sources"][0]["originalText"], "書き込み");
        assert_eq!(value[0]["source"], "scanning-parser");
        assert_eq!(value[0]["content"][0][1]["text"], "き込み");
        assert_eq!(value[0]["content"][1][0]["text"], "、");
    }

    /// One parse of a box gives the words a pointer would look up at each token's start; an
    /// inflected word reads as its whole span, and unmatched runs give none.
    #[test]
    fn a_boxes_words_come_from_one_parse() {
        let text = "書き込みを見た。";
        let parsed = serde_json::json!([{ "source": "scanning-parser", "content": [
            [{"text": "書", "reading": "か", "headwords": [[{"term": "書き込む", "reading": "かきこむ",
                "sources": [{"originalText": "書き込み"}, {"originalText": "書"}]}]]}, {"text": "き込み", "reading": "きこみ"}],
            [{"text": "を", "reading": "", "headwords": [[{"term": "を", "reading": "を", "sources": [{"originalText": "を"}]}]]}],
            [{"text": "見", "reading": "み", "headwords": [[{"term": "見る", "reading": "みる", "sources": [{"originalText": "見た"}]}]]}, {"text": "た", "reading": ""}],
            [{"text": "。", "reading": ""}]
        ]}]);
        assert_eq!(words_of_parse(&parsed, text), ["書き込み", "を", "見た"]);
    }

    /// Warming parses each box, then asks for each new word's first entries, and does nothing more
    /// once newer text has arrived.
    #[tokio::test(flavor = "multi_thread")]
    async fn warming_fetches_each_words_first_entries_and_gives_way_to_newer_text() {
        use crate::reader::ankiconnect::tests::serve;
        let (url, seen) = serve(|body| {
            if body.contains("scanLength") {
                (
                    200,
                    serde_json::json!([{ "source": "scanning-parser", "content": [
                        [{"text": "森", "headwords": [[{"term": "森", "sources": [{"originalText": "森"}]}]]}],
                        [{"text": "の", "headwords": [[{"term": "の", "sources": [{"originalText": "の"}]}]]}],
                        [{"text": "奥", "headwords": [[{"term": "奥", "sources": [{"originalText": "奥"}]}]]}]
                    ]}])
                    .to_string(),
                )
            } else {
                (200, r#"{"fields":[]}"#.into())
            }
        });
        // The lane has been quiet: the warm runs at once.
        let lane = lane(&url);
        *lane.touched.lock().unwrap() = std::time::Instant::now() - WARM_IDLE * 2;
        let ticket = lane.warm.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        warm(url.clone(), vec!["森の奥".into(), "森".into()], lane.clone(), ticket).await;
        let asked: Vec<String> =
            seen.lock().unwrap().iter().map(|r| r.split("\r\n\r\n").nth(1).unwrap_or("").to_string()).collect();
        assert_eq!(asked.len(), 5, "two parses, then 森, の, 奥 once each: {asked:?}");
        assert!(asked[1].contains(r#""text":"森""#) && asked[1].contains(r#""maxEntries":2"#));
        assert!(entries_ready(&url, "奥", Stage::First).is_some());

        // A newer warm began: the older one sends nothing more.
        let stale = lane.warm.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        lane.warm.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        warm(url.clone(), vec!["新しい".into()], lane.clone(), stale + 1).await;
        assert_eq!(seen.lock().unwrap().len(), 5);
    }
}
