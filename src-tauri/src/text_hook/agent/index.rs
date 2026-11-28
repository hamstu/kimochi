//! Which Agent script fits a game, from the index compiled in with the pinned scripts
//! (`src-tauri/agent-scripts.json`, written by `scripts/agent-scripts-package.mjs`). Asked before
//! anything is downloaded, so a game with a script can be offered one at once.
//!
//! - A game run by an emulator is told by the emulator's executable; its title id or disc serial
//!   (`0100A3A00CC7E000`, `ULJM05800`), which most emulators put in their window title, picks the
//!   script, else the game's name in the title does.
//! - A Steam game is told by its app id: from `steam_appid.txt` beside it, or the Steam library's
//!   `appmanifest_<id>.acf` for the folder it is installed in (under Proton too).
//! - Any other PC game only by its exact title (the window's, or its folder's): a script that
//!   hooks the wrong game sends nothing, which looks like a game that is quiet.
//!
//! Where a title has several scripts (one per language of a multilingual release), the one in the
//! language being read comes first.
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const INDEX_JSON: &str = include_str!("../../../agent-scripts.json");

#[derive(Debug, Clone, Deserialize)]
pub struct Archive {
    pub urls: Vec<String>,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Script {
    pub file: String,
    pub title: String,
    pub platform: String,
    #[serde(default)]
    pub ids: Vec<String>,
    #[serde(default)]
    pub steam: Vec<u64>,
    #[serde(default)]
    pub lang: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub generic: bool,
}

#[derive(Debug, Deserialize)]
pub struct Index {
    pub repository: String,
    pub commit: String,
    pub archive: Archive,
    /// `[name, size, sha256]` for every file of the collection.
    pub files: Vec<(String, u64, String)>,
    pub scripts: Vec<Script>,
}

pub fn index() -> &'static Index {
    static INDEX: OnceLock<Index> = OnceLock::new();
    INDEX.get_or_init(|| serde_json::from_str(INDEX_JSON).expect("agent-scripts.json is valid"))
}

/// The platform an emulator runs games of, from its executable's name.
pub fn emulator_platform(exe: &Path) -> Option<&'static str> {
    let path = exe.to_string_lossy().replace('\\', "/");
    let stem = Path::new(&path).file_stem()?.to_string_lossy().to_lowercase();
    const EMULATORS: &[(&str, &[&str])] = &[
        ("switch", &["yuzu", "suyu", "sudachi", "citron", "eden", "torzu", "ryujinx", "ryubing"]),
        ("psp", &["ppsspp"]),
        ("ps2", &["pcsx2"]),
        ("ps3", &["rpcs3"]),
        ("vita", &["vita3k"]),
        ("3ds", &["citra", "lime3ds", "azahar", "mandarine"]),
        ("pc98", &["dosbox-x", "dosbox_x"]),
    ];
    EMULATORS.iter().find(|(_, names)| names.iter().any(|name| stem.starts_with(name))).map(|(platform, _)| *platform)
}

/// Title ids (16 hex digits, with optional `0x` prefix) and disc serials (`SLPM-65732`,
/// `ULJM05800`, `PCSG 00291`) in a window title, as the index keeps them: upper case, letters and
/// digits.
pub fn ids_in(title: &str) -> Vec<String> {
    let upper = title.to_uppercase();
    let chars: Vec<char> = upper.chars().collect();
    let mut found = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let alone_before = i == 0 || !chars[i - 1].is_ascii_alphanumeric();
        // A title id: 16 hex digits, standing alone (optionally prefixed by `0X`).
        let hex_start = if alone_before && chars.get(i..i + 2) == Some(&['0', 'X']) { i + 2 } else { i };
        if alone_before && hex_start < chars.len() {
            let hex: String = chars[hex_start..].iter().take_while(|c| c.is_ascii_hexdigit()).collect();
            if hex.len() == 16 && hex.chars().any(|c| c.is_ascii_digit()) {
                found.push(hex);
                i = hex_start + 16;
                continue;
            }
        }
        // A serial: four letters, an optional separator, five digits (maybe split by a dot).
        if alone_before && i + 4 <= chars.len() && chars[i..i + 4].iter().all(|c| c.is_ascii_uppercase()) {
            let mut j = i + 4;
            if j < chars.len() && matches!(chars[j], '-' | '_' | ' ') {
                j += 1;
            }
            let mut digits = String::new();
            while j < chars.len() && digits.len() < 5 && (chars[j].is_ascii_digit() || chars[j] == '.') {
                if chars[j] != '.' {
                    digits.push(chars[j]);
                }
                j += 1;
            }
            let alone_after = j >= chars.len() || !chars[j].is_ascii_alphanumeric();
            if digits.len() == 5 && alone_after {
                found.push(format!("{}{digits}", chars[i..i + 4].iter().collect::<String>()));
                i = j;
                continue;
            }
        }
        i += 1;
    }
    found
}

