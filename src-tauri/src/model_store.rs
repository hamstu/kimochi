//! Local models, downloaded on demand instead of bundled: the OCR engines' and sentence audio's
//! speech recogniser (SenseVoice, `sentence_audio`).
//!
//! The ONNX Runtime libraries stay in the app bundle (they are native code that has to
//! be signed with it); the model files do not. They are listed, pinned by revision,
//! SHA-256 and size, in `src-tauri/ocr-models.json`, which is compiled in here and read
//! by the `prepare-*` scripts when a developer stages models locally.
//!
//! # Layout
//!
//! ```text
//! <app local data>/models/
//!   meikiocr/  meiki.text.detect.v0.1.960x544.onnx ... verified.json
//!   mangaocr/  pytorch_model.bin ... pytorch_model.bin.part  verified.json
//!   ppocr/  PP-OCRv6_small_det.onnx  PP-OCRv6_small_rec.onnx  PP-OCRv6_small_rec.yml  verified.json
//!   sensevoice/  model.int8.onnx  tokens.txt  verified.json
//! ```
//!
//! A file is only ever written as `<name>.part`; it reaches its final name by an atomic
//! rename after its size and SHA-256 have been checked, so a final path never holds a
//! partial file. `verified.json` records the SHA-256 each final file was verified
//! against, so start-up can tell "ready" from "left over from another revision"
//! without hashing hundreds of megabytes.
//!
//! # Resolution
//!
//! `models_dir` answers, in order: the downloaded store when it is complete and
//! verified, the bundle's resource directory (builds that still bundle models), then the
//! `CARGO_MANIFEST_DIR/resources` development fallback.
//!
//! # State machine (per engine)
//!
//! ```text
//! absent --start--> downloading --(per file)--> verifying --> ... --> ready
//!   ^                 |   |                                            |
//!   |              pause  error                                        |
//!   |                 v   v                                            |
//!   +---cancel---- paused / failed --resume/retry--> downloading       |
//!   +------------------------------------delete------------------------+
//! ```
//!
//! One worker thread per engine at most; it checks its control flag between chunks, so
//! pause and cancel take effect within one read. Quitting pauses every worker, which
//! keeps its `.part` files; the next launch finds them and reports `paused`.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

const MANIFEST_JSON: &str = include_str!("../ocr-models.json");
/// Per-engine record of which final files were verified, and against which SHA-256.
const MARKER: &str = "verified.json";
/// How often progress is reported while bytes arrive (about four times a second).
pub(crate) const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

// ---------------------------------------------------------------------------- manifest

/// One model file, pinned.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ModelFile {
    pub name: String,
    #[allow(dead_code)] // provenance, read by the prepare scripts
    pub repository: String,
    #[allow(dead_code)]
    pub revision: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

/// The files one engine needs.
#[derive(Debug, Clone, Deserialize)]
pub struct EngineModels {
    pub name: String,
    pub files: Vec<ModelFile>,
}

impl EngineModels {
    pub fn total_size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    engines: BTreeMap<String, EngineModels>,
}

impl Manifest {
    /// Parse and check a manifest: every engine present, every file name a plain file
    /// name (it becomes a path), every checksum 64 lowercase hex digits, every size known.
    pub fn parse(json: &str) -> Result<Self, String> {
        let manifest: Manifest = serde_json::from_str(json).map_err(|e| e.to_string())?;
        for engine in Engine::ALL {
            let models = manifest
                .engines
                .get(engine.key())
                .ok_or_else(|| format!("no models listed for {}", engine.key()))?;
            if models.files.is_empty() {
                return Err(format!("no files listed for {}", engine.key()));
            }
            for file in &models.files {
                let plain = !file.name.is_empty()
                    && !file.name.contains(['/', '\\'])
                    && file.name != "."
                    && file.name != ".."
                    && file.name != MARKER;
                if !plain {
                    return Err(format!("{:?} is not a plain file name", file.name));
                }
                let hex = file.sha256.len() == 64
                    && file
                        .sha256
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
                if !hex {
                    return Err(format!("{} has no valid SHA-256", file.name));
                }
                if file.size == 0 {
                    return Err(format!("{} has no size", file.name));
                }
                if !file.url.starts_with("https://") {
                    return Err(format!("{} is not served over HTTPS", file.name));
                }
            }
        }
        Ok(manifest)
    }

    pub fn engine(&self, engine: Engine) -> &EngineModels {
        &self.engines[engine.key()]
    }
}

/// The compiled-in manifest (`src-tauri/ocr-models.json`).
pub fn manifest() -> &'static Manifest {
    static MANIFEST: OnceLock<Manifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        Manifest::parse(MANIFEST_JSON).expect("src-tauri/ocr-models.json is checked by the tests")
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Engine {
    Meiki,
    Manga,
    PpOcr,
    /// Sentence audio's speech recogniser: not an OCR engine, never an `ocrMode`.
    SenseVoice,
}

impl Engine {
    pub const ALL: [Engine; 4] = [Engine::Meiki, Engine::Manga, Engine::PpOcr, Engine::SenseVoice];
    /// The OCR engines among them.
    pub const OCR: [Engine; 3] = [Engine::Meiki, Engine::Manga, Engine::PpOcr];

    /// The `ocrMode` setting value (OCR engines), the directory name and the manifest key.
    pub fn key(self) -> &'static str {
        match self {
            Engine::Meiki => "meikiocr",
            Engine::Manga => "mangaocr",
            Engine::PpOcr => "ppocr",
            Engine::SenseVoice => "sensevoice",
        }
    }

    /// An engine by its key; `local` is the retired name for MeikiOCR.
    pub fn from_key(key: &str) -> Option<Self> {
        match key {
            "meikiocr" | "local" => Some(Engine::Meiki),
            "mangaocr" => Some(Engine::Manga),
            "ppocr" => Some(Engine::PpOcr),
            "sensevoice" => Some(Engine::SenseVoice),
            _ => None,
        }
    }

    /// An `ocrMode` value naming an OCR engine.
    pub fn from_ocr_mode(mode: &str) -> Option<Self> {
        Self::from_key(mode).filter(|e| Self::OCR.contains(e))
    }
}

// ---------------------------------------------------------------------------- state

/// Where an engine's download stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    Absent,
    Downloading {
        file: String,
        received: u64,
        total: u64,
        overall_received: u64,
    },
    Paused {
        overall_received: u64,
    },
    Failed {
        message: String,
        overall_received: u64,
    },
    Verifying {
        file: String,
        overall_received: u64,
    },
    Ready,
}

impl Phase {
    pub fn name(&self) -> &'static str {
        match self {
            Phase::Absent => "absent",
            Phase::Downloading { .. } => "downloading",
            Phase::Paused { .. } => "paused",
            Phase::Failed { .. } => "failed",
            Phase::Verifying { .. } => "verifying",
            Phase::Ready => "ready",
        }
    }

    pub(crate) fn overall_received(&self, overall_total: u64) -> u64 {
        match self {
            Phase::Absent => 0,
            Phase::Ready => overall_total,
            Phase::Downloading {
                overall_received, ..
            }
            | Phase::Paused { overall_received }
            | Phase::Failed {
                overall_received, ..
            }
            | Phase::Verifying {
                overall_received, ..
            } => *overall_received,
        }
    }
}

/// Whole percent, rounded down so "100%" only ever means done.
pub fn percent(received: u64, total: u64) -> u64 {
    if total == 0 {
        return 0;
    }
    (u128::from(received.min(total)) * 100 / u128::from(total)) as u64
}

/// Why an engine whose models are in this phase cannot scan; `None` when ready.
/// This is the `ocrEngines.<engine>.reason` the capabilities report.
pub fn reason(phase: &Phase, overall_total: u64) -> Option<String> {
    Some(match phase {
        Phase::Ready => return None,
        Phase::Absent => "Model not downloaded".into(),
        Phase::Downloading {
            overall_received, ..
        } => format!(
            "Downloading model… {}%",
            percent(*overall_received, overall_total)
        ),
        Phase::Verifying { .. } => "Verifying model…".into(),
        Phase::Paused { .. } => "Model download paused".into(),
        Phase::Failed { message, .. } => format!("Model download failed: {message}"),
    })
}

