//! The local text observers automatic scanning watches the screen with.
//!
//! Automatic scanning reads each frame with a fast local engine, waits for its text to stop
//! changing, and only then lets the selected engine read it. Which engine watches is the
//! overlay's choice (`ui/watcher.ts`), made from what this machine has: with a local engine
//! selected, that same engine watches; with an online one, the best local engine here. Each
//! `capture_frame` names it, and [`Observers`] builds that observer on first use:
//!
//!  - `livetext` (macOS): Apple Live Text, `kimochi_capture::text::LiveTextObserver`, in the language being read.
//!  - `ppocr`: PaddleOCR, sharing the scan engine (`pp_ocr::read_lines`).
//!  - `meikiocr`: MeikiOCR, with an engine of its own (below).
//!  - `oneocr` (Windows): the Snipping Tool engine, through its worker process.
//!  - `vocr`: VOCR6, sharing the scan engine (`vocr::read_lines`). Only when it is the reader.
//!  - `screenai`: Chrome Screen AI, through the scan's warm worker process. Only when it is the
//!    reader.
//!
//! None of them downloads anything: a watcher whose models are missing reports
//! `unsupported`, and the overlay picks another.
//!
//! # Thread and memory model
//!
//! `TextObserver::observe` promises to return within its timeout, and an engine on a
//! CPU can take longer than that on a large frame. So an engine observer never runs
//! inference on the caller's thread:
//!
//!  - one dedicated worker thread per engine observer, its engine loaded lazily on
//!    the first observation (never at startup);
//!  - the queue is one slot deep and latest-wins: a request that has not started
//!    is replaced by a newer one, so the worker never works through a backlog of
//!    frames the screen has already moved past;
//!  - each request carries a generation and a content key; a caller only accepts
//!    the result for its own generation or for identical pixels, so a late result
//!    for an older frame is dropped rather than reported as the current screen;
//!  - a result for identical pixels is reused, so a slow engine on a static screen
//!    (exactly when settling matters) still converges instead of timing out on
//!    every tick;
//!  - the reads of the last few distinct frames are kept too (`RecentReads`), so a
//!    screen that only flips between a few states (a blinking ▼ beside the dialogue)
//!    is read once per state instead of on every look.
//!
//! MeikiOCR's observer engine is separate from the manual scan's (`MeikiState`), so a slow
//! accurate scan cannot starve observer ticks; the cost is a second copy of its sessions
//! (very roughly 100-150 MB on CPU). PaddleOCR's observer shares the scan engine instead:
//! its sessions are larger (500+ MB) and fast enough that a scan waits at most one
//! observation for the lock. Two DirectML runs never overlap: `meiki_ocr::DIRECTML_RUN`.
//!
//! # Error codes (see `capture_frame` in main.rs)
//!
//!  - `unsupported`: this engine cannot run here (models missing, runtime absent). The
//!    overlay chooses another watcher.
//!  - `stalled`: one inference has been running for longer than `STALL_AFTER`.
//!    The engine took a request and has not given it back; nothing more can be
//!    started on it, so this is also treated as standing.
//!  - `busy`: the answer was not ready within the timeout (cold engine load, a
//!    slow CPU, or a manual DirectML scan holding the run lock). Non-fatal by
//!    design: a slow-but-working observer must not be reported unsupported, so
//!    the scheduler backs off and retries, and the identical-pixels reuse above
//!    hands it the answer once one exists.
//!  - `observe`: inference ran and failed for this frame. Non-fatal.

use kimochi_capture::text::UnsupportedObserver;
use kimochi_capture::{
    text::{join_lines, CachedObserver},
    CaptureError, Frame, Observation, ObserverStatus, TextLine, TextObserver,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex, MutexGuard},
    thread::JoinHandle,
    time::{Duration, Instant},
};

/// The watcher used when a caller names none: what each OS used before watchers were chosen.
pub const DEFAULT_ENGINE: &str = if cfg!(target_os = "macos") { "livetext" } else { "meikiocr" };

/// The watcher for a read in `language`: the one the caller asked for, else [`DEFAULT_ENGINE`],
/// as long as it reads the language; otherwise the first of PaddleOCR, OneOCR (Windows) and
/// Screen AI that does, so a Japanese-only engine never watches for another language. Japanese
/// is read by every engine, so for it this is the request or the default, as before.
pub fn engine_for(requested: Option<&str>, language: &str) -> &'static str {
    let wanted = requested.and_then(known).unwrap_or(DEFAULT_ENGINE);
    if crate::language::engine_supports(wanted, language) {
        return wanted;
    }
    let os = if cfg!(target_os = "windows") { "oneocr" } else { DEFAULT_ENGINE };
    [os, "ppocr", "screenai"]
        .into_iter()
        .find(|engine| crate::language::engine_supports(engine, language))
        .unwrap_or("screenai")
}

/// The observer automatic scanning watches with, built on first use and kept until another
/// is selected.
///
/// Implements [`TextObserver`] for whichever was [`select`](Self::select)ed last, so the
/// status the overlay reads describes the watcher it is using.
pub struct Observers {
    app: tauri::AppHandle,
    current: &'static str,
    built: HashMap<&'static str, Box<dyn TextObserver>>,
}

impl Observers {
    pub fn new(app: &tauri::AppHandle) -> Self {
        announce_verified_capabilities(app);
        Self { app: app.clone(), current: DEFAULT_ENGINE, built: HashMap::new() }
    }

    /// Watch with `engine` from now on (unknown names keep the current one).
    ///
    /// The one it replaces is closed: each holds a model, some hundreds of MB, and one picked
    /// again is built in about the time of a read. PaddleOCR's model is the scan engine's, so
    /// it goes too unless PaddleOCR is still what scans.
    pub fn select(&mut self, engine: &str) {
        let Some(engine) = known(engine) else { return };
        let previous = std::mem::replace(&mut self.current, engine);
        if previous == engine || !self.built.contains_key(previous) {
            return;
        }
        self.close_engine(previous);
        if previous == "ppocr" && !crate::scans_with(&self.app, "ppocr") {
            crate::pp_ocr::unload(&self.app);
        }
    }

    /// The engine watching now, if it has been built.
    pub fn watching(&self) -> Option<&'static str> {
        self.built.contains_key(self.current).then_some(self.current)
    }

    /// Drop one engine's observer (its models are being deleted); rebuilt on next use.
    pub fn close_engine(&mut self, engine: &str) {
        if let Some(mut observer) = self.built.remove(engine) {
            observer.close();
        }
    }

    fn observer(&mut self) -> &mut Box<dyn TextObserver> {
        let (app, engine) = (&self.app, self.current);
        self.built.entry(engine).or_insert_with(|| build(app, engine))
    }
}

impl TextObserver for Observers {
    fn status(&self) -> ObserverStatus {
        match self.built.get(self.current) {
            Some(observer) => observer.status(),
            None => build(&self.app, self.current).status(),
        }
    }

