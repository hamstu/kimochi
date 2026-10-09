//! Which local text observer automatic scanning uses, and the MeikiOCR one.
//!
//! macOS keeps Apple Live Text (`kimochi_capture::platform_observer()`) exactly
//! as before. Windows and Linux have no OS engine Kimochi can use unpackaged, so
//! they read frames with the bundled MeikiOCR (detection plus recognition on the
//! whole frame, the same pipeline the manual scan uses).
//!
//! # Thread and memory model
//!
//! `TextObserver::observe` promises to return within its timeout, and Meiki on a
//! CPU can take longer than that on a large frame. So the observer never runs
//! inference on the caller's thread:
//!
//!  - one dedicated worker thread owns one `MeikiOcr` engine, loaded lazily on
//!    the first observation (never at startup);
//!  - the queue is one slot deep and latest-wins: a request that has not started
//!    is replaced by a newer one, so the worker never works through a backlog of
//!    frames the screen has already moved past;
//!  - each request carries a generation and a content key; a caller only accepts
//!    the result for its own generation or for identical pixels, so a late result
//!    for an older frame is dropped rather than reported as the current screen;
//!  - a result for identical pixels is reused, so a slow engine on a static screen
//!    (exactly when settling matters) still converges instead of timing out on
//!    every tick.
//!
//! The observer's engine is separate from the manual scan's (`MeikiState`), so a
//! slow accurate scan cannot starve observer ticks and neither path ever waits
//! on the other's lock. The cost is a second copy of the three ONNX sessions
//! while automatic scanning has been used: the models are 44 MB on disk and the
//! sessions take very roughly 100-150 MB resident on CPU (plus GPU memory on
//! DirectML). Two DirectML engines never run at once: `meiki_ocr::infer` holds a
//! process-wide run lock for DirectML sessions only, which no holder nests.
//!
//! # Error codes (see `capture_frame` in main.rs)
//!
//!  - `unsupported`: the runtime or models cannot be loaded here. A standing
//!    fact; automatic text mode turns itself off with this message.
//!  - `stalled`: one inference has been running for longer than `STALL_AFTER`.
//!    The engine took a request and has not given it back; nothing more can be
//!    started on it, so this is also treated as standing.
//!  - `busy`: the answer was not ready within the timeout (cold engine load, a
//!    slow CPU, or a manual DirectML scan holding the run lock). Non-fatal by
//!    design: a slow-but-working observer must not be reported unsupported, so
//!    the scheduler backs off and retries, and the identical-pixels reuse above
//!    hands it the answer once one exists.
//!  - `observe`: inference ran and failed for this frame. Non-fatal.

// macOS keeps only the Live Text branch; the Meiki worker below is compiled but unused there.
#![cfg_attr(target_os = "macos", allow(dead_code))]
#[cfg(not(target_os = "macos"))]
use kimochi_capture::text::UnsupportedObserver;
use kimochi_capture::{
    text::{join_lines, CachedObserver},
    CaptureError, Frame, Observation, ObserverStatus, TextLine, TextObserver,
};
use std::{
    sync::{Arc, Condvar, Mutex, MutexGuard},
    thread::JoinHandle,
    time::{Duration, Instant},
};

