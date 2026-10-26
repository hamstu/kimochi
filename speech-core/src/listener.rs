//! The listener: follows the recording as it fills, and decides what each line's voice was.
//!
//! # Hearing
//!
//! Every `tick`, the audio recorded since the last one is scored for speech: Silero's
//! probability (`vad`), helped by loudness against the background, because Silero alone misses
//! much of what games voice (a drawn-out "わあ〜っ", a breathy "はいっ", a name, all under music).
//! Speech is grouped into utterances (pauses under `JOIN_MS` stay inside one). Utterances say
//! when a voice is over, and are the clip when nothing better is known.
//!
//! # Deciding
//!
//! A line (`line`) is decided once its voice must be over: the next line has arrived and the
//! speech before it has ended, or nothing has been said for a while. Then:
//!
//! - **Matched**: with the model (SenseVoice, `sense_voice`), the stretch where the line's voice
//!   can be is transcribed, and the line's text is found in what was heard (`matching`). The clip
//!   is that speech, widened to the speech around it that is the line's own, and every character
//!   has a time (word clips come from those). The recogniser also hears speech that is too quiet
//!   for Silero under music.
//! - **Timed**: no model, or no match. The clip is the speech near the line's arrival
//!   (`trim::voice`).
//! - **Silent**: no speech near the line at all ("No voice was detected").
//! - **Missed**: the audio is no longer held.
//!
//! The newest line is decided after a quiet spell, and again when the next line arrives
//! (`provisional`), in case its voice went on after a long pause.
//!
//! # Where a line's voice is looked for
//!
//! From shortly before its anchor (`Line::anchor`: when its text appeared, else when it arrived),
//! but not before the previous line's anchor, to shortly after the next line's anchor. A line
//! read by OCR whose appearance was not seen (a manual scan, maybe long after the voice) is looked
//! for further back, up to `OCR_LOOKBACK_MS`, where only a match by its words is trusted.
//!
//! Everything is driven by the times given to it (`now`, the ring's own timestamps), so the lab
//! replays a recording through exactly what the app runs, faster than real time.
use crate::matching::{self, Heard, Match};
use crate::sense_voice::SenseVoice;
use crate::timeline::{self, Line, Timeline};
use crate::trim::{self, Span};
use crate::vad::{self, Vad};
use kimochi_capture::audio::AudioRing;
use std::collections::{HashMap, VecDeque};

/// Pauses shorter than this are inside one utterance.
const JOIN_MS: f64 = 500.0;
/// An utterance is cut here even if the speech goes on (singing, a long monologue), so lines can
/// be decided.
const MAX_UTTERANCE_MS: f64 = 12_000.0;
/// Speech ends after this long neither above Silero's "off" threshold nor loud.
const MIN_SILENCE_MS: f64 = 150.0;
/// A frame that Silero gives at least this, and that is `SEED_OVER_BACKGROUND` times as loud
/// as the background, starts speech too.
const WEAK_SPEECH: f32 = 0.07;
const SEED_OVER_BACKGROUND: f32 = 4.0;
const MIN_SEED_RMS: f32 = 0.01;
/// Speech goes on through frames this much louder than the background.
const LOUD_OVER_BACKGROUND: f32 = 2.5;
/// ... but for at most this long without Silero hearing speech.
const LOUD_RUN_MS: f64 = 800.0;
const MIN_LOUD_RMS: f32 = 0.004;
/// How far back speech can be found to have risen: 20 frames, 640 ms.
const ONSET_FRAMES: usize = 21;
/// The background level is a low percentile of the last 4 s of frames: quick to follow music
/// coming in, while the pauses between words keep speech itself out of it.
const BACKGROUND_FRAMES: usize = 125;
const BACKGROUND_PERCENTILE: f64 = 0.2;
/// Speech shorter than this is a click, a footstep or a breath.
const MIN_SPEECH_MS: f64 = 200.0;
/// A line's voice may start this long before its anchor (voices that lead their text).
const LEAD_MS: f64 = 1_000.0;
/// ... and run this long past the next line's anchor (the click that advanced cuts it).
const TAIL_MS: f64 = 300.0;
/// The recording is transcribed in chunks that end in a pause in the sound at least this long,
/// once they are this long (or the pause is long), and in any case at the longest...
const CHUNK_PAUSE_MS: f64 = 400.0;
const CHUNK_MIN_MS: f64 = 3_000.0;
const CHUNK_LONG_PAUSE_MS: f64 = 1_500.0;
const CHUNK_MAX_MS: f64 = 20_000.0;
/// ... and each is heard with this much of the audio before it, so its first word is whole.
const CHUNK_CONTEXT_MS: f64 = 300.0;
/// Heard characters further apart than this are separate stretches of speech.
const SPLIT_GAP_MS: f64 = 600.0;
/// A stretch of heard characters is taken to start this long before its first character's frame
/// and end this long after its last, before the utterances widen it.
const CHAR_LEAD_MS: f64 = 120.0;
const CHAR_TAIL_MS: f64 = 250.0;
/// An utterance widens a stretch of heard characters by at most this much at either end.
const WIDEN_START_MS: f64 = 800.0;
const WIDEN_END_MS: f64 = 1_500.0;
/// A match takes in speech this close before or after it, from this long before the line's anchor.
const EXTEND_GAP_MS: f64 = 1_500.0;
const EXTEND_LEAD_MS: f64 = 400.0;
/// After it, speech of at least this long, this close.
const TRAILING_GAP_MS: f64 = 800.0;
const MIN_TRAILING_MS: f64 = 250.0;
/// An OCR'd line whose text was not seen appearing is looked for this far back.
const OCR_LOOKBACK_MS: f64 = 20_000.0;
/// Timing alone, for such a line, trusts only speech still under way this close to its arrival,
/// and from at most this long before it.
const AT_SCAN_MS: f64 = 300.0;
const OCR_TIMED_LEAD_MS: f64 = 1_500.0;
/// The newest line is decided once this long has passed since its anchor...
const SETTLE_AFTER_MS: f64 = 1_500.0;
/// ... and this long has been quiet since the last speech;
const QUIET_MS: f64 = 1_200.0;
/// ... or this long with no speech at all (no voice);
const NO_VOICE_MS: f64 = 5_000.0;
/// ... and in any case by this.
const MAX_WAIT_MS: f64 = 25_000.0;
/// A match by words is trusted at this share of the line's characters, or at `MIN_MATCHED_LOOSE`
/// characters and `MIN_SCORE_LOOSE`.
const MIN_SCORE: f64 = 0.5;
const MIN_SCORE_LOOSE: f64 = 0.34;
const MIN_MATCHED_LOOSE: f64 = 5.0;
/// ... or at this many characters heard in a row from the line's start.
const MIN_OPENING: f64 = 3.0;
/// Screen-text changes kept (`Screen`).
const SCREEN_KEEP: usize = 200;
const SCREEN_LOOKBACK_MS: f64 = 30_000.0;
/// Utterances and transcriptions kept: far more than any buffer holds.
const UTTERANCES_KEEP: usize = 400;
const TRANSCRIPTS_KEEP: usize = 60;

