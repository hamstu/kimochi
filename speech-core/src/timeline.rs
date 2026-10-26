//! The recent Log lines, as the Log received them, and which one a card was mined from.
//!
//! A hooked line (WebSocket, clipboard) arrives as its text appears, which is about when its
//! voice starts. An OCR'd line arrives after the scan settles, a second or more into its voice;
//! when automatic scanning watched the text draw in, `appeared` is when it started to
//! (`listener::Screen`), which is the better anchor.
use std::collections::VecDeque;

/// Lines kept: far more than any audio buffer covers.
const KEEP: usize = 300;

#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub uid: String,
    pub text: String,
    /// Arrival, in Unix milliseconds.
    pub ts: f64,
    pub ocr: bool,
    /// When the line's text began to appear on screen, if that was seen (OCR'd lines only).
    pub appeared: Option<f64>,
    /// The OCR scan the line was read in: one scan can give several lines (a name box, the
    /// dialogue, a choice), all arriving together.
    pub scan: Option<String>,
}

impl Line {
    /// When the line's voice is expected to start: when its text appeared, else its arrival.
    pub fn anchor(&self) -> f64 {
        self.appeared.unwrap_or(self.ts).min(self.ts)
    }
}

#[derive(Default)]
pub struct Timeline {
    lines: VecDeque<Line>,
}

impl Timeline {
    /// A line arrived, or (same uid) its text changed: a start-merge keeps the arrival time.
    /// Answers whether the text is new or changed.
    pub fn record(&mut self, line: Line) -> bool {
        if let Some(known) = self.lines.iter_mut().find(|l| l.uid == line.uid) {
            let changed = known.text != line.text;
            known.text = line.text;
            return changed;
        }
        let at = self.lines.partition_point(|l| l.ts <= line.ts);
        self.lines.insert(at, line);
        while self.lines.len() > KEEP {
            self.lines.pop_front();
        }
        true
    }

    pub fn get(&self, uid: &str) -> Option<&Line> {
        self.lines.iter().find(|l| l.uid == uid)
    }

    /// The lines before and after `uid`'s, in arrival order.
    pub fn neighbours(&self, uid: &str) -> (Option<&Line>, Option<&Line>) {
        let Some(i) = self.lines.iter().position(|l| l.uid == uid) else {
            return (None, None);
        };
        (
            i.checked_sub(1).and_then(|p| self.lines.get(p)),
            self.lines.get(i + 1),
        )
    }

    /// Forget lines (the Log deleted them, or a fuller reading replaced them).
    pub fn remove(&mut self, uids: &[String]) {
        self.lines.retain(|l| !uids.contains(&l.uid));
    }

    pub fn iter(&self) -> impl DoubleEndedIterator<Item = &Line> {
        self.lines.iter()
    }

    pub fn clear(&mut self) {
        self.lines.clear();
    }

    /// The line a card was made from: the newest whose text best matches one of `texts` (the
    /// card's sentence, or every field of an extension's card), else the newest line.
    pub fn mined(&self, texts: &[&str]) -> Option<&Line> {
        let wanted: Vec<String> = texts
            .iter()
            .map(|t| normalize(t))
            .filter(|t| !t.is_empty())
            .collect();
        let mut best: Option<(u8, &Line)> = None;
        for line in self.lines.iter().rev() {
            let text = normalize(&line.text);
            if text.is_empty() {
                continue;
            }
            let score = wanted
                .iter()
                .map(|w| similarity(&text, w))
                .max()
                .unwrap_or(0);
            if score > best.map_or(0, |(s, _)| s) {
                best = Some((score, line));
            }
        }
        best.map(|(_, line)| line).or_else(|| self.lines.back())
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
    let sentence_sized =
        card.chars().count() >= 6 || card.chars().count() * 2 >= line.chars().count();
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
        Line {
            uid: uid.into(),
            text: text.into(),
            ts,
            ocr: false,
            appeared: None,
            scan: None,
        }
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
        assert_eq!(
            t.mined(&["今日はいい天気ですね。"]).unwrap().uid,
            "b",
            "a sentence cut out of a longer line"
        );
        assert_eq!(
            t.mined(&["<b>猫</b>が好きです。"]).unwrap().uid,
            "a",
            "markup is ignored"
        );
        assert_eq!(
            t.mined(&["猫", "ねこ", "cat", "猫が好きです。"])
                .unwrap()
                .uid,
            "a",
            "one of the card's fields"
        );
        assert_eq!(
            t.mined(&["猫"]).unwrap().uid,
            "c",
            "a lone word matches no line: the newest"
        );
        assert_eq!(t.mined(&[]).unwrap().uid, "c");
        assert!(Timeline::default().mined(&["x"]).is_none());
    }

    #[test]
    fn the_newest_of_equal_matches_wins() {
        let t = timeline(&[
            ("a", "はい。", 1_000.0),
            ("b", "いいえ。", 2_000.0),
            ("c", "はい。", 3_000.0),
        ]);
        assert_eq!(t.mined(&["はい。"]).unwrap().uid, "c");
    }

    #[test]
    fn a_lines_neighbours_and_anchor() {
        let mut t = timeline(&[
            ("a", "一", 1_000.0),
            ("b", "二", 5_000.0),
            ("c", "三", 9_000.0),
        ]);
        let (before, after) = t.neighbours("b");
        assert_eq!(
            (before.unwrap().uid.as_str(), after.unwrap().uid.as_str()),
            ("a", "c")
        );
        assert_eq!(t.neighbours("a").0, None);
        assert!(t.record(Line {
            uid: "d".into(),
            text: "四".into(),
            ts: 12_000.0,
            ocr: true,
            appeared: Some(10_500.0),
            scan: None,
        }));
        assert_eq!(t.get("d").unwrap().anchor(), 10_500.0);
        assert_eq!(t.get("a").unwrap().anchor(), 1_000.0);
        assert!(
            !t.record(line("a", "一", 1_000.0)),
            "the same text again is no change"
        );
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
        assert_eq!(
            normalize("<span>猫[ねこ]が 好[す]き</span>&nbsp;"),
            "猫が好き"
        );
    }
}
