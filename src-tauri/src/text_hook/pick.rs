//! Choosing the dialogue thread among a hooked game's text threads, by what is on screen.
//!
//! A hooked game produces many threads: the dialogue, but also the speaker's nameplate, menus,
//! HUD strings and engine noise. The one we want is the one whose current text is *on screen*,
//! in the biggest block of text there (a dialogue box is usually the largest text on screen).
//! The window is read with the local OCR and grouped into blocks; each thread's latest text is
//! looked for in each block.
//!
//! Matching is exact containment after normalising width, punctuation and whitespace, never
//! fuzzy: a fuzzy match is easily fooled by a nameplate or HUD string that shares a few
//! characters with the dialogue. An engine's own hook is preferred to a generic one (on a Windows
//! API, or on a script runtime's strings), even one that matches more of the screen; ties go to
//! mostly-Japanese text, and away from threads that repeat themselves rapidly.
//!
//! A choice is remembered per game by `hookcode`, `ctx & 0xFFFF` and `ctx2 & 0xFFFF`
//! ([`Signature`]), not by the hook address or the thread number: those change with every
//! launch (address-space randomisation), while the low halves of the contexts do not.
use serde::{Deserialize, Serialize};

/// What a thread is remembered by across launches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signature {
    pub hookcode: String,
    pub ctx: u16,
    pub ctx2: u16,
}

impl Signature {
    pub fn new(hookcode: &str, ctx: u64, ctx2: u64) -> Self {
        Signature { hookcode: hookcode.to_string(), ctx: (ctx & 0xFFFF) as u16, ctx2: (ctx2 & 0xFFFF) as u16 }
    }
}

/// One line the OCR read, in frame pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrLine {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Lines that belong together on screen: a dialogue box, a menu, a nameplate.
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    /// Normalised text of the block's lines in reading order.
    pub text: String,
    /// Sum of the lines' areas: how much of the screen this text takes up.
    pub area: f64,
}

/// A candidate thread, as the session knows it.
#[derive(Debug, Clone)]
pub struct Candidate<'a> {
    pub key: &'a str,
    pub hookcode: &'a str,
    /// The hook's name as the hooker gives it (`v8::String::Write`, `TextOutW`).
    pub name: &'a str,
    /// The thread's most recent sentence.
    pub text: &'a str,
    /// Sentences it produced in the last few seconds; a flood is engine noise, not dialogue.
    pub recent: usize,
    /// Pieces of text it has sent since the game was hooked.
    pub count: u64,
    /// The share of those that held script codes (asset and label names mixed in with the text).
    pub noise: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Scored {
    pub key: String,
    pub score: f64,
    /// Matched characters, the main part of the score.
    pub matched: usize,
    /// Matched characters scaled by how much of the thread's text they are: what an automatic
    /// choice must find enough of.
    pub effective: f64,
    /// Whether the match was in the largest block on screen.
    pub in_largest: bool,
}

/// Characters that never decide a match: whitespace, and Japanese and ASCII punctuation, which
/// OCR misreads or drops and games draw in separate calls. The long-vowel mark is kept: it is a
/// letter, and OCR reads it well.
fn ignorable(c: char) -> bool {
    c.is_whitespace()
        || c.is_ascii_punctuation()
        || "、。，．・：；？！゛゜´｀¨＾￣＿〃〆〇―‐／＼～∥｜…‥‘’“”（）〔〕［］｛｝〈〉《》「」『』【】＋－±×÷＝≠＜＞≦≧∞∴♪☆★○●◎◇◆□■△▲▽▼※→←↑↓〜｡｢｣､･"
            .contains(c)
}

/// Full-width ASCII and the ideographic space folded to plain ASCII; half-width katakana are
/// left alone (they are rare in games and OCR reads them as they are drawn).
fn fold_width(c: char) -> char {
    match c {
        '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFF01 + 0x21).unwrap_or(c),
        '\u{3000}' => ' ',
        _ => c,
    }
}

/// The form both sides are compared in.
pub fn normalize(text: &str) -> String {
    text.chars().map(fold_width).filter(|c| !ignorable(*c)).flat_map(char::to_lowercase).collect()
}

fn japanese(c: char) -> bool {
    matches!(c as u32, 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF66..=0xFF9F)
}

/// Share of a text's characters that are kana or kanji.
pub fn japanese_ratio(normalized: &str) -> f64 {
    let total = normalized.chars().count();
    if total == 0 {
        return 0.0;
    }
    normalized.chars().filter(|c| japanese(*c)).count() as f64 / total as f64
}

/// Generic hooks LunaHook (and Textractor) insert on Windows APIs carry the API's module in the
/// hook code (`HQ-54@0:gdi32.dll:TextOutW`). An engine hook names an engine, not a DLL export.
pub fn is_generic_api_hook(hookcode: &str) -> bool {
    let lower = hookcode.to_ascii_lowercase();
    [
        "gdi32.dll", "user32.dll", "kernel32.dll", "gdiplus.dll", "oleaut32.dll", "d3dx9", "d3d9.dll",
        "msvcrt.dll", "ucrtbase.dll", "dwrite.dll",
    ]
    .iter()
    .any(|module| lower.contains(module))
}

/// A generic hook: one on a Windows API ([`is_generic_api_hook`]), or one LunaHook puts on a
/// script runtime's string functions, which every string the game's script handles passes
/// through (`v8::String::Write` in an Electron or NW.js game, `System.String` methods in a Unity
/// Mono game, whose script interpreter compares and cuts its lines ahead of showing them), not its
/// text box. Such a hook is in the game's own image, so only its name tells it apart.
pub fn is_generic(hookcode: &str, name: &str) -> bool {
    is_generic_api_hook(hookcode) || name.starts_with("v8::") || hookcode.contains("@mscorlib:System:String:")
}

