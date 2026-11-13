//! The language being learned (the `language` setting), as native code needs it: the scripts it is
//! written in, whether its words are separated by spaces, whether it carries ruby, and which OCR
//! engines can read it.
//!
//! The table is `src-tauri/languages.json`, the native fields of `ui/languages.ts`
//! (`scripts/languages.test.mjs` keeps the two equal). A code this build does not list reads as
//! Japanese, and with Japanese every answer here is what the app did before languages existed.
use crate::settings::Settings;
use serde::Deserialize;
use std::sync::LazyLock;

const TABLE: &str = include_str!("../languages.json");

/// ISO 15924, with the combined codes `ui/languages.ts` uses (`Jpan` is kana and Han).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Script {
    Jpan,
    Kore,
    Hans,
    Hant,
    Latn,
    Cyrl,
    Grek,
    Deva,
    Thai,
    Geor,
    Armn,
    Khmr,
    Laoo,
    Knda,
}

impl Script {
    /// Whether `c` is a letter of this script. `Jpan` is the kana-and-kanji test the text hook has
    /// always used; `Kore` is Hangul alone (Hanja are rare enough in games that counting Han
    /// would make every Japanese thread read as Korean).
    pub fn has(self, c: char) -> bool {
        let c = c as u32;
        match self {
            Script::Jpan => matches!(c, 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF66..=0xFF9F),
            Script::Kore => matches!(c, 0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F | 0xAC00..=0xD7FF | 0xFFA0..=0xFFDC),
            Script::Hans | Script::Hant => {
                matches!(c, 0x3005..=0x3007 | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x3134F)
            }
            Script::Latn => {
                matches!(c, 0x41..=0x5A | 0x61..=0x7A | 0xAA | 0xBA | 0xC0..=0xD6 | 0xD8..=0xF6 | 0xF8..=0x24F | 0x1E00..=0x1EFF)
            }
            Script::Cyrl => matches!(c, 0x400..=0x52F | 0x1C80..=0x1C8F | 0x2DE0..=0x2DFF | 0xA640..=0xA69F),
            Script::Grek => matches!(c, 0x370..=0x3FF | 0x1F00..=0x1FFF),
            Script::Deva => matches!(c, 0x900..=0x97F | 0xA8E0..=0xA8FF),
            Script::Thai => matches!(c, 0xE00..=0xE7F),
            Script::Geor => matches!(c, 0x10A0..=0x10FF | 0x1C90..=0x1CBF | 0x2D00..=0x2D2F),
            Script::Armn => matches!(c, 0x530..=0x58F | 0xFB13..=0xFB17),
            Script::Khmr => matches!(c, 0x1780..=0x17FF | 0x19E0..=0x19FF),
            Script::Laoo => matches!(c, 0xE80..=0xEFF),
            Script::Knda => matches!(c, 0xC80..=0xCFF),
        }
    }
}

/// One row of the table. `vertical` is in the file too; nothing native reads it yet.
#[derive(Debug, Deserialize)]
pub struct Language {
    pub code: String,
    pub scripts: Vec<Script>,
    /// Words are separated by spaces.
    pub spaces: bool,
    /// Small annotation text (furigana) sits beside the main text.
    pub ruby: bool,
}

impl Language {
    pub fn is_japanese(&self) -> bool {
        self.code == JAPANESE
    }

    /// Whether `c` is a letter of one of the language's scripts.
    pub fn has(&self, c: char) -> bool {
        self.scripts.iter().any(|script| script.has(c))
    }
}

const JAPANESE: &str = "ja";

static LANGUAGES: LazyLock<Vec<Language>> =
    LazyLock::new(|| serde_json::from_str(TABLE).expect("src-tauri/languages.json is the language table"));

/// Every language, Japanese first.
pub fn all() -> &'static [Language] {
    &LANGUAGES
}

/// The language for a stored code; one this build does not list reads as Japanese.
pub fn get(code: &str) -> &'static Language {
    all().iter().find(|language| language.code == code).unwrap_or(&all()[0])
}

/// The `language` setting.
pub fn current(settings: &Settings) -> &'static Language {
    get(&settings.get_or::<String>("language", JAPANESE.into()))
}

// ---------------------------------------------------------------- OCR engines

/// The scripts the bundled PaddleOCR recogniser (PP-OCRv6 small) has in its dictionary.
const PADDLE_SCRIPTS: &[Script] = &[Script::Jpan, Script::Hans, Script::Hant, Script::Latn, Script::Grek];

