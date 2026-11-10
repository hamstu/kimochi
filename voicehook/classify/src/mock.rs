//! Synthetic captures with known answers, shaped after what the real engines did:
//! - `advhd`: a new XAudio2 voice per line (mono float, no names), SE in the same format, BGM.
//! - `siglus`: a new DirectSound ring per sound, plus a long mono ambience loop.
//! - `unity`: clip names (`v01-03` voices, numbered SE, `Bgm04`).
//! - `renpy`: channel names (`voice`, `music`, `sound`) and file paths.
//! - `ocr`: like `advhd`, but lines arrive late (OCR) and carry no `appeared` time.
//!
//! Each scene has narration lines without voice, lines skipped mid-voice, and SE near lines.
use crate::{Capture, Clip, Line};
use std::collections::HashMap;

pub struct Scene {
    pub name: &'static str,
    pub capture: Capture,
    pub lines: Vec<Line>,
    /// uid → the seq of its voice clip (None: an unvoiced line).
    pub truth: HashMap<String, Option<u64>>,
    /// Seqs of the clips that are speech.
    pub speech: std::collections::HashSet<u64>,
}

impl Scene {
    /// A stand-in for VAD/SenseVoice: right about speech, but unsure (None) one time in eight.
    pub fn oracle(&self, c: &Clip) -> Option<f64> {
        if c.seq % 8 == 3 {
            return None;
        }
        Some(if self.speech.contains(&c.seq) { 0.85 } else { 0.05 })
    }
}

struct Rng(u64);
impl Rng {
    fn f(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.f()
    }
}

pub const SCENES: &[&str] = &["advhd", "siglus", "unity", "renpy", "ocr"];

pub fn scene(name: &'static str, seed: u64) -> Scene {
    let mut r = Rng(seed * 7919 + name.len() as u64);
    let mut clips: Vec<Clip> = Vec::new();
    let mut lines = Vec::new();
    let mut truth = HashMap::new();
    let mut speech = std::collections::HashSet::new();
    let (mut seq, mut stream) = (0u64, 0u64);
    let t0 = 1_800_000_000_000.0;
    let mut add = |clips: &mut Vec<Clip>, stream: u64, start: f64, dur: f64, api: &str, fmt: &str, source: Option<String>, channel: Option<&str>, looping: bool| {
        seq += 1;
        clips.push(Clip {
            seq,
            stream,
            api: api.into(),
            start,
            dur,
            file: Some(format!("clips/{seq:05}.wav")),
            source,
            fmt: Some(fmt.into()),
            looping,
            channel: channel.map(str::to_string),
        });
        seq
    };
    let (api, vfmt) = match name {
        "unity" => ("unity", "float32 1ch 48000Hz"),
        "renpy" => ("renpy", "ogg"),
        "siglus" => ("dsound", "pcm16 1ch 44100Hz"),
        _ => ("xaudio2.9", "float32 1ch 44100Hz"),
    };
    let named = matches!(name, "unity" | "renpy");
    // BGM, and Siglus's ambience loop.
    stream += 1;
    let bgm_src = named.then(|| if name == "renpy" { "audio/bgm/town.ogg".to_string() } else { "Bgm04".to_string() });
    add(&mut clips, stream, t0 + 500.0, 95.0, api, if name == "renpy" { "ogg" } else { "float32 2ch 48000Hz" }, bgm_src, (name == "renpy").then_some("music"), true);
    if name == "siglus" {
        stream += 1;
        add(&mut clips, stream, t0 + 2000.0, 40.0, api, vfmt, None, None, true);
    }
    let mut t = t0 + 3000.0;
    let mut voice_stream = 100;
    for i in 0..60 {
        t += r.range(2500.0, 7000.0);
        let uid = format!("L{i:03}");
        let late = if name == "ocr" { r.range(200.0, 1100.0) } else { r.range(0.0, 60.0) };
        let anchor = t;
        lines.push(Line { uid: uid.clone(), text: format!("line {i}"), ts: anchor + late, appeared: if name == "ocr" { None } else { Some(anchor) }, ocr: name == "ocr" });
        let voiced = r.f() < 0.7;
        if voiced {
            let start = anchor + r.range(30.0, 350.0);
            let dur = r.range(1.0, 8.5);
            // AdvHD/Siglus/Unity: a new voice/buffer/source per line; Ren'Py: one channel.
            let s = if name == "renpy" {
                7
            } else {
                voice_stream += 1;
                voice_stream
            };
            let src = match name {
                "unity" => Some(format!("v{:02}-{:02}", i / 10 + 1, i % 10 + 1)),
                "renpy" => Some(format!("voice/ch1/{i:04}.ogg")),
                _ => None,
            };
            let seqn = add(&mut clips, s, start, dur, api, vfmt, src, (name == "renpy").then_some("voice"), false);
            truth.insert(uid, Some(seqn));
            speech.insert(seqn);
        } else {
            truth.insert(uid, None);
        }
        // SE: sometimes right at the line (a door, a hit), same format as the voice where unnamed.
        if r.f() < 0.35 {
            voice_stream += 1;
            let start = anchor + r.range(-200.0, 900.0);
            let src = match name {
                "unity" => Some(format!("{}", (r.f() * 100.0) as u32)),
                "renpy" => Some(format!("audio/se/se_{:03}.ogg", (r.f() * 50.0) as u32)),
                _ => None,
            };
            let s = if name == "renpy" { 8 } else { voice_stream };
            add(&mut clips, s, start, r.range(0.2, 1.4), api, vfmt, src, (name == "renpy").then_some("sound"), false);
        }
    }
    clips.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap());
    Scene { name, capture: Capture { dir: Default::default(), clips }, lines, truth, speech }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct Score {
    pub voiced: usize,
    pub right: usize,
    pub wrong: usize,
    pub missed: usize,
    /// Unvoiced lines given a clip (an SE, or a neighbour's voice).
    pub false_claims: usize,
}

