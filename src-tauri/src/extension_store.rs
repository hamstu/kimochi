//! The dictionary engines (Yomitan, Hachidori, 10ten), downloaded on demand instead of bundled.
//!
//! Kimochi's binary carries no engine. Each is pinned to one upstream GitHub release by
//! `extensions/<id>.source.json` (asset URL, SHA-256, size) and `extensions/<id>.sha256.json`
//! (every file of the unpacked release and its SHA-256), both compiled in here. When the user
//! chooses an engine the release zip is downloaded with the OCR models' resumable transfer
//! (`model_store::download_file`), checked against the pinned hash, unpacked with the same rules
//! as `scripts/sync-extension.mjs`, and every file is checked against the pinned map before the
//! tree is moved into place. See EXTENSION_DOWNLOADS.md.
//!
//! # Layout
//!
//! ```text
//! <app local data>/extensions/
//!   tenten/
//!     1.28.0/              the verified tree, exactly the zip's files (its existence is the commit)
//!     1.28.0.zip.part      while downloading (resumable)
//!     1.28.0.zip           downloaded and verified, not yet unpacked
//!     .staging-1.28.0-…    while unpacking; removed at start-up if found
//!     installed.json       {version, assetSha256, verifiedAt}, for diagnostics only
//! ```
//!
//! # Serving
//!
//! [`read`] answers a file of an engine for the schemes (`hachidori://`, `tenten://`, in
//! `extensions.rs`) and for Yomitan at the app origin root ([`EngineAssets`], which replaces the
//! context's asset provider so Yomitan keeps `tauri://localhost/` and its users' IndexedDB). Only
//! paths in the pinned map are answered; the tree is the ready download, or in a debug build the
//! developer cache `extensions/<id>/` (unless `KIMOCHI_EXTENSIONS_NO_DEV_TREE` is set); no path
//! component may be a link; and each file is hashed against the map the first time it is served
//! in a session.
//!
//! # State machine
//!
//! The OCR models' (`model_store.rs`): absent → downloading → verifying (the zip, then
//! "unpacking") → ready, with paused and failed, one worker per engine, pause and cancel checked
//! between reads. Quitting pauses and keeps the `.part`.
use crate::model_store::{
    self, download_file, percent, remove_dir, sha256_file, Fetch, HttpFetch, ModelFile, Phase,
    Progress, Stop, CANCEL, PAUSE, PROGRESS_INTERVAL, RUN,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

/// Every engine the store can download, in the order onboarding offers them.
pub const IDS: &[&str] = &["yomitan", "hachidori", "tenten"];

/// The compiled-in pins: `(id, source.json, sha256.json)`.
const PINS: &[(&str, &str, &str)] = &[
    (
        "yomitan",
        include_str!("../../extensions/yomitan.source.json"),
        include_str!("../../extensions/yomitan.sha256.json"),
    ),
    (
        "hachidori",
        include_str!("../../extensions/hachidori.source.json"),
        include_str!("../../extensions/hachidori.sha256.json"),
    ),
    (
        "tenten",
        include_str!("../../extensions/tenten.source.json"),
        include_str!("../../extensions/tenten.sha256.json"),
    ),
];

const INSTALLED: &str = "installed.json";
const STAGING: &str = ".staging-";
/// Set to test the real download in a debug build, which otherwise serves `extensions/<id>/`.
pub const NO_DEV_TREE: &str = "KIMOCHI_EXTENSIONS_NO_DEV_TREE";

// ---------------------------------------------------------------------------- pins

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Asset {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
pub struct Unpack {
    #[serde(rename = "stripPrefix", default)]
    pub strip_prefix: String,
}

/// `extensions/<id>.source.json`.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Pin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub asset: Asset,
    #[serde(default)]
    pub unpack: Unpack,
}

/// One engine: its pin and the hash of every file of its release.
#[derive(Debug, Clone)]
pub struct Engine {
    pub pin: Pin,
    pub files: BTreeMap<String, String>,
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Engine {
    /// Parse and check a pin and its file map, as `loadSource` does in Node: the id matches, the
    /// URL is https, the hash is a SHA-256, the size is known, the version is a plain directory
    /// name, and every file path is one the unpacker would accept.
    pub fn parse(id: &str, source: &str, files: &str) -> Result<Self, String> {
        let pin: Pin = serde_json::from_str(source).map_err(|e| format!("{id}.source.json: {e}"))?;
        let files: BTreeMap<String, String> =
            serde_json::from_str(files).map_err(|e| format!("{id}.sha256.json: {e}"))?;
        if pin.id != id {
            return Err(format!("{id}.source.json has id {:?}", pin.id));
        }
        if !pin.asset.url.starts_with("https://") {
            return Err(format!("{id}.source.json: asset.url must be https"));
        }
        if !is_sha256(&pin.asset.sha256) {
            return Err(format!("{id}.source.json: asset.sha256 is not a sha256"));
        }
        if pin.asset.size == 0 {
            return Err(format!("{id}.source.json: asset.size is missing"));
        }
        let plain = |s: &str| {
            !s.is_empty()
                && s != "."
                && s != ".."
                && !s.starts_with('.')
                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))
        };
        if !plain(&pin.version) {
            return Err(format!("{id}.source.json: version {:?} is not a plain name", pin.version));
        }
        if files.is_empty() || !files.contains_key("manifest.json") {
            return Err(format!("{id}.sha256.json lists no manifest.json"));
        }
        for (name, hash) in &files {
            if safe_entry_path(name).as_deref() != Ok(name.as_str()) || name == INSTALLED {
                return Err(format!("{id}.sha256.json: {name:?} is not a safe relative path"));
            }
            if !is_sha256(hash) {
                return Err(format!("{id}.sha256.json: {name} has no valid SHA-256"));
            }
        }
        Ok(Engine { pin, files })
    }

    fn zip_file(&self) -> ModelFile {
        ModelFile {
            name: format!("{}.zip", self.pin.version),
            repository: self.pin.id.clone(),
            revision: self.pin.version.clone(),
            url: self.pin.asset.url.clone(),
            sha256: self.pin.asset.sha256.clone(),
            size: self.pin.asset.size,
        }
    }
}

/// The compiled-in engines, by id.
pub fn engines() -> &'static BTreeMap<String, Engine> {
    static ENGINES: OnceLock<BTreeMap<String, Engine>> = OnceLock::new();
    ENGINES.get_or_init(|| {
        PINS.iter()
            .map(|(id, source, files)| {
                let engine = Engine::parse(id, source, files)
                    .expect("the extensions/ pins are checked by the tests");
                (id.to_string(), engine)
            })
            .collect()
    })
}

pub fn engine(id: &str) -> Option<&'static Engine> {
    engines().get(id)
}

// ---------------------------------------------------------------------------- unzip

/// The relative path a zip entry may be written to, or why not. The same rules as
/// `safeEntryPath` in `scripts/sync-extension.mjs`: no NUL, no backslash, nothing absolute, no
/// drive letter, no `..`; empty and `.` segments are dropped.
pub fn safe_entry_path(name: &str) -> Result<String, String> {
    if name.is_empty() {
        return Err("Zip entry has an empty name".into());
    }
    if name.contains('\0') {
        return Err(format!("Zip entry name contains NUL: {name:?}"));
    }
    if name.contains('\\') {
        return Err(format!("Zip entry name contains a backslash: {name}"));
    }
    let bytes = name.as_bytes();
    if name.starts_with('/') || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
    {
        return Err(format!("Zip entry is absolute: {name}"));
    }
    let parts: Vec<&str> = name.split('/').collect();
    if parts.contains(&"..") {
        return Err(format!("Zip entry escapes the target: {name}"));
    }
    Ok(parts
        .into_iter()
        .filter(|p| !p.is_empty() && *p != ".")
        .collect::<Vec<_>>()
        .join("/"))
}

const EOCD: u32 = 0x0605_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const LOCAL: u32 = 0x0403_4b50;

/// One central-directory entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipEntry {
    /// The safe relative path (`safe_entry_path`).
    pub name: String,
    pub directory: bool,
    method: u16,
    crc: u32,
    compressed: usize,
    size: usize,
    local: usize,
}

fn u16_at(b: &[u8], at: usize) -> Result<u16, String> {
    b.get(at..at + 2)
        .map(|s| u16::from_le_bytes([s[0], s[1]]))
        .ok_or_else(|| "Corrupt zip (truncated)".to_string())
}

