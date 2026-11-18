//! A line sent together with its translations, kept to the language being read.
//!
//! Multilingual releases keep every language of a line side by side in their script, and an engine
//! hook can catch them all at once. Yuzusoft's KiriKiri games (Senren＊Banka, Riddle Joker,
//! Café Stella) send the line drawn four times, then each translation, then the scene's name:
//! `「あっ、はい。なんですか？」`×4 `「啊，不好意思。怎么了？」`×2 `「啊，不好意思。怎麼了？」`×2
//! `■自動車（車内／走行）`. A release can also put an English translation beside the Japanese.
//! [`in_language`] keeps the parts in the language being read (the `language` setting).
//!
//! It is careful about ordinary lines: a Japanese line that quotes some English, or a sentence of
//! kanji alone, is left as it is. Only a line made of whole sentences in two languages, the
//! foreign part about as long as a translation would be, is cut; or a line drawn over in separate
//! parts (the original drawn over, then each translation), where everything after the original
//! that is not in the language goes.
use crate::language::Language;
use std::borrow::Cow;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// In the language being read.
    Own,
    /// In another language.
    Foreign,
    /// Can't tell: punctuation alone (`「……」`), or for Japanese, kanji with no kana and nothing
    /// only Chinese writes (`『先生』` is either).
    Unsure,
}

/// One sentence of the line, drawn `count` times in a row.
#[derive(Debug)]
struct Run<'a> {
    text: &'a str,
    count: usize,
    kind: Kind,
}

/// The line kept to the parts in `language`, or the line as it is when it is not one sent with its
/// translations.
pub fn in_language<'a>(text: &'a str, language: &Language) -> Cow<'a, str> {
    let pieces = sentences(text);
    // The engine's labels (the scene's name as it changes, `■自動車（車内／走行）`) are no part of
    // the game's line, wherever they come: before it, after it, or alone (then there is no line,
    // and none to give a voice to).
    if pieces.iter().any(|p| is_label(p)) {
        let rest: String = pieces.iter().filter(|p| !is_label(p)).copied().collect();
        if rest.trim().is_empty() {
            return Cow::Borrowed("");
        }
        return Cow::Owned(in_language(&rest, language).into_owned());
    }
    if pieces.len() < 2 {
        return Cow::Borrowed(text);
    }
    let mut runs: Vec<Run> = Vec::new();
    for piece in pieces {
        match runs.last_mut() {
            Some(run) if run.text.trim() == piece.trim() => run.count += 1,
            _ => runs.push(Run { text: piece, count: 1, kind: kind(piece, language) }),
        }
    }
    if runs.len() < 2 {
        return Cow::Borrowed(text);
    }
    // Drawn over in parts: the original drawn over, then at least one other sentence drawn over.
    // Before the original may come a label or two the engine adds, drawn once (the scene's name
    // as it changes, a sound effect's: `車／ドア開ける（車内）■自動車（車内／減速→停止）`).
    let original = runs.iter().position(|r| r.count >= 2).filter(|&first| {
        first <= MAX_LABELS
            && runs[first + 1..].iter().any(|r| r.count >= 2 && r.text.trim() != runs[first].text.trim())
    });
    let keep: Vec<bool> = if let Some(original) = original {
        let Some(keep) = drawn_over_keep(&runs, original) else { return Cow::Borrowed(text) };
        keep
    } else {
        let Some(keep) = translated_keep(&runs) else { return Cow::Borrowed(text) };
        keep
    };
    let mut out = String::with_capacity(text.len());
    for (run, keep) in runs.iter().zip(keep) {
        if keep {
            for _ in 0..run.count {
                out.push_str(run.text);
            }
        }
    }
    let out = out.trim();
    if out.is_empty() || out.len() == text.trim().len() {
        return Cow::Borrowed(text);
    }
    Cow::Owned(out.to_string())
}