/// Where usable models were found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Downloaded,
    Bundled,
    Development,
}

impl Source {
    fn key(self) -> &'static str {
        match self {
            Source::Downloaded => "downloaded",
            Source::Bundled => "bundled",
            Source::Development => "development",
        }
    }
}

/// The `model_status` reply and the `model-download` event payload.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub engine: &'static str,
    pub name: String,
    /// absent | downloading | paused | failed | verifying | ready
    pub state: &'static str,
    /// Where ready models live: downloaded | bundled | development.
    pub source: Option<&'static str>,
    /// The file being downloaded or verified.
    pub file: Option<String>,
    pub received_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub overall_received: u64,
    pub overall_total: u64,
    /// The failure, when failed.
    pub message: Option<String>,
}

impl ModelStatus {
    /// The status for a store phase. Models found outside the store (`fallback`) make an
    /// engine with nothing downloaded `ready`.
    pub fn new(
        engine: Engine,
        models: &EngineModels,
        phase: &Phase,
        fallback: Option<Source>,
    ) -> Self {
        let overall_total = models.total_size();
        let (phase, source) = match (phase, fallback) {
            (Phase::Ready, _) => (&Phase::Ready, Some(Source::Downloaded)),
            (Phase::Absent, Some(source)) => (&Phase::Ready, Some(source)),
            (phase, _) => (phase, None),
        };
        let mut status = ModelStatus {
            engine: engine.key(),
            name: models.name.clone(),
            state: phase.name(),
            source: source.map(Source::key),
            file: None,
            received_bytes: None,
            total_bytes: None,
            overall_received: phase.overall_received(overall_total),
            overall_total,
            message: None,
        };
        match phase {
            Phase::Downloading {
                file,
                received,
                total,
                ..
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

// ---------------------------------------------------------------------------- disk

pub(crate) fn part_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.part"))
}

/// Whether every file is present in `dir`. Used for bundled and development models,
/// which are trusted as staged (the prepare scripts verified them).
pub fn complete(dir: &Path, files: &[ModelFile]) -> bool {
    files.iter().all(|f| dir.join(&f.name).is_file())
}

/// The first complete directory: the ready store, then each fallback in order.
pub fn resolve(
    store: Option<PathBuf>,
    fallbacks: &[(Source, PathBuf)],
    files: &[ModelFile],
) -> Option<(PathBuf, Source)> {
    store
        .map(|dir| (dir, Source::Downloaded))
        .into_iter()
        .chain(fallbacks.iter().map(|(source, dir)| (dir.clone(), *source)))
        .find(|(dir, _)| complete(dir, files))
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Marker {
    /// File name -> the SHA-256 it was verified against.
    files: BTreeMap<String, String>,
}

fn read_marker(dir: &Path) -> Marker {
    fs::read(dir.join(MARKER))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_marker(dir: &Path, marker: &Marker) -> io::Result<()> {
    let target = dir.join(MARKER);
    let staged = dir.join(format!("{MARKER}.tmp"));
    fs::write(
        &staged,
        serde_json::to_vec_pretty(marker).map_err(io::Error::other)?,
    )?;
    // std's rename replaces an existing file on every platform (MoveFileExW on Windows).
    fs::rename(staged, target)
}

/// A final file that was verified against this manifest entry and still has its size.
fn verified(dir: &Path, file: &ModelFile, marker: &Marker) -> bool {
    marker.files.get(&file.name) == Some(&file.sha256)
        && fs::metadata(dir.join(&file.name)).is_ok_and(|m| m.is_file() && m.len() == file.size)
}

/// The store's phase as found on disk at start-up: `ready` when every file is verified,
/// `paused` when anything was downloaded, `absent` otherwise.
pub fn scan_disk(dir: &Path, files: &[ModelFile]) -> Phase {
    let marker = read_marker(dir);
    let (mut all, mut any, mut received) = (true, false, 0u64);
    for file in files {
        if verified(dir, file, &marker) {
            any = true;
            received += file.size;
        } else {
            all = false;
            if let Ok(meta) = fs::metadata(part_path(dir, &file.name)) {
                any = true;
                received += meta.len().min(file.size);
            }
        }
    }
    match (all, any) {
        (true, _) => Phase::Ready,
        (false, true) => Phase::Paused {
            overall_received: received,
        },
        (false, false) => Phase::Absent,
    }
}

pub(crate) fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

pub(crate) fn remove_dir(dir: &Path) -> io::Result<()> {
    match fs::remove_dir_all(dir) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------- transfer

/// An opened response body.
pub struct Body {
    /// 206: the body starts at the requested offset. 200: it starts at zero.
    pub partial: bool,
    /// Content-Length, when the server sent one.
    pub length: Option<u64>,
    pub reader: Box<dyn Read + Send>,
}

pub enum Opened {
    Body(Body),
    /// 416: the requested offset is past what the server has.
    RangeNotSatisfiable,
}

/// The network, behind a seam so the tests never touch it.
pub trait Fetch: Send + Sync {
    /// GET `url`, from `offset` when it is non-zero.
    fn open(&self, url: &str, offset: u64) -> Result<Opened, String>;
}

/// `reqwest`'s blocking client, already a dependency (the cloud OCR request uses it).
/// Built lazily on a worker thread: a blocking client must not be created inside the
/// async runtime.
#[derive(Default)]
pub struct HttpFetch {
    client: OnceLock<Result<reqwest::blocking::Client, String>>,
}

impl Fetch for HttpFetch {
    fn open(&self, url: &str, offset: u64) -> Result<Opened, String> {
        let client = self
            .client
            .get_or_init(|| {
                reqwest::blocking::Client::builder()
                    .user_agent(concat!(
                        "Kimochi/",
                        env!("CARGO_PKG_VERSION"),
                        " (model download)"
                    ))
                    .connect_timeout(Duration::from_secs(15))
                    // Applies to the response headers and to each body read, not the whole file.
                    .timeout(Duration::from_secs(30))
                    .build()
                    .map_err(|e| format!("could not start the HTTP client: {e}"))
            })
            .as_ref()
            .map_err(Clone::clone)?;
        let mut request = client.get(url);
        if offset > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
        }
        let response = request
            .send()
            .map_err(|e| format!("network error: {}", e.without_url()))?;
        let status = response.status();
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            return Ok(Opened::RangeNotSatisfiable);
        }
        if !status.is_success() {
            let host = response
                .url()
                .host_str()
                .unwrap_or("the server")
                .to_string();
            return Err(format!("{host} answered HTTP {}", status.as_u16()));
        }
        Ok(Opened::Body(Body {
            partial: status == reqwest::StatusCode::PARTIAL_CONTENT,
            length: response.content_length(),
            reader: Box::new(response),
        }))
    }
}

pub(crate) const RUN: u8 = 0;
pub(crate) const PAUSE: u8 = 1;
pub(crate) const CANCEL: u8 = 2;

/// Why a download stopped before its engine was ready.
#[derive(Debug, PartialEq, Eq)]
pub enum Stop {
    Paused,
    Cancelled,
    Failed(String),
}

/// What a file download reports as it goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Progress {
    /// Bytes of this file now in its `.part`.
    Bytes(u64),
    Verifying,
}

/// Where to resume a file from: the `.part` length, unless it is longer than the file
/// can be (then it is not a prefix of this file and the download starts over).
pub fn resume_offset(part_len: Option<u64>, expected: u64) -> u64 {
    match part_len {
        Some(len) if len <= expected => len,
        _ => 0,
    }
}

fn open_body(fetch: &dyn Fetch, file: &ModelFile, offset: &mut u64) -> Result<Body, Stop> {
    let failed = |e: String| Stop::Failed(format!("could not download {}: {e}", file.name));
    let body = match fetch.open(&file.url, *offset).map_err(failed)? {
        Opened::Body(body) => body,
        Opened::RangeNotSatisfiable => {
            // The partial file does not match what the server has: start over.
            *offset = 0;
            match fetch.open(&file.url, 0).map_err(failed)? {
                Opened::Body(body) => body,
                Opened::RangeNotSatisfiable => {
                    return Err(Stop::Failed(format!(
                        "the server refused to send {}",
                        file.name
                    )))
                }
            }
        }
    };
    if *offset > 0 && !body.partial {
        // The server ignored the range and is sending the whole file.
        *offset = 0;
    }
    Ok(body)
}

/// Download one file into `<dir>/<name>.part`, resuming what is there, then verify it
/// and rename it into place. Any failure leaves the final path untouched.
pub fn download_file(
    fetch: &dyn Fetch,
    dir: &Path,
    file: &ModelFile,
    control: &AtomicU8,
    progress: &mut dyn FnMut(Progress),
) -> Result<(), Stop> {
    let part = part_path(dir, &file.name);
    let io_failed =
        |action: &str, e: io::Error| Stop::Failed(format!("could not {action} {}: {e}", file.name));
    let mut offset = resume_offset(fs::metadata(&part).ok().map(|m| m.len()), file.size);
    if offset < file.size {
        let mut body = open_body(fetch, file, &mut offset)?;
        if let Some(length) = body.length {
            if offset + length != file.size {
                return Err(Stop::Failed(format!(
                    "the server offered {} bytes of {}, expected {}",
                    offset + length,
                    file.name,
                    file.size
                )));
            }
        }
        let mut out = if offset == 0 {
            File::create(&part)
        } else {
            OpenOptions::new().append(true).open(&part)
        }
        .map_err(|e| io_failed("write", e))?;
        progress(Progress::Bytes(offset));
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            match control.load(Ordering::SeqCst) {
                PAUSE => return Err(Stop::Paused),
                CANCEL => return Err(Stop::Cancelled),
                _ => {}
            }
            let n = match body.reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    return Err(Stop::Failed(format!(
                        "the connection was interrupted while downloading {} ({e})",
                        file.name
                    )))
                }
            };
            if offset + n as u64 > file.size {
                drop(out);
                let _ = fs::remove_file(&part);
                return Err(Stop::Failed(format!(
                    "{} is larger than expected; the download was discarded",
                    file.name
                )));
            }
            out.write_all(&buffer[..n])
                .map_err(|e| io_failed("write", e))?;
            offset += n as u64;
            progress(Progress::Bytes(offset));
        }
        out.sync_all().map_err(|e| io_failed("write", e))?;
        if offset < file.size {
            return Err(Stop::Failed(format!(
                "the connection closed after {offset} of {} bytes of {}",
                file.size, file.name
            )));
        }
    }
    progress(Progress::Verifying);
    let size = fs::metadata(&part).map_err(|e| io_failed("read", e))?.len();
    if size != file.size {
        let _ = fs::remove_file(&part);
        return Err(Stop::Failed(format!(
            "{} is {size} bytes, expected {}; the download was discarded",
            file.name, file.size
        )));
    }
    let digest = sha256_file(&part).map_err(|e| io_failed("verify", e))?;
    if digest != file.sha256 {
        let _ = fs::remove_file(&part);
        return Err(Stop::Failed(format!(
            "{} did not match its checksum; the download was discarded",
            file.name
        )));
    }
    fs::rename(&part, dir.join(&file.name)).map_err(|e| io_failed("install", e))
}

