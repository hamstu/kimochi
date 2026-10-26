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
//! # Scans, claims and second tries
//!
//! - The lines of one OCR scan (the dialogue, a name box, another speaker's box, noise the OCR
//!   picked up) arrive together and are decided together (`units`). Every block is looked for in
//!   what was heard; blocks said apart each get their own voice, and the parts of one box read as
//!   two blocks share theirs. A block that looks like a name box (short, no punctuation:
//!   `speaking_lines`) needs strong evidence of its own (`said_aside`), and a name said inside
//!   the dialogue is the dialogue's. Without a match, timing gives the voice to the line most
//!   like dialogue (`main_line`).
//! - A match holds the words it heard: other lines are matched to what is left (`claimed`). A
//!   line scanned again gets the voice its earlier reading had (`same_text`).
//! - A match is never given up, only bettered while it is partial (`replaces`); once most of the
//!   line is heard (`FINAL_SCORE`) it is not decided again. A line without one is tried again
//!   each time more speech is transcribed, for `RETRY_MS` (a scan made while the voice played).
//!   One letter heard is never a match.
//! - Lines the Log deletes, or a fuller reading replaces, are forgotten (`forget`).
//!
//! # Speed
//!
//! A line is decided as soon as its voice is over and transcribed: while a line waits, the
//! speech so far is transcribed at its first pause, and a line scanned with no sign of when it
//! appeared does not wait for its voice to start (it was already on screen). Pauses are judged
//! against the background as it is now (music comes and goes); how far speech reaches, against
//! the quietest of the last 30 s, so a soft start still counts.
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
/// Sound this much above the floor, for at least this long, just before a line's words (at most
/// `LEAD_IN_GAP_MS` before them) is its lead-in: a stammer, a soft "へえ……".
const LEAD_IN_OVER_BACKGROUND: f32 = 1.7;
const MIN_LOUD_MS: f64 = 100.0;
const LEAD_IN_GAP_MS: f64 = 800.0;
/// How far back speech can be found to have risen: 20 frames, 640 ms.
const ONSET_FRAMES: usize = 21;
/// The background level is a low percentile of the last 4 s of frames: quick to follow music
/// coming in, while the pauses between words keep speech itself out of it.
const BACKGROUND_FRAMES: usize = 125;
const BACKGROUND_PERCENTILE: f64 = 0.2;
/// How far speech reaches is judged against a slower floor too, the quietest of the last 30 s:
/// a voice's soft start ("へえ……", "そ、") rises above the room even while music plays. The
/// quick level alone says when the sound pauses (a voice is over, a chunk can be transcribed).
const FLOOR_FRAMES: usize = 940;
const FLOOR_PERCENTILE: f64 = 0.1;
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
/// A chunk the recogniser fails on is tried again this many times before it is skipped.
const MAX_FAILURES: u32 = 3;
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
/// Speech after an OCR'd line was read is still its voice if it follows the voice under way
/// with pauses no longer than this (a slow, dramatic line); later speech is the next line's.
const RUNS_ON_MS: f64 = 2_500.0;
/// A scanned line no match found is given the speech heard ending at most this long before the
/// scan, when at least this many of its characters, and this share of them, are the line's.
const MISHEARD_RECENT_MS: f64 = 3_000.0;
const MISHEARD_MIN_CHARS: usize = 3;
const MISHEARD_SHARE: f64 = 0.5;
/// An OCR'd line whose text was not seen appearing is looked for this far back.
const OCR_LOOKBACK_MS: f64 = 20_000.0;
/// Timing alone, for such a line, trusts only speech still under way this close to its arrival
/// (the whole utterance, from at most this long before it).
const AT_SCAN_MS: f64 = 300.0;
const OCR_TIMED_LEAD_MS: f64 = 12_000.0;
/// ... with the speech before it, when the pause between them is at most this.
const RUN_INTO_MS: f64 = 1_000.0;
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
/// A match by words this good is the line's for good: it is never decided again.
const FINAL_SCORE: f64 = 0.8;
/// A scan without a match by its words is tried again as more is transcribed, while the
/// recording is within this of it.
const RETRY_MS: f64 = 40_000.0;
/// Two lines of one scan whose matches share more than this (of the shorter) heard the same words.
const SAME_VOICE: f64 = 0.3;
/// A line of a multi-line scan this short (in letters) with no punctuation is a name box.
const NAME_LETTERS: usize = 6;
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