/// Groups OCR lines into blocks: a line joins the previous block when it starts within a line
/// height below it and overlaps it horizontally, the way a dialogue box's lines (and their
/// furigana) sit under each other. Lines are taken top to bottom.
pub fn blocks(lines: &[OcrLine]) -> Vec<Block> {
    struct Open {
        texts: Vec<String>,
        left: f64,
        right: f64,
        bottom: f64,
        height: f64,
        area: f64,
    }
    let mut sorted: Vec<&OcrLine> = lines.iter().filter(|l| !normalize(&l.text).is_empty()).collect();
    sorted.sort_by(|a, b| a.y.total_cmp(&b.y).then(a.x.total_cmp(&b.x)));
    let mut open: Vec<Open> = Vec::new();
    for line in sorted {
        let (left, right, bottom) = (line.x, line.x + line.width, line.y + line.height);
        let joins = open.iter_mut().rev().find(|b| {
            let gap = line.y - b.bottom;
            let reach = b.height.max(line.height) * 1.2;
            gap > -line.height * 0.5 && gap < reach && left < b.right && right > b.left
        });
        match joins {
            Some(b) => {
                b.texts.push(line.text.clone());
                b.left = b.left.min(left);
                b.right = b.right.max(right);
                b.bottom = b.bottom.max(bottom);
                b.height = line.height;
                b.area += line.width * line.height;
            }
            None => open.push(Open {
                texts: vec![line.text.clone()],
                left,
                right,
                bottom,
                height: line.height,
                area: line.width * line.height,
            }),
        }
    }
    open.into_iter()
        .map(|b| Block { text: normalize(&b.texts.concat()), area: b.area })
        .collect()
}

/// The fewest characters that count as a match: a two-kana string is on every screen.
const MIN_MATCH: usize = 4;
/// The least share of kana and kanji a thread needs to be chosen automatically.
const MIN_JAPANESE: f64 = 0.3;

/// Scores every candidate against the screen's blocks; best first. A candidate that matches
/// nothing is left out, so an empty result means "no thread is on screen yet".
pub fn score(candidates: &[Candidate], blocks: &[Block]) -> Vec<Scored> {
    let largest = blocks
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.area.total_cmp(&b.1.area))
        .map(|(i, _)| i);
    let mut scored: Vec<Scored> = candidates
        .iter()
        .filter_map(|candidate| {
            let text = normalize(candidate.text);
            let length = text.chars().count();
            // Too short to tell apart, or not Japanese: file paths, asset names and the window
            // title also turn up in hooked threads and on screen.
            if length < MIN_MATCH || japanese_ratio(&text) < MIN_JAPANESE {
                return None;
            }
            // The thread's whole sentence inside a block. Where the hook holds more than the
            // screen shows (text still typing out, or two sentences joined), the block inside
            // the sentence counts too, for what the block holds, scaled by how much of the
            // thread that is: a thread that merely contains the line among other text is noise.
            let (index, matched, coverage) = blocks
                .iter()
                .enumerate()
                .filter_map(|(i, block)| {
                    let shown = block.text.chars().count();
                    if block.text.contains(&text) {
                        Some((i, length, 1.0))
                    } else if shown >= MIN_MATCH && text.contains(&block.text) {
                        Some((i, shown, shown as f64 / length as f64))
                    } else {
                        None
                    }
                })
                .max_by_key(|(i, matched, _)| (*matched, Some(*i) == largest))?;
            let in_largest = Some(index) == largest;
            let effective = matched as f64 * coverage;
            let mut score = effective;
            if in_largest {
                score *= 2.0;
            }
            score += 4.0 * japanese_ratio(&text);
            // An engine's own hook over a generic one, even where the generic one matches more:
            // a generic hook sees every string the game handles, so it holds the line together
            // with whatever was drawn or built beside it (a speaker's name, markup).
            if is_generic(candidate.hookcode, candidate.name) {
                score *= 0.6;
            } else {
                score += 3.0;
            }
            // Of threads that show the same line, one that has spoken before: some hooks start a
            // new thread for every line (SiglusEngine's, whose context counts up), and a thread
            // chosen that way never speaks again.
            score += 0.25 * (candidate.count.clamp(1, 5) - 1) as f64;
            // And of those, one that sends the dialogue alone over one that mixes the script's
            // codes in with it (SiglusEngine has both).
            score -= 3.0 * candidate.noise;
            if candidate.recent > 6 {
                score *= 0.5;
            }
            // Of two copies of one line (a text and its shadow), the one wrapped least.
            score -= 0.01 * candidate.text.matches('\n').count() as f64;
            Some(Scored { key: candidate.key.to_string(), score, matched, effective, in_largest })
        })
        .collect();
    scored.sort_by(|a, b| b.score.total_cmp(&a.score));
    scored
}

/// The thread to choose automatically from `score`'s list: the best that matched at least
/// `min` characters, in the largest text on screen (the dialogue box) or, elsewhere, at least
/// [`MIN_OFF_BOX`] of them. A speaker's nameplate is never the largest text, and a long name
/// matched exactly while the line itself was misread would otherwise take the choice.
pub fn chosen(scored: &[Scored], min: f64) -> Option<&Scored> {
    scored.iter().find(|s| s.effective >= min && (s.in_largest || s.effective >= MIN_OFF_BOX))
}

/// The fewest characters a thread matched outside the largest text must have to be chosen.
const MIN_OFF_BOX: f64 = 12.0;

/// The sentences a typewriter effect leaves behind. A game that types its text out sets the
/// whole text again on every frame ("「", "「旅", "「旅人", …), and the hooker joins those calls
/// into one piece of text. A run of frames that never get shorter, each the start of the run's last
/// frame (ignoring the line breaks the game inserts as it wraps), is that last frame's sentence.
/// Clicking quickly puts two such runs in one piece (the rest of one line, the next line typing
/// out): each run is its own sentence, in order. Text that is not a typewriter's comes out as it
/// is, trimmed, as one sentence.
///
/// Of the ways to read a piece as runs, the one taken leaves the least text in sentences: the most
/// of it is frames being typed. Repeated characters can look like frames of their own ("ー", "ー"
/// and the start of "ーっ」"), but reading them so leaves a sentence for every such guess; two
/// lines read as one leave every frame of the second inside the first's sentence.
pub fn typewriter_lines(text: &str) -> Vec<String> {
    let parse = Parse::new(text, "");
    parse.best().map(|spans| parse.lines(&spans)).filter(|l| !l.is_empty()).unwrap_or_else(|| parse.trimmed())
}

