//! Which clip is a line's, by what is said in it: the recogniser's transcript of each clean clip
//! lined up against the line's text (`matching`), for lines the timing could not give a clip.
//!
//! Timing (`Hooked::tick`) pairs a line with a clip that starts just before or after it. When the
//! text arrives well after its voice (a line handed over late or in pieces, or a game whose text
//! waits for an animation) or a voice starts long after its line, the window misses it, and the
//! card falls back to the system recording (music and all). A clip's own words say whose it is,
//! however far it is from its line. A clean clip transcribes well (SenseVoice on SiglusEngine
//! voices: a line's own clip covers 56-100% of its characters, another line's rarely half), and
//! quickly (about 30 ms a second of speech on an ARM64 machine).
//!
//! A wrong voice on a card is worse than the system recording, so a clip is given by its words
//! only on clear evidence: enough of the line heard in it (`MIN_HEARD`, `MIN_SCORE`), clearly
//! better than any other clip near the line (`MARGIN`), and not a better fit for another line.
//! Short lines (a gasp, 「えっ！」) are heard in any number of clips, and never decided here.
//!
//! The same evidence settles a timing guess that went wrong: a line given a clip that says
//! nothing like it, while another clip near it clearly says it, takes that clip, and the first
//! goes back to be claimed by its own line.
use super::{classify, Hooked, Matched};
use crate::matching::{self, Heard};
use crate::sense_voice::HeardChar;
use std::path::PathBuf;

/// How long before a line's arrival its voice may have started, and after it, for the words to
/// decide (timing's window is a second or two).
pub const LEAD_MS: f64 = 10_000.0;
pub const LAG_MS: f64 = 6_000.0;
/// The share of the line's characters that must be heard in the clip.
pub const MIN_SCORE: f64 = 0.6;
/// And how many characters at least: fewer is a word any line may have.
pub const MIN_HEARD: f64 = 5.0;
/// How much better the line's clip must fit it than any other clip near it.
pub const MARGIN: f64 = 0.25;
/// A timing match is taken back only when its clip fits the line worse than this...
pub const POOR_FIT: f64 = 0.3;
/// ...and another clip fits it by this much more.
pub const BETTER_BY: f64 = 0.4;
/// Timing matches are checked for this long after their line arrives.
pub const VERIFY_MS: f64 = 60_000.0;
/// How long one pass may spend hearing clips: it shares its thread with the recording's listener.
/// No new clip is heard once this is spent (one always is); the rest wait for the next pass. A
/// clip takes about 20 ms a second of speech on an idle ARM64 machine, several times that on a busy one.
pub const PASS_MS: u128 = 250;
/// A clip outside the game's voice stream with less speech than this (Silero) is not heard: music
/// and effects cut into clips. Not the voice stream's own clips: breathy and whispered voices that
/// the recogniser hears word for word measure 0.00 (live SiglusEngine, eight of 71).
pub const MIN_SPEECH: f64 = 0.02;
/// With nothing new, the lines are looked at again this often (ms).
const RECHECK_MS: f64 = 1000.0;
/// Clips are transcribed when at least this long, and at most this long (seconds).
const MIN_CLIP_S: f64 = 0.6;
const MAX_CLIP_S: f64 = 30.0;
/// ... and, outside the voice stream (where music and ambience are cut into clips), at most this
/// long: one clip is heard whatever the pass's time, and a long one would hold the thread.
const MAX_OTHER_CLIP_S: f64 = 12.0;
/// A clip: its capture and sequence number.
pub(super) type Key = (PathBuf, u64);
/// The counts the words pass decided on, and when (`Hooked::words_state`).
pub(super) type State = ((usize, usize, usize, usize), f64);

/// The recogniser: the characters heard in mono `samples` at `rate`, or None when it cannot run.
pub type Transcribe<'a> = dyn FnMut(&[f32], u32) -> Option<Vec<HeardChar>> + 'a;

/// How well a line fits a clip's transcript.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fit {
    /// The share of the line's characters heard in the clip (0..1).
    pub score: f64,
    /// How many of the line's characters were heard.
    pub heard: f64,
    /// The share of the clip's heard characters the match covers: a whole line's clip is all its
    /// line; a clip holding two lines is half each.
    pub cover: f64,
    /// When the matched stretch was spoken (Unix ms).
    pub from_ms: f64,
    pub to_ms: f64,
}