// ---------------------------------------------------------------------------- store

type Notify = Arc<dyn Fn(Engine, bool) + Send + Sync>;

struct Slot {
    phase: Phase,
    /// Present while a worker runs; set to PAUSE or CANCEL to stop it.
    control: Option<Arc<AtomicU8>>,
}

/// The per-engine download state machines over one store directory.
pub struct ModelStore {
    root: PathBuf,
    manifest: Manifest,
    fetch: Arc<dyn Fetch>,
    slots: Mutex<HashMap<Engine, Slot>>,
    /// Called (never under the slot lock) with `transition = true` for state changes
    /// and `false` for throttled progress.
    notify: OnceLock<Notify>,
    closing: AtomicBool,
}

impl ModelStore {
    pub fn new(root: PathBuf, manifest: Manifest, fetch: Arc<dyn Fetch>) -> Arc<Self> {
        Arc::new(Self {
            root,
            manifest,
            fetch,
            slots: Mutex::new(HashMap::new()),
            notify: OnceLock::new(),
            closing: AtomicBool::new(false),
        })
    }

    pub fn on_change(&self, notify: impl Fn(Engine, bool) + Send + Sync + 'static) {
        let _ = self.notify.set(Arc::new(notify));
    }

    pub fn dir(&self, engine: Engine) -> PathBuf {
        self.root.join(engine.key())
    }

    pub fn models(&self, engine: Engine) -> &EngineModels {
        self.manifest.engine(engine)
    }

    fn with_slot<R>(&self, engine: Engine, f: impl FnOnce(&mut Slot) -> R) -> R {
        let mut slots = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        let slot = slots.entry(engine).or_insert_with(|| Slot {
            phase: scan_disk(&self.dir(engine), &self.models(engine).files),
            control: None,
        });
        f(slot)
    }

    fn emit(&self, engine: Engine, transition: bool) {
        if let Some(notify) = self.notify.get() {
            notify(engine, transition);
        }
    }

    pub fn phase(&self, engine: Engine) -> Phase {
        self.with_slot(engine, |slot| slot.phase.clone())
    }

    /// The store directory when its models are ready and still all present.
    pub fn ready_dir(&self, engine: Engine) -> Option<PathBuf> {
        let dir = self.dir(engine);
        (self.phase(engine) == Phase::Ready && complete(&dir, &self.models(engine).files))
            .then_some(dir)
    }

