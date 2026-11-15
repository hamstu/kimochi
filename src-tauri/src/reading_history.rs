//! The reading history: every line read, kept for stats and export (GitHub issue "Stats: store
//! per-line timestamp and full sentence").
//!
//! The Log's transcript (`sessions/<sid>/lines.json`) is a view the person trims, clears and
//! syncs; this is the record of what was read, in the shape reading-stats tools keep (GSM's
//! `game_lines`, exSTATic's per-line store, SubMiner's immersion tracker): when, the exact text,
//! what it came from, how it was captured. Screenshot and audio retention never touch it.
//!
//! On disk, `<profile>/reading-history/`:
//! - `YYYY-MM.jsonl`: one [`Event`] per line, appended in the order they arrive (UTC month of
//!   `at`). Only appended to: a crash loses at most the line being written.
//! - `backfill.jsonl`: the Log's lines from before the history existed, written once
//!   ([`ensure_backfilled`]); its presence marks the backfill done.
//!
//! [`lines`] folds the events into one [`HistoryLine`] per line uid: an `edit` replaces the text,
//! a `delete` (a misreading deleted from the Log, or fragments a fuller reading replaced) drops
//! the line. Clearing the Log, its line limit and deleting a session do not delete history.
//!
//! The Log (frontend/texthooker/core/history.ts) records. Export writes JSON and a CSV with every
//! field, and exSTATic's two CSVs: its lines CSV (`uuid,given_identifier,name,line,time`) is the
//! one per-line format other tools read (exSTATic, and GameSentenceMiner's exSTATic import), and
//! its stats CSV names the media and carries the daily totals.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The folder in a profile.
pub const DIR: &str = "reading-history";
const BACKFILL_FILE: &str = "backfill.jsonl";
/// Longest text kept for one line, in characters: far past any sentence, and short enough that a
/// pasted page cannot bloat the history.
const TEXT_LIMIT: usize = 5_000;

static LOCK: Mutex<()> = Mutex::new(());

/// Where the text came from, as the Log knew it (frontend `HistorySource`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exe: Option<String>,
}

impl Source {
    fn is_empty(&self) -> bool {
        self.window.is_none() && self.app.is_none() && self.exe.is_none()
    }
}

/// One change to the history, as the Log sends it and as each `.jsonl` line stores it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// `add`, `edit` or `delete`.
    pub op: String,
    pub uid: String,
    /// When the change was made, epoch ms.
    pub at: u64,
    /// When the line was read, epoch ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_text: Option<String>,
    /// How it was captured: `ocr`, `hook`, `clipboard`, `websocket`, `webhook`, `cli`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// The Log session it was read in (one per game or book, usually).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Minutes east of UTC where it was read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tz: Option<i32>,
    /// Copied from the Log by the one-time backfill, not recorded as it was read.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub backfilled: bool,
}

/// A line read, as the history ends up with it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryLine {
    pub uid: String,
    /// When it was read, epoch ms.
    pub ts: u64,
    /// Minutes east of UTC where it was read (0 when unknown).
    pub tz: i32,
    pub text: String,
    /// The text as captured, when it was corrected afterwards.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_text: Option<String>,
    /// [`count_chars`] of `text`.
    pub chars: usize,
    pub via: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    pub session: String,
    /// The session's name now (as it was, if the session has since been deleted).
    pub session_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub backfilled: bool,
    /// Time spent on it, ms ([`with_read_time`]). Worked out at export from the timestamps; 0
    /// until then.
    pub read_ms: u64,
    /// Skipped, not read ([`with_read_time`]): it counts no characters, line or time.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
}

/// Characters read, the way the Japanese reading trackers count them (GameSentenceMiner,
/// exSTATic, Rubi): every character but punctuation, symbols, spaces and line breaks, by code
/// point. The same rule as `countChars` (frontend/texthooker/core/charCount.ts), which the Log's
/// footer counts with. `text` itself is kept, so a different count can always be re-run.
pub fn count_chars(text: &str) -> usize {
    static NOT_READ: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"[\p{P}\p{S}\p{Z}\p{Cc}]").expect("a valid pattern"));
    NOT_READ.replace_all(text, "").chars().count()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn month_file(at: u64) -> String {
    let date =
        time::OffsetDateTime::from_unix_timestamp((at / 1000) as i64).unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    format!("{:04}-{:02}.jsonl", date.year(), u8::from(date.month()))
}

fn clip(text: &str) -> String {
    if text.chars().count() <= TEXT_LIMIT {
        return text.to_string();
    }
    text.chars().take(TEXT_LIMIT).collect()
}

/// An event worth storing, tidied; None when it says nothing.
fn tidy(mut event: Event) -> Option<Event> {
    if event.uid.trim().is_empty() || event.uid.len() > 200 {
        return None;
    }
    match event.op.as_str() {
        "delete" => {
            return Some(Event { op: event.op, uid: event.uid, at: event.at, ..Default::default() });
        }
        "add" | "edit" => {}
        _ => return None,
    }
    let text = event.text.as_deref().map(str::trim).filter(|t| !t.is_empty())?;
    event.text = Some(clip(text));
    event.original_text = event.original_text.as_deref().map(clip);
    event.ts?;
    if event.source.as_ref().is_some_and(Source::is_empty) {
        event.source = None;
    }
    Some(event)
}

fn append_to(path: &Path, events: &[Event]) -> Result<(), String> {
    if events.is_empty() {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut body = Vec::new();
    for event in events {
        serde_json::to_writer(&mut body, event).map_err(|e| e.to_string())?;
        body.push(b'\n');
    }
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
    file.write_all(&body).map_err(|e| e.to_string())
}

/// Store `events` in profile folder `dir`. Returns how many were kept.
pub fn append(dir: &Path, events: Vec<Event>) -> Result<usize, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    ensure_backfilled_locked(dir)?;
    let now = now_ms();
    let mut by_file: BTreeMap<String, Vec<Event>> = BTreeMap::new();
    for event in events.into_iter().filter_map(tidy) {
        let at = if event.at == 0 { now } else { event.at };
        by_file.entry(month_file(at)).or_default().push(Event { at, ..event });
    }
    let mut kept = 0;
    for (name, events) in by_file {
        append_to(&dir.join(DIR).join(name), &events)?;
        kept += events.len();
    }
    Ok(kept)
}