/// The languages Apple Live Text reads on every macOS the app runs on (14 and later). Japanese is
/// confirmed by use, and these 15 are what `ImageAnalyzer.supportedTextRecognitionLanguages`
/// reports on macOS 26.6; which release added each is unverified (Korean, Russian and Ukrainian
/// are believed to date from 13, Thai and Vietnamese from 14). macOS 26 also reports Turkish,
/// Indonesian, Czech, Danish, Dutch, Norwegian, Polish, Romanian and Swedish, left out until
/// they can be checked against the running OS.
const LIVE_TEXT: &[&str] = &[
    "ja", "ko", "zh-Hans", "zh-Hant", "yue", "en", "fr", "it", "de", "es", "pt", "ru", "uk", "th", "vi",
];

/// The languages an OCR engine can read, or None for every language (an engine that detects the
/// script itself: Google Lens, Kimochi cloud, Screen AI, OneOCR). The `languages` field of
/// `platform_capabilities`' `ocrEngines` entries.
pub fn engine_languages(engine: &str) -> Option<Vec<&'static str>> {
    match engine {
        // Trained on Japanese alone (their model cards).
        "meikiocr" | "local" | "mangaocr" | "vocr" => Some(vec![JAPANESE]),
        // Vietnamese is Latin script, but the dictionary lacks its tone-marked vowels.
        "ppocr" => Some(
            all()
                .iter()
                .filter(|l| l.code != "vi" && l.scripts.iter().all(|s| PADDLE_SCRIPTS.contains(s)))
                .map(|l| l.code.as_str())
                .collect(),
        ),
        "livetext" => Some(LIVE_TEXT.to_vec()),
        _ => None,
    }
}

/// Whether `engine` (an `ocrMode`) can read `language` (a code).
pub fn engine_supports(engine: &str, language: &str) -> bool {
    let language = get(language).code.as_str();
    engine_languages(engine).is_none_or(|codes| codes.contains(&language))
}

/// The engines tried, in order, when the selected one cannot read the language: the OS's own,
/// then Screen AI, PaddleOCR, Google Lens and Kimochi cloud.
pub const FALLBACK_ENGINES: &[&str] = &[
    if cfg!(target_os = "macos") { "livetext" } else { "oneocr" },
    "screenai",
    "ppocr",
    "googlelens",
    "cloud",
];

/// The scan engine for `language` after the language changed to it, or None to keep `current`:
/// the one last used for it (`remembered`) while it is still `usable`; else `current` if it can
/// read the language; else the first usable engine of [`FALLBACK_ENGINES`] that can.
pub fn engine_for(
    language: &str,
    current: &str,
    remembered: Option<&str>,
    usable: impl Fn(&str) -> bool,
) -> Option<String> {
    if let Some(remembered) = remembered.filter(|r| *r != current && engine_supports(r, language) && usable(r)) {
        return Some(remembered.to_string());
    }
    if engine_supports(current, language) {
        return None;
    }
    FALLBACK_ENGINES
        .iter()
        .find(|engine| engine_supports(engine, language) && usable(engine))
        .map(|engine| engine.to_string())
}

// ---------------------------------------------------------------- text hook