impl Fit {
    /// One number to rank fits by: what of the line was heard, weighed by how much of the clip
    /// that explains (another line's clip that happens to say a word of this one covers little).
    pub fn quality(&self) -> f64 {
        self.score * (0.5 + 0.5 * self.cover.min(1.0))
    }
    /// Clear evidence on its own (still to be compared with the other clips near the line).
    pub fn sure(&self) -> bool {
        self.score >= MIN_SCORE && self.heard >= MIN_HEARD
    }
    fn overlaps(&self, other: &Fit) -> bool {
        let overlap = self.to_ms.min(other.to_ms) - self.from_ms.max(other.from_ms);
        overlap > 0.5 * (self.to_ms - self.from_ms).min(other.to_ms - other.from_ms).max(1.0)
    }
}

/// How well `line` fits `heard` (a clip's transcript). None when nothing of it was heard.
pub fn fit(line: &str, heard: &Heard) -> Option<Fit> {
    let m = matching::find(line, std::slice::from_ref(heard), heard.start_ms, heard.end_ms)?;
    let letters = matching::fold(line).0.len() as f64;
    let total = heard.chars.iter().filter(|c| !matching::fold(&c.ch.to_string()).0.is_empty()).count();
    let covered = heard
        .chars
        .iter()
        .filter(|c| c.ms >= m.heard_from_ms && c.ms <= m.heard_to_ms && !matching::fold(&c.ch.to_string()).0.is_empty())
        .count();
    Some(Fit {
        score: m.score,
        heard: m.score * letters,
        cover: covered as f64 / total.max(1) as f64,
        from_ms: m.heard_from_ms,
        to_ms: m.heard_to_ms,
    })
}

/// A clip that may be a line's voice whatever its stream's standing: not a loop, not named as
/// music or effects, not a sound its stream plays again, and of a length a line is spoken in.
fn worth_hearing(c: &super::HookClip, all: &[super::HookClip], voice: &[String]) -> bool {
    let longest = if voice.contains(&c.group()) || classify::name_says(&classify::clip_name(c)) > 0 {
        MAX_CLIP_S
    } else {
        MAX_OTHER_CLIP_S
    };
    c.file.is_some()
        && !c.looping
        && (MIN_CLIP_S..=longest).contains(&c.dur)
        && classify::name_says(&classify::clip_name(c)) >= 0
        && !classify::repeated(c, all)
}

