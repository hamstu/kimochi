//! Voice classifier: which streams of a capture carry the voice, and which clip is each text
//! line's voice. Pure logic over a capture's `events.jsonl` (any adapter: the format is shared)
//! and the text hook's lines, shaped to drop into Kimochi's `sentence_audio` later:
//!
//! - `Capture::load` reads a capture; in the app, clips would arrive live instead.
//! - `classify` scores every stream from what is known without listening: names and paths
//!   (`voice/`, `vo_`, `koe`, `bgm`, `se_`...), the adapter's channel (`voice` in Ren'Py,
//!   `rpgm:voice`), format (mono vs stereo), looping, the clip length distribution, and, when text
//!   lines are given, how often its clips start right after a line appears (the strongest signal:
//!   a VN starts the voice with the line).
//! - `match_lines` gives each line the clip of a voice stream that starts nearest after its anchor
//!   (`Line::anchor`, as in `kimochi_speech::timeline`), each clip used once.
//! - `Confirm` is where `kimochi_speech` (SenseVoice) plugs in: it can transcribe a candidate and
//!   compare it with the line's text, to settle close calls. Not needed for a decision.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub mod mock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Clip {
    pub seq: u64,
    pub stream: u64,
    pub api: String,
    /// Unix ms the sound started.
    pub start: f64,
    pub dur: f64,
    pub file: Option<String>,
    pub source: Option<String>,
    pub fmt: Option<String>,
    pub looping: bool,
    /// Ren'Py channel / RPG Maker folder / Unity method..., when the adapter knows it.
    pub channel: Option<String>,
}