/// The sentences of `text` when it carries on typing `before`, the last frame of the text before
/// it: a typewriter that pauses longer than the hooker waits (a long "ーーー", a dramatic "……")
/// arrives in pieces, the next starting part way through the line. The first sentence is
/// `before` carried on (finished, or as far as it got); None when `text` does not carry it on.
pub fn typewriter_lines_after(before: &str, text: &str) -> Option<Vec<String>> {
    let before = before.trim();
    if before.is_empty() {
        return None;
    }
    let parse = Parse::new(&format!("{before}\n{text}"), before);
    let spans = parse.best()?;
    // The text before is carried on only by a run that starts with it.
    let &Span { from, last, .. } = spans.first()?;
    if from != 0 || last == 0 {
        return None;
    }
    let lines = parse.lines(&spans);
    (normalize(lines.first()?).len() > normalize(before).len()).then_some(lines)
}

/// The longest frame looked for: a sentence on screen is never longer.
const MAX_FRAME: usize = 400;
/// The most a frame grows on the one before it.
const MAX_STEP: usize = 3;
/// How many ends `Parse::best` reads before it settles for the latest run at each end.
const BEST_BUDGET: usize = 256;
/// The most steps a piece is read in (each a character compared): past it, the piece is taken as
/// it is. A typewriter's burst takes a few hundred thousand; text built to be hard (thousands of
/// one repeated character) would take billions.
const MAX_STEPS: usize = 3_000_000;

/// Part of a piece: a run (its frames from `from`, its last frame from `last`, to `end`), or with
/// `last` 0, text that is not a typewriter's, all of it the sentence.
#[derive(Clone, Copy)]
struct Span {
    from: usize,
    last: usize,
    end: usize,
}

/// The best way on from a frame to the last frame of its run: how many frames (this one
/// included), how many of them are as long as the one before, and how long the next one is (none
/// when the next is the last). Best is the fewest frames that do not grow for the most frames.
#[derive(Clone, Copy)]
struct Split {
    frames: usize,
    steady: usize,
    second: Option<usize>,
}

/// One piece of hooked text, read as frames. Its first `seed` characters (whitespace aside), when
/// there are any, are a frame of their own however long: the last frame of the piece before.
struct Parse {
    text: String,
    chars: Vec<(usize, char)>,
    norm: Vec<char>,
    seed: usize,
    steps: std::cell::Cell<usize>,
}

impl Parse {
    fn new(text: &str, seed: &str) -> Self {
        let chars: Vec<(usize, char)> = text.char_indices().filter(|(_, c)| !c.is_whitespace()).collect();
        let norm = chars.iter().map(|(_, c)| *c).collect();
        let seed = seed.chars().filter(|c| !c.is_whitespace()).count();
        Parse { text: text.to_string(), chars, norm, seed, steps: std::cell::Cell::new(0) }
    }

    fn trimmed(&self) -> Vec<String> {
        let t = self.text.trim();
        if t.is_empty() { vec![] } else { vec![t.to_string()] }
    }

    /// The original text of norm[from..to], line breaks and all.
    fn slice(&self, from: usize, to: usize) -> String {
        let end = self.chars[to - 1].0 + self.chars[to - 1].1.len_utf8();
        self.text[self.chars[from].0..end].trim().to_string()
    }

    fn lines(&self, spans: &[Span]) -> Vec<String> {
        spans.iter().map(|s| self.slice(s.last, s.end)).filter(|l| !l.is_empty()).collect()
    }

    /// The runs that end at `end`: for each start k of the last frame, latest first, the earliest q
    /// its frames can start at; `each` takes them until it returns true.
    fn runs(&self, end: usize, each: impl FnMut(usize, usize) -> bool) {
        self.runs_while(end, |_| true, each)
    }

    /// `runs`, for starts of the last frame while `wanted` says so.
    ///
    /// For a last frame from k, the frames before it are read from k backwards: `split[p]` holds,
    /// for each length a frame starting at p can have (a prefix of the last frame), the best way
    /// on from there to k (see `Split`), each frame as long as the one before or up to `MAX_STEP`
    /// longer. Where no frame can start for longer than the last frame, none can further back.
    fn runs_while(&self, end: usize, wanted: impl Fn(usize) -> bool, mut each: impl FnMut(usize, usize) -> bool) {
        let norm = &self.norm;
        for k in (1..end).rev() {
            if !wanted(k) {
                return;
            }
            // A frame ends at k only where what comes before k is the start of what follows it.
            if !self.frame_before(k, end) {
                continue;
            }
            // Nor in a row of one character ("……", "ーー"), unless the game broke the line there: a
            // last frame that starts part way along the row reads its own frames as longer ones.
            if norm[k - 1] == norm[k] && !self.space_before(k) {
                continue;
            }
            let last = &norm[k..end];
            let mut split: Vec<Vec<Option<Split>>> = vec![Vec::new(); k + 1];
            let mut reached = k;
            let mut start = None;
            for p in (0..k).rev() {
                if reached - p > last.len() {
                    break;
                }
                let common = norm[p..k].iter().zip(last).take_while(|(x, y)| x == y).count();
                self.steps.set(self.steps.get() + common * (MAX_STEP + 2) + 1);
                if self.steps.get() > MAX_STEPS {
                    return;
                }
                let mut here = vec![None; common + 1];
                for (len, slot) in here.iter_mut().enumerate().skip(1) {
                    let next = p + len;
                    *slot = if next == k {
                        Some(Split { frames: 1, steady: 0, second: None })
                    } else {
                        (len..=len + MAX_STEP)
                            .filter_map(|l| split[next].get(l).copied().flatten().map(|s| (l, s)))
                            .map(|(l, s)| Split {
                                frames: s.frames + 1,
                                steady: s.steady + usize::from(l == len),
                                second: Some(l),
                            })
                            .min_by_key(|s| (2 * s.steady) as isize - s.frames as isize)
                    };
                }
                if here.iter().any(Option::is_some) {
                    reached = p;
                }
                if norm[p] == norm[k] && self.typed(&here, p, k) {
                    start = Some(p);
                }
                split[p] = here;
            }
            if let Some(q) = start {
                if each(k, q) {
                    return;
                }
            }
        }
    }

    /// Whether the original text has whitespace (a line break between frames) just before norm[k].
    fn space_before(&self, k: usize) -> bool {
        let (at, _) = self.chars[k];
        let (before, c) = self.chars[k - 1];
        at > before + c.len_utf8()
    }