/// The observer automatic scanning uses on this OS, behind the one-frame cache.
///
/// Infallible like `platform_observer()`: when MeikiOCR is not installed the
/// answer is an `UnsupportedObserver` that says why.
pub fn local_observer(app: &tauri::AppHandle) -> Box<dyn TextObserver> {
    announce_verified_capabilities(app);
    #[cfg(target_os = "macos")]
    {
        Box::new(CachedObserver::new(kimochi_capture::platform_observer()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Only the bundled runtime is a standing fact here: the models may still be
        // downloading, and `MeikiObserver` waits for them (see `models_gate`).
        let inner: Box<dyn TextObserver> = match crate::meiki_ocr::runtime_available(app) {
            Ok(()) => Box::new(MeikiObserver::new(app.clone())),
            // Leaked once at startup: `UnsupportedObserver` holds a `&'static str`.
            Err(reason) => Box::new(UnsupportedObserver::new(Box::leak(
                unavailable_detail(&reason).into_boxed_str(),
            ))),
        };
        Box::new(CachedObserver::new(inner))
    }
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
}

fn unavailable_detail(reason: &str) -> String {
    format!(
        "Automatic scanning needs the local MeikiOCR engine, which is not available: {reason} Manual scanning works normally."
    )
}

/// How long one inference may run before the observer is reported stalled.
const STALL_AFTER: Duration = Duration::from_secs(30);

/// One read, as the worker returns it.
#[derive(Clone)]
struct Read {
    lines: Vec<TextLine>,
    duration_ms: f64,
}

#[derive(Clone)]
enum Failure {
    /// The engine cannot be loaded here; standing.
    Unavailable(String),
    /// This frame failed; transient.
    Inference(String),
}

type Answer = Result<Read, Failure>;

/// The Windows/Linux `TextObserver`: MeikiOCR on a dedicated worker.
pub struct MeikiObserver {
    app: tauri::AppHandle,
    worker: Option<LatestWorker<image::RgbImage, Answer>>,
    /// Set once the engine has failed to load; every later call says so.
    unsupported: Option<String>,
    timeouts: u32,
}

impl MeikiObserver {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            worker: None,
            unsupported: None,
            timeouts: 0,
        }
    }

    fn worker(&mut self) -> Result<&mut LatestWorker<image::RgbImage, Answer>, CaptureError> {
        if self.worker.is_none() {
            let app = self.app.clone();
            let mut engine = None;
            let mut failed: Option<String> = None;
            let run = move |image: image::RgbImage| -> Answer {
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
                match crate::meiki_ocr::infer(meiki, &image) {
                    Ok(lines) => Ok(Read {
                        lines: text_lines(&lines, image.width(), image.height()),
                        duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                    }),
                    Err(e) => {
                        // A panicking session may be left inconsistent: rebuild it next time.
                        if e.starts_with(crate::engine_probe::PANIC_PREFIX) {
                            engine = None;
                        }
                        Err(Failure::Inference(e))
                    }
                }
            };
            let worker = LatestWorker::spawn("kimochi-meiki-observer", run)
                .map_err(|e| CaptureError::new("observe", format!("MeikiOCR observer: {e}")))?;
            self.worker = Some(worker);
        }
        Ok(self.worker.as_mut().expect("worker was just created"))
    }
}

/// Automatic scanning reads frames with MeikiOCR whichever engine recognises the text,
/// so its models are needed even with Cloud OCR selected. Missing models start their
/// download (about 45 MB). While it runs the observer answers `busy`, which the
/// scheduler retries without turning automatic scanning off; a paused or failed
/// download is `unsupported` until the user resumes it in Settings → OCR.
///
/// Never sticky: once the models are ready the next observation proceeds.
fn models_gate(app: &tauri::AppHandle) -> Result<(), CaptureError> {
    use crate::model_store::{self, Engine};
    let Err(reason) = crate::meiki_ocr::models_ready(app) else {
        return Ok(());
    };
    model_store::ensure_started(app, Engine::Meiki);
    let waiting = matches!(
        model_store::status(app, Engine::Meiki).state,
        "downloading" | "verifying"
    );
    if waiting {
        Err(CaptureError::new(
            "busy",
            format!("Automatic scanning is waiting for the MeikiOCR model: {reason}"),
        ))
    } else {
        Err(CaptureError::new(
            "unsupported",
            unavailable_detail(&reason),
        ))
    }
}

