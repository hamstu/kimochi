//! The `chrome.storage` files of every dictionary engine: Yomitan's `chrome-local.json` and an
//! extension engine's `chrome-local-<id>.json`, in the app data directory (COMMANDS.md,
//! `storage_load` / `storage_save` / `storage_backup`).
//!
//! They describe the user's dictionaries (Hachidori's `dictionaryState`, 10ten's
//! `lastDbUpdateTime`, Yomitan's options and profiles), so nothing here may ever turn a good file
//! into an empty or broken one:
//!
//! - **Writes are atomic and durable.** The bytes go to a temp file unique to this write, are
//!   flushed to disk, and replace the file with one rename; a crash or a second Kimochi process
//!   writing at the same moment leaves either the old file or the new one, never half of one.
//! - **The previous good copy is kept** as `<file>.prev` (a hard link to the replaced file, so no
//!   bytes are copied), refreshed on every write.
//! - **A file that does not parse is never answered with `{}`.** It is moved aside to
//!   `<file>.corrupt-<ms>` and the `.prev` copy is loaded instead; with no usable `.prev` the load
//!   fails, and the caller must not write (the extension host then runs without saving). Only a
//!   file that does not exist, and has no `.prev` either, loads as `{}`.
//! - **Backups are bounded.** `storage_backup` copies and `.corrupt-` quarantines keep the newest
//!   `KEEP_COPIES` of each kind per file; older ones are removed.
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// How many `.bak-<ms>` (and, separately, `.corrupt-<ms>`) copies of one file are kept.
pub const KEEP_COPIES: usize = 10;

/// What `load` found.
#[derive(Debug, PartialEq)]
pub struct Loaded {
    pub value: Value,
    /// Set when the file itself could not be used and `.prev` was loaded instead: the evidence
    /// record for the evidence log.
    pub recovered: Option<Value>,
}

pub fn prev_name(file: &str) -> String {
    format!("{file}.prev")
}

fn parse(bytes: &[u8]) -> Result<Value, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if value.is_object() {
        Ok(value)
    } else {
        Err("not a JSON object".into())
    }
}

enum Read {
    Missing,
    Corrupt(String),
    Value(Value),
}

fn read(path: &Path) -> Result<Read, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(match parse(&bytes) {
            Ok(value) => Read::Value(value),
            Err(e) => Read::Corrupt(e),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Read::Missing),
        Err(e) => Err(format!("native: could not read {}: {e}", path.display())),
    }
}

/// Load `file` from `dir` (see the module notes for what happens to a missing or corrupt file).
pub fn load(dir: &Path, file: &str, now_ms: u128) -> Result<Loaded, String> {
    let path = dir.join(file);
    let reason = match read(&path)? {
        Read::Value(value) => return Ok(Loaded { value, recovered: None }),
        Read::Missing => None,
        Read::Corrupt(e) => Some(e),
    };
    let quarantined = match &reason {
        Some(_) => {
            let name = format!("{file}.corrupt-{now_ms}");
            std::fs::rename(&path, dir.join(&name))
                .map_err(|e| format!("native: {file} is not valid JSON and could not be set aside: {e}"))?;
            prune(dir, &format!("{file}.corrupt-"), KEEP_COPIES);
            Some(name)
        }
        None => None,
    };
    let prev = prev_name(file);
    match read(&dir.join(&prev)) {
        Ok(Read::Value(value)) => {
            // Put the good copy back in place, so the next launch reads it directly.
            let _ = write_atomic(&path, &serde_json::to_vec(&value).map_err(|e| e.to_string())?);
            Ok(Loaded {
                value,
                recovered: Some(json!({
                    "check": "storage-recovered",
                    "file": file,
                    "from": prev,
                    "reason": if reason.is_some() { "corrupt" } else { "missing" },
                    "error": reason,
                    "quarantined": quarantined,
                })),
            })
        }
        _ => match (reason, quarantined) {
            (None, _) => Ok(Loaded { value: json!({}), recovered: None }),
            (Some(e), name) => Err(format!(
                "native: {file} is not valid JSON ({e}); it was kept as {} and there is no previous copy",
                name.unwrap_or_default()
            )),
        },
    }
}

/// Serialise every write of this process: one rename at a time per process, so `.prev` always
/// names the file a write replaced.
static WRITES: Mutex<()> = Mutex::new(());