/// Windows' default ANSI code page for each language (`LOCALE_IDEFAULTANSICODEPAGE` of its main
/// locale), or None for a language Windows writes in Unicode alone. Every language in the table is
/// listed, so a new one needs a decision here (`every_language_has_a_hook_code_page`).
const ANSI_CODE_PAGES: &[(&str, Option<u32>)] = &[
    ("ja", Some(932)),
    ("ko", Some(949)),
    ("zh-Hans", Some(936)),
    ("zh-Hant", Some(950)),
    ("yue", Some(950)),
    // Western European.
    ("en", Some(1252)),
    ("es", Some(1252)),
    ("fr", Some(1252)),
    ("de", Some(1252)),
    ("it", Some(1252)),
    ("pt", Some(1252)),
    ("id", Some(1252)),
    ("nl", Some(1252)),
    ("sv", Some(1252)),
    ("no", Some(1252)),
    ("da", Some(1252)),
    ("fi", Some(1252)),
    ("tl", Some(1252)),
    ("la", Some(1252)),
    ("ga", Some(1252)),
    ("cy", Some(1252)),
    ("eu", Some(1252)),
    ("gd", Some(1252)),
    // Central European.
    ("pl", Some(1250)),
    ("cs", Some(1250)),
    ("hu", Some(1250)),
    ("ro", Some(1250)),
    ("sq", Some(1250)),
    // Serbo-Croatian: its Latin spelling (Croatian, Bosnian, Serbian Latin).
    ("sh", Some(1250)),
    // Cyrillic.
    ("ru", Some(1251)),
    ("uk", Some(1251)),
    ("bg", Some(1251)),
    ("be", Some(1251)),
    ("mn", Some(1251)),
    ("el", Some(1253)),
    ("grc", Some(1253)),
    ("tr", Some(1254)),
    ("et", Some(1257)),
    ("lv", Some(1257)),
    ("vi", Some(1258)),
    ("th", Some(874)),
    // Unicode-only on Windows: no ANSI code page holds these scripts (or Esperanto's and
    // Maltese's letters).
    ("hi", None),
    ("ka", None),
    ("hy", None),
    ("km", None),
    ("lo", None),
    ("kn", None),
    ("eo", None),
    ("mt", None),
];

/// The code page the text hook decodes a game's multibyte (ANSI) strings with when its hook names
/// none (LunaHook's default code page): the language's ANSI code page, so a Korean, Chinese,
/// Russian, Thai or accented Latin game hooked through ANSI text calls reads right. Shift-JIS
/// (932), what it always was, for Japanese, and for a language with no ANSI code page: such a
/// game's text comes through its Unicode hooks, and any ANSI one is ASCII, which every code page
/// reads alike. A hook code that names its own code page (`HS949#…`, a game's own hook codes in
/// Settings → Text Hooker) still decodes with that one.
pub fn hook_code_page(language: &Language) -> u32 {
    ANSI_CODE_PAGES
        .iter()
        .find(|(code, _)| *code == language.code)
        .and_then(|(_, page)| *page)
        .unwrap_or(932)
}

// ---------------------------------------------------------------- codes for other services

/// Google Lens's `LocaleContext.language`.
pub fn lens_code(language: &Language) -> &str {
    match language.code.as_str() {
        "zh-Hans" => "zh-CN",
        "zh-Hant" => "zh-TW",
        "yue" => "zh-HK",
        code => code,
    }
}

/// Apple Live Text's recognition locale. Japanese stays the bare `ja` the app always sent.
/// macOS only (Live Text); the tests run everywhere.
#[cfg(any(target_os = "macos", test))]
pub fn apple_locale(language: &Language) -> &str {
    match language.code.as_str() {
        "ko" => "ko-KR",
        "yue" => "yue-Hant",
        "en" => "en-US",
        "fr" => "fr-FR",
        "it" => "it-IT",
        "de" => "de-DE",
        "es" => "es-ES",
        "pt" => "pt-BR",
        "ru" => "ru-RU",
        "uk" => "uk-UA",
        "th" => "th-TH",
        // Apple's own spelling.
        "vi" => "vi-VT",
        code => code,
    }
}

/// The locales Live Text is asked to read: the language first, then English, which keeps a line
/// of Latin UI text from being forced into the language's script (`["ja", "en"]` for Japanese).
#[cfg(any(target_os = "macos", test))]
pub fn live_text_locales(language: &Language) -> Vec<String> {
    let first = apple_locale(language);
    if first.starts_with("en") {
        vec![first.to_string()]
    } else {
        vec![first.to_string(), "en".to_string()]
    }
}

/// Kimochi's server's request body with the optional `language` field (OCR, read aloud, explain).
/// Left out for Japanese, the server's default, so a Japanese request is the one it always was.
pub fn with_language(mut body: serde_json::Value, language: &Language) -> serde_json::Value {
    if !language.is_japanese() {
        body["language"] = serde_json::Value::String(language.code.clone());
    }
    body
}

/// The `sourceLang` sent to Kimochi cloud translation: `JA` as always for Japanese, else the app's
/// own code, which the server maps to DeepL (or to its own translator where DeepL has none).
pub fn cloud_source(language: &Language) -> &str {
    if language.is_japanese() { "JA" } else { &language.code }
}