    fn observe(&mut self, frame: &Frame, timeout: Duration) -> kimochi_capture::Result<Observation> {
        self.observer().observe(frame, timeout)
    }

    fn close(&mut self) {
        for observer in self.built.values_mut() {
            observer.close();
        }
        self.built.clear();
    }
}

fn known(engine: &str) -> Option<&'static str> {
    ["livetext", "ppocr", "meikiocr", "oneocr", "vocr", "screenai"].into_iter().find(|known| *known == engine)
}

fn build(app: &tauri::AppHandle, engine: &'static str) -> Box<dyn TextObserver> {
    let unsupported = |detail: String| -> Box<dyn TextObserver> {
        // Leaked once per engine: `UnsupportedObserver` holds a `&'static str`.
        Box::new(UnsupportedObserver::new(Box::leak(detail.into_boxed_str())))
    };
    let inner: Box<dyn TextObserver> = match engine {
        #[cfg(target_os = "macos")]
        "livetext" => {
            // In the language being read; rebuilt when it changes (`main.rs`, `language`).
            let mut observer = kimochi_capture::text::LiveTextObserver::new();
            if let Some(service) = tauri::Manager::try_state::<crate::state::Shared>(app) {
                observer.set_locales(crate::language::live_text_locales(crate::language::current(&service.settings)));
            }
            Box::new(observer)
        }
        "meikiocr" => match crate::meiki_ocr::runtime_available(app) {
            Ok(()) => Box::new(EngineObserver::meiki(app.clone())),
            Err(reason) => unsupported(unavailable_detail("MeikiOCR", &reason)),
        },
        "ppocr" => Box::new(EngineObserver::paddle(app.clone())),
        "vocr" => match crate::meiki_ocr::runtime_available(app) {
            Ok(()) => Box::new(EngineObserver::vocr(app.clone())),
            Err(reason) => unsupported(unavailable_detail("VOCR6", &reason)),
        },
        "screenai" => Box::new(EngineObserver::screenai(app.clone())),
        #[cfg(target_os = "windows")]
        "oneocr" => Box::new(EngineObserver::oneocr(app.clone())),
        _ => unsupported(format!(
            "Automatic scanning can't watch with {engine}."
        )),
    };
    Box::new(CachedObserver::new(inner))
}

/// Re-announce `platform-capabilities` when an engine's availability probe
/// replaces the presence-based answer with a verified one.
fn announce_verified_capabilities(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let announce = |app: tauri::AppHandle| {
        move || {
            if let Some(service) = app.try_state::<crate::state::Shared>() {
                let payload = crate::capabilities_value(&app, service.inner());
                let _ = app.emit("platform-capabilities", payload);
            }
        }
    };
    crate::meiki_ocr::on_verified(announce(app.clone()));
    crate::manga_ocr::on_verified(announce(app.clone()));
    crate::pp_ocr::on_verified(announce(app.clone()));
}

fn unavailable_detail(engine: &str, reason: &str) -> String {
    format!("Automatic scanning can't watch with {engine}: {reason}")
}

/// How long one inference may run before the observer is reported stalled.
const STALL_AFTER: Duration = Duration::from_secs(30);

/// How many recent reads an engine observer keeps, by exact frame (`frame_key`).
const RECENT_READS: usize = 4;

/// The last few reads, each for the exact pixels it was made from, so a screen that flips
/// between a few states (a blinking ▼ beside the dialogue, a cursor, A/B alternating) is read
/// once per state rather than on every look. The worker's own reuse covers only the frame it
/// read last, which an A/B/A/B screen never repeats. Identical pixels give an identical read,
/// so a hit changes nothing but the cost. Emptied whenever the source or crop changes (the
/// key would differ anyway; this keeps no stale reads around) and when the observer closes,
/// which is what changing the engine does.
struct RecentReads<T> {
    /// The source and crop the reads were made in.
    scope: Option<(String, [u32; 4])>,
    /// Newest last.
    reads: std::collections::VecDeque<(u64, T)>,
}

impl<T: Clone> RecentReads<T> {
    fn new() -> Self {
        Self { scope: None, reads: std::collections::VecDeque::with_capacity(RECENT_READS) }
    }

    /// Start a look at `frame`: forgets every read if its source or crop differs.
    fn enter(&mut self, frame: &Frame) {
        let scope = (frame.info.source_id.clone(), frame.info.crop_pixels);
        if self.scope.as_ref() != Some(&scope) {
            self.reads.clear();
            self.scope = Some(scope);
        }
    }

    fn get(&self, key: u64) -> Option<T> {
        self.reads.iter().find(|(k, _)| *k == key).map(|(_, read)| read.clone())
    }

    fn put(&mut self, key: u64, read: T) {
        self.reads.retain(|(k, _)| *k != key);
        if self.reads.len() == RECENT_READS {
            self.reads.pop_front();
        }
        self.reads.push_back((key, read));
    }

    fn clear(&mut self) {
        self.reads.clear();
        self.scope = None;
    }
}

/// One read, as the worker returns it.
#[derive(Clone)]
struct Read {
    lines: Vec<TextLine>,
    duration_ms: f64,
    /// The same read in the shape a scan of this engine returns (`ocr_frame`).
    scan: Value,
    /// The engine's own lines, for the next look to read only what changed (`incremental`);
    /// empty for an engine that is always read whole.
    raw: Vec<meikiocr::TextLine>,
    /// Only the changed regions were read; the rest is the previous reading.
    partial: bool,
}

/// What the worker is asked to read: the frame, and the part of it that changed when only that
/// is to be read.
struct Request {
    image: image::RgbImage,
    plan: Option<crate::incremental::Plan>,
}

/// Read the regions `plan` names with `read`, merged into the previous reading, or the whole
/// image without one. True when only regions were read.
fn read_planned(
    image: &image::RgbImage,
    plan: Option<crate::incremental::Plan>,
    mut read: impl FnMut(&image::RgbImage) -> Result<Vec<meikiocr::TextLine>, Failure>,
) -> Result<(Vec<meikiocr::TextLine>, bool), Failure> {
    let Some(plan) = plan else {
        return read(image).map(|lines| (lines, false));
    };
    let (width, height) = image.dimensions();
    let regions = plan.regions.clone();
    let mut found = Vec::new();
    for &[left, top, right, bottom] in &regions {
        let region = image::imageops::crop_imm(image, left, top, right - left, bottom - top).to_image();
        found.extend(crate::incremental::place(read(&region)?, [left, top, right, bottom], width, height));
    }
    let merged = crate::incremental::merge(plan, found);
    // Diagnostics: read the whole frame too and report where the two disagree.
    if std::env::var_os("KIMOCHI_WATCH_VERIFY").is_some() {
        let whole = read(image)?;
        let text = |lines: &[meikiocr::TextLine]| lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join(" | ");
        let (a, b) = (text(&merged), text(&whole));
        eprintln!(
            "kimochi: {}",
            serde_json::json!({"check": "watch-verify", "same": a == b, "regions": regions,
                "incremental": (a != b).then_some(&a), "whole": (a != b).then_some(&b)})
        );
    }
    Ok((merged, true))
}

