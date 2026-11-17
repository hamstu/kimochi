//! The hook database: hook codes known to read a game's dialogue, by the game's exe, so a game
//! nobody has hooked here before can be read from its first line (#223).
//!
//! LunaTranslator has no shared database of PC games' hook codes to borrow (its per-game
//! knowledge is LunaHook's engine detection, which the sidecar already runs, and what each user's
//! copy remembers locally; see RESEARCH.md), so this is Kimochi's own: `src-tauri/texthook-hookdb.json`
//! in the repository, compiled in, and fetched again at most once a day from the mirror (else
//! GitHub) into `<app local data>/texthook/hookdb.json`. The newer `revision` of the two is used.
//! Nothing here ever waits on the network: a lookup reads what is on disk, and a refresh runs on
//! its own thread.
//!
//! An entry matches a game by its exe's file name, and, when the entry says, the name of the
//! folder the exe is in and the exe's size (many engines ship the same `SiglusEngine.exe` or
//! `game.exe` for every title). Of the entries that match, the one that checks the most wins.
//!
//! ```json
//! { "format": 1, "revision": 3, "updated": "2026-11-17",
//!   "games": [ { "exe": "game.exe", "dir": "サンプル", "exeSize": 1234567,
//!                "codes": ["HS-8@1A2B3:game.exe"], "title": "…", "vndb": "v1234" } ] }
//! ```
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BUNDLED_JSON: &str = include_str!("../../texthook-hookdb.json");
/// Where a newer copy is fetched from, in order.
pub const SOURCES: &[&str] = &[
    "https://downloads.kimochiapp.com/texthook/hookdb.json",
    "https://raw.githubusercontent.com/hamstu/kimochi/main/src-tauri/texthook-hookdb.json",
];
/// How often a newer copy is looked for.
const REFRESH_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// The largest database accepted.
const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_CODE_CHARS: usize = 300;
const FORMAT: u64 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    /// The exe's file name, matched without regard to case.
    pub exe: String,
    /// The name of the folder the exe is in, when the exe's own name is not enough.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    /// The exe's size in bytes, to tell versions or titles sharing an engine's exe apart.
    #[serde(default, rename = "exeSize", skip_serializing_if = "Option::is_none")]
    pub exe_size: Option<u64>,
    /// H-codes (or LunaHook's other codes) whose thread is the dialogue, best first.
    #[serde(default)]
    pub codes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The game's VNDB id (`v1234`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vndb: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Db {
    pub format: u64,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub updated: Option<String>,
    #[serde(default)]
    pub games: Vec<Entry>,
}

fn valid_code(code: &str) -> bool {
    let code = code.trim();
    !code.is_empty() && code.chars().count() <= MAX_CODE_CHARS && !code.chars().any(char::is_control)
}

fn valid_vndb(id: &str) -> bool {
    id.len() > 1 && id.starts_with('v') && id[1..].bytes().all(|b| b.is_ascii_digit())
}

impl Db {
    /// Parses a database, dropping entries that could not be used (no exe, an unusable code, a
    /// malformed VNDB id) rather than refusing the whole file for one bad entry.
    pub fn parse(json: &str) -> Result<Self, String> {
        if json.len() > MAX_BYTES {
            return Err("the hook database is too large".into());
        }
        let mut db: Db = serde_json::from_str(json).map_err(|e| format!("the hook database is not valid: {e}"))?;
        if db.format != FORMAT {
            return Err(format!("the hook database has format {}, not {FORMAT}", db.format));
        }
        db.games.retain_mut(|entry| {
            entry.exe = entry.exe.trim().to_string();
            entry.codes = entry.codes.iter().map(|c| c.trim().to_string()).filter(|c| valid_code(c)).collect();
            entry.vndb = entry.vndb.take().filter(|id| valid_vndb(id));
            !entry.exe.is_empty()
                && !entry.exe.contains(['/', '\\'])
                && (!entry.codes.is_empty() || entry.vndb.is_some())
        });
        Ok(db)
    }

    /// The entry for the game at `exe` (`exe_size` its size, when known): of those whose exe name
    /// and whatever else they check match, the one that checks the most.
    pub fn lookup(&self, exe: &Path, exe_size: Option<u64>) -> Option<&Entry> {
        let name = exe.file_name()?.to_string_lossy().to_lowercase();
        let dir = exe.parent().and_then(Path::file_name).map(|d| d.to_string_lossy().to_lowercase());
        self.games
            .iter()
            .filter(|e| e.exe.to_lowercase() == name)
            .filter(|e| e.dir.as_ref().is_none_or(|d| Some(d.to_lowercase()) == dir))
            .filter(|e| e.exe_size.is_none_or(|s| Some(s) == exe_size))
            .max_by_key(|e| usize::from(e.dir.is_some()) + usize::from(e.exe_size.is_some()))
    }
}