/// An engine's label: `■`, a name, and what it says in brackets (`■自動車（車内／減速→停止）`).
fn is_label(piece: &str) -> bool {
    let piece = piece.trim();
    let (Some(name), Some(open)) = (piece.strip_prefix('■'), piece.find(['（', '('])) else { return false };
    // A name of two characters or more, no ■ in it: `■■■（笑）` is a word blacked out, then text.
    let name = &name[..open - '■'.len_utf8()];
    name.chars().count() >= 2
        && !name.contains('■')
        && piece.ends_with(['）', ')'])
        && !piece[open..].contains(['。', '「', '」'])
}

/// Labels drawn once that may come before a line drawn over in parts.
const MAX_LABELS: usize = 3;

/// Which runs of a line drawn over in parts to keep: the original (the run at `original`, the first
/// drawn over), wherever it is drawn. The rest is translations (a part that might be either,
/// `『先生』` after `『お客さん』`, is one), the line again with its ruby as text
/// (`「しなつ荘まで…」` between the copies of `「志那都荘まで…」`), and the labels the engine
/// adds. With the original in another language, the parts after it in the language (a translation
/// being read), labels aside; None when there are none.
fn drawn_over_keep(runs: &[Run], original: usize) -> Option<Vec<bool>> {
    if runs[original].kind == Kind::Foreign {
        let keep: Vec<bool> = runs
            .iter()
            .enumerate()
            .map(|(i, r)| i > original && r.kind == Kind::Own && !r.text.trim_start().starts_with('■'))
            .collect();
        return keep.contains(&true).then_some(keep);
    }
    let line = runs[original].text.trim();
    Some(runs.iter().map(|run| run.text.trim() == line).collect())
}

/// Which runs to keep of a line that may hold its translation once: the line must be whole
/// sentences in the language and whole sentences in another, the foreign ones at least a quarter
/// as long, as a translation is. A sentence that can't tell goes with the sentence before it (a
/// translation's `「……」` follows its line), or, first in the line, with the one after.
fn translated_keep(runs: &[Run]) -> Option<Vec<bool>> {
    let mut kinds: Vec<Kind> = runs.iter().map(|r| r.kind).collect();
    let mut last = None;
    for kind in kinds.iter_mut() {
        if *kind == Kind::Unsure {
            if let Some(before) = last {
                *kind = before;
            }
        } else {
            last = Some(*kind);
        }
    }
    let first = kinds.iter().copied().find(|k| *k != Kind::Unsure)?;
    for kind in kinds.iter_mut().take_while(|k| **k == Kind::Unsure) {
        *kind = first;
    }
    let weight =
        |want: Kind| -> f64 { runs.iter().zip(&kinds).filter(|(_, k)| **k == want).map(|(r, _)| weight(r.text)).sum() };
    let (own, foreign) = (weight(Kind::Own), weight(Kind::Foreign));
    if own < 2.0 || foreign < 4.0 || foreign < own / 4.0 {
        return None;
    }
    Some(kinds.iter().map(|k| *k == Kind::Own).collect())
}

/// How much a sentence says, in Japanese characters: a kana, kanji or Hangul block is one, a
/// letter of an alphabet half (`pick::letter_scale`).
fn weight(text: &str) -> f64 {
    text.chars().filter(|c| c.is_alphabetic()).map(|c| if is_cjk(c) { 1.0 } else { 0.5 }).sum()
}

fn is_cjk(c: char) -> bool {
    is_kana(c) || is_han(c) || matches!(c as u32, 0xAC00..=0xD7AF | 0x1100..=0x11FF | 0x3130..=0x318F)
}

fn is_kana(c: char) -> bool {
    // Hiragana, katakana (not `・` or `ー`, which other languages borrow) and half-width katakana.
    matches!(c as u32, 0x3041..=0x309F | 0x30A1..=0x30FA | 0x30FD..=0x30FF | 0xFF66..=0xFF9D)
}

fn is_han(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x3134F)
}