/// The watcher's latest full read: which engine, of which pixels (`frame_key`), and the scan
/// result it amounts to.
///
/// When the watcher is also the engine the reader chose, the recognition Auto OCR asks for once
/// a line settles is of the very frame the watcher just read, with the same engine and options.
/// Running the models again would only reproduce this, so `capture_frame` attaches it to the
/// stored frame and `ocr_frame` returns it. Keyed on the pixels, so it is never handed to a
/// frame it was not read from.
static LAST_SCAN: Mutex<Option<(&'static str, u64, Value)>> = Mutex::new(None);

/// The watcher's scan result for a frame whose `content_fingerprint` is `fingerprint`.
pub fn scan_for(fingerprint: &str) -> Option<(&'static str, Value)> {
    let last = LAST_SCAN.lock().unwrap_or_else(|p| p.into_inner());
    let (engine, key, scan) = last.as_ref()?;
    (format!("{key:016x}") == fingerprint).then(|| (*engine, scan.clone()))
}

#[derive(Clone)]
enum Failure {
    /// The engine cannot be loaded here; standing.
    Unavailable(String),
    /// This frame failed; transient.
    Inference(String),
}

type Answer = Result<Read, Failure>;
type Run = Box<dyn FnMut(Request) -> Answer + Send>;

/// A local OCR engine as a `TextObserver`, on a dedicated worker.
pub struct EngineObserver {
    app: tauri::AppHandle,
    engine: &'static str,
    name: &'static str,
    /// Ready to read, or why not yet; checked before every observation.
    gate: fn(&tauri::AppHandle) -> Result<(), String>,
    /// The worker's job, made when the worker starts.
    make_run: fn(tauri::AppHandle) -> Run,
    worker: Option<LatestWorker<Request, Answer>>,
    /// Set once the engine has failed to load; every later call says so.
    unsupported: Option<String>,
    timeouts: u32,
    /// The smallest region this engine reads well, when it can read regions at all
    /// (`incremental`); None reads every frame whole.
    regions: Option<(u32, u32)>,
    /// The last frame read and its reading, which the next look is compared with.
    previous: Option<crate::incremental::Previous>,
    /// Incremental looks since the last whole read.
    partial_looks: u32,
    /// The backend of the first read has been logged (`watcher-backend`).
    backend_logged: bool,
    /// Reads of the last few distinct frames (`RecentReads`).
    recent: RecentReads<Read>,
}

impl EngineObserver {
    fn new(
        app: tauri::AppHandle,
        engine: &'static str,
        name: &'static str,
        gate: fn(&tauri::AppHandle) -> Result<(), String>,
        make_run: fn(tauri::AppHandle) -> Run,
        regions: Option<(u32, u32)>,
    ) -> Self {
        Self {
            app,
            engine,
            name,
            gate,
            make_run,
            worker: None,
            unsupported: None,
            timeouts: 0,
            regions,
            previous: None,
            partial_looks: 0,
            backend_logged: false,
            recent: RecentReads::new(),
        }
    }

    /// MeikiOCR with an engine of its own, so a slow manual scan cannot starve it.
    ///
    /// Its detector reads every image at 960x544, scaling a small one up: regions narrower or
    /// shorter than half that are widened, so none reaches it more than twice enlarged.
    pub fn meiki(app: tauri::AppHandle) -> Self {
        let regions = Some((480, 272));
        Self::new(app, "meikiocr", "MeikiOCR", |app| crate::meiki_ocr::models_ready(app).map(|_| ()), |app| {
            let mut engine = None;
            let mut failed: Option<String> = None;
            Box::new(move |Request { image, plan }| -> Answer {
                if let Some(reason) = &failed {
                    return Err(Failure::Unavailable(reason.clone()));
                }
                if engine.is_none() {
                    let loaded = crate::meiki_ocr::engine_root(&app)
                        .and_then(|root| crate::meiki_ocr::load_engine(&root));
                    match loaded {
                        Ok(loaded) => engine = Some(loaded),
                        Err(reason) => {
                            failed = Some(reason.clone());
                            return Err(Failure::Unavailable(reason));
                        }
                    }
                }
                let Some(meiki) = engine.as_mut() else {
                    return Err(Failure::Inference("MeikiOCR engine missing".into()));
                };
                let started = Instant::now();
                let read = read_planned(&image, plan, |part| {
                    crate::meiki_ocr::infer(meiki, part).map_err(Failure::Inference)
                });
                match read {
                    Ok((lines, partial)) => Ok(Read {
                        lines: text_lines(&lines, image.width(), image.height()),
                        duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                        scan: crate::meiki_ocr::scan_result(&lines, meiki),
                        raw: lines,
                        partial,
                    }),
                    Err(Failure::Inference(e)) => {
                        // A panicking session may be left inconsistent: rebuild it next time.
                        if e.starts_with(crate::engine_probe::PANIC_PREFIX) {
                            engine = None;
                        }
                        Err(Failure::Inference(e))
                    }
                    Err(failure) => Err(failure),
                }
            })
        }, regions)
    }

    /// PaddleOCR on the scan engine, which loads (and keeps) it on first use.
    ///
    /// Its detector takes an image at its own size up to 960 on the longest side, so a region
    /// costs in proportion to its area: any size is read as it is. Only on the CPU, though: on a
    /// GPU backend every new size may compile anew (`pp_ocr::runs_on_cpu`), so there it reads
    /// whole frames, whose size does not change.
    pub fn paddle(app: tauri::AppHandle) -> Self {
        let regions = Some((0, 0));
        Self::new(app, "ppocr", "PaddleOCR", crate::pp_ocr::models_ready, |app| {
            // Learned from the first read, which is always whole.
            let mut on_cpu = false;
            Box::new(move |Request { image, plan }| -> Answer {
                let started = Instant::now();
                let plan = plan.filter(|_| on_cpu);
                let mut backend = Value::Null;
                let read = read_planned(&image, plan, |part| match crate::pp_ocr::read_lines(&app, part) {
                    Ok((lines, used)) => {
                        backend = used;
                        Ok(lines)
                    }
                    Err(crate::pp_ocr::ReadError::Unavailable(reason)) => Err(Failure::Unavailable(reason)),
                    Err(crate::pp_ocr::ReadError::Inference(reason)) => Err(Failure::Inference(reason)),
                });
                let (lines, partial) = read?;
                on_cpu = crate::pp_ocr::runs_on_cpu(&backend);
                Ok(Read {
                    lines: text_lines(&lines, image.width(), image.height()),
                    duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                    scan: crate::pp_ocr::scan_result(&lines, backend),
                    raw: lines,
                    partial,
                })
            })
        }, regions)
    }

    /// VOCR6 on the scan engine, which loads (and keeps) it on first use.
    ///
    /// Always whole frames: its line spotter reads the frame at one scale, chosen from the frame's
    /// size, and a whole frame takes about 11 ms on a desktop CPU anyway.
    pub fn vocr(app: tauri::AppHandle) -> Self {
        Self::new(app, "vocr", "VOCR6", crate::vocr::models_ready, |app| {
            Box::new(move |Request { image, .. }| -> Answer {
                let started = Instant::now();
                let (width, height) = (image.width() as usize, image.height() as usize);
                let grey = kimochi_vocr::Grey::from_interleaved(image.as_raw(), width, height, width * 3, 3);
                let lines = crate::vocr::read_lines(&app, &grey).map_err(|e| match e {
                    crate::pp_ocr::ReadError::Unavailable(reason) => Failure::Unavailable(reason),
                    crate::pp_ocr::ReadError::Inference(reason) => Failure::Inference(reason),
                })?;
                Ok(Read {
                    lines: text_lines(&lines, image.width(), image.height()),
                    duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                    scan: crate::vocr::scan_result(&lines),
                    raw: lines,
                    partial: false,
                })
            })
        }, None)
    }

    /// Chrome Screen AI through the scan's worker process (`screen_ai`), whole frames, its lines.
    pub fn screenai(app: tauri::AppHandle) -> Self {
        Self::new(app, "screenai", "Screen AI", |_| Ok(()), |app| {
            Box::new(move |Request { image, .. }| -> Answer {
                let started = Instant::now();
                let result = crate::screen_ai::recognize_rgb(&app, &image).map_err(Failure::Inference)?;
                Ok(Read {
                    lines: line_annotation_lines(&result),
                    duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                    scan: result,
                    raw: Vec::new(),
                    partial: false,
                })
            })
        }, None)
    }

    /// The Snipping Tool engine through its worker process, line by line.
    #[cfg(target_os = "windows")]
    pub fn oneocr(app: tauri::AppHandle) -> Self {
        Self::new(app, "oneocr", "OneOCR", |_| Ok(()), |app| {
            Box::new(move |Request { image, .. }| -> Answer {
                let started = Instant::now();
                let mut png = Vec::new();
                image::DynamicImage::ImageRgb8(image)
                    .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                    .map_err(|e| Failure::Inference(format!("OneOCR frame: {e}")))?;
                let result = crate::oneocr::recognize(&app, &png).map_err(Failure::Inference)?;
                Ok(Read {
                    lines: annotation_lines(&result),
                    duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                    scan: result,
                    raw: Vec::new(),
                    partial: false,
                })
            })
        }, None)
    }

    /// Take `read` as the reading of `frame` (whose `frame_key` is `key`): what the scan reuses,
    /// and what the next look's changed regions are measured against.
    fn accept(&mut self, frame: &Frame, key: u64, read: Read) -> Observation {
        *LAST_SCAN.lock().unwrap_or_else(|p| p.into_inner()) = Some((self.engine, key, read.scan));
        if self.regions.is_some() {
            self.previous = Some(crate::incremental::Previous::new(frame, read.raw));
        }
        Observation {
            engine: self.engine,
            text: join_lines(&read.lines),
            lines: read.lines,
            duration_ms: read.duration_ms,
        }
    }

    fn worker(&mut self) -> Result<&mut LatestWorker<Request, Answer>, CaptureError> {
        if self.worker.is_none() {
            let run = (self.make_run)(self.app.clone());
            let worker = LatestWorker::spawn(&format!("kimochi-{}-observer", self.engine), run)
                .map_err(|e| CaptureError::new("observe", format!("{} observer: {e}", self.name)))?;
            self.worker = Some(worker);
        }
        Ok(self.worker.as_mut().expect("worker was just created"))
    }
}

impl TextObserver for EngineObserver {
    fn status(&self) -> ObserverStatus {
        let gate = (self.gate)(&self.app).err();
        let reason = self.unsupported.as_ref().or(gate.as_ref());
        ObserverStatus {
            supported: reason.is_none(),
            engine: self.engine,
            minimum_os: "",
            private_api: false,
            detail: match reason {
                Some(reason) => unavailable_detail(self.name, reason),
                None => format!(
                    "Automatic scanning reads each changed frame with {}.",
                    self.name
                ),
            },
            timeouts: self.timeouts,
        }
    }

    fn observe(
        &mut self,
        frame: &Frame,
        timeout: Duration,
    ) -> kimochi_capture::Result<Observation> {
        if let Some(reason) = &self.unsupported {
            return Err(CaptureError::new("unsupported", unavailable_detail(self.name, reason)));
        }
        // Never sticky: once the models are downloaded the next observation proceeds.
        if let Err(reason) = (self.gate)(&self.app) {
            return Err(CaptureError::new("unsupported", unavailable_detail(self.name, &reason)));
        }
        let audit = std::env::var_os("KIMOCHI_CAPTURE_AUDIT").is_some();
        let clock = Instant::now();
        let key = frame_key(frame);
        let key_ms = clock.elapsed().as_secs_f64() * 1000.0;
        self.recent.enter(frame);
        if let Some(mut read) = self.recent.get(key) {
            // What this look cost, not what the original read did.
            read.duration_ms = key_ms;
            // These exact pixels were read a moment ago (a blinking indicator flipped back).
            if audit {
                eprintln!(
                    "kimochi: {}",
                    serde_json::json!({"check": "watch-look", "engine": self.engine, "recent": true,
                        "lines": read.lines.len(), "keyMs": key_ms.round()})
                );
            }
            return Ok(self.accept(frame, key, read));
        }
        let image = rgb_image(frame)?;
        let convert_ms = clock.elapsed().as_secs_f64() * 1000.0 - key_ms;
        let (engine, name) = (self.engine, self.name);
        // Only what changed since the last reading, unless it is time for a whole one.
        // `KIMOCHI_WATCH_FULL` reads every look whole, for comparing the two.
        let incremental = std::env::var_os("KIMOCHI_WATCH_FULL").is_none();
        let plan = match (self.regions, &self.previous) {
            (Some(min_size), Some(previous))
                if incremental && self.partial_looks < crate::incremental::FULL_EVERY =>
            {
                crate::incremental::plan(previous, frame, min_size)
            }
            _ => None,
        };
        let regions = plan.as_ref().map(|p| p.regions.clone());
        let plan_ms = clock.elapsed().as_secs_f64() * 1000.0 - key_ms - convert_ms;
        let submitted = Instant::now();
        match self.worker()?.submit(key, Request { image, plan }, timeout) {
            Outcome::Ready(Ok(read)) => {
                // Per-look diagnostics with the capture audit: what was read, and where the time went
                // besides the engine (hashing the frame, converting it, planning, the worker round trip).
                if audit {
                    eprintln!(
                        "kimochi: {}",
                        serde_json::json!({"check": "watch-look", "engine": engine, "partial": read.partial,
                            "regions": regions, "ms": read.duration_ms.round(), "lines": read.lines.len(),
                            "keyMs": key_ms.round(), "convertMs": convert_ms.round(), "planMs": plan_ms.round(),
                            "submitMs": (submitted.elapsed().as_secs_f64() * 1000.0).round()})
                    );
                }
                if !self.backend_logged {
                    self.backend_logged = true;
                    eprintln!(
                        "kimochi: {}",
                        serde_json::json!({"check": "watcher-backend", "engine": engine, "backend": read.scan["backend"]})
                    );
                }
                // A ready answer is for these pixels: this request's, or identical ones.
                if self.regions.is_some() {
                    self.partial_looks = if read.partial { self.partial_looks + 1 } else { 0 };
                }
                self.recent.put(key, read.clone());
                Ok(self.accept(frame, key, read))
            }
            Outcome::Ready(Err(Failure::Unavailable(reason))) => {
                let error = CaptureError::new("unsupported", unavailable_detail(name, &reason));
                self.unsupported = Some(reason);
                Err(error)
            }
            Outcome::Ready(Err(Failure::Inference(message))) => {
                Err(CaptureError::new("observe", message))
            }
            Outcome::Busy { running_for } => {
                self.timeouts += 1;
                Err(busy_error(name, running_for))
            }
        }
    }

    fn close(&mut self) {
        // Detached, not joined: a wedged inference must not hang the caller.
        // The next observation starts a fresh worker and engine.
        self.worker = None;
        self.unsupported = None;
        self.previous = None;
        self.backend_logged = false;
        self.recent.clear();
    }
}

/// The error for an answer that was not ready in time (see the module docs).
fn busy_error(name: &str, running_for: Option<Duration>) -> CaptureError {
    match running_for {
        Some(running) if running >= STALL_AFTER => CaptureError::new(
            "stalled",
            format!(
                "The local {name} observer has been reading one frame for {} s and has not answered; restart Kimochi to use automatic scanning again.",
                running.as_secs()
            ),
        ),
        _ => CaptureError::new(
            "busy",
            format!("The local {name} observer is still reading an earlier frame; retrying."),
        ),
    }
}

/// OneOCR's lines as frame-pixel lines.
///
/// The worker puts each line in `groups` (`text`, `bbox: [left, top, right, bottom]`) and
/// its words in `textAnnotations` as `fragment`s; a `line` annotation appears only for a line
/// with no words. The groups are the lines, then; the `line` annotations are the fallback for a
/// result without groups (an older worker), never both, so a line is not counted twice.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn annotation_lines(result: &serde_json::Value) -> Vec<TextLine> {
    if let Some(groups) = result["groups"].as_array() {
        let lines: Vec<TextLine> = groups
            .iter()
            .filter_map(|group| {
                let text = group["text"].as_str()?.trim();
                let bbox = group["bbox"].as_array()?;
                let [left, top, right, bottom] = <[f64; 4]>::try_from(
                    bbox.iter().map(|v| v.as_f64()).collect::<Option<Vec<_>>>()?,
                )
                .ok()?;
                (!text.is_empty() && right > left && bottom > top).then(|| TextLine {
                    text: text.to_string(),
                    x: left,
                    y: top,
                    width: right - left,
                    height: bottom - top,
                    segments: Vec::new(),
                })
            })
            .collect();
        if !lines.is_empty() {
            return lines;
        }
    }
    line_annotation_lines(result)
}

