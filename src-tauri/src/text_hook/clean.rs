//! What is done to a hooked line before it reaches the Log and the card, and the settings it is
//! done with: the game's own (`textHookerGames`) over the defaults (`textHookerDefaults`), as
//! `ui/hook-games.ts` describes them.
//!
//! Always: markup some engines leave in their text (`<b>…</b>`, `{漢字/かんじ}` ruby, Ren'Py's
//! `{w}`, Tyrano's `[r]`, `｜漢字《かんじ》`) is taken out, keeping the text it marks up; and a
//! line far longer than a game says at once (a backlog opened, a skip through a scene, sent as
//! one) is dropped. Per game: script codes taken out (unless turned off), repeated characters
//! undone (`ここここ` → `こ`), and the reader's own find-and-replace rules; and whether a line the
//! game sends in pieces (one call per row of its text box) is joined back up ([`continues_in`]).
use crate::language::Language;
use regex::{NoExpand, Regex};
use serde_json::Value;
use std::sync::OnceLock;

/// A line longer than this is not one the game shows at once: 300 characters of Japanese.
pub const MAX_LINE_CHARS: usize = 300;

/// The longest line a game shows at once, in the language's characters: [`MAX_LINE_CHARS`] in
/// Japanese characters, scaled for an alphabet (300 characters of English are some fifty words,
/// a paragraph an NVL screen or a translation's text box easily holds; `pick::letter_scale`),
/// with room to spare: a backlog or a skip sent as one is thousands.
pub fn max_line_chars(language: &Language) -> usize {
    if super::pick::letter_scale(language) == 1 { MAX_LINE_CHARS } else { 3 * MAX_LINE_CHARS }
}
const DEFAULT_FLUSH_MS: u32 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Repeats {
    /// Undone when every run of a character in the line is a multiple of the same count.
    Auto,
    Off,
    /// Each character sent this many times.
    Fixed(usize),
}

#[derive(Debug, Clone)]
pub struct Replacement {
    find: Regex,
    replace: String,
    regex: bool,
}

#[derive(Debug, Clone)]
pub struct GameConfig {
    pub flush_ms: u32,
    pub repeats: Repeats,
    /// A piece that carries on a sentence the line before left unfinished is joined to it.
    pub join_lines: bool,
    /// The script codes some engines leave in their text are taken out ([`strip_codes`]). Off by
    /// default for a language that spaces its words, where ordinary words look like codes.
    pub strip_codes: bool,
    /// The language has ruby: `{漢字/かんじ}`, `[漢字/かんじ]` and `漢字《かんじ》` are readings to
    /// take out ([`strip_markup`]). Elsewhere `[he/she]` is text.
    pub ruby: bool,
    /// The language spaces its words: rows joined back up have a space between them.
    pub spaces: bool,
    /// The longest line shown at once ([`max_line_chars`]).
    pub max_chars: usize,
    /// Sentences end, and speech opens and closes, as Japanese's do alone ([`continues_in`]).
    pub japanese: bool,
    pub hook_codes: Vec<String>,
    pub replacements: Vec<Replacement>,
}

impl Default for GameConfig {
    fn default() -> Self {
        GameConfig {
            flush_ms: DEFAULT_FLUSH_MS,
            repeats: Repeats::Auto,
            join_lines: true,
            strip_codes: true,
            ruby: true,
            spaces: false,
            max_chars: MAX_LINE_CHARS,
            japanese: true,
            hook_codes: Vec::new(),
            replacements: Vec::new(),
        }
    }
}