/// How a line's audio is cut, besides what the listener decides.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cutting {
    /// Moves the clip's start and end (negative: earlier).
    pub start_offset_ms: f64,
    pub end_offset_ms: f64,
    /// Cut the clip to the voice in it; off keeps the line's whole window (timed clips only).
    pub trim: bool,
    pub max_clip_ms: f64,
}

impl Default for Cutting {
    fn default() -> Self {
        Self { start_offset_ms: 0.0, end_offset_ms: 0.0, trim: true, max_clip_ms: 30_000.0 }
    }
}

/// How a voiced line's clip was found.
#[derive(Debug, Clone, PartialEq)]
pub enum How {
    /// By its words.
    Matched(Match),
    /// By timing alone.
    Timed,
}

/// A line's voice: the stretch to cut, in Unix ms, padded and with the user's offsets.
#[derive(Debug, Clone, PartialEq)]
pub struct Voice {
    pub from_ms: f64,
    pub to_ms: f64,
    pub how: How,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Voiced(Voice),
    /// No speech near the line.
    Silent,
    /// The line's audio is not held (it is older than the recording, or the recording stopped).
    Missed(String),
}

/// What the listener decided for a line.
#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub uid: String,
    pub text: String,
    pub outcome: Outcome,
    /// Decided before the next line arrived: it may be decided again then.
    pub provisional: bool,
}

/// When the screen's text began to change into each line, from the automatic-scan observer's
/// quick readings: a typewriter effect draws a line in over a second or two, and its voice
/// starts as it begins, while the OCR'd line only arrives once it has settled.
#[derive(Default)]
pub struct Screen {
    /// (when it was first read, the text folded).
    changes: VecDeque<(f64, Vec<char>)>,
}

impl Screen {
    /// The observer read `text` at `at_ms`.
    pub fn observed(&mut self, text: &str, at_ms: f64) {
        let folded = screen_fold(text);
        if self.changes.back().is_some_and(|(_, last)| *last == folded) {
            return;
        }
        self.changes.push_back((at_ms, folded));
        while self.changes.len() > SCREEN_KEEP {
            self.changes.pop_front();
        }
    }

    /// When the text of a line that arrived at `ts` began to appear. While a line draws in,
    /// the screen's text only grows: each reading is held in the next. So, from the last reading
    /// before the line arrived (which must show the line's start), go back while each earlier
    /// reading is held in the one after it (give or take an OCR slip); the run ends at the reading
    /// where the previous line's text was replaced, or the box was empty.
    pub fn appeared(&self, text: &str, ts: f64) -> Option<f64> {
        let line = screen_fold(text);
        if line.is_empty() {
            return None;
        }
        let start: Vec<char> = line.iter().copied().take(2).collect();
        let mut readings = self.changes.iter().rev().filter(|(at, _)| *at <= ts && ts - at <= SCREEN_LOOKBACK_MS);
        let (mut first, mut later) = match readings.next() {
            Some((at, seen)) if seen.windows(start.len()).any(|w| w == start.as_slice()) => (*at, seen),
            _ => return None,
        };
        for (at, seen) in readings {
            if seen.is_empty() || common(seen, later) * 5 < seen.len() * 4 {
                break;
            }
            first = *at;
            later = seen;
        }
        Some(first)
    }
}

/// Screen text as compared: folded (`matching::fold`), or for a line without words ("……", "…！")
/// its marks, so its appearance is seen too.
fn screen_fold(text: &str) -> Vec<char> {
    let (folded, _) = matching::fold(text);
    if folded.is_empty() {
        text.chars().filter(|c| !c.is_whitespace()).collect()
    } else {
        folded
    }
}

/// The length of the longest common subsequence of `a` and `b`.
fn common(a: &[char], b: &[char]) -> usize {
    let mut row = vec![0usize; b.len() + 1];
    for x in a {
        let mut diagonal = 0;
        for (j, y) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = if x == y { diagonal + 1 } else { row[j + 1].max(row[j]) };
            diagonal = above;
        }
    }
    row[b.len()]
}