/// A result's `line` annotations as frame-pixel lines (Screen AI's lines, OneOCR's fallback).
fn line_annotation_lines(result: &serde_json::Value) -> Vec<TextLine> {
    let Some(annotations) = result["textAnnotations"].as_array() else { return Vec::new() };
    annotations
        .iter()
        .filter(|a| a["granularity"] == "line")
        .filter_map(|a| {
            let text = a["description"].as_str()?.trim();
            let vertices = a["boundingPoly"]["vertices"].as_array()?;
            let xs = vertices.iter().filter_map(|v| v["x"].as_f64());
            let ys = vertices.iter().filter_map(|v| v["y"].as_f64());
            let (left, right) = xs.fold((f64::MAX, f64::MIN), |(l, r), x| (l.min(x), r.max(x)));
            let (top, bottom) = ys.fold((f64::MAX, f64::MIN), |(t, b), y| (t.min(y), b.max(y)));
            (!text.is_empty() && right > left && bottom > top).then(|| TextLine {
                text: text.to_string(),
                x: left,
                y: top,
                width: right - left,
                height: bottom - top,
                segments: Vec::new(),
            })
        })
        .collect()
}

/// Meiki lines in frame pixels: `[left, top, right, bottom)` to origin + size,
/// clamped to the frame, blank lines dropped (as `join_lines` would).
fn text_lines(lines: &[meikiocr::TextLine], width: u32, height: u32) -> Vec<TextLine> {
    lines
        .iter()
        .filter(|line| !line.text.trim().is_empty())
        .map(|line| {
            let [left, top, right, bottom] = line.bbox;
            let (left, right) = (left.min(width), right.min(width));
            let (top, bottom) = (top.min(height), bottom.min(height));
            TextLine {
                text: line.text.clone(),
                x: f64::from(left),
                y: f64::from(top),
                width: f64::from(right.saturating_sub(left)),
                height: f64::from(bottom.saturating_sub(top)),
                segments: Vec::new(),
            }
        })
        .collect()
}