/// DeepL's source language code, or None where DeepL does not translate the language: the
/// base subtag upper-cased (Chinese is `ZH`, Norwegian `NB`), for DeepL's long-standing source
/// languages plus Thai and Vietnamese. Cantonese has none: DeepL's Chinese is Mandarin. Kimochi's
/// server maps the same way.
pub fn deepl_source(language: &Language) -> Option<&'static str> {
    Some(match language.code.as_str() {
        "ja" => "JA",
        "ko" => "KO",
        "zh-Hans" | "zh-Hant" => "ZH",
        "th" => "TH",
        "vi" => "VI",
        "en" => "EN",
        "es" => "ES",
        "fr" => "FR",
        "de" => "DE",
        "it" => "IT",
        "pt" => "PT",
        "ru" => "RU",
        "id" => "ID",
        "tr" => "TR",
        "pl" => "PL",
        "nl" => "NL",
        "sv" => "SV",
        "no" => "NB",
        "da" => "DA",
        "fi" => "FI",
        "el" => "EL",
        "uk" => "UK",
        "cs" => "CS",
        "hu" => "HU",
        "ro" => "RO",
        "bg" => "BG",
        "et" => "ET",
        "lv" => "LV",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_parses_and_an_unknown_code_is_japanese() {
        assert_eq!(all().len(), 49);
        assert_eq!(all()[0].code, "ja");
        assert_eq!(get("tlh").code, "ja");
        assert!(get("xx").is_japanese());
        let japanese = get("ja");
        assert_eq!((japanese.spaces, japanese.ruby, japanese.scripts.as_slice()), (false, true, &[Script::Jpan][..]));
        assert!(get("en").spaces && !get("en").ruby);
        assert_eq!(all().iter().filter(|l| l.ruby).count(), 1);
    }

    #[test]
    fn japanese_letters_are_kana_and_kanji_as_before() {
        for c in ['あ', 'ア', '漢', 'ｱ', '㐀', '豈'] {
            assert!(Script::Jpan.has(c), "{c}");
        }
        for c in ['a', '。', '한', 'я', '１'] {
            assert!(!Script::Jpan.has(c), "{c}");
        }
        assert!(get("ko").has('한') && !get("ko").has('漢'));
        assert!(get("ru").has('я') && get("fr").has('é') && !get("fr").has('я'));
    }

    #[test]
    fn japanese_only_engines_read_japanese_alone() {
        for engine in ["meikiocr", "local", "mangaocr", "vocr"] {
            assert!(engine_supports(engine, "ja"));
            assert!(!engine_supports(engine, "en") && !engine_supports(engine, "ko"), "{engine}");
        }
        for engine in ["googlelens", "cloud", "screenai", "oneocr"] {
            assert!(engine_languages(engine).is_none());
            assert!(engine_supports(engine, "ko") && engine_supports(engine, "hi"));
        }
        // Every engine reads Japanese, and an unknown code is Japanese.
        for engine in ["meikiocr", "mangaocr", "vocr", "ppocr", "livetext", "screenai", "googlelens", "cloud", "oneocr"] {
            assert!(engine_supports(engine, "ja") && engine_supports(engine, "tlh"), "{engine}");
        }
    }

    #[test]
    fn paddle_reads_han_kana_latin_and_greek_but_not_vietnamese() {
        let paddle = engine_languages("ppocr").unwrap();
        for code in ["ja", "zh-Hans", "zh-Hant", "yue", "en", "fr", "pl", "el", "grc"] {
            assert!(paddle.contains(&code), "{code}");
        }
        for code in ["vi", "ko", "ru", "th", "hi", "sh"] {
            assert!(!paddle.contains(&code), "{code}");
        }
        assert!(engine_supports("livetext", "ko") && !engine_supports("livetext", "hi"));
    }

    #[test]
    fn a_language_change_keeps_an_engine_that_reads_it() {
        let all_usable = |_: &str| true;
        assert_eq!(engine_for("ja", "meikiocr", None, all_usable), None);
        assert_eq!(engine_for("en", "googlelens", None, all_usable), None);
        assert_eq!(engine_for("en", "ppocr", None, all_usable), None);
    }

    #[test]
    fn a_language_the_engine_cannot_read_picks_the_first_usable_fallback() {
        let os = FALLBACK_ENGINES[0];
        assert_eq!(engine_for("en", "meikiocr", None, |_| true).as_deref(), Some(os));
        // Neither the OS engine nor Screen AI here: PaddleOCR reads English, not Korean.
        let no_local = |engine: &str| !matches!(engine, "livetext" | "oneocr" | "screenai");
        assert_eq!(engine_for("en", "vocr", None, no_local).as_deref(), Some("ppocr"));
        assert_eq!(engine_for("ko", "vocr", None, no_local).as_deref(), Some("googlelens"));
        // Hindi: Live Text cannot read it, OneOCR is untagged.
        let expected = if cfg!(target_os = "macos") { "screenai" } else { "oneocr" };
        assert_eq!(engine_for("hi", "mangaocr", None, |_| true).as_deref(), Some(expected));
        // Nothing usable: the engine stays.
        assert_eq!(engine_for("ko", "meikiocr", None, |_| false), None);
    }

    #[test]
    fn the_engine_last_used_for_a_language_comes_back() {
        // Japanese read with MeikiOCR, Korean with Screen AI: back to Japanese restores MeikiOCR.
        assert_eq!(engine_for("ja", "screenai", Some("meikiocr"), |_| true).as_deref(), Some("meikiocr"));
        // Not when it is no longer usable, or cannot read the language (a hand-edited setting).
        assert_eq!(engine_for("ja", "screenai", Some("meikiocr"), |e| e != "meikiocr"), None);
        assert_eq!(engine_for("ko", "googlelens", Some("meikiocr"), |_| true), None);
        assert_eq!(engine_for("ja", "meikiocr", Some("meikiocr"), |_| true), None);
    }

    #[test]
    fn every_language_has_a_hook_code_page() {
        for language in all() {
            assert!(ANSI_CODE_PAGES.iter().any(|(code, _)| *code == language.code), "{} has no row", language.code);
        }
        assert_eq!(ANSI_CODE_PAGES.len(), all().len());
        // Japanese, and an unknown code (Japanese), decode Shift-JIS as always.
        assert_eq!(hook_code_page(get("ja")), 932);
        assert_eq!(hook_code_page(get("tlh")), 932);
        let pages: Vec<(&str, u32)> = ["ko", "zh-Hans", "zh-Hant", "yue", "ru", "th", "el", "tr", "pl", "lv", "vi", "en", "fr"]
            .into_iter()
            .map(|code| (code, hook_code_page(get(code))))
            .collect();
        assert_eq!(
            pages,
            [
                ("ko", 949),
                ("zh-Hans", 936),
                ("zh-Hant", 950),
                ("yue", 950),
                ("ru", 1251),
                ("th", 874),
                ("el", 1253),
                ("tr", 1254),
                ("pl", 1250),
                ("lv", 1257),
                ("vi", 1258),
                ("en", 1252),
                ("fr", 1252)
            ]
        );
        // No ANSI code page: Shift-JIS, which reads ASCII like any other.
        for code in ["hi", "ka", "hy", "km", "lo", "kn"] {
            assert_eq!(hook_code_page(get(code)), 932, "{code}");
        }
    }

    #[test]
    fn codes_for_other_services() {
        assert_eq!(lens_code(get("ja")), "ja");
        assert_eq!(lens_code(get("ko")), "ko");
        assert_eq!(lens_code(get("zh-Hant")), "zh-TW");
        assert_eq!(live_text_locales(get("ja")), ["ja", "en"]);
        assert_eq!(live_text_locales(get("ko")), ["ko-KR", "en"]);
        assert_eq!(live_text_locales(get("en")), ["en-US"]);
        assert_eq!(deepl_source(get("ja")), Some("JA"));
        assert_eq!(deepl_source(get("zh-Hant")), Some("ZH"));
        assert_eq!(deepl_source(get("no")), Some("NB"));
        assert_eq!(deepl_source(get("hi")), None);
        assert_eq!(deepl_source(get("yue")), None);
        assert_eq!(cloud_source(get("ja")), "JA");
        assert_eq!(cloud_source(get("zh-Hant")), "zh-Hant");
        let body = serde_json::json!({ "imageBase64": "x" });
        assert_eq!(with_language(body.clone(), get("ja")), body);
        assert_eq!(with_language(body, get("ko")), serde_json::json!({ "imageBase64": "x", "language": "ko" }));
        // Every Live Text language has a locale of Apple's (a region, or a script for Chinese).
        for code in LIVE_TEXT.iter().filter(|c| **c != "ja") {
            assert!(apple_locale(get(code)).contains('-'), "{code}");
        }
    }
}