/// Atomically and durably replace `path` with `bytes` (see the module notes).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = path.parent().ok_or("native: a storage file needs a directory")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = path.file_name().and_then(|n| n.to_str()).ok_or("native: bad storage file name")?;
    let tmp = dir.join(format!(
        ".{name}.{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("native: could not write {name}: {e}"));
    }
    let _guard = WRITES.lock().unwrap_or_else(|p| p.into_inner());
    keep_previous(dir, name);
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("native: could not replace {name}: {e}"));
    }
    sync_dir(dir);
    Ok(())
}

/// `<file>.prev` becomes the file about to be replaced. Best effort: a missing `.prev` only
/// means one less way back.
fn keep_previous(dir: &Path, name: &str) {
    let current = dir.join(name);
    if !current.is_file() {
        return;
    }
    let prev = dir.join(prev_name(name));
    let _ = std::fs::remove_file(&prev);
    if std::fs::hard_link(&current, &prev).is_err() {
        let _ = std::fs::copy(&current, &prev);
    }
}

#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

pub fn save(dir: &Path, file: &str, value: &Value) -> Result<(), String> {
    write_atomic(&dir.join(file), &serde_json::to_vec(value).map_err(|e| e.to_string())?)
}

/// Copy `file` to `backup` (a `<file>.bak-<ms>` name) and keep only the newest `KEEP_COPIES`
/// backups of it. `None` when there is no file.
pub fn backup(dir: &Path, file: &str, backup: &str) -> Result<Option<String>, String> {
    let source = dir.join(file);
    if !source.exists() {
        return Ok(None);
    }
    std::fs::copy(&source, dir.join(backup)).map_err(|e| format!("native: {e}"))?;
    prune(dir, &format!("{file}.bak-"), KEEP_COPIES);
    Ok(Some(backup.to_string()))
}

