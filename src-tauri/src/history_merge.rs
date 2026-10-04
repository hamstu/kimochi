//! One history entry per sentence, however many times it was read.
//!
//! Automatic OCR reads fast and then reads again: a dialogue box can arrive as its first line
//! (written early, perhaps with a misread character), then the whole passage, then the second
//! line on its own when the observer split the box another way. Each of those is a true
//! reading, and together they were three entries for one sentence.
//!
//! So a new entry is compared with the few most recent ones from the same source, written in
//! the last minute, with punctuation and spacing ignored and a small number of misread
//! characters tolerated:
//!
//!  - already contained in one of them (the same text again, or a piece of it): skipped;
//!  - containing one or more of them (the fuller reading): it takes their place, and says
//!    which ones it replaced, so the reader's log can swap its lines for the new one;
//!  - otherwise: a new entry.
//!
//! A different sentence of similar length is neither, at any length: containment allows about
//! one wrong character in eight, and text shorter than six characters must match exactly.
use serde_json::Value;

/// How far back, and how many entries, a new entry is compared with.
pub const WINDOW_MS: u64 = 60_000;
pub const DEPTH: usize = 3;

/// What to do with a new entry.
#[derive(Debug, PartialEq, Eq)]
pub enum Merge {
    /// Already there: write nothing.
    Skip,
    /// Write it, removing these entries (by id), which it contains.
    Replace(Vec<String>),
    /// Write it alongside the others.
    Add,
}

/// The characters that carry the sentence: letters, digits and kana/kanji, plus the long
/// vowel mark. Punctuation, brackets and spacing differ between readings of the same text.
fn letters(text: &str) -> Vec<char> {
    text.chars()
        .filter(|c| c.is_alphanumeric() || *c == 'ー')
        .collect()
}

/// Is `small` found inside `big`, allowing a few misread characters?
///
/// The best match of `small` against any stretch of `big` (an edit distance that may start
/// and end anywhere in `big`), within about one character in eight.
pub fn contained(small: &str, big: &str) -> bool {
    let a = letters(small);
    let b = letters(big);
    if a.is_empty() {
        return true;
    }
    let tolerance = if a.len() < 6 { 0 } else { (a.len() / 8).max(1) };
    if a.len() > b.len() + tolerance {
        return false;
    }
    // Rows over `a`, columns over `b`; a free start anywhere in `b`.
    let mut previous = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        let mut current = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            let substitute = previous[j] + usize::from(ca != cb);
            current[j + 1] = substitute.min(previous[j + 1] + 1).min(current[j] + 1);
        }
        previous = current;
    }
    previous.into_iter().min().unwrap_or(usize::MAX) <= tolerance
}

/// Decide what a new entry does to the recent history (newest first).
pub fn decide(text: &str, source: &Value, now: u64, history: &[Value]) -> Merge {
    let recent: Vec<&Value> = history
        .iter()
        .take(DEPTH)
        .filter(|entry| {
            let at = entry.get("timestamp").and_then(Value::as_u64).unwrap_or(0);
            now.saturating_sub(at) <= WINDOW_MS
                && entry.get("source").unwrap_or(&Value::Null) == source
        })
        .collect();
    let mut replaced = Vec::new();
    for entry in recent {
        let Some(old) = entry.get("text").and_then(Value::as_str) else {
            continue;
        };
        if contained(text, old) && letters(text).len() <= letters(old).len() {
            return Merge::Skip;
        }
        if contained(old, text) {
            if let Some(id) = entry.get("id").and_then(Value::as_str) {
                replaced.push(id.to_string());
            }
        }
    }
    if replaced.is_empty() {
        Merge::Add
    } else {
        Merge::Replace(replaced)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, text: &str, at: u64) -> Value {
        json!({ "id": id, "text": text, "timestamp": at, "source": null })
    }

    const FIRST: &str = "タバン「八、八イ!ごらんの通り影も形も";
    const WHOLE: &str = "タバン「ハ、ハイ!ごらんの通り影も形も ありません! こ、これにてオシマイ!!";
    const SECOND: &str = "ありません! こ、これにてオシマイ!!";

    #[test]
    fn the_recorded_three_readings_become_one_entry() {
        let now = 1_000_000;
        // The first line arrives alone, with two characters misread.
        let history = vec![entry("1", FIRST, now - 2000)];
        assert_eq!(
            decide(WHOLE, &Value::Null, now, &history),
            Merge::Replace(vec!["1".into()])
        );
        // The whole passage is in; the second line on its own adds nothing.
        let history = vec![entry("2", WHOLE, now - 1000)];
        assert_eq!(decide(SECOND, &Value::Null, now, &history), Merge::Skip);
        // Nor does the same passage read again.
        assert_eq!(decide(WHOLE, &Value::Null, now, &history), Merge::Skip);
    }

    #[test]
    fn different_sentences_are_kept_apart() {
        let now = 1_000_000;
        let history = vec![entry("1", "今日はいい天気ですね", now - 1000)];
        assert_eq!(
            decide("明日は雨が降りそうですね", &Value::Null, now, &history),
            Merge::Add
        );
        // Short replies must match exactly: はい is not いいえ.
        let history = vec![entry("1", "はい", now - 1000)];
        assert_eq!(decide("いいえ", &Value::Null, now, &history), Merge::Add);
        assert!(!contained("殺す", "返す"));
    }

    #[test]
    fn only_recent_entries_from_the_same_source_are_merged() {
        let now = 1_000_000;
        let old = vec![entry("1", WHOLE, now - WINDOW_MS - 1)];
        assert_eq!(decide(WHOLE, &Value::Null, now, &old), Merge::Add);
        let elsewhere =
            vec![json!({ "id": "1", "text": WHOLE, "timestamp": now, "source": {"name": "x"} })];
        assert_eq!(decide(WHOLE, &Value::Null, now, &elsewhere), Merge::Add);
    }

    #[test]
    fn one_reading_can_replace_several_fragments() {
        let now = 1_000_000;
        let history = vec![entry("2", SECOND, now - 500), entry("1", FIRST, now - 1500)];
        assert_eq!(
            decide(WHOLE, &Value::Null, now, &history),
            Merge::Replace(vec!["2".into(), "1".into()])
        );
    }
}