/// Written in Chinese and never in Japanese: the full-width comma (Japanese has `、`), particles and
/// interjections (`您 们 吗 呢 啊 哦 呃`), and simplified or traditional forms where Japanese
/// has its own (`这 说 话 么 们 经 應`). Characters Japanese shares (`的 了 是 来 会 給 還 個 為`)
/// are left out.
fn chinese_only(c: char) -> bool {
    "，您们們吗嗎呢啊哦呃喔哇呀嗯嘛啦咦唉哎诶欸吧呗咱这么麼说說话让讓应應连过时经經发现样对为个沒谢请问还该给边开关见觉"
        .contains(c)
}

/// Whether a kanji is one Japanese has no code for in Shift_JIS (JIS X 0208 and the vendor
/// extensions every Japanese game's text fits in): most simplified forms (`织 镇 闻 则`).
fn outside_jis(c: char) -> bool {
    let mut utf8 = [0u8; 4];
    let mut out = [0u8; 8];
    let mut encoder = encoding_rs::SHIFT_JIS.new_encoder();
    let (result, _, _) = encoder.encode_from_utf8_without_replacement(c.encode_utf8(&mut utf8), &mut out, true);
    result != encoding_rs::EncoderResult::InputEmpty
}

/// Whether text with no kana shows it is Chinese: something only Chinese writes
/// ([`chinese_only`]), or two kanji Japanese has no code for ([`outside_jis`]).
fn chinese_signs(text: &str) -> bool {
    text.chars().any(chinese_only) || text.chars().filter(|c| is_han(*c) && outside_jis(*c)).take(2).count() == 2
}

/// Whether text is Chinese, not Japanese: four kanji or more, no kana, and signs of Chinese
/// ([`chinese_signs`]).
pub fn looks_chinese(text: &str) -> bool {
    !text.chars().any(is_kana) && text.chars().filter(|c| is_han(*c)).count() >= 4 && chinese_signs(text)
}

/// Whether a sentence is in `language`.
fn kind(text: &str, language: &Language) -> Kind {
    let letters: Vec<char> = text.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.is_empty() {
        return Kind::Unsure;
    }
    let kana = letters.iter().filter(|c| is_kana(**c)).count();
    let chinese = language.code.starts_with("zh") || language.code == "yue";
    if language.is_japanese() {
        if kana > 0 {
            return Kind::Own;
        }
        if letters.iter().all(|c| is_han(*c)) {
            return if chinese_signs(text) { Kind::Foreign } else { Kind::Unsure };
        }
    } else if chinese && kana > 0 {
        // Kana in a sentence of Chinese never; in one of Japanese, always.
        return Kind::Foreign;
    }
    let own = letters.iter().filter(|c| language.has(**c)).count();
    if own * 2 >= letters.len() {
        Kind::Own
    } else if (letters.len() - own) * 10 >= letters.len() * 9 {
        Kind::Foreign
    } else {
        Kind::Unsure
    }
}

