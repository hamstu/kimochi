//! Sync's logic, independent of Tauri so it can be tested against an in-memory server and, in
//! the ignored end-to-end test, against a real one.
//!
//! **Records.** A profile's data is cut into records `(collection, id) → JSON`:
//! `prefs` (one per settings leaf, `profile::flatten`), `sessions` (one per session),
//! `lines` (`<sid>/<uid>`, one per line, keyed by a uid that is unique across computers),
//! `notebook` (`<sid>/<entryId>`, images as content-addressed blobs), `presets` (by name),
//! `stats` (one per computer, never merged), `conflicts` (the losing side of a concurrent edit).
//!
//! **State** (`<profile>/sync/state.json`): the server cursor, and for every record the server
//! `rev` and content hash this computer last agreed with (the *shadow*). A record whose local hash
//! differs from its shadow was changed here; it is stamped with a hybrid logical clock (`pending`)
//! when first noticed, so an edit made offline keeps the time it was made.
//!
//! **A cycle**: notice local changes → pull everything after the cursor → merge it into the files
//! (while the Log window holds its writes, see `Host`) → push what differs from the shadow, each
//! record with the `rev` it was based on. The server refuses a stale base (a concurrent edit); the
//! next round pulls that record and merges it:
//! - only one side changed → that side's version;
//! - both changed → the newer clock wins (ties: device id), and the loser is kept as a
//!   `conflicts` record the person can restore — never silently dropped. Lines merge field by
//!   field (a translation added on one computer and an explanation on another both stay); only a
//!   different text is a conflict;
//! - an edit and a delete → the edit wins;
//! - the first sync of a record (no shadow): preferences and presets take the account's version;
//!   sessions and notebook entries the one changed last.
//!
//! Deletes travel as tombstones. A line counts as deleted only when the Log recorded deleting it
//! (`lines.json`'s `deleted`), never because the Log's line limit trimmed it. A deleted session's
//! folder is moved to `sync/trash/` rather than removed.
use crate::profile;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// The shadow hash of a tombstone.
pub const TOMB: &str = "-";
pub const PUSH_BATCH: usize = 200;
pub const PULL_PAGE: u32 = 500;
/// Host-owned collections: changing their files needs the Log window to hold its writes.
const HOST_COLLECTIONS: &[&str] = &["sessions", "lines", "notebook", "presets"];
const TRASH_DAYS: u64 = 30;

pub fn key(collection: &str, id: &str) -> String {
    format!("{collection}\t{id}")
}

pub fn split_key(key: &str) -> (&str, &str) {
    key.split_once('\t').unwrap_or((key, ""))
}

/// JSON with object keys sorted at every level, so equal data hashes equally.
pub fn canonical(value: &Value) -> String {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                let mut out = Map::new();
                for k in keys {
                    out.insert(k.clone(), sorted(&map[k]));
                }
                Value::Object(out)
            }
            Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    serde_json::to_string(&sorted(value)).unwrap_or_default()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hash(value: &Value) -> String {
    sha256_hex(canonical(value).as_bytes())[..16].to_string()
}

/// FNV-1a, 64-bit: the uid a line written before uids existed is given, here and in the Log
/// (`frontend/texthooker/core/store.ts`), from what identifies it in its session.
pub fn fnv64(text: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

pub fn derived_line_uid(sid: &str, line: &Value) -> String {
    let id = line.get("id").map(Value::to_string).unwrap_or_default();
    let ts = line.get("ts").map(Value::to_string).unwrap_or_default();
    let text = line.get("text").and_then(Value::as_str).unwrap_or("");
    format!("l{:016x}", fnv64(&format!("{sid}\n{id}\n{ts}\n{text}")))
}

/// A folder or file name Sync will write: `[A-Za-z0-9._-]`, not `.`/`..`.
pub fn safe_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && s != "."
        && s != ".."
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

// ---------------------------------------------------------------- clock

/// A hybrid logical clock: wall-clock milliseconds, a counter for events in the same
/// millisecond (or when the wall clock is behind a clock already seen), and the device id. The
/// fixed-width string form sorts in clock order, ties broken by device id.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Clock {
    pub ms: u64,
    pub counter: u32,
}

impl Clock {
    pub fn tick(&mut self, now: u64, device: &str) -> String {
        if now > self.ms {
            self.ms = now;
            self.counter = 0;
        } else {
            self.counter += 1;
        }
        format!("{:013}.{:05}.{device}", self.ms, self.counter)
    }

    pub fn observe(&mut self, stamp: &str) {
        let mut parts = stamp.splitn(3, '.');
        let ms = parts.next().and_then(|p| p.parse::<u64>().ok());
        let counter = parts.next().and_then(|p| p.parse::<u32>().ok());
        if let (Some(ms), Some(counter)) = (ms, counter) {
            if (ms, counter) > (self.ms, self.counter) {
                self.ms = ms;
                self.counter = counter;
            }
        }
    }
}

// ---------------------------------------------------------------- state

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct State {
    #[serde(default)]
    pub version: u32,
    /// The server's `rev` up to which every change has been merged here.
    #[serde(default)]
    pub cursor: u64,
    /// key → (server rev, hash) this computer last agreed with the server on.
    #[serde(default)]
    pub shadow: BTreeMap<String, (u64, String)>,
    /// key → (hash, clock) of a local change not yet accepted by the server.
    #[serde(default)]
    pub pending: BTreeMap<String, (String, String)>,
    #[serde(default)]
    pub clock: Clock,
    /// The last known metadata of every session, to restore one deleted here that another
    /// computer kept adding to.
    #[serde(default)]
    pub sessions: BTreeMap<String, Value>,
    #[serde(default)]
    pub last_sync_at: Option<u64>,
    #[serde(default)]
    pub last_error: Option<String>,
    /// How this profile started: `copied-local`, `server`, `empty` (see `sync.rs`).
    #[serde(default)]
    pub origin: Option<String>,
}

pub fn state_path(dir: &Path) -> PathBuf {
    dir.join("sync").join("state.json")
}

