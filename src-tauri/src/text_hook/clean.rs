//! What is done to a hooked line before it reaches the Log and the card, and the settings it is
//! done with: the game's own (`textHookerGames`) over the defaults (`textHookerDefaults`), as
//! `ui/hook-games.ts` describes them.
//!
//! Always: markup some engines leave in their text (`<b>…</b>`, `{漢字/かんじ}` ruby, Ren'Py's
//! `{w}`, Tyrano's `[r]`, `｜漢字《かんじ》`) is taken out, keeping the text it marks up; and a
//! line far longer than a game says at once (a backlog opened, a skip through a scene, sent as
//! one) is dropped. Per game: repeated characters undone (`ここここ` → `こ`), and the reader's
//! own find-and-replace rules.
use regex::{NoExpand, Regex};
use serde_json::Value;
use std::sync::OnceLock;

/// A line longer than this is not one the game shows at once.
pub const MAX_LINE_CHARS: usize = 300;
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
    pub hook_codes: Vec<String>,
    pub replacements: Vec<Replacement>,
}

impl Default for GameConfig {
    fn default() -> Self {
        GameConfig { flush_ms: DEFAULT_FLUSH_MS, repeats: Repeats::Auto, hook_codes: Vec::new(), replacements: Vec::new() }
    }
}

impl GameConfig {
    /// From the defaults and the game's record (either may be null).
    pub fn from_settings(defaults: &Value, game: &Value) -> Self {
        let pick = |key: &str| if game[key].is_null() { &defaults[key] } else { &game[key] };
        let flush_ms = pick("flushMs").as_u64().map_or(DEFAULT_FLUSH_MS, |ms| ms.clamp(20, 5000) as u32);
        let repeats = match pick("repeats") {
            Value::String(s) if s == "off" => Repeats::Off,
            Value::Number(n) => n.as_u64().filter(|n| (2..=8).contains(n)).map_or(Repeats::Auto, |n| Repeats::Fixed(n as usize)),
            _ => Repeats::Auto,
        };
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
        GameConfig { flush_ms, repeats, hook_codes, replacements }
    }

    /// The line as it is shown and logged; None when it is not one to show.
    pub fn clean(&self, text: &str) -> Option<String> {
        let mut line = strip_markup(text);
        line = collapse_repeats(&line, self.repeats);
        for rule in &self.replacements {
            line = if rule.regex {
                rule.find.replace_all(&line, rule.replace.as_str()).into_owned()
            } else {
                rule.find.replace_all(&line, NoExpand(&rule.replace)).into_owned()
            };
        }
        let line = line.trim();
        if line.is_empty() || line.chars().count() > MAX_LINE_CHARS {
            return None;
        }
        Some(line.to_string())
    }
}

fn rules() -> &'static [(Regex, &'static str)] {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    RULES.get_or_init(|| {
        [
            // Ruby readings in HTML, then any tag.
            (r"(?is)<(rt|rp)>.*?</(rt|rp)>", ""),
            (r"</?[A-Za-z][A-Za-z0-9_-]*(?:[\s=][^<>]*)?/?>", ""),
            // {漢字/かんじ} and {漢字:かんじ}.
            (r"\{([^{}/:]+)[/:][^{}]*\}", "$1"),
            // Ren'Py's text tags: {w}, {p=1.0}, {i}…{/i}, {color=#fff}.
            (r"\{/?[a-z]+(?:=[^{}]*)?\}", ""),
            // Tyrano's line and page breaks, and its ruby tag (the base text follows it).
            (r#"\[(?:r|l|p|cm|er|resetfont|ruby\s+text="?[^\]"]*"?)\]"#, ""),
            // ｜漢字《かんじ》 and 漢字《かんじ》.
            (r"[|｜]([^|｜《》]+)《[^《》]*》", "$1"),
            (r"(\p{Han}+)《[^《》]*》", "$1"),
        ]
        .into_iter()
        .map(|(pattern, to)| (Regex::new(pattern).expect("markup rule"), to))
        .collect()
    })
}

/// The line without markup, keeping the text it marks up.
pub fn strip_markup(text: &str) -> String {
    let mut line = text.to_string();
    for (rule, to) in rules() {
        if rule.is_match(&line) {
            line = rule.replace_all(&line, *to).into_owned();
        }
    }
    line
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

    #[test]
    fn markup_goes_and_its_text_stays() {
        assert_eq!(strip_markup("<b>今日</b>は<color=#fff>晴れ</color>"), "今日は晴れ");
        assert_eq!(strip_markup("<ruby>漢字<rt>かんじ</rt></ruby>です"), "漢字です");
        assert_eq!(strip_markup("{漢字/かんじ}を{読:よ}む"), "漢字を読む");
        assert_eq!(strip_markup("待って{w}ください{p=1.0}"), "待ってください");
        assert_eq!(strip_markup("[ruby text=\"かんじ\"]漢字[r]次"), "漢字次");
        assert_eq!(strip_markup("｜東京《とうきょう》へ行く。漢字《かんじ》"), "東京へ行く。漢字");
        // Japanese brackets are text, not markup.
        assert_eq!(strip_markup("〈彼〉は【アキ】「……」"), "〈彼〉は【アキ】「……」");
        assert_eq!(strip_markup("a < b > c"), "a < b > c");
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
        let config = GameConfig::from_settings(&defaults, &game);
        assert_eq!(config.flush_ms, 500);
        assert_eq!(config.repeats, Repeats::Fixed(2));
        assert_eq!(config.hook_codes, vec!["HS-4@1234".to_string()]);
        let none = GameConfig::from_settings(&Value::Null, &Value::Null);
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
        let config = GameConfig::from_settings(&Value::Null, &game);
        // The broken regex is left out.
        assert_eq!(config.replacements.len(), 3);
        assert_eq!(config.clean("アキ：$x off").as_deref(), Some("$1 off"));
    }

    #[test]
    fn long_and_empty_lines_are_dropped() {
        let config = GameConfig::default();
        assert_eq!(config.clean(&"あ".repeat(MAX_LINE_CHARS + 1)), None);
        assert_eq!(config.clean("<br>"), None);
        assert_eq!(config.clean(" はい "), Some("はい".into()));
    }
}