fn u32_at(b: &[u8], at: usize) -> Result<u32, String> {
    b.get(at..at + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
        .ok_or_else(|| "Corrupt zip (truncated)".to_string())
}

/// The central directory, checked: stored and deflate only, no ZIP64, no encryption, no
/// symlinks, no unsafe names. A port of `readZip` in `scripts/sync-extension.mjs`.
pub fn zip_entries(zip: &[u8]) -> Result<Vec<ZipEntry>, String> {
    if zip.len() < 22 {
        return Err("Not a zip file (no end-of-central-directory record)".into());
    }
    let last = zip.len() - 22;
    let first = last.saturating_sub(0xffff);
    let eocd = (first..=last)
        .rev()
        .find(|&i| u32_at(zip, i) == Ok(EOCD))
        .ok_or("Not a zip file (no end-of-central-directory record)")?;
    let count = u16_at(zip, eocd + 10)?;
    let start = u32_at(zip, eocd + 16)?;
    if count == 0xffff || start == 0xffff_ffff {
        return Err("ZIP64 archives are not supported".into());
    }
    let mut offset = start as usize;
    let mut entries = Vec::with_capacity(count as usize);
    for _ in 0..count {
        if u32_at(zip, offset)? != CENTRAL {
            return Err("Corrupt zip central directory".into());
        }
        let made_by = u16_at(zip, offset + 4)? >> 8;
        let flags = u16_at(zip, offset + 8)?;
        let method = u16_at(zip, offset + 10)?;
        let crc = u32_at(zip, offset + 16)?;
        let compressed = u32_at(zip, offset + 20)? as usize;
        let size = u32_at(zip, offset + 24)? as usize;
        let name_len = u16_at(zip, offset + 28)? as usize;
        let extra_len = u16_at(zip, offset + 30)? as usize;
        let comment_len = u16_at(zip, offset + 32)? as usize;
        let external = u32_at(zip, offset + 38)?;
        let local = u32_at(zip, offset + 42)? as usize;
        let raw = zip
            .get(offset + 46..offset + 46 + name_len)
            .ok_or("Corrupt zip (truncated)")?;
        let raw = String::from_utf8_lossy(raw).into_owned();
        offset += 46 + name_len + extra_len + comment_len;
        if flags & 0x1 != 0 {
            return Err(format!("Encrypted zip entry: {raw}"));
        }
        // Unix "made by" (3) carries st_mode in the high 16 bits; 0o120000 is a symlink.
        let mode = if made_by == 3 { external >> 16 } else { 0 };
        if mode & 0o170000 == 0o120000 {
            return Err(format!("Zip entry is a symlink: {raw}"));
        }
        let name = safe_entry_path(&raw)?;
        let directory = raw.ends_with('/');
        if !directory && method != 0 && method != 8 {
            return Err(format!("Unsupported zip compression method {method}: {raw}"));
        }
        entries.push(ZipEntry {
            name,
            directory,
            method,
            crc,
            compressed,
            size,
            local,
        });
    }
    Ok(entries)
}

/// The entry's bytes, inflated, size- and CRC-checked.
fn entry_data(zip: &[u8], entry: &ZipEntry) -> Result<Vec<u8>, String> {
    if u32_at(zip, entry.local)? != LOCAL {
        return Err(format!("Corrupt local header: {}", entry.name));
    }
    let start = entry.local
        + 30
        + u16_at(zip, entry.local + 26)? as usize
        + u16_at(zip, entry.local + 28)? as usize;
    let raw = zip
        .get(start..start + entry.compressed)
        .ok_or_else(|| format!("Corrupt zip (truncated): {}", entry.name))?;
    let data = if entry.method == 0 {
        raw.to_vec()
    } else {
        let mut out = Vec::with_capacity(entry.size);
        // Never inflate past the declared size: a zip bomb stops at size + 1.
        flate2::read::DeflateDecoder::new(raw)
            .take(entry.size as u64 + 1)
            .read_to_end(&mut out)
            .map_err(|e| format!("Could not inflate {}: {e}", entry.name))?;
        out
    };
    if data.len() != entry.size {
        return Err(format!("Size mismatch for {}", entry.name));
    }
    if crc32fast::hash(&data) != entry.crc {
        return Err(format!("CRC mismatch for {}", entry.name));
    }
    Ok(data)
}

fn hex(digest: impl AsRef<[u8]>) -> String {
    digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// Differences between two hash maps, as `compareHashes` words them; empty when equal.
pub fn compare_hashes(
    expected: &BTreeMap<String, String>,
    actual: &BTreeMap<String, String>,
) -> Vec<String> {
    let mut problems = Vec::new();
    for (name, hash) in expected {
        match actual.get(name) {
            None => problems.push(format!("missing: {name}")),
            Some(h) if h != hash => problems.push(format!("changed: {name}")),
            _ => {}
        }
    }
    for name in actual.keys() {
        if !expected.contains_key(name) {
            problems.push(format!("added: {name}"));
        }
    }
    problems
}

/// Unpacks `zip` into `staging` (which must be empty), hashing every file as it is written, and
/// fails unless the files are exactly `expected`. `strip_prefix` is removed from every entry; an
/// entry outside it is an error. `control` is checked between files.
pub fn unpack(
    zip: &[u8],
    staging: &Path,
    strip_prefix: &str,
    expected: &BTreeMap<String, String>,
    control: &AtomicU8,
) -> Result<(), Stop> {
    let failed = |e: String| Stop::Failed(e);
    let prefix = if strip_prefix.is_empty() {
        String::new()
    } else {
        format!("{}/", safe_entry_path(strip_prefix).map_err(failed)?)
    };
    let root = staging.to_path_buf();
    let mut actual = BTreeMap::new();
    for entry in zip_entries(zip).map_err(failed)? {
        match control.load(Ordering::SeqCst) {
            PAUSE => return Err(Stop::Paused),
            CANCEL => return Err(Stop::Cancelled),
            _ => {}
        }
        let mut name = entry.name.clone();
        if !prefix.is_empty() {
            if format!("{name}/") == prefix {
                continue;
            }
            name = name
                .strip_prefix(&prefix)
                .ok_or_else(|| Stop::Failed(format!("Zip entry outside {prefix}: {name}")))?
                .to_string();
        }
        if name.is_empty() {
            continue;
        }
        let target = name.split('/').fold(root.clone(), |p, s| p.join(s));
        // Belt and braces on top of safe_entry_path: never write outside the staging directory.
        if !target.starts_with(&root) || target == root {
            return Err(Stop::Failed(format!("Zip entry escapes the target: {name}")));
        }
        let io = |what: &str, e: io::Error| Stop::Failed(format!("could not {what} {name}: {e}"));
        if entry.directory {
            fs::create_dir_all(&target).map_err(|e| io("create", e))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| io("create", e))?;
        }
        let data = entry_data(zip, &entry).map_err(failed)?;
        // `create_new`: a second entry with the same name would otherwise replace the first.
        let mut out = File::options()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| io("write", e))?;
        out.write_all(&data).map_err(|e| io("write", e))?;
        out.sync_all().map_err(|e| io("write", e))?;
        actual.insert(name, hex(Sha256::digest(&data)));
    }
    let problems = compare_hashes(expected, &actual);
    if problems.is_empty() {
        Ok(())
    } else {
        let more = problems.len().saturating_sub(5);
        Err(Stop::Failed(format!(
            "the download does not match the pinned release ({}{})",
            problems[..problems.len().min(5)].join(", "),
            if more > 0 { format!(", and {more} more") } else { String::new() }
        )))
    }
}

/// `fs::rename`, retried on Windows while the target or source is briefly held: Defender's
/// on-access scan opens freshly written `.js` and `.wasm` files.
pub fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut delay = Duration::from_millis(50);
    let mut attempt = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                // ERROR_ACCESS_DENIED (5) and ERROR_SHARING_VIOLATION (32).
                let transient = cfg!(windows) && matches!(e.raw_os_error(), Some(5) | Some(32));
                if !transient || attempt >= 8 {
                    return Err(e);
                }
                attempt += 1;
                std::thread::sleep(delay);
                delay = (delay * 2).min(Duration::from_secs(1));
            }
        }
    }
}

// ---------------------------------------------------------------------------- disk

fn version_dir(root: &Path, engine: &Engine) -> PathBuf {
    root.join(&engine.pin.id).join(&engine.pin.version)
}

/// The engine's phase as found on disk: ready when the pinned version's directory exists (it is
/// only ever created by a rename after every file was verified), paused when part or all of the
/// zip is there, absent otherwise.
pub fn scan_disk(root: &Path, engine: &Engine) -> Phase {
    let dir = root.join(&engine.pin.id);
    if version_dir(root, engine).is_dir() {
        return Phase::Ready;
    }
    let file = engine.zip_file();
    let done = fs::metadata(dir.join(&file.name)).ok().map(|m| m.len().min(file.size));
    let part = fs::metadata(model_store::part_path(&dir, &file.name))
        .ok()
        .map(|m| m.len().min(file.size));
    match done.or(part) {
        Some(received) => Phase::Paused {
            overall_received: received,
        },
        None => Phase::Absent,
    }
}