/// The history's files, backfill first, then month by month.
fn files(dir: &Path) -> Vec<PathBuf> {
    let folder = dir.join(DIR);
    let mut months: Vec<PathBuf> = std::fs::read_dir(&folder)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                n.len() == "YYYY-MM.jsonl".len()
                    && n.ends_with(".jsonl")
                    && n.as_bytes()[..4].iter().all(u8::is_ascii_digit)
            })
        })
        .collect();
    months.sort();
    let mut all = vec![folder.join(BACKFILL_FILE)];
    all.extend(months);
    all
}

type Stamp = (std::time::SystemTime, u64);

/// Parsed files by modification time and size: a quiet Sync cycle or a second export reads
/// nothing again.
type Parsed = HashMap<PathBuf, (Stamp, Vec<Event>)>;
static CACHE: Mutex<Option<Parsed>> = Mutex::new(None);

fn stamp(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// The events in one file: a `.jsonl` of this computer's, or another computer's chunk
/// (`{"events": [...]}`). Anything that does not parse (a write cut short) is passed over.
fn file_events(path: &Path) -> Vec<Event> {
    let Some(at) = stamp(path) else { return Vec::new() };
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some((seen, events)) = cache.get(path) {
        if *seen == at {
            return events.clone();
        }
    }
    let events: Vec<Event> = if path.extension().is_some_and(|e| e == "jsonl") {
        let Ok(file) = std::fs::File::open(path) else { return Vec::new() };
        std::io::BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter_map(|line| serde_json::from_str::<Event>(&line).ok())
            .collect()
    } else {
        chunk_events(&crate::profile::read_json(path).unwrap_or(Value::Null))
    };
    cache.insert(path.to_path_buf(), (at, events.clone()));
    events
}

/// The events a synced chunk holds.
fn chunk_events(chunk: &Value) -> Vec<Event> {
    chunk["events"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| serde_json::from_value::<Event>(e.clone()).ok())
        .filter_map(tidy)
        .collect()
}

/// The other computers' chunks kept here (`devices/<device>/<chunk>.json`), as `(record id,
/// path)`.
fn device_chunks(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    for device in std::fs::read_dir(dir.join(DIR).join(DEVICES_DIR)).into_iter().flatten().flatten() {
        let Some(name) = device.file_name().to_str().map(str::to_string) else { continue };
        if !crate::sync_core::safe_segment(&name) {
            continue;
        }
        for chunk in std::fs::read_dir(device.path()).into_iter().flatten().flatten() {
            let path = chunk.path();
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            if path.extension().is_some_and(|e| e == "json") {
                out.push((format!("{name}/{stem}"), path.clone()));
            }
        }
    }
    out.sort();
    out
}

/// Every event in `dir`'s history, this computer's and the other computers' it has from Sync,
/// in the order they were made (`at`; events made at the same moment keep their file order).
pub fn events(dir: &Path) -> Vec<Event> {
    let mut out = Vec::new();
    for path in files(dir) {
        out.extend(file_events(&path));
    }
    for (_, path) in device_chunks(dir) {
        out.extend(file_events(&path));
    }
    out.sort_by_key(|event| event.at);
    out
}

// --- Sync ---------------------------------------------------------------------------------------
//
// Each computer's events travel as records in the `history` collection, written only by the
// computer that made them, so two never edit one record (like `stats`). A record is a chunk of
// one file's events from one UTC hour, at most CHUNK_EVENTS of them and CHUNK_BYTES long:
// `<device>/<YYYYMMDDHH>.<n>`, or `<device>/b<YYYYMMDDHH>.<n>` from the backfill. The files are
// only appended to, so a new event changes only the last chunk of its hour, and a push sends a
// few kilobytes, not the day. Other computers' chunks are kept as they arrive, in
// `devices/<device>/<chunk>.json`, and fold into `lines` like this computer's own events.

const DEVICES_DIR: &str = "devices";
const CHUNK_EVENTS: usize = 50;
/// Well under the server's 256 KB per record.
const CHUNK_BYTES: usize = 192 * 1024;

fn hour_key(at: u64) -> String {
    let date =
        time::OffsetDateTime::from_unix_timestamp((at / 1000) as i64).unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    format!("{:04}{:02}{:02}{:02}", date.year(), u8::from(date.month()), date.day(), date.hour())
}

/// One file's events as chunks: `(chunk name, events)`.
fn chunks(prefix: &str, events: &[Event]) -> Vec<(String, Vec<Value>)> {
    let mut hours: BTreeMap<String, Vec<Vec<Value>>> = BTreeMap::new();
    let mut sizes: HashMap<String, usize> = HashMap::new();
    for event in events {
        let Ok(value) = serde_json::to_value(event) else { continue };
        let size = value.to_string().len();
        let hour = hour_key(event.at);
        let pieces = hours.entry(hour.clone()).or_default();
        let used = sizes.entry(hour).or_insert(0);
        let full = pieces.last().is_none_or(|last| last.len() >= CHUNK_EVENTS || *used + size > CHUNK_BYTES);
        if full {
            pieces.push(Vec::new());
            *used = 0;
        }
        *used += size;
        pieces.last_mut().expect("a chunk").push(value);
    }
    hours
        .into_iter()
        .flat_map(|(hour, pieces)| {
            pieces
                .into_iter()
                .enumerate()
                .map(move |(n, events)| (format!("{prefix}{hour}.{n}"), events))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// The history as Sync records, `(id, data)`: this computer's events in chunks under
/// `device_id`, and the other computers' chunks as they were received.
pub fn sync_records(dir: &Path, device_id: &str) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    if crate::sync_core::safe_segment(device_id) {
        for path in files(dir) {
            let prefix = if path.ends_with(BACKFILL_FILE) { "b" } else { "" };
            for (name, events) in chunks(prefix, &file_events(&path)) {
                out.push((format!("{device_id}/{name}"), json!({ "events": events })));
            }
        }
    }
    for (id, path) in device_chunks(dir) {
        if id.split('/').next() == Some(device_id) {
            continue;
        }
        if let Some(chunk) = crate::profile::read_json(&path) {
            out.push((id, chunk));
        }
    }
    out
}

/// Keep (or, with None, drop) another computer's chunk `id` (`<device>/<chunk>`) from Sync.
pub fn write_synced(dir: &Path, id: &str, data: Option<&Value>) -> Result<(), String> {
    let Some((device, chunk)) = id.split_once('/') else { return Ok(()) };
    if !crate::sync_core::safe_segment(device) || !crate::sync_core::safe_segment(chunk) {
        return Ok(());
    }
    let path = dir.join(DIR).join(DEVICES_DIR).join(device).join(format!("{chunk}.json"));
    if let Some(cache) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        cache.remove(&path);
    }
    match data {
        Some(value) => crate::profile::write_json(&path, value),
        None => match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        },
    }
}

/// The sessions' names now, by id.
fn session_names(dir: &Path) -> HashMap<String, String> {
    let manifest = crate::profile::read_json(&dir.join("sessions.json")).unwrap_or(Value::Null);
    manifest["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| Some((s["id"].as_str()?.to_string(), s["name"].as_str()?.trim().to_string())))
        .filter(|(_, name)| !name.is_empty())
        .collect()
}

/// The events folded into the lines read, oldest first. Later events about a line win, except
/// that it keeps the time it was first read.
pub fn fold(events: Vec<Event>, names: &HashMap<String, String>) -> Vec<HistoryLine> {
    let mut order: Vec<String> = Vec::new();
    let mut lines: HashMap<String, HistoryLine> = HashMap::new();
    for event in events {
        if event.op == "delete" {
            lines.remove(&event.uid);
            continue;
        }
        let (Some(text), Some(ts)) = (event.text, event.ts) else { continue };
        let line = HistoryLine {
            uid: event.uid.clone(),
            ts,
            tz: event.tz.unwrap_or(0),
            chars: count_chars(&text),
            text,
            original_text: event.original_text,
            via: event.via.unwrap_or_default(),
            engine: event.engine,
            session: event.session.clone().unwrap_or_default(),
            session_name: event.session_name.unwrap_or_default(),
            source: event.source,
            language: event.language,
            backfilled: event.backfilled,
            read_ms: 0,
            skipped: false,
        };
        match lines.get_mut(&event.uid) {
            Some(existing) => {
                let first_read = existing.ts.min(line.ts);
                let backfilled = existing.backfilled && line.backfilled;
                // A live record knows more than the backfill's copy (its source and language).
                if event.backfilled && !existing.backfilled {
                    continue;
                }
                *existing = HistoryLine { ts: first_read, backfilled, ..line };
            }
            None => {
                order.push(event.uid.clone());
                lines.insert(event.uid, line);
            }
        }
    }
    let mut out: Vec<HistoryLine> = order.into_iter().filter_map(|uid| lines.remove(&uid)).collect();
    for line in &mut out {
        if let Some(name) = names.get(&line.session) {
            line.session_name = name.clone();
        }
        if line.session_name.is_empty() {
            line.session_name = "Untitled".into();
        }
    }
    out.sort_by_key(|line| line.ts);
    out
}

/// The lines read in profile folder `dir`, oldest first.
pub fn lines(dir: &Path) -> Vec<HistoryLine> {
    {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _ = ensure_backfilled_locked(dir);
    }
    fold(events(dir), &session_names(dir))
}

/// Copy the Log's lines into the history once, for installs from before it existed: every
/// session's `lines.json`, as `add` events marked `backfilled`. Notes are not reading; lines the
/// Log remembers deleting are gone from its file already. Trimmed or cleared lines are lost.
fn ensure_backfilled_locked(dir: &Path) -> Result<(), String> {
    let marker = dir.join(DIR).join(BACKFILL_FILE);
    if marker.exists() {
        return Ok(());
    }
    let manifest = crate::profile::read_json(&dir.join("sessions.json")).unwrap_or(Value::Null);
    let mut events = Vec::new();
    for session in manifest["sessions"].as_array().into_iter().flatten() {
        let Some(sid) = session["id"].as_str().filter(|s| crate::sync_core::safe_segment(s)) else { continue };
        let name = session["name"].as_str().map(str::to_string);
        let Some(file) = crate::profile::read_json(&dir.join("sessions").join(sid).join("lines.json")) else {
            continue;
        };
        for line in file["lines"].as_array().into_iter().flatten() {
            if line["source"] == json!("note") {
                continue;
            }
            let Some(text) = line["text"].as_str() else { continue };
            let Some(ts) = line["ts"].as_u64() else { continue };
            let uid = line["uid"]
                .as_str()
                .filter(|u| !u.is_empty())
                .map_or_else(|| crate::sync_core::derived_line_uid(sid, line), str::to_string);
            let event = Event {
                op: "add".into(),
                uid,
                at: ts,
                ts: Some(ts),
                text: Some(text.to_string()),
                original_text: line["originalText"].as_str().map(str::to_string),
                via: line["source"].as_str().map(str::to_string),
                engine: line["ocr"]["engine"].as_str().map(str::to_string),
                session: Some(sid.to_string()),
                session_name: name.clone(),
                backfilled: true,
                ..Default::default()
            };
            events.extend(tidy(event));
        }
    }
    events.sort_by_key(|e| e.ts);
    // Written whole and renamed into place: the file's presence is what says the backfill is done.
    let mut body = Vec::new();
    for event in &events {
        serde_json::to_writer(&mut body, event).map_err(|e| e.to_string())?;
        body.push(b'\n');
    }
    crate::profile::write_bytes(&marker, &body)
}

// --- Export -------------------------------------------------------------------------------------

/// What `reading_history_export` writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// Everything, as `{format, version, exportedAt, lines: [HistoryLine]}`.
    Json,
    /// One row per line, every field: for spreadsheets, scripts and other tools.
    Csv,
    /// exSTATic's lines CSV (`exSTATic_lines.csv`), which exSTATic and GSM import.
    ExstaticLines,
    /// exSTATic's stats CSV (`exSTATic_stats.csv`): per media and day, which names the media.
    ExstaticStats,
}

impl Format {
    pub fn parse(format: &str) -> Result<Self, String> {
        Ok(match format {
            "json" => Format::Json,
            "csv" => Format::Csv,
            "exstatic-lines" => Format::ExstaticLines,
            "exstatic-stats" => Format::ExstaticStats,
            other => return Err(format!("invalid: unknown export format {other}")),
        })
    }
}

/// `ms` (epoch) as local ISO 8601 with its offset, `tz` minutes east of UTC.
pub fn iso_local(ms: u64, tz: i32) -> String {
    let offset = time::UtcOffset::from_whole_seconds(tz * 60).unwrap_or(time::UtcOffset::UTC);
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH)
        .to_offset(offset);
    let (h, m) = (tz.abs() / 60, tz.abs() % 60);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}{}{:02}:{:02}",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond(),
        if tz < 0 { '-' } else { '+' },
        h,
        m
    )
}

