//! Where a line was spoken: the line's text lined up against the characters the recogniser
//! heard (`sense_voice`), as a local alignment (Smith-Waterman), so a wrong guess here and there,
//! an OCR slip, or kana where the line has kanji costs a few characters rather than the match.
//!
//! A kanji on either side may stand for its reading in kana on the other (`readings`): the
//! recogniser writes わかった where the script has 分かった, and 為 where it has ため.
//!
//! The text on both sides is folded first: full-width letters to ASCII, katakana to hiragana,
//! and punctuation, spaces, long-vowel marks, small vowels and small tsu dropped (the recogniser
//! rarely writes them the way a script does).
//!
//! A match gives the stretch to cut (snapped out to where the voice starts and stops when the
//! match reaches the speech's edges) and a time for every character of the line, which is what
//! cuts a single word's audio out of it.
use crate::sense_voice::HeardChar;

const MATCH: i32 = 2;
/// A kanji stands for at most this many kana of its reading (after folding).
const MAX_RUN: usize = 4;

#[derive(Clone, Copy, PartialEq)]
enum Step {
    Stop,
    Diagonal,
    Up,
    Left,
    /// The line's kanji, said as this many heard kana.
    LineKanji(u8),
    /// A heard kanji, written as this many of the line's kana.
    HeardKanji(u8),
}
const MISMATCH: i32 = -1;
const GAP: i32 = -1;
/// The voice is taken to start this long before the first character's frame.
const LEAD_MS: f64 = 100.0;
/// A character's sound runs at most this long when no character follows it.
const LAST_CHAR_MS: f64 = 300.0;
const MAX_CHAR_MS: f64 = 400.0;
/// The match reaches the speech's start when it leaves at most this many characters before it,
/// and the speech starts at most this long before its first character.
const EDGE_CHARS: usize = 2;
const EDGE_START_MS: f64 = 700.0;
const EDGE_END_MS: f64 = 1_000.0;
/// ... and a little longer for each of the line's characters beyond the match.
const EDGE_CHAR_MS: f64 = 200.0;

/// One stretch of speech and the characters heard in it, in Unix ms.
#[derive(Debug, Clone, PartialEq)]
pub struct Heard {
    pub start_ms: f64,
    pub end_ms: f64,
    pub chars: Vec<HeardChar>,
}

impl Heard {
    /// `chars`' times are from `start_ms`.
    pub fn new(start_ms: f64, end_ms: f64, chars: Vec<HeardChar>) -> Self {
        let chars = chars
            .into_iter()
            .map(|c| HeardChar {
                ch: c.ch,
                ms: start_ms + c.ms,
            })
            .collect();
        Self {
            start_ms,
            end_ms,
            chars,
        }
    }

    pub fn text(&self) -> String {
        self.chars.iter().map(|c| c.ch).collect()
    }
}

/// Where a line was heard.
#[derive(Debug, Clone, PartialEq)]
pub struct Match {
    /// The share of the line's (folded) characters heard, 0..1.
    pub score: f64,
    /// The stretch to cut, in Unix ms: the voice, before padding.
    pub start_ms: f64,
    pub end_ms: f64,
    /// What was heard over the match.
    pub heard: String,
    /// When the first and last characters the match heard were spoken: what it holds of the
    /// speech, which no other line can then be matched to.
    pub heard_from_ms: f64,
    pub heard_to_ms: f64,
    /// The match begins at the line's first characters (its first three, heard in a row).
    pub from_line_start: bool,
    /// Character boundaries: line character `i` (by `char`) was spoken from `char_ms[i]` to
    /// `char_ms[i + 1]`.
    pub char_ms: Vec<f64>,
}

/// Text as matched, and for each character kept the index (by `char`) it came from.
pub fn fold(text: &str) -> (Vec<char>, Vec<usize>) {
    let mut chars = Vec::new();
    let mut from = Vec::new();
    for (i, c) in text.chars().enumerate() {
        let c = match c {
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            '\u{30A1}'..='\u{30F6}' => char::from_u32(c as u32 - 0x60).unwrap_or(c),
            _ => c,
        };
        let dropped = !c.is_alphanumeric()
            || matches!(c, 'ー' | 'っ' | 'ぁ' | 'ぃ' | 'ぅ' | 'ぇ' | 'ぉ' | 'ゎ');
        if !dropped {
            chars.push(c.to_ascii_lowercase());
            from.push(i);
        }
    }
    (chars, from)
}