/// Removes everything under `<root>/<id>/` that the pin does not need: other versions, their
/// zips and parts, and leftover staging directories. Keeps the pinned version's tree, zip and
/// part, and `installed.json`. Returns what was removed.
pub fn clean(root: &Path, engine: &Engine) -> Vec<String> {
    let dir = root.join(&engine.pin.id);
    let version = &engine.pin.version;
    let keep = [
        version.clone(),
        format!("{version}.zip"),
        format!("{version}.zip.part"),
        INSTALLED.to_string(),
    ];
    let mut removed = Vec::new();
    for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if keep.contains(&name) {
            continue;
        }
        let path = entry.path();
        // A link (planted, never ours) is removed itself, never followed.
        let result = match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_dir() => remove_dir(&path),
            Ok(_) => fs::remove_file(&path),
            Err(e) => Err(e),
        };
        if result.is_ok() {
            removed.push(name);
        }
    }
    removed
}

// ---------------------------------------------------------------------------- store

type Notify = Arc<dyn Fn(&str, bool) + Send + Sync>;

struct Slot {
    phase: Phase,
    control: Option<Arc<AtomicU8>>,
}

/// The per-engine download state machines over `<app local data>/extensions`.
pub struct ExtensionStore {
    root: PathBuf,
    engines: BTreeMap<String, Engine>,
    fetch: Arc<dyn Fetch>,
    slots: Mutex<HashMap<String, Slot>>,
    notify: OnceLock<Notify>,
    closing: AtomicBool,
}

impl ExtensionStore {
    pub fn new(root: PathBuf, engines: BTreeMap<String, Engine>, fetch: Arc<dyn Fetch>) -> Arc<Self> {
        Arc::new(Self {
            root,
            engines,
            fetch,
            slots: Mutex::new(HashMap::new()),
            notify: OnceLock::new(),
            closing: AtomicBool::new(false),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn on_change(&self, notify: impl Fn(&str, bool) + Send + Sync + 'static) {
        let _ = self.notify.set(Arc::new(notify));
    }

    fn with_slot<R>(&self, id: &str, f: impl FnOnce(&mut Slot) -> R) -> Option<R> {
        let engine = self.engines.get(id)?;
        let mut slots = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        let slot = slots.entry(id.to_string()).or_insert_with(|| Slot {
            phase: scan_disk(&self.root, engine),
            control: None,
        });
        Some(f(slot))
    }

    fn emit(&self, id: &str, transition: bool) {
        if let Some(notify) = self.notify.get() {
            notify(id, transition);
        }
    }

    pub fn phase(&self, id: &str) -> Phase {
        self.with_slot(id, |slot| {
            // A tree removed behind the store's back is not ready any more.
            if slot.phase == Phase::Ready && slot.control.is_none() {
                if let Some(engine) = self.engines.get(id) {
                    if !version_dir(&self.root, engine).is_dir() {
                        slot.phase = scan_disk(&self.root, engine);
                    }
                }
            }
            slot.phase.clone()
        })
        .unwrap_or(Phase::Absent)
    }

    /// The pinned version's tree when it is installed.
    #[cfg(test)]
    pub fn ready_dir(&self, id: &str) -> Option<PathBuf> {
        let engine = self.engines.get(id)?;
        let dir = version_dir(&self.root, engine);
        (self.phase(id) == Phase::Ready && dir.is_dir()).then_some(dir)
    }

    /// Removes leftovers for every engine (other versions, staging, stray parts). Start-up only.
    pub fn clean_all(&self) -> Vec<String> {
        self.engines
            .values()
            .flat_map(|engine| {
                clean(&self.root, engine)
                    .into_iter()
                    .map(move |name| format!("{}/{name}", engine.pin.id))
            })
            .collect()
    }

    /// Start, resume or retry. A no-op while one runs or once ready.
    pub fn start(self: &Arc<Self>, id: &str) {
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        let Some(engine) = self.engines.get(id) else { return };
        let control = self.with_slot(id, |slot| {
            if let Some(control) = &slot.control {
                control.store(RUN, Ordering::SeqCst);
                return None;
            }
            if slot.phase == Phase::Ready {
                return None;
            }
            let control = Arc::new(AtomicU8::new(RUN));
            slot.control = Some(control.clone());
            slot.phase = Phase::Downloading {
                file: engine.zip_file().name,
                received: 0,
                total: 0,
                overall_received: slot.phase.overall_received(engine.pin.asset.size),
            };
            Some(control)
        });
        let Some(Some(control)) = control else { return };
        self.emit(id, true);
        let store = self.clone();
        let worker = control.clone();
        let owned = id.to_string();
        let spawned = std::thread::Builder::new()
            .name(format!("kimochi-{id}-download"))
            .spawn(move || {
                let outcome = store.download(&owned, &worker);
                store.finish(&owned, &worker, outcome);
            });
        if let Err(e) = spawned {
            self.finish(id, &control, Err(Stop::Failed(format!("could not start the download: {e}"))));
        }
    }

    pub fn pause(&self, id: &str) {
        self.with_slot(id, |slot| {
            if let Some(control) = &slot.control {
                control.store(PAUSE, Ordering::SeqCst);
            }
        });
    }

    /// Stops a download and removes what it fetched, unless the engine is ready.
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        if self.phase(id) == Phase::Ready {
            return Ok(());
        }
        self.discard(id)
    }

    /// Stops any download and removes the engine's files, ready or not. Never its dictionaries:
    /// those are in the WebView's storage for its origin, and in `chrome-local-<id>.json`.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.discard(id)
    }

    fn discard(&self, id: &str) -> Result<(), String> {
        let Some(engine) = self.engines.get(id) else {
            return Err(format!("unknown engine {id}"));
        };
        let dir = self.root.join(id);
        let result = self.with_slot(id, |slot| {
            if let Some(control) = &slot.control {
                control.store(CANCEL, Ordering::SeqCst);
                return Ok(());
            }
            let removed = remove_dir(&dir);
            slot.phase = scan_disk(&self.root, engine);
            removed.map_err(|e| format!("could not remove {}: {e}", dir.display()))
        });
        forget_verified(id);
        self.emit(id, true);
        result.unwrap_or(Ok(()))
    }

    /// Pauses every worker and waits up to `wait` for them; their `.part` files are kept.
    pub fn shutdown(&self, wait: Duration) {
        self.closing.store(true, Ordering::SeqCst);
        let running = || {
            let slots = self.slots.lock().unwrap_or_else(|p| p.into_inner());
            let mut any = false;
            for control in slots.values().filter_map(|s| s.control.as_ref()) {
                control.store(PAUSE, Ordering::SeqCst);
                any = true;
            }
            any
        };
        let deadline = Instant::now() + wait;
        while running() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn set_phase(&self, id: &str, phase: Phase, transition: bool) {
        self.with_slot(id, |slot| slot.phase = phase);
        self.emit(id, transition);
    }

    /// The worker: the zip (unless a verified one is already there), then the unpack.
    fn download(&self, id: &str, control: &AtomicU8) -> Result<(), Stop> {
        let engine = self.engines.get(id).ok_or_else(|| Stop::Failed(format!("unknown engine {id}")))?;
        let dir = self.root.join(id);
        fs::create_dir_all(&dir)
            .map_err(|e| Stop::Failed(format!("could not create {}: {e}", dir.display())))?;
        let file = engine.zip_file();
        let zip = dir.join(&file.name);
        let size = file.size;
        if zip.exists() {
            self.set_phase(
                id,
                Phase::Verifying {
                    file: file.name.clone(),
                    overall_received: size,
                },
                true,
            );
            if sha256_file(&zip).ok().as_deref() != Some(file.sha256.as_str()) {
                let _ = fs::remove_file(&zip);
            }
        }
        if !zip.exists() {
            let mut last: Option<Instant> = None;
            let mut progress = |event: Progress| {
                let (phase, transition) = match event {
                    Progress::Bytes(received) => (
                        Phase::Downloading {
                            file: file.name.clone(),
                            received,
                            total: size,
                            overall_received: received,
                        },
                        false,
                    ),
                    Progress::Verifying => (
                        Phase::Verifying {
                            file: file.name.clone(),
                            overall_received: size,
                        },
                        true,
                    ),
                };
                if transition || last.is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL) {
                    last = Some(Instant::now());
                    self.set_phase(id, phase, transition);
                }
            };
            download_file(self.fetch.as_ref(), &dir, &file, control, &mut progress)?;
        }
        self.set_phase(
            id,
            Phase::Verifying {
                file: "unpacking".into(),
                overall_received: size,
            },
            true,
        );
        self.install(engine, &zip, control)
    }

    /// Unpack the verified zip into a staging directory, verify every file, then rename it into
    /// place, record it, and remove the zip and anything else the pin does not need.
    fn install(&self, engine: &Engine, zip: &Path, control: &AtomicU8) -> Result<(), Stop> {
        let dir = self.root.join(&engine.pin.id);
        let version = &engine.pin.version;
        for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
            if entry.file_name().to_string_lossy().starts_with(STAGING) {
                let _ = remove_dir(&entry.path());
            }
        }
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let staging = dir.join(format!("{STAGING}{version}-{}-{nanos}", std::process::id()));
        fs::create_dir(&staging)
            .map_err(|e| Stop::Failed(format!("could not create {}: {e}", staging.display())))?;
        let unpacked = fs::read(zip)
            .map_err(|e| Stop::Failed(format!("could not read the download: {e}")))
            .and_then(|bytes| {
                unpack(&bytes, &staging, &engine.pin.unpack.strip_prefix, &engine.files, control)
            });
        if let Err(stop) = unpacked {
            let _ = remove_dir(&staging);
            if matches!(stop, Stop::Failed(_)) {
                // The zip matched its pin, so a mismatch is a pin/map disagreement or local
                // interference (an antivirus quarantine); fetching it again is the only retry.
                let _ = fs::remove_file(zip);
            }
            return Err(stop);
        }
        let target = version_dir(&self.root, engine);
        let _ = remove_dir(&target);
        if let Err(e) = rename_with_retry(&staging, &target) {
            let _ = remove_dir(&staging);
            return Err(Stop::Failed(format!("could not move {} into place: {e}", engine.pin.name)));
        }
        let record = json!({
            "version": version,
            "assetSha256": engine.pin.asset.sha256,
            "verifiedAt": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        });
        let _ = fs::write(dir.join(INSTALLED), serde_json::to_vec_pretty(&record).unwrap_or_default());
        let _ = fs::remove_file(zip);
        forget_verified(&engine.pin.id);
        clean(&self.root, engine);
        Ok(())
    }