/// One CSV field, quoted when it must be (RFC 4180).
fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn csv_row(fields: &[String]) -> String {
    let mut row = fields.iter().map(|f| csv_field(f)).collect::<Vec<_>>().join(",");
    row.push_str("\r\n");
    row
}

/// Our CSV's columns.
pub const CSV_HEADER: &[&str] = &[
    "uid",
    "timestamp",
    "time",
    "text",
    "chars",
    "session_id",
    "session_name",
    "via",
    "engine",
    "window",
    "app",
    "exe",
    "language",
    "original_text",
    "backfilled",
    "read_ms",
    "skipped",
];

fn csv(lines: &[HistoryLine]) -> String {
    let mut out = String::from("\u{feff}");
    out.push_str(&csv_row(&CSV_HEADER.iter().map(|h| (*h).to_string()).collect::<Vec<_>>()));
    for line in lines {
        let source = line.source.clone().unwrap_or_default();
        out.push_str(&csv_row(&[
            line.uid.clone(),
            line.ts.to_string(),
            iso_local(line.ts, line.tz),
            line.text.clone(),
            line.chars.to_string(),
            line.session.clone(),
            line.session_name.clone(),
            line.via.clone(),
            line.engine.clone().unwrap_or_default(),
            source.window.unwrap_or_default(),
            source.app.unwrap_or_default(),
            source.exe.unwrap_or_default(),
            line.language.clone().unwrap_or_default(),
            line.original_text.clone().unwrap_or_default(),
            if line.backfilled { "1".into() } else { String::new() },
            line.read_ms.to_string(),
            if line.skipped { "1".into() } else { String::new() },
        ]));
    }
    out
}