/// How loud the background is (music, room tone): a low percentile of recent frames' loudness.
#[derive(Default)]
struct Background {
    frames: VecDeque<f32>,
    level: f32,
}

impl Background {
    fn push(&mut self, rms: f32) {
        self.frames.push_back(rms);
        if self.frames.len() > BACKGROUND_FRAMES {
            self.frames.pop_front();
        }
        // Every quarter second is plenty.
        if self.frames.len().is_multiple_of(8) || self.frames.len() < 16 {
            let mut sorted: Vec<f32> = self.frames.iter().copied().collect();
            sorted.sort_by(f32::total_cmp);
            self.level = sorted[((sorted.len() - 1) as f64 * BACKGROUND_PERCENTILE) as usize];
        }
    }
}

struct LineState {
    decision: Option<Decision>,
}

pub struct Listener {
    vad: Option<vad::Stream>,
    asr: Option<SenseVoice>,
    /// The next ring sample to score, and the ring's sample rate when it was read.
    cursor: Option<(u64, u32)>,
    /// Speech started at, and quiet since (hysteresis); loud without Silero's word since.
    speaking: Option<f64>,
    quiet_since: Option<f64>,
    loud_only_since: Option<f64>,
    /// The utterance being heard.
    open: Option<Span>,
    background: Background,
    /// The last few frames' times and whether they were loud, to find where speech rose.
    recent: VecDeque<(f64, bool)>,
    /// Utterances heard, oldest first.
    utterances: Vec<Span>,
    /// The stretches of speech within them (split at every `MIN_SILENCE_MS`), oldest first: what
    /// a line's clip is widened by, since an utterance can run from one line's voice into the
    /// next's.
    /// Each with the part Silero itself called speech (not only its loudness), if any.
    spoken: Vec<(Span, Option<Span>)>,
    /// That part of the stretch being heard.
    voiced: Option<Span>,
    /// Short loud sounds that are not (Silero says) speech, oldest first: a gasp, a sob, a laugh
    /// (or a sound effect), which a line's clip takes in just before its words.
    bursts: Vec<Span>,
    burst: Option<Span>,
    /// What the recogniser heard, chunk by chunk, oldest first, and where the next chunk starts.
    transcripts: Vec<Heard>,
    transcribed_until: f64,
    /// The end of the last frame that was speech or loud.
    last_sound: f64,
    /// Audio is scored up to here (Unix ms).
    heard_until: f64,
    lines: Timeline,
    states: HashMap<String, LineState>,
    pub screen: Screen,
    pub cutting: Cutting,
}

impl Listener {
    /// `vad`: speech detection, or None when it cannot run (then lines get their whole window).
    /// `asr`: the recogniser, when its model is there.
    pub fn new(vad: Option<Vad>, asr: Option<SenseVoice>) -> Self {
        Self {
            vad: vad.map(vad::Stream::new),
            asr,
            cursor: None,
            speaking: None,
            quiet_since: None,
            loud_only_since: None,
            open: None,
            background: Background::default(),
            recent: VecDeque::new(),
            utterances: Vec::new(),
            spoken: Vec::new(),
            voiced: None,
            bursts: Vec::new(),
            burst: None,
            transcripts: Vec::new(),
            transcribed_until: f64::NEG_INFINITY,
            last_sound: f64::NEG_INFINITY,
            heard_until: f64::NEG_INFINITY,
            lines: Timeline::default(),
            states: HashMap::new(),
            screen: Screen::default(),
            cutting: Cutting::default(),
        }
    }

    pub fn has_recogniser(&self) -> bool {
        self.asr.is_some()
    }

    pub fn has_speech_detection(&self) -> bool {
        self.vad.is_some()
    }

    /// The model arrived (or went): lines decided from now on are matched by their words (or not).
    pub fn set_recogniser(&mut self, asr: Option<SenseVoice>) {
        self.asr = asr;
        self.transcripts.clear();
        self.transcribed_until = f64::NEG_INFINITY;
    }

    /// Forget everything: the recording stopped or restarted.
    pub fn clear(&mut self) {
        if let Some(vad) = &mut self.vad {
            vad.reset();
        }
        self.cursor = None;
        self.speaking = None;
        self.quiet_since = None;
        self.open = None;
        self.background = Background::default();
        self.recent.clear();
        self.utterances.clear();
        self.spoken.clear();
        self.bursts.clear();
        self.burst = None;
        self.transcripts.clear();
        self.transcribed_until = f64::NEG_INFINITY;
        self.last_sound = f64::NEG_INFINITY;
        self.heard_until = f64::NEG_INFINITY;
        self.lines.clear();
        self.states.clear();
    }

    /// A line arrived, or its text changed (same uid): it is (re)decided when its voice is over.
    pub fn line(&mut self, mut line: Line) {
        if line.ocr && line.appeared.is_none() {
            line.appeared = self.screen.appeared(&line.text, line.ts);
        }
        let uid = line.uid.clone();
        if self.lines.record(line) {
            self.states.insert(uid, LineState { decision: None });
        }
    }

    /// The line a card was made from (`timeline::Timeline::mined`).
    pub fn mined(&self, texts: &[&str]) -> Option<&Line> {
        self.lines.mined(texts)
    }

    pub fn get_line(&self, uid: &str) -> Option<&Line> {
        self.lines.get(uid)
    }

    /// What was decided for `uid`, if it has been.
    pub fn decision(&self, uid: &str) -> Option<&Decision> {
        self.states.get(uid)?.decision.as_ref()
    }

    /// What the recogniser heard, for the lab's report.
    pub fn transcripts(&self) -> &[Heard] {
        &self.transcripts
    }