/// Folds fullwidth ASCII (`！..=～`) to plain ASCII so titles written in either width match.
fn fold_width(c: char) -> char {
    match c {
        '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
        _ => c,
    }
}

/// A name as titles are compared: lower case, fullwidth ASCII folded, letters and digits of any
/// script only.
pub fn normalise(name: &str) -> String {
    name.chars().map(fold_width).filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// The Steam app id of the game at `exe`: its `steam_appid.txt`, else the library manifest for the
/// folder it is installed in. Cached per path because `texthook_targets` polls every few seconds
/// and a Steam library can hold hundreds of `.acf` manifests.
pub fn steam_app_id(exe: &Path) -> Option<u64> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Option<u64>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(&cached) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(exe) {
        return cached;
    }
    let found = steam_app_id_uncached(exe);
    let mut map = cache.lock().unwrap_or_else(|e| e.into_inner());
    if map.len() > 256 {
        map.clear();
    }
    map.insert(exe.to_path_buf(), found);
    found
}

fn steam_app_id_uncached(exe: &Path) -> Option<u64> {
    for dir in exe.ancestors().skip(1).take(4) {
        if let Ok(text) = std::fs::read_to_string(dir.join("steam_appid.txt")) {
            if let Ok(id) = text.trim().parse() {
                return Some(id);
            }
        }
    }
    // `…/steamapps/common/<installdir>/…`
    let parts: Vec<&std::ffi::OsStr> = exe.iter().collect();
    let common = parts.iter().rposition(|p| p.to_string_lossy().eq_ignore_ascii_case("common"))?;
    if common == 0 || !parts[common - 1].to_string_lossy().eq_ignore_ascii_case("steamapps") {
        return None;
    }
    let installdir = parts.get(common + 1)?.to_string_lossy().to_string();
    let steamapps: std::path::PathBuf = parts[..common].iter().collect();
    for entry in std::fs::read_dir(&steamapps).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_prefix("appmanifest_").and_then(|n| n.strip_suffix(".acf")) else { continue };
        let Ok(acf) = std::fs::read_to_string(entry.path()) else { continue };
        if acf_value(&acf, "installdir").is_some_and(|dir| dir.eq_ignore_ascii_case(&installdir)) {
            return id.parse().ok();
        }
    }
    None
}

/// A top-level `"key" "value"` of a Steam `.acf` (text KeyValues).
fn acf_value(acf: &str, key: &str) -> Option<String> {
    acf.lines().find_map(|line| {
        let mut quoted = line.split('"').skip(1).step_by(2);
        (quoted.next()?.eq_ignore_ascii_case(key)).then(|| quoted.next().map(str::to_string)).flatten()
    })
}

/// What a game is, for matching.
#[derive(Debug, Clone)]
pub struct Game<'a> {
    pub exe: &'a Path,
    pub window_title: Option<&'a str>,
    pub steam: Option<u64>,
    /// The language being read (`ja`).
    pub language: &'a str,
}

