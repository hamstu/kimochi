//! Sentence audio: the last few seconds of system audio, kept while the setting is on, so a card
//! made from a texthooker line gets the line's spoken audio (the way Game Sentence Miner does it
//! with OBS's replay buffer, without OBS).
//!
//! - **Capture** (`kimochi_capture::audio`): what the computer plays, mono, into an `AudioRing`
//!   of `sentenceAudio.seconds`. Restarted when it stops; off unless `sentenceAudio.enabled`.
//! - **Lines** (`timeline`): the Log reports each line it adds (`sentence_audio_line`), with its
//!   arrival time.
//! - **Cards**: after a card is added (a dictionary extension's `addNote` through the AnkiConnect
//!   relay, or Kimochi's own pop-up through `sentence_audio_attach`), the card's line is found by
//!   its text, its window cut from the ring, trimmed to the voice (`vad`, `trim`), encoded
//!   (`encode`) and put in the card's sentence-audio field, if the card has that field and it is
//!   empty. The card is never held up: the audio follows it.
//!
//! Settings: `sentenceAudio` (a machine key, never synced: recording is this computer's choice).
pub mod encode;
pub mod timeline;
pub mod trim;
mod vad;

use crate::reader::ankiconnect;
use crate::settings::Settings;
use base64::Engine as _;
use kimochi_capture::audio::{now_ms, AudioRing, SystemAudio};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;
use timeline::{Line, Timeline};

/// Longest clip: a line's window is cut to this.
const MAX_CLIP_MS: f64 = 30_000.0;
/// How long a card waits for its line's voice to finish, when no later line has arrived.
const MAX_WAIT_MS: f64 = 15_000.0;
/// Waiting ends once this much has passed since the line arrived and the last stretch is quiet.
const MIN_WAIT_MS: f64 = 1_500.0;
const QUIET_MS: f64 = 800.0;
const DRAIN_EVERY: Duration = Duration::from_millis(50);
const RESTART_AFTER: Duration = Duration::from_secs(5);
const RETRY_UNAVAILABLE: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    /// Audio kept, in seconds.
    pub seconds: f64,
    /// The note field the audio goes in.
    pub field: String,
    /// Moves the clip's start and end (negative: earlier).
    pub start_offset_ms: f64,
    pub end_offset_ms: f64,
    /// Cut the clip to the voice in it (Silero VAD); off keeps the line's whole window.
    pub trim: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            seconds: 30.0,
            field: "SentenceAudio".into(),
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
        config.start_offset_ms = config.start_offset_ms.clamp(-5_000.0, 5_000.0);
        config.end_offset_ms = config.end_offset_ms.clamp(-5_000.0, 5_000.0);
        config.field = config.field.trim().to_string();
        config
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
    pub last: Option<LastCard>,
}

/// A clip ready for Anki.
pub struct Made {
    pub filename: String,
    pub mp3: Vec<u8>,
    pub duration_ms: f64,
    pub trimmed: bool,
}

/// Initialises the ONNX Runtime speech detection runs on (`meiki_ocr::onnx_runtime` in the app).
type Runtime = Box<dyn Fn() -> Result<(), String> + Send + Sync>;

pub struct SentenceAudio {
    runtime: Runtime,
    settings: Arc<Settings>,
    ring: Arc<Mutex<AudioRing>>,
    timeline: Mutex<Timeline>,
    state: Arc<Mutex<State>>,
    last: Mutex<Option<LastCard>>,
    /// Bumped on every stop, so a capture thread from before exits.
    generation: Arc<AtomicU64>,
    running: Mutex<bool>,
    vad: Mutex<Option<Result<vad::Vad, String>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl SentenceAudio {
    pub fn new(app: tauri::AppHandle, settings: Arc<Settings>) -> Arc<Self> {
        Self::with_runtime(settings, Box::new(move || crate::meiki_ocr::onnx_runtime(&app)))
    }

    fn with_runtime(settings: Arc<Settings>, runtime: Runtime) -> Arc<Self> {
        let config = Config::load(&settings);
        Arc::new(Self {
            runtime,
            settings,
            ring: Arc::new(Mutex::new(AudioRing::new(48_000, config.seconds))),
            timeline: Mutex::new(Timeline::default()),
            state: Arc::new(Mutex::new(State::Off)),
            last: Mutex::new(None),
            generation: Arc::new(AtomicU64::new(0)),
            running: Mutex::new(false),
            vad: Mutex::new(None),
        })
    }

    pub fn config(&self) -> Config {
        Config::load(&self.settings)
    }

    /// Start or stop recording, and resize the buffer, to match the settings.
    pub fn settings_changed(&self) {
        let config = self.config();
        lock(&self.ring).set_seconds(config.seconds);
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
        } else {
            *lock(&self.state) = State::Off;
            lock(&self.ring).clear();
            lock(&self.timeline).clear();
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
            last: lock(&self.last).clone(),
        }
    }

