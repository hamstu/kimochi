//! The recent texthooker lines, as the Log received them, and which stretch of audio belongs to
//! a mined one.
//!
//! A card is anchored on the line's arrival, not on when the card was added: the line's voice
//! plays from about when its text appeared until the next line replaced it. A hooked line
//! (WebSocket, clipboard) arrives as its text appears; an OCR'd line arrives after the scan
//! settles, so its voice may have started a second or more earlier, and the window reaches
//! further back for it.
use std::collections::VecDeque;

/// Lines kept: far more than any audio buffer covers.
const KEEP: usize = 300;
/// How far before its arrival a line's voice may start.
const LEAD_HOOKED_MS: f64 = 300.0;
const LEAD_OCR_MS: f64 = 1_500.0;
/// How long the voice may run on after the next line arrived.
const TAIL_MS: f64 = 300.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub uid: String,
    pub text: String,
    /// Arrival, in Unix milliseconds.
    pub ts: f64,
    pub ocr: bool,
}

/// The audio to cut for a line, in Unix milliseconds. `anchor` is the line's arrival.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Window {
    pub from: f64,
    pub to: f64,
    pub anchor: f64,
}

#[derive(Default)]
pub struct Timeline {
    lines: VecDeque<Line>,
}

impl Timeline {
    /// A line arrived, or (same uid) its text changed: a start-merge keeps the arrival time.
    pub fn record(&mut self, line: Line) {
        if let Some(known) = self.lines.iter_mut().find(|l| l.uid == line.uid) {
            known.text = line.text;
            return;
        }
        let at = self.lines.partition_point(|l| l.ts <= line.ts);
        self.lines.insert(at, line);
        while self.lines.len() > KEEP {
            self.lines.pop_front();
        }
    }

    pub fn clear(&mut self) {
        self.lines.clear();
    }

    /// The line a card was made from: the newest whose text best matches one of `texts` (the
    /// card's sentence, or every field of an extension's card), else the newest line.
    pub fn mined(&self, texts: &[&str]) -> Option<&Line> {
        let wanted: Vec<String> = texts.iter().map(|t| normalize(t)).filter(|t| !t.is_empty()).collect();
        let mut best: Option<(u8, &Line)> = None;
        for line in self.lines.iter().rev() {
            let text = normalize(&line.text);
            if text.is_empty() {
                continue;
            }
            let score = wanted.iter().map(|w| similarity(&text, w)).max().unwrap_or(0);
            if score > best.map_or(0, |(s, _)| s) {
                best = Some((score, line));
            }
        }
        best.map(|(_, line)| line).or_else(|| self.lines.back())
    }

    /// The audio that belongs to `line`, as of `now`: from shortly before it arrived (never
    /// before the previous line arrived) to shortly after the next line arrived, or `now`.
    /// At most `max_ms` long.
    pub fn window(&self, line: &Line, now: f64, max_ms: f64) -> Window {
        let index = self.lines.iter().position(|l| l.uid == line.uid);
        let previous = index.and_then(|i| i.checked_sub(1)).and_then(|i| self.lines.get(i));
        let next = index.and_then(|i| self.lines.get(i + 1));
        let lead = if line.ocr { LEAD_OCR_MS } else { LEAD_HOOKED_MS };
        let mut from = line.ts - lead;
        if let Some(previous) = previous {
            from = from.max(previous.ts.min(line.ts));
        }
        let to = next.map_or(now, |n| (n.ts + TAIL_MS).min(now)).max(line.ts);
        Window { from, to: to.min(from + max_ms), anchor: line.ts }
    }
}

/// Text as compared: no markup, no furigana brackets' readings, no spaces.
pub fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    let mut in_reading = false;
    for c in text.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            // Anki furigana: 猫[ねこ]
            '[' if !in_tag => in_reading = true,
            ']' if in_reading => in_reading = false,
            _ if in_tag || in_reading || c.is_whitespace() => {}
            _ => out.push(c),
        }
    }
    out.replace("&nbsp;", "")
}