    /// Start (or resume, or retry) a download. A no-op while one runs or once ready.
    pub fn start(self: &Arc<Self>, engine: Engine) {
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        let control = self.with_slot(engine, |slot| {
            if let Some(control) = &slot.control {
                // A worker asked to pause or cancel that has not stopped yet carries on.
                control.store(RUN, Ordering::SeqCst);
                return None;
            }
            if slot.phase == Phase::Ready {
                return None;
            }
            let total = self.models(engine).total_size();
            let control = Arc::new(AtomicU8::new(RUN));
            slot.control = Some(control.clone());
            slot.phase = Phase::Downloading {
                file: self.models(engine).files[0].name.clone(),
                received: 0,
                total: 0,
                overall_received: slot.phase.overall_received(total),
            };
            Some(control)
        });
        let Some(control) = control else { return };
        self.emit(engine, true);
        let store = self.clone();
        let worker = control.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("kimochi-{}-download", engine.key()))
            .spawn(move || {
                let outcome = store.download(engine, &worker);
                store.finish(engine, &worker, outcome);
            });
        if let Err(e) = spawned {
            self.finish(
                engine,
                &control,
                Err(Stop::Failed(format!("could not start the download: {e}"))),
            );
        }
    }

    /// Pause a running download, keeping what has arrived.
    pub fn pause(&self, engine: Engine) {
        self.with_slot(engine, |slot| {
            if let Some(control) = &slot.control {
                control.store(PAUSE, Ordering::SeqCst);
            }
        });
    }

    /// Stop any download and remove everything downloaded for this engine, unless it is
    /// ready (that is `delete`).
    pub fn cancel(&self, engine: Engine) -> Result<(), String> {
        if self.phase(engine) == Phase::Ready {
            return Ok(());
        }
        self.discard(engine)
    }

    /// Stop any download and remove the engine's models, ready or not.
    pub fn delete(&self, engine: Engine) -> Result<(), String> {
        self.discard(engine)
    }

    fn discard(&self, engine: Engine) -> Result<(), String> {
        let dir = self.dir(engine);
        let result = self.with_slot(engine, |slot| {
            if let Some(control) = &slot.control {
                // The worker removes the files itself as it stops, so nothing is
                // deleted underneath a file it still has open.
                control.store(CANCEL, Ordering::SeqCst);
                return Ok(());
            }
            let removed = remove_dir(&dir);
            slot.phase = scan_disk(&dir, &self.models(engine).files);
            removed.map_err(|e| format!("could not remove {}: {e}", dir.display()))
        });
        self.emit(engine, true);
        result
    }

    /// Ask every worker to pause, then wait up to `wait` for them to stop. Their
    /// `.part` files are kept, so the next launch reports `paused`.
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

    fn set_phase(&self, engine: Engine, phase: Phase, transition: bool) {
        self.with_slot(engine, |slot| slot.phase = phase);
        self.emit(engine, transition);
    }

    /// The worker: every file not already verified, in manifest order.
    fn download(&self, engine: Engine, control: &AtomicU8) -> Result<(), Stop> {
        let dir = self.dir(engine);
        fs::create_dir_all(&dir)
            .map_err(|e| Stop::Failed(format!("could not create {}: {e}", dir.display())))?;
        let mut marker = read_marker(&dir);
        let mut done = 0u64;
        let mut last: Option<Instant> = None;
        for file in &self.models(engine).files {
            if verified(&dir, file, &marker) {
                done += file.size;
                continue;
            }
            // Not verified against this manifest: a file from another revision, or one
            // put there by hand. It is replaced, never trusted.
            if marker.files.remove(&file.name).is_some() {
                let _ = write_marker(&dir, &marker);
            }
            let _ = fs::remove_file(dir.join(&file.name));
            let mut progress = |event: Progress| {
                let (phase, transition) = match event {
                    Progress::Bytes(received) => (
                        Phase::Downloading {
                            file: file.name.clone(),
                            received,
                            total: file.size,
                            overall_received: done + received,
                        },
                        false,
                    ),
                    Progress::Verifying => (
                        Phase::Verifying {
                            file: file.name.clone(),
                            overall_received: done + file.size,
                        },
                        true,
                    ),
                };
                let due = match last {
                    Some(at) => at.elapsed() >= PROGRESS_INTERVAL,
                    None => true,
                };
                if transition || due {
                    last = Some(Instant::now());
                    self.set_phase(engine, phase, transition);
                }
            };
            download_file(self.fetch.as_ref(), &dir, file, control, &mut progress)?;
            marker.files.insert(file.name.clone(), file.sha256.clone());
            write_marker(&dir, &marker)
                .map_err(|e| Stop::Failed(format!("could not record {}: {e}", file.name)))?;
            done += file.size;
        }
        Ok(())
    }

    /// Record how the worker ended. Runs on the worker thread.
    fn finish(self: &Arc<Self>, engine: Engine, control: &AtomicU8, outcome: Result<(), Stop>) {
        let dir = self.dir(engine);
        let files = &self.models(engine).files;
        let restart = self.with_slot(engine, |slot| {
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
                Err(Stop::Paused) => match scan_disk(&dir, files) {
                    Phase::Paused { overall_received } => Phase::Paused { overall_received },
                    // Paused before a byte arrived.
                    _ => Phase::Paused {
                        overall_received: 0,
                    },
                },
                Err(Stop::Failed(message)) => Phase::Failed {
                    message,
                    overall_received: scan_disk(&dir, files)
                        .overall_received(self.models(engine).total_size()),
                },
            };
            // `start` cleared a pause or cancel the worker had already acted on.
            stopped && control.load(Ordering::SeqCst) == RUN
        });
        self.emit(engine, true);
        if restart {
            self.start(engine);
        }
    }
}

// ---------------------------------------------------------------------------- activity

/// Shortest gap between two progress posts to the activity feed.
const ACTIVITY_PROGRESS_INTERVAL: Duration = Duration::from_secs(1);

/// What the activity feed hears about one engine's download: each state change once, and
/// progress at most once a second. The `model-download` event is far chattier (every 250 ms)
/// because the settings card draws a bar from it; the feed is read, not watched.
#[derive(Default)]
pub struct ModelTicker {
    state: Option<&'static str>,
    percent: u64,
    posted: Option<Instant>,
}

impl ModelTicker {
    /// The feed key for an engine's download, so progress settles into its outcome.
    pub fn key(engine: Engine) -> String {
        format!("model:{}", engine.key())
    }

    /// The post this status calls for, if any.
    pub fn next(
        &mut self,
        status: &ModelStatus,
        now: Instant,
    ) -> Option<(String, crate::activity::Tone)> {
        use crate::activity::Tone;
        let name = format!("{} model", status.name);
        let pct = percent(status.overall_received, status.overall_total);
        let previous = self.state.replace(status.state);
        let changed = previous != Some(status.state);
        let post = match status.state {
            "downloading" => {
                let due = self
                    .posted
                    .is_none_or(|at| now.duration_since(at) >= ACTIVITY_PROGRESS_INTERVAL);
                (changed || (due && pct != self.percent))
                    .then(|| (format!("Downloading {name}… {pct}%"), Tone::Busy))
            }
            _ if !changed => None,
            "verifying" => Some((format!("Verifying {name}…"), Tone::Busy)),
            // Only a download finishing is news; an engine found ready is not.
            "ready" => previous
                .is_some()
                .then(|| (format!("{name} ready"), Tone::Ok)),
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

// ---------------------------------------------------------------------------- app glue

/// The model directories outside the store, in resolution order.
fn fallbacks(app: &tauri::AppHandle, engine: Engine) -> Vec<(Source, PathBuf)> {
    use tauri::Manager;
    let mut dirs = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        dirs.push((Source::Bundled, resources.join(engine.key()).join("models")));
    }
    dirs.push((
        Source::Development,
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(engine.key())
            .join("models"),
    ));
    dirs
}

fn store(app: &tauri::AppHandle) -> Option<Arc<ModelStore>> {
    use tauri::Manager;
    app.try_state::<Arc<ModelStore>>()
        .map(|s| s.inner().clone())
}

/// Create the store under `<app local data>/models` and announce its changes.
///
/// The local data directory is the app data directory on macOS and Linux; on Windows it
/// is `%LOCALAPPDATA%` rather than the roaming profile, which must not carry 500 MB.
pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    let store = ModelStore::new(root, manifest().clone(), Arc::new(HttpFetch::default()));
    let handle = app.clone();
    let announced: Mutex<Option<Instant>> = Mutex::new(None);
    let tickers: Mutex<HashMap<Engine, ModelTicker>> = Mutex::new(HashMap::new());
    store.on_change(move |engine, transition| {
        let current = status(&handle, engine);
        let post = tickers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(engine)
            .or_default()
            .next(&current, Instant::now());
        if let Some((text, tone)) = post {
            crate::activity::post(&handle, &text, tone, Some(&ModelTicker::key(engine)));
        }
        let _ = handle.emit("model-download", current);
        // The capabilities carry the gate's reason ("Downloading model… 32%"): re-announce
        // them on every state change, and about once a second while bytes arrive.
        let due = {
            let mut last = announced.lock().unwrap_or_else(|p| p.into_inner());
            let due = transition || last.is_none_or(|at| at.elapsed() >= Duration::from_secs(1));
            if due {
                *last = Some(Instant::now());
            }
            due
        };
        if due {
            if let Some(service) = handle.try_state::<crate::state::Shared>() {
                let payload = crate::capabilities_value(&handle, service.inner());
                let _ = handle.emit("platform-capabilities", payload);
            }
        }
    });
    app.manage(store);
    Ok(())
}

/// The directory to load an engine's models from, or why it cannot scan yet.
pub fn models_dir(app: &tauri::AppHandle, engine: Engine) -> Result<PathBuf, String> {
    let models = manifest().engine(engine);
    let store = store(app);
    let ready = store.as_ref().and_then(|s| s.ready_dir(engine));
    if let Some((dir, _)) = resolve(ready, &fallbacks(app, engine), &models.files) {
        return Ok(dir);
    }
    let phase = store.map_or(Phase::Absent, |s| s.phase(engine));
    // A store that says ready but lost a file is reported as not downloaded.
    let phase = if phase == Phase::Ready {
        Phase::Absent
    } else {
        phase
    };
    Err(reason(&phase, models.total_size()).unwrap_or_default())
}

/// The model state when it is what keeps an engine from scanning, for the capabilities'
/// `ocrEngines.<engine>.model`; `None` when its models are usable.
pub fn gate(app: &tauri::AppHandle, engine: Engine) -> Option<&'static str> {
    models_dir(app, engine)
        .err()
        .map(|_| status(app, engine).state)
}