/// Where `line` was spoken among `heard`, looking at speech that overlaps `from_ms..to_ms`; of
/// equally good places, the one starting nearest `prefer_ms`. None when nothing matches at all.
pub fn find(line: &str, heard: &[Heard], from_ms: f64, to_ms: f64) -> Option<Match> {
    find_near(line, heard, from_ms, to_ms, from_ms)
}

pub fn find_near(
    line: &str,
    heard: &[Heard],
    from_ms: f64,
    to_ms: f64,
    prefer_ms: f64,
) -> Option<Match> {
    let (want, want_from) = fold(line);
    if want.is_empty() {
        return None;
    }
    // The heard characters, folded, with the segment and position each came from.
    struct Got {
        ch: char,
        segment: usize,
        index: usize,
    }
    let mut got = Vec::new();
    for (s, segment) in heard.iter().enumerate() {
        if segment.end_ms < from_ms || segment.start_ms > to_ms {
            continue;
        }
        for (index, c) in segment.chars.iter().enumerate() {
            let (folded, _) = fold(&c.ch.to_string());
            if let Some(&ch) = folded.first() {
                got.push(Got {
                    ch,
                    segment: s,
                    index,
                });
            }
        }
    }
    if got.is_empty() {
        return None;
    }
    // Smith-Waterman: score[i][j] for want[..i] against got[..j], and the step that got there.
    // Besides the usual steps, a kanji on either side may stand for a run of kana on the other
    // that is one of its readings (`readings`): a line's 分かった and a heard わかった.
    let (n, m) = (want.len(), got.len());
    let width = m + 1;
    let mut score = vec![0i32; (n + 1) * width];
    let mut step = vec![Step::Stop; (n + 1) * width];
    let kanji_at = |chars: &dyn Fn(usize) -> char, k: usize| -> Option<&'static [Vec<char>]> {
        // 々 repeats the kanji before it.
        let c = chars(k);
        if c == '々' && k > 0 { crate::readings::of(chars(k - 1)) } else { crate::readings::of(c) }
    };
    let line_char = |k: usize| want[k];
    let heard_char = |k: usize| got[k].ch;
    // Kana a reading can stand for: hiragana as written. Katakana is how a script and the
    // recogniser write names and loanwords (フリッツ), which no kanji's reading stands for.
    let original: Vec<char> = line.chars().collect();
    let line_hiragana: Vec<bool> = want_from.iter().map(|&k| crate::readings::is_kana(original[k])).collect();
    let heard_hiragana: Vec<bool> = got.iter().map(|g| crate::readings::is_kana(heard[g.segment].chars[g.index].ch)).collect();
    for i in 1..=n {
        let line_kanji = kanji_at(&line_char, i - 1);
        for j in 1..=m {
            let same = want[i - 1] == got[j - 1].ch;
            let mut best = (0, Step::Stop);
            let mut consider = |value: i32, s: Step| {
                if value > best.0 {
                    best = (value, s);
                }
            };
            consider(score[(i - 1) * width + j - 1] + if same { MATCH } else { MISMATCH }, Step::Diagonal);
            consider(score[(i - 1) * width + j] + GAP, Step::Up);
            consider(score[i * width + j - 1] + GAP, Step::Left);
            if !same {
                // A kanji of the line said as the kana heard.
                if let Some(readings) = line_kanji {
                    for k in 1..=MAX_RUN.min(j) {
                        let run: Vec<char> = got[j - k..j].iter().map(|g| g.ch).collect();
                        if !heard_hiragana[j - k..j].iter().all(|&h| h) {
                            break;
                        }
                        if crate::readings::reads(readings, &run) {
                            consider(score[(i - 1) * width + j - k] + MATCH, Step::LineKanji(k as u8));
                        }
                    }
                }
                // A kanji heard, written in kana in the line.
                if let Some(readings) = kanji_at(&heard_char, j - 1) {
                    for k in 1..=MAX_RUN.min(i) {
                        let run = &want[i - k..i];
                        if !line_hiragana[i - k..i].iter().all(|&h| h) {
                            break;
                        }
                        if crate::readings::reads(readings, run) {
                            consider(score[(i - k) * width + j - 1] + MATCH * k as i32, Step::HeardKanji(k as u8));
                        }
                    }
                }
            }
            score[i * width + j] = best.0;
            step[i * width + j] = best.1;
        }
    }
    let best = *score.iter().max()?;
    if best < MATCH {
        return None;
    }
    // Trace each cell holding the best score back to its pairs (line character, heard character
    // it was said in); keep the one nearest `prefer_ms`.
    let trace = |mut i: usize, mut j: usize| {
        let mut pairs = Vec::new();
        while i > 0 && j > 0 && score[i * width + j] > 0 {
            match step[i * width + j] {
                Step::Diagonal => {
                    if want[i - 1] == got[j - 1].ch {
                        pairs.push((i - 1, j - 1));
                    }
                    i -= 1;
                    j -= 1;
                }
                Step::Up => i -= 1,
                Step::Left => j -= 1,
                Step::LineKanji(k) => {
                    pairs.push((i - 1, j - k as usize));
                    i -= 1;
                    j -= k as usize;
                }
                Step::HeardKanji(k) => {
                    for q in (i - k as usize..i).rev() {
                        pairs.push((q, j - 1));
                    }
                    i -= k as usize;
                    j -= 1;
                }
                Step::Stop => break,
            }
        }
        pairs.reverse();
        pairs
    };
    let time = |g: &Got| heard[g.segment].chars[g.index].ms;
    let pairs = (0..score.len())
        .filter(|&k| score[k] == best)
        .map(|k| trace(k / width, k % width))
        .filter(|p| !p.is_empty())
        .min_by(|a, b| {
            let distance = |p: &[(usize, usize)]| (time(&got[p[0].1]) - prefer_ms).abs();
            distance(a).total_cmp(&distance(b))
        })?;

    let (first, last) = (&got[pairs[0].1], &got[pairs[pairs.len() - 1].1]);
    let first_segment = &heard[first.segment];
    let last_segment = &heard[last.segment];
    let first_ms = time(first);
    let last_end = char_end(last_segment, last.index);
    // The match reaches the speech's edge when what was heard beyond it is no more than the
    // line's own unmatched characters there (a garbled first word), give or take `EDGE_CHARS`.
    let (first_pair, last_pair) = (pairs[0], pairs[pairs.len() - 1]);
    let heard_before = got[..first_pair.1].iter().filter(|g| g.segment == first.segment).count();
    let heard_after = got[last_pair.1 + 1..].iter().filter(|g| g.segment == last.segment).count();
    let (line_before, line_after) = (first_pair.0, n - 1 - last_pair.0);
    let start_ms = if heard_before <= line_before + EDGE_CHARS
        && first_ms - first_segment.start_ms <= EDGE_START_MS + EDGE_CHAR_MS * line_before as f64
    {
        first_segment.start_ms
    } else {
        first_ms - LEAD_MS
    };
    let end_ms = if heard_after <= line_after + EDGE_CHARS
        && last_segment.end_ms - last_end <= EDGE_END_MS + EDGE_CHAR_MS * line_after as f64
    {
        last_segment.end_ms.max(last_end)
    } else if let Some(next) = got.get(last_pair.1 + 1).filter(|g| g.segment == last.segment) {
        // The next line's voice follows in the same breath: stop where it starts.
        time(next).min(last_end)
    } else {
        last_end
    };
    let heard_text = got[pairs[0].1..=pairs[pairs.len() - 1].1]
        .iter()
        .map(|g| g.ch)
        .collect();

    // A time for every folded character of the line: matched ones from what was heard, the
    // others spread evenly between their matched neighbours.
    let mut at: Vec<Option<f64>> = vec![None; n];
    for &(i, j) in &pairs {
        at[i] = Some(time(&got[j]));
    }
    let (first_i, last_i) = (pairs[0].0, pairs[pairs.len() - 1].0);
    let pace = if last_i > first_i {
        (time(last) - first_ms) / (last_i - first_i) as f64
    } else {
        120.0
    };
    for i in 0..n {
        if at[i].is_some() {
            continue;
        }
        at[i] = Some(if i < first_i {
            (first_ms - pace * (first_i - i) as f64).max(start_ms)
        } else if i > last_i {
            (time(last) + pace * (i - last_i) as f64).min(end_ms)
        } else {
            let before = (0..i).rev().find_map(|k| at[k].map(|t| (k, t))).unwrap();
            let after = (i + 1..n)
                .find(|&k| pairs.iter().any(|p| p.0 == k))
                .map(|k| (k, at[k].unwrap()))
                .unwrap();
            before.1 + (after.1 - before.1) * (i - before.0) as f64 / (after.0 - before.0) as f64
        });
    }
    // Boundaries for every original character: a character that was folded away (punctuation)
    // takes the time of the next one kept.
    let total = line.chars().count();
    let mut char_ms = vec![end_ms; total + 1];
    let mut k = 0;
    for (i, slot) in char_ms.iter_mut().take(total).enumerate() {
        while k < n && want_from[k] < i {
            k += 1;
        }
        if k < n {
            *slot = at[k].unwrap_or(end_ms);
        }
    }
    for i in 1..=total {
        char_ms[i] = char_ms[i].max(char_ms[i - 1]);
    }

    // Its first three characters heard in a row (a kanji said as several kana counts as one).
    let from_line_start = pairs.len() >= 3
        && pairs[..3].iter().enumerate().all(|(k, &(i, j))| i == k && j >= pairs[0].1 && j <= pairs[0].1 + k * MAX_RUN);
    Some(Match {
        from_line_start,
        score: pairs.len() as f64 / n as f64,
        start_ms,
        end_ms,
        heard: heard_text,
        heard_from_ms: first_ms,
        heard_to_ms: time(last),
        char_ms,
    })
}