/// The frame's RGBA rows (with their stride) as the RGB image Meiki reads.
pub(crate) fn rgb_image(frame: &Frame) -> kimochi_capture::Result<image::RgbImage> {
    let (width, height) = (frame.info.width as usize, frame.info.height as usize);
    let stride = frame.info.stride.max(width * 4);
    if width == 0 || height == 0 || frame.pixels.len() < stride * (height - 1) + width * 4 {
        return Err(CaptureError::new(
            "observe",
            "the frame is empty or shorter than its geometry",
        ));
    }
    let rgb = kimochi_capture::pixels::rgba_rows_to_rgb(&frame.pixels, width, height, stride);
    image::RgbImage::from_raw(frame.info.width, frame.info.height, rgb)
        .ok_or_else(|| CaptureError::new("observe", "the frame could not be converted"))
}

/// Identity of a frame's content, for reusing a result on identical pixels: the number behind
/// `capture_frame`'s `contentFingerprint`, which is how `scan_for` finds this read again.
fn frame_key(frame: &Frame) -> u64 {
    kimochi_capture::hash::content_key(frame)
}

// --- the worker -------------------------------------------------------------

/// What `LatestWorker::submit` came back with.
#[derive(Debug, PartialEq)]
enum Outcome<O> {
    Ready(O),
    /// Not ready in time; `running_for` is how long the in-flight job has run.
    Busy {
        running_for: Option<Duration>,
    },
}

struct Job<I> {
    generation: u64,
    key: u64,
    input: I,
}

struct Running {
    generation: u64,
    key: u64,
    started: Instant,
}

struct Done<O> {
    generation: u64,
    key: u64,
    output: O,
}

