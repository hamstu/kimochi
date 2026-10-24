//! Profiles: every Kimochi account keeps its own Log (sessions, lines, notebook, images, presets,
//! stats) and its own preferences, in a folder of its own; signed out, Kimochi uses the "Local"
//! profile, which is the app's local data folder itself (where every earlier version kept the
//! Log), so nothing moves for anyone who never signs in.
//!
//! ```text
//! <AppLocalData>/                       the Local profile (no account)
//!   sessions.json, sessions/, presets.json, stats.json, profile-settings.json
//!   profiles/<key>/                     one account's profile, <key> = <server>-<user id>
//!     sessions.json, sessions/, presets.json, stats.json, profile-settings.json
//!     sync/                             that account's sync state, conflicts and trash
//! ```
//!
//! Settings are one live document (`settings.json`). Its keys come in three kinds:
//! - **machine** keys (`MACHINE_KEYS`) and every secret (`is_private`) are this computer's: shared
//!   by every profile and never synced;
//! - **profile-local** keys (`PROFILE_LOCAL_KEYS`) follow the profile but are not synced (they name
//!   this computer's session ids);
//! - everything else is the profile's preferences, swapped on a switch and synced per leaf.
//!
//! The profile not in use keeps its preferences in its `profile-settings.json`.
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const PROFILES_DIR: &str = "profiles";
/// A profile's preferences while another profile is in use.
pub const SETTINGS_FILE: &str = "profile-settings.json";

/// Settings that belong to this computer: window places, the capture source and portal grant,
/// the scan history, the server choice, the OCR engine and dictionary engine (they depend on
/// what this computer has installed), recording system audio (`sentenceAudio`: this computer's
/// permission and choice), and account bookkeeping.
pub const MACHINE_KEYS: &[&str] = &[
    "windowPositions",
    "nativeWindowBounds",
    "nativeWindowPinned",
    "capture",
    "lastSelectedSource",
    "notebookEditRequest",
    "lastSeenVersion",
    "hasCompletedOnboarding",
    "scannedTextHistory",
    "serverSettings",
    "endpoint",
    "ocrMode",
    "cropRegions",
    "cropScanEnabled",
    "settingsActiveTab",
    "texthookerIngestedHistory",
    "accountLinkServer",
    "yomitanSettings",
    "accountBackup",
    "sentenceAudio",
];

/// Settings that follow the profile but never sync: they name this computer's sessions.
pub const PROFILE_LOCAL_KEYS: &[&str] = &["texthookerSourceSessions"];

/// A secret by its name: the DeepL key, an AnkiConnect key, any API key, token, secret or
/// password. Matched on any level of the document, so a key added later is covered too.
pub fn is_private(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k == "key"
        || k.ends_with("apikey")
        || k.ends_with("api_key")
        || k.ends_with("accesskey")
        || k.ends_with("authkey")
        || k.ends_with("connectkey")
        || k.contains("token")
        || k.contains("secret")
        || k.contains("password")
}

/// A copy of `value` without any private key, at any depth.
pub fn strip_private(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(k, _)| !is_private(k))
                .map(|(k, v)| (k.clone(), strip_private(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(strip_private).collect()),
        other => other.clone(),
    }
}

/// Put `local`'s private keys back into `incoming`, at the same places.
pub fn keep_private(local: &Value, incoming: &mut Value) {
    let (Some(local), Some(incoming)) = (local.as_object(), incoming.as_object_mut()) else {
        return;
    };
    for (key, value) in local {
        if is_private(key) {
            incoming.insert(key.clone(), value.clone());
        } else if let Some(inner) = incoming.get_mut(key) {
            keep_private(value, inner);
        }
    }
}

pub fn is_machine_key(key: &str) -> bool {
    MACHINE_KEYS.contains(&key) || is_private(key)
}

/// The profile's part of a settings document: no machine keys, no secrets.
pub fn profile_part(settings: &Value) -> Value {
    let mut out = strip_private(settings);
    if let Some(map) = out.as_object_mut() {
        map.retain(|key, _| !is_machine_key(key));
    }
    out
}

/// What Sync carries of a settings document: the profile's part without its profile-local keys.
pub fn synced_part(settings: &Value) -> Value {
    let mut out = profile_part(settings);
    if let Some(map) = out.as_object_mut() {
        map.retain(|key, _| !PROFILE_LOCAL_KEYS.contains(&key.as_str()));
    }
    out
}