/// How well a card's text names a line: 3 the same text, 2 the card's text holds the whole line
/// (the line in a sentence field with more around it), 1 the line holds the card's text and that
/// is sentence-sized (Yomitan cuts the sentence around the word out of a longer line), 0 no match.
/// A single looked-up word inside a line is not a match: it would pick any line using the word.
fn similarity(line: &str, card: &str) -> u8 {
    let sentence_sized = card.chars().count() >= 6 || card.chars().count() * 2 >= line.chars().count();
    if line == card {
        3
    } else if card.contains(line) && line.chars().count() >= 2 {
        2
    } else if line.contains(card) && sentence_sized {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(uid: &str, text: &str, ts: f64) -> Line {
        Line { uid: uid.into(), text: text.into(), ts, ocr: false }
    }

    fn timeline(lines: &[(&str, &str, f64)]) -> Timeline {
        let mut t = Timeline::default();
        for (uid, text, ts) in lines {
            t.record(line(uid, text, *ts));
        }
        t
    }

    #[test]
    fn the_card_names_its_line_by_its_sentence() {
        let t = timeline(&[
            ("a", "猫が好きです。", 1_000.0),
            ("b", "今日はいい天気ですね。散歩に行きましょう。", 2_000.0),
            ("c", "猫がいる。", 3_000.0),
        ]);
        assert_eq!(t.mined(&["今日はいい天気ですね。"]).unwrap().uid, "b", "a sentence cut out of a longer line");
        assert_eq!(t.mined(&["<b>猫</b>が好きです。"]).unwrap().uid, "a", "markup is ignored");
        assert_eq!(t.mined(&["猫", "ねこ", "cat", "猫が好きです。"]).unwrap().uid, "a", "one of the card's fields");
        assert_eq!(t.mined(&["猫"]).unwrap().uid, "c", "a lone word matches no line: the newest");
        assert_eq!(t.mined(&[]).unwrap().uid, "c");
        assert!(Timeline::default().mined(&["x"]).is_none());
    }

    #[test]
    fn the_newest_of_equal_matches_wins() {
        let t = timeline(&[("a", "はい。", 1_000.0), ("b", "いいえ。", 2_000.0), ("c", "はい。", 3_000.0)]);
        assert_eq!(t.mined(&["はい。"]).unwrap().uid, "c");
    }

    #[test]
    fn a_line_runs_from_its_arrival_to_the_next_line() {
        let t = timeline(&[("a", "一", 1_000.0), ("b", "二", 5_000.0), ("c", "三", 9_000.0)]);
        let b = t.mined(&["二"]).unwrap();
        assert_eq!(t.window(b, 20_000.0, 30_000.0), Window { from: 4_700.0, to: 9_300.0, anchor: 5_000.0 });
        // The newest line runs until now.
        let c = t.mined(&["三"]).unwrap();
        assert_eq!(t.window(c, 12_000.0, 30_000.0).to, 12_000.0);
        // And never longer than asked.
        assert_eq!(t.window(c, 60_000.0, 10_000.0).to, 8_700.0 + 10_000.0);
    }

    #[test]
    fn an_ocr_line_reaches_further_back_but_not_past_the_previous_line() {
        let mut t = timeline(&[("a", "一", 1_000.0)]);
        t.record(Line { uid: "b".into(), text: "二".into(), ts: 5_000.0, ocr: true });
        t.record(Line { uid: "c".into(), text: "三".into(), ts: 5_800.0, ocr: true });
        let b = t.mined(&["二"]).unwrap().clone();
        assert_eq!(t.window(&b, 9_000.0, 30_000.0).from, 3_500.0);
        let c = t.mined(&["三"]).unwrap().clone();
        assert_eq!(t.window(&c, 9_000.0, 30_000.0).from, 5_000.0, "the previous line's arrival");
    }

    #[test]
    fn a_merged_line_keeps_its_arrival_and_lines_stay_in_time_order() {
        let mut t = timeline(&[("a", "こんに", 1_000.0), ("b", "後", 3_000.0)]);
        t.record(line("a", "こんにちは", 2_500.0));
        t.record(line("z", "前", 2_000.0));
        let uids: Vec<_> = t.lines.iter().map(|l| (l.uid.as_str(), l.ts)).collect();
        assert_eq!(uids, vec![("a", 1_000.0), ("z", 2_000.0), ("b", 3_000.0)]);
        assert_eq!(t.mined(&["こんにちは"]).unwrap().uid, "a");
    }

    #[test]
    fn furigana_and_spaces_do_not_hide_a_match() {
        assert_eq!(normalize("<span>猫[ねこ]が 好[す]き</span>&nbsp;"), "猫が好き");
    }
}