/// Remove all but the newest `keep` files named `<prefix><ms>` in `dir`. Newest by the number,
/// which is when the copy was made.
pub fn prune(dir: &Path, prefix: &str, keep: usize) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut copies: Vec<(u128, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let ms = name.strip_prefix(prefix)?.parse::<u128>().ok()?;
            Some((ms, e.path()))
        })
        .collect();
    copies.sort_by_key(|copy| std::cmp::Reverse(copy.0));
    let mut removed = Vec::new();
    for (_, path) in copies.into_iter().skip(keep) {
        if std::fs::remove_file(&path).is_ok() {
            removed.push(path);
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "kimochi-chrome-storage-{tag}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const FILES: [&str; 3] = ["chrome-local.json", "chrome-local-hachidori.json", "chrome-local-tenten.json"];

    fn dictionaries() -> Value {
        json!({"local": {"dictionaryState": {"dictionaries": ["Jitendex"]}}, "sync": {}, "host": {"store": "S1"}})
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_missing_file_with_no_previous_copy_loads_empty_for_every_engine() {
        let dir = TempDir::new("missing");
        for file in FILES {
            assert_eq!(load(&dir.0, file, 1).unwrap(), Loaded { value: json!({}), recovered: None });
        }
    }

    #[test]
    fn save_then_load_round_trips_and_leaves_no_temp_files() {
        let dir = TempDir::new("roundtrip");
        for file in FILES {
            save(&dir.0, file, &dictionaries()).unwrap();
            save(&dir.0, file, &json!({"local": {"a": 1}})).unwrap();
            assert_eq!(load(&dir.0, file, 1).unwrap().value, json!({"local": {"a": 1}}));
            // The replaced version is the previous copy.
            assert_eq!(load(&dir.0, &prev_name(file), 1).unwrap().value, dictionaries());
        }
        assert!(names(&dir.0).iter().all(|n| !n.ends_with(".tmp")), "{:?}", names(&dir.0));
    }

    #[test]
    fn a_torn_or_empty_file_is_set_aside_and_the_previous_copy_loads_never_empty() {
        for broken in [&b""[..], &b"{\"local\": {\"dictionaryState\": "[..], &b"[]"[..]] {
            let dir = TempDir::new("torn");
            for file in FILES {
                save(&dir.0, file, &dictionaries()).unwrap();
                save(&dir.0, file, &json!({"local": {"newer": true}})).unwrap();
                // A crash (or another program) leaves the file truncated.
                std::fs::write(dir.0.join(file), broken).unwrap();
                let loaded = load(&dir.0, file, 7).unwrap();
                assert_eq!(loaded.value, dictionaries());
                let record = loaded.recovered.unwrap();
                assert_eq!(record["reason"], "corrupt");
                assert_eq!(record["quarantined"], format!("{file}.corrupt-7"));
                // The broken bytes are kept for inspection, and the good copy is back in place.
                assert_eq!(std::fs::read(dir.0.join(format!("{file}.corrupt-7"))).unwrap(), broken);
                assert_eq!(load(&dir.0, file, 8).unwrap(), Loaded { value: dictionaries(), recovered: None });
            }
        }
    }

    #[test]
    fn a_corrupt_file_without_a_previous_copy_fails_instead_of_loading_empty() {
        let dir = TempDir::new("corrupt");
        for file in FILES {
            std::fs::write(dir.0.join(file), b"{\"local\":").unwrap();
            let error = load(&dir.0, file, 3).unwrap_err();
            assert!(error.contains("not valid JSON"), "{error}");
            assert!(dir.0.join(format!("{file}.corrupt-3")).exists());
        }
    }

    #[test]
    fn a_file_deleted_from_under_the_app_comes_back_from_the_previous_copy() {
        let dir = TempDir::new("deleted");
        let file = "chrome-local-hachidori.json";
        save(&dir.0, file, &dictionaries()).unwrap();
        save(&dir.0, file, &json!({"local": {"x": 1}})).unwrap();
        std::fs::remove_file(dir.0.join(file)).unwrap();
        let loaded = load(&dir.0, file, 1).unwrap();
        assert_eq!(loaded.value, dictionaries());
        assert_eq!(loaded.recovered.unwrap()["reason"], "missing");
    }

    #[test]
    fn concurrent_writers_never_leave_a_partial_file() {
        let dir = TempDir::new("concurrent");
        let file = "chrome-local-hachidori.json";
        let big = |n: usize| json!({"local": {"dictionaryState": {"writer": n, "pad": "x".repeat(200_000)}}});
        std::thread::scope(|s| {
            for n in 0..8 {
                let dir = &dir.0;
                s.spawn(move || {
                    for _ in 0..10 {
                        save(dir, file, &big(n)).unwrap();
                    }
                });
            }
            // Meanwhile every read sees a whole file.
            for _ in 0..50 {
                let value = load(&dir.0, file, 1).unwrap().value;
                assert!(value == json!({}) || value["local"]["dictionaryState"]["pad"].as_str().unwrap().len() == 200_000);
            }
        });
        let value = load(&dir.0, file, 1).unwrap();
        assert!(value.recovered.is_none());
        assert!(names(&dir.0).iter().all(|n| !n.ends_with(".tmp")));
    }

    #[test]
    fn backups_are_bounded_newest_kept() {
        let dir = TempDir::new("backups");
        let file = "chrome-local-hachidori.json";
        assert_eq!(backup(&dir.0, file, &format!("{file}.bak-0")).unwrap(), None);
        save(&dir.0, file, &dictionaries()).unwrap();
        for ms in 1..=(KEEP_COPIES as u128 + 5) {
            assert_eq!(backup(&dir.0, file, &format!("{file}.bak-{ms}")).unwrap(), Some(format!("{file}.bak-{ms}")));
        }
        // Another engine's backups are not counted against this one's.
        std::fs::write(dir.0.join("chrome-local-tenten.json.bak-1"), b"{}").unwrap();
        prune(&dir.0, &format!("{file}.bak-"), KEEP_COPIES);
        let kept: Vec<String> = names(&dir.0).into_iter().filter(|n| n.starts_with(&format!("{file}.bak-"))).collect();
        assert_eq!(kept.len(), KEEP_COPIES);
        assert!(!kept.contains(&format!("{file}.bak-5")));
        assert!(kept.contains(&format!("{file}.bak-6")) && kept.contains(&format!("{file}.bak-15")));
        assert!(dir.0.join("chrome-local-tenten.json.bak-1").exists());
        assert_eq!(load(&dir.0, &format!("{file}.bak-15"), 1).unwrap().value, dictionaries());
    }
}