/// Whether a thread's hook code is `code` from the database: the same code, whatever its case
/// (LunaHook spells addresses and module names as it likes), ignoring surrounding space.
pub fn same_code(thread: &str, code: &str) -> bool {
    let (a, b) = (thread.trim(), code.trim());
    !a.is_empty() && a.eq_ignore_ascii_case(b)
}

// ---------------------------------------------------------------------------- loading

/// Which copy is in use, for Settings.
#[derive(Debug, Clone, Serialize)]
pub struct Info {
    pub games: usize,
    pub revision: u64,
    pub updated: Option<String>,
    /// `bundled` (the copy the app was built with) or `downloaded`.
    pub origin: &'static str,
    /// When a newer copy was last looked for (Unix ms), and why that failed, if it did.
    #[serde(rename = "checkedAt")]
    pub checked_at: Option<u64>,
    pub error: Option<String>,
}

struct Loaded {
    db: Db,
    origin: &'static str,
    checked_at: Option<u64>,
    error: Option<String>,
    refreshing: bool,
}

fn loaded() -> &'static Mutex<Option<Loaded>> {
    static LOADED: OnceLock<Mutex<Option<Loaded>>> = OnceLock::new();
    LOADED.get_or_init(|| Mutex::new(None))
}

fn bundled() -> Db {
    Db::parse(BUNDLED_JSON).expect("texthook-hookdb.json is valid")
}