impl GameConfig {
    /// From the defaults and the game's record (either may be null), for the language being read.
    pub fn from_settings(defaults: &Value, game: &Value, language: &Language) -> Self {
        let pick = |key: &str| if game[key].is_null() { &defaults[key] } else { &game[key] };
        let flush_ms = pick("flushMs").as_u64().map_or(DEFAULT_FLUSH_MS, |ms| ms.clamp(20, 5000) as u32);
        let repeats = match pick("repeats") {
            Value::String(s) if s == "off" => Repeats::Off,
            Value::Number(n) => n.as_u64().filter(|n| (2..=8).contains(n)).map_or(Repeats::Auto, |n| Repeats::Fixed(n as usize)),
            _ => Repeats::Auto,
        };
        let join_lines = pick("joinLines").as_bool().unwrap_or(true);
        // A setting the reader made wins; unset, on unless words are spaced (`Level10`, `user_name`
        // and `mp3player` are words there, not codes).
        let strip_codes = pick("stripCodes").as_bool().unwrap_or(!language.spaces);
        let hook_codes = game["hookCodes"]
            .as_array()
            .map(|codes| codes.iter().filter_map(|c| c.as_str()).map(str::trim).filter(|c| !c.is_empty()).map(String::from).collect())
            .unwrap_or_default();
        let replacements = game["replacements"]
            .as_array()
            .map(|rules| {
                rules
                    .iter()
                    .filter(|r| r["enabled"].as_bool() != Some(false))
                    .filter_map(|r| {
                        let find = r["find"].as_str().filter(|f| !f.is_empty())?;
                        let regex = r["regex"].as_bool() == Some(true);
                        let pattern = if regex { find.to_string() } else { regex::escape(find) };
                        Some(Replacement {
                            find: Regex::new(&pattern).ok()?,
                            replace: r["replace"].as_str().unwrap_or_default().to_string(),
                            regex,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        GameConfig {
            flush_ms,
            repeats,
            join_lines,
            strip_codes,
            ruby: language.ruby,
            spaces: language.spaces,
            max_chars: max_line_chars(language),
            japanese: language.is_japanese(),
            hook_codes,
            replacements,
        }
    }

    /// The line as it is shown and logged; None when it is not one to show.
    pub fn clean(&self, text: &str) -> Option<String> {
        let mut line = strip_markup(text, self.ruby);
        if self.strip_codes {
            line = strip_codes(&line);
        }
        line = collapse_repeats(&line, self.repeats);
        for rule in &self.replacements {
            line = if rule.regex {
                rule.find.replace_all(&line, rule.replace.as_str()).into_owned()
            } else {
                rule.find.replace_all(&line, NoExpand(&rule.replace)).into_owned()
            };
        }
        let line = line.trim();
        if line.is_empty() || line.chars().count() > self.max_chars {
            return None;
        }
        Some(line.to_string())
    }
}

/// The markup rules, each with whether it is a ruby rule (taken out only for a language with ruby).
fn rules() -> &'static [(Regex, &'static str, bool)] {
    static RULES: OnceLock<Vec<(Regex, &'static str, bool)>> = OnceLock::new();
    RULES.get_or_init(|| {
        [
            // Ruby readings in HTML, then any tag.
            (r"(?is)<(rt|rp)>.*?</(rt|rp)>", "", false),
            (r"</?[A-Za-z][A-Za-z0-9_-]*(?:[\s=][^<>]*)?/?>", "", false),
            // {漢字/かんじ} and {漢字:かんじ}.
            (r"\{([^{}/:]+)[/:][^{}]*\}", "$1", true),
            // [漢字/かんじ] (CatSystem; `[オレ/・・]` puts emphasis dots over the word).
            (r"\[([^\[\]/]+)/[^\[\]]*\]", "$1", true),
            // Ren'Py's text tags: {w}, {p=1.0}, {i}…{/i}, {color=#fff}.
            (r"\{/?[a-z]+(?:=[^{}]*)?\}", "", false),
            // Tyrano's line and page breaks, and its ruby tag (the base text follows it).
            (r#"\[(?:r|l|p|cm|er|resetfont|ruby\s+text="?[^\]"]*"?)\]"#, "", false),
            // ｜漢字《かんじ》 and 漢字《かんじ》.
            (r"[|｜]([^|｜《》]+)《[^《》]*》", "$1", true),
            (r"(\p{Han}+)《[^《》]*》", "$1", true),
            // A speaker as CatSystem2 sends one shown under another name (`ゆかり＠？？？「…」`):
            // the name shown.
            (r"^[^＠「『\s]{1,16}＠([^＠「『\s]{0,16}[「『])", "$1", false),
            // A line break written out (`\n`) in the script's text: Unity CatSystem.
            (r"(?:\\n)+([^A-Za-z\\]|$)", "\n$1", false),
        ]
        .into_iter()
        .map(|(pattern, to, ruby)| (Regex::new(pattern).expect("markup rule"), to, ruby))
        .collect()
    })
}

/// The line without markup, keeping the text it marks up. Without `ruby` (a language that has
/// none), the ruby forms are left as text.
pub fn strip_markup(text: &str, ruby: bool) -> String {
    let mut line = text.to_string();
    for (rule, to, is_ruby) in rules() {
        if (ruby || !is_ruby) && rule.is_match(&line) {
            line = rule.replace_all(&line, *to).into_owned();
        }
    }
    line
}

/// The line without the script codes some engines put in the text they draw: names of assets,
/// labels and flags (such as `chr00chr01先生「…`, `20$fx_shake_fa`, `VOK_`, `spr_a01_smile`,
/// `__ui_tag_room`, and markers such as `＃Ａ０１` inside the line). A code is
/// a run of ASCII letters, digits and `_ $ | -` with a `_` and a letter or digit, or mixing
/// letters and digits over five characters or more; or a `#` with letters then digits, in either
/// width. No line a game shows says one, while words, numbers, prices, hashtags and short names
/// (`OK`, `$100`, `#猫`, `PS5`, `3D`, `^_^`) are left as they are. A line that was codes and
/// nothing else comes out empty.
pub fn strip_codes(text: &str) -> String {
    if !has_codes(text) {
        return text.to_string();
    }
    let (run, mark) = code_rules();
    let line = mark.replace_all(text, "");
    let line = run.replace_all(&line, |caps: &regex::Captures| if is_code(&caps[0]) { String::new() } else { caps[0].to_string() });
    // What codes leave around them (the ` | ` between two, a stray `_`) goes with them.
    line.trim_matches(|c: char| c.is_whitespace() || "|_-".contains(c)).to_string()
}

/// Whether `text` holds a script code ([`strip_codes`]).
pub fn has_codes(text: &str) -> bool {
    let (run, mark) = code_rules();
    mark.is_match(text) || run.find_iter(text).any(|m| is_code(m.as_str()))
}

/// A run of ASCII letters, digits and `_ $ | -`, and a `#` marker.
fn code_rules() -> (&'static Regex, &'static Regex) {
    static RUN: OnceLock<Regex> = OnceLock::new();
    static MARK: OnceLock<Regex> = OnceLock::new();
    (
        RUN.get_or_init(|| Regex::new(r"[A-Za-z0-9_$|\-]+").expect("code rule")),
        MARK.get_or_init(|| Regex::new(r"[#＃][A-Za-zＡ-Ｚａ-ｚ]+[0-9０-９]+").expect("marker rule")),
    )
}

/// Whether a run of ASCII is a code: a `_` with a letter or digit, or letters and digits mixed
/// over five characters or more.
fn is_code(run: &str) -> bool {
    let letters = run.chars().any(|c| c.is_ascii_alphabetic());
    let digits = run.chars().any(|c| c.is_ascii_digit());
    (run.contains('_') && (letters || digits)) || (letters && digits && run.len() >= 5)
}

/// Whether `after` carries on the line `before`, as a game that sends its text box one row at a
/// time sends it (`「……って、なんだ田中くんか。先生に` then `何か用なの？」`): the
/// speech `before` opened is still open (`「うわっ、本が全部落ちてる～！` then
/// `よいしょ、よいしょ……」`) and `after` does not open another; or `before` does not end the way a
/// sentence ends (`。！？`, a closing bracket, an ellipsis or a dash), whatever `after` starts with
/// (`電話で叔母さんから` then `「よろしくね」と念を押されたことも`). How soon after is the
/// caller's to judge.
#[cfg(test)]
pub fn continues(before: &str, after: &str) -> bool {
    continues_in(before, after, true)
}

/// `continues` for the language being read: outside Japanese, a closing quote (`”`, `"`, `»`)
/// also ends a sentence, and speech opened with `“` or `«` is still open until it is closed.
pub fn continues_in(before: &str, after: &str, japanese: bool) -> bool {
    const ENDS: &str = "。．.！!？?」』）)】〉》］]｝}…‥―─—～〜♪♡☆★";
    const MORE_ENDS: &str = "”\"»’";
    let (Some(last), Some(first)) = (before.trim_end().chars().last(), after.trim_start().chars().next()) else {
        return false;
    };
    let open = |c: char| before.chars().filter(|x| *x == c).count();
    let speaking = open('「') > open('」') || open('『') > open('』');
    if speaking {
        return first != '「';
    }
    if !japanese {
        if let Some((opening, _)) = [('“', '”'), ('«', '»')].into_iter().find(|(o, c)| open(*o) > open(*c)) {
            return first != opening;
        }
    }
    !(ENDS.contains(last) || !japanese && MORE_ENDS.contains(last))
}

fn gcd(a: usize, b: usize) -> usize {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// Each character's repeats undone: `ここここんんんんににににちちちちはははは` → `こんにちは`.
pub fn collapse_repeats(text: &str, repeats: Repeats) -> String {
    let mut runs: Vec<(char, usize)> = Vec::new();
    for c in text.chars() {
        match runs.last_mut() {
            Some((last, count)) if *last == c => *count += 1,
            _ => runs.push((c, 1)),
        }
    }
    let by = match repeats {
        Repeats::Off => return text.to_string(),
        Repeats::Fixed(n) => n,
        // Only a line all of whose characters come the same number of times over, and enough of
        // them that it is not a word that happens to double (`ああ、ああ`).
        Repeats::Auto => {
            let shared = runs.iter().fold(0, |g, (_, count)| gcd(g, *count));
            if shared < 2 || runs.len() < 3 {
                return text.to_string();
            }
            shared
        }
    };
    runs.iter().flat_map(|(c, count)| std::iter::repeat_n(*c, count.div_ceil(by).max(1))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ja() -> &'static Language {
        crate::language::get("ja")
    }

    #[test]
    fn markup_goes_and_its_text_stays() {
        assert_eq!(strip_markup("<b>今日</b>は<color=#fff>晴れ</color>", true), "今日は晴れ");
        assert_eq!(strip_markup("<ruby>漢字<rt>かんじ</rt></ruby>です", true), "漢字です");
        assert_eq!(strip_markup("{漢字/かんじ}を{読:よ}む", true), "漢字を読む");
        assert_eq!(strip_markup("[僕/ぼく]は[思/おも]った", true), "僕は思った");
        assert_eq!(strip_markup("待って{w}ください{p=1.0}", true), "待ってください");
        assert_eq!(strip_markup("[ruby text=\"かんじ\"]漢字[r]次", true), "漢字次");
        assert_eq!(strip_markup("｜東京《とうきょう》へ行く。漢字《かんじ》", true), "東京へ行く。漢字");
        // Japanese brackets are text, not markup.
        assert_eq!(strip_markup("〈彼〉は【アキ】「……」", true), "〈彼〉は【アキ】「……」");
        assert_eq!(strip_markup("a < b > c", true), "a < b > c");
        // A speaker shown under another name: the name shown.
        assert_eq!(strip_markup("ゆかり＠？？？「本当にそうかな……」", true), "？？？「本当にそうかな……」");
        assert_eq!(strip_markup("連絡先は a＠b です「はい」", true), "連絡先は a＠b です「はい」");
        // A line break written out is one.
        assert_eq!(strip_markup("名前\\n「行くぞ」\\n", true), "名前\n「行くぞ」\n");
        assert_eq!(strip_markup("一行目\\n\\n二行目", true), "一行目\n二行目");
        assert_eq!(strip_markup("C:\\name", true), "C:\\name");
    }

    #[test]
    fn script_codes_go_and_the_line_stays() {
        // Shaped as a SiglusEngine hook sends them.
        assert_eq!(strip_codes("chr00chr01chr02chr03chr11chr10先生「じゃあ、始めましょうか。"), "先生「じゃあ、始めましょうか。");
        assert_eq!(strip_codes("20$fx_shake_fachr00chr01chr02chr03chr11chr10先生「いいのよ」"), "先生「いいのよ」");
        assert_eq!(strip_codes("SND_se04SE00se04se04今日はいい天気だ。"), "今日はいい天気だ。");
        assert_eq!(strip_codes("VOK_アキ「……ふぅ」"), "アキ「……ふぅ」");
        assert_eq!(strip_codes("0_blink01 |  |  |  | chr01アキ「はい……」"), "アキ「はい……」");
        assert_eq!(strip_codes("駅前__ui_tag_room$fx_tag_show_fa夕方__ui_tag_time$fx_tag_show_fa"), "駅前夕方");
        // Codes and nothing else.
        assert_eq!(strip_codes("2bg12_cc_fade02_fade02VOK_"), "");
        assert_eq!(strip_codes("spr_aki1a|spr_aki1A_face_ef00|spr_aki1A_face_brow40"), "");
        assert_eq!(strip_codes("chr10Xakichr24"), "");
        assert_eq!(strip_codes("＃Ａ０１　よいしょ、よいしょ……＃Ａ０４」"), "よいしょ、よいしょ……」");
        assert_eq!(strip_codes("＃Ａ０１」"), "」");
        // Words, numbers and short names are text.
        for line in ["ＰＳ５とPS5で3Dのゲーム", "OKです", "$100の時計", "＃拡散希望", "#1位", "１７時半、18時半下校", "顔文字^_^だよ", "e-mailを送る", "ああ、ああ", "………"] {
            assert_eq!(strip_codes(line), line);
        }
        let off = GameConfig::from_settings(&json!({ "stripCodes": false }), &Value::Null, ja());
        assert_eq!(off.clean("VOK_アキ「……ふぅ」").as_deref(), Some("VOK_アキ「……ふぅ」"));
        assert_eq!(GameConfig::default().clean("chr10Xakichr24"), None);
    }

    #[test]
    fn a_piece_carries_on_a_sentence_left_unfinished() {
        assert!(continues("「……って、なんだ田中くんか。先生に", "何か用なの？」"));
        assert!(continues("友達というわけじゃなくて、", "ただの「クラスメイト」というだけだ。"));
        assert!(continues("実は、今年の部長である", "山田さんは俺の幼なじみだったりする。"));
        // A finished sentence or line of speech, or a piece that opens its own, is a line of its own.
        assert!(!continues("「はい……、すみません」", "「いいの。ほら、続けて！」"));
        assert!(!continues("それがみんなの意見だ。", "本人いわく、何事も本気であり"));
        assert!(!continues("直接言ったこともあるのだけれど──", "──と返されてしまい"));
        assert!(!continues("「あ、あの、先輩……", "「ここに田中くんが来てる"));
        // Speech still open carries on past its ！, and a quote can carry on an unfinished line.
        assert!(continues("「うわっ、本が全部落ちてる～！", "よいしょ、よいしょ……」"));
        assert!(continues("「ふふっ。期待してますね、先輩っ", "」"));
        assert!(continues("あとになって、電話で叔母さんから", "「よろしくね」と念を押されたことも"));
        assert!(!continues("", "何か用なの？」"));
        let off = GameConfig::from_settings(&Value::Null, &json!({ "joinLines": false }), ja());
        assert!(!off.join_lines && GameConfig::default().join_lines);
    }

    #[test]
    fn repeats_are_undone_only_when_every_character_repeats() {
        assert_eq!(collapse_repeats("ここここんんんんににににちちちちはははは", Repeats::Auto), "こんにちは");
        assert_eq!(collapse_repeats("ここんんにちちはは", Repeats::Auto), "ここんんにちちはは");
        assert_eq!(collapse_repeats("ああ、ああ", Repeats::Auto), "ああ、ああ");
        assert_eq!(collapse_repeats("ええ……", Repeats::Auto), "ええ……");
        assert_eq!(collapse_repeats("ここんんにに", Repeats::Off), "ここんんにに");
        assert_eq!(collapse_repeats("ここんんにちちはは", Repeats::Fixed(2)), "こんにちは");
    }

    #[test]
    fn a_game_overrides_the_defaults() {
        let defaults = json!({ "flushMs": 500, "repeats": "off" });
        let game = json!({ "repeats": 2, "hookCodes": [" HS-4@1234 ", ""] });
        let config = GameConfig::from_settings(&defaults, &game, ja());
        assert_eq!(config.flush_ms, 500);
        assert_eq!(config.repeats, Repeats::Fixed(2));
        assert_eq!(config.hook_codes, vec!["HS-4@1234".to_string()]);
        let none = GameConfig::from_settings(&Value::Null, &Value::Null, ja());
        assert_eq!((none.flush_ms, none.repeats), (300, Repeats::Auto));
    }

    #[test]
    fn replacements_apply_in_order() {
        let game = json!({ "replacements": [
            { "find": "\\u3000", "replace": "" },
            { "find": "^.+?：", "replace": "", "regex": true },
            { "find": "$x", "replace": "$1" },
            { "find": "(", "replace": "", "regex": true },
            { "find": "off", "replace": "on", "enabled": false }
        ] });
        let config = GameConfig::from_settings(&Value::Null, &game, ja());
        // The broken regex is left out.
        assert_eq!(config.replacements.len(), 3);
        assert_eq!(config.clean("アキ：$x off").as_deref(), Some("$1 off"));
    }

    #[test]
    fn a_spaced_language_without_ruby_keeps_its_words() {
        let en = crate::language::get("en");
        let config = GameConfig::from_settings(&Value::Null, &Value::Null, en);
        assert!(!config.strip_codes && !config.ruby && config.spaces);
        // Ordinary words that look like codes, and slashes in brackets, are text.
        let line = "Reach Level10 as user_name with your mp3player [he/she] {yes/no}";
        assert_eq!(config.clean(line).as_deref(), Some(line));
        // Markup is still taken out.
        assert_eq!(config.clean("<b>Hello</b>{w} there").as_deref(), Some("Hello there"));
        // The reader turning code removal on wins.
        let on = GameConfig::from_settings(&json!({ "stripCodes": true }), &Value::Null, en);
        assert!(on.strip_codes);
        assert_eq!(on.clean("VOK_ Hello").as_deref(), Some("Hello"));
        // Japanese is as before.
        let ja = GameConfig::from_settings(&Value::Null, &Value::Null, ja());
        assert!(ja.strip_codes && ja.ruby && !ja.spaces);
        assert_eq!(ja.clean("[僕/ぼく]は{読:よ}む").as_deref(), Some("僕は読む"));
    }

    #[test]
    fn long_and_empty_lines_are_dropped() {
        let config = GameConfig::default();
        assert_eq!(config.clean(&"あ".repeat(MAX_LINE_CHARS + 1)), None);
        assert_eq!(config.clean("<br>"), None);
        assert_eq!(config.clean(" はい "), Some("はい".into()));
    }

    #[test]
    fn a_long_line_in_a_spaced_language_is_kept() {
        let en = crate::language::get("en");
        let config = GameConfig::from_settings(&Value::Null, &Value::Null, en);
        let paragraph = "The rain had not stopped for three days, and the river behind the old mill had risen so high that the villagers began moving their animals up the hill. Nobody spoke of the bridge. Everyone remembered what had happened the last time the water came this close, and nobody wanted to be the first to say it out loud.";
        assert!(paragraph.chars().count() > MAX_LINE_CHARS);
        assert_eq!(config.clean(paragraph).as_deref(), Some(paragraph));
        // A backlog sent as one is still dropped.
        assert_eq!(config.clean(&paragraph.repeat(4)), None);
        assert_eq!((max_line_chars(ja()), max_line_chars(crate::language::get("zh-Hant")), max_line_chars(crate::language::get("ko"))), (300, 300, 300));
        assert_eq!(max_line_chars(crate::language::get("ru")), 900);
        // Names and numbers in a line are text, not codes, in a spaced language.
        let line = "Room 12B is on level 3, Captain O'Neil. Bring the R2D2a unit and 500 credits.";
        assert_eq!(config.clean(line).as_deref(), Some(line));
    }

    #[test]
    fn rows_of_a_spaced_language_join_where_the_sentence_goes_on() {
        // Rows of one sentence.
        assert!(continues_in("Natalie, did you finish the report before", "the meeting?", false));
        assert!(continues_in("Наталья, ты закончила отчёт", "до собрания?", false));
        assert!(continues_in("“I told you already,", "but you never listen.”", false));
        assert!(continues_in("«Я же тебе говорила,", "но ты не слушаешь.»", false));
        // Two sentences, or two speeches.
        assert!(!continues_in("We have ten minutes left.", "Let's go.", false));
        assert!(!continues_in("“Ten minutes left.”", "She looked at the clock.", false));
        assert!(!continues_in("«Осталось десять минут.»", "Она посмотрела на часы.", false));
        assert!(!continues_in("“Wait,", "“No, you wait.”", false));
        assert!(!continues_in("우리 십 분밖에 안 남았어.", "가자.", false));
        // Japanese as before: a closing ” is not an end there.
        assert!(continues("彼は“はい”", "と言った。"));
        assert_eq!(continues_in("彼は“はい”", "と言った。", true), continues("彼は“はい”", "と言った。"));
    }
}