/// One path segment of a `prefs` record id: `~` → `~0`, `/` → `~1` (JSON Pointer's escaping).
pub fn escape_segment(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

/// A `prefs` record id back to its path segments.
pub fn split_path(id: &str) -> Vec<String> {
    id.split('/').map(|s| s.replace("~1", "/").replace("~0", "~")).collect()
}

/// Every leaf of `value` by its escaped path. Objects are walked; arrays and scalars are leaves;
/// empty objects are skipped (a leaf that later gains children must not read as deleted).
pub fn flatten(value: &Value) -> BTreeMap<String, Value> {
    fn walk(prefix: &str, value: &Value, out: &mut BTreeMap<String, Value>) {
        match value {
            Value::Object(map) => {
                for (key, inner) in map {
                    if key.is_empty() || is_private(key) {
                        continue;
                    }
                    let path = if prefix.is_empty() {
                        escape_segment(key)
                    } else {
                        format!("{prefix}/{}", escape_segment(key))
                    };
                    walk(&path, inner, out);
                }
            }
            other if !prefix.is_empty() => {
                out.insert(prefix.to_string(), other.clone());
            }
            _ => {}
        }
    }
    let mut out = BTreeMap::new();
    walk("", value, &mut out);
    out
}

/// Where a profile lives: the Local profile is the local data folder itself.
pub fn profile_dir(local_dir: &Path, key: Option<&str>) -> PathBuf {
    match key {
        Some(key) => local_dir.join(PROFILES_DIR).join(key),
        None => local_dir.to_path_buf(),
    }
}

/// The profile folder relative to the local data folder, as the webviews address it.
pub fn profile_root(key: Option<&str>) -> String {
    key.map(|k| format!("{PROFILES_DIR}/{k}")).unwrap_or_default()
}

/// A profile key for `server` and `user_id`: only `[A-Za-z0-9_-]`, so it is one safe path segment.
pub fn profile_key(server: &str, user_id: &str) -> String {
    let clean: String = user_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(80)
        .collect();
    format!("{server}-{}", if clean.is_empty() { "user" } else { &clean })
}

/// The Log's files in a profile folder (not its sync state).
pub const DATA_FILES: &[&str] = &["sessions.json", "presets.json", "stats.json", SETTINGS_FILE];

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<u64> {
    let mut copied = 0;
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copied += copy_dir(&entry.path(), &target)?;
        } else if kind.is_file() && !target.exists() {
            std::fs::copy(entry.path(), &target)?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// Copy (never move) the Log of one profile into another that has none yet. Returns the number of
/// files copied.
pub fn copy_profile_data(from: &Path, to: &Path) -> Result<u64, String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    let mut copied = 0;
    for name in DATA_FILES {
        let source = from.join(name);
        if source.is_file() && !to.join(name).exists() {
            std::fs::copy(&source, to.join(name)).map_err(|e| e.to_string())?;
            copied += 1;
        }
    }
    if from.join("sessions").is_dir() {
        copied += copy_dir(&from.join("sessions"), &to.join("sessions")).map_err(|e| e.to_string())?;
    }
    Ok(copied)
}

pub fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Write through a temp file and rename, so a crash leaves the previous file.
pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    write_bytes(path, &serde_json::to_vec(value).map_err(|e| e.to_string())?)
}