/// When the sound of character `index` in `segment` ends: where the next one starts, or a little
/// after it at the speech's end.
fn char_end(segment: &Heard, index: usize) -> f64 {
    let ms = segment.chars[index].ms;
    match segment.chars.get(index + 1) {
        Some(next) => next.ms.min(ms + MAX_CHAR_MS),
        None => (ms + LAST_CHAR_MS).min(segment.end_ms.max(ms + 60.0)),
    }
}

/// Where `word` was spoken in a line whose characters were spoken at `char_ms` (`Match::char_ms`):
/// the word as written in the line, else as folded, else its longest start found (a dictionary
/// form, 食べる, in a line that says 食べた). In Unix ms.
pub fn word_span(line: &str, word: &str, char_ms: &[f64]) -> Option<(f64, f64)> {
    let chars: Vec<char> = line.chars().collect();
    let target: Vec<char> = word.trim().chars().collect();
    if target.is_empty() || char_ms.len() != chars.len() + 1 {
        return None;
    }
    let find = |needle: &[char]| {
        (0..=chars.len().saturating_sub(needle.len())).find(|&i| chars[i..].starts_with(needle))
    };
    let (start, len) = if let Some(i) = find(&target) {
        (i, target.len())
    } else {
        let (folded, from) = fold(line);
        let (want, _) = fold(word);
        let found = (!want.is_empty())
            .then(|| {
                (0..=folded.len().saturating_sub(want.len()))
                    .find(|&i| folded[i..].starts_with(&want))
            })
            .flatten();
        if let Some(i) = found {
            (from[i], from[i + want.len() - 1] + 1 - from[i])
        } else {
            let shortest = if target.len() >= 2 { 2 } else { 1 };
            (shortest..target.len())
                .rev()
                .find_map(|len| find(&target[..len]).map(|i| (i, len)))?
        }
    };
    Some((char_ms[start], char_ms[start + len]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A segment heard from `start`, a character every 120 ms from `start + 200`.
    fn heard(start: f64, text: &str) -> Heard {
        let chars: Vec<HeardChar> = text
            .chars()
            .enumerate()
            .map(|(i, ch)| HeardChar {
                ch,
                ms: 200.0 + i as f64 * 120.0,
            })
            .collect();
        let end = start + 200.0 + text.chars().count() as f64 * 120.0 + 150.0;
        Heard::new(start, end, chars)
    }

    #[test]
    fn folding_ignores_how_the_text_is_written() {
        assert_eq!(
            fold("フリッツ先生、このお店ですか？")
                .0
                .iter()
                .collect::<String>(),
            "ふりつ先生このお店ですか"
        );
        assert_eq!(
            fold("わあ〜っ。ＡＢｃ…！").0.iter().collect::<String>(),
            "わあabc"
        );
        assert_eq!(fold("「はい」").1, vec![1, 2]);
    }

    #[test]
    fn a_line_is_found_in_what_was_heard_despite_slips() {
        let segments = [
            heard(0.0, "今日はいい天気ですね"),
            heard(3_000.0, "小サー味作りうまくいくといいね"),
        ];
        let m = find(
            "コサージュ作り、上手くいくといいね",
            &segments,
            0.0,
            10_000.0,
        )
        .unwrap();
        assert!(m.score > 0.5 && m.score < 1.0, "{m:?}");
        assert_eq!(
            m.start_ms, 3_000.0,
            "the match reaches the speech's start: snapped to it"
        );
        assert_eq!(m.end_ms, segments[1].end_ms);
        let exact = find("今日はいい天気ですね。", &segments, 0.0, 10_000.0).unwrap();
        assert_eq!(
            (exact.score, exact.start_ms, exact.end_ms),
            (1.0, 0.0, segments[0].end_ms)
        );
    }

    #[test]
    fn a_line_in_the_middle_of_longer_speech_is_cut_out_of_it() {
        // Two lines read without a pause between them: one segment.
        let segment = heard(1_000.0, "おはようございます今日もよろしくお願いします");
        let m = find(
            "今日もよろしくお願いします",
            std::slice::from_ref(&segment),
            0.0,
            20_000.0,
        )
        .unwrap();
        let today = segment.chars.iter().position(|c| c.ch == '今').unwrap();
        assert_eq!(m.start_ms, segment.chars[today].ms - LEAD_MS);
        assert_eq!(m.end_ms, segment.end_ms);
        let first = find(
            "おはようございます",
            std::slice::from_ref(&segment),
            0.0,
            20_000.0,
        )
        .unwrap();
        assert_eq!(first.start_ms, 1_000.0);
        assert_eq!(
            first.end_ms, segment.chars[today].ms,
            "ends where the next line's voice starts"
        );
    }

    #[test]
    fn speech_outside_the_window_and_unrelated_speech_do_not_match() {
        let segments = [heard(0.0, "猫が好きです"), heard(10_000.0, "全然違う話")];
        assert!(find("猫が好きです", &segments, 5_000.0, 20_000.0).is_none_or(|m| m.score < 0.3));
        assert!(
            find("！", &segments, 0.0, 20_000.0).is_none(),
            "nothing to match by"
        );
    }

    #[test]
    fn kanji_and_kana_line_up_by_their_readings() {
        // The script's kanji, heard in kana.
        let m = find("分かった。伝えておくよ", &[heard(0.0, "わかったつたえておくよ")], 0.0, 1e4).unwrap();
        assert!(m.score > 0.9, "{m:?}");
        assert_eq!(m.char_ms.len(), "分かった。伝えておくよ".chars().count() + 1);
        // The script's kana, heard as kanji.
        let m = find("そのためなら", &[heard(0.0, "その為なら")], 0.0, 1e4).unwrap();
        assert_eq!(m.score, 1.0, "{m:?}");
        // Words that only share a kana are not lined up by it.
        let other = find("分かった", &[heard(0.0, "ためいき")], 0.0, 1e4);
        assert!(other.as_ref().is_none_or(|m| m.score < 0.5), "{other:?}");
        // A name in katakana is not a kanji's reading: フリッツ is not 不立.
        let name = find("フリッツ", &[heard(0.0, "不立")], 0.0, 1e4);
        assert!(name.is_none(), "{name:?}");
    }

    #[test]
    fn of_two_equal_places_the_one_nearest_the_line_wins() {
        let segments = [
            heard(0.0, "はい"),
            heard(5_000.0, "はい"),
            heard(9_000.0, "はい"),
        ];
        let m = find_near("はいっ！", &segments, 0.0, 20_000.0, 5_100.0).unwrap();
        assert_eq!(m.start_ms, 5_000.0);
    }

    #[test]
    fn every_character_of_the_line_gets_a_time_and_words_are_found_by_them() {
        let segment = heard(0.0, "今日はいい天気ですね");
        let line = "今日は、いい天気ですね。";
        let m = find(line, std::slice::from_ref(&segment), 0.0, 10_000.0).unwrap();
        assert_eq!(m.char_ms.len(), line.chars().count() + 1);
        assert!(
            m.char_ms.windows(2).all(|w| w[0] <= w[1]),
            "{:?}",
            m.char_ms
        );
        let (from, to) = word_span(line, "天気", &m.char_ms).unwrap();
        let ten = segment.chars.iter().position(|c| c.ch == '天').unwrap();
        assert_eq!(from, segment.chars[ten].ms);
        assert_eq!(to, segment.chars[ten + 2].ms);
        assert!(
            word_span(line, "テンキ", &m.char_ms).is_none(),
            "a reading the line does not have"
        );
        let (a, b) = word_span(
            "ご飯を食べた",
            "食べる",
            &find("ご飯を食べた", &[heard(0.0, "ご飯を食べた")], 0.0, 1e4).unwrap().char_ms,
        )
        .unwrap();
        assert!(b > a, "the dictionary form's stem");
    }
}
