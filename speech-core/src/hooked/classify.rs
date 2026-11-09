//! Which hooked clips are the voice, and which clip is each line's.
//!
//! Engines often open a new buffer, voice or source for every sound, so clips are judged in groups
//! (adapter, format, channel or the source's folder). A group is scored from what is known without
//! listening: names and channels (`voice`, `vo_`, `koe`, `ボイス` vs `bgm`, `se_`...), looping, clip
//! lengths, mono, and, with lines, how often its clips start just after a line appears (the
//! strongest signal: a VN starts the voice with the line).
use super::HookClip;
use crate::timeline::Line;
use serde::Serialize;
use std::collections::BTreeMap;

/// How long before a line's anchor its voice may start (the hook and the text hook see the same
/// moment from two sides), and before an OCR line with no appearance time (read late). Live
/// AdvHD and SiglusEngine voices start ~330 ms before the text hook delivers the line, now and
/// then 500-640 ms: the window starts at `LEAD_MS` and learns, down to `MIN_LEAD_MS`.
pub const LEAD_MS: f64 = 700.0;
pub const MIN_LEAD_MS: f64 = 400.0;
pub const OCR_LEAD_MS: f64 = 1600.0;
/// The lead never goes past this, however early a game's voices start before its text arrives.
pub const MAX_LEAD_MS: f64 = 1500.0;
/// How long after a line's anchor its voice may start, before the window adapts.
pub const LAG_MS: f64 = 1500.0;
/// The window's lag never goes past this, however late a game starts its voices.
pub const MAX_LAG_MS: f64 = 4000.0;

const VOICE_WORDS: &[&str] = &[
    "voice",
    "/vo/",
    "vo_",
    "_vo",
    "koe",
    "/v/",
    "voc_",
    "vox",
    "serif",
    "セリフ",
    "ボイス",
    "音声",
];
const NOT_VOICE_WORDS: &[&str] = &[
    "bgm", "music", "/bgs", "bgs_", "/me/", "/se/", "se_", "se0", "se1", "sfx", "sound/",
    "ambient", "amb_", "jingle", "/sys", "system", "click", "cursor", "decision", "buzzer",
    "cancel",
];

/// +1 when a name says voice, -1 when it says music or effects, 0 when it says nothing.
pub fn name_says(s: &str) -> i32 {
    let l = s.to_lowercase().replace('\\', "/");
    if VOICE_WORDS.iter().any(|w| l.contains(w)) {
        1
    } else if NOT_VOICE_WORDS.iter().any(|w| l.contains(w)) {
        -1
    } else {
        0
    }
}

pub(crate) fn clip_name(c: &HookClip) -> String {
    format!(
        "{} {}",
        c.source.as_deref().unwrap_or(""),
        c.channel.as_deref().unwrap_or("")
    )
}