impl TextObserver for MeikiObserver {
    fn status(&self) -> ObserverStatus {
        let models = crate::meiki_ocr::models_ready(&self.app).err();
        let reason = self.unsupported.as_ref().or(models.as_ref());
        ObserverStatus {
            supported: reason.is_none(),
            engine: "meikiocr",
            minimum_os: "",
            private_api: false,
            detail: match reason {
                Some(reason) => unavailable_detail(reason),
                None => "Automatic scanning reads each changed frame with the bundled MeikiOCR engine on this computer; nothing leaves it until the text settles.".into(),
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
            return Err(CaptureError::new("unsupported", unavailable_detail(reason)));
        }
        models_gate(&self.app)?;
        let key = frame_key(frame);
        let image = rgb_image(frame)?;
        match self.worker()?.submit(key, image, timeout) {
            Outcome::Ready(Ok(read)) => Ok(Observation {
                engine: "meikiocr",
                text: join_lines(&read.lines),
                lines: read.lines,
                duration_ms: read.duration_ms,
            }),
            Outcome::Ready(Err(Failure::Unavailable(reason))) => {
                let error = CaptureError::new("unsupported", unavailable_detail(&reason));
                self.unsupported = Some(reason);
                Err(error)
            }
            Outcome::Ready(Err(Failure::Inference(message))) => {
                Err(CaptureError::new("observe", message))
            }
            Outcome::Busy { running_for } => {
                self.timeouts += 1;
                Err(busy_error(running_for))
            }
        }
    }

    fn close(&mut self) {
        // Detached, not joined: a wedged inference must not hang the caller.
        // The next observation starts a fresh worker and engine.
        self.worker = None;
    }
}

/// The error for an answer that was not ready in time (see the module docs).
fn busy_error(running_for: Option<Duration>) -> CaptureError {
    match running_for {
        Some(running) if running >= STALL_AFTER => CaptureError::new(
            "stalled",
            format!(
                "The local MeikiOCR observer has been reading one frame for {} s and has not answered; restart Kimochi to use automatic scanning again. Manual scanning works normally.",
                running.as_secs()
            ),
        ),
        _ => CaptureError::new(
            "busy",
            "The local MeikiOCR observer is still reading an earlier frame; retrying.",
        ),
    }
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
            }
        })
        .collect()
}

/// The frame's RGBA rows (with their stride) as the RGB image Meiki reads.
fn rgb_image(frame: &Frame) -> kimochi_capture::Result<image::RgbImage> {
    let (width, height) = (frame.info.width as usize, frame.info.height as usize);
    let stride = frame.info.stride.max(width * 4);
    if width == 0 || height == 0 || frame.pixels.len() < stride * (height - 1) + width * 4 {
        return Err(CaptureError::new(
            "observe",
            "the frame is empty or shorter than its geometry",
        ));
    }
    let mut rgb = Vec::with_capacity(width * height * 3);
    for row in frame.pixels.chunks(stride).take(height) {
        for pixel in row[..width * 4].as_chunks::<4>().0 {
            rgb.extend_from_slice(&pixel[..3]);
        }
    }
    image::RgbImage::from_raw(frame.info.width, frame.info.height, rgb)
        .ok_or_else(|| CaptureError::new("observe", "the frame could not be converted"))
}

/// Identity of a frame's content, for reusing a result on identical pixels.
fn frame_key(frame: &Frame) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    frame.info.source_id.hash(&mut hash);
    frame.info.width.hash(&mut hash);
    frame.info.height.hash(&mut hash);
    frame.info.crop_pixels.hash(&mut hash);
    frame.pixels.hash(&mut hash);
    hash.finish()
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
            }),
            changed: Condvar::new(),
        });
        let shared = channel.clone();
        let thread = std::thread::Builder::new()
            .name(name.into())
            .spawn(move || loop {
                let job = {
                    let mut slot = shared.lock();
                    loop {
                        if slot.closed {
                            return;
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
            })?;
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
    fn slow_is_busy_and_only_a_long_stall_is_standing() {
        assert_eq!(busy_error(None).code, "busy");
        assert_eq!(busy_error(Some(Duration::from_secs(2))).code, "busy");
        assert_eq!(busy_error(Some(STALL_AFTER)).code, "stalled");
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
