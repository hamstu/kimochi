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
    /// Time spent on it, ms: until the next line, at most the idle limit ([`with_read_time`]).
    /// Worked out at export from the timestamps; 0 until then.
    pub read_ms: u64,
}

/// Characters read, the way reading trackers count them (exSTATic, GSM, ttu reader): letters and
/// digits of any script, so kana, kanji and full-width alphanumerics count and punctuation,
/// symbols and spaces do not. `text` itself is kept, so a different count can always be re-run.
pub fn count_chars(text: &str) -> usize {
    text.chars().filter(|c| c.is_alphanumeric()).count()
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

/// Every event in `dir`'s history, in the order recorded. A line that does not parse (a write cut
/// short) is passed over.
pub fn events(dir: &Path) -> Vec<Event> {
    let mut out = Vec::new();
    for path in files(dir) {
        let Ok(file) = std::fs::File::open(&path) else { continue };
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            if let Ok(event) = serde_json::from_str::<Event>(&line) {
                out.push(event);
            }
        }
    }
    out
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
pub fn render(lines: &[HistoryLine], format: Format) -> Result<String, String> {
    match format {
        Format::Json => json_export(lines),
        Format::Csv => Ok(csv(lines)),
        Format::ExstaticLines => Ok(exstatic_lines(lines)),
        Format::ExstaticStats => Ok(exstatic_stats(lines)),
    }
}

/// Fill in each line's `read_ms` the way the Log's footer counts reading time
/// (frontend/texthooker/core/stats.ts): the time to the next line read, at most `idle_ms`, and
/// `idle_ms` after the last line of a run. `lines` must be oldest first.
pub fn with_read_time(lines: &mut [HistoryLine], idle_ms: u64) {
    let next: Vec<Option<u64>> = (0..lines.len()).map(|i| lines.get(i + 1).map(|l| l.ts)).collect();
    for (line, next) in lines.iter_mut().zip(next) {
        line.read_ms = next.map_or(idle_ms, |next| next.saturating_sub(line.ts).min(idle_ms));
    }
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

/// exSTATic's character count (`charsInLine` in its `calculations.ts`): every character but its
/// list of Japanese and ASCII punctuation and spaces.
pub fn exstatic_chars(text: &str) -> usize {
    const IGNORE: &str =
        "〔〕《》〖〗〘〙〚〛【】「」［］『』｛｝[]()（）｟｠〈〉≪≫。、.,※＊'：！?？‥…―─ｰ〽～→♪♫♬♩\"　 \t\n";
    text.chars().filter(|c| !IGNORE.contains(*c)).count()
}

/// `ms` (epoch) as the local date it was read, `YYYY-MM-DD`.
fn local_date(ms: u64, tz: i32) -> String {
    iso_local(ms, tz)[..10].to_string()
}

/// exSTATic's stats CSV: per media and local day, `client,uuid,name,given_identifier,type,date,
/// chars_read,lines_read,time_read,read_speed` (`time_read` in seconds, `read_speed` characters
/// per second). Importing it names the media the lines CSV fills. `lines` need `read_ms`.
fn exstatic_stats(lines: &[HistoryLine]) -> String {
    let media = exstatic_media(lines);
    // Characters, lines and ms per (local date, session), in the order first read.
    type Day = ((String, String), (usize, usize, u64));
    let mut days: Vec<Day> = Vec::new();
    let mut index: HashMap<(String, String), usize> = HashMap::new();
    for line in lines {
        let key = (local_date(line.ts, line.tz), line.session.clone());
        let at = *index.entry(key.clone()).or_insert_with(|| {
            days.push((key, (0, 0, 0)));
            days.len() - 1
        });
        let day = &mut days[at].1;
        day.0 += exstatic_chars(&line.text);
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

/// The idle limit when none is given: the Log's AFK threshold's default.
const DEFAULT_IDLE_SEC: u64 = 60;

/// `dir`'s history as `format`, with reading time counted up to `idle_sec` per line.
pub fn export(dir: &Path, format: Format, idle_sec: Option<u64>) -> Result<(usize, String), String> {
    let mut lines = lines(dir);
    with_read_time(&mut lines, idle_sec.unwrap_or(DEFAULT_IDLE_SEC).clamp(10, 3600) * 1000);
    Ok((lines.len(), render(&lines, format)?))
}

/// Write the history to `path` as `format` (`json`, `csv`, `exstatic-lines`, `exstatic-stats`),
/// counting at most `idleSec` (the AFK threshold) of reading time per line. Returns the lines
/// written.
#[tauri::command]
pub async fn reading_history_export(path: String, format: String, idle_sec: Option<u64>) -> Result<usize, String> {
    let format = Format::parse(&format)?;
    let dir = profile_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        let (count, body) = export(&dir, format, idle_sec)?;
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
    fn characters_count_letters_and_digits_of_any_script() {
        assert_eq!(count_chars("「わたしは、見守る。」"), 7);
        assert_eq!(count_chars("ＡＢＣ１２３ abc!"), 9);
        assert_eq!(exstatic_chars("「わたしは、見守る。」"), 7);
        assert_eq!(exstatic_chars("♡あ"), 2, "exSTATic counts what its list leaves in");
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
    fn reading_time_is_the_gap_to_the_next_line_up_to_the_idle_limit() {
        let names = HashMap::new();
        let mut lines = fold(vec![add("a", 0, "一"), add("b", 10_000, "二"), add("c", 500_000, "三")], &names);
        with_read_time(&mut lines, 60_000);
        assert_eq!(lines.iter().map(|l| l.read_ms).collect::<Vec<_>>(), [10_000, 60_000, 60_000]);
    }

    #[test]
    fn times_are_local_where_they_were_read() {
        assert_eq!(iso_local(0, 540), "1970-01-01T09:00:00.000+09:00");
        assert_eq!(iso_local(1_500, -330), "1969-12-31T18:30:01.500-05:30");
        assert_eq!(local_date(15 * 3600 * 1000, 540), "1970-01-02");
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
        with_read_time(&mut lines, 60_000);
        render(&lines, format).unwrap()
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
        // 7 + 10 characters; 10 s to the next line, then the 60 s idle limit.
        assert_eq!(rows[1], "kimochi,s1,Game,game.exe,vn,2024-11-15,17,2,70,0.24285714285714285");
        assert!(rows[2].starts_with("kimochi,s2,Book,Book,vn,2024-11-16,1,1,60,"));
    }

    #[test]
    fn the_full_exports_carry_every_field() {
        let csv = exported(Format::Csv);
        let mut rows = csv.trim_start_matches('\u{feff}').split("\r\n");
        assert_eq!(rows.next().unwrap(), CSV_HEADER.join(","));
        assert_eq!(
            rows.next().unwrap(),
            "a,1731650000123,2024-11-15T14:53:20.123+09:00,「わたしは、見守る。」,7,s1,Game,hook,,ゲーム,,game.exe,ja,,,10000"
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