/// The status the UI shows.
pub fn status(app: &tauri::AppHandle, engine: Engine) -> ModelStatus {
    let models = manifest().engine(engine);
    let store = store(app);
    let phase = store.as_ref().map_or(Phase::Absent, |s| s.phase(engine));
    let fallback = match phase {
        Phase::Absent => resolve(None, &fallbacks(app, engine), &models.files).map(|(_, s)| s),
        _ => None,
    };
    // A ready store missing a file (removed by hand) is not ready.
    let phase = match (&phase, &store) {
        (Phase::Ready, Some(store)) if store.ready_dir(engine).is_none() => Phase::Absent,
        _ => phase,
    };
    ModelStatus::new(engine, models, &phase, fallback)
}

/// Selecting a local engine whose models are missing starts their download, unless one
/// was paused or failed (the UI offers Resume or Retry instead). Called from `settings_set`
/// only, which the pickers reach after the user confirms the download; never at launch.
pub fn on_engine_selected(app: &tauri::AppHandle, mode: &str) {
    let Some(engine) = Engine::from_ocr_mode(mode) else {
        return;
    };
    if models_dir(app, engine).is_ok() {
        return;
    }
    if let Some(store) = store(app) {
        if store.phase(engine) == Phase::Absent {
            // Off the caller's thread (the main thread, for `settings_set` and setup): starting
            // announces the new capabilities, which takes the capture and observer locks.
            let _ = std::thread::Builder::new()
                .name("kimochi-model-start".into())
                .spawn(move || store.start(engine));
        }
    }
}

/// Start the download if nothing has been downloaded yet; for callers that need the
/// models whatever engine is selected (the Windows/Linux automatic-scan observer).
pub fn ensure_started(app: &tauri::AppHandle, engine: Engine) {
    if let Some(store) = store(app) {
        if store.phase(engine) == Phase::Absent {
            store.start(engine);
        }
    }
}

/// Pause every download before the process exits.
pub fn shutdown(app: &tauri::AppHandle) {
    if let Some(store) = store(app) {
        store.shutdown(Duration::from_secs(1));
    }
}

fn engine_arg(engine: &str) -> Result<Engine, String> {
    Engine::from_key(engine).ok_or_else(|| format!("invalid: unknown model {engine}"))
}