    /// Utterances heard, for the lab's report.
    pub fn utterances(&self) -> &[Span] {
        &self.utterances
    }

    /// Audio is scored up to this time.
    pub fn heard_until(&self) -> f64 {
        self.heard_until
    }

    /// Follow the ring, then decide every line whose voice is over. `now`: the current time
    /// (the ring's clock). Answers the new decisions (and a provisional one confirmed).
    pub fn tick(&mut self, ring: &AudioRing, now: f64) -> Vec<Decision> {
        if let Err(e) = self.follow(ring) {
            eprintln!("[sentence-audio] {e}");
            self.vad = None;
        }
        if self.vad.is_none() {
            self.heard_until = ring.end_ms().unwrap_or(now);
        }
        self.transcribe(ring, false);
        self.decide(ring, now, None)
    }

    /// Decide `uid` now, with what has been heard so far (a card was made and waited long
    /// enough). A line already decided for good keeps its decision.
    pub fn decide_now(&mut self, ring: &AudioRing, now: f64, uid: &str) -> Option<Decision> {
        if let Some(settled) = self.decision(uid).filter(|d| !d.provisional) {
            return Some(settled.clone());
        }
        self.transcribe(ring, true);
        self.decide(ring, now, Some(uid)).into_iter().find(|d| d.uid == uid)
    }

    /// Score the audio recorded since the last call, and group the speech into utterances.
    fn follow(&mut self, ring: &AudioRing) -> Result<(), String> {
        let Some(vad) = &mut self.vad else { return Ok(()) };
        let rate = ring.sample_rate();
        // A ring that restarted (a new rate, cleared) is followed afresh.
        let restart = match self.cursor {
            Some((index, r)) => r != rate || index < ring.first_index() || index > ring.end_index(),
            None => true,
        };
        if restart {
            vad.reset();
            self.speaking = None;
            self.quiet_since = None;
            self.close();
            self.cursor = Some((ring.end_index(), rate));
            return Ok(());
        }
        let (index, _) = self.cursor.unwrap();
        // Whole groups of samples that make one 16 kHz sample, so resampling is exact at 48 kHz.
        let group = if rate.is_multiple_of(vad::RATE) { (rate / vad::RATE) as u64 } else { 1 };
        let available = (ring.end_index() - index) / group * group;
        if available == 0 {
            return Ok(());
        }
        let (start, samples) = ring.read_from(index);
        let audio = vad::to_16k(&samples[..available as usize], rate);
        // The stream may hold samples back from the last call: this call's first frame starts
        // where those began.
        let pending_before = vad.pending();
        let frames = vad.push(&audio)?;
        let pending_after = vad.pending();
        let per_16k = rate as f64 / vad::RATE as f64;
        let first_frame = start as f64 - pending_before as f64 * per_16k;
        for (k, (p, rms)) in frames.into_iter().enumerate() {
            let at = first_frame + (k * vad::FRAME) as f64 * per_16k;
            if let Some(t) = ring.wall_ms_at(at.max(0.0) as u64) {
                self.hear(p, rms, t);
            }
        }
        self.cursor = Some((start + available, rate));
        if let Some(end) = ring.wall_ms_at(start + available) {
            self.heard_until = end - pending_after as f64 * 1000.0 / vad::RATE as f64;
        }
        // An utterance whose speech ended long enough ago is over.
        if let Some(open) = self.open {
            if self.speaking.is_none() && self.heard_until - open.end >= JOIN_MS {
                self.close();
            }
        }
        Ok(())
    }

    /// One frame: its speech probability `p` and loudness `rms`, for the frame starting at `t`.
    /// A frame starts speech when Silero says so, or leans that way at all and the frame stands
    /// out from the background; speech runs on (and back, to where the sound rose) while it
    /// stays loud.
    fn hear(&mut self, p: f32, rms: f32, t: f64) {
        let level = self.background.level;
        self.background.push(rms);
        let loud = rms >= (LOUD_OVER_BACKGROUND * level).max(MIN_LOUD_RMS);
        let seed = p >= vad::ON || (p >= WEAK_SPEECH && rms >= (SEED_OVER_BACKGROUND * level).max(MIN_SEED_RMS));
        self.recent.push_back((t, loud));
        while self.recent.len() > ONSET_FRAMES {
            self.recent.pop_front();
        }
        let end = t + vad::FRAME_MS;
        if loud || p >= vad::OFF {
            self.last_sound = end;
        }
        if rms >= (SEED_OVER_BACKGROUND * level).max(MIN_SEED_RMS) {
            self.burst.get_or_insert(Span { start: t, end }).end = end;
        } else if let Some(burst) = self.burst.take() {
            self.bursts.push(burst);
            let excess = self.bursts.len().saturating_sub(UTTERANCES_KEEP);
            self.bursts.drain(..excess);
        }
        match self.speaking {
            None if seed => {
                let start = self.recent.iter().rev().skip(1).take_while(|(_, loud)| *loud).last().map_or(t, |(at, _)| *at);
                self.speaking = Some(start);
                self.voiced = (p >= vad::ON).then_some(Span { start: t, end });
                self.quiet_since = None;
                if self.open.is_some_and(|open| start - open.end > JOIN_MS) {
                    self.close();
                }
                self.open.get_or_insert(Span { start, end }).end = end;
            }
            // Loudness alone carries speech on only so long: music swells are loud too.
            Some(_) if p >= vad::OFF || (loud && t - *self.loud_only_since.get_or_insert(t) < LOUD_RUN_MS) => {
                if p >= vad::OFF {
                    self.loud_only_since = None;
                }
                if p >= vad::ON || (p >= vad::OFF && self.voiced.is_some()) {
                    self.voiced.get_or_insert(Span { start: t, end }).end = end;
                }
                self.quiet_since = None;
                if let Some(open) = &mut self.open {
                    open.end = end;
                    if open.end - open.start >= MAX_UTTERANCE_MS {
                        self.close();
                        self.open = Some(Span { start: end, end });
                    }
                }
            }
            Some(_) => {
                let since = *self.quiet_since.get_or_insert(t);
                if end - since >= MIN_SILENCE_MS {
                    self.loud_only_since = None;
                    if let Some(started) = self.speaking {
                        self.spoken.push((Span { start: started, end: since.max(started) }, self.voiced));
                        let excess = self.spoken.len().saturating_sub(UTTERANCES_KEEP * 4);
                        self.spoken.drain(..excess);
                    }
                    self.speaking = None;
                    self.quiet_since = None;
                    if let Some(open) = &mut self.open {
                        open.end = since.max(open.start);
                    }
                }
            }
            None => {}
        }
    }

