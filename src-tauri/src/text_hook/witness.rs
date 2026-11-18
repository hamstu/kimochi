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
    /// Its latest text differs from the one before it: a line, not a label redrawn.
    pub fresh: bool,
    /// Pieces it has sent: of threads that show the same line, the one that has spoken most is the
    /// game's steady dialogue thread (SiglusEngine starts a thread per line beside it).
    pub count: u64,
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
///
/// The largest block is the dialogue box, as for the first choice (`pick::chosen`): a line there
/// outranks one elsewhere either way, so a menu bar or a nameplate never vouches for a thread
/// over the dialogue, nor hands the choice to one.
pub fn judge(chosen: &str, earlier: &[&str], others: &[Other], blocks: &[Block], language: &Language) -> Verdict {
    let scale = pick::letter_scale(language);
    let chosen = fold(chosen);
    let letters = |text: &str| text.chars().filter(|c| language.has(*c)).count();
    let largest = blocks.iter().enumerate().max_by(|a, b| a.1.area.total_cmp(&b.1.area)).map(|(i, _)| i);
    // Where on screen a text is: in the largest block, elsewhere, or not at all.
    let place = |text: &str| -> Option<bool> {
        let shown: Vec<usize> = (0..blocks.len()).filter(|i| found(text, &blocks[*i].text) >= SHOWN).collect();
        (!shown.is_empty()).then(|| shown.iter().any(|i| Some(*i) == largest))
    };
    let mine = (chosen.chars().count() >= MIN_CHARS * scale).then(|| place(&chosen)).flatten();
    // Another engine thread with a fresh line on screen, the one with the most of it: a generic
    // hook (a menu drawn through `DrawTextExW`) is never handed the choice on the screen's word,
    // nor a thread that sent the same text again (a label redrawn). A thread with the chosen
    // line (sent again, or more around it) is no other. Off the largest block, only a long line.
    let theirs = others
        .iter()
        .filter(|o| o.fresh && !o.generic)
        .filter_map(|o| {
            let text = fold(o.text);
            let length = text.chars().count();
            if length < MIN_OTHER * scale || !pick::reads_as(&text, language) || pick::same_line(&chosen, &text) {
                return None;
            }
            let in_largest = place(&text)?;
            // How closely: a copy with the speaker's name glued on matches less of itself.
            let closeness = (blocks.iter().map(|b| found(&text, &b.text)).fold(0.0, f64::max) * 20.0).round() as u32;
            (in_largest || length >= MIN_OFF_BOX * scale).then_some((
                o,
                in_largest,
                (closeness, o.count.min(5), length),
            ))
        })
        .max_by_key(|(_, in_largest, rank)| (*in_largest, *rank));
    match (mine, &theirs) {
        (Some(true), _) => return Verdict::Shown,
        (_, Some((other, true, _))) => return Verdict::Other(other.key.to_string()),
        (Some(false), _) => return Verdict::Shown,
        _ => {}
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
    if let Some((other, _, _)) = theirs {
        return Verdict::Other(other.key.to_string());
    }
    let on_screen = |text: &str| place(text).is_some();
    if earlier.iter().map(|t| fold(t)).any(|t| t.chars().count() >= MIN_CHARS * scale && on_screen(&t)) {
        return Verdict::Earlier;
    }
    if blocks.iter().any(|b| letters(&b.text) >= MIN_OTHER * scale) {
        return Verdict::Unhooked;
    }
    Verdict::Unclear
}

/// The fewest characters another thread's line must have to take over from outside the largest
/// block (`pick::chosen` asks the same of a first choice).
const MIN_OFF_BOX: usize = 12;

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
        Other { key, text, generic: false, fresh: true, count: 5 }
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
    fn of_threads_with_the_line_the_steady_one_without_the_name_is_named() {
        // A nameplate block above the box, the line in the box; a per-line thread (spoken once), a
        // thread with the speaker's name glued on, and the steady dialogue thread.
        let mut lines = vec![line("物語の窓 体験版", 2.0), line("声", 440.0)];
        lines.push(OcrLine {
            text: "「あと五秒しかないぞ！」".into(), x: 100.0, y: 520.0, width: 600.0, height: 40.0
        });
        let blocks = dialogue_blocks(&lines, "物語の窓 体験版", ja());
        let others = [
            Other {
                key: "per-line", text: "「あと五秒しかないぞ！」", generic: false, fresh: true, count: 1
            },
            Other {
                key: "named", text: "声「あと五秒しかないぞ！」", generic: false, fresh: true, count: 30
            },
            Other {
                key: "steady", text: "「あと五秒しかないぞ！」", generic: false, fresh: true, count: 30
            },
        ];
        assert_eq!(judge("「前の場面の台詞だった」", &[], &others, &blocks, ja()), Verdict::Other("steady".into()));
    }

    #[test]
    fn a_generic_hook_or_a_label_redrawn_is_never_handed_the_choice() {
        let blocks = screen(&["「明日は早く起きないといけないんだ」"]);
        let generic = Other {
            key: "generic",
            text: "少年「明日は早く起きないといけないんだ」",
            generic: true,
            fresh: true,
            count: 5,
        };
        assert_eq!(judge("「昨日の話の続きだけど」", &[], &[generic.clone()], &blocks, ja()), Verdict::Unhooked);
        let others = [generic, other("engine", "「明日は早く起きないといけないんだ」")];
        assert_eq!(judge("「昨日の話の続きだけど」", &[], &others, &blocks, ja()), Verdict::Other("engine".into()));
        let redrawn = Other {
            key: "label",
            text: "「明日は早く起きないといけないんだ」",
            generic: false,
            fresh: false,
            count: 5,
        };
        assert_eq!(judge("「昨日の話の続きだけど」", &[], &[redrawn], &blocks, ja()), Verdict::Unhooked);
    }

    /// The window's menu bar (in the capture, and sent by a thread of its own) beside the dialogue.
    fn with_menu(rows: &[&str]) -> Vec<Block> {
        let mut lines = vec![line("物語の窓 体験版", 2.0), line("終了 ウィンドウ メッセージ 環境設定 ヘルプ", 32.0)];
        for (i, row) in rows.iter().enumerate() {
            lines.push(line(row, 600.0 + 40.0 * i as f64));
        }
        let mut lines = lines;
        // The dialogue's rows are in a larger font than the menu.
        for l in lines.iter_mut().skip(2) {
            l.height = 40.0;
            l.width = 40.0 * l.text.chars().count() as f64;
        }
        dialogue_blocks(&lines, "物語の窓 体験版", ja())
    }

    #[test]
    fn the_dialogue_box_outranks_a_menu_bar_either_way() {
        let blocks = with_menu(&["築三十年と聞いているが、改築でもしたんだろうか。"]);
        let menu = "終了ウィンドウメッセージ環境設定ヘルプ";
        let line = "築三十年と聞いているが、改築でもしたんだろうか。外観はとても綺麗だ。";
        // A menu thread chosen by mistake is not vouched for: the dialogue thread takes over.
        assert_eq!(judge(menu, &[], &[other("dialogue", line)], &blocks, ja()), Verdict::Other("dialogue".into()));
        // The dialogue thread chosen is kept (most of it typed out), however fresh the menu thread is.
        assert_eq!(judge(line, &[], &[other("menu", menu)], &blocks, ja()), Verdict::Shown);
        let whole = with_menu(&["築三十年と聞いているが、改築でもしたんだろうか。", "外観はとても綺麗だ。"]);
        assert_eq!(judge(line, &[], &[other("menu", menu)], &whole, ja()), Verdict::Shown);
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
    /// Replays steps a live harness recorded (a game hooked by the sidecar, its window read by the
    /// OCR worker; one JSON object per line with `title`, `lines` and `threads`), judging every
    /// thread that has sent text as if it were the chosen one. Prints one row per step and thread.
    /// `KIMOCHI_WITNESS_REPLAY=<file> cargo test --bin kimochi witness::tests::replay -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn replay_from_env() {
        let Ok(path) = std::env::var("KIMOCHI_WITNESS_REPLAY") else { return };
        let mut tally = std::collections::BTreeMap::<String, usize>::new();
        for row in std::fs::read_to_string(path).unwrap().lines().filter(|l| !l.trim().is_empty()) {
            let step: serde_json::Value = serde_json::from_str(row).unwrap();
            let lines: Vec<OcrLine> = step["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| OcrLine {
                    text: l["text"].as_str().unwrap_or("").into(),
                    x: l["x"].as_f64().unwrap_or(0.0),
                    y: l["y"].as_f64().unwrap_or(0.0),
                    width: l["width"].as_f64().unwrap_or(0.0),
                    height: l["height"].as_f64().unwrap_or(0.0),
                })
                .collect();
            let blocks = dialogue_blocks(&lines, step["title"].as_str().unwrap_or(""), ja());
            let threads = step["threads"].as_array().unwrap();
            let text = |t: &serde_json::Value| t["text"].as_str().unwrap_or("").to_string();
            for chosen in threads {
                let others: Vec<(String, String, bool, bool, u64)> = threads
                    .iter()
                    .filter(|t| t["key"] != chosen["key"])
                    .map(|t| {
                        let history = t["history"].as_array().cloned().unwrap_or_default();
                        let fresh =
                            history.get(1).is_none_or(|h| h.as_str() != history.first().and_then(|f| f.as_str()));
                        let generic =
                            pick::is_generic(t["hookcode"].as_str().unwrap_or(""), t["name"].as_str().unwrap_or(""));
                        (
                            t["key"].as_str().unwrap_or("").to_string(),
                            text(t),
                            generic,
                            fresh,
                            t["count"].as_u64().unwrap_or(1),
                        )
                    })
                    .collect();
                let others: Vec<Other> = others
                    .iter()
                    .map(|(k, t, g, f, c)| Other { key: k, text: t, generic: *g, fresh: *f, count: *c })
                    .collect();
                let earlier: Vec<String> = chosen["history"]
                    .as_array()
                    .map(|h| h.iter().skip(1).filter_map(|x| x.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                let earlier: Vec<&str> = earlier.iter().map(String::as_str).collect();
                let verdict = judge(&text(chosen), &earlier, &others, &blocks, ja());
                let key = chosen["hookcode"].as_str().unwrap_or("").to_string();
                println!("step {:>3} {:<40} {:?}", step["step"], key, verdict);
                *tally.entry(format!("{key} {}", verdict.name())).or_default() += 1;
            }
        }
        for (k, n) in tally {
            println!("TALLY {k}: {n}");
        }
    }
}