pub fn load_state(dir: &Path) -> State {
    profile::read_json(&state_path(dir))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn save_state(dir: &Path, state: &State) -> Result<(), String> {
    let bytes = serde_json::to_vec(state).map_err(|e| e.to_string())?;
    profile::write_bytes(&state_path(dir), &bytes)
}

pub fn conflicts_path(dir: &Path) -> PathBuf {
    dir.join("sync").join("conflicts.json")
}

pub fn load_conflicts(dir: &Path) -> Option<BTreeMap<String, Value>> {
    let path = conflicts_path(dir);
    if !path.exists() {
        return Some(BTreeMap::new());
    }
    profile::read_json(&path).and_then(|v| serde_json::from_value(v).ok())
}

// ---------------------------------------------------------------- server

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRecord {
    pub collection: String,
    pub id: String,
    pub rev: u64,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub data: Value,
    #[serde(default)]
    pub hlc: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct ChangesPage {
    pub changes: Vec<RemoteRecord>,
    pub cursor: u64,
    #[serde(default)]
    pub more: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PushRecord {
    pub collection: String,
    pub id: String,
    pub base_rev: u64,
    pub deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    pub hlc: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Accepted {
    pub collection: String,
    pub id: String,
    pub rev: u64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct PushConflict {
    pub collection: String,
    pub id: String,
    /// The server's record; `null` when it has none (the base named a record it no longer has).
    #[serde(default)]
    pub current: Option<Value>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct PushResult {
    #[serde(default)]
    pub accepted: Vec<Accepted>,
    #[serde(default)]
    pub conflicts: Vec<PushConflict>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct Status {
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub records: u64,
    #[serde(default)]
    pub used: u64,
    #[serde(default)]
    pub limit: Option<u64>,
}

pub trait Remote {
    fn status(&self) -> Result<Status, String>;
    fn changes(&self, since: u64, limit: u32) -> Result<ChangesPage, String>;
    fn push(&self, device_id: &str, records: &[PushRecord]) -> Result<PushResult, String>;
    fn blobs_missing(&self, hashes: &[String]) -> Result<Vec<String>, String>;
    fn blob_put(&self, sha: &str, bytes: Vec<u8>, content_type: &str) -> Result<(), String>;
    fn blob_get(&self, sha: &str) -> Result<Vec<u8>, String>;
}

/// The profile's preferences: the live settings for the profile in use, its
/// `profile-settings.json` otherwise.
pub trait Prefs {
    fn document(&self) -> Value;
    /// Set (`Some`) or remove (`None`) each path.
    fn apply(&mut self, changes: &[(Vec<String>, Option<Value>)]) -> Result<(), String>;
}

/// The Log window, which owns the profile's files while it runs: `hold` flushes its pending
/// writes and pauses them; `release` lets it reload what changed and carry on.
pub trait Host {
    fn hold(&self) -> Result<(), String>;
    fn release(&self, changed: &Changed);
}

/// No Log window attached (a profile not in use, tests).
pub struct NoHost;
impl Host for NoHost {
    fn hold(&self) -> Result<(), String> {
        Ok(())
    }
    fn release(&self, _: &Changed) {}
}

/// What a merge changed on disk, for the Log to reload.
#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Changed {
    pub sessions: bool,
    pub lines: BTreeSet<String>,
    pub notebook: BTreeSet<String>,
    pub presets: bool,
}

/// A profile's preferences kept in its `profile-settings.json` while it is not in use.
pub struct FilePrefs {
    pub path: PathBuf,
    pub doc: Value,
}

impl FilePrefs {
    pub fn open(path: PathBuf, fallback: Value) -> Self {
        let doc = profile::read_json(&path).filter(Value::is_object).unwrap_or(fallback);
        Self { path, doc }
    }
}

impl Prefs for FilePrefs {
    fn document(&self) -> Value {
        self.doc.clone()
    }
    fn apply(&mut self, changes: &[(Vec<String>, Option<Value>)]) -> Result<(), String> {
        for (path, value) in changes {
            set_path(&mut self.doc, path, value.clone());
        }
        profile::write_json(&self.path, &self.doc)
    }
}

pub fn set_path(doc: &mut Value, path: &[String], value: Option<Value>) {
    if path.is_empty() {
        return;
    }
    if !doc.is_object() {
        *doc = json!({});
    }
    let mut cursor = doc;
    for part in &path[..path.len() - 1] {
        if !cursor.get(part).is_some_and(Value::is_object) {
            cursor[part.as_str()] = json!({});
        }
        cursor = cursor.get_mut(part.as_str()).expect("just inserted");
    }
    let leaf = path[path.len() - 1].as_str();
    match value {
        Some(value) => cursor[leaf] = value,
        None => {
            if let Some(map) = cursor.as_object_mut() {
                map.remove(leaf);
            }
        }
    }
}

// ---------------------------------------------------------------- reading the profile

/// Parsed files by modification time and size, and image hashes, so a quiet cycle reads nothing.
#[derive(Default)]
pub struct ScanCache {
    files: HashMap<PathBuf, (SystemTime, u64, Option<Value>)>,
    shas: HashMap<PathBuf, (SystemTime, u64, String)>,
}

fn stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

impl ScanCache {
    fn json(&mut self, path: &Path) -> Option<Value> {
        let Some((modified, len)) = stamp(path) else {
            self.files.remove(path);
            return None;
        };
        if let Some((m, l, value)) = self.files.get(path) {
            if *m == modified && *l == len {
                return value.clone();
            }
        }
        let value = profile::read_json(path);
        self.files.insert(path.to_path_buf(), (modified, len, value.clone()));
        value
    }

    fn sha(&mut self, path: &Path) -> Option<String> {
        let (modified, len) = stamp(path)?;
        if let Some((m, l, sha)) = self.shas.get(path) {
            if *m == modified && *l == len {
                return Some(sha.clone());
            }
        }
        let sha = sha256_hex(&std::fs::read(path).ok()?);
        self.shas.insert(path.to_path_buf(), (modified, len, sha.clone()));
        Some(sha)
    }
}

/// The profile as records, plus what is needed to tell a delete from an absence.
#[derive(Default, Debug)]
pub struct Local {
    pub records: BTreeMap<String, Value>,
    /// Lines the Log recorded deleting.
    pub line_tombstones: HashSet<String>,
    pub manifest_ok: bool,
    pub sids: HashSet<String>,
    pub lines_ok: HashSet<String>,
    pub notebook_ok: HashSet<String>,
    pub presets_ok: bool,
    pub conflicts_ok: bool,
    /// Image blobs by SHA-256: the file holding each.
    pub images: HashMap<String, PathBuf>,
}

const LINE_FIELDS: &[&str] = &["text", "source", "ts", "ocr", "translation", "showTranslation", "explanation"];

pub fn line_record(sid: &str, uid: &str, line: &Value) -> Value {
    let mut data = Map::new();
    data.insert("sid".into(), json!(sid));
    data.insert("uid".into(), json!(uid));
    for field in LINE_FIELDS {
        if let Some(value) = line.get(*field).filter(|v| !v.is_null()) {
            data.insert((*field).into(), value.clone());
        }
    }
    Value::Object(data)
}

fn session_record(session: &Value) -> Value {
    json!({
        "name": session.get("name").cloned().unwrap_or(json!("")),
        "description": session.get("description").cloned().unwrap_or(json!("")),
        "createdAt": session.get("createdAt").cloned().unwrap_or(json!(0)),
        "updatedAt": session.get("updatedAt").cloned().unwrap_or(json!(0)),
    })
}

/// `sessions/<sid>/images/<name>` with safe parts, or None.
fn image_path_ok(sid: &str, path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    matches!(parts.as_slice(), ["sessions", s, "images", name] if *s == sid && safe_segment(name))
}

pub fn scan(dir: &Path, prefs: &Value, device_id: &str, device_name: &str, cache: &mut ScanCache) -> Local {
    let mut local = Local::default();
    for (path, value) in profile::flatten(&profile::synced_part(prefs)) {
        local.records.insert(key("prefs", &path), value);
    }
    if let Some(manifest) = cache.json(&dir.join("sessions.json")) {
        if let Some(sessions) = manifest.get("sessions").and_then(Value::as_array) {
            local.manifest_ok = true;
            for session in sessions {
                let Some(sid) = session.get("id").and_then(Value::as_str) else { continue };
                if !safe_segment(sid) {
                    continue;
                }
                local.sids.insert(sid.to_string());
                local.records.insert(key("sessions", sid), session_record(session));
            }
        }
    }
    let sids: Vec<String> = local.sids.iter().cloned().collect();
    for sid in sids {
        let session_dir = dir.join("sessions").join(&sid);
        let lines_file = session_dir.join("lines.json");
        let lines = if lines_file.exists() { cache.json(&lines_file) } else { Some(json!({ "lines": [] })) };
        if let Some(lines) = lines.filter(|l| l.get("lines").is_some_and(Value::is_array)) {
            local.lines_ok.insert(sid.clone());
            for line in lines["lines"].as_array().into_iter().flatten() {
                let Some(text) = line.get("text").and_then(Value::as_str) else { continue };
                if text.trim().is_empty() {
                    continue;
                }
                let uid = line
                    .get("uid")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| derived_line_uid(&sid, line));
                local.records.insert(key("lines", &format!("{sid}/{uid}")), line_record(&sid, &uid, line));
            }
            for gone in lines.get("deleted").and_then(Value::as_array).into_iter().flatten() {
                if let Some(uid) = gone.get("uid").and_then(Value::as_str) {
                    local.line_tombstones.insert(key("lines", &format!("{sid}/{uid}")));
                }
            }
        }
        let notebook_file = session_dir.join("notebook.json");
        let notebook = if notebook_file.exists() { cache.json(&notebook_file) } else { Some(json!({ "entries": [] })) };
        if let Some(notebook) = notebook.filter(|n| n.get("entries").is_some_and(Value::is_array)) {
            local.notebook_ok.insert(sid.clone());
            for entry in notebook["entries"].as_array().into_iter().flatten() {
                let Some(id) = entry.get("id").and_then(Value::as_str) else { continue };
                let mut entry = entry.clone();
                if let Some(images) = entry.get_mut("images").and_then(Value::as_array_mut) {
                    for image in images.iter_mut() {
                        let path = image.get("path").and_then(Value::as_str).unwrap_or("").to_string();
                        let sha = if image_path_ok(&sid, &path) { cache.sha(&dir.join(&path)) } else { None };
                        if let Some(map) = image.as_object_mut() {
                            map.remove("sha256");
                            if let Some(sha) = sha {
                                local.images.insert(sha.clone(), dir.join(&path));
                                map.insert("sha256".into(), json!(sha));
                            }
                        }
                    }
                }
                local.records.insert(key("notebook", &format!("{sid}/{id}")), json!({ "sid": sid, "entry": entry }));
            }
        }
    }
    if let Some(presets) = cache.json(&dir.join("presets.json")) {
        if let Some(map) = presets.get("presets").and_then(Value::as_object) {
            local.presets_ok = true;
            for (name, preset) in map {
                local.records.insert(key("presets", name), profile::strip_private(preset));
            }
        }
    }
    if let Some(stats) = cache.json(&dir.join("stats.json")) {
        let mut data = Map::new();
        for field in ["totalChars", "totalLines", "totalMs", "lastUpdateTs"] {
            data.insert(field.into(), stats.get(field).cloned().unwrap_or(json!(0)));
        }
        data.insert("deviceName".into(), json!(device_name));
        local.records.insert(key("stats", device_id), Value::Object(data));
    }
    if let Some(conflicts) = load_conflicts(dir) {
        local.conflicts_ok = true;
        for (id, data) in conflicts {
            local.records.insert(key("conflicts", &id), data);
        }
    }
    local
}

/// What this computer has for a record.
#[derive(Debug, Clone, PartialEq)]
pub enum Side {
    Live(Value),
    /// Deleted here (the Log recorded it, or its container is readable and lacks it).
    Deleted,
    /// Not here, for a reason that is not a delete (a line the Log's limit trimmed, an unreadable
    /// file): neither pushed nor treated as changed.
    Absent,
}

fn line_sid(id: &str) -> &str {
    id.split_once('/').map(|(sid, _)| sid).unwrap_or("")
}

pub fn side(local: &Local, k: &str) -> Side {
    if let Some(value) = local.records.get(k) {
        return Side::Live(value.clone());
    }
    let (collection, id) = split_key(k);
    let session_gone = |sid: &str| local.manifest_ok && !local.sids.contains(sid);
    let deleted = match collection {
        "prefs" => true,
        "sessions" => local.manifest_ok,
        "lines" => local.line_tombstones.contains(k) || session_gone(line_sid(id)),
        "notebook" => local.notebook_ok.contains(line_sid(id)) || session_gone(line_sid(id)),
        "presets" => local.presets_ok,
        "conflicts" => local.conflicts_ok,
        _ => false,
    };
    if deleted {
        Side::Deleted
    } else {
        Side::Absent
    }
}

// ---------------------------------------------------------------- writes

/// Changes to make to the profile's files, by record.
#[derive(Default, Debug)]
pub struct Writes {
    pub prefs: Vec<(Vec<String>, Option<Value>)>,
    pub sessions: BTreeMap<String, Option<Value>>,
    pub lines: BTreeMap<String, BTreeMap<String, Option<Value>>>,
    pub notebook: BTreeMap<String, BTreeMap<String, Option<Value>>>,
    pub presets: BTreeMap<String, Option<Value>>,
    pub conflicts: BTreeMap<String, Option<Value>>,
}

impl Writes {
    pub fn is_empty(&self) -> bool {
        self.prefs.is_empty()
            && self.sessions.is_empty()
            && self.lines.is_empty()
            && self.notebook.is_empty()
            && self.presets.is_empty()
            && self.conflicts.is_empty()
    }

    fn needs_host(&self) -> bool {
        !(self.sessions.is_empty() && self.lines.is_empty() && self.notebook.is_empty() && self.presets.is_empty())
    }

    /// Record `data` (None: delete) for `k`, and reflect it in `local`.
    pub fn put(&mut self, local: &mut Local, k: &str, data: Option<Value>) {
        let (collection, id) = split_key(k);
        let (collection, id) = (collection.to_string(), id.to_string());
        match &data {
            Some(value) => {
                local.records.insert(k.to_string(), value.clone());
            }
            None => {
                local.records.remove(k);
            }
        }
        match collection.as_str() {
            "prefs" => self.prefs.push((profile::split_path(&id), data)),
            "sessions" => {
                if data.is_some() {
                    local.sids.insert(id.clone());
                } else {
                    local.sids.remove(&id);
                }
                self.sessions.insert(id, data);
            }
            "lines" | "notebook" => {
                let Some((sid, item)) = id.split_once('/') else { return };
                if data.is_some() && !local.sids.contains(sid) {
                    local.sids.insert(sid.to_string());
                }
                let target = if collection == "lines" { &mut self.lines } else { &mut self.notebook };
                target.entry(sid.to_string()).or_default().insert(item.to_string(), data);
            }
            "presets" => {
                self.presets.insert(id, data);
            }
            "conflicts" => {
                self.conflicts.insert(id, data);
            }
            _ => {}
        }
    }
}

fn read_or(path: &Path, fallback: Value) -> Value {
    profile::read_json(path).unwrap_or(fallback)
}

fn new_session(name: &str, now: u64) -> (String, Value) {
    let sid = random_id("s");
    (sid.clone(), json!({ "id": sid, "name": name, "description": "", "createdAt": now, "updatedAt": now }))
}

/// A random-enough id without a dependency: hashed time, process and a counter.
pub fn random_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seed = format!("{nanos}:{}:{}:{:p}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst), &COUNTER);
    format!("{prefix}{}", &sha256_hex(seed.as_bytes())[..24])
}

fn ensure_session_files(dir: &Path, sid: &str) -> Result<(), String> {
    let session = dir.join("sessions").join(sid);
    std::fs::create_dir_all(session.join("images")).map_err(|e| e.to_string())?;
    if !session.join("lines.json").exists() {
        profile::write_json(&session.join("lines.json"), &json!({ "version": 1, "lines": [] }))?;
    }
    if !session.join("notebook.json").exists() {
        profile::write_json(&session.join("notebook.json"), &json!({ "version": 2, "cacheVersion": 0, "entries": [] }))?;
    }
    Ok(())
}

fn ts_of(value: &Value) -> f64 {
    value.get("ts").and_then(Value::as_f64).unwrap_or(0.0)
}

/// Put `writes` in the profile's files. Images named by incoming notebook entries are downloaded
/// first (`blob`), so a failure leaves the files untouched.
pub fn apply_writes(
    dir: &Path,
    writes: &Writes,
    prefs: &mut dyn Prefs,
    known_sessions: &BTreeMap<String, Value>,
    blob: &dyn Fn(&str) -> Result<Vec<u8>, String>,
    now: u64,
) -> Result<Changed, String> {
    let mut changed = Changed::default();
    // Images first: nothing is written if one cannot be fetched.
    let mut images: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    for (sid, entries) in &writes.notebook {
        for data in entries.values().flatten() {
            for image in data["entry"]["images"].as_array().into_iter().flatten() {
                let (Some(path), Some(sha)) = (image["path"].as_str(), image["sha256"].as_str()) else { continue };
                if !image_path_ok(sid, path) {
                    continue;
                }
                let file = dir.join(path);
                if file.exists() && std::fs::read(&file).map(|b| sha256_hex(&b) == sha).unwrap_or(false) {
                    continue;
                }
                let bytes = blob(sha)?;
                if sha256_hex(&bytes) != sha {
                    return Err(format!("native: an image ({sha}) did not download intact"));
                }
                images.push((file, bytes));
            }
        }
    }
    for (file, bytes) in images {
        profile::write_bytes(&file, &bytes)?;
    }

    if !writes.prefs.is_empty() {
        prefs.apply(&writes.prefs)?;
    }

    // Sessions: the manifest, with placeholders for sessions known only through their lines.
    let manifest_path = dir.join("sessions.json");
    let touches_sessions = !writes.sessions.is_empty() || !writes.lines.is_empty() || !writes.notebook.is_empty();
    let mut manifest = read_or(&manifest_path, json!({ "version": 1, "activeId": "", "sessions": [] }));
    if touches_sessions {
        if !manifest.get("sessions").is_some_and(Value::is_array) {
            manifest["sessions"] = json!([]);
        }
        let mut manifest_changed = false;
        let mut wanted: Vec<(String, Option<Value>)> = writes
            .sessions
            .iter()
            .filter(|(sid, _)| safe_segment(sid))
            .map(|(sid, data)| (sid.clone(), data.clone()))
            .collect();
        for sid in writes.lines.keys().chain(writes.notebook.keys()) {
            let live = writes
                .lines
                .get(sid)
                .into_iter()
                .chain(writes.notebook.get(sid))
                .any(|items| items.values().any(Option::is_some));
            if live && !writes.sessions.contains_key(sid) && safe_segment(sid) {
                let present = manifest["sessions"].as_array().is_some_and(|s| s.iter().any(|x| x["id"] == json!(sid)));
                if !present {
                    let meta = known_sessions.get(sid).cloned().unwrap_or_else(|| {
                        json!({ "name": "Synced session", "description": "", "createdAt": now, "updatedAt": now })
                    });
                    wanted.push((sid.clone(), Some(meta)));
                }
            }
        }
        let mut deleted = Vec::new();
        for (sid, data) in &wanted {
            let sessions = manifest["sessions"].as_array_mut().expect("array");
            let index = sessions.iter().position(|s| s["id"] == json!(sid));
            match (data, index) {
                (Some(data), Some(i)) => {
                    for field in ["name", "description", "createdAt", "updatedAt"] {
                        if let Some(v) = data.get(field) {
                            sessions[i][field] = v.clone();
                        }
                    }
                    ensure_session_files(dir, sid)?;
                    manifest_changed = true;
                }
                (Some(data), None) => {
                    let mut meta = session_record(data);
                    meta["id"] = json!(sid);
                    sessions.push(meta);
                    ensure_session_files(dir, sid)?;
                    manifest_changed = true;
                }
                (None, Some(i)) => {
                    sessions.remove(i);
                    deleted.push(sid.clone());
                    manifest_changed = true;
                }
                (None, None) => {}
            }
        }
        let sessions = manifest["sessions"].as_array_mut().expect("array");
        if sessions.is_empty() {
            let (sid, meta) = new_session("Session", now);
            sessions.push(meta);
            ensure_session_files(dir, &sid)?;
        }
        let active = manifest["activeId"].as_str().unwrap_or("").to_string();
        if !manifest["sessions"].as_array().expect("array").iter().any(|s| s["id"] == json!(active)) {
            manifest["activeId"] = manifest["sessions"][0]["id"].clone();
        }
        if manifest_changed {
            if manifest.get("version").is_none() {
                manifest["version"] = json!(1);
            }
            profile::write_json(&manifest_path, &manifest)?;
            changed.sessions = true;
        }
        // A deleted session's folder goes to the trash, not away.
        for sid in deleted {
            let from = dir.join("sessions").join(&sid);
            if from.exists() {
                let trash = dir.join("sync").join("trash");
                std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
                std::fs::rename(&from, trash.join(format!("{sid}-{now}"))).map_err(|e| e.to_string())?;
            }
        }
    }
    let live_sids: HashSet<String> = manifest["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s["id"].as_str().map(str::to_string))
        .collect();

    for (sid, items) in &writes.lines {
        if !live_sids.contains(sid) {
            continue;
        }
        let path = dir.join("sessions").join(sid).join("lines.json");
        let mut file = read_or(&path, json!({ "version": 1, "lines": [] }));
        if !file.get("lines").is_some_and(Value::is_array) {
            return Err(format!("native: sessions/{sid}/lines.json is unreadable; it was left as it is"));
        }
        let lines = file["lines"].as_array_mut().expect("array");
        // Give every line its uid, so the ones derived here stay the same once written.
        for line in lines.iter_mut() {
            if line.get("uid").and_then(Value::as_str).is_none() && line.is_object() {
                let uid = derived_line_uid(sid, line);
                line["uid"] = json!(uid);
            }
        }
        let mut next_id = lines.iter().filter_map(|l| l["id"].as_u64()).max().unwrap_or(0) + 1;
        for (uid, data) in items {
            let index = lines.iter().position(|l| l["uid"] == json!(uid));
            match (data, index) {
                (Some(data), Some(i)) => {
                    let line = &mut lines[i];
                    for field in LINE_FIELDS {
                        match data.get(*field) {
                            Some(v) => line[*field] = v.clone(),
                            None => {
                                if let Some(map) = line.as_object_mut() {
                                    map.remove(*field);
                                }
                            }
                        }
                    }
                }
                (Some(data), None) => {
                    let mut line = Map::new();
                    line.insert("id".into(), json!(next_id));
                    next_id += 1;
                    line.insert("uid".into(), json!(uid));
                    for field in LINE_FIELDS {
                        if let Some(v) = data.get(*field) {
                            line.insert((*field).into(), v.clone());
                        }
                    }
                    let line = Value::Object(line);
                    let ts = ts_of(&line);
                    let at = lines.iter().rposition(|l| ts_of(l) <= ts).map(|i| i + 1).unwrap_or(0);
                    lines.insert(at, line);
                }
                (None, Some(i)) => {
                    lines.remove(i);
                }
                (None, None) => {}
            }
        }
        profile::write_json(&path, &file)?;
        changed.lines.insert(sid.clone());
    }

    for (sid, items) in &writes.notebook {
        if !live_sids.contains(sid) {
            continue;
        }
        let path = dir.join("sessions").join(sid).join("notebook.json");
        let mut file = read_or(&path, json!({ "version": 2, "cacheVersion": 0, "entries": [] }));
        if !file.get("entries").is_some_and(Value::is_array) {
            return Err(format!("native: sessions/{sid}/notebook.json is unreadable; it was left as it is"));
        }
        let entries = file["entries"].as_array_mut().expect("array");
        for (id, data) in items {
            let index = entries.iter().position(|e| e["id"] == json!(id));
            let entry = data.as_ref().map(|d| {
                let mut entry = d["entry"].clone();
                if let Some(images) = entry.get_mut("images").and_then(Value::as_array_mut) {
                    images.retain(|i| i["path"].as_str().is_some_and(|p| image_path_ok(sid, p)));
                    for image in images.iter_mut() {
                        if let Some(map) = image.as_object_mut() {
                            map.remove("sha256");
                        }
                    }
                }
                entry["id"] = json!(id);
                entry
            });
            match (entry, index) {
                (Some(entry), Some(i)) => entries[i] = entry,
                (Some(entry), None) => entries.push(entry),
                (None, Some(i)) => {
                    entries.remove(i);
                }
                (None, None) => {}
            }
        }
        let version = file["cacheVersion"].as_u64().unwrap_or(0) + 1;
        file["cacheVersion"] = json!(version);
        if file.get("version").is_none() {
            file["version"] = json!(2);
        }
        profile::write_json(&path, &file)?;
        changed.notebook.insert(sid.clone());
    }

    if !writes.presets.is_empty() {
        let path = dir.join("presets.json");
        let mut file = read_or(&path, json!({ "version": 1, "active": "", "presets": {} }));
        if !file.get("presets").is_some_and(Value::is_object) {
            file["presets"] = json!({});
        }
        let presets = file["presets"].as_object_mut().expect("object");
        for (name, data) in &writes.presets {
            match data {
                Some(data) => {
                    let mut data = data.clone();
                    if let Some(local) = presets.get(name) {
                        profile::keep_private(local, &mut data);
                    }
                    presets.insert(name.clone(), data);
                }
                // The Log always keeps one preset.
                None if presets.len() > 1 => {
                    presets.remove(name);
                }
                None => {}
            }
        }
        let first = presets.keys().next().cloned().unwrap_or_default();
        let active = file["active"].as_str().unwrap_or("").to_string();
        if !file["presets"].as_object().expect("object").contains_key(&active) {
            file["active"] = json!(first);
        }
        profile::write_json(&path, &file)?;
        changed.presets = true;
    }

    if !writes.conflicts.is_empty() {
        let mut conflicts = load_conflicts(dir).unwrap_or_default();
        for (id, data) in &writes.conflicts {
            match data {
                Some(data) => conflicts.insert(id.clone(), data.clone()),
                None => conflicts.remove(id),
            };
        }
        profile::write_json(&conflicts_path(dir), &serde_json::to_value(conflicts).map_err(|e| e.to_string())?)?;
    }
    Ok(changed)
}

/// Drop trashed sessions older than thirty days.
pub fn empty_trash(dir: &Path, now: u64) {
    let Ok(entries) = std::fs::read_dir(dir.join("sync").join("trash")) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let at = name.rsplit('-').next().and_then(|t| t.parse::<u64>().ok()).unwrap_or(now);
        if now.saturating_sub(at) > TRASH_DAYS * 86_400_000 {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

// ---------------------------------------------------------------- a cycle

pub struct Ctx<'a> {
    pub dir: &'a Path,
    pub device_id: &'a str,
    pub device_name: &'a str,
    pub remote: &'a dyn Remote,
    pub host: &'a dyn Host,
    pub prefs: &'a mut dyn Prefs,
    pub cache: &'a mut ScanCache,
    pub state: &'a mut State,
    pub log: &'a dyn Fn(&str, String),
    pub now: &'a dyn Fn() -> u64,
}

#[derive(Default, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub pulled: usize,
    pub applied: usize,
    pub pushed: usize,
    pub conflicts: usize,
    pub refused: usize,
}

fn describe(k: &str) -> String {
    let (collection, id) = split_key(k);
    match collection {
        "prefs" => format!("setting {}", profile::split_path(id).join(".")),
        "sessions" => format!("session {id}"),
        "lines" => format!("line {id}"),
        "notebook" => format!("notebook entry {id}"),
        "presets" => format!("preset \"{id}\""),
        "stats" => format!("reading stats of {id}"),
        "conflicts" => format!("conflict copy {id}"),
        _ => format!("{collection} {id}"),
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(max).collect::<String>())
    }
}

fn updated_at(collection: &str, data: &Value) -> Option<f64> {
    match collection {
        "sessions" => data.get("updatedAt")?.as_f64(),
        "notebook" => data.get("entry")?.get("updatedAt")?.as_f64(),
        _ => None,
    }
}

/// Note local changes: every record that differs from its shadow gets a clock stamp the first
/// time its current content is seen.
pub fn stamp_pending(ctx: &mut Ctx, local: &Local) {
    let keys: BTreeSet<String> = local.records.keys().chain(ctx.state.shadow.keys()).cloned().collect();
    let now = (ctx.now)();
    for k in keys {
        let current = match side(local, &k) {
            Side::Live(value) => hash(&value),
            Side::Deleted => TOMB.to_string(),
            Side::Absent => continue,
        };
        let shadow = ctx.state.shadow.get(&k).map(|s| s.1.as_str());
        if shadow == Some(current.as_str()) || (shadow.is_none() && current == TOMB) {
            ctx.state.pending.remove(&k);
            continue;
        }
        if ctx.state.pending.get(&k).map(|p| p.0.as_str()) != Some(current.as_str()) {
            let stamp = ctx.state.clock.tick(now, ctx.device_id);
            ctx.state.pending.insert(k, (current, stamp));
        }
    }
}

fn local_stamp(ctx: &mut Ctx, k: &str) -> String {
    if let Some((_, stamp)) = ctx.state.pending.get(k) {
        return stamp.clone();
    }
    let now = (ctx.now)();
    ctx.state.clock.tick(now, ctx.device_id)
}

#[allow(clippy::too_many_arguments)]
fn conflict_copy(ctx: &mut Ctx, writes: &mut Writes, local: &mut Local, k: &str, loser: &Value, loser_stamp: &str, loser_device: &str, winner_stamp: &str) {
    let (collection, id) = split_key(k);
    if collection == "conflicts" || collection == "stats" {
        return;
    }
    let conflict_id = format!("{collection}/{id}@{loser_stamp}");
    let data = json!({
        "collection": collection,
        "recordId": id,
        "deleted": false,
        "data": loser,
        "hlc": loser_stamp,
        "deviceId": loser_device,
        "winnerHlc": winner_stamp,
        "detectedAt": (ctx.now)(),
    });
    writes.put(local, &key("conflicts", &conflict_id), Some(data));
}

/// Merge pulled records into the files. Returns how many records changed something here.
fn merge_remote(ctx: &mut Ctx, local: &mut Local, remote: &[RemoteRecord], report: &mut Report) -> Result<(), String> {
    let mut writes = Writes::default();
    let mut latest: BTreeMap<String, &RemoteRecord> = BTreeMap::new();
    for record in remote {
        latest.insert(key(&record.collection, &record.id), record);
    }
    // Sessions first, so lines and entries land in sessions that exist.
    let mut order: Vec<(&String, &&RemoteRecord)> = latest.iter().collect();
    order.sort_by_key(|(_, r)| (r.collection != "sessions", r.rev));
    for (k, r) in order {
        let k = k.as_str();
        ctx.state.clock.observe(&r.hlc);
        let shadow = ctx.state.shadow.get(k).cloned();
        if shadow.as_ref().is_some_and(|s| s.0 >= r.rev) {
            continue; // our own change coming back, or one already merged
        }
        let collection = r.collection.as_str();
        let foreign_pref = collection == "prefs" && {
            let path = profile::split_path(&r.id);
            path.iter().any(|p| p.is_empty() || profile::is_private(p))
                || profile::is_machine_key(&path[0])
                || profile::PROFILE_LOCAL_KEYS.contains(&path[0].as_str())
        };
        if foreign_pref || !HOST_COLLECTIONS.iter().chain(&["prefs", "stats", "conflicts"]).any(|c| *c == collection) {
            // A setting this computer keeps to itself, or a collection this version does not know.
            ctx.state.shadow.insert(k.to_string(), (r.rev, if r.deleted { TOMB.into() } else { hash(&r.data) }));
            continue;
        }
        if collection == "stats" && r.id == ctx.device_id {
            ctx.state.shadow.insert(k.to_string(), (r.rev, if r.deleted { TOMB.into() } else { hash(&r.data) }));
            continue;
        }
        let remote_hash = if r.deleted { TOMB.to_string() } else { hash(&r.data) };
        let here = side(local, k);
        let here_hash = match &here {
            Side::Live(v) => Some(hash(v)),
            Side::Deleted => Some(TOMB.to_string()),
            Side::Absent => None,
        };
        let changed_here = match (&here, &shadow) {
            (Side::Absent, _) => false,
            (Side::Deleted, None) => false,
            (_, None) => true,
            (_, Some(s)) => here_hash.as_deref() != Some(s.1.as_str()),
        };
        if collection == "stats" {
            // Another computer's reading totals: kept on the server, not merged into ours.
            ctx.state.shadow.insert(k.to_string(), (r.rev, remote_hash));
            continue;
        }
        if !changed_here || here_hash.as_deref() == Some(remote_hash.as_str()) {
            let differs = here_hash.as_deref() != Some(remote_hash.as_str());
            if differs {
                match (&here, r.deleted) {
                    (Side::Live(_), true) => {
                        writes.put(local, k, None);
                        (ctx.log)("pull", format!("Deleted {} (deleted on another computer)", describe(k)));
                        report.applied += 1;
                    }
                    (_, true) => {}
                    (_, false) => {
                        writes.put(local, k, Some(r.data.clone()));
                        report.applied += 1;
                    }
                }
            }
            ctx.state.shadow.insert(k.to_string(), (r.rev, remote_hash));
            ctx.state.pending.remove(k);
            continue;
        }
        // Changed on both sides.
        let first = shadow.is_none();
        match (&here, r.deleted) {
            (Side::Live(_), true) => {
                (ctx.log)("merge", format!("Kept {}: edited here while another computer deleted it", describe(k)));
                ctx.state.shadow.insert(k.to_string(), (r.rev, TOMB.into()));
            }
            (Side::Deleted, false) => {
                (ctx.log)("merge", format!("Restored {}: deleted here while another computer edited it", describe(k)));
                writes.put(local, k, Some(r.data.clone()));
                ctx.state.shadow.insert(k.to_string(), (r.rev, remote_hash));
                ctx.state.pending.remove(k);
                report.applied += 1;
            }
            (Side::Deleted, true) | (Side::Absent, _) => {
                ctx.state.shadow.insert(k.to_string(), (r.rev, remote_hash));
                ctx.state.pending.remove(k);
            }
            (Side::Live(mine), false) => {
                let mine = mine.clone();
                let my_stamp = local_stamp(ctx, k);
                if collection == "prefs" && first {
                    (ctx.log)(
                        "merge",
                        format!(
                            "Using the account's {} = {} (this computer had {})",
                            describe(k),
                            clip(&r.data.to_string(), 120),
                            clip(&mine.to_string(), 120)
                        ),
                    );
                    writes.put(local, k, Some(r.data.clone()));
                    ctx.state.pending.remove(k);
                } else if collection == "lines" {
                    let remote_wins = first || r.hlc.as_str() > my_stamp.as_str();
                    let (winner, loser) = if remote_wins { (&r.data, &mine) } else { (&mine, &r.data) };
                    let mut merged = winner.clone();
                    if let (Some(out), Some(loser_map)) = (merged.as_object_mut(), loser.as_object()) {
                        for (field, value) in loser_map {
                            out.entry(field.clone()).or_insert_with(|| value.clone());
                        }
                    }
                    if winner.get("text") != loser.get("text") {
                        let (loser_stamp, loser_device) = if remote_wins {
                            (my_stamp.clone(), ctx.device_id.to_string())
                        } else {
                            (r.hlc.clone(), r.device_id.clone())
                        };
                        let winner_stamp = if remote_wins { r.hlc.clone() } else { my_stamp.clone() };
                        conflict_copy(ctx, &mut writes, local, k, loser, &loser_stamp, &loser_device, &winner_stamp);
                        report.conflicts += 1;
                        (ctx.log)("conflict", format!("{} was edited on two computers; kept the newer text, the other is in Conflicts", describe(k)));
                    } else {
                        (ctx.log)("merge", format!("Merged {} field by field", describe(k)));
                    }
                    if merged != mine {
                        writes.put(local, k, Some(merged));
                        report.applied += 1;
                    }
                } else {
                    let remote_wins = if first && collection == "presets" {
                        true
                    } else if first {
                        match (updated_at(collection, &r.data), updated_at(collection, &mine)) {
                            (Some(theirs), Some(ours)) if theirs != ours => theirs > ours,
                            _ => true,
                        }
                    } else {
                        r.hlc.as_str() > my_stamp.as_str()
                    };
                    if remote_wins {
                        conflict_copy(ctx, &mut writes, local, k, &mine, &my_stamp, ctx.device_id, &r.hlc);
                        writes.put(local, k, Some(r.data.clone()));
                        ctx.state.pending.remove(k);
                        report.applied += 1;
                    } else {
                        conflict_copy(ctx, &mut writes, local, k, &r.data, &r.hlc, &r.device_id, &my_stamp);
                    }
                    report.conflicts += 1;
                    (ctx.log)(
                        "conflict",
                        format!(
                            "{} changed on two computers; kept {} version, the other is in Conflicts",
                            describe(k),
                            if remote_wins { "the other computer's" } else { "this computer's" }
                        ),
                    );
                }
                ctx.state.shadow.insert(k.to_string(), (r.rev, remote_hash));
            }
        }
    }
    if writes.is_empty() {
        return Ok(());
    }
    let needs_host = writes.needs_host();
    let now = (ctx.now)();
    let remote_api = ctx.remote;
    let changed = apply_writes(ctx.dir, &writes, ctx.prefs, &ctx.state.sessions, &|sha| remote_api.blob_get(sha), now)?;
    if needs_host {
        ctx.host.release(&changed);
    }
    Ok(())
}

/// Upload the image blobs that `records` name and the server lacks.
fn upload_blobs(ctx: &Ctx, local: &Local, records: &[PushRecord]) -> Result<(), String> {
    let mut wanted: Vec<String> = Vec::new();
    for record in records.iter().filter(|r| r.collection == "notebook") {
        let Some(data) = &record.data else { continue };
        for image in data["entry"]["images"].as_array().into_iter().flatten() {
            if let Some(sha) = image["sha256"].as_str() {
                if !wanted.iter().any(|w| w == sha) {
                    wanted.push(sha.to_string());
                }
            }
        }
    }
    for chunk in wanted.chunks(500) {
        for sha in ctx.remote.blobs_missing(chunk)? {
            let Some(file) = local.images.get(&sha) else { continue };
            let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
            if sha256_hex(&bytes) != sha {
                continue; // changed since the scan; the next cycle sends it
            }
            let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            let content_type = match ext.as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                "avif" => "image/avif",
                "bmp" => "image/bmp",
                _ => "application/octet-stream",
            };
            ctx.remote.blob_put(&sha, bytes, content_type)?;
            (ctx.log)("push", format!("Uploaded an image ({sha:.12}…)"));
        }
    }
    Ok(())
}

/// The records that differ from their shadow, ready to push.
pub fn outgoing(ctx: &mut Ctx, local: &Local) -> Vec<PushRecord> {
    let keys: BTreeSet<String> = local.records.keys().chain(ctx.state.shadow.keys()).cloned().collect();
    let mut out = Vec::new();
    for k in keys {
        let shadow = ctx.state.shadow.get(&k).cloned();
        let (collection, id) = split_key(&k);
        let (collection, id) = (collection.to_string(), id.to_string());
        if collection == "stats" && id != ctx.device_id {
            continue;
        }
        let record = match side(local, &k) {
            Side::Live(value) => {
                if shadow.as_ref().is_some_and(|s| s.1 == hash(&value)) {
                    continue;
                }
                PushRecord {
                    collection,
                    id,
                    base_rev: shadow.map(|s| s.0).unwrap_or(0),
                    deleted: false,
                    data: Some(value),
                    hlc: String::new(),
                }
            }
            Side::Deleted => match shadow {
                Some(s) if s.1 != TOMB => PushRecord { collection, id, base_rev: s.0, deleted: true, data: None, hlc: String::new() },
                _ => continue,
            },
            Side::Absent => continue,
        };
        let stamp = local_stamp(ctx, &k);
        out.push(PushRecord { hlc: stamp, ..record });
    }
    // Sessions before what they hold; deletes of a session after its contents.
    out.sort_by_key(|r| match (r.collection.as_str(), r.deleted) {
        ("sessions", false) => 0,
        ("sessions", true) => 2,
        _ => 1,
    });
    out
}

fn remember_sessions(state: &mut State, local: &Local) {
    for (k, data) in &local.records {
        let (collection, id) = split_key(k);
        if collection == "sessions" {
            state.sessions.insert(id.to_string(), data.clone());
        }
    }
}

/// One sync: notice, pull, merge, push, until nothing is refused (at most three rounds).
pub fn sync_once(ctx: &mut Ctx) -> Result<Report, String> {
    let mut report = Report::default();
    let prefs_doc = ctx.prefs.document();
    let mut local = scan(ctx.dir, &prefs_doc, ctx.device_id, ctx.device_name, ctx.cache);
    stamp_pending(ctx, &local);
    remember_sessions(ctx.state, &local);
    empty_trash(ctx.dir, (ctx.now)());
    for round in 0..3 {
        // Pull.
        let mut pulled: Vec<RemoteRecord> = Vec::new();
        let mut cursor = ctx.state.cursor;
        loop {
            let page = ctx.remote.changes(cursor, PULL_PAGE)?;
            let more = page.more && page.cursor > cursor;
            cursor = page.cursor.max(cursor);
            pulled.extend(page.changes);
            if !more || pulled.len() >= 20_000 {
                break;
            }
        }
        report.pulled += pulled.len();
        let fresh: Vec<RemoteRecord> = pulled
            .into_iter()
            .filter(|r| ctx.state.shadow.get(&key(&r.collection, &r.id)).is_none_or(|s| s.0 < r.rev))
            .collect();
        if !fresh.is_empty() {
            let host_files = fresh.iter().any(|r| HOST_COLLECTIONS.contains(&r.collection.as_str()));
            if host_files {
                ctx.host.hold()?;
                // The Log has flushed: read the files as they are now.
                let prefs_doc = ctx.prefs.document();
                local = scan(ctx.dir, &prefs_doc, ctx.device_id, ctx.device_name, ctx.cache);
                stamp_pending(ctx, &local);
            }
            let merged = merge_remote(ctx, &mut local, &fresh, &mut report);
            if host_files && merged.is_err() {
                ctx.host.release(&Changed::default());
            }
            merged?;
            // Only after the merge reached the files: a failure pulls the same changes again.
            let prefs_doc = ctx.prefs.document();
            local = scan(ctx.dir, &prefs_doc, ctx.device_id, ctx.device_name, ctx.cache);
            stamp_pending(ctx, &local);
            remember_sessions(ctx.state, &local);
        }
        ctx.state.cursor = cursor;

        // Push.
        let outgoing = outgoing(ctx, &local);
        if outgoing.is_empty() {
            break;
        }
        let mut refused = 0;
        for batch in outgoing.chunks(PUSH_BATCH) {
            upload_blobs(ctx, &local, batch)?;
            let result = ctx.remote.push(ctx.device_id, batch)?;
            for accepted in &result.accepted {
                let k = key(&accepted.collection, &accepted.id);
                let Some(sent) = batch.iter().find(|r| r.collection == accepted.collection && r.id == accepted.id) else { continue };
                let sent_hash = if sent.deleted { TOMB.to_string() } else { sent.data.as_ref().map(hash).unwrap_or_default() };
                ctx.state.shadow.insert(k.clone(), (accepted.rev, sent_hash));
                if ctx.state.pending.get(&k).is_some_and(|p| p.1 == sent.hlc) {
                    ctx.state.pending.remove(&k);
                }
            }
            report.pushed += result.accepted.len();
            refused += result.conflicts.len();
            for conflict in &result.conflicts {
                let k = key(&conflict.collection, &conflict.id);
                if conflict.current.as_ref().is_none_or(Value::is_null) {
                    // The server no longer has it (its data was erased): send it again as new.
                    ctx.state.shadow.remove(&k);
                    (ctx.log)("push", format!("The server no longer has {}; sending it again", describe(&k)));
                } else {
                    (ctx.log)("push", format!("The server has a newer {}; merging it", describe(&k)));
                }
            }
        }
        report.refused += refused;
        if refused == 0 {
            break;
        }
        if round == 2 {
            (ctx.log)("push", format!("{refused} change(s) still differ from the server; trying again next time"));
        }
    }
    ctx.state.last_sync_at = Some((ctx.now)());
    ctx.state.last_error = None;
    Ok(report)
}

/// Put a conflict's kept version back (it then syncs as a new change) and drop the conflict.
pub fn restore_conflict(dir: &Path, prefs: &mut dyn Prefs, host: &dyn Host, state: &State, id: &str, now: u64) -> Result<String, String> {
    let conflicts = load_conflicts(dir).ok_or("native: the conflicts file is unreadable")?;
    let conflict = conflicts.get(id).cloned().ok_or("invalid: that conflict is already resolved")?;
    let collection = conflict["collection"].as_str().unwrap_or("").to_string();
    let record_id = conflict["recordId"].as_str().unwrap_or("").to_string();
    let data = conflict["data"].clone();
    let k = key(&collection, &record_id);
    let mut local = Local::default();
    let mut writes = Writes::default();
    writes.put(&mut local, &k, Some(data));
    writes.put(&mut local, &key("conflicts", id), None);
    let needs_host = writes.needs_host();
    if needs_host {
        host.hold()?;
    }
    let result = apply_writes(dir, &writes, prefs, &state.sessions, &|_| Err("native: the image is no longer available".into()), now);
    if needs_host {
        host.release(result.as_ref().unwrap_or(&Changed::default()));
    }
    result?;
    Ok(describe(&k))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// The server's rules (kimochi-server `src/sync.ts`), in memory.
    #[derive(Default)]
    pub struct MemServer {
        pub seq: Cell<u64>,
        pub records: RefCell<BTreeMap<(String, String), RemoteRecord>>,
        pub blobs: RefCell<HashMap<String, Vec<u8>>>,
        pub offline: Cell<bool>,
    }

    impl Remote for MemServer {
        fn status(&self) -> Result<Status, String> {
            Ok(Status { seq: self.seq.get(), records: self.records.borrow().values().filter(|r| !r.deleted).count() as u64, ..Default::default() })
        }
        fn changes(&self, since: u64, limit: u32) -> Result<ChangesPage, String> {
            if self.offline.get() {
                return Err("offline".into());
            }
            let mut all: Vec<RemoteRecord> = self.records.borrow().values().filter(|r| r.rev > since).cloned().collect();
            all.sort_by_key(|r| r.rev);
            let more = all.len() > limit as usize;
            all.truncate(limit as usize);
            let cursor = all.last().map(|r| r.rev).unwrap_or(since);
            Ok(ChangesPage { changes: all, cursor, more })
        }
        fn push(&self, device_id: &str, records: &[PushRecord]) -> Result<PushResult, String> {
            if self.offline.get() {
                return Err("offline".into());
            }
            let mut result = PushResult::default();
            let mut store = self.records.borrow_mut();
            for r in records {
                let id = (r.collection.clone(), r.id.clone());
                let current = store.get(&id).map(|c| c.rev).unwrap_or(0);
                if current != r.base_rev {
                    result.conflicts.push(PushConflict { collection: r.collection.clone(), id: r.id.clone(), current: store.get(&id).map(|c| json!({ "rev": c.rev })) });
                    continue;
                }
                self.seq.set(self.seq.get() + 1);
                let rev = self.seq.get();
                store.insert(
                    id,
                    RemoteRecord {
                        collection: r.collection.clone(),
                        id: r.id.clone(),
                        rev,
                        deleted: r.deleted,
                        data: r.data.clone().unwrap_or(Value::Null),
                        hlc: r.hlc.clone(),
                        device_id: device_id.into(),
                        updated_at: String::new(),
                    },
                );
                result.accepted.push(Accepted { collection: r.collection.clone(), id: r.id.clone(), rev });
            }
            Ok(result)
        }
        fn blobs_missing(&self, hashes: &[String]) -> Result<Vec<String>, String> {
            Ok(hashes.iter().filter(|h| !self.blobs.borrow().contains_key(*h)).cloned().collect())
        }
        fn blob_put(&self, sha: &str, bytes: Vec<u8>, _: &str) -> Result<(), String> {
            self.blobs.borrow_mut().insert(sha.into(), bytes);
            Ok(())
        }
        fn blob_get(&self, sha: &str) -> Result<Vec<u8>, String> {
            self.blobs.borrow().get(sha).cloned().ok_or_else(|| "missing".into())
        }
    }

    /// One computer: a profile folder, its preferences and its sync state.
    pub struct Device {
        pub id: String,
        pub dir: PathBuf,
        pub prefs: FilePrefs,
        pub state: State,
        pub cache: ScanCache,
        pub clock: Cell<u64>,
        pub log: RefCell<Vec<String>>,
    }

    impl Device {
        pub fn new(id: &str, tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("kimochi-sync-{tag}-{id}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let prefs = FilePrefs { path: dir.join("prefs.json"), doc: json!({ "appearance": "light" }) };
            Self { id: id.into(), dir, prefs, state: State::default(), cache: ScanCache::default(), clock: Cell::new(1_000_000), log: RefCell::new(Vec::new()) }
        }

        pub fn sync(&mut self, server: &dyn Remote) -> Report {
            self.clock.set(self.clock.get() + 1000);
            let clock = &self.clock;
            let now = move || clock.get();
            let log = |kind: &str, text: String| self.log.borrow_mut().push(format!("{kind}: {text}"));
            let mut ctx = Ctx {
                dir: &self.dir,
                device_id: &self.id,
                device_name: &self.id,
                remote: server,
                host: &NoHost,
                prefs: &mut self.prefs,
                cache: &mut self.cache,
                state: &mut self.state,
                log: &log,
                now: &now,
            };
            sync_once(&mut ctx).unwrap()
        }

        pub fn write(&self, path: &str, value: Value) {
            profile::write_json(&self.dir.join(path), &value).unwrap();
            // A cache keyed on mtime could miss a write within the same tick; drop it.
        }

        pub fn read(&self, path: &str) -> Value {
            profile::read_json(&self.dir.join(path)).unwrap_or(Value::Null)
        }

        pub fn lines(&self, sid: &str) -> Vec<Value> {
            self.read(&format!("sessions/{sid}/lines.json"))["lines"].as_array().cloned().unwrap_or_default()
        }

        pub fn texts(&self, sid: &str) -> Vec<String> {
            self.lines(sid).iter().map(|l| l["text"].as_str().unwrap_or("").to_string()).collect()
        }

        pub fn session(&self, sid: &str, name: &str, lines: Value) {
            let mut manifest = self.read("sessions.json");
            if manifest.is_null() {
                manifest = json!({ "version": 1, "activeId": sid, "sessions": [] });
            }
            let sessions = manifest["sessions"].as_array_mut().unwrap();
            sessions.retain(|s| s["id"] != json!(sid));
            sessions.push(json!({ "id": sid, "name": name, "description": "", "createdAt": 1, "updatedAt": 1 }));
            self.write("sessions.json", manifest);
            self.write(&format!("sessions/{sid}/lines.json"), json!({ "version": 1, "lines": lines }));
        }

        pub fn conflicts(&self) -> BTreeMap<String, Value> {
            load_conflicts(&self.dir).unwrap()
        }

        fn touch(&mut self) {
            self.cache = ScanCache::default();
        }
    }

    impl Drop for Device {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn line(id: u64, uid: &str, text: &str, ts: u64) -> Value {
        json!({ "id": id, "uid": uid, "text": text, "source": "ocr", "ts": ts })
    }

    #[test]
    fn two_computers_union_their_lines() {
        let server = MemServer::default();
        let mut a = Device::new("A", "union");
        let mut b = Device::new("B", "union");
        a.session("s1", "Novel", json!([line(1, "ua1", "一", 10), line(2, "ua2", "二", 30)]));
        a.sync(&server);
        // B has its own line numbered 1 in the same session: a clash of numbers, not of lines.
        b.session("s1", "Novel", json!([line(1, "ub1", "三", 20)]));
        b.sync(&server);
        a.touch();
        a.sync(&server);
        assert_eq!(a.texts("s1"), ["一", "三", "二"], "ordered by time");
        assert_eq!(b.texts("s1"), ["一", "三", "二"]);
        let ids: HashSet<u64> = b.lines("s1").iter().map(|l| l["id"].as_u64().unwrap()).collect();
        assert_eq!(ids.len(), 3, "incoming lines are renumbered: {:?}", b.lines("s1"));
        assert!(a.conflicts().is_empty() && b.conflicts().is_empty());
    }

    #[test]
    fn lines_without_uids_get_the_same_uid_everywhere() {
        let sid = "s1";
        let l = json!({ "id": 7, "text": "猫", "ts": 1700000000000u64, "source": "ocr" });
        assert_eq!(derived_line_uid(sid, &l), derived_line_uid(sid, &l.clone()));
        // The Log computes the same: FNV-1a 64 of "s1\n7\n1700000000000\n猫".
        assert_eq!(derived_line_uid(sid, &l), format!("l{:016x}", fnv64("s1\n7\n1700000000000\n猫")));
        assert_eq!(fnv64(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv64("a"), 0xaf63_dc4c_8601_ec8c);
        // The same vector `scripts/texthooker-integration.test.mjs` checks against the Log's copy.
        assert_eq!(derived_line_uid(sid, &l), "lac08c75e3214c5be");
    }

    #[test]
    fn a_concurrent_edit_keeps_the_newer_and_saves_the_other() {
        let server = MemServer::default();
        let mut a = Device::new("A", "conflict");
        let mut b = Device::new("B", "conflict");
        a.session("s1", "Original", json!([]));
        a.sync(&server);
        b.sync(&server);
        // Both rename the session while apart; B's rename is later.
        let mut manifest = a.read("sessions.json");
        manifest["sessions"][0]["name"] = json!("Renamed on A");
        a.write("sessions.json", manifest);
        a.touch();
        a.sync(&server);
        let mut manifest = b.read("sessions.json");
        manifest["sessions"][0]["name"] = json!("Renamed on B");
        b.write("sessions.json", manifest);
        b.touch();
        b.clock.set(a.clock.get() + 50_000);
        b.sync(&server);
        a.touch();
        a.sync(&server);
        assert_eq!(a.read("sessions.json")["sessions"][0]["name"], "Renamed on B");
        assert_eq!(b.read("sessions.json")["sessions"][0]["name"], "Renamed on B");
        let conflicts = a.conflicts();
        assert_eq!(conflicts.len(), 1, "{conflicts:?}");
        let kept = conflicts.values().next().unwrap();
        assert_eq!(kept["data"]["name"], "Renamed on A");
        assert_eq!(b.conflicts().len(), 1, "B learns of the conflict through the server");

        // Restoring the loser makes it the current version everywhere.
        let id = conflicts.keys().next().unwrap().clone();
        restore_conflict(&a.dir, &mut a.prefs, &NoHost, &a.state, &id, 5).unwrap();
        a.touch();
        a.sync(&server);
        b.touch();
        b.sync(&server);
        assert_eq!(b.read("sessions.json")["sessions"][0]["name"], "Renamed on A");
        assert!(a.conflicts().is_empty() && b.conflicts().is_empty());
    }

    #[test]
    fn deletes_travel_but_an_edit_beats_a_delete() {
        let server = MemServer::default();
        let mut a = Device::new("A", "tomb");
        let mut b = Device::new("B", "tomb");
        a.session("s1", "Novel", json!([line(1, "u1", "消す", 10), line(2, "u2", "残す", 20), line(3, "u3", "訳す", 30)]));
        a.sync(&server);
        b.sync(&server);
        // A deletes u1 (recorded) and u3 (recorded); B translates u3 meanwhile.
        a.write("sessions/s1/lines.json", json!({ "version": 1, "lines": [line(2, "u2", "残す", 20)], "deleted": [{ "uid": "u1" }, { "uid": "u3" }] }));
        a.touch();
        a.sync(&server);
        let mut lines = b.lines("s1");
        lines[2]["translation"] = json!("translate");
        b.write("sessions/s1/lines.json", json!({ "version": 1, "lines": lines }));
        b.touch();
        b.sync(&server);
        a.touch();
        a.sync(&server);
        assert_eq!(b.texts("s1"), ["残す", "訳す"], "u1's delete reached B; B's edit of u3 survived");
        assert_eq!(a.texts("s1"), ["残す", "訳す"], "A got u3 back");
        assert_eq!(a.lines("s1")[1]["translation"], "translate");
    }

    #[test]
    fn a_trimmed_line_is_not_a_delete() {
        let server = MemServer::default();
        let mut a = Device::new("A", "trim");
        let mut b = Device::new("B", "trim");
        a.session("s1", "Novel", json!([line(1, "u1", "古い", 10), line(2, "u2", "新しい", 20)]));
        a.sync(&server);
        b.sync(&server);
        a.write("sessions/s1/lines.json", json!({ "version": 1, "lines": [line(2, "u2", "新しい", 20)] }));
        a.touch();
        let report = a.sync(&server);
        assert_eq!(report.pushed, 0);
        b.touch();
        b.sync(&server);
        assert_eq!(b.texts("s1"), ["古い", "新しい"]);
    }

    #[test]
    fn a_deleted_session_goes_to_the_trash_everywhere() {
        let server = MemServer::default();
        let mut a = Device::new("A", "session-delete");
        let mut b = Device::new("B", "session-delete");
        a.session("s1", "Keep", json!([]));
        a.session("s2", "Drop", json!([line(1, "u1", "x", 1)]));
        a.sync(&server);
        b.sync(&server);
        assert_eq!(b.texts("s2"), ["x"]);
        let mut manifest = a.read("sessions.json");
        manifest["sessions"].as_array_mut().unwrap().retain(|s| s["id"] != "s2");
        a.write("sessions.json", manifest);
        std::fs::remove_dir_all(a.dir.join("sessions/s2")).unwrap();
        a.touch();
        a.sync(&server);
        b.touch();
        b.sync(&server);
        let ids: Vec<String> = b.read("sessions.json")["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["s1"]);
        assert!(!b.dir.join("sessions/s2").exists());
        let trash: Vec<_> = std::fs::read_dir(b.dir.join("sync/trash")).unwrap().collect();
        assert_eq!(trash.len(), 1, "kept in the trash");
        assert!(server.records.borrow().get(&("lines".into(), "s2/u1".into())).unwrap().deleted, "its lines are tombstoned too");
    }

    #[test]
    fn preferences_sync_per_setting_and_the_account_wins_at_first() {
        let server = MemServer::default();
        let mut a = Device::new("A", "prefs");
        let mut b = Device::new("B", "prefs");
        a.prefs.doc = json!({ "appearance": "dark", "superTexthooker": { "fontSizePx": 20, "deeplApiKey": "secret" }, "windowPositions": { "x": 1 } });
        a.sync(&server);
        b.prefs.doc = json!({ "appearance": "light", "superTexthooker": { "deeplApiKey": "mine" } });
        b.sync(&server);
        assert_eq!(b.prefs.doc["appearance"], "dark", "the account's value at the first sync");
        assert_eq!(b.prefs.doc["superTexthooker"]["fontSizePx"], 20);
        assert_eq!(b.prefs.doc["superTexthooker"]["deeplApiKey"], "mine", "secrets never travel");
        assert!(b.prefs.doc.get("windowPositions").is_none());
        assert!(!server.records.borrow().keys().any(|(_, id)| id.contains("deeplApiKey") || id.contains("windowPositions")));
        // Different settings changed on each computer both survive.
        a.prefs.doc["appearance"] = json!("system");
        b.prefs.doc["superTexthooker"]["fontSizePx"] = json!(24);
        a.sync(&server);
        b.sync(&server);
        a.sync(&server);
        assert_eq!(a.prefs.doc["appearance"], "system");
        assert_eq!(a.prefs.doc["superTexthooker"]["fontSizePx"], 24);
        assert_eq!(b.prefs.doc["appearance"], "system");
    }

    #[test]
    fn notebook_images_travel_as_blobs() {
        let server = MemServer::default();
        let mut a = Device::new("A", "images");
        let mut b = Device::new("B", "images");
        a.session("s1", "Novel", json!([]));
        std::fs::create_dir_all(a.dir.join("sessions/s1/images")).unwrap();
        std::fs::write(a.dir.join("sessions/s1/images/i1.png"), b"png-bytes").unwrap();
        a.write(
            "sessions/s1/notebook.json",
            json!({ "version": 2, "cacheVersion": 3, "entries": [{ "id": "e1", "kind": "person", "family": "山田", "images": [{ "id": "i1", "path": "sessions/s1/images/i1.png", "addedAt": 1 }], "updatedAt": 1 }] }),
        );
        a.sync(&server);
        assert_eq!(server.blobs.borrow().len(), 1);
        b.sync(&server);
        assert_eq!(std::fs::read(b.dir.join("sessions/s1/images/i1.png")).unwrap(), b"png-bytes");
        let entry = &b.read("sessions/s1/notebook.json")["entries"][0];
        assert_eq!(entry["family"], "山田");
        assert!(entry["images"][0].get("sha256").is_none(), "the file keeps the Log's shape");
        // Nothing differs afterwards: a second sync pushes nothing.
        b.touch();
        assert_eq!(b.sync(&server).pushed, 0);
    }

    #[test]
    fn offline_changes_wait_and_keep_their_time() {
        let server = MemServer::default();
        let mut a = Device::new("A", "offline");
        a.session("s1", "Novel", json!([line(1, "u1", "x", 1)]));
        server.offline.set(true);
        a.clock.set(a.clock.get() + 1000);
        {
            let clock = &a.clock;
            let now = move || clock.get();
            let log = |_: &str, _: String| {};
            let mut ctx = Ctx { dir: &a.dir, device_id: "A", device_name: "A", remote: &server, host: &NoHost, prefs: &mut a.prefs, cache: &mut a.cache, state: &mut a.state, log: &log, now: &now };
            assert!(sync_once(&mut ctx).is_err());
        }
        let stamped = a.state.pending.get(&key("lines", "s1/u1")).unwrap().1.clone();
        server.offline.set(false);
        a.sync(&server);
        let record = server.records.borrow().get(&("lines".into(), "s1/u1".into())).cloned().unwrap();
        assert_eq!(record.hlc, stamped, "the edit keeps the time it was noticed offline");
        assert!(a.state.pending.is_empty());
    }

    #[test]
    fn clocks_order_by_time_then_device() {
        let mut clock = Clock::default();
        let a = clock.tick(5, "A");
        let b = clock.tick(5, "A");
        assert!(b > a);
        clock.observe("0000000000099.00002.B");
        let c = clock.tick(10, "A");
        assert!(c.as_str() > "0000000000099.00002.B");
    }
}