/// What the listener knows (`Listener::report`), for the Diagnostics window.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub heard_until: Option<f64>,
    pub transcribed_until: Option<f64>,
    /// Speech is being heard now.
    pub speaking: bool,
    pub speech_detection: bool,
    pub recogniser: bool,
    /// The newest lines first.
    pub lines: Vec<LineReport>,
    /// What the recogniser heard recently, oldest first.
    pub heard: Vec<HeardReport>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineReport {
    pub uid: String,
    pub text: String,
    pub ts: f64,
    pub appeared: Option<f64>,
    pub scan: Option<String>,
    /// `waiting`, `voiced`, `silent` or `missed`.
    pub outcome: &'static str,
    /// `matched` or `timed`.
    pub how: Option<&'static str>,
    pub score: Option<f64>,
    pub heard: Option<String>,
    /// The clip, in Unix ms.
    pub clip: Option<(f64, f64)>,
    pub provisional: bool,
    /// Where its voice was looked for.
    pub window: Option<(f64, f64)>,
    pub decided_at: Option<f64>,
    /// How many times its decision changed.
    pub changes: usize,
    pub note: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeardReport {
    pub start_ms: f64,
    pub end_ms: f64,
    pub text: String,
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

/// Screen text as compared: each character folded as `matching::fold` does (katakana as
/// hiragana, full-width as ASCII), but marks kept, so a line without words ("……", "…！") is
/// seen appearing too, beside a name box or not.
fn screen_fold(text: &str) -> Vec<char> {
    text.chars().filter(|c| !c.is_whitespace()).map(|c| matching::fold(&c.to_string()).0.first().copied().unwrap_or(c)).collect()
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
    /// The slower floor (`FLOOR_FRAMES`), and its frames.
    long: VecDeque<f32>,
    floor: f32,
    /// Frames pushed, to re-rank every few.
    pushed: u64,
}

impl Background {
    fn push(&mut self, rms: f32) {
        self.frames.push_back(rms);
        if self.frames.len() > BACKGROUND_FRAMES {
            self.frames.pop_front();
        }
        self.long.push_back(rms);
        if self.long.len() > FLOOR_FRAMES {
            self.long.pop_front();
        }
        self.pushed += 1;
        let rank = |frames: &VecDeque<f32>, percentile: f64| {
            let mut sorted: Vec<f32> = frames.iter().copied().collect();
            sorted.sort_by(f32::total_cmp);
            sorted[((sorted.len() - 1) as f64 * percentile) as usize]
        };
        // Every quarter second is plenty (every two for the floor).
        if self.pushed.is_multiple_of(8) || self.frames.len() < 16 {
            self.level = rank(&self.frames, BACKGROUND_PERCENTILE);
        }
        if self.pushed.is_multiple_of(64) || self.long.len() < 16 {
            self.floor = rank(&self.long, FLOOR_PERCENTILE);
        }
    }

    /// The level speech is judged against: the quick level, or the floor below it.
    fn speech_level(&self) -> f32 {
        self.level.min(self.floor)
    }
}

#[derive(Default)]
struct LineState {
    decision: Option<Decision>,
    /// `Listener::heard_count` when it was last decided: tried again once more has been heard.
    tried: usize,
    /// How many times its decision changed, and when it last did.
    tries: usize,
    decided_at: Option<f64>,
    /// Where its voice was last looked for.
    window: Option<(f64, f64)>,
    /// Why it was decided as it was, for the Diagnostics window.
    note: String,
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
    /// Stretches of sound above the floor (`LEAD_IN_OVER_BACKGROUND`), oldest first: a stammer
    /// or a soft "へえ……" before a line's words, which Silero does not call speech.
    louds: Vec<Span>,
    loud_run: Option<Span>,
    /// What the recogniser heard, chunk by chunk, oldest first, and where the next chunk starts.
    transcripts: Vec<Heard>,
    transcribed_until: f64,
    /// Transcribed chunks with words in them so far: lines are tried again when it grows.
    heard_count: usize,
    /// The recogniser failed on the chunk this many times in a row.
    failures: u32,
    /// Tests give the transcripts themselves, standing in for the recogniser.
    given_transcripts: bool,
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
            louds: Vec::new(),
            loud_run: None,
            transcripts: Vec::new(),
            transcribed_until: f64::NEG_INFINITY,
            heard_count: 0,
            failures: 0,
            given_transcripts: false,
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

    /// Whether lines are matched by their words: the recogniser is there (or, in tests, its
    /// transcripts are given).
    fn recognising(&self) -> bool {
        self.asr.is_some() || self.given_transcripts
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
        self.louds.clear();
        self.loud_run = None;
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
            self.states.insert(uid, LineState::default());
            // Lines the timeline let go of (it keeps the newest few hundred).
            let lines = &self.lines;
            self.states.retain(|uid, _| lines.get(uid).is_some());
        }
    }

    /// Forget lines: the Log deleted them, or a fuller reading of the same text replaced them
    /// (and arrives as a line of its own). Their voice is free for other lines again.
    pub fn forget(&mut self, uids: &[String]) {
        self.lines.remove(uids);
        for uid in uids {
            self.states.remove(uid);
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

    /// Why `uid` was decided as it was (or is still waiting).
    pub fn note(&self, uid: &str) -> Option<String> {
        let state = self.states.get(uid)?;
        if state.decision.is_some() {
            return Some(state.note.clone());
        }
        Some(if self.speaking.is_some() {
            "waiting: speech is under way".into()
        } else if self.unfinished(f64::INFINITY) {
            "waiting: the speech model is catching up".into()
        } else {
            "waiting for its voice to end".into()
        })
    }

    /// What the listener knows, for the Diagnostics window: the newest `lines`, and what was
    /// heard in the last `heard_ms`.
    pub fn report(&self, lines: usize, heard_ms: f64) -> Report {
        let lines = self
            .lines
            .iter()
            .rev()
            .take(lines)
            .map(|line| {
                let state = self.states.get(&line.uid);
                let decision = state.and_then(|s| s.decision.as_ref());
                let (outcome, how, score, heard, clip) = match decision.map(|d| &d.outcome) {
                    None => ("waiting", None, None, None, None),
                    Some(Outcome::Voiced(v)) => match &v.how {
                        How::Matched(m) => ("voiced", Some("matched"), Some(m.score), Some(m.heard.clone()), Some((v.from_ms, v.to_ms))),
                        How::Timed => ("voiced", Some("timed"), None, None, Some((v.from_ms, v.to_ms))),
                    },
                    Some(Outcome::Silent) => ("silent", None, None, None, None),
                    Some(Outcome::Missed(_)) => ("missed", None, None, None, None),
                };
                LineReport {
                    uid: line.uid.clone(),
                    text: line.text.clone(),
                    ts: line.ts,
                    appeared: line.appeared,
                    scan: line.scan.clone(),
                    outcome,
                    how,
                    score,
                    heard,
                    clip,
                    provisional: decision.is_some_and(|d| d.provisional),
                    window: state.and_then(|s| s.window),
                    decided_at: state.and_then(|s| s.decided_at),
                    changes: state.map_or(0, |s| s.tries),
                    note: self.note(&line.uid).unwrap_or_default(),
                }
            })
            .collect();
        let heard = self
            .transcripts
            .iter()
            .filter(|t| t.end_ms >= self.heard_until - heard_ms && !t.chars.is_empty())
            .map(|t| HeardReport { start_ms: t.start_ms, end_ms: t.end_ms, text: t.text() })
            .collect();
        Report {
            heard_until: self.heard_until.is_finite().then_some(self.heard_until),
            transcribed_until: self.transcribed_until.is_finite().then_some(self.transcribed_until),
            speaking: self.speaking.is_some(),
            speech_detection: self.vad.is_some(),
            recogniser: self.asr.is_some(),
            lines,
            heard,
        }
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

    /// Decide `uid` now, with everything heard so far (a card was made and waited long enough):
    /// a line not yet matched by its words is tried again. A match stays as it was.
    pub fn decide_now(&mut self, ring: &AudioRing, now: f64, uid: &str) -> Option<Decision> {
        if let Some(matched) = self.decision(uid).filter(|d| matches!(&d.outcome, Outcome::Voiced(Voice { how: How::Matched(_), .. }))) {
            return Some(matched.clone());
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
        let (level, floor) = (self.background.level, self.background.speech_level());
        self.background.push(rms);
        let loud = rms >= (LOUD_OVER_BACKGROUND * floor).max(MIN_LOUD_RMS);
        let seed = p >= vad::ON || (p >= WEAK_SPEECH && rms >= (SEED_OVER_BACKGROUND * floor).max(MIN_SEED_RMS));
        self.recent.push_back((t, loud));
        while self.recent.len() > ONSET_FRAMES {
            self.recent.pop_front();
        }
        let end = t + vad::FRAME_MS;
        if p >= vad::OFF || rms >= (LOUD_OVER_BACKGROUND * level).max(MIN_LOUD_RMS) {
            self.last_sound = end;
        }
        if rms >= (LEAD_IN_OVER_BACKGROUND * floor).max(MIN_LOUD_RMS) {
            self.loud_run.get_or_insert(Span { start: t, end }).end = end;
        } else if let Some(run) = self.loud_run.take().filter(|r| r.end - r.start >= MIN_LOUD_MS) {
            self.louds.push(run);
            let excess = self.louds.len().saturating_sub(UTTERANCES_KEEP);
            self.louds.drain(..excess);
        }
        if rms >= (SEED_OVER_BACKGROUND * floor).max(MIN_SEED_RMS) {
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
        // A line waiting for its voice to be heard: the speech so far, at its first pause.
        let waiting = self.states.values().any(|s| s.decision.is_none());
        // Never longer than half the recording kept, so a chunk's start is still held.
        let longest = CHUNK_MAX_MS.min(ring.seconds() * 500.0);
        let end = if now {
            self.heard_until
        } else if pause >= CHUNK_PAUSE_MS && (length >= CHUNK_MIN_MS || pause >= CHUNK_LONG_PAUSE_MS || waiting) {
            // In the middle of the pause, so neither chunk clips a sound.
            (self.heard_until - pause / 2.0).max(start)
        } else if length >= longest {
            self.heard_until
        } else {
            return;
        };
        if end <= start {
            return;
        }
        let sound = self.last_sound > start || self.speech(start, end).iter().any(|_| true);
        let chars = if sound {
            match self.recognise(ring, start, end) {
                Ok(chars) => chars,
                // Tried again next time, a few times, while the audio is held.
                Err(e) if self.failures < MAX_FAILURES => {
                    self.failures += 1;
                    eprintln!("[sentence-audio] {e}");
                    return;
                }
                Err(e) => {
                    eprintln!("[sentence-audio] {e}; skipping {:.1}s of audio", (end - start) / 1000.0);
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        self.failures = 0;
        self.transcribed_until = end;
        if !chars.is_empty() {
            self.heard_count += 1;
        }
        self.transcripts.push(Heard { start_ms: start, end_ms: end, chars });
        let excess = self.transcripts.len().saturating_sub(TRANSCRIPTS_KEEP);
        self.transcripts.drain(..excess);
    }

    /// The characters heard between `start` and `end` (with a little audio before, for context).
    fn recognise(&mut self, ring: &AudioRing, start: f64, end: f64) -> Result<Vec<crate::sense_voice::HeardChar>, String> {
        let Some(asr) = &mut self.asr else { return Ok(Vec::new()) };
        let Some(clip) = ring.snapshot(start - CHUNK_CONTEXT_MS, end) else { return Ok(Vec::new()) };
        let audio = vad::to_16k(&clip.samples, clip.sample_rate);
        Ok(asr
            .transcribe(&audio)?
            .into_iter()
            .map(|c| crate::sense_voice::HeardChar { ch: c.ch, ms: clip.start_ms + c.ms })
            .filter(|c| c.ms >= start - CHUNK_CONTEXT_MS / 2.0)
            .collect())
    }

    /// What the recogniser heard between `from` and `to`, as stretches of speech: the characters,
    /// split where they pause, each stretch widened to the utterance it is part of. Characters
    /// in `claimed` (other lines' voices) are left out.
    fn heard(&self, from: f64, to: f64, claimed: &[Span]) -> Vec<Heard> {
        let mut stretches: Vec<Heard> = Vec::new();
        let chars = self
            .transcripts
            .iter()
            .flat_map(|t| t.chars.iter())
            .filter(|c| c.ms >= from && c.ms <= to && !claimed.iter().any(|s| c.ms >= s.start && c.ms < s.end));
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

    /// Decide the lines that are due (or just `only`'s scan, now, whether due or not), a scan at a
    /// time (`units`), and try again the recent ones without a final match once more has been heard.
    fn decide(&mut self, ring: &AudioRing, now: f64, only: Option<&str>) -> Vec<Decision> {
        let mut out = Vec::new();
        let lines: Vec<Line> = self.lines.iter().cloned().collect();
        let units = units(&lines);
        let main_of = |u: usize| &lines[units[u].start + main_line(&lines[units[u].clone()])];
        for (u, range) in units.iter().enumerate() {
            let unit = &lines[range.clone()];
            if only.is_some_and(|uid| !unit.iter().any(|l| l.uid == uid)) {
                continue;
            }
            let main = main_line(unit);
            let previous = u.checked_sub(1).map(main_of);
            let next = units.get(u + 1).map(|_| main_of(u + 1));
            let decided: Vec<Option<&Decision>> = unit.iter().map(|l| self.decision(&l.uid)).collect();
            let undecided = decided.iter().any(|d| d.is_none_or(|d| d.provisional && next.is_some()));
            let retry = !undecided && self.retry_due(unit, now);
            if only.is_none() && !undecided && !retry {
                continue;
            }
            let (from, to) = self.window(&unit[main], previous, next);
            if only.is_none() && undecided && !self.due(&unit[main], next, from, to, now) {
                continue;
            }
            let to = to.min(self.heard_until.max(from));
            let outcomes = self.unit_outcomes(ring, unit, main, previous, from, to);
            let heard_count = self.heard_count;
            for (line, (mut outcome, mut note)) in unit.iter().zip(outcomes) {
                let Some(state) = self.states.get_mut(&line.uid) else { continue };
                state.tried = heard_count;
                state.window = Some((from, to));
                if let Some(before) = &state.decision {
                    if !replaces(&before.outcome, &outcome, retry) {
                        outcome = before.outcome.clone();
                        note = state.note.clone();
                    }
                }
                let provisional = next.is_none() && !is_final(&outcome);
                let decision = Decision { uid: line.uid.clone(), text: line.text.clone(), outcome, provisional };
                let changed = state.decision.as_ref().is_none_or(|d| d.outcome != decision.outcome || d.provisional != decision.provisional);
                if changed {
                    state.decided_at = Some(now);
                    state.tries += 1;
                }
                state.note = note;
                state.decision = Some(decision.clone());
                if changed || only.is_some() {
                    out.push(decision);
                }
            }
        }
        out
    }

    /// Whether a scan already decided is worth trying again: one of its lines has no final match,
    /// the recogniser has heard more since, and the scan is recent enough for that to be its
    /// voice. (Lines already final keep their decision: `replaces`.)
    fn retry_due(&self, unit: &[Line], now: f64) -> bool {
        let Some(newest) = unit.iter().map(|l| l.ts).reduce(f64::max) else { return false };
        self.recognising()
            && now - newest < RETRY_MS
            && unit.iter().any(|l| {
                let state = self.states.get(&l.uid);
                state.is_some_and(|s| s.tried < self.heard_count && !s.decision.as_ref().is_some_and(|d| is_final(&d.outcome)))
            })
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
        if next.is_some() {
            return heard_until >= to && !self.unfinished(to);
        }
        // A line scanned with no sign of when it appeared was already on screen: its voice has
        // begun (or is over), and only has to end. Others wait for theirs to start.
        let settled = (line.ocr && line.appeared.is_none()) || heard_until - anchor >= SETTLE_AFTER_MS;
        if !settled || self.unfinished(to) || self.speaking.is_some() {
            return false;
        }
        match self.speech(from, heard_until).iter().map(|s| s.end).reduce(f64::max) {
            Some(last) => heard_until - last >= QUIET_MS,
            None => heard_until - anchor >= NO_VOICE_MS,
        }
    }

    /// Speech before `to` that is still being heard, or not yet transcribed.
    fn unfinished(&self, to: f64) -> bool {
        let untranscribed = self.recognising() && self.transcribed_until < to.min(self.last_sound);
        self.open.is_some_and(|o| o.start < to) || untranscribed
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
        // A softer lead-in right before that.
        for span in self.louds.iter().rev() {
            if span.start >= floor && span.start < start && span.end >= start - LEAD_IN_GAP_MS {
                start = span.start;
            }
        }
        // After it, only speech of its own (a trailing laugh, a last word the recogniser missed):
        // an utterance running on from the match may be the next line said without a pause.
        for span in &spans {
            // Speech that runs on past the next line's anchor is the next line's (what reaches the
            // window's end was cut there: it ran on).
            let own = span.end < ceiling + TAIL_MS - 1.0;
            let speech = span.end - span.start >= MIN_TRAILING_MS;
            if own && speech && span.start >= end - CHAR_TAIL_MS && span.start <= end + TRAILING_GAP_MS && span.end > end {
                end = span.end.min(ceiling);
            }
        }
        (start, end)
    }

    /// The voice found for each line of a scan (or the one line of a hooked line), with why.
    ///
    /// A scan is one voice: the line that matches by the most words gets it, and so does a line
    /// that matches the speech right next to it (a text box read as two blocks), but a name box
    /// never does. Without a match, timing gives it to the scan's main line (`main_line`).
    fn unit_outcomes(&mut self, ring: &AudioRing, unit: &[Line], main: usize, previous: Option<&Line>, from: f64, to: f64) -> Vec<(Outcome, String)> {
        let held_from = ring.start_ms().unwrap_or(f64::INFINITY);
        if unit[main].anchor().max(from) < held_from && unit[main].ts < held_from {
            let gone = Outcome::Missed("The line is older than the audio kept.".into());
            return unit.iter().map(|_| (gone.clone(), "its audio is no longer held".to_string())).collect();
        }
        let claimed = self.claimed(unit);
        let stretches = if to > from { self.heard(from, to, &claimed) } else { Vec::new() };
        // Every block of the scan is looked for. One that looks like a name box (short, no
        // punctuation: `speaking_lines`) may still be what is said, or a name inside the words,
        // or noise the OCR picked up: it needs strong evidence of its own (`said_aside`).
        let speaks = speaking_lines(unit);
        let mut candidates: Vec<(usize, Match)> = (0..unit.len())
            .filter_map(|i| self.matched(&unit[i], &stretches, from, to).map(|m| (i, m)))
            .filter(|(i, m)| speaks[*i] || said_aside(&unit[*i], m))
            .collect();
        // Most letters heard first; of equals, the one that reads like dialogue.
        candidates.sort_by(|(a, x), (b, y)| {
            matched_letters(&unit[*b], y).total_cmp(&matched_letters(&unit[*a], x)).then(speaks[*b].cmp(&speaks[*a]))
        });
        let debug = std::env::var_os("KIMOCHI_SENTENCE_AUDIO_DEBUG").is_some();
        if debug {
            let heard: Vec<String> = stretches.iter().map(|s| format!("{:.2}-{:.2} {}", s.start_ms / 1000.0, s.end_ms / 1000.0, s.text())).collect();
            let found: Vec<_> = candidates.iter().map(|(i, m)| (unit[*i].uid.as_str(), m.score, m.heard.as_str())).collect();
            eprintln!(
                "[sentence-audio] {:?}: window {:.2}-{:.2}, anchor {:.2}, heard {heard:?}, matches {found:?}",
                unit.iter().map(|l| (&l.uid, &l.text)).collect::<Vec<_>>(),
                from / 1000.0,
                to / 1000.0,
                unit[main].anchor() / 1000.0,
            );
        }
        // The voices heard in the scan: each the speech of one or more of its blocks (a box read
        // as two blocks shares one voice; boxes said apart each have their own).
        struct Voiced {
            start: f64,
            end: f64,
            lines: Vec<(usize, Match)>,
        }
        let mut voices: Vec<Voiced> = Vec::new();
        for (i, m) in candidates {
            // The same words as a block that matched better.
            if voices.iter().flat_map(|v| &v.lines).any(|(_, o)| overlap(o, &m) > SAME_VOICE) {
                continue;
            }
            // Words of its own, not a syllable that happens to be in the speech.
            let letters = matched_letters(&unit[i], &m);
            let substantial = letters >= MIN_MATCHED_LOOSE || (m.score >= FINAL_SCORE && letters >= MIN_OPENING);
            let (s, e) = self.around_match(&unit[i], &m, &stretches, from, to);
            let first = voices.is_empty();
            // Next to a voice: the rest of the same box, unless the part said first ends its
            // sentence (two boxes said one after the other).
            let continues = |v: &Voiced| {
                let said_first = if m.start_ms < v.start {
                    &unit[i].text
                } else {
                    let (k, _) = v.lines.iter().max_by(|a, b| a.1.end_ms.total_cmp(&b.1.end_ms)).unwrap();
                    &unit[*k].text
                };
                !ends_sentence(said_first)
            };
            match voices.iter_mut().find(|v| m.start_ms <= v.end + EXTEND_GAP_MS && m.end_ms >= v.start - EXTEND_GAP_MS && continues(v)) {
                Some(voice) if substantial => {
                    (voice.start, voice.end) = (voice.start.min(s), voice.end.max(e));
                    voice.lines.push((i, m));
                }
                Some(_) => {}
                None if first || substantial => voices.push(Voiced { start: s, end: e, lines: vec![(i, m)] }),
                None => {}
            }
        }
        let mut outcomes = vec![(Outcome::Silent, String::new()); unit.len()];
        if let Some(first) = voices.first() {
            let best = first.lines[0].0;
            for voice in &voices {
                if debug {
                    eprintln!("[sentence-audio] {}: matched, cut {:.2}-{:.2}", unit[voice.lines[0].0].uid, voice.start / 1000.0, voice.end / 1000.0);
                }
                for (i, m) in &voice.lines {
                    let note = format!("matched {:.0}% by its words: heard “{}”", m.score * 100.0, m.heard);
                    outcomes[*i] = (self.cut(voice.start, voice.end, How::Matched(m.clone())), note);
                }
            }
            for (i, outcome) in outcomes.iter_mut().enumerate() {
                if outcome.1.is_empty() {
                    outcome.1 = elsewhere(&unit[best].text, speaks[i]);
                }
            }
            return outcomes;
        }
        // The same text as a line already matched (scanned again): its voice.
        for (i, line) in unit.iter().enumerate().filter(|(i, _)| speaks[*i]) {
            if let Some(voice) = self.same_text(line, unit, held_from) {
                outcomes[i] = (Outcome::Voiced(voice), "the same text as the scan just before: its voice".into());
                for (k, other) in outcomes.iter_mut().enumerate().filter(|(k, _)| *k != i) {
                    other.1 = elsewhere(&unit[i].text, speaks[k]);
                }
                return outcomes;
            }
        }
        let heard_text: String = stretches.iter().map(|s| s.text()).collect::<Vec<_>>().join(" ");
        outcomes[main] = self.timed(&unit[main], previous, from, to, &stretches, &heard_text);
        for (i, outcome) in outcomes.iter_mut().enumerate() {
            if i != main {
                outcome.1 = elsewhere(&unit[main].text, speaks[i]);
            }
        }
        outcomes
    }

    /// Where `line` was heard, when the match is good enough to trust. An OCR'd line was on screen
    /// when it was read, so its voice started by then (give or take a voice that lags its text):
    /// a match starting later is someone else's words, and the line is looked for again in only
    /// the speech that started by then and what runs on from it.
    fn matched(&self, line: &Line, stretches: &[Heard], from: f64, to: f64) -> Option<Match> {
        let latest = line.ts + LEAD_MS;
        let letters = matching::fold(&line.text).0.len() as f64;
        let m = if line.ocr {
            let mut usable: Vec<Heard> = Vec::new();
            for s in stretches {
                let runs_on = usable.last().is_some_and(|l| s.start_ms - l.end_ms <= RUNS_ON_MS);
                if s.start_ms > latest && !runs_on {
                    break;
                }
                usable.push(s.clone());
            }
            let m = matching::find_near(&line.text, &usable, from, to, line.anchor())?;
            if m.start_ms <= latest {
                m
            } else {
                // Its words were heard only in what followed: look in what had started by then.
                usable.retain(|s| s.start_ms <= latest);
                matching::find_near(&line.text, &usable, from, to, line.anchor()).filter(|m| m.start_ms <= latest)?
            }
        } else {
            matching::find_near(&line.text, stretches, from, to, line.anchor())?
        };
        let matched = m.score * letters;
        // One letter heard is chance, not the line (unless the line is one letter).
        if matched < letters.min(2.0) {
            return None;
        }
        // A voice cut short (the player clicked on) matches only the line's opening words.
        let opening = m.from_line_start && matched >= MIN_OPENING;
        (m.score >= MIN_SCORE || (m.score >= MIN_SCORE_LOOSE && matched >= MIN_MATCHED_LOOSE) || opening).then_some(m)
    }

    /// For a line scanned with no match by its words: the speech playing as it was scanned, or the
    /// last to end shortly before (and the speech running into it), when most of what was heard
    /// there is in the line. The recogniser misheard it (kana for kanji, a word it did not know),
    /// but it was this line's voice. (start, end, what was heard).
    fn misheard(&self, line: &Line, stretches: &[Heard]) -> Option<(f64, f64, String)> {
        let last = stretches.iter().rposition(|s| s.start_ms <= line.ts && s.end_ms >= line.ts - MISHEARD_RECENT_MS)?;
        let mut first = last;
        while first > 0 && stretches[first].start_ms - stretches[first - 1].end_ms <= EXTEND_GAP_MS {
            first -= 1;
        }
        let heard: String = stretches[first..=last].iter().map(|s| s.text()).collect();
        let (said, text) = (matching::fold(&heard).0, matching::fold(&line.text).0);
        let shared = common(&said, &text);
        let enough = shared >= MISHEARD_MIN_CHARS && shared as f64 >= said.len() as f64 * MISHEARD_SHARE;
        enough.then(|| (stretches[first].start_ms, stretches[last].end_ms, heard))
    }

    /// The speech other lines' matches hold: what they were heard saying is not this line's.
    fn claimed(&self, unit: &[Line]) -> Vec<Span> {
        self.states
            .iter()
            .filter(|(uid, _)| !unit.iter().any(|l| &l.uid == *uid))
            .filter_map(|(_, s)| match s.decision.as_ref().map(|d| &d.outcome) {
                Some(Outcome::Voiced(Voice { how: How::Matched(m), .. })) => Some(Span { start: m.heard_from_ms, end: m.heard_to_ms + 1.0 }),
                _ => None,
            })
            .collect()
    }

    /// The voice of a line of the scan just before with the same text, matched by its words,
    /// while its audio is still held: a line scanned twice is one presentation.
    fn same_text(&self, line: &Line, unit: &[Line], held_from: f64) -> Option<Voice> {
        let text = matching::fold(&line.text).0;
        if text.len() < 2 {
            return None;
        }
        // Only the scan just before: the same text scanned again. Further back, the same words
        // ("はい") may be said again by someone else.
        let before = self.lines.iter().rev().find(|l| l.ts <= line.ts && !unit.iter().any(|u| u.uid == l.uid))?;
        let previous = |l: &Line| l.uid == before.uid || (before.scan.is_some() && l.scan == before.scan);
        self.lines.iter().rev().filter(|l| previous(l)).find_map(|l| {
            match self.decision(&l.uid).map(|d| &d.outcome) {
                Some(Outcome::Voiced(v)) if matches!(v.how, How::Matched(_)) && v.from_ms >= held_from && matching::fold(&l.text).0 == text => {
                    Some(v.clone())
                }
                _ => None,
            }
        })
    }

    /// The clip for speech from `from` to `to`: padded, with the user's offsets.
    fn cut(&self, from: f64, to: f64, how: How) -> Outcome {
        let cutting = self.cutting;
        let start = from - trim::PAD_BEFORE_MS + cutting.start_offset_ms;
        let end = (to + trim::PAD_AFTER_MS + cutting.end_offset_ms).min(start + cutting.max_clip_ms);
        Outcome::Voiced(Voice { from_ms: start, to_ms: end.max(start), how })
    }

    /// `line`'s voice by timing alone, with why.
    fn timed(&self, line: &Line, previous: Option<&Line>, from: f64, to: f64, stretches: &[Heard], heard: &str) -> (Outcome, String) {
        let cutting = self.cutting;
        let unmatched = if heard.is_empty() { "nothing was heard".to_string() } else { format!("no match in “{}”", short(heard)) };
        // An OCR'd line not seen appearing may have been scanned long after its voice: with the
        // recogniser listening and no match, its voice was not heard (yet: tried again as more
        // is); without it, only speech under way when it was scanned is taken.
        let unanchored = line.ocr && line.appeared.is_none();
        if unanchored && self.recognising() {
            return match self.misheard(line, stretches) {
                Some((start, end, heard)) => {
                    (self.cut(start, end, How::Timed), format!("misheard as “{}”, which was playing as it was scanned", short(&heard)))
                }
                None => (Outcome::Silent, unmatched),
            };
        }
        let (from, to) = if unanchored {
            let at_scan = self.speech(line.ts - AT_SCAN_MS, line.ts);
            let (Some(mut start), Some(end)) = (
                at_scan.iter().map(|s| s.start).reduce(f64::min),
                at_scan.iter().map(|s| s.end).reduce(f64::max),
            ) else {
                return (Outcome::Silent, "no voice was under way when it was scanned".into());
            };
            let floor = from.max(line.ts - OCR_TIMED_LEAD_MS).max(previous.map_or(f64::NEG_INFINITY, |p| p.ts));
            // And the speech that ran into it: a line's voice pauses between its sentences.
            for before in self.speech(floor, start).iter().rev() {
                if start - before.end > RUN_INTO_MS {
                    break;
                }
                start = start.min(before.start);
            }
            (start.max(floor), end.max(floor))
        } else {
            (from, to.max(from))
        };
        let why = if self.recognising() { format!("{unmatched}; placed by timing") } else { "placed by timing (no speech model)".into() };
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
        if !unanchored {
            let floor = line.anchor() - EXTEND_LEAD_MS;
            let ceiling = if to.is_finite() { to - TAIL_MS } else { self.heard_until };
            speech.extend(self.bursts.iter().copied().filter(|b| b.start >= floor && b.start < ceiling && b.end <= to));
        }
        if self.vad.is_none() || !cutting.trim {
            if self.vad.is_some() && speech.is_empty() {
                return (Outcome::Silent, "no speech near it".into());
            }
            // No speech detection (or trimming off): the whole window.
            let voice = Voice {
                from_ms: from + cutting.start_offset_ms,
                to_ms: (to + cutting.end_offset_ms).min(from + cutting.max_clip_ms),
                how: How::Timed,
            };
            return (Outcome::Voiced(voice), "its whole window (no speech detection, or trimming off)".into());
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
            Some(voice) => (self.cut(from + voice.start, from + voice.end, How::Timed), why),
            None => (Outcome::Silent, "no speech near it".into()),
        }
    }
}

/// A line as the Log reports it (for tests and the lab).
pub fn line(uid: &str, text: &str, ts: f64, ocr: bool) -> Line {
    Line { uid: uid.into(), text: text.into(), ts, ocr, appeared: None, scan: None }
}

/// The lines of one OCR scan (adjacent: they arrive together), as ranges of `lines`; every other
/// line is a unit of its own.
fn units(lines: &[Line]) -> Vec<std::ops::Range<usize>> {
    let mut out: Vec<std::ops::Range<usize>> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        match out.last_mut() {
            Some(unit) if line.scan.is_some() && lines[unit.start].scan == line.scan => unit.end = i + 1,
            _ => out.push(i..i + 1),
        }
    }
    out
}

/// Which lines of a scan read like what is said: all of them, unless some look like dialogue and
/// the others like a name box beside it (short, with no punctuation). A lean, not a rule: a
/// name-like block that was clearly said gets its voice too (`said_aside`).
fn speaking_lines(unit: &[Line]) -> Vec<bool> {
    let name_like = |l: &Line| {
        unit.len() > 1
            && matching::fold(&l.text).0.len() <= NAME_LETTERS
            && !l.text.chars().any(|c| "。、！？!?…‥「」『』（）()―〜~,.，．♪".contains(c))
    };
    let names: Vec<bool> = unit.iter().map(name_like).collect();
    if names.iter().all(|n| *n) {
        vec![true; unit.len()]
    } else {
        names.iter().map(|n| !n).collect()
    }
}

/// The line of a scan most likely to be what is said: the longest that can be voiced, or when
/// every line is short and plain (a name box beside a name called out), the last: a name box
/// comes before what is said.
fn main_line(unit: &[Line]) -> usize {
    let speaks = speaking_lines(unit);
    if speaks.iter().all(|s| *s) && unit.len() > 1 && unit.iter().all(|l| matching::fold(&l.text).0.len() <= NAME_LETTERS) {
        return unit.len() - 1;
    }
    (0..unit.len()).max_by_key(|&i| (speaks[i], matching::fold(&unit[i].text).0.len())).unwrap_or(0)
}

/// Whether text ends a sentence (。！？…, or a closing quote after one).
fn ends_sentence(text: &str) -> bool {
    text.trim_end().trim_end_matches(['」', '』', '）', ')', '"']).ends_with(['。', '！', '？', '!', '?', '…', '‥', '.'])
}

/// Why a line of a scan has no voice of its own.
fn elsewhere(text: &str, speaks: bool) -> String {
    if speaks {
        format!("another line of the scan has the voice ({})", short(text))
    } else {
        format!("looks like a name box, and its words were not heard on their own (the voice went to {})", short(text))
    }
}

/// Whether a block that looks like a name box was said itself: nearly all of it heard, as it
/// appeared or was scanned (not in some earlier voice that happens to say the name).
fn said_aside(line: &Line, m: &Match) -> bool {
    m.score >= FINAL_SCORE && matched_letters(line, m) >= 2.0 && m.end_ms >= line.anchor() - MISHEARD_RECENT_MS
}

/// How many of the line's letters a match heard.
fn matched_letters(line: &Line, m: &Match) -> f64 {
    m.score * matching::fold(&line.text).0.len() as f64
}

/// How much two matches share, as a share of the shorter.
fn overlap(a: &Match, b: &Match) -> f64 {
    let shared = (a.end_ms.min(b.end_ms) - a.start_ms.max(b.start_ms)).max(0.0);
    shared / (a.end_ms - a.start_ms).min(b.end_ms - b.start_ms).max(1.0)
}

/// A match by words good enough never to be decided again.
fn is_final(outcome: &Outcome) -> bool {
    matches!(outcome, Outcome::Voiced(Voice { how: How::Matched(m), .. }) if m.score >= FINAL_SCORE)
}

/// Whether a line decided `before`, decided again, takes `now`. A match by words is kept unless
/// a clearly better one comes (more of the line heard; never once it is final), a clip is never
/// given up because its audio is no longer held, and a retry only ever brings a match.
fn replaces(before: &Outcome, now: &Outcome, retry: bool) -> bool {
    let matched = |o: &Outcome| match o {
        Outcome::Voiced(Voice { how: How::Matched(m), .. }) => Some(m.score),
        _ => None,
    };
    match (matched(before), matched(now)) {
        (Some(b), Some(n)) => b < FINAL_SCORE && n >= b + 0.05,
        (Some(_), None) => false,
        (None, Some(_)) => true,
        (None, None) => !retry && !(matches!(before, Outcome::Voiced(_)) && matches!(now, Outcome::Missed(_))),
    }
}

/// Text cut short for a note.
fn short(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= 24 {
        text.to_string()
    } else {
        chars[..24].iter().collect::<String>() + "…"
    }
}

pub use timeline::normalize;


#[cfg(test)]
mod tests {
    use super::*;
    use crate::sense_voice::HeardChar;

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

    /// A listener that is given what was heard (`say`), in place of the recogniser, over a
    /// minute of silent recording from 0.
    fn listening() -> (Listener, AudioRing) {
        let mut ring = AudioRing::new(1_000, 120.0);
        ring.push(0.0, 1_000, &vec![0.0; 100_000]);
        let mut listener = Listener::new(None, None);
        listener.given_transcripts = true;
        (listener, ring)
    }

    /// `text` heard from `at` ms, a character every 120 ms.
    fn say(listener: &mut Listener, at: f64, text: &str) {
        let chars: Vec<HeardChar> = text.chars().enumerate().map(|(i, ch)| HeardChar { ch, ms: at + i as f64 * 120.0 }).collect();
        let end = at + chars.len() as f64 * 120.0;
        listener.transcripts.push(Heard { start_ms: at, end_ms: end, chars });
        listener.transcribed_until = end;
        listener.heard_count += 1;
    }

    fn scanned(uid: &str, text: &str, ts: f64, scan: &str) -> Line {
        Line { scan: Some(scan.into()), ..line(uid, text, ts, true) }
    }

    fn matched(decision: Option<&Decision>) -> Option<(f64, f64)> {
        match decision.map(|d| &d.outcome) {
            Some(Outcome::Voiced(Voice { how: How::Matched(m), from_ms, to_ms })) => {
                assert!(m.score > 0.0);
                Some((*from_ms, *to_ms))
            }
            _ => None,
        }
    }

    #[test]
    fn a_scans_name_box_never_gets_the_voice_and_its_dialogue_does() {
        let (mut listener, ring) = listening();
        say(&mut listener, 10_000.0, "今日はいい天気ですね");
        // Scanned by hand a few seconds after the voice: the name box and the dialogue, together.
        listener.line(scanned("name", "シーア", 14_000.0, "s1"));
        listener.line(scanned("said", "今日はいい天気ですね。", 14_000.0, "s1"));
        listener.tick(&ring, 20_000.0);
        let voice = matched(listener.decision("said")).expect("the dialogue matched by its words");
        assert!(voice.0 < 10_000.0 && voice.1 > 11_000.0, "{voice:?}");
        assert_eq!(listener.decision("name").unwrap().outcome, Outcome::Silent);
        assert!(listener.note("name").unwrap().contains("name box"), "{:?}", listener.note("name"));
    }

    #[test]
    fn every_box_of_a_scan_that_was_said_gets_its_own_voice() {
        let (mut listener, ring) = listening();
        // Two speakers' boxes on screen at once (or a short subtitle beside another): said apart.
        say(&mut listener, 10_000.0, "今日はいい天気ですね");
        say(&mut listener, 12_600.0, "ありがとう");
        listener.line(scanned("long", "今日はいい天気ですね。", 14_000.0, "s1"));
        listener.line(scanned("short", "ありがとう", 14_000.0, "s1"));
        listener.line(scanned("noise", "MENU", 14_000.0, "s1"));
        listener.tick(&ring, 20_000.0);
        let (long, short) = (matched(listener.decision("long")).unwrap(), matched(listener.decision("short")).unwrap());
        assert!(long.1 < 12_600.0 && short.0 > 11_500.0, "each its own voice: {long:?} {short:?}");
        assert_eq!(listener.decision("noise").unwrap().outcome, Outcome::Silent);
    }

    #[test]
    fn a_name_box_is_not_voiced_by_the_name_said_in_the_dialogue_or_long_before() {
        let (mut listener, ring) = listening();
        say(&mut listener, 2_000.0, "フリッツ先生このお店ですか");
        say(&mut listener, 10_000.0, "シーアおはよう");
        listener.line(scanned("name", "シーア", 12_000.0, "s1"));
        listener.line(scanned("said", "シーア、おはよう！", 12_000.0, "s1"));
        listener.tick(&ring, 18_000.0);
        assert!(matched(listener.decision("said")).is_some());
        assert_eq!(listener.decision("name").unwrap().outcome, Outcome::Silent, "the name is the dialogue's");
        // A name box whose dialogue was not heard: the name was said, but 18 s before.
        listener.line(scanned("name2", "フリッツ", 20_000.0, "s2"));
        listener.line(scanned("said2", "……", 20_000.0, "s2"));
        listener.tick(&ring, 30_000.0);
        assert!(matched(listener.decision("name2")).is_none(), "{:?}", listener.decision("name2"));
    }

    #[test]
    fn the_same_words_said_again_are_not_the_earlier_lines_voice() {
        let (mut listener, ring) = listening();
        say(&mut listener, 10_000.0, "はい");
        listener.line(scanned("first", "はい", 11_000.0, "s1"));
        listener.tick(&ring, 16_000.0);
        assert!(matched(listener.decision("first")).is_some());
        listener.line(scanned("between", "行きましょう。", 18_000.0, "s2"));
        // Someone says "はい" again later, and the recogniser mishears it.
        say(&mut listener, 24_000.0, "ない");
        listener.line(scanned("again", "はい", 25_000.0, "s3"));
        listener.tick(&ring, 32_000.0);
        assert!(!matches!(listener.decision("again").unwrap().outcome, Outcome::Voiced(_)), "{:?}", listener.decision("again"));
    }

    #[test]
    fn a_match_is_kept_as_later_lines_arrive() {
        let (mut listener, ring) = listening();
        say(&mut listener, 10_000.0, "今日はいい天気ですね");
        listener.line(scanned("name", "シーア", 12_000.0, "s1"));
        listener.line(scanned("said", "今日はいい天気ですね。", 12_000.0, "s1"));
        listener.tick(&ring, 18_000.0);
        let first = listener.decision("said").cloned().unwrap();
        assert!(matched(Some(&first)).is_some() && !first.provisional, "a whole match is final: {first:?}");
        // The next line says some of the same words; then more lines come.
        say(&mut listener, 19_000.0, "天気がいいから散歩しよう");
        listener.line(scanned("name2", "フリッツ", 21_000.0, "s2"));
        listener.line(scanned("next", "天気がいいから散歩しよう。", 21_000.0, "s2"));
        let decisions = listener.tick(&ring, 30_000.0);
        assert!(decisions.iter().all(|d| d.uid != "said"), "{decisions:?}");
        assert_eq!(listener.decision("said"), Some(&first));
        let next = matched(listener.decision("next")).unwrap();
        assert!(next.0 > 18_000.0, "its own voice, not the first line's: {next:?}");
        assert_eq!(listener.decision("name2").unwrap().outcome, Outcome::Silent);
    }

    #[test]
    fn a_line_scanned_while_its_voice_plays_is_matched_once_the_rest_is_heard() {
        let (mut listener, ring) = listening();
        // Scanned at 10.6 s: only the line's first words are heard by then, and the recogniser
        // makes nothing of them.
        say(&mut listener, 10_000.0, "ええと");
        listener.line(scanned("said", "今日はいい天気ですね。散歩に行きましょう。", 10_600.0, "s1"));
        listener.tick(&ring, 16_000.0);
        assert_eq!(listener.decision("said").unwrap().outcome, Outcome::Silent);
        // The rest of the voice is transcribed: tried again, and matched.
        say(&mut listener, 10_500.0, "今日はいい天気ですね散歩に行きましょう");
        let decisions = listener.tick(&ring, 17_000.0);
        assert!(decisions.iter().any(|d| d.uid == "said"));
        assert!(matched(listener.decision("said")).is_some(), "{:?}", listener.decision("said"));
        // Nothing more to hear: not decided again.
        assert!(listener.tick(&ring, 18_000.0).is_empty());
    }

    #[test]
    fn a_voice_that_starts_after_the_scan_is_not_the_scanned_lines() {
        let (mut listener, ring) = listening();
        listener.line(scanned("said", "はい", 10_000.0, "s1"));
        // The next line's voice, after the player moved on: it says "はい" too.
        say(&mut listener, 13_000.0, "はいそうです");
        listener.tick(&ring, 20_000.0);
        assert!(matched(listener.decision("said")).is_none(), "{:?}", listener.decision("said"));
    }

    #[test]
    fn a_fuller_reading_takes_the_place_of_the_partial_one() {
        let (mut listener, ring) = listening();
        say(&mut listener, 10_000.0, "今日はいい天気ですね散歩に行きましょう");
        listener.line(scanned("part", "今日はいい天気", 11_000.0, "s1"));
        listener.tick(&ring, 11_500.0);
        // The Log swaps the partial line for the fuller reading.
        listener.forget(&["part".to_string()]);
        listener.line(scanned("full", "今日はいい天気ですね。散歩に行きましょう。", 12_500.0, "s2"));
        listener.tick(&ring, 20_000.0);
        assert!(listener.decision("part").is_none());
        let voice = matched(listener.decision("full")).unwrap();
        assert!(voice.1 > 12_000.0, "the whole voice: {voice:?}");
    }

    #[test]
    fn a_line_scanned_again_gets_the_voice_it_had() {
        let (mut listener, ring) = listening();
        say(&mut listener, 10_000.0, "今日はいい天気ですね");
        listener.line(scanned("first", "今日はいい天気ですね。", 12_000.0, "s1"));
        listener.tick(&ring, 18_000.0);
        let first = matched(listener.decision("first")).unwrap();
        // The same text scanned again later: its words are the first line's, so it shares them.
        listener.line(scanned("again", "今日はいい天気ですね。", 19_000.0, "s2"));
        listener.tick(&ring, 30_000.0);
        match &listener.decision("again").unwrap().outcome {
            Outcome::Voiced(v) => assert_eq!((v.from_ms, v.to_ms), first),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_scans_main_line_is_its_dialogue() {
        let unit = |texts: &[&str]| -> Vec<Line> { texts.iter().enumerate().map(|(i, t)| scanned(&i.to_string(), t, 0.0, "s")).collect() };
        assert_eq!(main_line(&unit(&["シーア", "はいっ！"])), 1);
        assert_eq!(main_line(&unit(&["フリッツ", "今日はいい天気ですね"])), 1);
        assert_eq!(main_line(&unit(&["マティアス", "フリッツ"])), 1, "a name called out, beside the name box");
        assert_eq!(speaking_lines(&unit(&["シーア", "はいっ！"])), vec![false, true]);
        assert_eq!(speaking_lines(&unit(&["今日はいい天気ですね。", "散歩に行きましょう。"])), vec![true, true]);
        assert_eq!(speaking_lines(&unit(&["はい"])), vec![true]);
    }

    #[test]
    fn a_wordless_line_beside_a_name_box_is_seen_appearing() {
        let mut screen = Screen::default();
        screen.observed("シーア 前の台詞です。", 1_000.0);
        screen.observed("フリッツ …", 2_000.0);
        screen.observed("フリッツ …！", 2_200.0);
        assert_eq!(screen.appeared("…！", 3_000.0), Some(2_000.0));
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