    fn finish(self: &Arc<Self>, id: &str, control: &AtomicU8, outcome: Result<(), Stop>) {
        let Some(engine) = self.engines.get(id) else { return };
        let dir = self.root.join(id);
        let restart = self
            .with_slot(id, |slot| {
                slot.control = None;
                let stopped = matches!(outcome, Err(Stop::Paused | Stop::Cancelled));
                slot.phase = match outcome {
                    Ok(()) => Phase::Ready,
                    Err(Stop::Cancelled) => match remove_dir(&dir) {
                        Ok(()) => Phase::Absent,
                        Err(e) => Phase::Failed {
                            message: format!("could not remove {}: {e}", dir.display()),
                            overall_received: 0,
                        },
                    },
                    Err(Stop::Paused) => match scan_disk(&self.root, engine) {
                        Phase::Paused { overall_received } => Phase::Paused { overall_received },
                        _ => Phase::Paused {
                            overall_received: 0,
                        },
                    },
                    Err(Stop::Failed(message)) => Phase::Failed {
                        message,
                        overall_received: scan_disk(&self.root, engine)
                            .overall_received(engine.pin.asset.size),
                    },
                };
                stopped && control.load(Ordering::SeqCst) == RUN
            })
            .unwrap_or(false);
        self.emit(id, true);
        if restart {
            self.start(id);
        }
    }
}

// ---------------------------------------------------------------------------- status

/// The `extension_status` reply and the `extension-download` event payload. The shape of
/// `ModelStatus`, with `engine` an engine id and the pinned `version`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStatus {
    pub engine: String,
    pub name: String,
    pub version: String,
    /// absent | downloading | paused | failed | verifying | ready
    pub state: &'static str,
    /// Where a ready engine is served from: downloaded | development.
    pub source: Option<&'static str>,
    pub file: Option<String>,
    pub received_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub overall_received: u64,
    pub overall_total: u64,
    pub message: Option<String>,
}

impl ExtensionStatus {
    pub fn new(engine: &Engine, phase: &Phase, development: bool) -> Self {
        let total = engine.pin.asset.size;
        let (phase, source) = match phase {
            Phase::Ready => (&Phase::Ready, Some("downloaded")),
            Phase::Absent if development => (&Phase::Ready, Some("development")),
            other => (other, None),
        };
        let mut status = ExtensionStatus {
            engine: engine.pin.id.clone(),
            name: engine.pin.name.clone(),
            version: engine.pin.version.clone(),
            state: phase.name(),
            source,
            file: None,
            received_bytes: None,
            total_bytes: None,
            overall_received: phase.overall_received(total),
            overall_total: total,
            message: None,
        };
        match phase {
            Phase::Downloading {
                file, received, total, ..
            } => {
                status.file = Some(file.clone());
                status.received_bytes = Some(*received);
                status.total_bytes = Some(*total);
            }
            Phase::Verifying { file, .. } => status.file = Some(file.clone()),
            Phase::Failed { message, .. } => status.message = Some(message.clone()),
            _ => {}
        }
        status
    }
}

/// What the activity feed hears about one engine's download: each state change once, progress at
/// most once a second.
#[derive(Default)]
pub struct ExtensionTicker {
    state: Option<&'static str>,
    percent: u64,
    posted: Option<Instant>,
}

impl ExtensionTicker {
    pub fn key(id: &str) -> String {
        format!("extension:{id}")
    }

    pub fn next(&mut self, status: &ExtensionStatus, now: Instant) -> Option<(String, crate::activity::Tone)> {
        use crate::activity::Tone;
        let name = &status.name;
        let pct = percent(status.overall_received, status.overall_total);
        let previous = self.state.replace(status.state);
        let changed = previous != Some(status.state);
        let post = match status.state {
            "downloading" => {
                let due = self
                    .posted
                    .is_none_or(|at| now.duration_since(at) >= Duration::from_secs(1));
                (changed || (due && pct != self.percent))
                    .then(|| (format!("Downloading {name}… {pct}%"), Tone::Busy))
            }
            _ if !changed => None,
            "verifying" => Some((format!("Verifying {name}…"), Tone::Busy)),
            "ready" => previous.is_some().then(|| (format!("{name} ready"), Tone::Ok)),
            "paused" => Some((format!("{name} download paused at {pct}%"), Tone::Info)),
            "failed" => Some((
                format!(
                    "{name} download failed: {}",
                    status.message.as_deref().unwrap_or("unknown error")
                ),
                Tone::Error,
            )),
            "absent" => Some(match previous {
                Some("ready") | None => (format!("{name} removed"), Tone::Info),
                Some(_) => (format!("{name} download cancelled"), Tone::Info),
            }),
            _ => None,
        };
        if post.is_some() {
            self.percent = pct;
            self.posted = Some(now);
        }
        post
    }
}

// ---------------------------------------------------------------------------- serving

/// The store root, set once at start-up, so serving needs no app handle (the asset provider has
/// none).
static ROOT: OnceLock<PathBuf> = OnceLock::new();
/// Files already hashed against the map this session: `(id, tree, path)`.
static VERIFIED: OnceLock<Mutex<HashSet<(String, PathBuf, String)>>> = OnceLock::new();
/// Where serving refusals are reported (`record` in main.rs).
static REPORT: OnceLock<Box<dyn Fn(Value) + Send + Sync>> = OnceLock::new();

fn verified() -> &'static Mutex<HashSet<(String, PathBuf, String)>> {
    VERIFIED.get_or_init(Default::default)
}

fn forget_verified(id: &str) {
    verified()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .retain(|(engine, _, _)| engine != id);
}

fn report(value: Value) {
    eprintln!("kimochi: {value}");
    if let Some(report) = REPORT.get() {
        report(value);
    }
}

/// The developer cache `<repo>/extensions/<id>/`, in a debug build only (a release binary never
/// serves code from a compiled-in path of the build machine), and not with
/// `KIMOCHI_EXTENSIONS_NO_DEV_TREE` set.
pub fn dev_tree(id: &str) -> Option<PathBuf> {
    if !cfg!(debug_assertions) || std::env::var_os(NO_DEV_TREE).is_some() {
        return None;
    }
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("extensions").join(id);
    dir.join("manifest.json").is_file().then_some(dir)
}

