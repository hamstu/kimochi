//! Sentence audio: what this computer plays, kept for a little while when the setting is on, so
//! each Log line gets the clip of its voice, to play from the Log and to go on the cards mined
//! from it. Game Sentence Miner's idea (an OBS replay buffer cut at each line), done without OBS
//! and listening to what was said.
//!
//! - **Capture** (`kimochi_capture::audio`, the `record` thread): what the computer plays, mono,
//!   into a ring of `sentenceAudio.seconds`. Restarted when it stops.
//! - **Listening** (`kimochi_speech::listener`, the `listen` thread): follows a copy of the ring,
//!   hears where speech is and, once the speech model is downloaded (Settings → Anki), what was
//!   said; decides for each line the Log reports (`sentence_audio_line`) what its voice was. The
//!   automatic-scan observer's quick readings (`screen_text`) tell it when an OCR'd line began to
//!   appear. Every decision cuts a clip into the clip store (`sentenceAudio.clips` kept, MP3 files
//!   in `<app local data>/sentence-audio/`) and is announced as `sentence-audio-line`.
//! - **Cards**: after a card is added (a dictionary extension's `addNote` through the AnkiConnect
//!   relay, or Kimochi's own pop-up through `sentence_audio_attach`), its line is found by its
//!   text, its clip put in the card's sentence-audio field, and, when a word-audio field is set
//!   and the clip was matched by its words, the mined word's own audio in that field. Only empty
//!   fields are filled. The card is never held up: the audio follows it.
//!
//! Settings: `sentenceAudio` (a machine key, never synced: recording is this computer's choice).
use crate::reader::ankiconnect;
use crate::settings::Settings;
use base64::Engine as _;
use kimochi_capture::audio::{now_ms, AudioRing, SystemAudio};
use kimochi_speech::clips::{self, ClipStore};
use kimochi_speech::listener::{Cutting, Decision, Listener, Outcome};
use kimochi_speech::sense_voice::SenseVoice;
use kimochi_speech::timeline::{self, Line};
use kimochi_speech::vad::Vad;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// How long a card waits for its line to be decided (its voice to end) before taking what has
/// been heard.
const MAX_WAIT_MS: f64 = 15_000.0;
const DRAIN_EVERY: Duration = Duration::from_millis(50);
const LISTEN_EVERY: Duration = Duration::from_millis(100);
/// How often the listener looks for the speech model (downloaded, or removed).
const MODEL_CHECK_EVERY: Duration = Duration::from_secs(2);
/// CPU threads the recogniser uses: enough to keep well ahead of the recording, little enough
/// to leave the game alone.
const RECOGNISER_THREADS: usize = 2;
const RESTART_AFTER: Duration = Duration::from_secs(5);
const RETRY_UNAVAILABLE: Duration = Duration::from_secs(30);
/// Line states kept for the Log: far more than the clips kept.
const LINES_KEEP: usize = 500;
/// The Diagnostics window shows this many of the newest lines, and what was heard this far back.
const DEBUG_LINES: usize = 40;
const DEBUG_HEARD_MS: f64 = 60_000.0;

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    /// Audio kept, in seconds.
    pub seconds: f64,
    /// The note field the line's audio goes in.
    pub field: String,
    /// The note field the mined word's audio goes in; empty: none.
    pub word_field: String,
    /// Clips kept on disk.
    pub clips: usize,
    /// Moves the clip's start and end (negative: earlier).
    pub start_offset_ms: f64,
    pub end_offset_ms: f64,
    /// Cut a clip found by timing to the voice in it; off keeps the line's whole window.
    pub trim: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            seconds: 30.0,
            field: "SentenceAudio".into(),
            word_field: String::new(),
            clips: 15,
            start_offset_ms: 0.0,
            end_offset_ms: 0.0,
            trim: true,
        }
    }
}

impl Config {
    pub fn load(settings: &Settings) -> Self {
        let mut config: Config = settings
            .get("sentenceAudio")
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        config.seconds = config.seconds.clamp(10.0, 120.0);
        config.clips = config.clips.clamp(5, 100);
        config.start_offset_ms = config.start_offset_ms.clamp(-5_000.0, 5_000.0);
        config.end_offset_ms = config.end_offset_ms.clamp(-5_000.0, 5_000.0);
        config.field = config.field.trim().to_string();
        config.word_field = config.word_field.trim().to_string();
        config
    }

    fn cutting(&self) -> Cutting {
        Cutting { start_offset_ms: self.start_offset_ms, end_offset_ms: self.end_offset_ms, trim: self.trim, ..Cutting::default() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum State {
    Off,
    Starting,
    /// `source`: what is recorded. `excludesOwnAudio`: Kimochi's own sounds are left out.
    #[serde(rename_all = "camelCase")]
    Recording { source: String, excludes_own_audio: bool },
    /// macOS: Screen Recording is not granted.
    NoPermission { message: String },
    /// This computer cannot record its audio now (no PipeWire, no output device); tried again
    /// every `RETRY_UNAVAILABLE`.
    Unavailable { message: String },
    /// No backend for this OS.
    Unsupported { message: String },
    /// The stream failed or stopped; it is started again shortly.
    Error { message: String },
}

/// Whether lines are matched by their words: the speech model's state in the listener.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Recogniser {
    /// Not downloaded: lines are placed by timing.
    Absent,
    Loading,
    Ready,
    Failed { message: String },
}

/// What happened to the last card's audio, for Settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCard {
    pub at: f64,
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    #[serde(flatten)]
    pub state: State,
    /// `macos`, `windows` or `linux`: what the recording can do differs.
    pub platform: &'static str,
    /// Seconds of audio held.
    pub held: f64,
    /// Loudness of the last half second, 0..1, for a level meter.
    pub level: f32,
    pub recogniser: Recogniser,
    pub last: Option<LastCard>,
}

/// A line's audio, as the Log shows it (`sentence-audio-line`, `sentence_audio_lines`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineAudio {
    pub uid: String,
    /// `voiced` (a clip to play), `silent` (no voice was found) or `missed` (its audio was gone).
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    /// `matched` (found by its words) or `timed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub how: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// What the Diagnostics window shows (`sentence_audio_debug`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Debug {
    pub status: Status,
    /// Clips kept on disk.
    pub clips: usize,
    /// None until recording starts.
    pub listener: Option<kimochi_speech::listener::Report>,
}

