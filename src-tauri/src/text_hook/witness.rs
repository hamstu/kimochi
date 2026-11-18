//! The screen as a witness for the chosen thread: one reading of the game window, taken only
//! when the chosen thread looks wrong (it has gone quiet while another thread sends a fresh line),
//! says whether the game shows what the chosen thread last sent, or what another thread sent.
//!
//! The thread choice keeps its own rules (`mod.rs`): a thread that misses a few lines in a row is
//! dropped and the screen chooses again. That is blind both ways. A chosen thread that is fine
//! (another thread sends lines ahead of the screen, or the backlog's) can be dropped for it, and a
//! dead one (SiglusEngine starts threads per scene) keeps the choice for three lost lines. A
//! reading settles it at the first suspicion: the chosen thread's line is on screen (keep it), or
//! another thread's is and the chosen thread's is not (take that one now). Anything else (the
//! line still typing out, a menu, nothing readable) leaves the rules as they are.
//!
//! Independent of Auto align: this reads the window itself, once, on demand, as the first
//! choice does (`pick_loop`).
use super::pick::{self, Block, OcrLine};
use crate::language::Language;

/// The share of a text's neighbouring-character pairs that must be on screen for it to be shown:
/// OCR misreads a character or two in most lines (a long dash as "一", a kanji for its look-alike).
const SHOWN: f64 = 0.6;
/// The fewest characters a text must have for the screen to say anything about it: a two-kana
/// line (`はい`) is in many lines and many menus.
const MIN_CHARS: usize = 4;
/// The fewest characters another thread's text must have to take over on the screen's word.
const MIN_OTHER: usize = 6;

/// What one reading says about the chosen thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// The chosen thread's last line is on screen: it is the dialogue.
    Shown,
    /// What the screen shows of the dialogue is inside the chosen thread's line (the line still
    /// typing out, or a thread that sends the line with more around it): the thread is alive.
    Within,
    /// Another thread's text is on screen and the chosen thread's is not: that thread has the
    /// dialogue.
    Other(String),
    /// The screen shows a line the chosen thread sent before its last: the hook is ahead of the
    /// screen (a game that hands over upcoming lines early).
    Earlier,
    /// The screen shows text in the language that no thread sent.
    Unhooked,
    /// Nothing to go by: no text in the language, or the chosen line too short to tell.
    Unclear,
}

impl Verdict {
    pub fn name(&self) -> &'static str {
        match self {
            Verdict::Shown => "shown",
            Verdict::Within => "within",
            Verdict::Other(_) => "other",
            Verdict::Earlier => "earlier",
            Verdict::Unhooked => "unhooked",
            Verdict::Unclear => "unclear",
        }
    }
}

/// Another thread, as the witness sees it.
#[derive(Debug, Clone)]
pub struct Other<'a> {
    pub key: &'a str,
    pub text: &'a str,
    /// A generic hook (`pick::is_generic`): it sees every string the game handles, so it takes
    /// over only when no engine thread shows the line.
    pub generic: bool,
}

/// OCR reads small kana as full-size ones (`ゃ` as `や`, `っ` as `つ`); both sides fold them.
fn fold_small(c: char) -> char {
    const SMALL: &str = "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ";
    const LARGE: &str = "あいうえおつやゆよわかけアイウエオツヤユヨワカケ";
    SMALL.chars().position(|s| s == c).and_then(|i| LARGE.chars().nth(i)).unwrap_or(c)
}

/// The form a text is compared in here: `pick::normalize`, small kana folded.
pub fn fold(text: &str) -> String {
    pick::normalize(text).chars().map(fold_small).collect()
}

fn pairs(text: &str) -> Vec<(char, char)> {
    let chars: Vec<char> = text.chars().collect();
    chars.windows(2).map(|w| (w[0], w[1])).collect()
}

/// The share of `text`'s neighbouring-character pairs found in `screen` (both folded).
pub fn found(text: &str, screen: &str) -> f64 {
    let wanted = pairs(text);
    if wanted.is_empty() {
        return if !text.is_empty() && screen.contains(text) { 1.0 } else { 0.0 };
    }
    let shown: std::collections::HashSet<(char, char)> = pairs(screen).into_iter().collect();
    wanted.iter().filter(|p| shown.contains(p)).count() as f64 / wanted.len() as f64
}