/// The tree an engine is served from: its installed download, else the debug dev tree.
pub fn serving_tree(id: &str) -> Option<(PathBuf, &'static str)> {
    let engine = engine(id)?;
    if let Some(root) = ROOT.get() {
        let dir = version_dir(root, engine);
        if dir.is_dir() {
            return Some((dir, "downloaded"));
        }
    }
    dev_tree(id).map(|dir| (dir, "development"))
}

/// Whether an engine can be served now. `none` and unknown ids never are.
pub fn is_ready(id: &str) -> bool {
    serving_tree(id).is_some()
}

/// `rel` under `tree`, provided no component is a link and the last is a regular file.
pub fn file_without_links(tree: &Path, rel: &str) -> Option<PathBuf> {
    let mut path = tree.to_path_buf();
    let segments: Vec<&str> = rel.split('/').collect();
    for (i, segment) in segments.iter().enumerate() {
        path.push(segment);
        let meta = fs::symlink_metadata(&path).ok()?;
        let last = i + 1 == segments.len();
        if meta.file_type().is_symlink() || (last && !meta.is_file()) || (!last && !meta.is_dir()) {
            return None;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            // FILE_ATTRIBUTE_REPARSE_POINT: junctions and other reparse points.
            if meta.file_attributes() & 0x400 != 0 {
                return None;
            }
        }
    }
    Some(path)
}

/// One file of an engine's release, or `None` (a 404): only paths in the pinned map, from the
/// serving tree, never through a link, and hashed against the map the first time it is served.
pub fn read(id: &str, rel: &str) -> Option<Vec<u8>> {
    let engine = engine(id)?;
    let expected = engine.files.get(rel)?;
    let (tree, _) = serving_tree(id)?;
    read_verified(id, &tree, rel, expected)
}

fn read_verified(id: &str, tree: &Path, rel: &str, expected: &str) -> Option<Vec<u8>> {
    let Some(path) = file_without_links(tree, rel) else {
        if fs::symlink_metadata(tree.join(rel)).is_ok() {
            report(json!({ "check": "extension-file-refused", "engine": id, "file": rel, "reason": "not a regular file" }));
        }
        return None;
    };
    let bytes = fs::read(path).ok()?;
    let key = (id.to_string(), tree.to_path_buf(), rel.to_string());
    let seen = verified().lock().unwrap_or_else(|p| p.into_inner()).contains(&key);
    if !seen {
        if hex(Sha256::digest(&bytes)) != expected {
            report(json!({ "check": "extension-file-refused", "engine": id, "file": rel, "reason": "does not match the pinned release" }));
            return None;
        }
        verified().lock().unwrap_or_else(|p| p.into_inner()).insert(key);
    }
    Some(bytes)
}

/// The app's asset provider with Yomitan layered in: Yomitan's own paths (exactly the keys of
/// `extensions/yomitan.sha256.json`) are answered by [`read`] from the download, so Yomitan stays
/// at the app origin root, where its users' dictionaries are; every other path (`/app/`, `/ui/`,
/// `/spike/`) is the embedded `dist/`, as before. Installed with `Context::set_assets`.
pub struct EngineAssets<R: tauri::Runtime> {
    embedded: Box<dyn tauri::Assets<R>>,
}

impl<R: tauri::Runtime> EngineAssets<R> {
    pub fn new(embedded: Box<dyn tauri::Assets<R>>) -> Self {
        Self { embedded }
    }
}

/// A placeholder provider, only ever in the context while the real one is being wrapped.
pub struct NoAssets;

impl<R: tauri::Runtime> tauri::Assets<R> for NoAssets {
    fn get(&self, _: &tauri::utils::assets::AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }
    fn iter(&self) -> Box<tauri::utils::assets::AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(
        &self,
        _: &tauri::utils::assets::AssetKey,
    ) -> Box<dyn Iterator<Item = tauri::utils::assets::CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

/// The Yomitan file an asset key names, if it names one.
pub fn yomitan_path(key: &str) -> Option<&'static str> {
    let rel = key.strip_prefix('/').unwrap_or(key);
    engine("yomitan")?
        .files
        .get_key_value(rel)
        .map(|(k, _)| k.as_str())
}

impl<R: tauri::Runtime> tauri::Assets<R> for EngineAssets<R> {
    fn setup(&self, app: &tauri::App<R>) {
        self.embedded.setup(app);
    }

    fn get(&self, key: &tauri::utils::assets::AssetKey) -> Option<Cow<'_, [u8]>> {
        match yomitan_path(key.as_ref()) {
            Some(rel) => read("yomitan", rel).map(Cow::Owned),
            None => self.embedded.get(key),
        }
    }

    fn iter(&self) -> Box<tauri::utils::assets::AssetsIter<'_>> {
        self.embedded.iter()
    }

    fn csp_hashes(
        &self,
        html_path: &tauri::utils::assets::AssetKey,
    ) -> Box<dyn Iterator<Item = tauri::utils::assets::CspHash<'_>> + '_> {
        self.embedded.csp_hashes(html_path)
    }
}

// ---------------------------------------------------------------------------- app glue

fn store(app: &tauri::AppHandle) -> Option<Arc<ExtensionStore>> {
    use tauri::Manager;
    app.try_state::<Arc<ExtensionStore>>().map(|s| s.inner().clone())
}

/// The status the UI shows.
pub fn status(app: &tauri::AppHandle, id: &str) -> Option<ExtensionStatus> {
    let engine = engine(id)?;
    let phase = store(app).map_or(Phase::Absent, |s| s.phase(id));
    Some(ExtensionStatus::new(engine, &phase, dev_tree(id).is_some()))
}

/// Create the store under `<app local data>/extensions`, clean leftovers, and announce changes
/// (the `extension-download` event, the activity feed, and `on_change`, which main.rs uses to
/// move the windows to a newly usable engine).
pub fn install(
    app: &tauri::AppHandle,
    report_to: impl Fn(Value) + Send + Sync + 'static,
    on_change: impl Fn(&tauri::AppHandle, &str, bool) + Send + Sync + 'static,
) -> Result<Arc<ExtensionStore>, String> {
    use tauri::{Emitter, Manager};
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("extensions");
    let _ = ROOT.set(root.clone());
    let _ = REPORT.set(Box::new(report_to));
    let store = ExtensionStore::new(root, engines().clone(), Arc::new(HttpFetch::default()));
    let removed = store.clean_all();
    if !removed.is_empty() {
        report(json!({ "check": "extension-store-cleaned", "removed": removed }));
    }
    let handle = app.clone();
    let tickers: Mutex<HashMap<String, ExtensionTicker>> = Mutex::new(HashMap::new());
    store.on_change(move |id, transition| {
        let Some(current) = status(&handle, id) else { return };
        let post = tickers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(id.to_string())
            .or_default()
            .next(&current, Instant::now());
        if let Some((text, tone)) = post {
            crate::activity::post(&handle, &text, tone, Some(&ExtensionTicker::key(id)));
        }
        let _ = handle.emit("extension-download", current);
        if transition {
            on_change(&handle, id, transition);
        }
    });
    app.manage(store.clone());
    Ok(store)
}

/// Start the download of an engine the user already chose, when it is not usable: at launch for
/// the selected engine (after a pin bump, or an upgrade from a build that bundled it). Paused
/// downloads resume; a failed one waits for Retry.
pub fn ensure_selected(app: &tauri::AppHandle, id: &str) -> bool {
    if is_ready(id) {
        return false;
    }
    let Some(store) = store(app) else { return false };
    if !matches!(store.phase(id), Phase::Absent | Phase::Paused { .. }) {
        return false;
    }
    store.start(id);
    true
}

/// Pause every download before the process exits.
pub fn shutdown(app: &tauri::AppHandle) {
    if let Some(store) = store(app) {
        store.shutdown(Duration::from_secs(1));
    }
}

fn id_arg(id: &str) -> Result<&'static str, String> {
    IDS.iter()
        .copied()
        .find(|known| *known == id)
        .ok_or_else(|| format!("invalid: unknown dictionary engine {id}"))
}