    fn recording(&self) -> bool {
        matches!(*lock(&self.state), State::Recording { .. })
    }

    pub fn record_line(&self, line: Line) {
        if *lock(&self.running) {
            lock(&self.timeline).record(line);
        }
    }

    fn note(&self, ok: bool, message: impl Into<String>) {
        let message = message.into();
        if !ok {
            eprintln!("[sentence-audio] {message}");
        }
        *lock(&self.last) = Some(LastCard { at: now_ms(), ok, message });
    }

    /// Speech in `samples`, or None when speech detection is off or cannot run.
    fn speech(&self, samples: &[f32], sample_rate: u32) -> Option<Vec<trim::Span>> {
        let mut vad = lock(&self.vad);
        let vad = vad.get_or_insert_with(|| (self.runtime)().and_then(|()| vad::Vad::new()));
        match vad {
            Ok(vad) => vad.speech(samples, sample_rate).map_err(|e| eprintln!("[sentence-audio] {e}")).ok(),
            Err(e) => {
                eprintln!("[sentence-audio] speech detection unavailable: {e}");
                None
            }
        }
    }

    /// Wait (up to `MAX_WAIT_MS` after the line arrived) while the newest line's voice may still
    /// be playing: until a later line arrives, or the last `QUIET_MS` hold no speech.
    fn wait_for_voice(&self, line: &Line, config: &Config) {
        loop {
            let now = now_ms();
            if now - line.ts >= MAX_WAIT_MS || !self.recording() {
                return;
            }
            let later = lock(&self.timeline).mined(&[]).is_some_and(|newest| newest.ts > line.ts);
            if later {
                return;
            }
            if now - line.ts >= MIN_WAIT_MS {
                let recent = lock(&self.ring).snapshot(now - QUIET_MS, now);
                let Some(recent) = recent else { return };
                let speaking = if config.trim {
                    match self.speech(&recent.samples, recent.sample_rate) {
                        Some(spans) => !spans.is_empty(),
                        None => return,
                    }
                } else {
                    return;
                };
                if !speaking {
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    /// The audio of the line a card was made from (`texts`: the card's sentence, or all its
    /// fields). Blocks while the line's voice may still be playing.
    pub fn make(&self, texts: &[&str]) -> Result<Made, String> {
        if !self.recording() {
            return Err("System audio is not being recorded.".into());
        }
        let config = self.config();
        let line = lock(&self.timeline)
            .mined(texts)
            .cloned()
            .ok_or("No line has arrived in the Log since recording started.")?;
        self.wait_for_voice(&line, &config);
        let now = now_ms();
        let window = lock(&self.timeline).window(&line, now, MAX_CLIP_MS);
        let clip = {
            let ring = lock(&self.ring);
            if ring.start_ms().is_none_or(|start| window.anchor < start) {
                return Err(format!(
                    "The line is older than the audio kept ({:.0} seconds).",
                    ring.seconds()
                ));
            }
            ring.snapshot(window.from, window.to).ok_or("No audio was recorded for the line.")?
        };
        let spans = if config.trim { self.speech(&clip.samples, clip.sample_rate) } else { None };
        let voice = spans.as_ref().and_then(|spans| trim::voice(spans, window.anchor - clip.start_ms));
        let cut = trim::cut(voice, clip.duration_ms(), config.start_offset_ms, config.end_offset_ms);
        // KIMOCHI_SENTENCE_AUDIO_DEBUG=1: how the clip was cut, to tune the timing.
        if std::env::var_os("KIMOCHI_SENTENCE_AUDIO_DEBUG").is_some() {
            eprintln!(
                "[sentence-audio] line {:?}: window {:.0}..{:.0} (anchor +{:.0}), clip {:.0}ms from +{:.0}, speech {spans:?}, voice {voice:?}, cut {cut:?}",
                line.text,
                window.from,
                window.to,
                window.anchor - window.from,
                clip.duration_ms(),
                clip.start_ms - window.from,
            );
        }
        let at = |ms: f64| ((ms * clip.sample_rate as f64 / 1000.0) as usize).min(clip.samples.len());
        let mut samples = clip.samples[at(cut.start)..at(cut.end)].to_vec();
        if samples.len() < clip.sample_rate as usize / 10 {
            return Err("The clip came out empty: check the offsets in Settings → Anki.".into());
        }
        trim::level(&mut samples);
        trim::fade(&mut samples, clip.sample_rate);
        let mp3 = encode::mp3(&samples, clip.sample_rate)?;
        Ok(Made {
            filename: format!("kimochi_{}.mp3", now as u64),
            mp3,
            duration_ms: samples.len() as f64 * 1000.0 / clip.sample_rate as f64,
            trimmed: voice.is_some(),
        })
    }

    /// Put the audio of the card's line in note `note_id`'s sentence-audio field (`field`, or the
    /// configured one), when the note has that field and it is empty. Reports how it went in
    /// the status.
    pub async fn attach(self: Arc<Self>, anki: Anki, note_id: u64, texts: Vec<String>, field: Option<String>) {
        let field = field.filter(|f| !f.trim().is_empty()).unwrap_or_else(|| self.config().field);
        if let Err(message) = self.clone().attach_inner(&anki, note_id, texts, &field).await {
            self.note(false, message);
        }
    }

    async fn attach_inner(self: Arc<Self>, anki: &Anki, note_id: u64, texts: Vec<String>, field: &str) -> Result<(), String> {
        if field.is_empty() {
            return Err("No sentence-audio field is set in Settings → Anki.".into());
        }
        let info = anki.call("notesInfo", json!({ "notes": [note_id] })).await?;
        let fields = info.get(0).and_then(|n| n.get("fields")).ok_or("Anki did not find the new card.")?;
        let Some(current) = fields.get(field) else {
            return Err(format!("The card's note type has no “{field}” field, so no audio was added."));
        };
        if current.get("value").and_then(Value::as_str).is_some_and(|v| !v.trim().is_empty()) {
            self.note(true, format!("The card's “{field}” field was already filled; left as it was."));
            return Ok(());
        }
        let service = self.clone();
        let made = tauri::async_runtime::spawn_blocking(move || {
            let texts: Vec<&str> = texts.iter().map(String::as_str).collect();
            service.make(&texts)
        })
        .await
        .map_err(|e| e.to_string())??;
        let data = base64::engine::general_purpose::STANDARD.encode(&made.mp3);
        anki.call("storeMediaFile", json!({ "filename": made.filename, "data": data })).await?;
        let mut update = serde_json::Map::new();
        update.insert(field.to_string(), json!(format!("[sound:{}]", made.filename)));
        anki.call("updateNoteFields", json!({ "note": { "id": note_id, "fields": update } })).await?;
        self.note(
            true,
            format!(
                "Added {:.1} seconds of audio to “{field}”{}.",
                made.duration_ms / 1000.0,
                if made.trimmed { "" } else { " (untrimmed: no speech found)" }
            ),
        );
        Ok(())
    }
}

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
        let until = std::time::Instant::now() + wait;
        while live() && std::time::Instant::now() < until {
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
    let Some((anki, note_id, texts)) = added_card(url, request, reply_status, reply_body) else { return };
    let service = service.inner().clone();
    tauri::async_runtime::spawn(service.attach(anki, note_id, texts, None));
}

/// The card a relayed request added: where its AnkiConnect is (the extension's address and key),
/// its id, and its fields' text.
fn added_card(url: &str, request: &Value, reply_status: u16, reply_body: &str) -> Option<(Anki, u64, Vec<String>)> {
    if request.get("action").and_then(Value::as_str) != Some("addNote") || reply_status != 200 {
        return None;
    }
    let note_id = added_note_id(reply_body)?;
    let texts = request
        .pointer("/params/note/fields")
        .and_then(Value::as_object)
        .map(|fields| fields.values().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let anki = Anki {
        url: url.to_string(),
        key: request.get("key").and_then(Value::as_str).map(str::to_string),
    };
    Some((anki, note_id, texts))
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

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn sentence_audio_status(service: tauri::State<'_, Arc<SentenceAudio>>) -> Status {
    service.status()
}

/// The Log added a line (or changed one: a start-merge keeps its `uid`). `ts`: its arrival, in
/// Unix ms. `source`: the Log's line source (`ocr`, `websocket`, `clipboard`, `webhook`).
#[tauri::command]
pub fn sentence_audio_line(
    service: tauri::State<'_, Arc<SentenceAudio>>,
    uid: String,
    text: String,
    ts: f64,
    source: String,
) {
    service.record_line(Line { uid, text, ts, ocr: source == "ocr" });
}

/// Kimochi's pop-up added note `note_id` from `sentence`: its audio follows, into `field` (a
/// field mapped to the sentence audio) or the configured field, at the AnkiConnect in Settings.
#[tauri::command]
pub fn sentence_audio_attach(
    service: tauri::State<'_, Arc<SentenceAudio>>,
    settings: tauri::State<'_, crate::state::Shared>,
    url: String,
    note_id: u64,
    sentence: Option<String>,
    field: Option<String>,
) {
    if !service.recording() {
        return;
    }
    let (_, key) = ankiconnect::configured(&settings.settings);
    let anki = Anki { url, key };
    let service = service.inner().clone();
    tauri::async_runtime::spawn(service.attach(anki, note_id, sentence.into_iter().collect(), field));
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
        let (anki, id, mut texts) = added_card("http://127.0.0.1:8765", &request, 200, "1234").unwrap();
        texts.sort();
        assert_eq!((anki.url.as_str(), anki.key.as_deref(), id), ("http://127.0.0.1:8765", Some("theirs"), 1234));
        assert_eq!(texts, vec!["猫", "猫が好き。"]);
        assert!(added_card("u", &request, 403, "1234").is_none(), "refused");
        assert!(added_card("u", &request, 200, r#"{"result":null,"error":"duplicate"}"#).is_none());
        let mut other = request.clone();
        other["action"] = json!("updateNoteFields");
        assert!(added_card("u", &other, 200, "null").is_none(), "only new cards");
    }

    #[test]
    fn settings_are_read_with_defaults_and_limits() {
        let dir = std::env::temp_dir().join(format!("kimochi-sentence-audio-{}", std::process::id()));
        let settings = Settings::load(dir.join("settings.json"));
        assert_eq!(Config::load(&settings), Config::default());
        settings
            .set("sentenceAudio", json!({ "enabled": true, "seconds": 999, "field": " Audio ", "startOffsetMs": -200 }))
            .unwrap();
        let config = Config::load(&settings);
        assert!(config.enabled && config.trim);
        assert_eq!((config.seconds, config.field.as_str(), config.start_offset_ms), (120.0, "Audio", -200.0));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The whole path on this Mac, opt-in, with a fake AnkiConnect: records system audio while two
    /// lines' speech plays (out loud, at half volume), then attaches the first line's audio to a
    /// card. `KIMOCHI_ORT=…/libonnxruntime.dylib KIMOCHI_SPEECH_WAV=a.wav KIMOCHI_SPEECH_WAV2=b.wav
    /// [KIMOCHI_OUT=clip.mp3] cargo test --bin kimochi card_gets -- --ignored --nocapture`. Needs
    /// Screen Recording for the terminal on macOS, and on Windows `KIMOCHI_AUDIO_ENDPOINT_LOOPBACK=1`
    /// (the test's own player is Kimochi's child there, which process loopback leaves out).
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn a_card_gets_its_lines_voice_from_system_audio() {
        use crate::reader::ankiconnect::tests::serve;
        let ort_path = std::env::var("KIMOCHI_ORT").expect("KIMOCHI_ORT");
        let wavs = [std::env::var("KIMOCHI_SPEECH_WAV").unwrap(), std::env::var("KIMOCHI_SPEECH_WAV2").unwrap()];
        let dir = std::env::temp_dir().join(format!("kimochi-sentence-audio-e2e-{}", std::process::id()));
        let settings = Arc::new(Settings::load(dir.join("settings.json")));
        settings.set("sentenceAudio", json!({ "enabled": true })).unwrap();
        let service = SentenceAudio::with_runtime(
            settings,
            Box::new(move || ort::init_from(ort_path.clone()).commit().map(|_| ()).map_err(|e| e.to_string())),
        );
        service.settings_changed();
        for _ in 0..50 {
            if service.recording() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(service.recording(), "{:?}", service.status().state);
        std::thread::sleep(Duration::from_millis(500));

        let play = |path: &str| {
            let status = if cfg!(target_os = "macos") {
                std::process::Command::new("afplay").args(["-v", "0.5", path]).status()
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
            service.record_line(Line { uid: i.to_string(), text: text.to_string(), ts: now_ms(), ocr: false });
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
                    "SentenceAudio": { "value": "", "order": 1 }
                } }]),
                "storeMediaFile" => request["params"]["filename"].clone(),
                _ => Value::Null,
            };
            (200, json!({ "result": result, "error": null }).to_string())
        });
        // The extension's card: its sentence field holds the first line, in markup.
        let texts = vec!["天気".to_string(), "<b>今日</b>はいい天気ですね。".to_string()];
        service.clone().attach(Anki { url, key: None }, 42, texts, None).await;

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
        let _ = std::fs::remove_dir_all(dir);
    }
}