fn json_export(lines: &[HistoryLine]) -> Result<String, String> {
    serde_json::to_string_pretty(&json!({
        "format": "kimochi-reading-history",
        "version": 1,
        "exportedAt": now_ms(),
        "lines": lines,
    }))
    .map_err(|e| e.to_string())
}

/// `lines` in `format`.
/// `lines` in `format`, with days starting at `day_start_hour`.
pub fn render(lines: &[HistoryLine], format: Format, day_start_hour: i64) -> Result<String, String> {
    match format {
        Format::Json => json_export(lines),
        Format::Csv => Ok(csv(lines)),
        Format::ExstaticLines => Ok(exstatic_lines(lines)),
        Format::ExstaticStats => Ok(exstatic_stats(lines, day_start_hour)),
    }
}

// --- Reading time -------------------------------------------------------------------------------
//
// The rule every stat uses, as frontend/texthooker/lib/readingTime.ts explains it and implements it
// for the app; scripts/fixtures/reading-time.json holds the cases both are tested with. A line
// counts the time until the next, at most 2.5 x what a line its length takes at the session's
// slower pace (3 s a character before 5 lines are measured), between 2 s and the ceiling; three
// or more fast, long lines in a row were skipped; a day starts at 4 am.

const CAP_FACTOR: f64 = 2.5;
const CAP_FLOOR_MS: f64 = 2_000.0;
const FALLBACK_MS_PER_CHAR: f64 = 3_000.0;
const PACE_MIN_SAMPLES: usize = 5;
const PACE_MIN_CHARS: usize = 5;
const PACE_MIN_GAP_MS: u64 = 1_000;
const PACE_MAX_GAP_MS: u64 = 300_000;
const PACE_WINDOW: usize = 200;
const PACE_PERCENTILE: f64 = 0.25;
const SKIP_MIN_CHARS: usize = 12;
const SKIP_MAX_GAP_MS: u64 = 1_000;
const SKIP_MIN_RUN: usize = 3;
/// A reading day starts at this local hour.
pub const DAY_START_HOUR: i64 = 4;

/// A session's pace: characters a second of its recent measured lines.
#[derive(Default)]
struct Pace {
    samples: std::collections::VecDeque<f64>,
}

impl Pace {
    fn learn(&mut self, chars: usize, gap_ms: u64) {
        if chars < PACE_MIN_CHARS || !(PACE_MIN_GAP_MS..=PACE_MAX_GAP_MS).contains(&gap_ms) {
            return;
        }
        self.samples.push_back(chars as f64 / (gap_ms as f64 / 1000.0));
        if self.samples.len() > PACE_WINDOW {
            self.samples.pop_front();
        }
    }

    fn cap_ms(&self, chars: usize, ceiling_ms: u64) -> f64 {
        if chars == 0 {
            return 0.0;
        }
        let expected = if self.samples.len() >= PACE_MIN_SAMPLES {
            let mut sorted: Vec<f64> = self.samples.iter().copied().collect();
            sorted.sort_by(f64::total_cmp);
            let pace = sorted[(PACE_PERCENTILE * (sorted.len() - 1) as f64).floor() as usize];
            CAP_FACTOR * (chars as f64 / pace) * 1000.0
        } else {
            chars as f64 * FALLBACK_MS_PER_CHAR
        };
        expected.max(CAP_FLOOR_MS).min(ceiling_ms as f64)
    }
}

/// Which lines, `(ts, chars)` oldest first, were skipped.
fn skipped_lines(lines: &[(u64, usize)]) -> Vec<bool> {
    let mut skipped = vec![false; lines.len()];
    let mut start = 0;
    for i in 1..=lines.len() {
        let fast = i < lines.len()
            && lines[i].0.saturating_sub(lines[i - 1].0) < SKIP_MAX_GAP_MS
            && lines[i].1 >= SKIP_MIN_CHARS
            && lines[i - 1].1 >= SKIP_MIN_CHARS;
        if fast {
            continue;
        }
        if i - start >= SKIP_MIN_RUN {
            skipped[start..i].iter_mut().for_each(|s| *s = true);
        }
        start = i;
    }
    skipped
}