impl Score {
    pub fn precision(&self) -> f64 {
        let claimed = self.right + self.wrong + self.false_claims;
        if claimed == 0 { 1.0 } else { self.right as f64 / claimed as f64 }
    }
    pub fn recall(&self) -> f64 {
        if self.voiced == 0 { 1.0 } else { self.right as f64 / self.voiced as f64 }
    }
}

/// `with_lines`: lines also feed the classification (they always drive the matching).
/// `speech`: the oracle filters candidates, as VAD/SenseVoice would in the app.
pub fn evaluate(s: &Scene, with_lines: bool, speech: bool) -> Score {
    let lines_for_classify: &[Line] = if with_lines { &s.lines } else { &[] };
    let verdicts = crate::classify(&s.capture, lines_for_classify);
    let voice = crate::voice_groups(&verdicts);
    let mut score = Score::default();
    let oracle = |c: &Clip| s.oracle(c);
    for m in crate::match_lines_with(&s.capture, &voice, &s.lines, if speech { Some(&oracle) } else { None }) {
        let truth = s.truth[&m.uid];
        match (truth, m.clip.map(|c| c.seq)) {
            (Some(t), Some(g)) if t == g => score.right += 1,
            (Some(_), Some(_)) => score.wrong += 1,
            (Some(_), None) => score.missed += 1,
            (None, Some(_)) => score.false_claims += 1,
            (None, None) => {}
        }
        if truth.is_some() {
            score.voiced += 1;
        }
    }
    score
}

/// Scores summed over seeds 1..=n.
pub fn total(name: &'static str, n: u64, with_lines: bool, speech: bool) -> Score {
    let mut acc = Score::default();
    for seed in 1..=n {
        let x = evaluate(&scene(name, seed), with_lines, speech);
        acc.voiced += x.voiced;
        acc.right += x.right;
        acc.wrong += x.wrong;
        acc.missed += x.missed;
        acc.false_claims += x.false_claims;
    }
    acc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_a_speech_check_every_scene_is_right() {
        for name in SCENES {
            let sc = total(name, 10, true, true);
            assert!(sc.precision() >= 0.93 && sc.recall() >= 0.95, "{name}: {sc:?}");
        }
    }

    #[test]
    fn channel_names_alone_are_enough() {
        let sc = total("renpy", 10, true, false);
        assert!(sc.precision() >= 0.98 && sc.recall() >= 0.98, "{sc:?}");
    }

    #[test]
    fn timing_alone_keeps_recall_on_unnamed_engines() {
        for name in ["advhd", "siglus", "unity", "ocr"] {
            let sc = total(name, 10, true, false);
            assert!(sc.recall() >= 0.85 && sc.precision() >= 0.7, "{name}: {sc:?}");
        }
    }

    #[test]
    fn named_scenes_pick_their_voice_group_without_text() {
        for name in ["unity", "renpy"] {
            let s = scene(name, 3);
            let voice = crate::voice_groups(&crate::classify(&s.capture, &[]));
            assert_eq!(voice.len(), 1, "{name}: {voice:?}");
        }
    }

    #[test]
    fn loops_are_never_voice() {
        for name in SCENES {
            let s = scene(name, 2);
            for x in crate::classify(&s.capture, &s.lines).iter().filter(|x| x.reasons.iter().any(|r| r == "loops")) {
                assert!(x.voice < 0.5, "{name}: {x:?}");
            }
        }
    }
}