    /// Whether some frame can end at k: the m characters before k are the m after it, for some m.
    fn frame_before(&self, k: usize, end: usize) -> bool {
        let norm = &self.norm;
        (1..=k.min(end - k).min(MAX_FRAME)).any(|m| {
            self.steps.set(self.steps.get() + 1);
            norm[k - m] == norm[k] && norm[k - m..k] == norm[k..k + m]
        })
    }

    /// Whether frames from `q` to `k` (`here`, the ways from q) look like text being typed: at
    /// least two of them (a single lead-in that happens to repeat the sentence's start, "ああ、ああ",
    /// is not a typewriter), the first of one or two characters, growing a little at a time, and
    /// with only two, by one character. Ordinary text can split into prefixes of what follows it by
    /// chance ("きょうは" + "はなと" before "はなとやまと…"), but not into a run like that. A frame
    /// as long as the one before (a space the game adds as it wraps) is allowed now and then,
    /// never mostly: a row of one character repeated ("……………") splits into frames of one that
    /// never grow. The frames may add up to less than the final text: a click mid-line shows the
    /// rest at once. From a seed (the last frame of the piece before), the seed is the first frame.
    fn typed(&self, here: &[Option<Split>], q: usize, k: usize) -> bool {
        if self.seed > 0 && q == 0 {
            return here.get(self.seed).copied().flatten().is_some();
        }
        let _ = k;
        (1..here.len().min(3)).any(|len| match here[len] {
            Some(s) if s.frames == 2 => s.second == Some(len + 1),
            Some(s) => s.frames > 2 && 2 * s.steady < s.frames,
            None => false,
        })
    }

    /// The reading that leaves the least text in sentences (ties: the latest run), or, past the
    /// budget, the latest run at each end. None for a piece too short or too long to read.
    fn best(&self) -> Option<Vec<Span>> {
        let n = self.norm.len();
        if !(4..=4_000).contains(&n) {
            return None;
        }
        let mut memo = std::collections::HashMap::new();
        let mut budget = BEST_BUDGET;
        let (_, spans) = self.best_to(n, &mut memo, &mut budget);
        (self.steps.get() <= MAX_STEPS).then_some(spans)
    }

    /// The least text in sentences norm[..end] can leave, and how.
    fn best_to(
        &self,
        end: usize,
        memo: &mut std::collections::HashMap<usize, (usize, Vec<Span>)>,
        budget: &mut usize,
    ) -> (usize, Vec<Span>) {
        if end == 0 {
            return (0, Vec::new());
        }
        if let Some(known) = memo.get(&end) {
            return known.clone();
        }
        // Nothing typed: all of it is the sentence.
        let mut best = (end, vec![Span { from: 0, last: 0, end }]);
        if *budget == 0 {
            // Out of reads: the latest run, and the same before it.
            let mut latest = None;
            self.runs(end, |k, q| {
                latest = Some((k, q));
                true
            });
            if let Some((k, q)) = latest {
                let (cost, mut spans) = self.best_to(q, memo, budget);
                spans.push(Span { from: q, last: k, end });
                best = (cost + end - k, spans);
            }
        } else {
            *budget -= 1;
            // The sentence only grows as its start moves back: once it is as long as the best
            // reading so far leaves, no earlier start can do better.
            let least = std::cell::Cell::new(best.0);
            self.runs_while(
                end,
                |k| end - k < least.get(),
                |k, q| {
                    let sentence = end - k;
                    let (cost, spans) = self.best_to(q, memo, budget);
                    if cost + sentence < best.0 {
                        let mut spans = spans;
                        spans.push(Span { from: q, last: k, end });
                        best = (cost + sentence, spans);
                        least.set(best.0);
                    }
                    false
                },
            );
        }
        memo.insert(end, best.clone());
        best
    }
}

/// Sentences the game drew more than once in a row, once: CatSystem2 draws each line three times
/// (`「そ、そうだよな」「そ、そうだよな」「そ、そうだよな」` is `「そ、そうだよな」`). Only a run of
/// at least `MIN_REPEAT` characters that ends a sentence counts: a word said twice
/// (`ガタッ、ガタッ`) is the text. Collapsed until nothing repeats: a speaker shown under another
/// name comes as `名名「…」「…」名「…」`, which is `名「…」名「…」` once each part is once.
pub fn collapse_repeated_sentences(text: &str) -> String {
    // Longer than a line drawn a few times over (a script interpreter's source going through
    // String functions: thousands of characters, every one of them a place to look): as it is.
    if text.chars().count() > REPEATS_UP_TO * super::clean::MAX_LINE_CHARS {
        return text.to_string();
    }
    let mut text = text.to_string();
    loop {
        let once = collapse_once(&text);
        if once.len() == text.len() {
            return text;
        }
        text = once;
    }
}