impl Clip {
    /// The group a clip is judged with: engines often open a new buffer/voice/source per sound,
    /// so streams alone are too fine. Adapter + format + channel (or the source's folder).
    pub fn group(&self) -> String {
        let folder =
            self.source.as_deref().and_then(|s| s.replace('\\', "/").rsplit_once('/').map(|(d, _)| d.to_string()));
        format!(
            "{} | {} | {}",
            self.api,
            self.fmt.as_deref().unwrap_or("?"),
            self.channel.clone().or(folder).unwrap_or_default()
        )
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Capture {
    pub dir: PathBuf,
    pub clips: Vec<Clip>,
}

/// A text-hook line, as `kimochi_speech::timeline::Line` has it (the fields used here).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Line {
    pub uid: String,
    pub text: String,
    /// Arrival, Unix ms.
    pub ts: f64,
    /// When its text began to appear, if known.
    #[serde(default)]
    pub appeared: Option<f64>,
    /// Read from the screen (OCR): it can arrive well after its voice began.
    #[serde(default)]
    pub ocr: bool,
}

impl Line {
    pub fn anchor(&self) -> f64 {
        self.appeared.unwrap_or(self.ts)
    }
    /// How long before the anchor its voice may start: an OCR line with no appearance time can
    /// be read a second or more after the voice began.
    pub fn lead(&self) -> f64 {
        if self.ocr && self.appeared.is_none() {
            OCR_LEAD_MS
        } else {
            LEAD_MS
        }
    }
}

impl Capture {
    pub fn load(dir: &Path) -> Result<Capture, String> {
        let text = std::fs::read_to_string(dir.join("events.jsonl")).map_err(|e| format!("{}: {e}", dir.display()))?;
        Ok(Capture { dir: dir.to_path_buf(), clips: parse_events(&text) })
    }
}

/// The audible clips in an events.jsonl.
pub fn parse_events(text: &str) -> Vec<Clip> {
    let mut clips = Vec::new();
    // Stream id → channel named at its creation (web adapter: rpgm:voice, howl, media).
    let mut stream_channel: BTreeMap<u64, String> = BTreeMap::new();
    for l in text.lines() {
        let Ok(e) = serde_json::from_str::<Value>(l) else { continue };
        if e["ev"] == "stream" {
            if let (Some(s), Some(c)) = (e["s"].as_u64(), e["info"]["channel"].as_str()) {
                stream_channel.insert(s, c.to_string());
            }
            continue;
        }
        if e["ev"] != "clip" || e["silent"].as_bool() == Some(true) {
            continue;
        }
        let meta = &e["meta"];
        let channel = meta["channel"]
            .as_str()
            .map(str::to_string)
            .or_else(|| e["s"].as_u64().and_then(|s| stream_channel.get(&s).cloned()));
        clips.push(Clip {
            seq: e["seq"].as_u64().unwrap_or(0),
            stream: e["s"].as_u64().unwrap_or(0),
            api: e["api"].as_str().unwrap_or("").into(),
            start: e["start"].as_f64().or(e["t"].as_f64()).unwrap_or(0.0),
            dur: e["dur"].as_f64().unwrap_or(0.0),
            file: e["file"].as_str().map(str::to_string),
            source: e["source"].as_str().map(str::to_string),
            fmt: e["fmt"].as_str().map(str::to_string),
            looping: e["looping"].as_bool().unwrap_or(false),
            channel,
        });
    }
    clips
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Verdict {
    /// `Clip::group()`.
    pub group: String,
    pub streams: Vec<u64>,
    /// 0..1: how likely this group is the voice.
    pub voice: f64,
    pub clips: usize,
    pub median_dur: f64,
    /// Fraction of its clips that start just after a line appears (None without lines).
    pub line_hits: Option<f64>,
    pub reasons: Vec<String>,
}

/// How long after a line's anchor its voice may start, and how early (the hook and the text hook
/// see the same moment from two sides; a line can also be reported a little late).
pub const LEAD_MS: f64 = 400.0;
pub const OCR_LEAD_MS: f64 = 1600.0;
pub const LAG_MS: f64 = 1500.0;

const VOICE_WORDS: &[&str] =
    &["voice", "/vo/", "vo_", "_vo", "koe", "/v/", "voc_", "vox", "serif", "セリフ", "ボイス", "音声"];
const NOT_VOICE_WORDS: &[&str] = &[
    "bgm", "music", "/bgs", "bgs_", "/me/", "/se/", "se_", "se0", "se1", "sfx", "sound/", "ambient", "amb_", "jingle",
    "/sys", "system", "click", "cursor", "decision", "buzzer", "cancel",
];

/// +1 when a name says voice, -1 when it says music/effects, 0 when it says nothing.
pub fn name_says(s: &str) -> (i32, Option<String>) {
    let l = s.to_lowercase().replace('\\', "/");
    if let Some(w) = VOICE_WORDS.iter().find(|w| l.contains(*w)) {
        return (1, Some(format!("name has '{w}'")));
    }
    if let Some(w) = NOT_VOICE_WORDS.iter().find(|w| l.contains(*w)) {
        return (-1, Some(format!("name has '{w}'")));
    }
    (0, None)
}

fn clip_name(c: &Clip) -> String {
    format!("{} {}", c.source.as_deref().unwrap_or(""), c.channel.as_deref().unwrap_or(""))
}

fn median(mut v: Vec<f64>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn near_line(start: f64, anchors: &[(f64, f64)]) -> bool {
    anchors.iter().any(|(a, lead)| start >= a - lead && start <= a + LAG_MS)
}

/// Scores every group of clips. Higher `voice` = more likely the voice.
pub fn classify(cap: &Capture, lines: &[Line]) -> Vec<Verdict> {
    let mut by: BTreeMap<String, Vec<&Clip>> = BTreeMap::new();
    for c in &cap.clips {
        by.entry(c.group()).or_default().push(c);
    }
    let anchors: Vec<(f64, f64)> = lines.iter().map(|l| (l.anchor(), l.lead())).collect();
    let mut out = Vec::new();
    for (group, clips) in by {
        let mut logit = -0.5f64;
        let mut reasons = Vec::new();
        let n = clips.len() as f64;
        // Names: the share of clips whose source/channel says voice or not-voice.
        let (mut yes, mut no, mut why_yes, mut why_no) = (0usize, 0usize, None, None);
        for c in &clips {
            match name_says(&clip_name(c)) {
                (1, w) => {
                    yes += 1;
                    why_yes = why_yes.or(w);
                }
                (-1, w) => {
                    no += 1;
                    why_no = why_no.or(w);
                }
                _ => {}
            }
        }
        if yes as f64 / n > 0.5 {
            logit += 4.0;
            reasons.push(why_yes.unwrap_or_default());
        } else if no as f64 / n > 0.5 {
            logit -= 4.0;
            reasons.push(why_no.unwrap_or_default());
        }
        // Looping is music or ambience.
        if clips.iter().filter(|c| c.looping).count() as f64 / n > 0.5 {
            logit -= 3.0;
            reasons.push("loops".into());
        }
        // Length: voice lines are ~0.6-20 s, most 1.5-10 s.
        let med = median(clips.iter().map(|c| c.dur).filter(|d| *d > 0.0).collect());
        if med > 30.0 {
            logit -= 3.0;
            reasons.push(format!("long clips (median {med:.0} s)"));
        } else if med > 0.0 && med < 0.6 {
            logit -= 1.5;
            reasons.push(format!("short clips (median {med:.2} s)"));
        } else if (1.2..=12.0).contains(&med) {
            logit += 0.5;
            reasons.push(format!("line-length clips (median {med:.1} s)"));
        }
        // Format: VN voice is almost always mono.
        let mono = clips.iter().filter(|c| c.fmt.as_deref().is_some_and(|f| f.contains("1ch"))).count() as f64 / n;
        if mono > 0.5 {
            logit += 0.7;
            reasons.push("mono".into());
        }
        // Lines: clips that start just after a line appears, and lines that got one.
        let mut line_hits = None;
        if !anchors.is_empty() {
            let rate = clips.iter().filter(|c| near_line(c.start, &anchors)).count() as f64 / n;
            let covered = anchors.iter().filter(|a| clips.iter().any(|c| near_line(c.start, &[**a]))).count();
            let cover = covered as f64 / anchors.len() as f64;
            line_hits = Some(rate);
            // A group with a single clip says little either way.
            let weight = (n / 3.0).min(1.0);
            logit += weight * (6.0 * (rate - 0.4) + 3.0 * cover);
            reasons.push(format!(
                "{:.0}% of clips start with a line, {:.0}% of lines have one",
                rate * 100.0,
                cover * 100.0
            ));
        }
        let mut streams: Vec<u64> = clips.iter().map(|c| c.stream).collect();
        streams.sort_unstable();
        streams.dedup();
        out.push(Verdict {
            group,
            streams,
            voice: 1.0 / (1.0 + (-logit).exp()),
            clips: clips.len(),
            median_dur: med,
            line_hits,
            reasons,
        });
    }
    out.sort_by(|a, b| b.voice.partial_cmp(&a.voice).unwrap());
    out
}

/// Groups taken as voice: above 0.55, or the best one if it clearly leads and is above 0.3.
pub fn voice_groups(verdicts: &[Verdict]) -> Vec<String> {
    let mut v: Vec<String> = verdicts.iter().filter(|x| x.voice > 0.55).map(|x| x.group.clone()).collect();
    if v.is_empty() {
        if let Some(best) = verdicts.first().filter(|b| b.voice >= 0.3) {
            if verdicts.get(1).is_none_or(|s| best.voice - s.voice > 0.15) {
                v.push(best.group.clone());
            }
        }
    }
    v
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LineMatch {
    pub uid: String,
    pub clip: Option<Clip>,
    /// Clip start minus line anchor, ms.
    pub offset_ms: Option<f64>,
}

/// Gives each line the nearest clip of a voice group starting in `[anchor - LEAD_MS,
/// anchor + LAG_MS]`, each clip used once; a clip whose own name says music/effects is never
/// taken. Lines without one (narration, skipped) get `None`.
pub fn match_lines(cap: &Capture, voice: &[String], lines: &[Line]) -> Vec<LineMatch> {
    match_lines_with(cap, voice, lines, None)
}

/// Per-clip speech score 0..1 (None: cannot tell): Kimochi's VAD (speech ratio) or SenseVoice.
pub type Speech<'a> = &'a dyn Fn(&Clip) -> Option<f64>;

/// `match_lines`, dropping candidates that `speech` says are not speech (< 0.3): an SE in the
/// voice's own format that starts right at a line is otherwise indistinguishable by timing.
pub fn match_lines_with(cap: &Capture, voice: &[String], lines: &[Line], speech: Option<Speech>) -> Vec<LineMatch> {
    let candidates: Vec<&Clip> = cap
        .clips
        .iter()
        .filter(|c| voice.contains(&c.group()) && name_says(&clip_name(c)).0 >= 0 && !c.looping)
        .filter(|c| speech.is_none_or(|f| f(c).is_none_or(|s| s >= 0.3)))
        .collect();
    let mut pairs: Vec<(f64, usize, usize)> = Vec::new();
    for (li, l) in lines.iter().enumerate() {
        let a = l.anchor();
        for (ci, c) in candidates.iter().enumerate() {
            let d = c.start - a;
            if (-l.lead()..=LAG_MS).contains(&d) {
                // Nearest start wins; a start before the line costs double; a very short clip
                // (a click, a door) loses to a line-length one in the same window.
                let short = if c.dur > 0.0 && c.dur < 0.8 { 700.0 } else { 0.0 };
                pairs.push((if d < 0.0 { -d * 2.0 } else { d } + short, li, ci));
            }
        }
    }
    pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut line_clip: Vec<Option<usize>> = vec![None; lines.len()];
    let mut used = vec![false; candidates.len()];
    for (_, li, ci) in pairs {
        if line_clip[li].is_none() && !used[ci] {
            line_clip[li] = Some(ci);
            used[ci] = true;
        }
    }
    lines
        .iter()
        .zip(line_clip)
        .map(|(l, ci)| LineMatch {
            uid: l.uid.clone(),
            clip: ci.map(|i| candidates[i].clone()),
            offset_ms: ci.map(|i| candidates[i].start - l.anchor()),
        })
        .collect()
}

/// Where speech recognition plugs in (Kimochi's SenseVoice): how well a clip's speech matches a
/// line's text, 0..1, or None when it cannot tell.
pub trait Confirm {
    fn similarity(&self, clip_file: &Path, text: &str) -> Option<f64>;
}

/// The voice clip for one line, as `sentence_audio` would ask for it: the matched clip, unless
/// `confirm` says its speech is clearly not the line (then None, and the app falls back to the
/// mixed recording).
pub fn voice_for_line(cap: &Capture, lines: &[Line], uid: &str, confirm: Option<&dyn Confirm>) -> Option<Clip> {
    let verdicts = classify(cap, lines);
    let m = match_lines(cap, &voice_groups(&verdicts), lines).into_iter().find(|m| m.uid == uid)?;
    let clip = m.clip?;
    if let (Some(c), Some(f)) = (confirm, clip.file.as_ref()) {
        let text = &lines.iter().find(|l| l.uid == uid)?.text;
        if c.similarity(&cap.dir.join(f), text).is_some_and(|s| s < 0.2) {
            return None;
        }
    }
    Some(clip)
}