/// How long before `line`'s anchor its voice may start, with `lead` the window's (learned) lead.
pub fn lead(line: &Line, lead: f64) -> f64 {
    if line.ocr && line.appeared.is_none() {
        OCR_LEAD_MS.max(lead)
    } else {
        lead
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub group: String,
    /// 0..1: how likely the group is the voice.
    pub voice: f64,
    pub clips: usize,
    pub median_dur: f64,
    /// Its clips' names or channel say voice (no listening needed to trust it).
    pub named: bool,
    pub reasons: Vec<String>,
}

fn median(mut v: Vec<f64>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn near(start: f64, windows: &[(f64, f64, f64)]) -> bool {
    windows
        .iter()
        .any(|(a, lead, lag)| start >= a - lead && start <= a + lag)
}

/// Scores every group of `clips`. Higher `voice` = more likely the voice.
pub fn classify(clips: &[HookClip], lines: &[Line], lead_ms: f64, lag: f64) -> Vec<Verdict> {
    let mut by: BTreeMap<String, Vec<&HookClip>> = BTreeMap::new();
    for c in clips {
        by.entry(c.group()).or_default().push(c);
    }
    let windows: Vec<(f64, f64, f64)> = lines.iter().map(|l| (l.anchor(), lead(l, lead_ms), lag)).collect();
    let mut out = Vec::new();
    for (group, clips) in by {
        let mut logit = -0.5f64;
        let mut reasons = Vec::new();
        let n = clips.len() as f64;
        let says: Vec<i32> = clips.iter().map(|c| name_says(&clip_name(c))).collect();
        let yes = says.iter().filter(|s| **s > 0).count() as f64 / n;
        let no = says.iter().filter(|s| **s < 0).count() as f64 / n;
        let named = yes > 0.5;
        if named {
            logit += 4.0;
            reasons.push("named voice".into());
        } else if no > 0.5 {
            logit -= 4.0;
            reasons.push("named music/effects".into());
        }
        if clips.iter().filter(|c| c.looping).count() as f64 / n > 0.5 {
            logit -= 3.0;
            reasons.push("loops".into());
        }
        let med = median(clips.iter().map(|c| c.dur).filter(|d| *d > 0.0).collect());
        if med > 30.0 {
            logit -= 3.0;
            reasons.push(format!("long clips (median {med:.0} s)"));
        } else if med > 0.0 && med < 0.6 {
            logit -= 1.5;
            reasons.push(format!("short clips (median {med:.2} s)"));
        } else if (1.2..=12.0).contains(&med) {
            logit += 0.5;
        }
        if clips
            .iter()
            .filter(|c| c.fmt.as_deref().is_some_and(|f| f.contains("1ch")))
            .count() as f64
            / n
            > 0.5
        {
            logit += 0.7;
            reasons.push("mono".into());
        }
        if !windows.is_empty() {
            let rate = clips.iter().filter(|c| near(c.start, &windows)).count() as f64 / n;
            let covered = windows
                .iter()
                .filter(|w| clips.iter().any(|c| near(c.start, &[**w])))
                .count();
            let cover = covered as f64 / windows.len() as f64;
            // A group of one or two clips says little either way.
            let weight = (n / 3.0).min(1.0);
            logit += weight * (6.0 * (rate - 0.4) + 3.0 * cover);
            reasons.push(format!(
                "{:.0}% start with a line, {:.0}% of lines have one",
                rate * 100.0,
                cover * 100.0
            ));
        }
        out.push(Verdict {
            group,
            voice: 1.0 / (1.0 + (-logit).exp()),
            clips: clips.len(),
            median_dur: med,
            named,
            reasons,
        });
    }
    out.sort_by(|a, b| b.voice.partial_cmp(&a.voice).unwrap());
    out
}

/// Groups taken as voice: above 0.55, or the best one if it clearly leads and is above 0.3.
pub fn voice_groups(verdicts: &[Verdict]) -> Vec<String> {
    let mut v: Vec<String> = verdicts
        .iter()
        .filter(|x| x.voice > 0.55)
        .map(|x| x.group.clone())
        .collect();
    if v.is_empty() {
        if let Some(best) = verdicts.first().filter(|b| b.voice >= 0.3) {
            if verdicts.get(1).is_none_or(|s| best.voice - s.voice > 0.15) {
                v.push(best.group.clone());
            }
        }
    }
    v
}

/// A clip that can be a line's voice: in a voice group, not named music/effects, not a loop.
pub fn candidate(c: &HookClip, voice: &[String]) -> bool {
    voice.contains(&c.group()) && name_says(&clip_name(c)) >= 0 && !c.looping
}

/// `text` opens a quote near its start (after a speaker's name, at most).
pub fn opens_quote(text: &str) -> bool {
    text.chars().take(16).any(|c| c == '「' || c == '『')
}

/// Voiced lines are quotes, mostly: of a quote and a narration row near the same voice, the quote
/// takes it unless the row is clearly closer (live KiriKiri: a narration row typed out just
/// after a quote took the quote's voice by 87 ms). Voiced narration with no quote near still pairs.
pub const UNQUOTED_MS: f64 = 300.0;
fn unquoted(line: &Line) -> f64 {
    if opens_quote(&line.text) {
        0.0
    } else {
        UNQUOTED_MS
    }
}

/// Pairs lines with candidate clips starting in `[anchor - lead, anchor + lag]`, nearest first
/// (a start before the line costs double; a very short clip loses to a line-length one), each
/// clip and each line used once. Returns, per line, the index into `clips` and the offset.
pub fn pair(lines: &[Line], clips: &[&HookClip], lead_ms: f64, lag: f64) -> Vec<Option<(usize, f64)>> {
    let mut pairs: Vec<(f64, usize, usize, f64)> = Vec::new();
    for (li, l) in lines.iter().enumerate() {
        let (a, lead) = (l.anchor(), lead(l, lead_ms));
        for (ci, c) in clips.iter().enumerate() {
            let d = c.start - a;
            if (-lead..=lag).contains(&d) {
                let short = if c.dur > 0.0 && c.dur < 0.8 {
                    700.0
                } else {
                    0.0
                };
                pairs.push((if d < 0.0 { -d * 2.0 } else { d } + short + unquoted(l), li, ci, d));
            }
        }
    }
    pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut out = vec![None; lines.len()];
    let mut used = vec![false; clips.len()];
    for (_, li, ci, d) in pairs {
        if out[li].is_none() && !used[ci] {
            out[li] = Some((ci, d));
            used[ci] = true;
        }
    }
    out
}