/// A clip ready for Anki.
/// Taken from the clip store in one go, so a line decided again while the card is being sent
/// cannot mix one clip's audio with another's word.
pub struct Made {
    pub filename: String,
    pub mp3: Vec<u8>,
    pub duration_ms: f64,
    pub matched: bool,
    /// The mined word and its audio, when asked for and found in the line.
    pub word: Option<(String, Vec<u8>)>,
}

/// What the service needs from the app: kept apart so the tests run it without one.
pub struct Host {
    /// Initialise the ONNX Runtime (`meiki_ocr::onnx_runtime`).
    pub runtime: Box<dyn Fn() -> Result<(), String> + Send + Sync>,
    /// Where the downloaded speech model is, when it is ready.
    pub model_dir: Box<dyn Fn() -> Option<PathBuf> + Send + Sync>,
    pub emit: Box<dyn Fn(&LineAudio) + Send + Sync>,
}

enum Input {
    Line(Line),
    Forget(Vec<String>),
    Screen(String, f64),
}

/// The listener and its own copy of the recording, owned by the `listen` thread (and borrowed by
/// a card that cannot wait).
struct Ears {
    listener: Listener,
    ring: AudioRing,
    /// The next sample of the shared ring to copy.
    cursor: Option<u64>,
    model: Option<PathBuf>,
    model_checked: Option<Instant>,
}