/// The time each line `(ts, chars, session)` (oldest first) counts, and whether it was skipped.
/// `skip_fast`: whether skipping counts nothing (`skipFastLines`).
pub fn credit(lines: &[(u64, usize, &str)], ceiling_ms: u64, skip_fast: bool) -> Vec<(u64, bool)> {
    let skipped = if skip_fast {
        skipped_lines(&lines.iter().map(|l| (l.0, l.1)).collect::<Vec<_>>())
    } else {
        vec![false; lines.len()]
    };
    let mut paces: HashMap<&str, Pace> = HashMap::new();
    (0..lines.len())
        .map(|i| {
            if skipped[i] {
                return (0, true);
            }
            let (ts, chars, session) = lines[i];
            let pace = paces.entry(session).or_default();
            let cap = pace.cap_ms(chars, ceiling_ms);
            let Some(next) = lines.get(i + 1) else { return (cap.round() as u64, false) };
            let gap = next.0.saturating_sub(ts);
            if !skipped[i + 1] {
                pace.learn(chars, gap);
            }
            ((gap as f64).min(cap).round() as u64, false)
        })
        .collect()
}

/// Fill in each line's `read_ms` and `skipped` by the rule above, with `ceiling_ms` the most one
/// line may count. `lines` must be oldest first.
pub fn with_read_time(lines: &mut [HistoryLine], ceiling_ms: u64, skip_fast: bool) {
    let timed: Vec<(u64, usize, &str)> = lines.iter().map(|l| (l.ts, l.chars, l.session.as_str())).collect();
    let credits = credit(&timed, ceiling_ms, skip_fast);
    for (line, (ms, skipped)) in lines.iter_mut().zip(credits) {
        line.read_ms = ms;
        line.skipped = skipped;
    }
}

/// The reading day of `ms` (epoch) read `tz` minutes east of UTC, `YYYY-MM-DD`: the local date
/// [`DAY_START_HOUR`] hours earlier.
pub fn reading_day(ms: u64, tz: i32, start_hour: i64) -> String {
    let shifted = (ms as i64 + i64::from(tz) * 60_000 - start_hour * 3_600_000).max(0) as u64;
    iso_local(shifted, 0)[..10].to_string()
}

/// Epoch ms as exSTATic's `time`: epoch seconds with a fraction.
fn epoch_seconds(ms: u64) -> String {
    format!("{}.{:03}", ms / 1000, ms % 1000)
}

/// What exSTATic calls a media item: `uuid` (the session's id; Kimochi's are UUIDs),
/// `given_identifier` (what it was read from: the hooked game's executable, else the session's
/// name; exSTATic uses the texthooker's process path) and `name`.
fn exstatic_media(lines: &[HistoryLine]) -> HashMap<String, (String, String)> {
    let mut media: HashMap<String, (String, String)> = HashMap::new();
    for line in lines {
        let exe = line.source.as_ref().and_then(|s| s.exe.clone()).filter(|e| !e.trim().is_empty());
        let entry = media.entry(line.session.clone()).or_insert_with(|| (String::new(), line.session_name.clone()));
        if entry.0.is_empty() {
            if let Some(exe) = exe {
                entry.0 = exe;
            }
        }
    }
    for (identifier, name) in media.values_mut() {
        if identifier.is_empty() {
            *identifier = name.clone();
        }
    }
    media
}

fn exstatic_uuid(session: &str) -> String {
    if session.is_empty() {
        "kimochi".into()
    } else {
        session.to_string()
    }
}

/// exSTATic's lines CSV: `uuid,given_identifier,name,line,time` (its `data_extraction.ts`).
fn exstatic_lines(lines: &[HistoryLine]) -> String {
    let media = exstatic_media(lines);
    let mut out = String::from("\u{feff}");
    out.push_str(&csv_row(&["uuid", "given_identifier", "name", "line", "time"].map(String::from)));
    for line in lines {
        let (identifier, name) = media.get(&line.session).cloned().unwrap_or_default();
        out.push_str(&csv_row(&[
            exstatic_uuid(&line.session),
            identifier,
            name,
            line.text.clone(),
            epoch_seconds(line.ts),
        ]));
    }
    out
}

/// `ms` (epoch) as the local date it was read, `YYYY-MM-DD`.
/// exSTATic's stats CSV: per media and reading day ([`reading_day`]), `client,uuid,name,given_identifier,type,date,
/// chars_read,lines_read,time_read,read_speed` (`chars_read` by [`count_chars`], `time_read` in
/// seconds, `read_speed` characters per second), skipped lines left out. Importing it names the media
/// the lines CSV fills. `lines` need [`with_read_time`].
fn exstatic_stats(lines: &[HistoryLine], day_start_hour: i64) -> String {
    let media = exstatic_media(lines);
    // Characters, lines and ms per (local date, session), in the order first read.
    type Day = ((String, String), (usize, usize, u64));
    let mut days: Vec<Day> = Vec::new();
    let mut index: HashMap<(String, String), usize> = HashMap::new();
    for line in lines.iter().filter(|l| !l.skipped) {
        let key = (reading_day(line.ts, line.tz, day_start_hour), line.session.clone());
        let at = *index.entry(key.clone()).or_insert_with(|| {
            days.push((key, (0, 0, 0)));
            days.len() - 1
        });
        let day = &mut days[at].1;
        day.0 += line.chars;
        day.1 += 1;
        day.2 += line.read_ms;
    }
    let mut out = String::from("\u{feff}");
    out.push_str(&csv_row(
        &[
            "client",
            "uuid",
            "name",
            "given_identifier",
            "type",
            "date",
            "chars_read",
            "lines_read",
            "time_read",
            "read_speed",
        ]
        .map(String::from),
    ));
    for ((date, session), (chars, count, ms)) in days {
        let (identifier, name) = media.get(&session).cloned().unwrap_or_default();
        let seconds = ms as f64 / 1000.0;
        let speed = if seconds > 0.0 { (chars as f64 / seconds).to_string() } else { String::new() };
        out.push_str(&csv_row(&[
            "kimochi".into(),
            exstatic_uuid(&session),
            name,
            identifier,
            "vn".into(),
            date,
            chars.to_string(),
            count.to_string(),
            format!("{seconds}"),
            speed,
        ]));
    }
    out
}