pub fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("sync-{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The settings a profile switch writes, top-level key by key: `current`'s machine keys and
/// secrets stay; every other key takes `target`'s value (`Null`: removed). Only keys that change.
pub fn switch_updates(current: &Value, target: &Value) -> Vec<(String, Value)> {
    let empty = Map::new();
    let current_map = current.as_object().unwrap_or(&empty);
    let target_map = target.as_object().unwrap_or(&empty);
    let mut keys: Vec<&String> = current_map.keys().chain(target_map.keys()).collect();
    keys.sort();
    keys.dedup();
    let mut updates = Vec::new();
    for key in keys {
        if is_machine_key(key) {
            continue;
        }
        let mut next = target_map.get(key).cloned().unwrap_or(Value::Null);
        if let Some(local) = current_map.get(key) {
            keep_private(local, &mut next);
        }
        if current_map.get(key) != Some(&next) && !(next.is_null() && !current_map.contains_key(key)) {
            updates.push((key.clone(), next));
        }
    }
    updates
}

/// A profile's preferences laid over the defaults: what a profile starts from.
pub fn with_defaults(defaults: &Value, profile: &Value) -> Value {
    let mut out = profile_part(defaults);
    if let (Some(out), Some(profile)) = (out.as_object_mut(), profile.as_object()) {
        for (key, value) in profile {
            if !is_machine_key(key) {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn secrets_and_machine_keys_never_leave_the_computer() {
        let settings = json!({
            "appearance": "dark",
            "hotkeys": { "scan": { "accelerator": "Cmd+J" } },
            "superTexthooker": { "deeplApiKey": "secret-1", "ankiConnectKey": "secret-2", "fontSizePx": 16 },
            "capture": { "portalRestoreToken": "t" },
            "voice": { "apiKey": "x", "voiceId": "keep" },
            "windowPositions": { "log": [1, 2] },
            "scannedTextHistory": ["a"],
            "texthookerSourceSessions": { "app": "s1" },
        });
        let out = synced_part(&settings);
        let text = out.to_string();
        for secret in ["secret-1", "secret-2", "portalRestoreToken", "apiKey", "windowPositions", "texthookerSourceSessions"] {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        assert_eq!(out["superTexthooker"]["fontSizePx"], 16);
        assert!(profile_part(&settings).get("texthookerSourceSessions").is_some());
        let leaves = flatten(&out);
        assert_eq!(leaves.get("hotkeys/scan/accelerator"), Some(&json!("Cmd+J")));
        assert_eq!(leaves.get("voice/voiceId"), Some(&json!("keep")));
    }

    #[test]
    fn paths_escape_and_round_trip() {
        let value = json!({ "a/b": { "c~d": 1 }, "empty": {}, "list": [1, 2] });
        let leaves = flatten(&value);
        assert_eq!(leaves.keys().collect::<Vec<_>>(), ["a~1b/c~0d", "list"]);
        assert_eq!(split_path("a~1b/c~0d"), ["a/b", "c~d"]);
    }

    #[test]
    fn a_switch_keeps_this_computers_keys_and_secrets() {
        let current = json!({
            "appearance": "light",
            "windowPositions": { "log": [5, 5] },
            "superTexthooker": { "deeplApiKey": "mine", "fontSizePx": 14 },
            "onlyHere": 1,
        });
        let target = json!({ "appearance": "dark", "superTexthooker": { "fontSizePx": 20 } });
        let updates: BTreeMap<String, Value> = switch_updates(&current, &target).into_iter().collect();
        assert_eq!(updates["appearance"], "dark");
        assert_eq!(updates["superTexthooker"], json!({ "fontSizePx": 20, "deeplApiKey": "mine" }));
        assert_eq!(updates["onlyHere"], Value::Null);
        assert!(!updates.contains_key("windowPositions"));
    }

    #[test]
    fn profile_keys_are_safe_segments() {
        assert_eq!(profile_key("cloud", "usr_AbC-1"), "cloud-usr_AbC-1");
        assert_eq!(profile_key("local", "a/../b"), "local-a____b");
    }

    #[test]
    fn copying_a_profile_never_overwrites() {
        let root = std::env::temp_dir().join(format!("kimochi-profile-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (from, to) = (root.join("from"), root.join("to"));
        std::fs::create_dir_all(from.join("sessions/s1/images")).unwrap();
        std::fs::write(from.join("sessions.json"), "{}").unwrap();
        std::fs::write(from.join("sessions/s1/lines.json"), "lines").unwrap();
        std::fs::write(from.join("sessions/s1/images/a.png"), "png").unwrap();
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(to.join("presets.json"), "mine").unwrap();
        std::fs::write(from.join("presets.json"), "theirs").unwrap();
        assert_eq!(copy_profile_data(&from, &to).unwrap(), 3);
        assert_eq!(std::fs::read_to_string(to.join("presets.json")).unwrap(), "mine");
        assert_eq!(std::fs::read_to_string(to.join("sessions/s1/images/a.png")).unwrap(), "png");
        assert!(from.join("sessions/s1/lines.json").exists(), "a copy, not a move");
        let _ = std::fs::remove_dir_all(&root);
    }
}