pub struct SentenceAudio {
    host: Arc<Host>,
    settings: Arc<Settings>,
    ring: Arc<Mutex<AudioRing>>,
    ears: Arc<Mutex<Option<Ears>>>,
    inbox: Arc<Mutex<Vec<Input>>>,
    store: Arc<Mutex<ClipStore>>,
    lines: Arc<Mutex<VecDeque<LineAudio>>>,
    state: Arc<Mutex<State>>,
    recogniser: Arc<Mutex<Recogniser>>,
    last: Mutex<Option<LastCard>>,
    /// Bumped on every stop, so the threads from before exit.
    generation: Arc<AtomicU64>,
    running: Mutex<bool>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl SentenceAudio {
    pub fn new(app: tauri::AppHandle, settings: Arc<Settings>) -> Arc<Self> {
        let clips_dir = app
            .path()
            .app_local_data_dir()
            .map(|d| d.join("sentence-audio"))
            .unwrap_or_else(|_| std::env::temp_dir().join("kimochi-sentence-audio"));
        let (runtime_app, model_app, emit_app) = (app.clone(), app.clone(), app);
        let host = Host {
            runtime: Box::new(move || crate::meiki_ocr::onnx_runtime(&runtime_app)),
            model_dir: Box::new(move || {
                crate::model_store::models_dir(&model_app, crate::model_store::Engine::SenseVoice).ok()
            }),
            emit: Box::new(move |line| {
                let _ = emit_app.emit("sentence-audio-line", line);
            }),
        };
        Self::with_host(settings, host, clips_dir)
    }

    fn with_host(settings: Arc<Settings>, host: Host, clips_dir: PathBuf) -> Arc<Self> {
        let config = Config::load(&settings);
        Arc::new(Self {
            host: Arc::new(host),
            settings,
            ring: Arc::new(Mutex::new(AudioRing::new(48_000, config.seconds))),
            ears: Arc::new(Mutex::new(None)),
            inbox: Arc::new(Mutex::new(Vec::new())),
            store: Arc::new(Mutex::new(ClipStore::open(clips_dir, config.clips))),
            lines: Arc::new(Mutex::new(VecDeque::new())),
            state: Arc::new(Mutex::new(State::Off)),
            recogniser: Arc::new(Mutex::new(Recogniser::Absent)),
            last: Mutex::new(None),
            generation: Arc::new(AtomicU64::new(0)),
            running: Mutex::new(false),
        })
    }

    pub fn config(&self) -> Config {
        Config::load(&self.settings)
    }

    /// Start or stop recording, and resize the buffer and the clip store, to match the settings.
    pub fn settings_changed(self: &Arc<Self>) {
        let config = self.config();
        lock(&self.ring).set_seconds(config.seconds);
        lock(&self.store).set_keep(config.clips);
        let mut running = lock(&self.running);
        if config.enabled == *running {
            return;
        }
        *running = config.enabled;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if config.enabled {
            *lock(&self.state) = State::Starting;
            let (ring, state, current) = (self.ring.clone(), self.state.clone(), self.generation.clone());
            std::thread::Builder::new()
                .name("sentence-audio".into())
                .spawn(move || record(generation, current, ring, state))
                .ok();
            let service = self.clone();
            std::thread::Builder::new()
                .name("sentence-audio-listen".into())
                .spawn(move || service.listen(generation))
                .ok();
        } else {
            *lock(&self.state) = State::Off;
            lock(&self.ring).clear();
            *lock(&self.ears) = None;
            lock(&self.inbox).clear();
            *lock(&self.recogniser) = Recogniser::Absent;
        }
    }

    pub fn status(&self) -> Status {
        let ring = lock(&self.ring);
        let level = ring
            .end_ms()
            .and_then(|end| ring.snapshot(end - 500.0, end))
            .map(|c| (c.samples.iter().map(|s| s * s).sum::<f32>() / c.samples.len().max(1) as f32).sqrt())
            .unwrap_or(0.0);
        Status {
            state: lock(&self.state).clone(),
            platform: std::env::consts::OS,
            held: ring.len() as f64 / ring.sample_rate() as f64,
            level: (level * 4.0).min(1.0),
            recogniser: lock(&self.recogniser).clone(),
            last: lock(&self.last).clone(),
        }
    }

    fn recording(&self) -> bool {
        matches!(*lock(&self.state), State::Recording { .. })
    }

    fn live(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    pub fn record_line(&self, line: Line) {
        if *lock(&self.running) {
            lock(&self.inbox).push(Input::Line(line));
        }
    }

    /// The Log deleted lines (or a fuller reading replaced them).
    pub fn forget_lines(&self, uids: Vec<String>) {
        if *lock(&self.running) && !uids.is_empty() {
            lock(&self.inbox).push(Input::Forget(uids));
        }
    }

    /// What the listener knows, for the Diagnostics window.
    pub fn debug(&self) -> Debug {
        let report = lock(&self.ears).as_ref().map(|ears| ears.listener.report(DEBUG_LINES, DEBUG_HEARD_MS));
        Debug { status: self.status(), clips: lock(&self.store).all().count(), listener: report }
    }

    /// The automatic-scan observer read `text` from the screen at `at_ms`.
    pub fn screen_text(&self, text: &str, at_ms: f64) {
        if *lock(&self.running) {
            lock(&self.inbox).push(Input::Screen(text.to_string(), at_ms));
        }
    }

    /// The Log's view of every line decided (the newest `LINES_KEEP`), with what each kept clip
    /// says about itself after a restart.
    pub fn lines(&self) -> Vec<LineAudio> {
        let mut out: Vec<LineAudio> = lock(&self.lines).iter().cloned().collect();
        for info in lock(&self.store).all() {
            if !out.iter().any(|l| l.uid == info.uid) {
                out.push(LineAudio {
                    uid: info.uid.clone(),
                    state: "voiced",
                    duration_ms: Some(info.duration_ms),
                    how: Some(info.how.clone()),
                    message: None,
                });
            }
        }
        out
    }

    /// The clip of line `uid`, as MP3.
    pub fn clip(&self, uid: &str) -> Option<Vec<u8>> {
        lock(&self.store).read(uid)
    }

    fn line_state(&self, uid: &str) -> Option<LineAudio> {
        lock(&self.lines).iter().rev().find(|l| l.uid == uid).cloned()
    }

    fn note(&self, ok: bool, message: impl Into<String>) {
        let message = message.into();
        if !ok {
            eprintln!("[sentence-audio] {message}");
        }
        *lock(&self.last) = Some(LastCard { at: now_ms(), ok, message });
    }

    /// The listening thread: follow the recording, decide lines, keep their clips.
    fn listen(self: Arc<Self>, generation: u64) {
        while self.live(generation) {
            std::thread::sleep(LISTEN_EVERY);
            let mut ears = lock(&self.ears);
            if !self.live(generation) {
                break;
            }
            let ears = ears.get_or_insert_with(|| self.hear());
            self.check_model(ears);
            self.copy_audio(ears);
            ears.listener.cutting = self.config().cutting();
            for input in lock(&self.inbox).drain(..) {
                match input {
                    Input::Line(line) => ears.listener.line(line),
                    Input::Forget(uids) => {
                        ears.listener.forget(&uids);
                        lock(&self.lines).retain(|l| !uids.contains(&l.uid));
                        let mut store = lock(&self.store);
                        for uid in &uids {
                            store.remove(uid);
                        }
                    }
                    Input::Screen(text, at) => ears.listener.screen.observed(&text, at),
                }
            }
            let decisions = ears.listener.tick(&ears.ring, now_ms());
            for decision in decisions {
                self.keep(ears, &decision);
            }
        }
    }

    /// A fresh listener: speech detection when the ONNX Runtime loads, else timing alone.
    fn hear(&self) -> Ears {
        let vad = (self.host.runtime)().and_then(|()| Vad::new());
        if let Err(e) = &vad {
            eprintln!("[sentence-audio] speech detection unavailable: {e}");
        }
        let config = self.config();
        let mut listener = Listener::new(vad.ok(), None);
        listener.cutting = config.cutting();
        Ears {
            listener,
            ring: AudioRing::new(48_000, config.seconds),
            cursor: None,
            model: None,
            model_checked: None,
        }
    }

    /// Load the speech model once it is downloaded; drop it once it is removed.
    fn check_model(&self, ears: &mut Ears) {
        if ears.model_checked.is_some_and(|at| at.elapsed() < MODEL_CHECK_EVERY) {
            return;
        }
        ears.model_checked = Some(Instant::now());
        let dir = (self.host.model_dir)();
        if dir == ears.model {
            return;
        }
        ears.listener.set_recogniser(None);
        ears.model = dir.clone();
        let Some(dir) = dir else {
            *lock(&self.recogniser) = Recogniser::Absent;
            return;
        };
        if !ears.listener.has_speech_detection() {
            *lock(&self.recogniser) = Recogniser::Failed { message: "The ONNX Runtime did not load.".into() };
            return;
        }
        *lock(&self.recogniser) = Recogniser::Loading;
        let loaded = crate::engine_probe::guarded(|| SenseVoice::load(&dir, RECOGNISER_THREADS));
        *lock(&self.recogniser) = match loaded {
            Ok(model) => {
                ears.listener.set_recogniser(Some(model));
                Recogniser::Ready
            }
            Err(message) => {
                eprintln!("[sentence-audio] the speech model did not load: {message}");
                Recogniser::Failed { message }
            }
        };
    }

    /// Copy what the capture added to the shared ring into the listener's own, so recognising
    /// speech never holds up the capture.
    fn copy_audio(&self, ears: &mut Ears) {
        let (start, samples, wall, rate, seconds) = {
            let ring = lock(&self.ring);
            let behind = ears.cursor.is_none_or(|c| c < ring.first_index() || c > ring.end_index());
            let from = if behind { ring.first_index() } else { ears.cursor.unwrap() };
            let (start, samples) = ring.read_from(from);
            (start, samples, ring.wall_ms_at(start), ring.sample_rate(), ring.seconds())
        };
        if ears.ring.seconds() != seconds {
            ears.ring.set_seconds(seconds);
        }
        if let (Some(wall), false) = (wall, samples.is_empty()) {
            ears.ring.push(wall, rate, &samples);
        }
        ears.cursor = Some(start + samples.len() as u64);
    }

    /// Keep what was decided for a line: its clip in the store, its state for the Log.
    fn keep(&self, ears: &Ears, decision: &Decision) {
        let line = match &decision.outcome {
            Outcome::Voiced(voice) => match clips::render(&ears.ring, voice) {
                Ok(rendered) => match lock(&self.store).put(&decision.uid, &decision.text, voice, &rendered) {
                    Ok(info) => LineAudio {
                        uid: decision.uid.clone(),
                        state: "voiced",
                        duration_ms: Some(info.duration_ms),
                        how: Some(info.how),
                        message: None,
                    },
                    Err(e) => missed(&decision.uid, format!("The clip could not be saved: {e}")),
                },
                Err(e) => missed(&decision.uid, e),
            },
            Outcome::Silent => {
                lock(&self.store).remove(&decision.uid);
                LineAudio { uid: decision.uid.clone(), state: "silent", duration_ms: None, how: None, message: None }
            }
            Outcome::Missed(why) => missed(&decision.uid, why.clone()),
        };
        {
            let mut lines = lock(&self.lines);
            lines.retain(|l| l.uid != line.uid);
            lines.push_back(line.clone());
            while lines.len() > LINES_KEEP {
                lines.pop_front();
            }
        }
        (self.host.emit)(&line);
    }

    /// The line a card was made from (found by its fields' text: its sentence, or all of them),
    /// and its audio. Waits (up to `MAX_WAIT_MS`) while the line's voice may still be playing.
    /// `fields`: the card's fields (name, text); `word`: the mined word, when known, else found
    /// among the fields; `want_word`: cut the word's audio too.
    pub fn make(&self, fields: &[(String, String)], word: Option<String>, want_word: bool) -> Result<Made, String> {
        if !self.recording() {
            return Err("System audio is not being recorded.".into());
        }
        let texts: Vec<&str> = fields.iter().map(|(_, v)| v.as_str()).collect();
        let (uid, ts) = {
            let ears = lock(&self.ears);
            let ears = ears.as_ref().ok_or("No line has arrived in the Log since recording started.")?;
            let line = ears.listener.mined(&texts).ok_or("The card's sentence is not a line in the Log, so no audio was added.")?;
            (line.uid.clone(), line.ts)
        };
        while self.line_state(&uid).is_none() && now_ms() - ts < MAX_WAIT_MS && self.recording() {
            std::thread::sleep(Duration::from_millis(200));
        }
        // Undecided, or decided without a match by its words: try it with everything heard by now.
        if self.line_state(&uid).is_none_or(|l| l.how.as_deref() != Some("matched")) {
            let mut guard = lock(&self.ears);
            if let Some(ears) = guard.as_mut() {
                if let Some(decision) = ears.listener.decide_now(&ears.ring, now_ms(), &uid) {
                    self.keep(ears, &decision);
                }
            }
        }
        let state = self.line_state(&uid).ok_or("The line's audio could not be found.")?;
        match state.state {
            "voiced" => {
                let store = lock(&self.store);
                let info = store.get(&uid).ok_or("The line's clip is no longer kept.")?;
                let mp3 = store.read(&uid).ok_or("The line's clip is no longer kept.")?;
                let word = if want_word {
                    let word = word.or_else(|| card_word(fields, &info.text));
                    word.and_then(|w| store.word(&uid, &w).map(|mp3| (w, mp3)))
                } else {
                    None
                };
                Ok(Made {
                    filename: format!("kimochi_{}.mp3", now_ms() as u64),
                    mp3,
                    duration_ms: info.duration_ms,
                    matched: info.how == "matched",
                    word,
                })
            }
            "silent" => Err(SILENT.into()),
            _ => Err(state.message.unwrap_or_else(|| "The line's audio is no longer held.".into())),
        }
    }

    /// Put the audio of the card's line in note `note_id`'s sentence-audio field (`field`, or the
    /// configured one), and the mined word's in the word-audio field, when the note has those
    /// fields and they are empty. `fields`: the card's fields as sent (name → text), or just its
    /// sentence; `word`: the mined word, when known. Reports how it went in the status.
    pub async fn attach(self: Arc<Self>, anki: Anki, note_id: u64, fields: Vec<(String, String)>, field: Option<String>, word: Option<String>) {
        let config = self.config();
        let field = field.filter(|f| !f.trim().is_empty()).unwrap_or(config.field);
        if let Err(message) = self.clone().attach_inner(&anki, note_id, fields, &field, &config.word_field, word).await {
            let ok = message == SILENT;
            self.note(ok, message);
        }
    }

    async fn attach_inner(
        self: Arc<Self>,
        anki: &Anki,
        note_id: u64,
        fields: Vec<(String, String)>,
        field: &str,
        word_field: &str,
        word: Option<String>,
    ) -> Result<(), String> {
        if field.is_empty() {
            return Err("No sentence-audio field is set in Settings → Anki.".into());
        }
        let info = anki.call("notesInfo", json!({ "notes": [note_id] })).await?;
        let note = info.get(0).and_then(|n| n.get("fields")).ok_or("Anki did not find the new card.")?;
        let empty = |name: &str| {
            note.get(name).map(|f| f.get("value").and_then(Value::as_str).is_none_or(|v| v.trim().is_empty()))
        };
        let Some(sentence_empty) = empty(field) else {
            return Err(format!("The card's note type has no “{field}” field, so no audio was added."));
        };
        let word_empty = !word_field.is_empty() && empty(word_field) == Some(true);
        if !sentence_empty && !word_empty {
            self.note(true, format!("The card's “{field}” field was already filled; left as it was."));
            return Ok(());
        }
        let service = self.clone();
        let made = tauri::async_runtime::spawn_blocking(move || service.make(&fields, word, word_empty))
            .await
            .map_err(|e| e.to_string())??;
        let mut update = serde_json::Map::new();
        let mut done = Vec::new();
        if sentence_empty {
            let data = base64::engine::general_purpose::STANDARD.encode(&made.mp3);
            anki.call("storeMediaFile", json!({ "filename": made.filename, "data": data })).await?;
            update.insert(field.to_string(), json!(format!("[sound:{}]", made.filename)));
            done.push(format!("{:.1} seconds of audio to “{field}”", made.duration_ms / 1000.0));
        }
        if word_empty {
            match made.word {
                Some((w, mp3)) => {
                    let filename = format!("kimochi_{}_word.mp3", now_ms() as u64);
                    let data = base64::engine::general_purpose::STANDARD.encode(&mp3);
                    anki.call("storeMediaFile", json!({ "filename": filename, "data": data })).await?;
                    update.insert(word_field.to_string(), json!(format!("[sound:{filename}]")));
                    done.push(format!("“{w}” to “{word_field}”"));
                }
                None if made.matched => done.push("no word audio (the word was not found in the line)".into()),
                None => done.push("no word audio (needs the speech model)".into()),
            }
        }
        // Filled meanwhile (by hand, or another card's audio): left as it is.
        let info = anki.call("notesInfo", json!({ "notes": [note_id] })).await?;
        if let Some(now) = info.get(0).and_then(|n| n.get("fields")) {
            update.retain(|name, _| now.get(name).and_then(|f| f.get("value")).and_then(Value::as_str).is_none_or(|v| v.trim().is_empty()));
        }
        if !update.is_empty() {
            anki.call("updateNoteFields", json!({ "note": { "id": note_id, "fields": update } })).await?;
        }
        let how = if made.matched { "matched by its words" } else { "placed by timing" };
        self.note(true, format!("Added {} ({how}).", done.join(", ")));
        Ok(())
    }
}

const SILENT: &str = "No voice was detected for the card's line, so no audio was added.";

fn missed(uid: &str, message: String) -> LineAudio {
    LineAudio { uid: uid.to_string(), state: "missed", duration_ms: None, how: None, message: Some(message) }
}

/// The word a dictionary extension's card was mined for: a field named for it (Expression, Word,
/// Term, …) if the card has one, else its shortest field that is in the line.
fn card_word(fields: &[(String, String)], line: &str) -> Option<String> {
    const NAMES: [&str; 8] = ["expression", "word", "term", "vocab", "vocabulary", "kanji", "単語", "front"];
    let plain = |v: &str| timeline::normalize(v);
    let named = fields.iter().find(|(name, value)| {
        let name = name.to_lowercase();
        NAMES.iter().any(|n| name == *n || name.starts_with(n)) && !plain(value).is_empty() && plain(value).chars().count() <= 15
    });
    if let Some((_, value)) = named {
        return Some(plain(value));
    }
    let line = plain(line);
    fields
        .iter()
        .map(|(_, v)| plain(v))
        .filter(|v| (1..=15).contains(&v.chars().count()) && line.contains(v.as_str()))
        .min_by_key(|v| v.chars().count())
}

/// A card's fields as sent: (name, text).
type Fields = Vec<(String, String)>;

/// Where a card's AnkiConnect is: the extension's own address and key for its cards, Kimochi's
/// for the pop-up's.
pub struct Anki {
    pub url: String,
    pub key: Option<String>,
}

impl Anki {
    async fn call(&self, action: &str, params: Value) -> Result<Value, String> {
        ankiconnect::action(&self.url, self.key.as_deref(), action, params).await
    }
}

/// The capture thread: start, drain into the ring, and start again after a failure, until the
/// generation moves on.
fn record(generation: u64, current: Arc<AtomicU64>, ring: Arc<Mutex<AudioRing>>, state: Arc<Mutex<State>>) {
    let live = || current.load(Ordering::SeqCst) == generation;
    let set = |next: State| {
        if live() {
            *lock(&state) = next;
        }
    };
    while live() {
        set(State::Starting);
        match SystemAudio::start() {
            Ok(mut capture) => {
                set(State::Recording { source: capture.source(), excludes_own_audio: capture.excludes_own_audio() });
                while live() {
                    std::thread::sleep(DRAIN_EVERY);
                    capture.drain_into(&mut lock(&ring));
                    if let Some(why) = capture.ended() {
                        set(State::Error { message: format!("Recording stopped: {why}") });
                        break;
                    }
                }
            }
            Err(e) if e.code == "unsupported" => {
                set(State::Unsupported { message: e.message });
                return;
            }
            Err(e) if e.code == "permission" => set(State::NoPermission { message: e.message }),
            Err(e) if e.code == "unavailable" => set(State::Unavailable { message: e.message }),
            Err(e) => set(State::Error { message: e.message }),
        }
        let wait = if matches!(*lock(&state), State::Unavailable { .. }) { RETRY_UNAVAILABLE } else { RESTART_AFTER };
        let until = Instant::now() + wait;
        while live() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// After the relay carried a dictionary extension's request: when it was an `addNote` that
/// AnkiConnect accepted, the card's audio follows.
pub fn after_relay(app: &tauri::AppHandle, url: &str, request: &Value, reply_status: u16, reply_body: &str) {
    let Some(service) = app.try_state::<Arc<SentenceAudio>>() else { return };
    if !service.recording() {
        return;
    }
    let Some((anki, note_id, fields)) = added_card(url, request, reply_status, reply_body) else { return };
    let service = service.inner().clone();
    tauri::async_runtime::spawn(service.attach(anki, note_id, fields, None, None));
}

/// The card a relayed request added: where its AnkiConnect is (the extension's address and key),
/// its id, and its fields (name, text).
fn added_card(url: &str, request: &Value, reply_status: u16, reply_body: &str) -> Option<(Anki, u64, Fields)> {
    if request.get("action").and_then(Value::as_str) != Some("addNote") || reply_status != 200 {
        return None;
    }
    let note_id = added_note_id(reply_body)?;
    let fields = request
        .pointer("/params/note/fields")
        .and_then(Value::as_object)
        .map(|fields| fields.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
        .unwrap_or_default();
    let anki = Anki {
        url: url.to_string(),
        key: request.get("key").and_then(Value::as_str).map(str::to_string),
    };
    Some((anki, note_id, fields))
}

/// The new note's id from `addNote`'s answer: `{"result": id, "error": null}` (API version 6),
/// or the bare id (the version 2 Yomitan speaks).
fn added_note_id(body: &str) -> Option<u64> {
    let value: Value = serde_json::from_str(body).ok()?;
    match value.as_object() {
        Some(o) if o.contains_key("result") => o.get("error").filter(|e| !e.is_null()).map_or(o["result"].as_u64(), |_| None),
        _ => value.as_u64(),
    }
}

/// The automatic-scan observer read `text` from the screen at `at_ms`: when an OCR'd line began
/// to appear, which is when its voice began.
pub fn screen_text(app: &tauri::AppHandle, text: &str, at_ms: f64) {
    if let Some(service) = app.try_state::<Arc<SentenceAudio>>() {
        service.screen_text(text, at_ms);
    }
}

/// The speech model is about to be removed: let go of its files first (Windows cannot delete a
/// file that is open).
pub fn unload_model(app: &tauri::AppHandle) {
    if let Some(service) = app.try_state::<Arc<SentenceAudio>>() {
        if let Some(ears) = lock(&service.ears).as_mut() {
            ears.listener.set_recogniser(None);
            ears.model = None;
            // Looked for again later: a removed model is found absent then.
            ears.model_checked = Some(Instant::now());
        }
        *lock(&service.recogniser) = Recogniser::Absent;
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn sentence_audio_status(service: tauri::State<'_, Arc<SentenceAudio>>) -> Status {
    service.status()
}

/// The Log added a line (or changed one: a start-merge keeps its `uid`). `ts`: its arrival, in
/// Unix ms. `source`: the Log's line source (`ocr`, `websocket`, `clipboard`, `webhook`).
/// `scan`: the OCR scan it was read in (a scan's lines, a name box and the dialogue, share it).
#[tauri::command]
pub fn sentence_audio_line(
    service: tauri::State<'_, Arc<SentenceAudio>>,
    uid: String,
    text: String,
    ts: f64,
    source: String,
    scan: Option<String>,
) {
    service.record_line(Line { uid, text, ts, ocr: source == "ocr", appeared: None, scan });
}

/// The Log deleted lines, or a fuller reading of the same text replaced them.
#[tauri::command]
pub fn sentence_audio_forget(service: tauri::State<'_, Arc<SentenceAudio>>, uids: Vec<String>) {
    service.forget_lines(uids);
}

/// The recording, the speech model and the listener's view of the recent lines, for the
/// Diagnostics window.
#[tauri::command]
pub fn sentence_audio_debug(service: tauri::State<'_, Arc<SentenceAudio>>) -> Debug {
    service.debug()
}

/// What is known about each recent line's audio, for the Log.
#[tauri::command]
pub fn sentence_audio_lines(service: tauri::State<'_, Arc<SentenceAudio>>) -> Vec<LineAudio> {
    service.lines()
}

/// Line `uid`'s clip, as base64 MP3, or null when it has none.
#[tauri::command]
pub fn sentence_audio_clip(service: tauri::State<'_, Arc<SentenceAudio>>, uid: String) -> Option<String> {
    service.clip(&uid).map(|mp3| base64::engine::general_purpose::STANDARD.encode(mp3))
}

/// Kimochi's pop-up added note `note_id` from `sentence` for `word`: its audio follows, into
/// `field` (a field mapped to the sentence audio) or the configured field, and the word's audio
/// into `wordField` (mapped to the word audio) or the configured word field.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // a command's arguments are its parameters, by name
pub fn sentence_audio_attach(
    service: tauri::State<'_, Arc<SentenceAudio>>,
    settings: tauri::State<'_, crate::state::Shared>,
    url: String,
    note_id: u64,
    sentence: Option<String>,
    field: Option<String>,
    word: Option<String>,
    word_field: Option<String>,
) {
    if !service.recording() {
        return;
    }
    let (_, key) = ankiconnect::configured(&settings.settings);
    let anki = Anki { url, key };
    let service = service.inner().clone();
    let fields = sentence.into_iter().map(|s| ("Sentence".to_string(), s)).collect();
    let word_field = word_field.filter(|f| !f.trim().is_empty());
    tauri::async_runtime::spawn(async move {
        match word_field {
            // The pop-up's own mapping names the word field: it wins over the setting.
            Some(word_field) => {
                let config = service.config();
                let field = field.filter(|f| !f.trim().is_empty()).unwrap_or(config.field);
                if let Err(message) = service.clone().attach_inner(&anki, note_id, fields, &field, &word_field, word).await {
                    let ok = message == SILENT;
                    service.note(ok, message);
                }
            }
            None => service.attach(anki, note_id, fields, field, word).await,
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_new_notes_id_is_read_from_either_api_version() {
        assert_eq!(added_note_id(r#"{"result":1700000000000,"error":null}"#), Some(1_700_000_000_000));
        assert_eq!(added_note_id("1700000000000"), Some(1_700_000_000_000));
        assert_eq!(added_note_id(r#"{"result":null,"error":"cannot create note because it is a duplicate"}"#), None);
        assert_eq!(added_note_id(r#"{"error":"x"}"#), None);
        assert_eq!(added_note_id("not json"), None);
    }

    #[test]
    fn a_relayed_addnote_names_the_card_and_where_its_anki_is() {
        let request = json!({
            "action": "addNote", "version": 2, "key": "theirs",
            "params": { "note": { "deckName": "D", "fields": { "Sentence": "猫が好き。", "Word": "猫", "Freq": 3 } } }
        });
        let (anki, id, mut fields) = added_card("http://127.0.0.1:8765", &request, 200, "1234").unwrap();
        fields.sort();
        assert_eq!((anki.url.as_str(), anki.key.as_deref(), id), ("http://127.0.0.1:8765", Some("theirs"), 1234));
        assert_eq!(fields, vec![("Sentence".to_string(), "猫が好き。".to_string()), ("Word".to_string(), "猫".to_string())]);
        assert!(added_card("u", &request, 403, "1234").is_none(), "refused");
        assert!(added_card("u", &request, 200, r#"{"result":null,"error":"duplicate"}"#).is_none());
        let mut other = request.clone();
        other["action"] = json!("updateNoteFields");
        assert!(added_card("u", &other, 200, "null").is_none(), "only new cards");
    }

    #[test]
    fn the_cards_word_is_its_word_field_or_its_shortest_field_in_the_line() {
        let line = "今日はいい天気ですね。";
        let field = |n: &str, v: &str| (n.to_string(), v.to_string());
        assert_eq!(card_word(&[field("Sentence", line), field("Expression", "<b>天気</b>")], line).as_deref(), Some("天気"));
        assert_eq!(card_word(&[field("Front", "天気[てんき]"), field("Back", "weather")], line).as_deref(), Some("天気"));
        assert_eq!(card_word(&[field("A", line), field("B", "天気"), field("C", "weather")], line).as_deref(), Some("天気"));
        assert_eq!(card_word(&[field("A", "weather")], line), None);
    }

    #[test]
    fn settings_are_read_with_defaults_and_limits() {
        let dir = std::env::temp_dir().join(format!("kimochi-sentence-audio-{}", std::process::id()));
        let settings = Settings::load(dir.join("settings.json"));
        assert_eq!(Config::load(&settings), Config::default());
        settings
            .set("sentenceAudio", json!({ "enabled": true, "seconds": 999, "field": " Audio ", "startOffsetMs": -200, "clips": 1, "wordField": " Word " }))
            .unwrap();
        let config = Config::load(&settings);
        assert!(config.enabled && config.trim);
        assert_eq!((config.seconds, config.field.as_str(), config.start_offset_ms), (120.0, "Audio", -200.0));
        assert_eq!((config.clips, config.word_field.as_str()), (5, "Word"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The whole path on this Mac, opt-in, with a fake AnkiConnect: records system audio while two
    /// lines' speech plays (out loud, at half volume), then attaches the first line's audio (and
    /// its word's) to a card. `KIMOCHI_ORT=…/libonnxruntime.dylib KIMOCHI_SPEECH_WAV=a.wav
    /// KIMOCHI_SPEECH_WAV2=b.wav [KIMOCHI_SENSEVOICE=<model dir>] [KIMOCHI_OUT=clip.mp3]
    /// cargo test --bin kimochi card_gets -- --ignored --nocapture`. Needs Screen Recording for the
    /// terminal on macOS, and on Windows `KIMOCHI_AUDIO_ENDPOINT_LOOPBACK=1` (the test's own player
    /// is Kimochi's child there, which process loopback leaves out).
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn a_card_gets_its_lines_voice_from_system_audio() {
        use crate::reader::ankiconnect::tests::serve;
        let ort_path = std::env::var("KIMOCHI_ORT").expect("KIMOCHI_ORT");
        let wavs = [std::env::var("KIMOCHI_SPEECH_WAV").unwrap(), std::env::var("KIMOCHI_SPEECH_WAV2").unwrap()];
        let model = std::env::var("KIMOCHI_SENSEVOICE").ok().map(PathBuf::from);
        let dir = std::env::temp_dir().join(format!("kimochi-sentence-audio-e2e-{}", std::process::id()));
        let settings = Arc::new(Settings::load(dir.join("settings.json")));
        settings.set("sentenceAudio", json!({ "enabled": true, "wordField": "WordAudio" })).unwrap();
        let host = Host {
            runtime: Box::new(move || ort::init_from(ort_path.clone()).commit().map(|_| ()).map_err(|e| e.to_string())),
            model_dir: Box::new(move || model.clone()),
            emit: Box::new(|line| eprintln!("line {line:?}")),
        };
        let service = SentenceAudio::with_host(settings, host, dir.join("clips"));
        service.settings_changed();
        for _ in 0..50 {
            if service.recording() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(service.recording(), "{:?}", service.status().state);
        // Let the listener load the model, if there is one.
        std::thread::sleep(Duration::from_millis(3_000));
        eprintln!("recogniser {:?}", service.status().recogniser);

        let play = |path: &str| {
            let status = if cfg!(target_os = "macos") {
                std::process::Command::new("afplay").args(["-v", "0.3", path]).status()
            } else if cfg!(target_os = "windows") {
                let script = format!("(New-Object Media.SoundPlayer '{path}').PlaySync()");
                std::process::Command::new("powershell").args(["-NoProfile", "-Command", &script]).status()
            } else {
                std::process::Command::new("pw-play").args(["--volume", "0.5", path]).status()
            };
            assert!(status.unwrap().success());
        };
        let lines = ["今日はいい天気ですね。散歩に行きましょう。", "猫が好きです。"];
        let mut spoken_ms = Vec::new();
        for (i, (text, wav)) in lines.iter().zip(&wavs).enumerate() {
            service.record_line(Line { uid: i.to_string(), text: text.to_string(), ts: now_ms(), ocr: false, appeared: None, scan: None });
            let started = now_ms();
            play(wav);
            spoken_ms.push(now_ms() - started);
            std::thread::sleep(Duration::from_millis(400));
        }

        let (url, seen) = serve(|body| {
            let request: Value = serde_json::from_str(body).unwrap();
            let result = match request["action"].as_str().unwrap() {
                "notesInfo" => json!([{ "noteId": 42, "fields": {
                    "Word": { "value": "天気", "order": 0 },
                    "SentenceAudio": { "value": "", "order": 1 },
                    "WordAudio": { "value": "", "order": 2 }
                } }]),
                "storeMediaFile" => request["params"]["filename"].clone(),
                _ => Value::Null,
            };
            (200, json!({ "result": result, "error": null }).to_string())
        });
        // The extension's card: its sentence field holds the first line, in markup.
        let fields = vec![("Word".to_string(), "天気".to_string()), ("Sentence".to_string(), "<b>今日</b>はいい天気ですね。".to_string())];
        service.clone().attach(Anki { url, key: None }, 42, fields, None, None).await;

        let last = service.status().last.unwrap();
        eprintln!("{}", last.message);
        assert!(last.ok, "{}", last.message);
        let requests = seen.lock().unwrap().clone();
        let body = |action: &str| -> Value {
            let raw = requests.iter().find(|r| r.contains(&format!("\"action\":\"{action}\""))).unwrap();
            serde_json::from_str(raw.split_once("\r\n\r\n").unwrap().1).unwrap()
        };
        let stored = body("storeMediaFile");
        let mp3 = base64::engine::general_purpose::STANDARD.decode(stored["params"]["data"].as_str().unwrap()).unwrap();
        if let Ok(out) = std::env::var("KIMOCHI_OUT") {
            std::fs::write(out, &mp3).unwrap();
        }
        let seconds = mp3.len() as f64 * 8.0 / 96_000.0;
        let first_line = spoken_ms[0] / 1000.0;
        eprintln!("clip {seconds:.2}s; the first line played for {first_line:.2}s, the second for {:.2}s", spoken_ms[1] / 1000.0);
        assert!((seconds - first_line).abs() < 0.8, "clip {seconds:.2}s vs line {first_line:.2}s");
        let updated = body("updateNoteFields");
        let sound = updated["params"]["note"]["fields"]["SentenceAudio"].as_str().unwrap();
        assert_eq!(sound, format!("[sound:{}]", stored["params"]["filename"].as_str().unwrap()));
        assert!(service.lines().iter().any(|l| l.uid == "0" && l.state == "voiced"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