/// Run one store operation off the async runtime (it may delete files, and it announces the
/// new capabilities, which takes the capture and observer locks), then answer the status.
async fn act(
    app: tauri::AppHandle,
    engine: String,
    operation: impl FnOnce(&tauri::AppHandle, Arc<ModelStore>, Engine) -> Result<(), String>
        + Send
        + 'static,
) -> Result<ModelStatus, String> {
    let engine = engine_arg(&engine)?;
    let store = store(&app).ok_or_else(|| "native: the model store is not running".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        operation(&app, store, engine).map_err(|e| format!("native: {e}"))?;
        Ok(status(&app, engine))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn model_status(app: tauri::AppHandle, engine: String) -> Result<ModelStatus, String> {
    Ok(status(&app, engine_arg(&engine)?))
}

#[tauri::command]
pub async fn model_download_start(
    app: tauri::AppHandle,
    engine: String,
) -> Result<ModelStatus, String> {
    act(app, engine, |_, store, engine| {
        store.start(engine);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn model_download_resume(
    app: tauri::AppHandle,
    engine: String,
) -> Result<ModelStatus, String> {
    model_download_start(app, engine).await
}

#[tauri::command]
pub async fn model_download_retry(
    app: tauri::AppHandle,
    engine: String,
) -> Result<ModelStatus, String> {
    model_download_start(app, engine).await
}

#[tauri::command]
pub async fn model_download_pause(
    app: tauri::AppHandle,
    engine: String,
) -> Result<ModelStatus, String> {
    act(app, engine, |_, store, engine| {
        store.pause(engine);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn model_download_cancel(
    app: tauri::AppHandle,
    engine: String,
) -> Result<ModelStatus, String> {
    act(app, engine, |_, store, engine| store.cancel(engine)).await
}

#[tauri::command]
pub async fn model_delete(app: tauri::AppHandle, engine: String) -> Result<ModelStatus, String> {
    act(app, engine, |app, store, engine| {
        // Loaded sessions keep their files open (and on Windows, undeletable): drop them first.
        match engine {
            Engine::Meiki => {
                crate::meiki_ocr::unload(app);
                // The Windows/Linux automatic-scan observer owns a second MeikiOCR engine.
                #[cfg(not(target_os = "macos"))]
                {
                    use tauri::Manager;
                    if let Some(service) = app.try_state::<crate::state::Shared>() {
                        if let Ok(mut observer) = service.observer.lock() {
                            observer.close();
                        }
                    }
                }
            }
            Engine::Manga => crate::manga_ocr::unload(app),
            Engine::PpOcr => crate::pp_ocr::unload(app),
            Engine::SenseVoice => crate::sentence_audio::unload_model(app),
        }
        store.delete(engine)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// A unique, empty directory under the system temp dir, removed on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "kimochi-model-store-{tag}-{}-{}",
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

    fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    fn file(name: &str, content: &[u8]) -> ModelFile {
        ModelFile {
            name: name.into(),
            repository: "test/repo".into(),
            revision: "0".into(),
            url: format!("https://models.test/{name}"),
            sha256: sha(content),
            size: content.len() as u64,
        }
    }

    /// How the fake server misbehaves.
    #[derive(Default, Clone)]
    struct Quirks {
        /// Answer 200 with the whole body even when a range is asked for.
        ignore_range: bool,
        /// Close the connection after this many bytes of a response.
        drop_after: Option<usize>,
        /// Serve this instead of the real content.
        corrupt: bool,
    }

    #[derive(Default)]
    struct FakeServer {
        files: HashMap<String, Vec<u8>>,
        quirks: Mutex<Quirks>,
        /// Every (url, offset) requested.
        requests: Mutex<Vec<(String, u64)>>,
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
            // Small chunks, so control checks between reads are exercised.
            let n = buf.len().min(end - self.at).min(7);
            buf[..n].copy_from_slice(&self.data[self.at..self.at + n]);
            self.at += n;
            Ok(n)
        }
    }

    impl Fetch for FakeServer {
        fn open(&self, url: &str, offset: u64) -> Result<Opened, String> {
            self.requests.lock().unwrap().push((url.into(), offset));
            let quirks = self.quirks.lock().unwrap().clone();
            let mut data = self
                .files
                .get(url)
                .cloned()
                .ok_or_else(|| "models.test answered HTTP 404".to_string())?;
            if quirks.corrupt {
                data.iter_mut().for_each(|b| *b ^= 0xff);
            }
            let offset = offset as usize;
            if offset > data.len() {
                return Ok(Opened::RangeNotSatisfiable);
            }
            let (partial, body) = if offset > 0 && !quirks.ignore_range {
                (true, data[offset..].to_vec())
            } else {
                (false, data)
            };
            Ok(Opened::Body(Body {
                partial,
                length: Some(body.len() as u64),
                reader: Box::new(Chunked {
                    stop: quirks.drop_after,
                    data: body,
                    at: 0,
                }),
            }))
        }
    }

    fn server(files: &[(&ModelFile, &[u8])]) -> FakeServer {
        FakeServer {
            files: files
                .iter()
                .map(|(f, bytes)| (f.url.clone(), bytes.to_vec()))
                .collect(),
            ..Default::default()
        }
    }

    fn run(fetch: &dyn Fetch, dir: &Path, f: &ModelFile) -> Result<(), Stop> {
        download_file(fetch, dir, f, &AtomicU8::new(RUN), &mut |_| {})
    }

    #[test]
    fn the_checked_in_manifest_parses_and_names_what_the_engines_load() {
        let manifest = Manifest::parse(MANIFEST_JSON).unwrap();
        let names = |engine| -> Vec<String> {
            manifest
                .engine(engine)
                .files
                .iter()
                .map(|f| f.name.clone())
                .collect()
        };
        let meiki = meikiocr::ModelPaths::from_dir("");
        for path in [
            meiki.detection,
            meiki.recognition,
            meiki.vertical_recognition,
        ] {
            assert!(names(Engine::Meiki).contains(&path.to_string_lossy().into_owned()));
        }
        let manga = mangaocr::ModelPaths::from_dir("");
        for path in [manga.weights, manga.vocab, manga.config] {
            assert!(names(Engine::Manga).contains(&path.to_string_lossy().into_owned()));
        }
        assert!(names(Engine::Manga).contains(&"comic-text-detector.onnx".to_string()));
        let pp = ppocr::ModelPaths::from_dir("", crate::pp_ocr::TIER);
        for path in [pp.detection, pp.recognition, pp.dictionary] {
            assert!(names(Engine::PpOcr).contains(&path.to_string_lossy().into_owned()));
        }
        assert!(manifest.engine(Engine::Manga).total_size() > 500_000_000);
        for file in [kimochi_speech::sense_voice::MODEL_FILE, kimochi_speech::sense_voice::TOKENS_FILE] {
            assert!(names(Engine::SenseVoice).contains(&file.to_string()));
        }
    }

    #[test]
    fn manifests_with_unsafe_names_or_missing_checksums_are_refused() {
        let with = |name: &str, sha: &str| {
            let entry = format!(
                r#"{{"name":"{name}","repository":"r","revision":"v","url":"https://x/y","sha256":"{sha}","size":1}}"#
            );
            format!(
                r#"{{"engines":{{"meikiocr":{{"name":"M","files":[{entry}]}},"mangaocr":{{"name":"G","files":[{entry}]}},"ppocr":{{"name":"P","files":[{entry}]}},"sensevoice":{{"name":"S","files":[{entry}]}}}}}}"#
            )
        };
        let good = "a".repeat(64);
        assert!(Manifest::parse(&with("model.onnx", &good)).is_ok());
        assert!(Manifest::parse(&with("../model.onnx", &good)).is_err());
        assert!(Manifest::parse(&with("dir\\\\model.onnx", &good)).is_err());
        assert!(Manifest::parse(&with("model.onnx", "abc")).is_err());
        assert!(Manifest::parse(r#"{"engines":{}}"#).is_err());
    }

    #[test]
    fn resume_offset_keeps_a_prefix_and_restarts_an_overlong_part() {
        assert_eq!(resume_offset(None, 100), 0);
        assert_eq!(resume_offset(Some(0), 100), 0);
        assert_eq!(resume_offset(Some(40), 100), 40);
        assert_eq!(resume_offset(Some(100), 100), 100);
        assert_eq!(resume_offset(Some(101), 100), 0);
    }

    #[test]
    fn percent_rounds_down_and_reasons_are_human() {
        assert_eq!(percent(0, 0), 0);
        assert_eq!(percent(329, 1000), 32);
        assert_eq!(percent(999, 1000), 99);
        assert_eq!(percent(2000, 1000), 100);
        let downloading = Phase::Downloading {
            file: "a".into(),
            received: 1,
            total: 2,
            overall_received: 32,
        };
        assert_eq!(
            reason(&downloading, 100).as_deref(),
            Some("Downloading model… 32%")
        );
        assert_eq!(
            reason(
                &Phase::Paused {
                    overall_received: 5
                },
                100
            )
            .as_deref(),
            Some("Model download paused")
        );
        let failed = Phase::Failed {
            message: "huggingface.co answered HTTP 503".into(),
            overall_received: 0,
        };
        assert_eq!(
            reason(&failed, 100).as_deref(),
            Some("Model download failed: huggingface.co answered HTTP 503")
        );
        assert_eq!(
            reason(&Phase::Absent, 100).as_deref(),
            Some("Model not downloaded")
        );
        assert_eq!(reason(&Phase::Ready, 100), None);
    }

    #[test]
    fn the_activity_feed_hears_state_changes_and_throttled_progress() {
        use crate::activity::Tone;
        let models = EngineModels {
            name: "MeikiOCR".into(),
            files: vec![file("a.onnx", &[0; 100])],
        };
        let at = |phase: Phase| ModelStatus::new(Engine::Meiki, &models, &phase, None);
        let downloading = |received| {
            at(Phase::Downloading {
                file: "a.onnx".into(),
                received,
                total: 100,
                overall_received: received,
            })
        };
        let start = Instant::now();
        let later = |ms| start + Duration::from_millis(ms);
        let mut ticker = ModelTicker::default();

        assert_eq!(
            ticker.next(&downloading(0), start),
            Some(("Downloading MeikiOCR model… 0%".into(), Tone::Busy))
        );
        // Bytes arriving inside the second are not news yet.
        assert_eq!(ticker.next(&downloading(10), later(250)), None);
        assert_eq!(ticker.next(&downloading(20), later(500)), None);
        assert_eq!(
            ticker.next(&downloading(42), later(1000)),
            Some(("Downloading MeikiOCR model… 42%".into(), Tone::Busy))
        );
        // Nor is a second without progress.
        assert_eq!(ticker.next(&downloading(42), later(2500)), None);
        assert_eq!(
            ticker.next(
                &at(Phase::Verifying {
                    file: "a.onnx".into(),
                    overall_received: 100
                }),
                later(2600)
            ),
            Some(("Verifying MeikiOCR model…".into(), Tone::Busy))
        );
        assert_eq!(
            ticker.next(&at(Phase::Ready), later(2700)),
            Some(("MeikiOCR model ready".into(), Tone::Ok))
        );
        assert_eq!(ticker.next(&at(Phase::Ready), later(2800)), None);
        assert_eq!(
            ticker.next(&at(Phase::Absent), later(2900)),
            Some(("MeikiOCR model removed".into(), Tone::Info))
        );

        let mut ticker = ModelTicker::default();
        ticker.next(&downloading(50), start);
        assert_eq!(
            ticker.next(
                &at(Phase::Failed {
                    message: "HTTP 503".into(),
                    overall_received: 50
                }),
                later(100)
            ),
            Some((
                "MeikiOCR model download failed: HTTP 503".into(),
                Tone::Error
            ))
        );
        assert_eq!(
            ticker.next(&at(Phase::Absent), later(200)),
            Some(("MeikiOCR model download cancelled".into(), Tone::Info))
        );
        // An engine first seen ready was not downloaded just now.
        assert_eq!(ModelTicker::default().next(&at(Phase::Ready), start), None);
        assert_eq!(ModelTicker::key(Engine::Manga), "model:mangaocr");
    }

    #[test]
    fn a_fresh_download_is_verified_and_renamed_into_place() {
        let dir = TempDir::new("fresh");
        let content = b"detector weights".repeat(10);
        let f = file("det.onnx", &content);
        let fake = server(&[(&f, &content)]);
        let mut events = Vec::new();
        download_file(&fake, &dir.0, &f, &AtomicU8::new(RUN), &mut |p| {
            events.push(p)
        })
        .unwrap();
        assert_eq!(fs::read(dir.0.join("det.onnx")).unwrap(), content);
        assert!(!part_path(&dir.0, "det.onnx").exists());
        assert_eq!(events.first(), Some(&Progress::Bytes(0)));
        assert_eq!(events.last(), Some(&Progress::Verifying));
        assert!(events.contains(&Progress::Bytes(content.len() as u64)));
    }

    #[test]
    fn a_partial_file_resumes_from_its_length() {
        let dir = TempDir::new("resume");
        let content: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        let f = file("rec.onnx", &content);
        fs::write(part_path(&dir.0, "rec.onnx"), &content[..400]).unwrap();
        let fake = server(&[(&f, &content)]);
        run(&fake, &dir.0, &f).unwrap();
        assert_eq!(fake.requests.lock().unwrap()[0].1, 400);
        assert_eq!(fs::read(dir.0.join("rec.onnx")).unwrap(), content);
    }

    #[test]
    fn a_server_that_ignores_the_range_restarts_the_file() {
        let dir = TempDir::new("norange");
        let content = b"0123456789".repeat(20);
        let f = file("vocab.txt", &content);
        fs::write(part_path(&dir.0, "vocab.txt"), &content[..50]).unwrap();
        let fake = server(&[(&f, &content)]);
        fake.quirks.lock().unwrap().ignore_range = true;
        run(&fake, &dir.0, &f).unwrap();
        assert_eq!(fs::read(dir.0.join("vocab.txt")).unwrap(), content);
    }

    #[test]
    fn an_overlong_part_is_restarted_from_zero() {
        let dir = TempDir::new("overlong");
        let content = b"abc".repeat(10);
        let f = file("config.json", &content);
        fs::write(part_path(&dir.0, "config.json"), b"x".repeat(100)).unwrap();
        let fake = server(&[(&f, &content)]);
        run(&fake, &dir.0, &f).unwrap();
        assert_eq!(fake.requests.lock().unwrap()[0].1, 0);
        assert_eq!(fs::read(dir.0.join("config.json")).unwrap(), content);
    }

    #[test]
    fn a_checksum_mismatch_fails_and_leaves_no_file_at_either_path() {
        let dir = TempDir::new("corrupt");
        let content = b"weights".repeat(30);
        let f = file("pytorch_model.bin", &content);
        let fake = server(&[(&f, &content)]);
        fake.quirks.lock().unwrap().corrupt = true;
        let Err(Stop::Failed(message)) = run(&fake, &dir.0, &f) else {
            panic!("a corrupt file must fail");
        };
        assert!(message.contains("checksum"), "{message}");
        assert!(!dir.0.join("pytorch_model.bin").exists());
        assert!(!part_path(&dir.0, "pytorch_model.bin").exists());
    }

    #[test]
    fn a_dropped_connection_fails_keeping_the_part_and_a_retry_resumes() {
        let dir = TempDir::new("dropped");
        let content: Vec<u8> = (0..200u8).collect();
        let f = file("big.bin", &content);
        let fake = server(&[(&f, &content)]);
        fake.quirks.lock().unwrap().drop_after = Some(120);
        let Err(Stop::Failed(message)) = run(&fake, &dir.0, &f) else {
            panic!("a dropped connection must fail");
        };
        assert!(message.contains("interrupted"), "{message}");
        assert!(!dir.0.join("big.bin").exists());
        assert_eq!(
            fs::metadata(part_path(&dir.0, "big.bin")).unwrap().len(),
            120
        );
        fake.quirks.lock().unwrap().drop_after = None;
        run(&fake, &dir.0, &f).unwrap();
        assert_eq!(fake.requests.lock().unwrap()[1].1, 120);
        assert_eq!(fs::read(dir.0.join("big.bin")).unwrap(), content);
    }

    #[test]
    fn pause_and_cancel_stop_between_reads_and_keep_the_part() {
        let dir = TempDir::new("pause");
        let content = b"z".repeat(100);
        let f = file("rec.onnx", &content);
        let fake = server(&[(&f, &content)]);
        let control = AtomicU8::new(RUN);
        let stop = download_file(&fake, &dir.0, &f, &control, &mut |p| {
            if p == Progress::Bytes(14) {
                control.store(PAUSE, Ordering::SeqCst);
            }
        });
        assert_eq!(stop, Err(Stop::Paused));
        assert_eq!(
            fs::metadata(part_path(&dir.0, "rec.onnx")).unwrap().len(),
            14
        );
        assert!(!dir.0.join("rec.onnx").exists());
        control.store(CANCEL, Ordering::SeqCst);
        assert_eq!(run_with(&fake, &dir.0, &f, &control), Err(Stop::Cancelled));
    }

    fn run_with(
        fetch: &dyn Fetch,
        dir: &Path,
        f: &ModelFile,
        control: &AtomicU8,
    ) -> Result<(), Stop> {
        download_file(fetch, dir, f, control, &mut |_| {})
    }

    #[test]
    fn disk_scan_reports_absent_paused_and_ready() {
        let dir = TempDir::new("scan");
        let a = b"first".to_vec();
        let b = b"second file".to_vec();
        let files = vec![file("a.onnx", &a), file("b.onnx", &b)];
        assert_eq!(scan_disk(&dir.0, &files), Phase::Absent);
        fs::write(part_path(&dir.0, "a.onnx"), &a[..2]).unwrap();
        assert_eq!(
            scan_disk(&dir.0, &files),
            Phase::Paused {
                overall_received: 2
            }
        );
        fs::remove_file(part_path(&dir.0, "a.onnx")).unwrap();
        fs::write(dir.0.join("a.onnx"), &a).unwrap();
        fs::write(dir.0.join("b.onnx"), &b).unwrap();
        // Present but never verified (another revision, or copied by hand): not ready.
        assert_eq!(scan_disk(&dir.0, &files), Phase::Absent);
        let mut marker = Marker::default();
        for f in &files {
            marker.files.insert(f.name.clone(), f.sha256.clone());
        }
        write_marker(&dir.0, &marker).unwrap();
        assert_eq!(scan_disk(&dir.0, &files), Phase::Ready);
        // A verified file whose size changed since is not ready.
        fs::write(dir.0.join("b.onnx"), b"tampered").unwrap();
        assert_eq!(
            scan_disk(&dir.0, &files),
            Phase::Paused {
                overall_received: a.len() as u64
            }
        );
    }

    #[test]
    fn resolution_prefers_the_ready_store_then_bundled_then_development() {
        let root = TempDir::new("resolve");
        let content = b"m".to_vec();
        let files = vec![file("m.onnx", &content)];
        let dir = |name: &str, complete: bool| {
            let d = root.0.join(name);
            fs::create_dir_all(&d).unwrap();
            if complete {
                fs::write(d.join("m.onnx"), &content).unwrap();
            }
            d
        };
        let store = dir("store", true);
        let bundled = dir("bundled", true);
        let development = dir("development", true);
        let empty = dir("empty", false);
        let fallbacks = vec![
            (Source::Bundled, bundled.clone()),
            (Source::Development, development.clone()),
        ];
        assert_eq!(
            resolve(Some(store.clone()), &fallbacks, &files),
            Some((store, Source::Downloaded))
        );
        assert_eq!(
            resolve(None, &fallbacks, &files),
            Some((bundled, Source::Bundled))
        );
        let incomplete_bundle = vec![
            (Source::Bundled, empty.clone()),
            (Source::Development, development.clone()),
        ];
        assert_eq!(
            resolve(Some(empty.clone()), &incomplete_bundle, &files),
            Some((development, Source::Development))
        );
        assert_eq!(resolve(None, &[(Source::Bundled, empty)], &files), None);
    }

    fn test_manifest(meiki: &[ModelFile], manga: &[ModelFile]) -> Manifest {
        let engine = |name: &str, files: &[ModelFile]| EngineModels {
            name: name.into(),
            files: files.to_vec(),
        };
        Manifest {
            engines: BTreeMap::from([
                ("meikiocr".to_string(), engine("MeikiOCR", meiki)),
                ("mangaocr".to_string(), engine("Manga OCR", manga)),
            ]),
        }
    }

    fn wait_until(store: &ModelStore, engine: Engine, done: impl Fn(&Phase) -> bool) -> Phase {
        let start = Instant::now();
        loop {
            let idle = store.with_slot(engine, |s| s.control.is_none());
            let phase = store.phase(engine);
            if idle && done(&phase) {
                return phase;
            }
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "stuck in {phase:?}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn the_store_downloads_every_file_and_reports_transitions() {
        let root = TempDir::new("store");
        let a = b"alpha".repeat(9);
        let b = b"beta".repeat(13);
        let files = vec![file("a.onnx", &a), file("b.onnx", &b)];
        let fake = Arc::new(server(&[(&files[0], &a), (&files[1], &b)]));
        let store = ModelStore::new(root.0.clone(), test_manifest(&files, &files[..1]), fake);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let watcher = Arc::downgrade(&store);
        store.on_change(move |engine, transition| {
            if let (true, Some(store)) = (transition, watcher.upgrade()) {
                log.lock().unwrap().push(store.phase(engine).name());
            }
        });
        assert_eq!(store.phase(Engine::Meiki), Phase::Absent);
        store.start(Engine::Meiki);
        assert_eq!(
            wait_until(&store, Engine::Meiki, |p| *p == Phase::Ready),
            Phase::Ready
        );
        assert_eq!(
            store.ready_dir(Engine::Meiki),
            Some(root.0.join("meikiocr"))
        );
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.first(), Some(&"downloading"));
        assert!(seen.contains(&"verifying"));
        assert_eq!(seen.last(), Some(&"ready"));
        // A second store over the same directory finds it ready without the network.
        let again = ModelStore::new(
            root.0.clone(),
            test_manifest(&files, &files[..1]),
            Arc::new(FakeServer::default()),
        );
        assert_eq!(again.phase(Engine::Meiki), Phase::Ready);
        // Delete removes it.
        again.delete(Engine::Meiki).unwrap();
        assert_eq!(again.phase(Engine::Meiki), Phase::Absent);
        assert!(!root.0.join("meikiocr").exists());
    }

    #[test]
    fn a_failed_download_is_retried_and_cancel_removes_everything() {
        let root = TempDir::new("retry");
        let a: Vec<u8> = (0..150u8).collect();
        let files = vec![file("a.onnx", &a)];
        let fake = Arc::new(server(&[(&files[0], &a)]));
        fake.quirks.lock().unwrap().drop_after = Some(60);
        let store = ModelStore::new(root.0.clone(), test_manifest(&files, &files), fake.clone());
        store.start(Engine::Manga);
        let failed = wait_until(&store, Engine::Manga, |p| matches!(p, Phase::Failed { .. }));
        assert_eq!(failed.overall_received(150), 60);
        let status = ModelStatus::new(Engine::Manga, store.models(Engine::Manga), &failed, None);
        assert_eq!(status.state, "failed");
        assert!(status.message.unwrap().contains("interrupted"));
        // Retry resumes from the kept part.
        fake.quirks.lock().unwrap().drop_after = None;
        store.start(Engine::Manga);
        wait_until(&store, Engine::Manga, |p| *p == Phase::Ready);
        assert_eq!(fake.requests.lock().unwrap().last().unwrap().1, 60);
        // Cancel leaves a ready engine alone; delete does not.
        store.cancel(Engine::Manga).unwrap();
        assert_eq!(store.phase(Engine::Manga), Phase::Ready);
        // A paused download (simulated by a leftover part) is removed by cancel.
        store.delete(Engine::Manga).unwrap();
        fs::create_dir_all(root.0.join("mangaocr")).unwrap();
        fs::write(part_path(&root.0.join("mangaocr"), "a.onnx"), &a[..10]).unwrap();
        let fresh = ModelStore::new(root.0.clone(), test_manifest(&files, &files), fake);
        assert_eq!(
            fresh.phase(Engine::Manga),
            Phase::Paused {
                overall_received: 10
            }
        );
        fresh.cancel(Engine::Manga).unwrap();
        assert_eq!(fresh.phase(Engine::Manga), Phase::Absent);
        assert!(!root.0.join("mangaocr").exists());
    }

    #[test]
    fn a_verification_failure_is_reported_and_nothing_is_installed() {
        let root = TempDir::new("verify");
        let a = b"good bytes".to_vec();
        let files = vec![file("a.onnx", &a)];
        let fake = Arc::new(server(&[(&files[0], &a)]));
        fake.quirks.lock().unwrap().corrupt = true;
        let store = ModelStore::new(root.0.clone(), test_manifest(&files, &files), fake);
        store.start(Engine::Meiki);
        let Phase::Failed { message, .. } =
            wait_until(&store, Engine::Meiki, |p| matches!(p, Phase::Failed { .. }))
        else {
            unreachable!()
        };
        assert!(message.contains("checksum"), "{message}");
        assert_eq!(
            reason(&store.phase(Engine::Meiki), 10).unwrap(),
            format!("Model download failed: {message}")
        );
        assert!(!root.0.join("meikiocr/a.onnx").exists());
        assert!(!part_path(&root.0.join("meikiocr"), "a.onnx").exists());
    }

    #[test]
    fn a_file_left_from_another_revision_is_replaced() {
        let root = TempDir::new("revision");
        let new = b"new revision".to_vec();
        let files = vec![file("a.onnx", &new)];
        let dir = root.0.join("meikiocr");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.onnx"), b"old revision").unwrap();
        let mut marker = Marker::default();
        marker.files.insert("a.onnx".into(), sha(b"old revision"));
        write_marker(&dir, &marker).unwrap();
        let fake = Arc::new(server(&[(&files[0], &new)]));
        let store = ModelStore::new(root.0.clone(), test_manifest(&files, &files), fake);
        assert_eq!(store.phase(Engine::Meiki), Phase::Absent);
        store.start(Engine::Meiki);
        wait_until(&store, Engine::Meiki, |p| *p == Phase::Ready);
        assert_eq!(fs::read(dir.join("a.onnx")).unwrap(), new);
    }

    #[test]
    fn status_reports_bundled_models_as_ready_and_progress_in_bytes() {
        let models = EngineModels {
            name: "MeikiOCR".into(),
            files: vec![file("a", b"12345"), file("b", b"67890")],
        };
        let bundled = ModelStatus::new(
            Engine::Meiki,
            &models,
            &Phase::Absent,
            Some(Source::Bundled),
        );
        assert_eq!((bundled.state, bundled.source), ("ready", Some("bundled")));
        let absent = ModelStatus::new(Engine::Meiki, &models, &Phase::Absent, None);
        assert_eq!(
            (absent.state, absent.source, absent.overall_total),
            ("absent", None, 10)
        );
        let downloading = Phase::Downloading {
            file: "b".into(),
            received: 2,
            total: 5,
            overall_received: 7,
        };
        let status = ModelStatus::new(Engine::Meiki, &models, &downloading, Some(Source::Bundled));
        assert_eq!(status.state, "downloading");
        assert_eq!(status.file.as_deref(), Some("b"));
        assert_eq!(
            (status.received_bytes, status.total_bytes),
            (Some(2), Some(5))
        );
        assert_eq!((status.overall_received, status.overall_total), (7, 10));
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["receivedBytes"], 2);
        assert_eq!(json["overallTotal"], 10);
    }

    #[test]
    fn shutdown_pauses_a_running_download() {
        /// A body that never ends, so the worker is mid-file when asked to stop.
        struct Endless;
        impl Read for Endless {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                std::thread::sleep(Duration::from_millis(1));
                let n = buf.len().min(3);
                buf[..n].fill(1);
                Ok(n)
            }
        }
        struct Slow;
        impl Fetch for Slow {
            fn open(&self, _: &str, _: u64) -> Result<Opened, String> {
                Ok(Opened::Body(Body {
                    partial: false,
                    length: None,
                    reader: Box::new(Endless),
                }))
            }
        }
        let root = TempDir::new("shutdown");
        let files = vec![ModelFile {
            size: 1 << 40,
            ..file("huge.bin", b"x")
        }];
        let store = ModelStore::new(
            root.0.clone(),
            test_manifest(&files, &files),
            Arc::new(Slow),
        );
        store.start(Engine::Manga);
        std::thread::sleep(Duration::from_millis(30));
        store.shutdown(Duration::from_secs(5));
        assert!(matches!(store.phase(Engine::Manga), Phase::Paused { .. }));
        assert!(part_path(&root.0.join("mangaocr"), "huge.bin").exists());
        // Nothing starts once the app is closing.
        store.start(Engine::Manga);
        assert!(matches!(store.phase(Engine::Manga), Phase::Paused { .. }));
    }
}