// --- Commands -----------------------------------------------------------------------------------

fn profile_dir() -> Result<PathBuf, String> {
    crate::account::active_profile_dir().ok_or_else(|| "unavailable: no profile is open".to_string())
}

/// The Log's lines read, for the history (frontend/texthooker/core/history.ts).
#[tauri::command]
pub async fn reading_history_append(events: Vec<Event>) -> Result<usize, String> {
    let dir = profile_dir()?;
    tauri::async_runtime::spawn_blocking(move || append(&dir, events)).await.map_err(|e| e.to_string())?
}

/// What the export can say before it is made: how many lines, from when to when.
#[tauri::command]
pub async fn reading_history_summary() -> Result<Value, String> {
    let dir = profile_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        let lines = lines(&dir);
        json!({
            "lines": lines.len(),
            "chars": lines.iter().map(|l| l.chars).sum::<usize>(),
            "first": lines.first().map(|l| l.ts),
            "last": lines.last().map(|l| l.ts),
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// `lines` as the Stats tab reads them: only those of `sessions` when given, each with only
/// `fields` (HistoryLine's camelCase names) when given, which keeps a long history's reply small.
pub fn select(lines: Vec<HistoryLine>, sessions: Option<&[String]>, fields: Option<&[String]>) -> Vec<Value> {
    let wanted: Option<std::collections::HashSet<&str>> = sessions.map(|s| s.iter().map(String::as_str).collect());
    lines
        .into_iter()
        .filter(|line| wanted.as_ref().is_none_or(|w| w.contains(line.session.as_str())))
        .map(|line| {
            let mut value = serde_json::to_value(line).unwrap_or(Value::Null);
            if let (Some(fields), Value::Object(map)) = (fields, &mut value) {
                map.retain(|key, _| fields.iter().any(|f| f == key));
            }
            value
        })
        .collect()
}

/// The lines read, oldest first, for the Stats tab: only `sessions`' when given, with only
/// `fields` when given.
#[tauri::command]
pub async fn reading_history_lines(
    sessions: Option<Vec<String>>,
    fields: Option<Vec<String>>,
) -> Result<Vec<Value>, String> {
    let dir = profile_dir()?;
    tauri::async_runtime::spawn_blocking(move || select(lines(&dir), sessions.as_deref(), fields.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

/// The idle limit when none is given: the Log's AFK threshold's default.
const DEFAULT_IDLE_SEC: u64 = 300;

/// `dir`'s history as `format`, with reading time counted up to `idle_sec` per line.
/// What the person chose for the reading stats (Settings → Log): the most one line may count, in
/// seconds; whether skipping counts nothing; the hour a day starts.
#[derive(Debug, Clone, Copy, Default)]
pub struct Rules {
    pub idle_sec: Option<u64>,
    pub skip_fast: Option<bool>,
    pub day_start_hour: Option<u8>,
}

pub fn export(dir: &Path, format: Format, rules: Rules) -> Result<(usize, String), String> {
    let mut lines = lines(dir);
    let ceiling_ms = rules.idle_sec.unwrap_or(DEFAULT_IDLE_SEC).clamp(10, 3600) * 1000;
    with_read_time(&mut lines, ceiling_ms, rules.skip_fast.unwrap_or(true));
    let day_start = rules.day_start_hour.map_or(DAY_START_HOUR, |h| i64::from(h.min(12)));
    Ok((lines.len(), render(&lines, format, day_start)?))
}

/// Write the history to `path` as `format` (`json`, `csv`, `exstatic-lines`, `exstatic-stats`),
/// counting at most `idleSec` (the AFK threshold) of reading time per line. Returns the lines
/// written.
#[tauri::command]
pub async fn reading_history_export(
    path: String,
    format: String,
    idle_sec: Option<u64>,
    skip_fast_lines: Option<bool>,
    day_start_hour: Option<u8>,
) -> Result<usize, String> {
    let format = Format::parse(&format)?;
    let dir = profile_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        let rules = Rules { idle_sec, skip_fast: skip_fast_lines, day_start_hour };
        let (count, body) = export(&dir, format, rules)?;
        std::fs::write(&path, body).map_err(|e| format!("Could not write {path}: {e}"))?;
        Ok(count)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kimochi-reading-history-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn add(uid: &str, ts: u64, text: &str) -> Event {
        Event {
            op: "add".into(),
            uid: uid.into(),
            at: ts,
            ts: Some(ts),
            text: Some(text.into()),
            via: Some("hook".into()),
            session: Some("s1".into()),
            session_name: Some("Game".into()),
            source: Some(Source { window: Some("ゲーム".into()), app: None, exe: Some("game.exe".into()) }),
            language: Some("ja".into()),
            tz: Some(540),
            ..Default::default()
        }
    }

    #[test]
    fn characters_are_counted_as_gsm_and_exstatic_count_them() {
        // The cases where the trackers are compared (Rubi's docs/ocr-history.md).
        for (text, count) in [
            ("「わたしは、見守る。」", 7),
            ("ABC abc!", 6),
            ("……", 0),
            ("♪", 0),
            ("！", 0),
            ("～", 0),
            ("ー", 1),
            ("１２３", 3),
            ("・", 0),
            ("〜", 0),
            ("😀", 0),
            ("𠮟る", 2),
            ("○○さん", 2),
            ("行こう\n明日", 5),
            ("ＡＢＣ１２３ abc!", 9),
        ] {
            assert_eq!(count_chars(text), count, "{text}");
        }
    }

    #[test]
    fn lines_are_selected_by_session_with_only_the_fields_asked_for() {
        let mut other = add("b", 2_000, "二行目");
        other.session = Some("s2".into());
        let lines = fold(vec![add("a", 1_000, "一行目"), other], &HashMap::new());
        let all = select(lines.clone(), None, None);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0]["text"], "一行目");
        assert_eq!(all[1]["sessionName"], "Game");
        let fields = ["ts".to_string(), "chars".to_string(), "session".to_string()];
        let some = select(lines, Some(&["s2".to_string()]), Some(&fields));
        assert_eq!(some, vec![json!({"ts": 2_000, "chars": 3, "session": "s2"})]);
    }

    #[test]
    fn lines_are_appended_kept_apart_from_the_log_and_folded_by_uid() {
        let dir = temp("append");
        // A Log line limit or clear does not reach this folder; only events do.
        let kept = append(
            &dir,
            vec![
                add("a", 1_000, "わたしは"),
                add("b", 2_000, "沈みゆく地球を。"),
                Event {
                    op: "edit".into(),
                    uid: "a".into(),
                    at: 3_000,
                    ts: Some(1_000),
                    text: Some("わたしは見守る。".into()),
                    original_text: Some("わたしは".into()),
                    ..add("a", 1_000, "")
                },
                add("c", 4_000, "誤読"),
                Event { op: "delete".into(), uid: "c".into(), at: 5_000, ..Default::default() },
                add("d", 6_000, "   "),
                Event { op: "bogus".into(), ..add("e", 7_000, "x") },
            ],
        )
        .unwrap();
        assert_eq!(kept, 5, "blank lines and unknown ops are not stored");
        let lines = lines(&dir);
        let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, ["わたしは見守る。", "沈みゆく地球を。"]);
        assert_eq!(lines[0].ts, 1_000, "an edit keeps when it was read");
        assert_eq!(lines[0].original_text.as_deref(), Some("わたしは"));
        assert_eq!(lines[0].chars, 7);
        assert_eq!(lines[0].source.as_ref().unwrap().exe.as_deref(), Some("game.exe"));
        // Stored a line per event, in a file per month of the event.
        let raw = std::fs::read_to_string(dir.join(DIR).join("1970-01.jsonl")).unwrap();
        assert_eq!(raw.lines().count(), 5);
        // A torn last write is passed over.
        std::fs::OpenOptions::new()
            .append(true)
            .open(dir.join(DIR).join("1970-01.jsonl"))
            .unwrap()
            .write_all(b"{\"op\":\"add")
            .unwrap();
        assert_eq!(super::lines(&dir).len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn existing_log_lines_are_backfilled_once() {
        let dir = temp("backfill");
        std::fs::create_dir_all(dir.join("sessions/s1")).unwrap();
        std::fs::create_dir_all(dir.join("sessions/s2")).unwrap();
        std::fs::write(
            dir.join("sessions.json"),
            r#"{"version":1,"activeId":"s1","sessions":[{"id":"s1","name":"Steins;Gate"},{"id":"s2","name":"Old"},{"id":"../x","name":"Bad"}]}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("sessions/s1/lines.json"),
            r#"{"version":1,"lines":[
                {"id":1,"uid":"u1","text":"スキャン","source":"ocr","ts":10,"ocr":{"engine":"meiki"}},
                {"id":2,"uid":"n1","text":"my note","source":"note","ts":20},
                {"id":3,"text":"古い行","source":"hook","ts":30}
            ],"deleted":[{"uid":"gone","at":5}]}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("sessions/s2/lines.json"),
            r#"{"version":1,"lines":[{"id":1,"uid":"u2","text":"二","source":"clipboard","ts":15}]}"#,
        )
        .unwrap();
        // The live record of a line also in the Log wins over the backfill's copy.
        append(&dir, vec![Event { session: Some("s1".into()), ..add("u1", 10, "スキャン") }]).unwrap();
        let lines = lines(&dir);
        let summary: Vec<(&str, &str, bool)> =
            lines.iter().map(|l| (l.text.as_str(), l.session_name.as_str(), l.backfilled)).collect();
        assert_eq!(summary, [("スキャン", "Steins;Gate", false), ("二", "Old", true), ("古い行", "Steins;Gate", true)]);
        let derived = crate::sync_core::derived_line_uid("s1", &json!({"id":3,"ts":30,"text":"古い行"}));
        assert_eq!(lines[2].uid, derived, "lines without a uid get the one Sync derives");
        assert_eq!(lines[0].via, "hook", "the live record");
        // Once: a line cleared from the Log afterwards stays in the history, and is not copied twice.
        std::fs::write(dir.join("sessions/s2/lines.json"), r#"{"version":1,"lines":[]}"#).unwrap();
        append(&dir, vec![]).unwrap();
        assert_eq!(super::lines(&dir).len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_profile_without_a_log_backfills_nothing() {
        let dir = temp("empty");
        assert!(lines(&dir).is_empty());
        assert!(dir.join(DIR).join(BACKFILL_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_renamed_session_exports_under_its_new_name() {
        let dir = temp("rename");
        append(&dir, vec![add("a", 1_000, "一")]).unwrap();
        std::fs::write(
            dir.join("sessions.json"),
            r#"{"version":1,"activeId":"s1","sessions":[{"id":"s1","name":"Renamed"}]}"#,
        )
        .unwrap();
        assert_eq!(lines(&dir)[0].session_name, "Renamed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reading_time_follows_the_rule_the_app_uses() {
        // The cases the app's own rule (frontend/texthooker/lib/readingTime.ts) is tested with.
        let fixture: Value = serde_json::from_str(include_str!("../../scripts/fixtures/reading-time.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let lines: Vec<(u64, usize, &str)> = case["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| {
                    (l["ts"].as_u64().unwrap(), l["chars"].as_u64().unwrap() as usize, l["session"].as_str().unwrap())
                })
                .collect();
            let expected: Vec<(u64, bool)> = case["credits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| (c["ms"].as_u64().unwrap(), c["skipped"].as_bool().unwrap()))
                .collect();
            let skip_fast = case["skipFast"].as_bool().unwrap_or(true);
            assert_eq!(credit(&lines, case["ceilingMs"].as_u64().unwrap(), skip_fast), expected, "{}", case["name"]);
        }
        for day in fixture["days"].as_array().unwrap() {
            let (ts, tz) = (day["ts"].as_u64().unwrap(), day["tz"].as_i64().unwrap() as i32);
            let start = day["startHour"].as_i64().unwrap_or(DAY_START_HOUR);
            assert_eq!(reading_day(ts, tz, start), day["day"].as_str().unwrap(), "{}", day["why"]);
        }
    }

    #[test]
    fn times_are_local_where_they_were_read() {
        assert_eq!(iso_local(0, 540), "1970-01-01T09:00:00.000+09:00");
        assert_eq!(iso_local(1_500, -330), "1969-12-31T18:30:01.500-05:30");
        assert_eq!(reading_day(15 * 3600 * 1000, 540, 4), "1970-01-01", "00:00 in Tokyo is the day before");
        assert_eq!(reading_day(20 * 3600 * 1000, 540, 4), "1970-01-02");
    }

    #[test]
    fn sync_chunks_are_small_and_only_the_last_of_an_hour_grows() {
        let hour = 3_600_000;
        let events: Vec<Event> = (0..120).map(|i| add(&format!("u{i}"), hour + i, "一")).collect();
        let sizes: Vec<(String, usize)> = chunks("", &events).into_iter().map(|(name, e)| (name, e.len())).collect();
        assert_eq!(
            sizes,
            [("1970010101.0".to_string(), 50), ("1970010101.1".to_string(), 50), ("1970010101.2".to_string(), 20)]
        );
        let mut more = events.clone();
        more.push(add("late", hour + 500, "二"));
        more.push(add("next", 2 * hour, "三"));
        let after = chunks("", &more);
        assert_eq!(after[..2], chunks("", &events)[..2], "full chunks never change");
        assert_eq!(after[2].1.len(), 21);
        assert_eq!(after[3].0, "1970010102.0");
        // Long lines fill a chunk by size before count.
        let long: Vec<Event> = (0..20).map(|i| add(&format!("l{i}"), hour, &"あ".repeat(TEXT_LIMIT))).collect();
        let pieces = chunks("b", &long);
        assert!(pieces.len() > 1 && pieces[0].0.starts_with("b1970010101."));
        assert!(pieces.iter().all(|(_, e)| serde_json::to_string(e).unwrap().len() <= CHUNK_BYTES));
    }

    #[test]
    fn another_computers_chunks_fold_in_and_never_go_back_as_ours() {
        let dir = temp("devices");
        append(&dir, vec![add("a", 1_000, "一")]).unwrap();
        let theirs = json!({ "events": [add("b", 2_000, "二"), Event { op: "delete".into(), uid: "a".into(), at: 3_000, ..Default::default() }] });
        write_synced(&dir, "other/1970010100.0", Some(&theirs)).unwrap();
        write_synced(&dir, "../evil/x", Some(&theirs)).unwrap();
        assert!(!dir.join(DIR).join("evil").exists());
        assert_eq!(lines(&dir).iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["二"]);
        let ids: Vec<String> = sync_records(&dir, "me").into_iter().map(|(id, _)| id).collect();
        assert_eq!(ids, ["me/1970010100.0", "other/1970010100.0"]);
        write_synced(&dir, "other/1970010100.0", None).unwrap();
        assert_eq!(lines(&dir).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn exported(format: Format) -> String {
        let names = HashMap::new();
        let mut lines = fold(
            vec![
                add("a", 1_731_650_000_123, "「わたしは、見守る。」"),
                add("b", 1_731_650_010_123, "彼は\"そう\"言った, 本当に"),
                Event {
                    session: Some("s2".into()),
                    session_name: Some("Book".into()),
                    source: None,
                    ..add("c", 1_731_740_000_000, "本")
                },
            ],
            &names,
        );
        with_read_time(&mut lines, 60_000, true);
        render(&lines, format, DAY_START_HOUR).unwrap()
    }

    #[test]
    fn the_exstatic_lines_csv_is_what_exstatic_and_gsm_import() {
        let csv = exported(Format::ExstaticLines);
        let rows: Vec<&str> = csv.trim_start_matches('\u{feff}').split("\r\n").collect();
        assert_eq!(rows[0], "uuid,given_identifier,name,line,time");
        assert_eq!(rows[1], "s1,game.exe,Game,「わたしは、見守る。」,1731650000.123");
        assert_eq!(rows[2], r#"s1,game.exe,Game,"彼は""そう""言った, 本当に",1731650010.123"#);
        assert_eq!(rows[3], "s2,Book,Book,本,1731740000.000", "no game: the session names it");
        assert!(csv.starts_with('\u{feff}'), "a BOM, as exSTATic writes");
    }

    #[test]
    fn the_exstatic_stats_csv_totals_each_media_by_local_day() {
        let csv = exported(Format::ExstaticStats);
        let rows: Vec<&str> = csv.trim_start_matches('\u{feff}').split("\r\n").collect();
        assert_eq!(rows[0], "client,uuid,name,given_identifier,type,date,chars_read,lines_read,time_read,read_speed");
        // 7 + 10 characters; 10 s to the next line, then a break: the line's 30 s (3 s a character).
        assert_eq!(rows[1], "kimochi,s1,Game,game.exe,vn,2024-11-15,17,2,40,0.425");
        assert_eq!(rows[2], "kimochi,s2,Book,Book,vn,2024-11-16,1,1,3,0.3333333333333333");
    }

    #[test]
    fn the_full_exports_carry_every_field() {
        let csv = exported(Format::Csv);
        let mut rows = csv.trim_start_matches('\u{feff}').split("\r\n");
        assert_eq!(rows.next().unwrap(), CSV_HEADER.join(","));
        assert_eq!(
            rows.next().unwrap(),
            "a,1731650000123,2024-11-15T14:53:20.123+09:00,「わたしは、見守る。」,7,s1,Game,hook,,ゲーム,,game.exe,ja,,,10000,"
        );
        let json: Value = serde_json::from_str(&exported(Format::Json)).unwrap();
        assert_eq!(json["format"], "kimochi-reading-history");
        assert_eq!(json["lines"][0]["text"], "「わたしは、見守る。」");
        assert_eq!(json["lines"][0]["source"]["exe"], "game.exe");
        assert_eq!(json["lines"][0]["readMs"], 10_000);
        assert_eq!(json["lines"].as_array().unwrap().len(), 3);
        assert!(Format::parse("xml").is_err());
    }
}