/// The line in sentences, as it was (joined, they are the line): a sentence ends at a full stop
/// (`。！？`, and `. ! ?` before a space or another script) outside brackets, and at a closing
/// bracket or quote that the next sentence opens straight after (`「…」「…」`, `"…" 「…」`).
/// `■`, which some engines put before the scene's name, starts one.
fn sentences(text: &str) -> Vec<&str> {
    const OPEN: &str = "「『（(【〈《“［[";
    const CLOSE: &str = "」』）)】〉》”］]";
    const STOPS: &str = "。！？!?．";
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut depth = 0usize;
    let mut quoted = false;
    for (i, &(at, c)) in chars.iter().enumerate() {
        let next = chars.get(i + 1).map(|&(_, c)| c);
        let end = at + c.len_utf8();
        if c == '■' && depth == 0 && !quoted && at > start && !text[start..at].ends_with('■') {
            pieces.push(&text[start..at]);
            start = at;
        }
        if c == '"' {
            quoted = !quoted;
        } else if OPEN.contains(c) {
            depth += 1;
        } else if CLOSE.contains(c) {
            depth = depth.saturating_sub(1);
        }
        if depth > 0 || quoted {
            continue;
        }
        let opens = |n: Option<char>| n.is_none_or(|n| OPEN.contains(n) || n == '"' || n.is_whitespace() || n == '■');
        let boundary = if CLOSE.contains(c) || c == '"' {
            // A `■` label ends with its brackets (`■自動車（車内／走行）`), whatever follows.
            opens(next) || text[start..].starts_with('■')
        } else if c == '.' {
            next.is_none_or(|n| n.is_whitespace() || n == '"' || !n.is_ascii())
        } else if STOPS.contains(c) {
            next.is_none_or(|n| !STOPS.contains(n) && !CLOSE.contains(n) && n != '.')
        } else {
            false
        };
        if boundary && next.is_some() {
            pieces.push(&text[start..end]);
            start = end;
        }
    }
    if start < text.len() {
        pieces.push(&text[start..]);
    }
    pieces
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ja() -> &'static Language {
        crate::language::get("ja")
    }
    fn keep(text: &str) -> String {
        crate::text_hook::pick::collapse_repeated_sentences(&in_language(text, ja()), ja())
    }

    /// What Senren＊Banka's EmbedKrkrZ hook sent (LunaHook 12.1.3.8, the game in English or Japanese).
    const SENREN: &[(&str, &str)] = &[
        (
            "『お客さん』『お客さん』『お客さん』『お客さん』『先生』『先生』『先生』『先生』■自動車（車内／走行）",
            "『お客さん』",
        ),
        ("「………」「………」「………」「………」「……」「……」「……」「……」■自動車（車内／走行）", "「………」"),
        ("「……ぁ？」「……ぁ？」「……ぁ？」「……ぁ？」「……呃？」「……呃？」「……呃？」「……呃？」■自動車（車内／走行）", "「……ぁ？」"),
        (
            "「お客さんってば」「お客さんってば」「お客さんってば」「お客さんってば」「先生您醒醒」「先生您醒醒」「先生您醒醒」「先生您醒醒」■自動車（車内／走行）",
            "「お客さんってば」",
        ),
        (
            "「あっ、はい。なんですか？」「あっ、はい。なんですか？」「あっ、はい。なんですか？」「あっ、はい。なんですか？」「啊，不好意思。怎么了？」「啊，不好意思。怎么了？」「啊，不好意思。怎麼了？」「啊，不好意思。怎麼了？」■自動車（車内／走行）",
            "「あっ、はい。なんですか？」",
        ),
        (
            "飛び起きた俺は、前に座っている運転手に返事をする。飛び起きた俺は、前に座っている運転手に返事をする。飛び起きた俺は、前に座っている運転手に返事をする。飛び起きた俺は、前に座っている運転手に返事をする。我猛地坐了起来，连忙应了一声。我猛地坐了起来，连忙应了一声。我猛地坐了起來，連忙應了一聲。我猛地坐了起來，連忙應了一聲。■自動車（車内／走行）",
            "飛び起きた俺は、前に座っている運転手に返事をする。",
        ),
        (
            "「志那都荘まで行って欲しいんですけど」「志那都荘まで行って欲しいんですけど」「しなつ荘まで行って欲しいんですけど」「しなつ荘まで行って欲しいんですけど」「志那都荘まで行って欲しいんですけど」「志那都荘まで行って欲しいんですけど」「志那都荘まで行って欲しいんですけど」「志那都荘まで行って欲しいんですけど」「しなつ荘まで行って欲しいんですけど」「しなつ荘まで行って欲しいんですけど」「志那都荘まで行って欲しいんですけど」「志那都荘まで行って欲しいんですけど」「能麻烦您送我到志那都庄吗」「能麻烦您送我到志那都庄吗」「能麻煩您送我到志那都莊嗎」「能麻煩您送我到志那都莊嗎」■自動車（車内／走行）",
            "「志那都荘まで行って欲しいんですけど」",
        ),
        // The scene changing and a sound effect: their labels come first.
        (
            "車／ドア開ける（車内）■自動車（車内／減速→停止）無視して、そのまま外に出た。無視して、そのまま外に出た。無視して、そのまま外に出た。無視して、そのまま外に出た。我懒得搭理他，直接下了车。我懒得搭理他，直接下了车。我懶得搭理他，直接下了車。我懶得搭理他，直接下了車。■自動車（車内／走行）",
            "無視して、そのまま外に出た。",
        ),
    ];

    #[test]
    fn a_line_drawn_with_its_translations_keeps_the_japanese() {
        for (sent, line) in SENREN {
            assert_eq!(keep(sent), *line, "{sent}");
        }
    }

    #[test]
    fn a_line_beside_its_english_translation_keeps_the_language_being_read() {
        let line = "「あっ、はい。なんですか？」\"Oh, uhh, yes? What is it?\"";
        assert_eq!(keep(line), "「あっ、はい。なんですか？」");
        let en = crate::language::get("en");
        assert_eq!(in_language(line, en), "\"Oh, uhh, yes? What is it?\"");
        let narration = "飛び起きた俺は、前に座っている運転手に返事をする。I jumped up and answered the driver.";
        assert_eq!(keep(narration), "飛び起きた俺は、前に座っている運転手に返事をする。");
        // Reading Chinese, the Japanese goes and both scripts of the translation stay.
        let zh = crate::language::get("zh-Hans");
        assert_eq!(
            crate::text_hook::pick::collapse_repeated_sentences(&in_language(SENREN[4].0, zh), zh),
            "「啊，不好意思。怎么了？」「啊，不好意思。怎麼了？」"
        );
    }

    #[test]
    fn a_scene_label_sent_alone_is_no_line() {
        assert_eq!(in_language("■自動車（車内／走行）", ja()), "");
        assert_eq!(in_language("■自動車（車内／走行）■自動車（車内／減速→停止）", ja()), "");
        assert_eq!(in_language("■", ja()), "■");
        // Labels before a line sent once (no copies or translations): the line alone.
        assert_eq!(
            in_language(
                "■自動車（車内／走行）■自動車（車内／減速→停止）子供の頃は女を感じるようなことはなかった。",
                ja()
            ),
            "子供の頃は女を感じるようなことはなかった。"
        );
        assert_eq!(in_language("■■■（笑）だ。", ja()), "■■■（笑）だ。");
    }

    #[test]
    fn ordinary_lines_are_left_alone() {
        for line in [
            "「Good morning!」と、彼女は英語で挨拶した。",
            "英語で言うと、Nice to meet you. はじめまして。",
            "「行くぞ」「了解」",
            "ここが俺の家だ。東京都千代田区。",
            "「本当？」「本当だよ」",
            "彼は言った。OK. それで終わりだ。",
            "「お前は■■■だ」",
            "結論。それは不可能だ。",
            "「わ、わかったよ」「わ、わかったよ」「わ、わかったよ」",
            "chr00chr01先生「……」",
            "Hello there. How are you?",
        ] {
            assert_eq!(in_language(line, ja()), line, "{line}");
        }
        let en = crate::language::get("en");
        assert_eq!(in_language("Knock, knock. Who's there?", en), "Knock, knock. Who's there?");
    }

    #[test]
    fn sentences_split_where_the_next_one_starts() {
        assert_eq!(sentences("「あ。い」「う」"), vec!["「あ。い」", "「う」"]);
        assert_eq!(sentences("「あ」と言った。次だ。"), vec!["「あ」と言った。", "次だ。"]);
        assert_eq!(sentences("はい。\"Yes.\" Ok."), vec!["はい。", "\"Yes.\"", " Ok."]);
        assert_eq!(sentences("円周率は3.14だ。"), vec!["円周率は3.14だ。"]);
        assert_eq!(sentences("「え？」■駅"), vec!["「え？」", "■駅"]);
        assert_eq!(sentences("音（車内）■駅（夜）行こう。"), vec!["音（車内）", "■駅（夜）", "行こう。"]);
    }
}