fn collapse_once(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let ends = |c: char| "。！？!?」』）)…―～".contains(c);
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let longest = ((chars.len() - i) / 2).min(super::clean::MAX_LINE_CHARS);
        // The shortest sentence that repeats: drawn four times, the line twice over repeats too.
        // A whole quote, however short (`「ん？」「ん？」「ん？」`), is a sentence too.
        let quote = |n: usize| chars[i] == '「' && chars[i + n - 1] == '」';
        let repeat = (3..=longest).find(|&n| {
            (n >= MIN_REPEAT || quote(n)) && chars[i] == chars[i + n] && ends(chars[i + n - 1]) && chars[i..i + n] == chars[i + n..i + 2 * n]
        });
        match repeat {
            Some(n) => {
                out.extend(&chars[i..i + n]);
                i += n;
                while i + n <= chars.len() && chars[i..i + n] == chars[i - n..i] {
                    i += n;
                }
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// Whether `shown` (normalized) is a line of dialogue other than `before`: Japanese, `min` characters
/// or more, and not `before` typed further or the start of it.
pub fn another_line(before: &str, shown: &str, min: usize) -> bool {
    let fresh = before.is_empty() || !(shown.starts_with(before) || before.starts_with(shown));
    fresh && shown.chars().count() >= min && japanese_ratio(shown) >= MIN_JAPANESE
}

/// The shortest sentence `collapse_repeated_sentences` takes as drawn twice.
const MIN_REPEAT: usize = 6;
/// The most times over `collapse_repeated_sentences` expects a line to be drawn.
const REPEATS_UP_TO: usize = 4;

/// The last sentence of `typewriter_lines`: what a thread is showing now.
#[cfg(test)]
pub fn collapse_typewriter(text: &str) -> String {
    typewriter_lines(text).pop().unwrap_or_default()
}

/// A readable name for a hook. Engine hooks on managed code (Unity's Mono and IL2CPP) carry a
/// method signature as their name; their hook code names the class and method
/// (`EHMF2@UnityEngine.UI:UnityEngine.UI:Text:set_text:1:JIT:UNITY` is `Text.set_text`).
pub fn display_name(hookcode: &str, name: &str) -> String {
    if name.matches(':').count() >= 2 {
        if let Some((_, tail)) = hookcode.split_once('@') {
            let parts: Vec<&str> = tail.split(':').collect();
            if parts.len() >= 4 && !parts[2].is_empty() && !parts[3].is_empty() {
                return format!("{}.{}", parts[2], parts[3]);
            }
        }
    }
    name.trim_end_matches(':').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What LunaHook gave for one line of a Unity game that types its text out:
    /// `UnityEngine.UI.Text.set_text` on the text and on its shadow, and `String.op_Inequality`.
    fn unity() -> serde_json::Value {
        serde_json::from_str(include_str!("fixtures/unity-typewriter.json")).unwrap()
    }
    const UNITY_LINE: &str = "「旅人は夢だけの記録となってもなおその町に集まり、\n　お客様の約束に駆けつけたのです」";

    #[test]
    fn a_typed_out_line_collapses_to_its_final_text() {
        let fixture = unity();
        assert_eq!(collapse_typewriter(fixture["setText"].as_str().unwrap()), UNITY_LINE);
        // The shadow copy wraps at other places; the same line comes out.
        assert_eq!(
            normalize(&collapse_typewriter(fixture["setTextShadow"].as_str().unwrap())),
            normalize(UNITY_LINE)
        );
    }

    #[test]
    fn a_line_that_repeats_its_own_start_keeps_it() {
        // そもそも: the final text has a second "そ" a frame could otherwise be split at.
        let line = "そもそも『夢』は、何だろう。";
        let chars: Vec<char> = line.chars().collect();
        let frames: String = (1..=chars.len()).map(|n| chars[..n].iter().collect::<String>()).collect();
        assert_eq!(collapse_typewriter(&frames), line);
        // The game setting the finished text again changes nothing.
        assert_eq!(collapse_typewriter(&format!("{frames}{line}{line}")), line);
    }

    #[test]
    fn a_line_skipped_to_its_end_mid_typing_still_collapses() {
        // Clicking while the line types out: the game jumps from 「少年は春の帰 to the whole line.
        let typed = "「「少\n「少年\n「少年は\n「少年は春\n「少年は春の\n「少年は春の帰\n「少年は春の帰り道で雨に降られ、\n　風邪をひいてしまったのです」";
        assert_eq!(collapse_typewriter(typed), "「少年は春の帰り道で雨に降られ、\n　風邪をひいてしまったのです」");
        // Skipped after two frames.
        assert_eq!(collapse_typewriter("「「少「少年は春の帰り道です」"), "「少年は春の帰り道です」");
    }

    #[test]
    fn two_lines_typed_out_in_one_burst_come_out_as_two() {
        // Clicking twice quickly: the first line finished at once, the next typed out, all before
        // the hooker's flush.
        let typed = |line: &str| -> String {
            let chars: Vec<char> = line.chars().collect();
            (1..=chars.len()).map(|n| chars[..n].iter().collect::<String>()).collect()
        };
        let a = "「少年は春の帰り道で雨に降られたのです」";
        let b = "「そして、町は静かになりました」";
        let skipped: String = a.chars().take(4).collect::<Vec<_>>().iter().enumerate()
            .map(|(i, _)| a.chars().take(i + 1).collect::<String>()).collect();
        assert_eq!(typewriter_lines(&format!("{skipped}{a}{}", typed(b))), vec![a, b]);
        assert_eq!(collapse_typewriter(&format!("{}{}", typed(a), typed(b))), b);
        assert_eq!(typewriter_lines(&format!("{}{}", typed(a), typed(b))), vec![a, b]);
    }

    /// Every frame of `line` from `from` characters on, as the hooker joins them.
    fn frames(line: &str, from: usize) -> String {
        let chars: Vec<char> = line.chars().collect();
        (from.max(1)..=chars.len()).map(|n| chars[..n].iter().collect::<String>() + "\n").collect()
    }

    #[test]
    fn a_line_with_a_long_drawn_out_vowel_is_one_line() {
        // Three "ー" in a row look like frames "ー", "ー" and the start of "ーっ」".
        let line = "「はぁっ、はぁっ、もうだめよぉ、んーーーーーっ」";
        assert_eq!(typewriter_lines(&frames(line, 1)), vec![line]);
        // A hooker that joins the frames with nothing between them.
        assert_eq!(typewriter_lines(&frames(line, 1).replace('\n', "")), vec![line]);
        let dots = "「うっ………………ま、だ……！」";
        assert_eq!(typewriter_lines(&frames(dots, 1)), vec![dots]);
    }

    #[test]
    fn a_line_of_dots_is_the_whole_row() {
        // As the game sends them: the first two frames joined, the rest a line each.
        let line = "……………………。";
        let burst = "………\n………\n…………\n……………\n………………\n…………………\n……………………\n……………………。\n";
        assert_eq!(typewriter_lines(burst), vec![line]);
        assert_eq!(typewriter_lines("………\n……。\n"), vec!["……。"]);
        let shout = "いいい\nいいで\nいいです\nいいですよ\nいいですよ！\nいいですよ！\n\nいいですよ！\nは\nいいですよ！\nはぁ\nいいですよ！\nはぁー\nいいですよ！\nはぁーー\nいいですよ！\nはぁーーー\nいいですよ！\nはぁーーーー\nいいですよ！\nはぁーーーーー！\nいいですよ！\nはぁーーーーー！！\n";
        assert_eq!(typewriter_lines(shout), vec!["いいですよ！\nはぁーーーーー！！"]);
    }

    #[test]
    fn a_line_that_pauses_while_typing_carries_on_from_the_piece_before() {
        // The pause before "ーーー" is longer than the hooker waits: the line comes in three pieces.
        let line = "「はぁっ、はぁっ、もうだめよぉ、んーーーーーっ」";
        let all = frames(line, 1);
        let first = typewriter_lines(&all[..all.find("「はぁっ、はぁっ、もうだめよぉ、んー").unwrap()]);
        assert_eq!(first, vec!["「はぁっ、はぁっ、もうだめよぉ、ん"]);
        let n = "「はぁっ、はぁっ、もうだめよぉ、ん".chars().count();
        let middle: String = frames(line, n + 1).lines().take(3).map(|f| format!("{f}\n")).collect();
        let carried = typewriter_lines_after(&first[0], &middle).unwrap();
        assert_eq!(carried, vec!["「はぁっ、はぁっ、もうだめよぉ、んーーー"]);
        assert_eq!(typewriter_lines_after(&carried[0], &frames(line, n + 4)).unwrap(), vec![line]);
        // A single frame that finishes it.
        assert_eq!(typewriter_lines_after(&carried[0], line).unwrap(), vec![line]);
        // The next line typed out after it, in the same piece.
        let next = "「何よ……！」";
        assert_eq!(
            typewriter_lines_after(&carried[0], &format!("{line}\n{}", frames(next, 1))).unwrap(),
            vec![line, next]
        );
    }

    #[test]
    fn a_long_line_typed_out_is_read_in_few_steps() {
        let line = "「何よ……！　私をこんな、小さな鍵で、閉じ込めておけるなんて、思い上がりもいいところ、よぉ……！　もうだめよぉ、んーーーーっ」";
        let parse = Parse::new(&frames(line, 1), "");
        let spans = parse.best().unwrap();
        assert_eq!(parse.lines(&spans), vec![line]);
        assert!(parse.steps.get() < MAX_STEPS / 4, "{} steps", parse.steps.get());
        // Text built to be hard is read within the same bound.
        let dashes = Parse::new(&"ー".repeat(3000), "");
        let _ = dashes.best();
        assert!(dashes.steps.get() <= MAX_STEPS + 4_000);
    }

    #[test]
    fn a_piece_that_does_not_carry_on_the_line_before_is_its_own() {
        let before = "「はぁっ、はぁっ、もうだめよぉ、ん";
        assert_eq!(typewriter_lines_after(before, &frames("「何よ……！」", 1)), None);
        assert_eq!(typewriter_lines_after(before, before), None);
        assert_eq!(typewriter_lines_after(before, "テキスト速度のサンプルです。"), None);
    }

    #[test]
    fn sentences_drawn_three_times_come_out_once() {
        let a = "「そ、そうだよな」";
        let b = "今さらやめろと言われても困る。";
        assert_eq!(collapse_repeated_sentences(&format!("{a}{a}{a}{b}{b}{b}")), format!("{a}{b}"));
        // Four times over (a speaker shown under another name: `name＠shown「…」`).
        let named = "りんか＠？？？「と、とんでもないところを見られた……」";
        assert_eq!(collapse_repeated_sentences(&named.repeat(4)), named);
        assert_eq!(collapse_repeated_sentences("「ん？」「ん？」「ん？」"), "「ん？」");
        // Its name and line drawn apart: name, name, line, line, then the two together.
        assert_eq!(collapse_repeated_sentences("りんか＠？？？りんか＠？？？「そこはご想像にお任せするよ」「そこはご想像にお任せするよ」りんか＠？？？「そこはご想像にお任せするよ」"), "りんか＠？？？「そこはご想像にお任せするよ」");
        assert_eq!(collapse_repeated_sentences(&format!("まあ、そういうことだ。涼太{a}涼太{a}")), format!("まあ、そういうことだ。涼太{a}"));
        // Words and short cries said twice are the text.
        for text in ["さらに、ガタッ、ガタッ。そして、ガタッ、ガタッ。", "「うん、うん」", "あはは、あはは！", "今日は猫と一緒に学校へ行きます。"] {
            assert_eq!(collapse_repeated_sentences(text), text);
        }
    }

    #[test]
    fn a_line_typed_out_or_sent_twice_is_one_line() {
        let line = "決して稼ぎの良い仕事ではない。";
        assert!(another_line("", line, 6));
        assert!(!another_line(line, line, 6));
        assert!(!another_line("決して稼ぎの", line, 6));
        assert!(!another_line(line, "決して稼ぎの", 6));
        assert!(another_line(line, "周りの住人からは重宝されている。", 6));
        // A nameplate or a code is not a line.
        assert!(!another_line(line, "セリシア", 6));
        assert!(!another_line(line, "se_21_140_voice", 6));
    }

    #[test]
    fn a_script_going_through_string_functions_is_left_as_it_is_and_quickly() {
        // A script interpreter's source, tens of thousands of characters with a bracket on every line.
        let script = "if⏎(_EXITCODE_==4)⏎next⏎".repeat(2_000);
        let start = std::time::Instant::now();
        assert_eq!(collapse_repeated_sentences(&script), script);
        assert!(start.elapsed() < std::time::Duration::from_millis(100), "{:?}", start.elapsed());
        // The longest a line drawn a few times over can be.
        let line = format!("{}。", "あ".repeat(crate::text_hook::clean::MAX_LINE_CHARS - 1));
        let start = std::time::Instant::now();
        assert_eq!(collapse_repeated_sentences(&line.repeat(3)), line);
        assert!(start.elapsed() < std::time::Duration::from_millis(500), "{:?}", start.elapsed());
    }

    #[test]
    fn a_sentence_that_repeats_a_word_is_not_typed_out() {
        // "は" then "はなと" are prefixes of "はなとやまと…" by chance, not frames.
        let line = "きょうははなとはなとやまとほしとそらをみます。青い空と静かな海が好きです。";
        assert_eq!(typewriter_lines(line), vec![line]);
    }

    #[test]
    fn ordinary_sentences_are_left_alone() {
        assert_eq!(collapse_typewriter("  今日は猫と一緒に学校へ行きます。 "), "今日は猫と一緒に学校へ行きます。");
        assert_eq!(collapse_typewriter("ああ、ああ"), "ああ、ああ");
        assert_eq!(collapse_typewriter("「はい」と「いいえ」"), "「はい」と「いいえ」");
        assert_eq!(collapse_typewriter("ミサキ"), "ミサキ");
    }

    #[test]
    fn on_a_typewriter_game_the_clean_thread_beats_the_one_that_merely_contains_the_line() {
        let fixture = unity();
        let set_text = collapse_typewriter(fixture["setText"].as_str().unwrap());
        let inequality = collapse_typewriter(fixture["opInequality"].as_str().unwrap());
        let candidates = [
            Candidate { key: "inequality", hookcode: "HMF1@mscorlib:System:String:op_Inequality:2:JIT:UNITY", name: "", text: &inequality, recent: 1, count: 1, noise: 0.0 },
            Candidate { key: "set_text", hookcode: "EHMF2@UnityEngine.UI:UnityEngine.UI:Text:set_text:1:JIT:UNITY", name: "", text: &set_text, recent: 1, count: 1, noise: 0.0 },
        ];
        let screen = [
            line("AUTO SKIP LOG", 1290.0, 820.0, 300.0, 24.0),
            line("「旅人は夢だけの記録となってもなおその町に集まり、", 430.0, 880.0, 700.0, 32.0),
            line("お客様の約束に駆けつけたのです」", 450.0, 925.0, 450.0, 32.0),
        ];
        let scored = score(&candidates, &blocks(&screen));
        assert_eq!(scored[0].key, "set_text");
    }

    #[test]
    fn a_path_that_shares_the_window_title_is_never_chosen() {
        let path = "C:\\Users\\me\\Games\\Sample Game\\Sample Game_Data\\StreamingAssets";
        let candidates = [Candidate { key: "path", hookcode: "HQXF1@mscorlib:System:String:Substring:2:JIT:UNITY", name: "", text: path, recent: 1, count: 1, noise: 0.0 }];
        let screen = [
            line("Sample Game", 10.0, 5.0, 200.0, 20.0),
            line("「静かな港町に流れ着いた古い手紙により", 430.0, 880.0, 700.0, 32.0),
        ];
        assert!(score(&candidates, &blocks(&screen)).is_empty());
    }

    #[test]
    fn of_a_text_and_its_shadow_the_unwrapped_copy_wins() {
        let screen = [line("「最後の答えは、少年の手に残されました」", 430.0, 880.0, 700.0, 32.0)];
        let candidates = [
            Candidate { key: "shadow", hookcode: "EHMF2@UnityEngine.UI:UnityEngine.UI:Text:set_text:1:JIT:UNITY", name: "", text: "「最\n後の答えは、\n少年の手に残されました」", recent: 1, count: 1, noise: 0.0 },
            Candidate { key: "text", hookcode: "EHMF2@UnityEngine.UI:UnityEngine.UI:Text:set_text:1:JIT:UNITY", name: "", text: "「最後の答えは、少年の手に残されました」", recent: 1, count: 1, noise: 0.0 },
        ];
        assert_eq!(score(&candidates, &blocks(&screen))[0].key, "text");
    }

    #[test]
    fn managed_hooks_are_named_by_class_and_method() {
        assert_eq!(
            display_name("EHMF2@UnityEngine.UI:UnityEngine.UI:Text:set_text:1:JIT:UNITY", "Text:Text:g:String:String:"),
            "Text.set_text"
        );
        assert_eq!(display_name("HQ-54@0:gdi32.dll:TextOutW", "TextOutW"), "TextOutW");
    }

    fn line(text: &str, x: f64, y: f64, w: f64, h: f64) -> OcrLine {
        OcrLine { text: text.into(), x, y, width: w, height: h }
    }

    /// The fake game's screen: menu items, a vertical title, a HUD, the nameplate and the
    /// dialogue box with furigana over its first line.
    fn screen() -> Vec<OcrLine> {
        vec![
            line("回想", 65.0, 55.0, 76.0, 38.0),
            line("音楽", 65.0, 125.0, 76.0, 38.0),
            line("オート スキップ セーブ", 581.0, 20.0, 200.0, 18.0),
            line("ミサキ", 50.0, 446.0, 72.0, 24.0),
            line("にほんご", 50.0, 511.0, 56.0, 14.0),
            line("今日は猫と一緒に学校へ行きます。", 50.0, 536.0, 448.0, 28.0),
            line("青い空と静かな海が好きです。", 50.0, 596.0, 392.0, 28.0),
        ]
    }

    #[test]
    fn normalising_folds_width_and_drops_punctuation_and_space() {
        assert_eq!(normalize("「ＡＢＣ　今日は、猫！」"), "abc今日は猫");
        assert_eq!(normalize("ラーメン…"), "ラーメン");
    }

    #[test]
    fn the_dialogue_box_is_the_largest_block_and_keeps_its_furigana() {
        let blocks = blocks(&screen());
        let largest = blocks.iter().max_by(|a, b| a.area.total_cmp(&b.area)).unwrap();
        assert_eq!(largest.text, "にほんご今日は猫と一緒に学校へ行きます青い空と静かな海が好きです");
        assert!(blocks.iter().any(|b| b.text == "ミサキ"));
    }

    #[test]
    fn the_dialogue_thread_beats_the_nameplate_hud_and_menu() {
        let candidates = [
            Candidate { key: "name", hookcode: "HQ-24@0:user32.dll:DrawTextW", name: "", text: "ミサキ", recent: 1, count: 1, noise: 0.0 },
            Candidate { key: "hud", hookcode: "HQ-24@0:user32.dll:DrawTextExW", name: "", text: "オート　スキップ　セーブ", recent: 1, count: 1, noise: 0.0 },
            Candidate { key: "menu", hookcode: "HQ-24@0:gdiplus.dll:GdipDrawString", name: "", text: "回想音楽想回日本語の本を読むにほんご", recent: 1, count: 1, noise: 0.0 },
            Candidate {
                key: "dialogue",
                hookcode: "HQ-54@0:gdi32.dll:TextOutW",
                name: "",
                text: "今日は猫と一緒に学校へ行きます。青い空と静かな海が好きです。",
                recent: 1,
                count: 1,
                noise: 0.0,
            },
        ];
        let scored = score(&candidates, &blocks(&screen()));
        assert_eq!(scored[0].key, "dialogue");
        assert!(scored[0].in_largest);
        // The nameplate is too short to count at all.
        assert!(!scored.iter().any(|s| s.key == "name"));
    }

    #[test]
    fn a_previous_line_is_not_on_screen_and_does_not_match() {
        let candidates = [Candidate {
            key: "dialogue",
            hookcode: "HQ-54@0:gdi32.dll:TextOutW",
            name: "",
            text: "明日は友達と日本語の本を読みます。青い空と静かな海が好きです。",
            recent: 1,
            count: 1,
            noise: 0.0,
        }];
        // Only the unchanged second line is on screen; it is inside the sentence, so it still
        // counts, but for its own length and never as the whole sentence.
        let scored = score(&candidates, &blocks(&screen()));
        assert!(scored.is_empty() || scored[0].matched < 20);
    }

    #[test]
    fn a_name_matched_outside_the_dialogue_box_is_not_chosen() {
        let s = |key: &str, effective: f64, in_largest: bool| Scored { key: key.into(), score: effective, matched: effective as usize, effective, in_largest };
        // The nameplate matched exactly; the line, misread, did not match at all.
        assert!(chosen(&[s("name", 10.0, false)], 6.0).is_none());
        // The line in the dialogue box, behind a better-scored name.
        assert_eq!(chosen(&[s("name", 10.0, false), s("line", 8.0, true)], 6.0).unwrap().key, "line");
        // A long line outside the largest text (a game whose largest text is a menu) still counts.
        assert_eq!(chosen(&[s("line", 20.0, false)], 6.0).unwrap().key, "line");
    }

    #[test]
    fn engine_hooks_win_ties_and_floods_lose() {
        let blocks = vec![Block { text: normalize("今日は猫と一緒に学校へ行きます"), area: 100.0 }];
        let text = "今日は猫と一緒に学校へ行きます";
        let candidates = [
            Candidate { key: "api", hookcode: "HQ-54@0:gdi32.dll:TextOutW", name: "", text, recent: 1, count: 1, noise: 0.0 },
            Candidate { key: "engine", hookcode: "HS-8@1A2B3:Game.exe", name: "", text, recent: 1, count: 1, noise: 0.0 },
            Candidate { key: "flood", hookcode: "HS-4@4C5D6:Game.exe", name: "", text, recent: 40, count: 1, noise: 0.0 },
        ];
        let scored = score(&candidates, &blocks);
        assert_eq!(scored.iter().map(|s| s.key.as_str()).collect::<Vec<_>>(), ["engine", "api", "flood"]);
    }

    #[test]
    fn a_script_engines_own_hook_beats_its_runtimes_strings() {
        // TyranoScript on Electron: LunaHook's tyranoscript hook sends the line; V8's string
        // functions send it too, with the speaker's name drawn above it in the same box.
        let screen = [line("お母さん", 120.0, 560.0, 120.0, 30.0), line("おはよう。今日は朝から雨だよ。早く梅雨明けしないもんかね。", 120.0, 600.0, 900.0, 30.0)];
        let candidates = [
            Candidate { key: "v8", hookcode: "HVX0@292530:game.exe", name: "v8::String::Write", text: "お母さんおはよう。今日は朝から雨だよ。早く梅雨明けしないもんかね。", recent: 1, count: 16, noise: 0.0 },
            Candidate { key: "tyrano", hookcode: "EXHQXFN0@8CDC0:LunaHook64.dll", name: "tyranoscript", text: "おはよう。今日は朝から雨だよ。早く梅雨明けしないもんかね。\n", recent: 1, count: 9, noise: 0.0 },
        ];
        let scored = score(&candidates, &blocks(&screen));
        assert_eq!(scored[0].key, "tyrano");
        assert!(is_generic("HVX0@292530:game.exe", "v8::String::Length"));
        assert!(!is_generic("EXHQXFN0@8CDC0:LunaHook64.dll", "tyranoscript"));
    }

    #[test]
    fn a_unity_text_box_beats_the_runtimes_strings() {
        // Unity Mono with a script interpreter: `String` methods see each line as the script
        // handles it (ahead of showing it); TextMeshPro's setter, as it is shown.
        let screen = [line("これではまるで妖精だ。", 200.0, 600.0, 600.0, 30.0)];
        let candidates = [
            Candidate { key: "string", hookcode: "HMF1@mscorlib:System:String:op_Inequality:2:JIT:UNITY", name: "String.op_Inequality", text: "これではまるで妖精だ。", recent: 1, count: 61, noise: 0.0 },
            Candidate { key: "tmp", hookcode: "EXHMXF2@Unity.TextMeshPro:TMPro:TMP_Text:set_text:1:JIT:UNITY", name: "TMP_Text.set_text", text: "これではまるで妖精だ。", recent: 1, count: 61, noise: 0.0 },
        ];
        assert_eq!(score(&candidates, &blocks(&screen))[0].key, "tmp");
        assert!(is_generic("HQXF1@mscorlib:System:String:Substring:2:JIT:UNITY", "String.Substring"));
    }

    #[test]
    fn of_threads_showing_the_line_a_lasting_clean_one_wins() {
        // SiglusEngine: one hook starts a thread per line (its context counts up), another keeps
        // one thread for every line.
        let blocks = vec![Block { text: normalize("「本当ですか？　助かります」"), area: 100.0 }];
        let text = "「本当ですか？　助かります」";
        let candidates = [
            Candidate { key: "per-line", hookcode: "HWXN0@1A2B3:Game.exe", name: "", text, recent: 1, count: 1, noise: 0.0 },
            Candidate { key: "lasting", hookcode: "HW-4@4C5D6:Game.exe", name: "", text, recent: 1, count: 12, noise: 0.0 },
            // The same hook in another context: the dialogue, mixed in with the script's codes.
            Candidate { key: "mixed", hookcode: "HW-4@4C5D6:Game.exe", name: "", text, recent: 1, count: 40, noise: 0.6 },
        ];
        let order: Vec<String> = score(&candidates, &blocks).into_iter().map(|s| s.key).collect();
        assert_eq!(order, ["lasting", "per-line", "mixed"]);
    }

    #[test]
    fn signatures_keep_only_the_low_halves_of_the_contexts() {
        let a = Signature::new("HQ-54@0:gdi32.dll:TextOutW", 0x7ff6_1234_503a, 0);
        let b = Signature::new("HQ-54@0:gdi32.dll:TextOutW", 0x7ff7_9999_503a, 0);
        assert_eq!(a, b);
        assert_eq!(a.ctx, 0x503a);
    }
}