    /// The utterance being heard is over (unless it was a blip).
    fn close(&mut self) {
        if let Some(open) = self.open.take() {
            if open.end - open.start >= MIN_SPEECH_MS {
                self.utterances.push(open);
                let excess = self.utterances.len().saturating_sub(UTTERANCES_KEEP);
                self.utterances.drain(..excess);
            }
        }
    }

    /// Stretches of speech between `from` and `to`, including the one being heard.
    /// `strong`: only the parts Silero itself called speech (not their loudness around them).
    fn spoken(&self, from: f64, to: f64, strong: bool) -> Vec<Span> {
        let current = self.speaking.map(|start| (Span { start, end: self.heard_until.max(start) }, self.voiced));
        self.spoken
            .iter()
            .copied()
            .chain(current)
            .filter_map(|(s, voiced)| if strong { voiced } else { Some(s) })
            .filter(|s| s.end > from && s.start < to)
            .collect()
    }

    /// Utterances between `from` and `to`, including the one being heard.
    fn speech(&self, from: f64, to: f64) -> Vec<Span> {
        self.utterances.iter().chain(self.open.iter()).copied().filter(|s| s.end > from && s.start < to).collect()
    }

    /// Transcribe the recording up to a pause: the chunk since the last one, once it ends in a
    /// pause in the sound and is long enough (`CHUNK_*`), or everything heard so far when `now`
    /// (a card is waiting). A chunk with no sound in it is skipped, not transcribed.
    fn transcribe(&mut self, ring: &AudioRing, now: bool) {
        if self.asr.is_none() {
            return;
        }
        let held = ring.start_ms().unwrap_or(self.heard_until);
        let start = self.transcribed_until.max(held);
        if self.heard_until <= start {
            return;
        }
        let pause = self.heard_until - self.last_sound.max(start);
        let length = self.heard_until - start;
        let end = if now {
            self.heard_until
        } else if pause >= CHUNK_PAUSE_MS && (length >= CHUNK_MIN_MS || pause >= CHUNK_LONG_PAUSE_MS) {
            // In the middle of the pause, so neither chunk clips a sound.
            (self.heard_until - pause / 2.0).max(start)
        } else if length >= CHUNK_MAX_MS {
            self.heard_until
        } else {
            return;
        };
        if end <= start {
            return;
        }
        self.transcribed_until = end;
        let sound = self.last_sound > start || self.speech(start, end).iter().any(|_| true);
        let chars = if sound { self.recognise(ring, start, end) } else { Vec::new() };
        self.transcripts.push(Heard { start_ms: start, end_ms: end, chars });
        let excess = self.transcripts.len().saturating_sub(TRANSCRIPTS_KEEP);
        self.transcripts.drain(..excess);
    }

    /// The characters heard between `start` and `end` (with a little audio before, for context).
    fn recognise(&mut self, ring: &AudioRing, start: f64, end: f64) -> Vec<crate::sense_voice::HeardChar> {
        let Some(asr) = &mut self.asr else { return Vec::new() };
        let Some(clip) = ring.snapshot(start - CHUNK_CONTEXT_MS, end) else { return Vec::new() };
        let audio = vad::to_16k(&clip.samples, clip.sample_rate);
        match asr.transcribe(&audio) {
            Ok(chars) => chars
                .into_iter()
                .map(|c| crate::sense_voice::HeardChar { ch: c.ch, ms: clip.start_ms + c.ms })
                .filter(|c| c.ms >= start - CHUNK_CONTEXT_MS / 2.0)
                .collect(),
            Err(e) => {
                eprintln!("[sentence-audio] {e}");
                Vec::new()
            }
        }
    }

    /// What the recogniser heard between `from` and `to`, as stretches of speech: the characters,
    /// split where they pause, each stretch widened to the utterance it is part of.
    fn heard(&self, from: f64, to: f64) -> Vec<Heard> {
        let mut stretches: Vec<Heard> = Vec::new();
        let chars = self.transcripts.iter().flat_map(|t| t.chars.iter()).filter(|c| c.ms >= from && c.ms <= to);
        for c in chars {
            match stretches.last_mut() {
                Some(s) if c.ms - s.chars.last().map_or(f64::NEG_INFINITY, |l| l.ms) <= SPLIT_GAP_MS => s.chars.push(*c),
                _ => stretches.push(Heard { start_ms: 0.0, end_ms: 0.0, chars: vec![*c] }),
            }
        }
        // A stretch starts where its speech rose (any), and ends where speech Silero heard ends:
        // music after it is loud too.
        let (any, by_silero) = (self.spoken(from, to, false), self.spoken(from, to, true));
        for s in &mut stretches {
            let (first, last) = (s.chars[0].ms, s.chars[s.chars.len() - 1].ms);
            s.start_ms = (first - CHAR_LEAD_MS).max(from);
            s.end_ms = (last + CHAR_TAIL_MS).min(to);
            let (start, end) = (s.start_ms, s.end_ms);
            for u in any.iter().filter(|u| u.start < end && u.end > start) {
                if u.start < s.start_ms && u.start >= start - WIDEN_START_MS {
                    s.start_ms = u.start.max(from);
                }
            }
            for u in by_silero.iter().filter(|u| u.start < end && u.end > start) {
                if u.end > s.end_ms && u.end <= end + WIDEN_END_MS {
                    s.end_ms = u.end.min(to);
                }
            }
        }
        stretches
    }