async fn act(
    app: tauri::AppHandle,
    engine: String,
    operation: impl FnOnce(Arc<ExtensionStore>, &'static str) -> Result<(), String> + Send + 'static,
) -> Result<ExtensionStatus, String> {
    let id = id_arg(&engine)?;
    let store = store(&app).ok_or_else(|| "native: the engine store is not running".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        operation(store, id).map_err(|e| format!("native: {e}"))?;
        status(&app, id).ok_or_else(|| "native: unknown engine".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn extension_status(app: tauri::AppHandle, engine: String) -> Result<ExtensionStatus, String> {
    let id = id_arg(&engine)?;
    status(&app, id).ok_or_else(|| "native: unknown engine".into())
}

#[tauri::command]
pub async fn extension_download_start(app: tauri::AppHandle, engine: String) -> Result<ExtensionStatus, String> {
    act(app, engine, |store, id| {
        store.start(id);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn extension_download_resume(app: tauri::AppHandle, engine: String) -> Result<ExtensionStatus, String> {
    extension_download_start(app, engine).await
}

#[tauri::command]
pub async fn extension_download_retry(app: tauri::AppHandle, engine: String) -> Result<ExtensionStatus, String> {
    extension_download_start(app, engine).await
}

#[tauri::command]
pub async fn extension_download_pause(app: tauri::AppHandle, engine: String) -> Result<ExtensionStatus, String> {
    act(app, engine, |store, id| {
        store.pause(id);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn extension_download_cancel(app: tauri::AppHandle, engine: String) -> Result<ExtensionStatus, String> {
    act(app, engine, |store, id| store.cancel(id)).await
}

/// Removes a downloaded engine. Refused for the engine the dictionary setting names: removing it
/// would leave the reader with no dictionary behind the user's back (switch first).
#[tauri::command]
pub async fn extension_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::state::Shared>,
    engine: String,
) -> Result<ExtensionStatus, String> {
    let selected = crate::extensions::selected_engine(&state.settings);
    if selected == engine {
        return Err(format!(
            "invalid: {engine} is the engine in use; switch to another in Settings → Dictionary first"
        ));
    }
    act(app, engine, |store, id| store.delete(id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_store::{Body, Opened};
    use std::sync::atomic::AtomicUsize;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "kimochi-extension-store-{tag}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// `{name, data, method, mode, flags, crc}`, directories ending in `/`; the test twin of
    /// `makeZip` in scripts/sync-extension.test.mjs.
    #[derive(Clone)]
    struct Item {
        name: &'static str,
        data: Vec<u8>,
        method: u16,
        mode: u32,
        flags: u16,
        crc: Option<u32>,
    }
    fn item(name: &'static str, data: &[u8]) -> Item {
        Item {
            name,
            data: data.to_vec(),
            method: 8,
            mode: 0o100644,
            flags: 0,
            crc: None,
        }
    }

    fn make_zip(items: &[Item]) -> Vec<u8> {
        let mut locals = Vec::new();
        let mut centrals = Vec::new();
        for it in items {
            let stored = if it.method == 8 {
                let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                e.write_all(&it.data).unwrap();
                e.finish().unwrap()
            } else {
                it.data.clone()
            };
            let crc = it.crc.unwrap_or_else(|| crc32fast::hash(&it.data));
            let offset = locals.len() as u32;
            let name = it.name.as_bytes();
            let mut local = vec![0u8; 30];
            local[0..4].copy_from_slice(&LOCAL.to_le_bytes());
            local[6..8].copy_from_slice(&it.flags.to_le_bytes());
            local[8..10].copy_from_slice(&it.method.to_le_bytes());
            local[14..18].copy_from_slice(&crc.to_le_bytes());
            local[18..22].copy_from_slice(&(stored.len() as u32).to_le_bytes());
            local[22..26].copy_from_slice(&(it.data.len() as u32).to_le_bytes());
            local[26..28].copy_from_slice(&(name.len() as u16).to_le_bytes());
            locals.extend_from_slice(&local);
            locals.extend_from_slice(name);
            locals.extend_from_slice(&stored);
            let mut central = vec![0u8; 46];
            central[0..4].copy_from_slice(&CENTRAL.to_le_bytes());
            central[4..6].copy_from_slice(&((3u16 << 8) | 20).to_le_bytes());
            central[8..10].copy_from_slice(&it.flags.to_le_bytes());
            central[10..12].copy_from_slice(&it.method.to_le_bytes());
            central[16..20].copy_from_slice(&crc.to_le_bytes());
            central[20..24].copy_from_slice(&(stored.len() as u32).to_le_bytes());
            central[24..28].copy_from_slice(&(it.data.len() as u32).to_le_bytes());
            central[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
            central[38..42].copy_from_slice(&(it.mode << 16).to_le_bytes());
            central[42..46].copy_from_slice(&offset.to_le_bytes());
            centrals.extend_from_slice(&central);
            centrals.extend_from_slice(name);
        }
        let mut end = vec![0u8; 22];
        end[0..4].copy_from_slice(&EOCD.to_le_bytes());
        end[8..10].copy_from_slice(&(items.len() as u16).to_le_bytes());
        end[10..12].copy_from_slice(&(items.len() as u16).to_le_bytes());
        end[12..16].copy_from_slice(&(centrals.len() as u32).to_le_bytes());
        end[16..20].copy_from_slice(&(locals.len() as u32).to_le_bytes());
        [locals, centrals, end].concat()
    }

    fn sha(bytes: &[u8]) -> String {
        hex(Sha256::digest(bytes))
    }

    fn map(items: &[(&str, &[u8])]) -> BTreeMap<String, String> {
        items.iter().map(|(n, d)| (n.to_string(), sha(d))).collect()
    }

    fn run() -> AtomicU8 {
        AtomicU8::new(RUN)
    }

    #[test]
    fn the_compiled_in_pins_parse_and_name_every_engine() {
        let engines = engines();
        assert_eq!(engines.keys().map(String::as_str).collect::<Vec<_>>(), {
            let mut ids = IDS.to_vec();
            ids.sort();
            ids
        });
        assert_eq!(engines["yomitan"].pin.version, "26.8.24.0");
        assert_eq!(engines["yomitan"].files.len(), 421);
        assert!(engines["yomitan"].files.contains_key("js/comm/api.js"));
        for engine in engines.values() {
            assert!(engine.pin.asset.url.starts_with("https://github.com/"));
            assert!(engine.pin.asset.size > 1_000_000);
        }
        // The scheme engines are a subset of the downloadable ones.
        for id in crate::extensions::IDS {
            assert!(engines.contains_key(*id));
        }
    }

    #[test]
    fn pins_with_unsafe_paths_or_missing_fields_are_refused() {
        let good = format!(
            r#"{{"id":"demo","name":"Demo","version":"1.0","asset":{{"url":"https://x/y.zip","sha256":"{}","size":5}}}}"#,
            "a".repeat(64)
        );
        let files = |name: &str| format!(r#"{{"manifest.json":"{0}","{name}":"{0}"}}"#, "b".repeat(64));
        assert!(Engine::parse("demo", &good, &files("js/a.js")).is_ok());
        for bad in ["../x.js", "/abs.js", "a\\\\b.js", "a//b.js", "./a.js", "installed.json"] {
            assert!(Engine::parse("demo", &good, &files(bad)).is_err(), "{bad}");
        }
        assert!(Engine::parse("other", &good, &files("a.js")).is_err());
        assert!(Engine::parse("demo", &good.replace("https://", "http://"), &files("a.js")).is_err());
        assert!(Engine::parse("demo", &good.replace("\"size\":5", "\"size\":0"), &files("a.js")).is_err());
        assert!(Engine::parse("demo", &good.replace("1.0", "../1"), &files("a.js")).is_err());
        assert!(Engine::parse("demo", &good, r#"{"a.js":"x"}"#).is_err());
    }

    #[test]
    fn safe_entry_path_matches_the_node_rules() {
        assert_eq!(safe_entry_path("css/options.css").unwrap(), "css/options.css");
        assert_eq!(safe_entry_path("./a//b/").unwrap(), "a/b");
        for bad in ["../x", "a/../../x", "a/..", "/etc/passwd", "C:/x", "c:x", "a\\..\\x", "a\0b", ""] {
            assert!(safe_entry_path(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn unpack_writes_exactly_the_pinned_files() {
        let dir = TempDir::new("unpack");
        let a = b"manifest".to_vec();
        let b = b"console.log(1)".repeat(50);
        let zip = make_zip(&[
            item("js/", b""),
            item("manifest.json", &a),
            Item { method: 0, ..item("js/bg.js", &b) },
        ]);
        let expected = map(&[("manifest.json", &a), ("js/bg.js", &b)]);
        let out = dir.0.join("out");
        fs::create_dir(&out).unwrap();
        unpack(&zip, &out, "", &expected, &run()).unwrap();
        assert_eq!(fs::read(out.join("js/bg.js")).unwrap(), b);
        assert_eq!(fs::read(out.join("manifest.json")).unwrap(), a);
    }

    #[test]
    fn unpack_strips_a_prefix_and_refuses_entries_outside_it() {
        let dir = TempDir::new("prefix");
        let a = b"{}".to_vec();
        let zip = make_zip(&[item("ext/", b""), item("ext/manifest.json", &a)]);
        let out = dir.0.join("out");
        fs::create_dir(&out).unwrap();
        unpack(&zip, &out, "ext", &map(&[("manifest.json", &a)]), &run()).unwrap();
        assert!(out.join("manifest.json").is_file());
        let zip = make_zip(&[item("ext/manifest.json", &a), item("other.js", b"x")]);
        let out = dir.0.join("out2");
        fs::create_dir(&out).unwrap();
        let Err(Stop::Failed(m)) = unpack(&zip, &out, "ext", &map(&[("manifest.json", &a)]), &run()) else {
            panic!()
        };
        assert!(m.contains("outside"), "{m}");
    }

    #[test]
    fn unpack_refuses_traversal_symlinks_encryption_bad_crc_and_odd_methods() {
        let dir = TempDir::new("unsafe");
        let fail = |items: &[Item]| {
            let out = dir.0.join(format!("o{}", items.len() + items[0].name.len()));
            let _ = fs::remove_dir_all(&out);
            fs::create_dir(&out).unwrap();
            match unpack(&make_zip(items), &out, "", &BTreeMap::new(), &run()) {
                Err(Stop::Failed(m)) => {
                    // Nothing escaped the staging directory.
                    assert!(!dir.0.join("evil.js").exists());
                    m
                }
                other => panic!("{other:?}"),
            }
        };
        assert!(fail(&[item("../evil.js", b"x")]).contains("escapes"));
        assert!(fail(&[item("/evil.js", b"x")]).contains("absolute"));
        assert!(fail(&[item("a\\..\\evil.js", b"x")]).contains("backslash"));
        assert!(fail(&[Item { mode: 0o120777, ..item("link", b"/etc/passwd") }]).contains("symlink"));
        assert!(fail(&[Item { flags: 1, ..item("secret.js", b"x") }]).contains("Encrypted"));
        assert!(fail(&[Item { crc: Some(1), ..item("bad.js", b"payload") }]).contains("CRC"));
        assert!(fail(&[Item { method: 12, ..item("bz.js", b"x") }]).contains("compression method"));
        assert!(fail(&[item("a.js", b"x"), item("a.js", b"y")]).contains("a.js"));
    }

    #[test]
    fn unpack_reports_missing_changed_and_added_files() {
        let dir = TempDir::new("compare");
        let out = dir.0.join("out");
        fs::create_dir(&out).unwrap();
        let zip = make_zip(&[item("manifest.json", b"{}"), item("extra.js", b"x"), item("bg.js", b"changed")]);
        let expected = map(&[("manifest.json", b"{}"), ("bg.js", b"original"), ("gone.js", b"y")]);
        let Err(Stop::Failed(m)) = unpack(&zip, &out, "", &expected, &run()) else { panic!() };
        assert!(m.contains("changed: bg.js"), "{m}");
        assert!(m.contains("missing: gone.js"), "{m}");
        assert!(m.contains("added: extra.js"), "{m}");
        assert!(zip_entries(b"not a zip").is_err());
    }

    #[test]
    fn served_files_are_allowlisted_link_free_and_hashed_once() {
        let dir = TempDir::new("serve");
        let tree = dir.0.join("tree");
        fs::create_dir_all(tree.join("js")).unwrap();
        fs::write(tree.join("js/a.js"), b"good").unwrap();
        let good = sha(b"good");
        assert_eq!(read_verified("t1", &tree, "js/a.js", &good).as_deref(), Some(&b"good"[..]));
        // A file changed after it was first verified is still served this session (hashing
        // every request would cost too much), but a fresh tree is checked again.
        assert!(read_verified("t1", &tree, "js/a.js", &sha(b"other")).is_some());
        assert!(read_verified("t2", &tree, "js/a.js", &sha(b"other")).is_none());
        assert!(read_verified("t3", &tree, "js/missing.js", &good).is_none());
        assert!(file_without_links(&tree, "js").is_none(), "a directory is not a file");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(tree.join("js/a.js"), tree.join("link.js")).unwrap();
            assert!(file_without_links(&tree, "link.js").is_none());
            std::os::unix::fs::symlink(tree.join("js"), tree.join("dirlink")).unwrap();
            assert!(file_without_links(&tree, "dirlink/a.js").is_none());
            assert!(read_verified("t4", &tree, "link.js", &good).is_none());
        }
        // Yomitan's asset keys: exactly the pinned paths.
        assert_eq!(yomitan_path("/js/comm/api.js"), Some("js/comm/api.js"));
        assert_eq!(yomitan_path("/settings.html"), Some("settings.html"));
        for other in ["/app/main.html", "/spike/shim.js", "/ui/overlay.html", "/js/", "/", "/installed.json"] {
            assert_eq!(yomitan_path(other), None, "{other}");
        }
    }

    // ------------------------------------------------------------------ store with a fake server

    #[derive(Default)]
    struct FakeServer {
        files: HashMap<String, Vec<u8>>,
        fail: Mutex<Option<String>>,
        requests: Mutex<Vec<(String, u64)>>,
        drop_after: Mutex<Option<usize>>,
    }

    struct Chunked {
        data: Vec<u8>,
        at: usize,
        stop: Option<usize>,
    }
    impl Read for Chunked {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let end = self.stop.unwrap_or(self.data.len()).min(self.data.len());
            if self.at >= end {
                if self.stop.is_some() && self.at < self.data.len() {
                    return Err(io::Error::new(io::ErrorKind::ConnectionReset, "reset"));
                }
                return Ok(0);
            }
            let n = buf.len().min(end - self.at).min(64);
            buf[..n].copy_from_slice(&self.data[self.at..self.at + n]);
            self.at += n;
            Ok(n)
        }
    }

    impl Fetch for FakeServer {
        fn open(&self, url: &str, offset: u64) -> Result<Opened, String> {
            self.requests.lock().unwrap().push((url.into(), offset));
            if let Some(message) = self.fail.lock().unwrap().clone() {
                return Err(message);
            }
            let data = self.files.get(url).cloned().ok_or("github.com answered HTTP 404")?;
            let offset = offset as usize;
            let body = data[offset.min(data.len())..].to_vec();
            Ok(Opened::Body(Body {
                partial: offset > 0,
                length: Some(body.len() as u64),
                reader: Box::new(Chunked {
                    data: body,
                    at: 0,
                    stop: *self.drop_after.lock().unwrap(),
                }),
            }))
        }
    }

    fn demo(version: &str, items: &[(&'static str, &[u8])]) -> (Engine, Vec<u8>) {
        let zip = make_zip(&items.iter().map(|(n, d)| item(n, d)).collect::<Vec<_>>());
        let engine = Engine {
            pin: Pin {
                id: "demo".into(),
                name: "Demo".into(),
                version: version.into(),
                asset: Asset {
                    url: format!("https://github.com/demo/{version}.zip"),
                    sha256: sha(&zip),
                    size: zip.len() as u64,
                },
                unpack: Unpack::default(),
            },
            files: map(items),
        };
        (engine, zip)
    }

    fn wait_until(store: &ExtensionStore, done: impl Fn(&Phase) -> bool) -> Phase {
        let start = Instant::now();
        loop {
            let idle = store.with_slot("demo", |s| s.control.is_none()).unwrap();
            let phase = store.phase("demo");
            if idle && done(&phase) {
                return phase;
            }
            assert!(start.elapsed() < Duration::from_secs(10), "stuck in {phase:?}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn store_with(root: &Path, engine: &Engine, server: Arc<FakeServer>) -> Arc<ExtensionStore> {
        ExtensionStore::new(
            root.to_path_buf(),
            BTreeMap::from([("demo".to_string(), engine.clone())]),
            server,
        )
    }

    fn server(engine: &Engine, zip: &[u8]) -> Arc<FakeServer> {
        Arc::new(FakeServer {
            files: HashMap::from([(engine.pin.asset.url.clone(), zip.to_vec())]),
            ..Default::default()
        })
    }

    #[test]
    fn the_store_downloads_verifies_unpacks_and_records_an_engine() {
        let root = TempDir::new("store");
        let (engine, zip) = demo("1.0.0", &[("manifest.json", b"{}"), ("js/bg.js", &b"x".repeat(5000))]);
        let store = store_with(&root.0, &engine, server(&engine, &zip));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let watcher = Arc::downgrade(&store);
        store.on_change(move |id, transition| {
            if let (true, Some(store)) = (transition, watcher.upgrade()) {
                log.lock().unwrap().push(store.phase(id).name());
            }
        });
        assert_eq!(store.phase("demo"), Phase::Absent);
        store.start("demo");
        assert_eq!(wait_until(&store, |p| *p == Phase::Ready), Phase::Ready);
        let tree = root.0.join("demo/1.0.0");
        assert_eq!(store.ready_dir("demo"), Some(tree.clone()));
        assert_eq!(fs::read(tree.join("js/bg.js")).unwrap(), b"x".repeat(5000));
        // Nothing but the tree and the record is left.
        let mut left: Vec<String> = fs::read_dir(root.0.join("demo"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["1.0.0", "installed.json"]);
        let record: Value = serde_json::from_slice(&fs::read(root.0.join("demo/installed.json")).unwrap()).unwrap();
        assert_eq!(record["assetSha256"], engine.pin.asset.sha256);
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.first(), Some(&"downloading"));
        assert!(seen.contains(&"verifying"));
        assert_eq!(seen.last(), Some(&"ready"));
        // A new store over the same directory finds it ready without the network.
        let again = store_with(&root.0, &engine, Arc::new(FakeServer::default()));
        assert_eq!(again.phase("demo"), Phase::Ready);
        again.delete("demo").unwrap();
        assert_eq!(again.phase("demo"), Phase::Absent);
        assert!(!root.0.join("demo").exists());
    }

    #[test]
    fn an_offline_failure_is_reported_and_retry_resumes_from_the_part() {
        let root = TempDir::new("offline");
        let (engine, zip) = demo("2.0", &[("manifest.json", &b"m".repeat(4000))]);
        let fake = server(&engine, &zip);
        *fake.fail.lock().unwrap() = Some("network error: error sending request".into());
        let store = store_with(&root.0, &engine, fake.clone());
        store.start("demo");
        let Phase::Failed { message, .. } = wait_until(&store, |p| matches!(p, Phase::Failed { .. })) else {
            unreachable!()
        };
        assert!(message.contains("network error"), "{message}");
        let status = ExtensionStatus::new(&engine, &store.phase("demo"), false);
        assert_eq!((status.state, status.engine.as_str()), ("failed", "demo"));
        // Connection dropped half way: the part is kept, and a retry asks for the rest.
        *fake.fail.lock().unwrap() = None;
        *fake.drop_after.lock().unwrap() = Some(zip.len() / 2);
        store.start("demo");
        wait_until(&store, |p| matches!(p, Phase::Failed { .. }));
        *fake.drop_after.lock().unwrap() = None;
        store.start("demo");
        wait_until(&store, |p| *p == Phase::Ready);
        assert_eq!(fake.requests.lock().unwrap().last().unwrap().1, (zip.len() / 2) as u64);
    }

    #[test]
    fn a_release_that_differs_from_the_map_is_never_installed() {
        let root = TempDir::new("mismatch");
        let (mut engine, zip) = demo("1.0", &[("manifest.json", b"{}"), ("a.js", b"a")]);
        engine.files.insert("b.js".into(), sha(b"b"));
        let store = store_with(&root.0, &engine, server(&engine, &zip));
        store.start("demo");
        let Phase::Failed { message, .. } = wait_until(&store, |p| matches!(p, Phase::Failed { .. })) else {
            unreachable!()
        };
        assert!(message.contains("missing: b.js"), "{message}");
        assert!(!root.0.join("demo/1.0").exists());
        // No staging directory and no zip are left behind.
        let left: Vec<String> = fs::read_dir(root.0.join("demo"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn a_pin_bump_cleans_the_old_version_and_downloads_the_new_one() {
        let root = TempDir::new("bump");
        let (old, old_zip) = demo("1.0", &[("manifest.json", b"{\"v\":1}")]);
        let store = store_with(&root.0, &old, server(&old, &old_zip));
        store.start("demo");
        wait_until(&store, |p| *p == Phase::Ready);
        // The next app version pins 2.0: the old tree is not the pinned one, so not ready.
        let (new, new_zip) = demo("2.0", &[("manifest.json", b"{\"v\":2}")]);
        fs::create_dir_all(root.0.join("demo/.staging-1.0-1-2")).unwrap();
        fs::write(root.0.join("demo/0.9.zip.part"), b"stale").unwrap();
        let store = store_with(&root.0, &new, server(&new, &new_zip));
        assert_eq!(store.phase("demo"), Phase::Absent);
        let mut removed = store.clean_all();
        removed.sort();
        assert_eq!(removed, vec!["demo/.staging-1.0-1-2", "demo/0.9.zip.part", "demo/1.0"]);
        store.start("demo");
        wait_until(&store, |p| *p == Phase::Ready);
        assert_eq!(fs::read(root.0.join("demo/2.0/manifest.json")).unwrap(), b"{\"v\":2}");
        assert!(!root.0.join("demo/1.0").exists());
    }

    #[test]
    fn a_verified_zip_left_by_a_quit_is_unpacked_without_downloading_again() {
        let root = TempDir::new("leftzip");
        let (engine, zip) = demo("1.0", &[("manifest.json", b"{}")]);
        fs::create_dir_all(root.0.join("demo")).unwrap();
        fs::write(root.0.join("demo/1.0.zip"), &zip).unwrap();
        let fake = server(&engine, &zip);
        let store = store_with(&root.0, &engine, fake.clone());
        assert_eq!(store.phase("demo"), Phase::Paused { overall_received: zip.len() as u64 });
        store.start("demo");
        wait_until(&store, |p| *p == Phase::Ready);
        assert!(fake.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn pause_keeps_the_part_and_cancel_removes_everything() {
        let root = TempDir::new("pause");
        let (engine, zip) = demo("1.0", &[("manifest.json", &(0..200_000u32).map(|i| (i * 7) as u8).collect::<Vec<_>>())]);
        fs::create_dir_all(root.0.join("demo")).unwrap();
        fs::write(root.0.join("demo/1.0.zip.part"), &zip[..100]).unwrap();
        let store = store_with(&root.0, &engine, server(&engine, &zip));
        assert_eq!(store.phase("demo"), Phase::Paused { overall_received: 100 });
        store.cancel("demo").unwrap();
        assert_eq!(store.phase("demo"), Phase::Absent);
        assert!(!root.0.join("demo").exists());
        store.shutdown(Duration::from_millis(10));
        store.start("demo");
        assert_eq!(store.phase("demo"), Phase::Absent, "nothing starts once closing");
    }

    #[test]
    fn statuses_and_the_activity_feed_read_like_the_models() {
        use crate::activity::Tone;
        let (engine, _) = demo("1.0", &[("manifest.json", b"{}")]);
        let dev = ExtensionStatus::new(&engine, &Phase::Absent, true);
        assert_eq!((dev.state, dev.source), ("ready", Some("development")));
        let json = serde_json::to_value(ExtensionStatus::new(&engine, &Phase::Absent, false)).unwrap();
        assert_eq!(json["state"], "absent");
        assert_eq!(json["version"], "1.0");
        assert_eq!(json["overallTotal"], engine.pin.asset.size);
        let mut ticker = ExtensionTicker::default();
        let now = Instant::now();
        let downloading = ExtensionStatus::new(
            &engine,
            &Phase::Downloading { file: "1.0.zip".into(), received: 0, total: 9, overall_received: 0 },
            false,
        );
        assert_eq!(ticker.next(&downloading, now), Some(("Downloading Demo… 0%".into(), Tone::Busy)));
        assert_eq!(
            ticker.next(&ExtensionStatus::new(&engine, &Phase::Ready, false), now),
            Some(("Demo ready".into(), Tone::Ok))
        );
        assert_eq!(ExtensionTicker::key("tenten"), "extension:tenten");
    }

    /// The real releases through the Rust unpacker, against the compiled-in maps: run with
    /// `KIMOCHI_RELEASE_ZIPS=<dir>` holding `<id>.zip` for each pinned engine (fetched by hand
    /// from the pinned URLs). Skipped otherwise, so `cargo test` never needs the network.
    #[test]
    fn the_pinned_releases_unpack_to_exactly_their_maps() {
        let Some(dir) = std::env::var_os("KIMOCHI_RELEASE_ZIPS") else { return };
        for (id, engine) in engines() {
            let zip = fs::read(Path::new(&dir).join(format!("{id}.zip"))).unwrap();
            assert_eq!(sha(&zip), engine.pin.asset.sha256, "{id}");
            assert_eq!(zip.len() as u64, engine.pin.asset.size, "{id}");
            let out = TempDir::new(id);
            unpack(&zip, &out.0, &engine.pin.unpack.strip_prefix, &engine.files, &run()).unwrap();
        }
    }
}