/// Pre-indexed view of the compiled-in scripts so frequent `texthook_targets` calls do no repeated
/// title normalisation or full-collection scans.
struct Lookup {
    /// `(platform, id)` → script indices.
    by_id: HashMap<(&'static str, String), Vec<usize>>,
    /// `platform` → `(script index, normalised title, char len)` for titles >= 4 chars.
    by_platform: HashMap<&'static str, Vec<(usize, String, usize)>>,
    /// Steam app id → PC script indices.
    by_steam: HashMap<u64, Vec<usize>>,
    /// Normalised PC title (>= 3 chars) → PC script indices.
    by_pc_name: HashMap<String, Vec<usize>>,
}

impl Lookup {
    fn build(scripts: &'static [Script]) -> Self {
        let mut by_id: HashMap<(&'static str, String), Vec<usize>> = HashMap::new();
        let mut by_platform: HashMap<&'static str, Vec<(usize, String, usize)>> = HashMap::new();
        let mut by_steam: HashMap<u64, Vec<usize>> = HashMap::new();
        let mut by_pc_name: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, s) in scripts.iter().enumerate() {
            if s.generic {
                continue;
            }
            let norm = normalise(&s.title);
            let len = norm.chars().count();
            if s.platform == "pc" {
                for &app_id in &s.steam {
                    by_steam.entry(app_id).or_default().push(i);
                }
                if len >= 3 {
                    by_pc_name.entry(norm).or_default().push(i);
                }
            } else {
                let plat: &'static str = s.platform.as_str();
                for id in &s.ids {
                    by_id.entry((plat, id.clone())).or_default().push(i);
                }
                if len >= 4 {
                    by_platform.entry(plat).or_default().push((i, norm, len));
                }
            }
        }
        Lookup { by_id, by_platform, by_steam, by_pc_name }
    }
}

fn lookup() -> &'static Lookup {
    static LOOKUP: OnceLock<Lookup> = OnceLock::new();
    LOOKUP.get_or_init(|| Lookup::build(&index().scripts))
}

fn best_for_language<'s>(candidates: impl IntoIterator<Item = &'s Script>, language: &str) -> Option<&'s Script> {
    // The script in the language being read, then one for any language, then the rest.
    candidates.into_iter().min_by_key(|s| match s.lang.as_deref() {
        Some(lang) if lang == language => 0,
        None => 1,
        Some(_) => 2,
    })
}

/// The script for this game, if the collection has one.
pub fn find(game: &Game) -> Option<&'static Script> {
    let scripts = &index().scripts;
    let map = lookup();
    let title = game.window_title.unwrap_or_default();
    let candidates: Vec<&'static Script> = match emulator_platform(game.exe) {
        Some(platform) => {
            let mut by_id = Vec::new();
            for id in ids_in(title) {
                if let Some(indices) = map.by_id.get(&(platform, id)) {
                    for &i in indices {
                        if !by_id.iter().any(|s: &&Script| std::ptr::eq(*s, &scripts[i])) {
                            by_id.push(&scripts[i]);
                        }
                    }
                }
            }
            if by_id.is_empty() {
                let window = normalise(title);
                let mut longest = 0usize;
                let mut named = Vec::new();
                if let Some(entries) = map.by_platform.get(platform) {
                    for (i, name, len) in entries {
                        if *len >= longest && window.contains(name.as_str()) {
                            if *len > longest {
                                longest = *len;
                                named.clear();
                            }
                            named.push(&scripts[*i]);
                        }
                    }
                }
                named
            } else {
                by_id
            }
        }
        None => {
            let by_steam: Vec<&'static Script> = game
                .steam
                .and_then(|id| map.by_steam.get(&id))
                .map(|indices| indices.iter().map(|&i| &scripts[i]).collect())
                .unwrap_or_default();
            if by_steam.is_empty() {
                let window = normalise(title);
                let path = game.exe.to_string_lossy().replace('\\', "/");
                let folder =
                    Path::new(&path).parent().and_then(Path::file_name).map(|f| normalise(&f.to_string_lossy()));
                let mut matched = Vec::new();
                if let Some(indices) = map.by_pc_name.get(&window) {
                    matched.extend(indices.iter().map(|&i| &scripts[i]));
                }
                if let Some(folder) = folder.filter(|f| f != &window) {
                    if let Some(indices) = map.by_pc_name.get(&folder) {
                        for &i in indices {
                            if !matched.iter().any(|s| std::ptr::eq(*s, &scripts[i])) {
                                matched.push(&scripts[i]);
                            }
                        }
                    }
                }
                matched
            } else {
                by_steam
            }
        }
    };
    best_for_language(candidates, game.language)
}

