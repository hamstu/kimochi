//! Clean per-sound captures, selected without a speech model. The system listener remains the fallback.
pub mod classify;
pub mod feed;
use crate::timeline::Line;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookClip {
    pub seq: u64,
    pub stream: u64,
    pub api: String,
    pub start: f64,
    pub dur: f64,
    pub file: Option<String>,
    pub source: Option<String>,
    pub fmt: Option<String>,
    pub looping: bool,
    pub channel: Option<String>,
}
impl HookClip {
    pub fn group(&self) -> String {
        let folder = self.source.as_deref().and_then(|s| s.replace('\\', "/").rsplit_once('/').map(|(d, _)| d.to_owned()));
        format!("{} | {} | {}", self.api, self.fmt.as_deref().unwrap_or("?"), self.channel.clone().or(folder).unwrap_or_default())
    }
}
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub captures: usize,
    pub clips_seen: u64,
    pub matched: usize,
    pub lag_ms: f64,
    /// Candidates set aside: empty, or with no speech in them.
    pub rejected: usize,
    /// Learned: how long each character of a line takes to type out before the text hook delivers
    /// it (KiriKiri rows arrive when typed, ~150 ms a character after their voice starts; engines
    /// that hand over whole lines, 0). A hook line's voice is expected that much before it arrives.
    pub typing_ms: f64,
    /// How long before a line's arrival its voice may start (learned like the lag).
    pub lead_ms: f64,
    pub groups: Vec<classify::Verdict>,
    pub error: Option<String>,
}
/// Typing delays tried (ms a character), the most a line's typing can move its anchor, and the
/// tight window a delay must explain voice starts in to be adopted.
const TYPING_STEPS: [f64; 5] = [40.0, 80.0, 120.0, 160.0, 200.0];
const MAX_TYPING_MS: f64 = 8000.0;
/// Voices that settle the timing (the typing delay and the window) for a session.
const SETTLED_CLIPS: usize = 5;
/// Until the timing settles, a quote row arriving this long after a voice started may be the one
/// it was typed for.
const TYPED_QUOTE_MS: f64 = 4000.0;
/// A quote's row handed over this long after its voice ended still shares it (typed out late).
const SHARE_AFTER_MS: f64 = 1500.0;
const TIGHT_LEAD_MS: f64 = 500.0;
const TIGHT_LAG_MS: f64 = 700.0;
/// A clip this close to a line (either side) was played while text was being read.
const OBSERVED_MS: f64 = 20_000.0;
/// Clips at least this long (s) are checked for speech; voiced clips measured 0.30-0.81 speech,
/// same-format effects 0.0 (AdvHD footsteps, ambience), breaths and gasps under 1.2 s 0.0 too.
const SPEECH_CHECK_MIN_S: f64 = 1.5;
/// Essentially no speech frames: whispered and breathy lines score low (a SiglusEngine whisper
/// 0.04, kisses 0.10), effects measured exactly 0.
const MIN_SPEECH_SHARE: f64 = 0.02;
/// `line` with its anchor moved back by `ms` a character typed (hook lines only: OCR lines
/// have their own appearance time).
fn typed(line: &Line, ms: f64) -> Line {
    if ms <= 0.0 || line.ocr {
        return line.clone();
    }
    let n = line.text.chars().filter(|c| !c.is_whitespace()).count() as f64;
    let mut t = line.clone();
    t.appeared = Some(line.anchor() - (ms * n).min(MAX_TYPING_MS));
    t
}
/// The line in `order` (lines by arrival) whose quote row `i` carries on, if it does: the rows
/// since the last that opened a quote (at most six back, within 30 s) still leave it open.
fn quote_start(order: &[&Line], i: usize) -> Option<usize> {
    let row = order[i];
    if row.text.starts_with(['「', '『']) {
        return None;
    }
    let mut text = String::new();
    for j in (i.saturating_sub(6)..i).rev() {
        if row.ts - order[j].ts > 30_000.0 {
            return None;
        }
        text.insert_str(0, &order[j].text);
        if order[j].text.starts_with(['「', '『']) {
            return quote_open(&text).then_some(j);
        }
    }
    None
}
use classify::opens_quote;
/// The quote `text` opens is still open: its next row carries on the same speech.
fn quote_open(text: &str) -> bool {
    let count = |set: &[char]| text.chars().filter(|c| set.contains(c)).count();
    count(&['「', '『']) > count(&['」', '』'])
}
pub struct Matched {
    pub line: Line,
    pub clip: HookClip,
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}
/// One session, reset when the selected game changes. Capture discovery is supplied by the app.
pub struct Hooked {
    feeds: BTreeMap<PathBuf, feed::Feed>,
    lines: Vec<Line>,
    used: BTreeSet<(PathBuf, u64)>,
    done: BTreeMap<String, (PathBuf, u64)>,
    pub report: Report,
    pub max_wait_ms: f64,
    /// Speech detection (Silero, not the speech model), when the ONNX Runtime loads: a long
    /// candidate with no speech in it (footsteps, a door, ambience in the voice's own format) is
    /// never a line's voice. Without it, clips are chosen by timing and streams alone.
    pub speech: Option<crate::vad::Vad>,
    /// A voice stream is established: its clips come with lines.
    trusted: bool,
    /// The game's voice stream as established in an earlier session (`voice_group`), trusted
    /// from its first clip: no warm-up after a restart or the next time the game is played.
    pub remembered: Option<String>,
    /// The game's typing delay as learned in an earlier session (`Report::typing_ms`).
    pub remembered_typing: Option<f64>,
    voice_groups: Vec<String>,
    /// Enough voices have taught the timing (or an earlier session did): a voice starting well
    /// after a line can be that line's, rather than the next line's still being typed out.
    settled: bool,
}
impl Default for Hooked {
    fn default() -> Self {
        Self {
            max_wait_ms: 15_000.0,
            speech: None,
            trusted: false,
            remembered: None,
            remembered_typing: None,
            voice_groups: Vec::new(),
            settled: false,
            feeds: BTreeMap::new(),
            lines: Vec::new(),
            used: BTreeSet::new(),
            done: BTreeMap::new(),
            report: Report { lag_ms: classify::LAG_MS, lead_ms: classify::LEAD_MS, ..Default::default() },
        }
    }
}
impl Hooked {
    pub fn add_capture(&mut self, dir: PathBuf) {
        self.feeds.entry(dir.clone()).or_insert_with(|| feed::Feed::new(dir));
    }
    pub fn line(&mut self, line: Line) {
        if let Some(old) = self.lines.iter_mut().find(|l| l.uid == line.uid) {
            *old = line;
        } else {
            self.lines.push(line);
        }
        if self.lines.len() > 500 {
            let old = self.lines.remove(0);
            self.done.remove(&old.uid);
        }
    }
    pub fn forget(&mut self, uids: &[String]) {
        self.lines.retain(|l| !uids.contains(&l.uid));
        for uid in uids {
            if let Some(key) = self.done.remove(uid) {
                // A clip shared by the rows of one quote stays taken while another row has it.
                if !self.done.values().any(|k| *k == key) {
                    self.used.remove(&key);
                }
            }
        }
    }
    pub fn needs_fallback(&self, now: f64) -> bool {
        self.feeds.is_empty() || self.lines.iter().any(|l| now - l.ts < 30_000.0 && !self.completed(&l.uid) && !self.waiting(&l.uid, now))
    }
    /// The game's voices are being captured: a voice stream is established and has given lines
    /// their clips. A line it gave none is most likely unvoiced (narration), so a fallback guess
    /// placed by timing alone, not confirmed by the line's words, is not trusted over that.
    pub fn established(&self) -> bool {
        // A stream named as voice (Ren'Py's voice channel, an audio/voice folder) needs no count:
        // a sparsely voiced game (one line in eight) would otherwise never get there.
        // A game whose voice stream an earlier session established is established from the start
        // while its capture runs: narration before this session's first voice is narration too.
        self.trusted && (self.named_voice() || self.report.matched >= 3) || (self.remembered.is_some() && !self.feeds.is_empty())
    }
    fn named_voice(&self) -> bool {
        self.report.groups.iter().any(|g| g.named && self.voice_groups.contains(&g.group))
    }
    /// The one voice stream, once it is established in this session: worth remembering for the game.
    pub fn voice_group(&self) -> Option<&str> {
        match self.voice_groups.as_slice() {
            [one] if self.report.matched >= 3 || (self.named_voice() && self.report.matched >= 1) => Some(one),
            _ => None,
        }
    }
    /// The typing delay, once enough voices have taught it: worth remembering for the game.
    pub fn typing(&self) -> Option<f64> {
        (self.settled && self.report.matched >= 3).then_some(self.report.typing_ms)
    }
    /// The game being captured, from its capture's start.
    pub fn exe(&self) -> Option<&str> {
        self.feeds.values().find_map(|f| f.exe.as_deref())
    }
    pub fn lines(&self) -> &[Line] {
        &self.lines
    }
    pub fn retry(&mut self, uid: &str) {
        self.done.remove(uid);
    }
    pub fn completed(&self, uid: &str) -> bool {
        self.done.contains_key(uid)
    }
    /// A clip of the voice stream that may be `uid`'s is held, not yet given to any line: decided
    /// once its timing is known (the game's typing delay, or a late start) or it ends playing. For
    /// a card that would otherwise settle for the system recording.
    pub fn pending(&self, uid: &str, now: f64) -> bool {
        if self.done.contains_key(uid) || self.voice_groups.is_empty() {
            return false;
        }
        let Some(line) = self.lines.iter().find(|l| l.uid == uid).map(|l| self.typed(l)) else {
            return false;
        };
        let (from, to) = (line.anchor() - classify::lead(&line, self.report.lead_ms).max(TYPED_QUOTE_MS), line.anchor() + self.report.lag_ms);
        now - line.ts < feed::KEEP_MS
            && self.feeds.iter().any(|(dir, f)| {
                f.clips().iter().any(|c| !self.used.contains(&(dir.clone(), c.seq)) && self.voice_groups.contains(&c.group()) && (from..=to).contains(&c.start))
            })
    }
    /// Bound the wait, even for missing end events. A healthy stream gets time to finish.
    pub fn waiting(&self, uid: &str, now: f64) -> bool {
        if self.feeds.is_empty() || self.done.contains_key(uid) {
            return false;
        }
        let Some(line) = self.lines.iter().find(|l| l.uid == uid).map(|l| self.typed(l)) else {
            return false;
        };
        let line = &line;
        let age = now - line.anchor();
        if age > self.max_wait_ms {
            return false;
        }
        if age < self.report.lag_ms + 400.0 {
            return true;
        }
        let in_window = |s: f64| s >= line.anchor() - classify::lead(line, self.report.lead_ms) && s <= line.anchor() + self.report.lag_ms;
        // A sound still being recorded, or one handed over whole as it started (Unity, Ren'Py,
        // SDL_mixer), which is matched once it has played (`tick`).
        self.feeds.values().flat_map(|f| f.open_starts(now)).any(in_window)
            || self.feeds.iter().any(|(dir, f)| {
                f.clips().iter().any(|c| {
                    !self.used.contains(&(dir.clone(), c.seq))
                        && c.file.is_some()
                        && c.dur <= 30.0
                        && classify::name_says(&classify::clip_name(c)) >= 0
                        && now < c.start + c.dur * 1000.0 + 150.0
                        && in_window(c.start)
                })
            })
    }
    /// A clip long enough to judge (a breath or a gasp may be a line's whole voice) with no speech.
    /// A clip whose file is named as voice is never second-guessed: Silero hears next to nothing in
    /// a shouted or sobbing line (live Unity: a shouted apology, `Sound/Voice/ch01_003.ogg`, at most
    /// 14% in any frame), and the name is the better witness.
    fn no_speech(&mut self, clip: &HookClip, samples: &[f32], sample_rate: u32) -> bool {
        if clip.dur < SPEECH_CHECK_MIN_S || classify::name_says(&classify::clip_name(clip)) > 0 {
            return false;
        }
        match self.speech.as_mut().map(|vad| vad.speech_share(samples, sample_rate)) {
            Some(Ok(share)) => share < MIN_SPEECH_SHARE,
            _ => false,
        }
    }
    /// Of clips that start as near `line` as each other (`tied`, indexes into `available`), the
    /// line's: the one with clearly the most speech, else the one whose length clearly fits the
    /// line's text best. None while one of them still plays, or when none stands out. Never one of
    /// `taken` (another line's).
    fn untie(&mut self, line: &Line, available: &[(PathBuf, HookClip)], tied: &[usize], taken: &[usize], now: f64) -> Option<usize> {
        let tied: Vec<usize> = tied.iter().copied().filter(|j| !taken.contains(j)).collect();
        if tied.len() == 1 {
            return Some(tied[0]);
        }
        if tied.is_empty() || tied.iter().any(|&j| now < available[j].1.start + available[j].1.dur * 1000.0 + 150.0) {
            return None;
        }
        let mut speech: Vec<(usize, f64)> = Vec::new();
        for &j in &tied {
            let (dir, clip) = &available[j];
            let share = match (self.feeds[dir].decode(clip), self.speech.as_mut()) {
                (Ok((samples, rate)), Some(vad)) if !samples.is_empty() => vad.speech_share(&samples, rate).ok(),
                _ => None,
            };
            speech.push((j, share.unwrap_or(-1.0)));
        }
        speech.sort_by(|a, b| b.1.total_cmp(&a.1));
        if speech[0].1 >= MIN_SPEECH_SHARE && speech[0].1 - speech[1].1 >= 0.2 {
            return Some(speech[0].0);
        }
        // About a mora every 0.13 s once spoken, with half a second around it.
        let spoken = line.text.chars().filter(|c| c.is_alphanumeric()).count() as f64;
        let expected = 0.5 + 0.13 * spoken;
        let mut fit: Vec<(usize, f64)> = tied.iter().map(|&j| (j, (available[j].1.dur - expected).abs())).collect();
        fit.sort_by(|a, b| a.1.total_cmp(&b.1));
        (fit[1].1 - fit[0].1 >= 0.6).then_some(fit[0].0)
    }
    /// `line` with its anchor moved back by its typing time (`Report::typing_ms`).
    fn typed(&self, line: &Line) -> Line {
        typed(line, self.report.typing_ms)
    }
    /// The typing delay that explains clearly more voice starts than none does (two more at
    /// least), else none: engines that hand over whole lines keep their anchors. A start explained
    /// by a line that opens a quote counts fully, by any other line half: voiced lines are quotes,
    /// mostly, and a voice that starts just after a narration row is the next row's, being typed.
    fn learn_typing(&self, starts: &[f64]) -> f64 {
        let explained = |k: f64| {
            starts
                .iter()
                .map(|s| {
                    let near = |l: &&Line| (-TIGHT_LEAD_MS..=TIGHT_LAG_MS).contains(&(*s - typed(l, k).anchor()));
                    if self.lines.iter().filter(near).any(|l| opens_quote(&l.text)) {
                        2
                    } else if self.lines.iter().any(|l| near(&l)) {
                        1
                    } else {
                        0
                    }
                })
                .sum::<usize>()
        };
        let base = explained(0.0);
        let mut best = (0.0, base);
        for k in TYPING_STEPS {
            let n = explained(k);
            if n > best.1 {
                best = (k, n);
            }
        }
        if best.1 >= base + 4 {
            best.0
        } else {
            0.0
        }
    }
    pub fn tick(&mut self, now: f64) -> Vec<Matched> {
        for f in self.feeds.values_mut() {
            if let Err(e) = f.poll(now) {
                self.report.error = Some(e);
            }
        }
        self.report.captures = self.feeds.len();
        self.report.clips_seen = self.feeds.values().map(|f| f.clips_seen).sum();
        let all: Vec<HookClip> = self.feeds.values().flat_map(|f| f.clips().iter().cloned()).collect();
        // Groups are judged on what played while text was being read. Clips far from every line
        // (before Kimochi was restarted, while the text hook was detached, at a title screen) say
        // nothing about which sounds go with lines, and would make the voice look unrelated to them.
        let observed: Vec<HookClip> = if self.lines.is_empty() {
            all.clone()
        } else {
            all.iter().filter(|c| self.lines.iter().any(|l| (c.start - l.anchor()).abs() <= OBSERVED_MS)).cloned().collect()
        };
        let all = observed;
        // A clearly leading group can teach the lag even when its files have no names.
        let wide = classify::classify(&all, &self.lines, classify::MAX_LEAD_MS, classify::MAX_LAG_MS);
        // (A group too small to judge competes with none, as below.)
        let learned = wide.first().filter(|v| v.clips >= 3 && v.voice > 0.85 && !wide.iter().skip(1).any(|other| (other.clips >= 3 || other.named) && v.voice - other.voice <= 0.15)).map(|v| v.group.clone());
        let teach: Vec<&HookClip> = all.iter().filter(|c| !c.looping && c.dur <= 30.0 && (classify::name_says(&classify::clip_name(c)) > 0 || learned.as_ref().is_some_and(|g| *g == c.group()))).collect();
        // The game's own delay from an earlier session until this one has seen enough to judge.
        self.settled = teach.len() >= SETTLED_CLIPS || self.remembered_typing.is_some();
        match self.remembered_typing {
            Some(remembered) if teach.len() < SETTLED_CLIPS => self.report.typing_ms = remembered,
            _ if teach.len() >= 3 => self.report.typing_ms = self.learn_typing(&teach.iter().map(|c| c.start).collect::<Vec<_>>()),
            _ => {}
        }
        let lines: Vec<Line> = self.lines.iter().map(|l| self.typed(l)).collect();
        // Strong names also teach late-starting engines before unnamed clips are trusted.
        // Each such clip is measured from its nearest line (a start before the line counting double,
        // as in pairing): a voice that starts just before the next line's text arrives is that
        // line's, not a late start of the line before.
        let (mut late, mut early) = (Vec::new(), Vec::new());
        for c in teach {
            let nearest = lines
                .iter()
                .map(|l| c.start - l.anchor())
                .filter(|d| (-classify::MAX_LEAD_MS..=classify::MAX_LAG_MS).contains(d))
                .min_by(|a, b| (if *a < 0.0 { -2.0 * a } else { *a }).total_cmp(&(if *b < 0.0 { -2.0 * b } else { *b })));
            match nearest {
                Some(d) if d >= 0.0 => late.push(d),
                Some(d) => early.push(-d),
                None => {}
            }
        }
        let p90 = |mut v: Vec<f64>| {
            v.sort_by(f64::total_cmp);
            v[v.len() * 9 / 10]
        };
        if late.len() >= 3 {
            self.report.lag_ms = (p90(late) + 400.0).clamp(classify::LAG_MS, classify::MAX_LAG_MS);
        }
        if early.len() >= 3 {
            self.report.lead_ms = (p90(early) + 400.0).clamp(classify::MIN_LEAD_MS, classify::MAX_LEAD_MS);
        }
        self.report.groups = classify::classify(&all, &lines, self.report.lead_ms, self.report.lag_ms);
        // Unnamed groups need repeated evidence, and a clear lead over competing sounds. A group too
        // small to be judged (a door and a chime that happened to come with lines) competes with none.
        let voice: Vec<String> = self
            .report
            .groups
            .iter()
            .filter(|v| {
                (self.remembered.as_ref() == Some(&v.group) && v.voice > 0.5)
                    || v.voice > 0.75
                    && (v.named || (v.clips >= 3 && !self.report.groups.iter().any(|other| other.group != v.group && (other.clips >= 3 || other.named) && other.voice >= v.voice - 0.15)))
            })
            .map(|v| v.group.clone())
            .collect();
        self.trusted = !voice.is_empty();
        self.voice_groups = voice.clone();
        let available: Vec<(PathBuf, HookClip)> = self
            .feeds
            .iter()
            .flat_map(|(p, f)| f.clips().iter().map(move |c| (p.clone(), c.clone())))
            .filter(|(p, c)| !self.used.contains(&(p.clone(), c.seq)) && c.file.is_some() && c.dur >= 0.15 && c.dur <= 30.0 && classify::candidate(c, &voice))
            .collect();
        // Rows that carry on a quote opened by an earlier row (KiriKiri hands over each typed row):
        // they start no voice of their own; they share the quote's, below.
        let mut order: Vec<&Line> = lines.iter().collect();
        order.sort_by(|a, b| a.ts.total_cmp(&b.ts));
        let quote_of: BTreeMap<String, String> = (0..order.len()).filter_map(|i| quote_start(&order, i).map(|j| (order[i].uid.clone(), order[j].uid.clone()))).collect();
        let pending: Vec<Line> = lines
            .iter()
            .filter(|l| !quote_of.contains_key(&l.uid))
            // As long as clips are kept: a pass held up (speech recognition, a busy machine) catches up.
            .filter(|l| !self.done.contains_key(&l.uid) && now - l.ts < feed::KEEP_MS)
            .filter(|l| l.scan.as_ref().is_none_or(|scan| !lines.iter().any(|other| other.scan.as_ref() == Some(scan) && other.text.chars().count() > l.text.chars().count())))
            .cloned()
            .collect();
        let refs: Vec<&HookClip> = available.iter().map(|(_, c)| c).collect();
        let open: Vec<(f64, String)> = self.feeds.values().flat_map(|f| f.open(now)).collect();
        let pairs = classify::pair(&pending, &refs, self.report.lead_ms, self.report.lag_ms);
        // Clips the pairing gave to some line: a tie is never settled with another line's clip.
        let pairs_taken: Vec<usize> = pairs.iter().flatten().map(|(i, _)| *i).collect();
        let mut out = Vec::new();
        for (line, pair) in pending.into_iter().zip(pairs) {
            let Some((i, _)) = pair else {
                continue;
            };
            let cost = |c: &HookClip| {
                let d = c.start - line.anchor();
                (if d < 0.0 { -2.0 * d } else { d }) + if c.dur < 0.8 { 700.0 } else { 0.0 }
            };
            // Clips as near the line as this one (a voice and an effect started together): the one
            // that is clearly the speech, or failing that clearly the line's length, else none yet.
            let tied: Vec<usize> = std::iter::once(i)
                .chain(available.iter().enumerate().filter(|(j, (_, other))| {
                    *j != i && other.start >= line.anchor() - classify::lead(&line, self.report.lead_ms) && other.start <= line.anchor() + self.report.lag_ms && (cost(other) - cost(&available[i].1)).abs() < 150.0
                }).map(|(j, _)| j))
                .collect();
            let i = if tied.len() > 1 {
                let others: Vec<usize> = pairs_taken.iter().copied().filter(|&j| j != i).collect();
                match self.untie(&line, &available, &tied, &others, now) {
                    Some(j) => j,
                    None => continue,
                }
            } else {
                i
            };
            let (dir, clip) = &available[i];
            // A sound of the voice's own stream that started in the line's window is still playing
            // (a longer clip starting with a short one): it may be the better match, so wait for it.
            if open.iter().any(|(start, group)| {
                voice.contains(group) && *start >= line.anchor() - classify::lead(&line, self.report.lead_ms) && *start <= line.anchor() + self.report.lag_ms && {
                    let d = start - line.anchor();
                    (if d < 0.0 { -2.0 * d } else { d }) < cost(clip) + 150.0
                }
            }) {
                continue;
            }
            // Until the timing has settled, a voice starting well after the line may belong to the
            // next line, still being typed out (KiriKiri): decided once the delay is known.
            if !self.settled
                && clip.start > line.anchor()
                && (clip.start - line.anchor() > TIGHT_LAG_MS
                    || (!opens_quote(&line.text) && lines.iter().any(|o| opens_quote(&o.text) && o.ts > clip.start && o.ts - clip.start <= TYPED_QUOTE_MS)))
            {
                continue;
            }
            // Some adapters expose whole files at play time: do not release until playback ends.
            if now < clip.start + clip.dur * 1000.0 + 150.0 {
                continue;
            }
            match self.feeds[dir].decode(clip) {
                Ok((samples, sample_rate)) if !samples.is_empty() && !self.no_speech(clip, &samples, sample_rate) => {
                    self.used.insert((dir.clone(), clip.seq));
                    self.done.insert(line.uid.clone(), (dir.clone(), clip.seq));
                    self.report.matched += 1;
                    let line = self.lines.iter().find(|o| o.uid == line.uid).cloned().unwrap_or(line);
                    out.push(Matched { line, clip: clip.clone(), samples, sample_rate });
                }
                Ok(_) => {
                    // Empty, or no speech: never a voice; the line may pair with another clip.
                    self.used.insert((dir.clone(), clip.seq));
                    self.report.rejected += 1;
                }
                Err(e) => {
                    self.report.error = Some(e);
                    self.used.insert((dir.clone(), clip.seq));
                }
            }
        }
        // A quote's later rows, delivered while its voice played (or just after: a row is handed over
        // once typed), have the voice its first row was given.
        for (row, first) in &quote_of {
            if self.done.contains_key(row) {
                continue;
            }
            let Some((dir, seq)) = self.done.get(first).cloned() else {
                continue;
            };
            let Some(line) = self.lines.iter().find(|l| l.uid == *row).cloned() else {
                continue;
            };
            let Some(clip) = self.feeds.get(&dir).and_then(|f| f.clips().iter().find(|c| c.seq == seq)).cloned() else {
                continue;
            };
            if line.ts > clip.start + clip.dur * 1000.0 + SHARE_AFTER_MS {
                continue;
            }
            if let Ok((samples, sample_rate)) = self.feeds[&dir].decode(&clip) {
                self.done.insert(line.uid.clone(), (dir, seq));
                self.report.matched += 1;
                out.push(Matched { line, clip, samples, sample_rate });
            }
        }
        let existing: BTreeSet<_> = self.feeds.iter().flat_map(|(p, f)| f.clips().iter().map(move |c| (p.clone(), c.seq))).collect();
        self.used.retain(|key| existing.contains(key));
        out
    }
}
#[cfg(test)]
mod tests;