impl Hooked {
    /// Lines the timing gave no clip (or a clip that says something else), given theirs by its
    /// words: see the module. Call after [`Hooked::tick`], with the recogniser. Clips are heard
    /// once each, for at most [`PASS_MS`] a call, those nearest a line waiting for one first.
    pub fn by_words(&mut self, now: f64, transcribe: &mut Transcribe) -> Vec<Matched> {
        let letters = |text: &str| matching::fold(text).0.len() as f64;
        let all: Vec<super::HookClip> = self.feeds.values().flat_map(|f| f.clips().iter().cloned()).collect();
        // Lines waiting for a clip whose window has passed, long enough to be told by their words.
        let open: Vec<crate::timeline::Line> = self
            .lines
            .iter()
            .filter(|l| {
                !self.done.contains_key(&l.uid)
                    && now - l.ts < super::feed::KEEP_MS
                    && letters(&l.text) >= MIN_HEARD
                    && !self.waiting(&l.uid, now)
            })
            .cloned()
            .collect();
        // Recent timing matches, to check.
        let checked: Vec<(crate::timeline::Line, (PathBuf, u64))> = self
            .lines
            .iter()
            .filter(|l| now - l.ts < VERIFY_MS && letters(&l.text) >= MIN_HEARD && !self.worded.contains(&l.uid))
            .filter_map(|l| self.done.get(&l.uid).map(|k| (l.clone(), k.clone())))
            .collect();
        if open.is_empty() && checked.is_empty() {
            return Vec::new();
        }
        let near =
            |start: f64, l: &crate::timeline::Line| (l.anchor() - LEAD_MS..=l.anchor() + LAG_MS).contains(&start);
        // Clips to hear: free ones near an open or checked line, and the checked lines' own.
        let mut wanted: Vec<(f64, PathBuf, super::HookClip)> = Vec::new();
        for (dir, f) in &self.feeds {
            for c in f.clips() {
                let key = (dir.clone(), c.seq);
                // Heard once, once it has played whole (the cheap checks first: a clip that may
                // be a voice is told by comparing it with every other).
                if self.heard.contains_key(&key) || now < c.start + c.dur * 1000.0 + 150.0 {
                    continue;
                }
                let own = checked.iter().any(|(_, k)| *k == key);
                let distance = open
                    .iter()
                    .chain(checked.iter().map(|(l, _)| l))
                    .filter(|l| own || near(c.start, l))
                    .map(|l| (c.start - l.anchor()).abs())
                    .fold(f64::INFINITY, f64::min);
                if !distance.is_finite() || (!own && self.used.contains(&key)) {
                    continue;
                }
                if own || worth_hearing(c, &all, &self.voice_groups) {
                    wanted.push((distance, dir.clone(), c.clone()));
                } else {
                    // Never a voice (a loop, an effect played again...): heard as saying nothing,
                    // so it is not looked at again.
                    self.heard.insert(key, Heard::new(c.start, c.start + c.dur * 1000.0, Vec::new()));
                }
            }
        }
        wanted.sort_by(|a, b| a.0.total_cmp(&b.0));
        let began = std::time::Instant::now();
        for (_, dir, c) in wanted {
            if began.elapsed().as_millis() >= PASS_MS {
                break;
            }
            let voice = self.voice_groups.contains(&c.group()) || classify::name_says(&classify::clip_name(&c)) > 0;
            let heard = match self.feeds[&dir].decode(&c) {
                Ok((samples, rate)) if !samples.is_empty() => {
                    let quiet = !voice
                        && self
                            .speech
                            .as_mut()
                            .and_then(|vad| vad.speech_share(&samples, rate).ok())
                            .is_some_and(|share| share < MIN_SPEECH);
                    if quiet {
                        Some(Vec::new())
                    } else {
                        transcribe(&samples, rate)
                    }
                }
                _ => Some(Vec::new()),
            };
            match heard {
                Some(chars) => {
                    let heard = Heard::new(c.start, c.start + c.dur * 1000.0, chars);
                    self.heard.insert((dir, c.seq), heard);
                }
                // The recogniser cannot run: try again next pass.
                None => return Vec::new(),
            }
        }
        // Nothing new heard, no line, match or clip changed: decided as last time, but for what
        // time alone settles (a window ending, a clip done playing), looked at once a second.
        let state = (self.lines.len(), self.done.len(), self.used.len(), self.heard.len());
        if state == self.words_state.0 && now - self.words_state.1 < RECHECK_MS && now >= self.words_state.1 {
            return Vec::new();
        }
        self.words_state = (state, now);
        // Every heard clip that is still there, one per sound (an adapter's pieces of one sound
        // heard the same; the longest stands for them).
        let mut sounds: Vec<((PathBuf, u64), &super::HookClip, &Heard)> = Vec::new();
        for (dir, f) in &self.feeds {
            for c in f.clips() {
                let key = (dir.clone(), c.seq);
                let Some(heard) = self.heard.get(&key) else { continue };
                match sounds.iter_mut().find(|(_, o, _)| (o.start - c.start).abs() <= classify::ECHO_MS) {
                    Some(slot) if slot.1.dur < c.dur && !self.used.contains(&slot.0) => *slot = (key, c, heard),
                    Some(_) => {}
                    None => sounds.push((key, c, heard)),
                }
            }
        }
        // How each line fits each heard clip near it, worked out once (`Hooked::fits`, by line and text).
        for l in self.lines.iter().filter(|l| now - l.ts < super::feed::KEEP_MS && letters(&l.text) >= MIN_HEARD) {
            for (key, _, h) in &sounds {
                if near(h.start_ms, l) {
                    self.fits.entry((l.uid.clone(), l.text.clone(), key.clone())).or_insert_with(|| fit(&l.text, h));
                }
            }
        }
        let fits = |l: &crate::timeline::Line| -> Vec<(usize, Fit)> {
            sounds
                .iter()
                .enumerate()
                .filter(|(_, (_, c, _))| near(c.start, l))
                .filter_map(|(i, (k, _, _))| {
                    self.fits.get(&(l.uid.clone(), l.text.clone(), k.clone())).copied().flatten().map(|f| (i, f))
                })
                .collect()
        };
        // The clear best clip of a line, if it has one among `fits`.
        let best = |fits: &[(usize, Fit)]| -> Option<(usize, Fit)> {
            let mut ranked: Vec<&(usize, Fit)> = fits.iter().collect();
            ranked.sort_by(|a, b| b.1.quality().total_cmp(&a.1.quality()));
            let first = **ranked.first()?;
            let clear = ranked.get(1).is_none_or(|second| {
                first.1.quality() - second.1.quality() >= MARGIN || first.1.score - second.1.score >= MARGIN
            });
            (first.1.sure() && clear).then_some(first)
        };
        // Every line near a clip competes for it: of two lines that fit one stretch of it, the one
        // it fits clearly better takes it; rows of one speech fit different stretches and share it.
        let rivals: Vec<(&crate::timeline::Line, Vec<(usize, Fit)>)> = self
            .lines
            .iter()
            .filter(|l| now - l.ts < super::feed::KEEP_MS && letters(&l.text) >= MIN_HEARD)
            .map(|l| (l, fits(l)))
            .collect();
        let contested = |uid: &str, i: usize, f: &Fit| {
            rivals.iter().any(|(other, fits)| {
                other.uid != uid
                    && fits.iter().any(|(j, g)| *j == i && g.overlaps(f) && g.quality() > f.quality() - MARGIN)
            })
        };
        // A line is decided once every clip that may be its own has been heard: none in its window
        // still unheard or playing, and, unless its voice came before it (text handed over late),
        // the window over (another clip may yet start in it and say the line too).
        let playing: Vec<f64> = self.feeds.values().flat_map(|f| f.open_starts(now)).collect();
        let all_heard = |l: &crate::timeline::Line, best_start: f64| {
            let unheard = self.feeds.iter().any(|(dir, f)| {
                f.clips().iter().any(|c| {
                    near(c.start, l)
                        && worth_hearing(c, &all, &self.voice_groups)
                        && !self.used.contains(&(dir.clone(), c.seq))
                        && !self.heard.contains_key(&(dir.clone(), c.seq))
                })
            });
            !unheard && !playing.iter().any(|s| near(*s, l)) && (best_start <= l.anchor() || now >= l.anchor() + LAG_MS)
        };
        let mut give: Vec<(String, usize, Option<Key>)> = Vec::new();
        for l in &open {
            let fits = fits(l);
            if let Some((i, f)) = best(&fits) {
                if !self.used.contains(&sounds[i].0) && !contested(&l.uid, i, &f) && all_heard(l, sounds[i].1.start) {
                    give.push((l.uid.clone(), i, None));
                }
            }
        }
        for (l, key) in &checked {
            let Some(own) = sounds.iter().position(|(k, _, _)| k == key) else { continue };
            let fits = fits(l);
            let mine = fits.iter().find(|(i, _)| *i == own).map_or(0.0, |(_, f)| f.quality());
            // The clip given said too little to judge by (a whisper the recogniser missed): kept.
            if letters(&sounds[own].2.text()) < MIN_HEARD || mine >= POOR_FIT {
                continue;
            }
            if let Some((i, f)) = best(&fits) {
                if i != own
                    && f.quality() - mine >= BETTER_BY
                    && !self.used.contains(&sounds[i].0)
                    && !contested(&l.uid, i, &f)
                {
                    give.push((l.uid.clone(), i, Some(key.clone())));
                }
            }
        }
        let mut out = Vec::new();
        for (uid, i, instead) in give {
            let (key, clip) = (sounds[i].0.clone(), sounds[i].1.clone());
            // Two lines given one clip in this pass: only where their stretches differ (checked
            // above against every line), so both keep it.
            let Ok((samples, sample_rate)) = self.feeds[&key.0].decode(&clip) else { continue };
            if let Some(old) = instead {
                // The clip the timing gave goes back, for its own line.
                if !self.done.iter().any(|(u, k)| *u != uid && *k == old) {
                    self.used.remove(&old);
                }
            }
            self.used.insert(key.clone());
            self.done.insert(uid.clone(), key);
            self.worded.insert(uid.clone());
            self.report.matched += 1;
            self.report.by_words += 1;
            let Some(line) = self.lines.iter().find(|l| l.uid == uid).cloned() else { continue };
            out.push(Matched { line, clip, samples, sample_rate });
        }
        // Transcripts of clips gone from the capture go too.
        let existing: std::collections::BTreeSet<(PathBuf, u64)> =
            self.feeds.iter().flat_map(|(p, f)| f.clips().iter().map(move |c| (p.clone(), c.seq))).collect();
        self.heard.retain(|k, _| existing.contains(k));
        let lines: std::collections::BTreeSet<&str> = self.lines.iter().map(|l| l.uid.as_str()).collect();
        self.fits.retain(|(uid, _, k), _| existing.contains(k) && lines.contains(uid.as_str()));
        out
    }
}