struct Slot<I, O> {
    /// Depth one: a newer request replaces an unstarted older one.
    pending: Option<Job<I>>,
    running: Option<Running>,
    done: Option<Done<O>>,
    closed: bool,
    /// The worker thread has returned and dropped its engine.
    exited: bool,
}

struct Channel<I, O> {
    slot: Mutex<Slot<I, O>>,
    changed: Condvar,
}

impl<I, O> Channel<I, O> {
    fn lock(&self) -> MutexGuard<'_, Slot<I, O>> {
        self.slot.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// A worker as `shutdown` sees it, whatever it reads.
trait Stop: Send + Sync {
    fn close(&self);
    fn exited(&self) -> bool;
}

impl<I: Send, O: Send> Stop for Channel<I, O> {
    fn close(&self) {
        self.lock().closed = true;
        self.changed.notify_all();
    }
    fn exited(&self) -> bool {
        self.lock().exited
    }
}

/// Every worker started, so the app can stop them before it exits.
static WORKERS: Mutex<Vec<std::sync::Weak<dyn Stop>>> = Mutex::new(Vec::new());

/// Stop every observer worker and wait, at most `timeout`, for each to finish the read it is
/// in and drop its engine. Called as the app exits: process exit tears down the engines'
/// runtime (ONNX Runtime's globals) underneath a read still running on a worker, which
/// crashed Kimochi on quit while Auto OCR was watching. Returns how many were still running
/// when the time ran out (each is then left to the exit, as before).
pub fn shutdown(timeout: Duration) -> usize {
    let workers: Vec<_> = {
        let mut list = WORKERS.lock().unwrap_or_else(|p| p.into_inner());
        list.retain(|w| w.strong_count() > 0);
        list.iter().filter_map(|w| w.upgrade()).collect()
    };
    stop_all(&workers, timeout)
}

fn stop_all(workers: &[Arc<dyn Stop>], timeout: Duration) -> usize {
    for worker in workers {
        worker.close();
    }
    let deadline = Instant::now() + timeout;
    loop {
        let running = workers.iter().filter(|w| !w.exited()).count();
        if running == 0 || Instant::now() >= deadline {
            return running;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// One owned worker thread, a one-deep latest-wins queue, and generation-stamped
/// results. `run` is only ever called on the worker, one input at a time.
struct LatestWorker<I, O> {
    channel: Arc<Channel<I, O>>,
    generation: u64,
    _thread: JoinHandle<()>,
}

impl<I: Send + 'static, O: Clone + Send + 'static> LatestWorker<I, O> {
    fn spawn(name: &str, mut run: impl FnMut(I) -> O + Send + 'static) -> std::io::Result<Self> {
        let channel = Arc::new(Channel {
            slot: Mutex::new(Slot {
                pending: None,
                running: None,
                done: None,
                closed: false,
                exited: false,
            }),
            changed: Condvar::new(),
        });
        let shared = channel.clone();
        let thread = std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                'serve: loop {
                    let job = {
                        let mut slot = shared.lock();
                        loop {
                            if slot.closed {
                                break 'serve;
                            }
                            if let Some(job) = slot.pending.take() {
                                slot.running = Some(Running {
                                    generation: job.generation,
                                    key: job.key,
                                    started: Instant::now(),
                                });
                                break job;
                            }
                            slot = shared.changed.wait(slot).unwrap_or_else(|p| p.into_inner());
                        }
                    };
                    let output = run(job.input);
                    let mut slot = shared.lock();
                    slot.running = None;
                    slot.done = Some(Done {
                        generation: job.generation,
                        key: job.key,
                        output,
                    });
                    shared.changed.notify_all();
                }
                // The engine goes with `run`, here on the worker, before saying so.
                drop(run);
                shared.lock().exited = true;
                shared.changed.notify_all();
            })?;
        let stop: Arc<dyn Stop> = channel.clone();
        WORKERS.lock().unwrap_or_else(|p| p.into_inner()).push(Arc::downgrade(&stop));
        Ok(Self {
            channel,
            generation: 0,
            _thread: thread,
        })
    }

    /// Ask for `input` (whose content is identified by `key`) and wait at most
    /// `timeout` for its answer.
    fn submit(&mut self, key: u64, input: I, timeout: Duration) -> Outcome<O> {
        let deadline = Instant::now() + timeout;
        let mut slot = self.channel.lock();
        if let Some(done) = slot.done.as_ref().filter(|done| done.key == key) {
            return Outcome::Ready(done.output.clone());
        }
        let generation = match slot.running.as_ref().filter(|running| running.key == key) {
            // The same pixels are already being read: wait for that, do not queue a twin.
            Some(running) => running.generation,
            None => {
                self.generation += 1;
                slot.pending = Some(Job {
                    generation: self.generation,
                    key,
                    input,
                });
                self.channel.changed.notify_all();
                self.generation
            }
        };
        loop {
            if let Some(done) = slot
                .done
                .as_ref()
                .filter(|done| done.generation == generation || done.key == key)
            {
                return Outcome::Ready(done.output.clone());
            }
            let now = Instant::now();
            if now >= deadline {
                return Outcome::Busy {
                    running_for: slot.running.as_ref().map(|r| r.started.elapsed()),
                };
            }
            slot = self
                .channel
                .changed
                .wait_timeout(slot, deadline - now)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
    }
}

impl<I, O> Drop for LatestWorker<I, O> {
    fn drop(&mut self) {
        // The thread exits when it next looks at the slot; a run in progress
        // finishes first and its result is discarded with the channel.
        self.channel.lock().closed = true;
        self.channel.changed.notify_all();
    }
}

#[cfg(test)]
mod watcher_language_tests {
    use super::engine_for;

    #[test]
    fn a_japanese_only_watcher_never_watches_another_language() {
        assert_eq!(engine_for(Some("meikiocr"), "ja"), "meikiocr");
        assert_eq!(engine_for(None, "ja"), super::DEFAULT_ENGINE);
        assert_eq!(engine_for(Some("ppocr"), "en"), "ppocr");
        for requested in [Some("meikiocr"), Some("vocr"), None] {
            let engine = engine_for(requested, "ko");
            assert!(crate::language::engine_supports(engine, "ko"), "{engine}");
            let engine = engine_for(requested, "hi");
            assert!(crate::language::engine_supports(engine, "hi"), "{engine}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    };

    fn meiki(text: &str, bbox: [u32; 4]) -> meikiocr::TextLine {
        meikiocr::TextLine {
            text: text.into(),
            bbox,
            detection_confidence: Some(0.9),
            characters: vec![],
            is_vertical: false,
        }
    }

    #[test]
    fn meiki_boxes_become_frame_pixel_lines() {
        let lines = text_lines(
            &[
                meiki("日本語", [10, 20, 90, 40]),
                meiki("  ", [0, 0, 5, 5]),
                meiki("はみ出す", [150, 90, 260, 130]),
            ],
            200,
            100,
        );
        assert_eq!(lines.len(), 2, "blank lines are dropped");
        assert_eq!(lines[0].text, "日本語");
        assert_eq!(
            (lines[0].x, lines[0].y, lines[0].width, lines[0].height),
            (10.0, 20.0, 80.0, 20.0)
        );
        // Clamped to the frame rather than reaching outside it.
        assert_eq!(
            (lines[1].x, lines[1].y, lines[1].width, lines[1].height),
            (150.0, 90.0, 50.0, 10.0)
        );
        assert_eq!(join_lines(&lines), "日本語\nはみ出す");
    }

    fn frame(width: u32, height: u32, stride: usize) -> Frame {
        Frame {
            info: kimochi_capture::FrameInfo {
                source_id: "test".into(),
                width,
                height,
                stride,
                full_width: width,
                full_height: height,
                crop_pixels: [0, 0, width, height],
                scale_factor: 1.0,
                source_bounds: None,
                pixel_format: "rgba8",
                color_space: "srgb",
                resolve_ms: 0.0,
                acquisition_ms: 0.0,
                pixels_ms: 0.0,
                total_ms: 0.0,
            },
            pixels: (0..stride * height as usize).map(|i| i as u8).collect(),
        }
    }

    /// What `EngineObserver::observe` does with its `RecentReads`: reuse a read of these exact
    /// pixels, or read the frame (counting reads) and remember it.
    fn look(recent: &mut RecentReads<String>, frame: &Frame, reads: &mut usize) -> String {
        recent.enter(frame);
        let key = frame_key(frame);
        if let Some(read) = recent.get(key) {
            return read;
        }
        *reads += 1;
        let read = format!("read {}", frame.pixels[0]);
        recent.put(key, read.clone());
        read
    }

    fn with_pixel(mut frame: Frame, value: u8) -> Frame {
        frame.pixels[0] = value;
        frame
    }

    #[test]
    fn a_screen_flipping_between_two_states_is_read_once_per_state() {
        // A blinking ▼: the frame alternates A/B/A/B for as long as the player reads.
        let (a, b) = (with_pixel(frame(4, 2, 16), 1), with_pixel(frame(4, 2, 16), 2));
        let mut recent = RecentReads::new();
        let mut reads = 0;
        for _ in 0..10 {
            assert_eq!(look(&mut recent, &a, &mut reads), "read 1");
            assert_eq!(look(&mut recent, &b, &mut reads), "read 2");
        }
        assert_eq!(reads, 2);
    }

    #[test]
    fn recent_reads_keep_only_the_last_few_frames() {
        let frames: Vec<_> = (0..=RECENT_READS as u8).map(|v| with_pixel(frame(4, 2, 16), v)).collect();
        let mut recent = RecentReads::new();
        let mut reads = 0;
        for f in &frames {
            look(&mut recent, f, &mut reads);
        }
        assert_eq!(reads, RECENT_READS + 1);
        // The newest four are still there; the oldest was dropped and is read again.
        for f in &frames[1..] {
            look(&mut recent, f, &mut reads);
        }
        assert_eq!(reads, RECENT_READS + 1);
        look(&mut recent, &frames[0], &mut reads);
        assert_eq!(reads, RECENT_READS + 2);
    }

    #[test]
    fn a_new_source_or_crop_forgets_every_recent_read() {
        let a = with_pixel(frame(4, 2, 16), 1);
        let mut recent = RecentReads::new();
        let mut reads = 0;
        look(&mut recent, &a, &mut reads);
        let mut other_source = with_pixel(frame(4, 2, 16), 1);
        other_source.info.source_id = "other".into();
        look(&mut recent, &other_source, &mut reads);
        assert_eq!(recent.reads.len(), 1, "the first source's reads are gone");
        let mut cropped = with_pixel(frame(4, 2, 16), 1);
        cropped.info.source_id = "other".into();
        cropped.info.crop_pixels = [1, 0, 3, 2];
        look(&mut recent, &cropped, &mut reads);
        assert_eq!(recent.reads.len(), 1, "the uncropped reads are gone");
        // Back to the first source: read again, not served from before.
        look(&mut recent, &a, &mut reads);
        assert_eq!(reads, 4);
        recent.clear();
        assert!(recent.reads.is_empty() && recent.scope.is_none());
    }

    #[test]
    fn stopping_waits_for_the_read_in_progress_and_the_engine_to_go() {
        struct Engine(Arc<AtomicUsize>);
        impl Drop for Engine {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicUsize::new(0));
        let engine = Engine(dropped.clone());
        let (started_tx, started_rx) = mpsc::channel();
        let mut worker = LatestWorker::spawn("test-stop", move |input: u32| {
            let _engine = &engine;
            started_tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(150));
            input
        })
        .unwrap();
        let _ = worker.submit(1, 1, Duration::ZERO);
        started_rx.recv().unwrap();
        let stop: Arc<dyn Stop> = worker.channel.clone();
        assert_eq!(stop_all(&[stop.clone()], Duration::from_secs(5)), 0);
        assert!(stop.exited());
        assert_eq!(dropped.load(Ordering::SeqCst), 1, "the engine is dropped before exit proceeds");
    }

    #[test]
    fn stopping_gives_up_on_a_wedged_read_after_the_timeout() {
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (started_tx, started_rx) = mpsc::channel();
        let mut worker = LatestWorker::spawn("test-wedged", move |input: u32| {
            started_tx.send(()).unwrap();
            let _ = release_rx.recv();
            input
        })
        .unwrap();
        let _ = worker.submit(1, 1, Duration::ZERO);
        started_rx.recv().unwrap();
        let stop: Arc<dyn Stop> = worker.channel.clone();
        let clock = Instant::now();
        assert_eq!(stop_all(&[stop.clone()], Duration::from_millis(50)), 1);
        assert!(clock.elapsed() < Duration::from_secs(2));
        release_tx.send(()).unwrap();
    }

    #[test]
    fn rgba_rows_with_padding_become_rgb() {
        let image = rgb_image(&frame(2, 2, 12)).unwrap();
        assert_eq!((image.width(), image.height()), (2, 2));
        // Row 0: bytes 0..8; row 1 starts at the stride (12), padding skipped.
        assert_eq!(image.as_raw(), &[0, 1, 2, 4, 5, 6, 12, 13, 14, 16, 17, 18]);
        let mut short = frame(2, 2, 8);
        short.pixels.truncate(10);
        assert_eq!(rgb_image(&short).unwrap_err().code, "observe");
    }

    #[test]
    fn identical_frames_share_a_key_and_any_change_does_not() {
        let a = frame(2, 2, 8);
        let mut b = frame(2, 2, 8);
        assert_eq!(frame_key(&a), frame_key(&b));
        b.pixels[3] ^= 1;
        assert_ne!(frame_key(&a), frame_key(&b));
    }

    #[test]
    fn oneocr_groups_are_its_lines_and_fragments_are_not_counted_again() {
        // What the worker sends for a line with words: the line as a group, each word a
        // fragment, and no `line` annotation at all (oneocr-worker/src/main.rs `parse`).
        let poly = |x: f64, y: f64| serde_json::json!({"vertices": [
            {"x": x, "y": y}, {"x": x + 40.0, "y": y}, {"x": x + 40.0, "y": y + 20.0}, {"x": x, "y": y + 20.0}
        ]});
        let result = serde_json::json!({
            "fullText": "今日は\n猫",
            "groups": [
                {"id": "oneocr-line-0", "text": "今日は", "bbox": [10.0, 30.0, 110.0, 50.0], "orientation": "horizontal", "linePolygons": [[[10.0, 30.0], [110.0, 30.0], [110.0, 50.0], [10.0, 50.0]]]},
                {"id": "oneocr-line-1", "text": "猫", "bbox": [10.0, 60.0, 30.0, 80.0], "orientation": "horizontal", "linePolygons": [[[10.0, 60.0], [30.0, 60.0], [30.0, 80.0], [10.0, 80.0]]]},
                {"id": "oneocr-line-2", "text": "  ", "bbox": [10.0, 90.0, 30.0, 110.0], "orientation": "horizontal", "linePolygons": []}
            ],
            "textAnnotations": [
                {"description": "今日は\n猫", "granularity": "aggregate", "boundingPoly": poly(0.0, 0.0)},
                {"description": "今日", "granularity": "fragment", "boundingPoly": poly(10.0, 30.0), "groupId": "oneocr-line-0"},
                {"description": "は", "granularity": "fragment", "boundingPoly": poly(50.0, 30.0), "groupId": "oneocr-line-0"},
                {"description": "猫", "granularity": "fragment", "boundingPoly": poly(10.0, 60.0), "groupId": "oneocr-line-1"}
            ]
        });
        let lines = annotation_lines(&result);
        assert_eq!(lines.len(), 2);
        assert_eq!((lines[0].text.as_str(), lines[0].x, lines[0].y, lines[0].width, lines[0].height), ("今日は", 10.0, 30.0, 100.0, 20.0));
        assert_eq!(lines[1].text.as_str(), "猫");
        assert_eq!(join_lines(&lines), "今日は\n猫");
    }

    #[test]
    fn oneocr_line_annotations_become_lines_and_its_fragments_do_not() {
        // A result without groups (an older worker): its `line` annotations are the lines.
        let poly = |x: f64, y: f64| serde_json::json!({"vertices": [
            {"x": x, "y": y}, {"x": x + 100.0, "y": y}, {"x": x + 100.0, "y": y + 20.0}, {"x": x, "y": y + 20.0}
        ]});
        let result = serde_json::json!({"textAnnotations": [
            {"description": "全部", "granularity": "aggregate", "boundingPoly": poly(0.0, 0.0)},
            {"description": "今日は", "granularity": "line", "boundingPoly": poly(10.0, 30.0)},
            {"description": "今日", "granularity": "fragment", "boundingPoly": poly(10.0, 30.0)},
            {"description": "  ", "granularity": "line", "boundingPoly": poly(10.0, 60.0)},
        ]});
        let lines = annotation_lines(&result);
        assert_eq!(lines.len(), 1);
        assert_eq!((lines[0].text.as_str(), lines[0].x, lines[0].y, lines[0].width), ("今日は", 10.0, 30.0, 100.0));
    }

    #[test]
    fn slow_is_busy_and_only_a_long_stall_is_standing() {
        assert_eq!(busy_error("MeikiOCR", None).code, "busy");
        assert_eq!(busy_error("MeikiOCR", Some(Duration::from_secs(2))).code, "busy");
        assert_eq!(busy_error("MeikiOCR", Some(STALL_AFTER)).code, "stalled");
    }

    /// The worker, the sender that releases one run, and the inputs it ran.
    type Gated = (
        LatestWorker<u32, u32>,
        mpsc::Sender<()>,
        Arc<Mutex<Vec<u32>>>,
    );

    /// A worker whose runs each wait for a release, recording what they ran.
    fn gated() -> Gated {
        let (release, gate) = mpsc::channel::<()>();
        let ran = Arc::new(Mutex::new(Vec::new()));
        let log = ran.clone();
        let worker = LatestWorker::spawn("test-worker", move |input: u32| {
            gate.recv().unwrap();
            log.lock().unwrap().push(input);
            input * 10
        })
        .unwrap();
        (worker, release, ran)
    }

    const SHORT: Duration = Duration::from_millis(30);
    const LONG: Duration = Duration::from_secs(5);

    #[test]
    fn an_answer_in_time_is_returned() {
        let (mut worker, release, _) = gated();
        release.send(()).unwrap();
        assert_eq!(worker.submit(1, 1, LONG), Outcome::Ready(10));
    }

    #[test]
    fn a_timeout_is_busy_and_the_late_answer_serves_identical_pixels() {
        let (mut worker, release, ran) = gated();
        let Outcome::Busy { running_for } = worker.submit(7, 7, SHORT) else {
            panic!("should time out")
        };
        assert!(running_for.is_some(), "the job is in flight");
        release.send(()).unwrap();
        // Same pixels again: waits for the in-flight read instead of queueing a twin.
        assert_eq!(worker.submit(7, 7, LONG), Outcome::Ready(70));
        // And later identical frames reuse it without running again.
        assert_eq!(worker.submit(7, 7, SHORT), Outcome::Ready(70));
        assert_eq!(*ran.lock().unwrap(), vec![7]);
    }

    #[test]
    fn the_queue_is_one_deep_and_latest_wins() {
        let (mut worker, release, ran) = gated();
        assert!(matches!(worker.submit(1, 1, SHORT), Outcome::Busy { .. })); // running
        assert!(matches!(worker.submit(2, 2, SHORT), Outcome::Busy { .. })); // queued
        assert!(matches!(worker.submit(3, 3, SHORT), Outcome::Busy { .. })); // replaces 2
        release.send(()).unwrap(); // finishes 1
        release.send(()).unwrap(); // finishes 3
        assert_eq!(worker.submit(3, 3, LONG), Outcome::Ready(30));
        assert_eq!(*ran.lock().unwrap(), vec![1, 3], "frame 2 was superseded");
    }

    #[test]
    fn a_late_answer_for_another_frame_is_never_reported_as_this_one() {
        let (mut worker, release, _) = gated();
        assert!(matches!(worker.submit(1, 1, SHORT), Outcome::Busy { .. }));
        release.send(()).unwrap(); // 1 completes while 2 is being asked for
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            c.fetch_add(1, Ordering::SeqCst);
            release.send(()).unwrap();
        });
        assert_eq!(worker.submit(2, 2, LONG), Outcome::Ready(20));
        releaser.join().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dropping_the_worker_stops_its_thread() {
        let (worker, release, _) = gated();
        let channel = worker.channel.clone();
        drop(worker);
        drop(release);
        assert!(channel.lock().closed);
    }
}