#[cfg(test)]
pub fn find_in<'s>(scripts: &'s [Script], game: &Game) -> Option<&'s Script> {
    let title = game.window_title.unwrap_or_default();
    let candidates: Vec<&Script> = match emulator_platform(game.exe) {
        Some(platform) => {
            let on: Vec<&Script> = scripts.iter().filter(|s| s.platform == platform && !s.generic).collect();
            let ids = ids_in(title);
            let by_id: Vec<&Script> = on.iter().copied().filter(|s| s.ids.iter().any(|id| ids.contains(id))).collect();
            if by_id.is_empty() {
                // The game's name in the title (`Eden | v0.1 | Tsukihime | 1.0.2`): the longest
                // script title found there, at least four letters of it.
                let window = normalise(title);
                let mut longest = 0usize;
                let mut named = Vec::new();
                for s in on {
                    let name = normalise(&s.title);
                    let len = name.chars().count();
                    if len >= 4 && len >= longest && window.contains(&name) {
                        if len > longest {
                            longest = len;
                            named.clear();
                        }
                        named.push(s);
                    }
                }
                named
            } else {
                by_id
            }
        }
        None => {
            let pc = |s: &&Script| s.platform == "pc" && !s.generic;
            let by_steam: Vec<&Script> = game
                .steam
                .map_or_else(Vec::new, |id| scripts.iter().filter(pc).filter(|s| s.steam.contains(&id)).collect());
            if by_steam.is_empty() {
                let window = normalise(title);
                let path = game.exe.to_string_lossy().replace('\\', "/");
                let folder =
                    Path::new(&path).parent().and_then(Path::file_name).map(|f| normalise(&f.to_string_lossy()));
                scripts
                    .iter()
                    .filter(pc)
                    .filter(|s| {
                        let name = normalise(&s.title);
                        name.chars().count() >= 3 && (name == window || folder.as_deref() == Some(name.as_str()))
                    })
                    .collect()
            } else {
                by_steam
            }
        }
    };
    best_for_language(candidates, game.language)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn script(file: &str, title: &str, platform: &str, ids: &[&str], steam: &[u64], lang: Option<&str>) -> Script {
        Script {
            file: file.into(),
            title: title.into(),
            platform: platform.into(),
            ids: ids.iter().map(|s| s.to_string()).collect(),
            steam: steam.to_vec(),
            lang: lang.map(String::from),
            version: None,
            author: None,
            generic: false,
        }
    }

    fn scripts() -> Vec<Script> {
        vec![
            script("NS_0100A3A00CC7E000_CLANNAD.js", "CLANNAD", "switch", &["0100A3A00CC7E000"], &[], None),
            script("NS_0100A3A00CC7E000_CLANNAD_JP.js", "CLANNAD", "switch", &["0100A3A00CC7E000"], &[], Some("ja")),
            script(
                "NS_01001DC01486A000_Tsukihime.js",
                "月姫 -A piece of blue glass moon-",
                "switch",
                &["01001DC01486A000"],
                &[],
                None,
            ),
            script("NS_0100XXXX_Tsuki.js", "Tsuki", "switch", &["0100000000000001"], &[], None),
            script("NS_0100YYYY_Tsukihime_EN.js", "Tsukihime", "switch", &["0100000000000002"], &[], Some("en")),
            script("PSP_NPJH50505_Fate-EXTRA-CCC.js", "Fate/EXTRA CCC", "psp", &["NPJH50505"], &[], None),
            script("PC_Steam_Air.js", "AIR", "pc", &[], &[2983250], None),
            script("PC_Leaf_Kizuato.js", "Kizuato", "pc", &[], &[], None),
        ]
    }

    fn game<'a>(exe: &'a Path, title: &'a str) -> Game<'a> {
        Game { exe, window_title: Some(title), steam: None, language: "ja" }
    }

    #[test]
    fn emulators_are_told_by_their_executable() {
        assert_eq!(emulator_platform(Path::new("C:/Emu/yuzu.exe")), Some("switch"));
        assert_eq!(emulator_platform(Path::new("/Applications/PPSSPPSDL.app/Contents/MacOS/PPSSPPSDL")), Some("psp"));
        assert_eq!(emulator_platform(Path::new("/Applications/azahar.app/Contents/MacOS/azahar")), Some("3ds"));
        assert_eq!(emulator_platform(Path::new("/Applications/Eden.app/Contents/MacOS/eden")), Some("switch"));
        assert_eq!(emulator_platform(Path::new("/opt/Ryujinx/Ryujinx.Ava")), Some("switch"));
        assert_eq!(emulator_platform(Path::new("C:/PPSSPP/PPSSPPWindows64.exe")), Some("psp"));
        assert_eq!(emulator_platform(Path::new("C:/pcsx2/pcsx2-qt.exe")), Some("ps2"));
        assert_eq!(emulator_platform(Path::new("C:/Vita3K/Vita3K.exe")), Some("vita"));
        assert_eq!(emulator_platform(Path::new("C:/Games/Air/SiglusEngine.exe")), None);
    }

    #[test]
    fn title_ids_and_serials_are_read_off_window_titles() {
        assert_eq!(ids_in("Eden | 0100A3A00CC7E000 | CLANNAD"), vec!["0100A3A00CC7E000"]);
        assert_eq!(ids_in("PPSSPP v1.18 - NPJH50505 : Fate/EXTRA CCC"), vec!["NPJH50505"]);
        assert_eq!(ids_in("PCSX2 2.4 | Akai Ito [SLPM-65732]"), vec!["SLPM65732"]);
        assert_eq!(ids_in("SLPM_657.32"), vec!["SLPM65732"]);
        assert!(ids_in("Vita3K | ABCDE12345 longer").is_empty());
        assert!(ids_in("DEADBEEFDEADBEEFAA").is_empty(), "17+ hex digits is no title id");
    }

    #[test]
    fn an_emulated_game_is_matched_by_id_then_by_its_name_in_the_title() {
        let all = scripts();
        let yuzu = PathBuf::from("C:/Emu/yuzu.exe");
        // By id, in the language being read.
        let found = find_in(&all, &game(&yuzu, "yuzu 1734 | 0100A3A00CC7E000 | CLANNAD")).unwrap();
        assert_eq!(found.file, "NS_0100A3A00CC7E000_CLANNAD_JP.js");
        let english = Game { language: "en", ..game(&yuzu, "yuzu | 0100A3A00CC7E000") };
        assert_eq!(find_in(&all, &english).unwrap().file, "NS_0100A3A00CC7E000_CLANNAD.js");
        // By name: the longest title found, never a shorter one inside it.
        let eden = PathBuf::from("C:/Eden/eden.exe");
        let found = find_in(&all, &game(&eden, "Eden | v0.0.3 | 月姫 -A piece of blue glass moon- | 1.0.2")).unwrap();
        assert_eq!(found.file, "NS_01001DC01486A000_Tsukihime.js");
        let found = find_in(&all, &game(&eden, "Eden | v0.0.3 | Tsukihime (64-bit) | 1.0.2")).unwrap();
        assert_eq!(found.file, "NS_0100YYYY_Tsukihime_EN.js");
        // Another platform's script never.
        let ppsspp = PathBuf::from("C:/PPSSPP/PPSSPPWindows64.exe");
        assert!(find_in(&all, &game(&ppsspp, "PPSSPP - 0100A3A00CC7E000")).is_none());
        assert_eq!(
            find_in(&all, &game(&ppsspp, "PPSSPP v1.18 - NPJH50505")).unwrap().file,
            "PSP_NPJH50505_Fate-EXTRA-CCC.js"
        );
    }

    #[test]
    fn a_pc_game_is_matched_by_steam_id_or_exact_title_only() {
        let all = scripts();
        let exe = PathBuf::from("D:/SteamLibrary/steamapps/common/AIR/SiglusEngine.exe");
        let steam = Game { steam: Some(2983250), ..game(&exe, "AIR") };
        assert_eq!(find_in(&all, &steam).unwrap().file, "PC_Steam_Air.js");
        // Not a Steam game it knows: the title must be the script's, exactly.
        let other = PathBuf::from("C:/Games/Kizuato/kizuato.exe");
        assert_eq!(find_in(&all, &game(&other, "Kizuato")).unwrap().file, "PC_Leaf_Kizuato.js");
        assert_eq!(find_in(&all, &game(&other, "whatever")).unwrap().file, "PC_Leaf_Kizuato.js", "by its folder");
        let lookalike = PathBuf::from("C:/Games/Airship/game.exe");
        assert!(find_in(&all, &game(&lookalike, "AIR Battle")).is_none());
    }

    #[test]
    fn steam_app_ids_come_from_the_library_or_steam_appid_txt() {
        let base = std::env::temp_dir().join(format!("kimochi-agent-steam-{}", std::process::id()));
        let game_dir = base.join("steamapps").join("common").join("AIR");
        std::fs::create_dir_all(&game_dir).unwrap();
        std::fs::write(
            base.join("steamapps").join("appmanifest_2983250.acf"),
            "\"AppState\"\n{\n\t\"appid\"\t\t\"2983250\"\n\t\"installdir\"\t\t\"AIR\"\n}\n",
        )
        .unwrap();
        assert_eq!(steam_app_id(&game_dir.join("SiglusEngine.exe")), Some(2983250));
        let other = base.join("Other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("steam_appid.txt"), "976390\n").unwrap();
        assert_eq!(steam_app_id(&other.join("game.exe")), Some(976390));
        assert_eq!(steam_app_id(&base.join("Nothing").join("game.exe")), None);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_compiled_in_index_parses_and_has_the_runtime() {
        let index = index();
        assert_eq!(index.commit.len(), 40);
        assert!(index.files.iter().any(|(name, _, _)| name == "libLoader.js"));
        assert!(index.scripts.len() > 400);
    }

    #[test]
    fn both_seishun_psp_discs_match_the_compiled_in_script() {
        let exe = Path::new("PPSSPPWindows64.exe");
        for serial in ["ULJM06302", "ULJM06303"] {
            let title = format!("PPSSPP v1.19.3 - {serial} : 青春はじめました！");
            let found = find(&game(exe, &title)).unwrap();
            assert_eq!(found.file, "PSP_ULJM06302-3_Seishun_Hajimemashita.js");
        }
    }

    #[test]
    fn fullwidth_titles_0x_prefixed_ids_and_mandarine_match() {
        assert_eq!(normalise("ＣＬＡＮＮＡＤ"), "clannad");
        assert_eq!(normalise("９-nine-"), "9nine");
        assert_eq!(ids_in("Eden | 0x0100A3A00CC7E000 | CLANNAD"), vec!["0100A3A00CC7E000"]);
        assert_eq!(emulator_platform(Path::new("/usr/bin/mandarine-qt")), Some("3ds"));
        // Pre-indexed `find` agrees with linear `find_in` on compiled-in scripts.
        let eden = Path::new("C:/Eden/eden.exe");
        let query = game(eden, "Eden | 0x0100A3A00CC7E000 | ＣＬＡＮＮＡＤ");
        assert_eq!(find(&query), find_in(&index().scripts, &query));
        assert_eq!(find(&query).unwrap().file, "NS_0100A3A00CC7E000_CLANNAD_JP.js");
    }
}