    /// Decide the lines that are due (or just `only`, now, whether due or not).
    fn decide(&mut self, ring: &AudioRing, now: f64, only: Option<&str>) -> Vec<Decision> {
        let mut out = Vec::new();
        let lines: Vec<Line> = self.lines.iter().cloned().collect();
        for (i, line) in lines.iter().enumerate() {
            if only.is_some_and(|uid| uid != line.uid) {
                continue;
            }
            let Some(state) = self.states.get(&line.uid) else { continue };
            let next = lines.get(i + 1);
            let settled = state.decision.as_ref().is_some_and(|d| !d.provisional || next.is_none());
            if settled && only.is_none() {
                continue;
            }
            let previous = i.checked_sub(1).map(|p| &lines[p]);
            let (from, to) = self.window(line, previous, next);
            if only.is_none() && !self.due(line, next, from, to, now) {
                continue;
            }
            let to = to.min(self.heard_until.max(from));
            let mut outcome = self.outcome(ring, line, previous, from, to);
            let state = self.states.get_mut(&line.uid).unwrap();
            // Decided again (the next line arrived): a match by words is not given up for less.
            if let Some(Outcome::Voiced(Voice { how: How::Matched(before), .. })) = state.decision.as_ref().map(|d| &d.outcome) {
                let worse = match &outcome {
                    Outcome::Voiced(Voice { how: How::Matched(now), .. }) => now.score + 0.05 < before.score,
                    Outcome::Missed(_) => false,
                    _ => true,
                };
                if worse {
                    outcome = state.decision.as_ref().unwrap().outcome.clone();
                }
            }
            let decision = Decision { uid: line.uid.clone(), text: line.text.clone(), outcome, provisional: next.is_none() };
            let changed =
                state.decision.as_ref().is_none_or(|d| d.outcome != decision.outcome || d.provisional != decision.provisional);
            state.decision = Some(decision.clone());
            if changed || only.is_some() {
                out.push(decision);
            }
        }
        out
    }

    /// Where `line`'s voice is looked for, in Unix ms (`to` is open-ended for the newest line).
    fn window(&self, line: &Line, previous: Option<&Line>, next: Option<&Line>) -> (f64, f64) {
        let anchor = line.anchor();
        let from = if line.ocr && line.appeared.is_none() {
            let floor = previous.map_or(f64::NEG_INFINITY, |p| p.ts - LEAD_MS);
            (line.ts - OCR_LOOKBACK_MS).max(floor)
        } else {
            let floor = previous.map_or(f64::NEG_INFINITY, |p| p.anchor().min(anchor));
            (anchor - LEAD_MS).max(floor)
        };
        // An OCR'd line arrives once drawn: the next line cannot have begun before that.
        let earliest_next = if line.ocr { line.ts } else { anchor };
        let to = next.map_or(f64::INFINITY, |n| n.anchor().max(earliest_next) + TAIL_MS);
        (from, to)
    }

    /// Whether `line`'s voice must be over by now.
    fn due(&self, line: &Line, next: Option<&Line>, from: f64, to: f64, now: f64) -> bool {
        let heard_until = self.heard_until;
        let anchor = line.anchor();
        if heard_until - anchor >= MAX_WAIT_MS || now - line.ts >= MAX_WAIT_MS * 2.0 {
            return true;
        }
        // Speech before `to` that is still being heard, or not yet transcribed.
        let untranscribed = self.asr.is_some() && self.transcribed_until < to.min(self.last_sound);
        let unfinished = self.open.is_some_and(|o| o.start < to) || untranscribed;
        if next.is_some() {
            return heard_until >= to && !unfinished;
        }
        if heard_until - anchor < SETTLE_AFTER_MS || unfinished || self.speaking.is_some() {
            return false;
        }
        match self.speech(from, heard_until).iter().map(|s| s.end).reduce(f64::max) {
            Some(last) => heard_until - last >= QUIET_MS,
            None => heard_until - anchor >= NO_VOICE_MS,
        }
    }