fn cache_path(root: &Path) -> PathBuf {
    root.join("hookdb.json")
}
fn checked_path(root: &Path) -> PathBuf {
    root.join("hookdb.checked")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The bundled database, or the downloaded one when its revision is newer.
fn load(root: &Path) -> Loaded {
    let mut db = bundled();
    let mut origin = "bundled";
    if let Some(cached) = std::fs::read_to_string(cache_path(root)).ok().and_then(|t| Db::parse(&t).ok()) {
        if cached.revision > db.revision {
            db = cached;
            origin = "downloaded";
        }
    }
    let checked_at = std::fs::read_to_string(checked_path(root)).ok().and_then(|t| t.trim().parse().ok());
    Loaded { db, origin, checked_at, error: None, refreshing: false }
}

fn with_loaded<T>(root: &Path, f: impl FnOnce(&mut Loaded) -> T) -> T {
    let mut guard = loaded().lock().unwrap_or_else(|e| e.into_inner());
    let state = guard.get_or_insert_with(|| load(root));
    f(state)
}

/// The entry for the game at `exe`, from the copy on disk (never the network).
pub fn lookup(root: &Path, exe: &Path) -> Option<Entry> {
    let size = std::fs::metadata(exe).ok().map(|m| m.len());
    with_loaded(root, |state| state.db.lookup(exe, size).cloned())
}

pub fn info(root: &Path) -> Info {
    with_loaded(root, |state| Info {
        games: state.db.games.len(),
        revision: state.db.revision,
        updated: state.db.updated.clone(),
        origin: state.origin,
        checked_at: state.checked_at,
        error: state.error.clone(),
    })
}

/// Fetches the newest copy from the first source that answers, keeping it when its revision is
/// newer than the one in use. Blocking: run it on its own thread.
pub fn refresh(root: &Path) -> Result<Info, String> {
    let started = with_loaded(root, |state| !std::mem::replace(&mut state.refreshing, true));
    if !started {
        return Ok(info(root));
    }
    let fetched = fetch();
    let checked = now_ms();
    let _ = std::fs::create_dir_all(root);
    let _ = std::fs::write(checked_path(root), checked.to_string());
    with_loaded(root, |state| {
        state.refreshing = false;
        state.checked_at = Some(checked);
        match fetched {
            Ok((text, db)) => {
                state.error = None;
                if db.revision > state.db.revision {
                    let tmp = cache_path(root).with_extension("json.tmp");
                    if std::fs::write(&tmp, &text).is_ok() {
                        let _ = std::fs::rename(&tmp, cache_path(root));
                    }
                    state.db = db;
                    state.origin = "downloaded";
                }
            }
            Err(e) => state.error = Some(e),
        }
    });
    Ok(info(root))
}

/// Looks for a newer copy on its own thread, unless one was looked for in the last day.
pub fn refresh_if_due(root: PathBuf) {
    let due = with_loaded(&root, |state| {
        !state.refreshing
            && state.checked_at.is_none_or(|at| now_ms().saturating_sub(at) > REFRESH_EVERY.as_millis() as u64)
    });
    if due {
        std::thread::spawn(move || {
            let _ = refresh(&root);
        });
    }
}

fn fetch() -> Result<(String, Db), String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("Kimochi/", env!("CARGO_PKG_VERSION"), " (hook database)"))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut last = String::from("no source answered");
    for url in SOURCES {
        let result = client
            .get(*url)
            .send()
            .map_err(|e| format!("network error: {}", e.without_url()))
            .and_then(|r| {
                if r.status().is_success() {
                    Ok(r)
                } else {
                    Err(format!("{} answered HTTP {}", r.url().host_str().unwrap_or("the server"), r.status().as_u16()))
                }
            })
            .and_then(|r| r.text().map_err(|e| format!("network error: {e}")))
            .and_then(|text| Db::parse(&text).map(|db| (text, db)));
        match result {
            Ok(found) => return Ok(found),
            Err(e) => last = e,
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db(json: &str) -> Db {
        Db::parse(json).unwrap()
    }

    #[test]
    fn the_bundled_database_parses() {
        let db = bundled();
        assert_eq!(db.format, 1);
    }

    #[test]
    fn an_entry_matches_by_exe_name_then_by_what_else_it_checks() {
        let db = db(r#"{"format":1,"revision":1,"games":[
            {"exe":"SiglusEngine.exe","codes":["HS0@1:SiglusEngine.exe"]},
            {"exe":"SiglusEngine.exe","dir":"Summer Pockets","codes":["HQ-8@2:SiglusEngine.exe"],"vndb":"v20424"},
            {"exe":"SiglusEngine.exe","dir":"Summer Pockets","exeSize":42,"codes":["HQ-8@3:SiglusEngine.exe"]}
        ]}"#);
        let exe = Path::new(r"C:\Games\Summer Pockets\siglusengine.EXE");
        assert_eq!(db.lookup(exe, Some(42)).unwrap().codes, ["HQ-8@3:SiglusEngine.exe"], "the most specific");
        assert_eq!(db.lookup(exe, Some(7)).unwrap().codes, ["HQ-8@2:SiglusEngine.exe"], "the size does not match");
        assert_eq!(db.lookup(exe, None).unwrap().vndb.as_deref(), Some("v20424"));
        let other = Path::new(r"C:\Games\Another\SiglusEngine.exe");
        assert_eq!(db.lookup(other, None).unwrap().codes, ["HS0@1:SiglusEngine.exe"], "the engine-wide entry");
        assert!(db.lookup(Path::new(r"C:\Games\x\game.exe"), None).is_none());
    }

    #[test]
    fn unusable_entries_are_dropped_not_the_file() {
        let db = db(r#"{"format":1,"games":[
            {"exe":"","codes":["HS0@1"]},
            {"exe":"a\\b.exe","codes":["HS0@1"]},
            {"exe":"a.exe","codes":["  "]},
            {"exe":"b.exe","codes":["bad\ncode"],"vndb":"v12"},
            {"exe":"c.exe","codes":["HS0@1:c.exe"],"vndb":"https://vndb.org/v1"}
        ]}"#);
        assert_eq!(db.games.len(), 2);
        assert!(db.games[0].codes.is_empty() && db.games[0].vndb.as_deref() == Some("v12"));
        assert_eq!(db.games[1].vndb, None);
        assert!(Db::parse(r#"{"format":2,"games":[]}"#).is_err(), "a format this build does not know");
        assert!(Db::parse("not json").is_err());
    }

    #[test]
    fn codes_compare_without_case() {
        assert!(same_code("HS-8@1a2b3:Game.exe", " hs-8@1A2B3:game.exe "));
        assert!(!same_code("HS-8@1a2b3:Game.exe", "HS-8@1a2b4:Game.exe"));
        assert!(!same_code("", ""));
    }

    #[test]
    fn a_downloaded_copy_is_used_only_when_newer() {
        let root = std::env::temp_dir().join(format!("kimochi-hookdb-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let newer = r#"{"format":1,"revision":999999,"games":[{"exe":"new.exe","codes":["HS0@1:new.exe"]}]}"#;
        std::fs::write(cache_path(&root), newer).unwrap();
        let state = load(&root);
        assert_eq!(state.origin, "downloaded");
        assert!(state.db.lookup(Path::new("new.exe"), None).is_some());
        let older = r#"{"format":1,"revision":0,"games":[{"exe":"old.exe","codes":["HS0@1:old.exe"]}]}"#;
        std::fs::write(cache_path(&root), older).unwrap();
        assert_eq!(load(&root).origin, "bundled");
        let _ = std::fs::remove_file(cache_path(&root));
        let _ = std::fs::remove_dir(&root);
    }
}