/// The window's own text left out (its title bar, which the capture holds): an OCR line most of
/// whose pairs are in the window's title. And lines with none of the language's letters (a menu
/// of `SAVE`, `LOAD`, `AUTO`; a stray mark).
pub fn dialogue_blocks(lines: &[OcrLine], title: &str, language: &Language) -> Vec<Block> {
    let title = fold(title);
    let kept: Vec<OcrLine> = lines
        .iter()
        .filter(|l| {
            let text = fold(&l.text);
            let letters = text.chars().filter(|c| language.has(*c)).count();
            letters > 0 && !(title.chars().count() >= 3 && text.chars().count() >= 2 && found(&text, &title) >= SHOWN)
        })
        .cloned()
        .collect();
    pick::blocks(&kept).into_iter().map(|b| Block { text: fold(&b.text), area: b.area }).collect()
}

/// What the screen's dialogue `blocks` (`dialogue_blocks`) say about the chosen thread, whose last
/// line is `chosen`, which sent `earlier` before it (newest first), while `others` hold their own
/// latest text.
pub fn judge(chosen: &str, earlier: &[&str], others: &[Other], blocks: &[Block], language: &Language) -> Verdict {
    let scale = pick::letter_scale(language);
    let chosen = fold(chosen);
    let letters = |text: &str| text.chars().filter(|c| language.has(*c)).count();
    let on_screen = |text: &str| blocks.iter().map(|b| found(text, &b.text)).fold(0.0, f64::max);
    if chosen.chars().count() >= MIN_CHARS * scale && on_screen(&chosen) >= SHOWN {
        return Verdict::Shown;
    }
    // What the screen shows of the dialogue inside the chosen line: a line typing out, or a thread
    // that sends the line with more around it. A block of a few letters only is no sign (a name).
    let within = blocks.iter().any(|b| {
        b.text.chars().count() >= MIN_CHARS * scale && chosen.contains(&b.text)
            || letters(&b.text) >= MIN_OTHER && found(&b.text, &chosen) >= 0.8
    });
    if within {
        return Verdict::Within;
    }
    // Another thread whose text is on screen: the engine thread with the most of it, else a
    // generic one. A thread with the chosen line (sent again, or more around it) is no other.
    let mut best: Option<(&Other, usize)> = None;
    for other in others {
        let text = fold(other.text);
        let length = text.chars().count();
        if length < MIN_OTHER * scale || !pick::reads_as(&text, language) || pick::same_line(&chosen, &text) {
            continue;
        }
        if on_screen(&text) < SHOWN {
            continue;
        }
        let better = match best {
            None => true,
            Some((b, l)) => (b.generic && !other.generic) || (b.generic == other.generic && length > l),
        };
        if better {
            best = Some((other, length));
        }
    }
    if let Some((other, _)) = best {
        return Verdict::Other(other.key.to_string());
    }
    if earlier.iter().map(|t| fold(t)).any(|t| t.chars().count() >= MIN_CHARS * scale && on_screen(&t) >= SHOWN) {
        return Verdict::Earlier;
    }
    if blocks.iter().any(|b| letters(&b.text) >= MIN_OTHER * scale) {
        return Verdict::Unhooked;
    }
    Verdict::Unclear
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ja() -> &'static Language {
        crate::language::get("ja")
    }
    fn line(text: &str, y: f64) -> OcrLine {
        OcrLine { text: text.into(), x: 100.0, y, width: 30.0 * text.chars().count() as f64, height: 30.0 }
    }
    /// A window: its title bar, a menu of buttons, and the dialogue box's rows.
    fn screen(rows: &[&str]) -> Vec<Block> {
        let mut lines = vec![line("物語の窓 体験版", 2.0), line("SAVE LOAD AUTO SKIP", 40.0)];
        for (i, row) in rows.iter().enumerate() {
            lines.push(line(row, 500.0 + 36.0 * i as f64));
        }
        dialogue_blocks(&lines, "物語の窓 体験版", ja())
    }
    fn other<'a>(key: &'a str, text: &'a str) -> Other<'a> {
        Other { key, text, generic: false }
    }

    #[test]
    fn the_title_bar_and_latin_buttons_are_not_dialogue() {
        let blocks = screen(&[]);
        assert!(blocks.is_empty(), "{blocks:?}");
        assert_eq!(judge("「今日は雨が降りそうですね」", &[], &[], &blocks, ja()), Verdict::Unclear);
    }

    #[test]
    fn the_chosen_line_on_screen_keeps_the_thread_despite_misreads() {
        // OCR: small kana read large, a long dash read as a kanji one, a row break.
        let blocks = screen(&["「ちょっと待って、", "まーだ話は終わってないよ」"]);
        assert_eq!(fold("ゃ"), "や");
        let chosen = "「ちょっと待って、ま一だ話は終わってないよ」";
        assert_eq!(judge(chosen, &[], &[], &blocks, ja()), Verdict::Shown);
        let others = [other("next", "「次の授業は体育だったよね」")];
        assert_eq!(judge(chosen, &[], &others, &blocks, ja()), Verdict::Shown);
    }

    #[test]
    fn small_kana_read_as_full_size_still_match() {
        let blocks = screen(&["「やっ、ひやあつ！や、やめっ……！」"]);
        assert_eq!(judge("「やっ、ひゃぁっ！　や、やめっ……！」", &[], &[], &blocks, ja()), Verdict::Shown);
    }

    #[test]
    fn a_line_still_typing_out_or_sent_with_more_around_it_is_within() {
        let blocks = screen(&["おはようございます"]);
        assert_eq!(judge("おはようございます、先生。今日も早いですね。", &[], &[], &blocks, ja()), Verdict::Within);
        // A thread that sends the quick menu's labels and the line twice around it.
        let blocks = screen(&["ええ、大丈夫ですわ……"]);
        let noisy = "ええ、大丈夫ですわ……BACKHIDE……え、ええ！？庭の方から声がした。";
        assert_eq!(judge(noisy, &[], &[], &blocks, ja()), Verdict::Within);
    }

    #[test]
    fn another_threads_line_on_screen_names_that_thread() {
        // The chosen thread stopped at a line from the last scene; another thread has this one.
        let blocks = screen(&["母「またそんなこと言って。", "見つけたら魔法が解けちゃうでしょ？」"]);
        let others = [
            other("scene-context", "「またそんなこと言って。見つけたら魔法が解けちゃうでしょ？」"),
            other("backlog", "「探してはいけませんよ」"),
        ];
        assert_eq!(
            judge("「だから、決してその箱を探してはいけませんよ……」", &[], &others, &blocks, ja()),
            Verdict::Other("scene-context".into())
        );
    }

    #[test]
    fn an_engine_thread_is_named_over_a_generic_one_with_more_text() {
        let blocks = screen(&["「明日は早く起きないといけないんだ」"]);
        let others = [
            Other { key: "generic", text: "少年「明日は早く起きないといけないんだ」", generic: true },
            other("engine", "「明日は早く起きないといけないんだ」"),
        ];
        assert_eq!(judge("「昨日の話の続きだけど」", &[], &others, &blocks, ja()), Verdict::Other("engine".into()));
    }

    #[test]
    fn a_thread_with_the_chosen_line_sent_again_is_no_other() {
        let blocks = screen(&["「今日はいい天気だね」"]);
        let others = [other("copy", "少年「今日はいい天気だね」と言った")];
        assert_eq!(judge("「今日はいい天気だね」", &[], &others, &blocks, ja()), Verdict::Shown);
        let blocks = screen(&["「全然違う話をしている」"]);
        let others = [other("copy", "「今日はいい天気だね」")];
        assert_eq!(judge("「今日はいい天気だね」", &[], &others, &blocks, ja()), Verdict::Unhooked);
    }

    #[test]
    fn a_line_sent_before_the_last_on_screen_means_the_hook_is_ahead() {
        let blocks = screen(&["「何をしているんだ」"]);
        let earlier = ["「何をしているんだ」", "「おい」"];
        assert_eq!(judge("彼女は何も答えなかった。", &earlier, &[], &blocks, ja()), Verdict::Earlier);
    }

    #[test]
    fn unhooked_dialogue_and_short_lines() {
        let blocks = screen(&["誰も知らない言葉が画面に出ている"]);
        assert_eq!(judge("「別の台詞を送った」", &[], &[], &blocks, ja()), Verdict::Unhooked);
        // Too short to tell: neither shown nor anything else.
        let blocks = screen(&["はい"]);
        assert_eq!(judge("はい", &[], &[], &blocks, ja()), Verdict::Unclear);
    }
}