    /// A match by words, widened to the speech around it that is the line's own: for a line whose
    /// anchor is reliable (hooked, or seen appearing), speech from just before the anchor to the
    /// next line's anchor belongs to it even where the recogniser made nothing of it (an
    /// interjection, a sigh, a name it did not know).
    fn around_match(&self, line: &Line, m: &Match, stretches: &[Heard], from: f64, to: f64) -> (f64, f64) {
        let (mut start, mut end) = (m.start_ms, m.end_ms);
        if line.ocr && line.appeared.is_none() {
            return (start, end);
        }
        let floor = from.max(line.anchor() - EXTEND_LEAD_MS);
        let ceiling = (to - TAIL_MS).max(end);
        let words = stretches.iter().map(|s| Span { start: s.start_ms, end: s.end_ms });
        // Before the words: any speech, and loud bursts (a gasp, a sob).
        let mut before = self.spoken(floor, start, false);
        before.extend(words.clone());
        before.extend(self.bursts.iter().copied().filter(|b| b.start >= floor && b.end <= start));
        before.sort_by(|a, b| a.start.total_cmp(&b.start));
        // After them, only speech Silero heard, or words: music swells are loud too, and bursts
        // are as likely the next line's.
        let mut spans = self.spoken(end - CHAR_TAIL_MS, ceiling, true);
        spans.extend(words);
        spans.sort_by(|a, b| a.start.total_cmp(&b.start));
        for span in before.iter().rev() {
            if span.end >= start - EXTEND_GAP_MS && span.start < start && span.start >= floor {
                start = span.start;
            }
        }
        // After it, only speech of its own (a trailing laugh, a last word the recogniser missed):
        // an utterance running on from the match may be the next line said without a pause.
        for span in &spans {
            // Speech that runs on past the next line's anchor is the next line's.
            let own = span.end <= ceiling + TAIL_MS;
            let speech = span.end - span.start >= MIN_TRAILING_MS;
            if own && speech && span.start >= end - CHAR_TAIL_MS && span.start <= end + TRAILING_GAP_MS && span.end > end {
                end = span.end.min(ceiling);
            }
        }
        (start, end)
    }

    fn outcome(&mut self, ring: &AudioRing, line: &Line, previous: Option<&Line>, from: f64, to: f64) -> Outcome {
        let held_from = ring.start_ms().unwrap_or(f64::INFINITY);
        if line.anchor().max(from) < held_from && line.ts < held_from {
            return Outcome::Missed("The line is older than the audio kept.".into());
        }
        let cutting = self.cutting;
        let cut = |from: f64, to: f64, how: How| {
            let start = from - trim::PAD_BEFORE_MS + cutting.start_offset_ms;
            let end = (to + trim::PAD_AFTER_MS + cutting.end_offset_ms).min(start + cutting.max_clip_ms);
            Outcome::Voiced(Voice { from_ms: start, to_ms: end.max(start), how })
        };
        let stretches = if to > from { self.heard(from, to) } else { Vec::new() };
        let found = matching::find_near(&line.text, &stretches, from, to, line.anchor());
        // KIMOCHI_SENTENCE_AUDIO_DEBUG=1: what each line was decided from.
        if std::env::var_os("KIMOCHI_SENTENCE_AUDIO_DEBUG").is_some() {
            let heard: Vec<String> = stretches.iter().map(|s| format!("{:.2}-{:.2} {}", s.start_ms / 1000.0, s.end_ms / 1000.0, s.text())).collect();
            eprintln!(
                "[sentence-audio] {} {:?}: window {:.2}-{:.2}, anchor {:.2}, heard {heard:?}, match {:?}",
                line.uid,
                line.text,
                from / 1000.0,
                to / 1000.0,
                line.anchor() / 1000.0,
                found.as_ref().map(|m| (m.score, m.heard.clone()))
            );
        }
        if let Some(m) = found {
            let letters = matching::fold(&line.text).0.len() as f64;
            let matched = m.score * letters;
            // A voice cut short (the player clicked on) matches only the line's opening words.
            let opening = m.from_line_start && matched >= MIN_OPENING;
            if m.score >= MIN_SCORE || (m.score >= MIN_SCORE_LOOSE && matched >= MIN_MATCHED_LOOSE) || opening {
                let (start, end) = self.around_match(line, &m, &stretches, from, to);
                if std::env::var_os("KIMOCHI_SENTENCE_AUDIO_DEBUG").is_some() {
                    let spans = |strong| -> Vec<String> {
                        self.spoken(from, to, strong).iter().map(|s| format!("{:.2}-{:.2}", s.start / 1000.0, s.end / 1000.0)).collect()
                    };
                    let spoken = (spans(false), spans(true));
                    eprintln!(
                        "[sentence-audio] {}: matched {:.2}-{:.2}, widened to {:.2}-{:.2}; speech {spoken:?}",
                        line.uid,
                        m.start_ms / 1000.0,
                        m.end_ms / 1000.0,
                        start / 1000.0,
                        end / 1000.0
                    );
                }
                return cut(start, end, How::Matched(m));
            }
        }
        // Timing alone. An OCR'd line not seen appearing may have been scanned long after its
        // voice: with the recogniser listening and no match, its voice was not heard; without
        // it, only speech under way when it was scanned is taken.
        let unanchored = line.ocr && line.appeared.is_none();
        if unanchored && self.asr.is_some() {
            return Outcome::Silent;
        }
        let (from, to) = if unanchored {
            // Only a voice still playing as the line was scanned.
            let at_scan = self.speech(line.ts - AT_SCAN_MS, line.ts);
            let (Some(start), Some(end)) = (
                at_scan.iter().map(|s| s.start).reduce(f64::min),
                at_scan.iter().map(|s| s.end).reduce(f64::max),
            ) else {
                return Outcome::Silent;
            };
            let floor = from.max(line.ts - OCR_TIMED_LEAD_MS).max(previous.map_or(f64::NEG_INFINITY, |p| p.ts));
            (start.max(floor), end.max(floor))
        } else {
            (from, to.max(from))
        };
        // Stretches of speech, each ending where Silero last heard speech in it (the loudness after
        // is as likely music).
        let mut speech: Vec<Span> = self
            .spoken
            .iter()
            .copied()
            .chain(self.speaking.map(|start| (Span { start, end: self.heard_until.max(start) }, self.voiced)))
            .map(|(s, voiced)| voiced.map_or(s, |v| Span { start: s.start, end: v.end.min(s.end).max(s.start) }))
            .filter(|s| s.end > from && s.start < to)
            .collect();
        speech.extend(stretches.iter().filter(|s| s.end_ms > from && s.start_ms < to).map(|s| Span { start: s.start_ms, end: s.end_ms }));
        // A line without words ("……", "…！") is often voiced with a gasp or a sigh, which Silero
        // does not call speech: a loud burst right after a reliable anchor counts.
        if !(line.ocr && line.appeared.is_none()) {
            let floor = line.anchor() - EXTEND_LEAD_MS;
            let ceiling = if to.is_finite() { to - TAIL_MS } else { self.heard_until };
            speech.extend(self.bursts.iter().copied().filter(|b| b.start >= floor && b.start < ceiling && b.end <= to));
        }
        if self.vad.is_none() || !cutting.trim {
            if self.vad.is_some() && speech.is_empty() {
                return Outcome::Silent;
            }
            // No speech detection (or trimming off): the whole window.
            return Outcome::Voiced(Voice {
                from_ms: from + cutting.start_offset_ms,
                to_ms: (to + cutting.end_offset_ms).min(from + cutting.max_clip_ms),
                how: How::Timed,
            });
        }
        // Speech under way well before the line's anchor is the previous line's voice running on.
        if !unanchored {
            let floor = line.anchor() - EXTEND_LEAD_MS;
            speech.retain(|s| s.start >= floor);
        }
        speech.sort_by(|a, b| a.start.total_cmp(&b.start));
        let spans: Vec<Span> =
            speech.into_iter().map(|s| Span { start: s.start.max(from) - from, end: s.end.min(to) - from }).collect();
        match trim::voice(&spans, line.anchor().max(from) - from) {
            Some(voice) => cut(from + voice.start, from + voice.end, How::Timed),
            None => Outcome::Silent,
        }
    }
}

/// A line as the Log reports it (for tests and the lab).
pub fn line(uid: &str, text: &str, ts: f64, ocr: bool) -> Line {
    Line { uid: uid.into(), text: text.into(), ts, ocr, appeared: None }
}

pub use timeline::normalize;


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_appeared_when_it_began_to_draw_in() {
        let mut screen = Screen::default();
        screen.observed("前の台詞です。", 1_000.0);
        screen.observed("", 4_000.0);
        screen.observed("今", 4_100.0);
        screen.observed("今日は", 4_300.0);
        screen.observed("今日はいい天気", 4_700.0);
        screen.observed("今日はいい天気ですね。", 5_200.0);
        assert_eq!(screen.appeared("今日はいい天気ですね。", 5_900.0), Some(4_100.0), "as it began to draw in");
        assert_eq!(screen.appeared("前の台詞です。", 3_000.0), Some(1_000.0));
        assert_eq!(screen.appeared("見たことのない文", 5_900.0), None);
        assert_eq!(screen.appeared("今日はいい天気ですね。", 4_200.0), None, "not yet shown by then");
        // The next line's first words inside this one's text are not the next line appearing.
        screen.observed("あたしのお姉ちゃんなんだけど", 6_000.0);
        screen.observed("お姉ちゃん…？", 7_200.0);
        assert_eq!(screen.appeared("お姉ちゃん…？", 7_900.0), Some(7_200.0));
        // A name box and buttons around the text box: the new name and first word are where it
        // began (the empty box before held the old name).
        let mut game = Screen::default();
        game.observed("シーア 前の台詞です。 オート スキップ", 1_000.0);
        game.observed("シーア オート スキップ", 2_000.0);
        game.observed("フリッツ 今日 オート スキップ", 2_200.0);
        game.observed("フリッツ 今日はいい天気ですね。 オート スキップ", 2_600.0);
        assert_eq!(game.appeared("今日はいい天気ですね。", 3_400.0), Some(2_200.0));
    }

    #[test]
    fn without_speech_detection_a_line_gets_its_whole_window() {
        let mut ring = AudioRing::new(1_000, 60.0);
        ring.push(0.0, 1_000, &vec![0.1; 20_000]);
        let mut listener = Listener::new(None, None);
        listener.line(line("a", "一", 2_000.0, false));
        listener.line(line("b", "二", 6_000.0, false));
        let decisions = listener.tick(&ring, 20_000.0);
        let a = decisions.iter().find(|d| d.uid == "a").unwrap();
        match &a.outcome {
            Outcome::Voiced(v) => assert_eq!((v.from_ms, v.to_ms, &v.how), (1_000.0, 6_300.0, &How::Timed)),
            other => panic!("{other:?}"),
        }
        assert!(!a.provisional);
        // The newest line runs to the end of the recording, and is decided again later.
        let b = decisions.iter().find(|d| d.uid == "b").unwrap();
        assert!(b.provisional);
        assert!(matches!(&b.outcome, Outcome::Voiced(v) if v.to_ms == 20_000.0));
        assert!(listener.tick(&ring, 21_000.0).is_empty(), "nothing new");
    }

    #[test]
    fn a_line_older_than_the_recording_is_missed() {
        let mut ring = AudioRing::new(1_000, 10.0);
        ring.push(50_000.0, 1_000, &vec![0.0; 10_000]);
        let mut listener = Listener::new(None, None);
        listener.line(line("old", "古い", 10_000.0, false));
        listener.line(line("new", "新しい", 55_000.0, false));
        let decisions = listener.tick(&ring, 60_000.0);
        assert!(matches!(decisions[0].outcome, Outcome::Missed(_)), "{decisions:?}");
    }
}
