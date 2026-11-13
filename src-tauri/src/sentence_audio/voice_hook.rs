//! Capture discovery for the explicitly selected text-hook game: on Windows, and for Windows
//! games running through Wine or Proton on Linux.
use kimochi_speech::hooked::Hooked;
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
/// Where Kimochi's own voice hook data lives (what is remembered per game; on Windows also the
/// captures and the injected DLL copies): `%LOCALAPPDATA%/kimochi-voicehook`, elsewhere
/// `$XDG_DATA_HOME/kimochi-voicehook`.
pub fn base_dir() -> PathBuf {
    if cfg!(windows) {
        return std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("kimochi-voicehook");
    }
    std::env::var_os("XDG_DATA_HOME")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(std::env::temp_dir)
        .join("kimochi-voicehook")
}

/// The prefix's user folders (`drive_c/users/<user>`), `Public` aside, by name.
fn prefix_users(prefix: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(prefix.join("drive_c").join("users"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| !n.eq_ignore_ascii_case("public"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn prefix_base(prefix: &Path, user: &str) -> PathBuf {
    prefix.join("drive_c").join("users").join(user).join("AppData").join("Local").join("kimochi-voicehook")
}

/// Under Wine the DLL runs inside the game's prefix and writes its captures to the prefix's
/// `%LOCALAPPDATA%\kimochi-voicehook`. Every user's: which one the game runs as (Proton's
/// `steamuser`, else the Unix user's name) is the prefix's business.
pub fn prefix_bases(prefix: &Path) -> Vec<PathBuf> {
    prefix_users(prefix).iter().map(|u| prefix_base(prefix, u)).collect()
}

/// The prefix user's `kimochi-voicehook` folder to stage the DLL in, as a Linux path and as the
/// game sees it (`C:\users\<user>\AppData\Local\kimochi-voicehook`). The game loads it from the
/// prefix's own drive, which it sees even inside Steam's runtime container.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn prefix_home(prefix: &Path, unix_user: Option<&str>) -> Option<(PathBuf, String)> {
    let users = prefix_users(prefix);
    let user = ["steamuser"]
        .into_iter()
        .chain(unix_user)
        .find(|u| users.iter().any(|n| n == u))
        .map(str::to_owned)
        .or_else(|| users.into_iter().next())?;
    Some((prefix_base(prefix, &user), format!(r"C:\users\{user}\AppData\Local\kimochi-voicehook")))
}

/// `path` under `base` as a Windows path under `windows_base`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn windows_under(path: &Path, base: &Path, windows_base: &str) -> Option<String> {
    let rest = path.strip_prefix(base).ok()?;
    let mut out = windows_base.trim_end_matches('\\').to_string();
    for part in rest.components() {
        out.push('\\');
        out.push_str(&part.as_os_str().to_string_lossy());
    }
    Some(out)
}

/// A copy of `dll` under `<base>/bin/<content hash>/` to inject instead of the bundled file. A
/// game keeps an injected DLL loaded (and its file locked) until it exits, so injecting the
/// bundled copy would make updating or reinstalling Kimochi fail while a hooked game runs.
/// Copies are keyed by content, so every build gets its own and an existing one is reused.
pub fn staged_dll(dll: &std::path::Path, base: &std::path::Path) -> Result<PathBuf, String> {
    let bytes = std::fs::read(dll).map_err(|e| format!("{}: {e}", dll.display()))?;
    // FNV-1a: stable across builds and Rust versions, unlike `DefaultHasher`.
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3));
    let name = dll.file_name().ok_or("the DLL has no file name")?;
    let dir = base.join("bin").join(format!("{hash:016x}"));
    let target = dir.join(name);
    if std::fs::metadata(&target).is_ok_and(|m| m.len() == bytes.len() as u64) {
        return Ok(target);
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Written under a temporary name first, so a half-written copy is never injected.
    // Unique per call: sentence audio and the Unity text reader can stage it at the same time.
    static CALLS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let call = CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let partial = dir.join(format!("{}.partial-{}-{call}", name.to_string_lossy(), std::process::id()));
    std::fs::write(&partial, &bytes).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&partial, &target) {
        let _ = std::fs::remove_file(&partial);
        // Another Kimochi staged the same copy meanwhile (and a game may already hold it).
        if !std::fs::metadata(&target).is_ok_and(|m| m.len() == bytes.len() as u64) {
            return Err(e.to_string());
        }
    }
    Ok(target)
}

#[derive(Default)]
pub struct Capture {
    pub pids: Vec<u32>,
    /// The folders the hooked game's captures appear in: `base_dir()`, or under Wine the prefix's.
    pub bases: Vec<PathBuf>,
    pub generation: u64,
    pub error: Option<String>,
    pub attempted: Vec<u32>,
}
pub struct Discovery {
    pub generation: u64,
    checked: Option<Instant>,
    /// The game whose remembered voice stream was looked up.
    looked_up: Option<String>,
    /// When ended games' captures were last cleared away.
    pruned: Option<Instant>,
}
impl Default for Discovery {
    fn default() -> Self {
        Self { generation: u64::MAX, checked: None, looked_up: None, pruned: None }
    }
}

/// A capture untouched this long, of no game being hooked, is an ended session's.
const STALE: Duration = Duration::from_secs(60 * 60);
const PRUNE_EVERY: Duration = Duration::from_secs(10 * 60);

/// Removes captures (`<pid>-<time>` folders) of ended game sessions: untouched for `stale` and
/// not of a process in `live`. Each is bounded while its game runs (256 clips, 128 MiB), but
/// nothing else ever removed them, so every session played left one behind. One a game still
/// writes cannot be removed on Windows and is left. Returns how many went.
pub fn prune_stale(base: &std::path::Path, live: &[u32], stale: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(base) else {
        return 0;
    };
    let mut removed = 0;
    for e in entries.flatten() {
        let name = e.file_name();
        let Some((pid, time)) =
            name.to_string_lossy().split_once('-').map(|(p, t)| (p.parse::<u32>(), t.parse::<u64>()))
        else {
            continue;
        };
        let (Ok(pid), Ok(_)) = (pid, time) else {
            continue;
        };
        let path = e.path();
        if live.contains(&pid) || !path.is_dir() {
            continue;
        }
        let touched = std::fs::metadata(path.join("events.jsonl"))
            .or_else(|_| std::fs::metadata(&path))
            .and_then(|m| m.modified());
        if touched.is_ok_and(|t| t.elapsed().is_ok_and(|age| age > stale)) && std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Each game's voice stream and typing delay as last established (`Hooked::voice_group`,
/// `Hooked::typing`), by executable path: `<base>/games.json`, `{exe: {group, typingMs}}`.
fn games_file(base: &std::path::Path) -> PathBuf {
    base.join("games.json")
}
#[derive(Debug, Clone, PartialEq)]
pub struct Remembered {
    pub group: String,
    pub typing_ms: Option<f64>,
}
pub fn remembered(base: &std::path::Path, exe: &str) -> Option<Remembered> {
    let games: serde_json::Value = serde_json::from_slice(&std::fs::read(games_file(base)).ok()?).ok()?;
    let game = games.get(exe.to_lowercase())?;
    // A bare string: the group alone, as first written.
    match game.as_str() {
        Some(group) => Some(Remembered { group: group.into(), typing_ms: None }),
        None => Some(Remembered { group: game["group"].as_str()?.into(), typing_ms: game["typingMs"].as_f64() }),
    }
}
pub fn remember(base: &std::path::Path, exe: &str, game: &Remembered) -> Result<(), String> {
    let path = games_file(base);
    let mut games: serde_json::Map<String, serde_json::Value> =
        std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    games.insert(exe.to_lowercase(), serde_json::json!({"group": game.group, "typingMs": game.typing_ms}));
    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let partial = path.with_extension(format!("json.partial-{}", std::process::id()));
    std::fs::write(&partial, serde_json::to_vec_pretty(&games).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&partial, &path).map_err(|e| e.to_string())
}
impl Discovery {
    pub fn poll(&mut self, capture: &Capture, hooked: &mut Hooked, enabled: bool) {
        if self.generation != capture.generation || !enabled {
            let speech = hooked.speech.take();
            *hooked = Hooked::default();
            hooked.speech = speech;
            self.generation = capture.generation;
            self.checked = None;
            self.looked_up = None;
        }
        if enabled && !capture.bases.is_empty() && self.pruned.is_none_or(|t| t.elapsed() > PRUNE_EVERY) {
            self.pruned = Some(Instant::now());
            for base in &capture.bases {
                prune_stale(base, &capture.pids, STALE);
            }
        }
        if !enabled || capture.pids.is_empty() || self.checked.is_some_and(|t| t.elapsed() < Duration::from_secs(1)) {
            return;
        }
        self.checked = Some(Instant::now());
        let mut newest = std::collections::BTreeMap::<u32, (u64, PathBuf)>::new();
        for e in capture.bases.iter().filter_map(|b| std::fs::read_dir(b).ok()).flat_map(|d| d.flatten()) {
            let name = e.file_name();
            let name = name.to_string_lossy();
            let Some((pid, time)) = name.split_once('-') else {
                continue;
            };
            let (Ok(pid), Ok(time)) = (pid.parse::<u32>(), time.parse::<u64>()) else {
                continue;
            };
            if !capture.pids.contains(&pid) || !e.path().is_dir() {
                continue;
            }
            if newest.get(&pid).is_none_or(|(old, _)| time > *old) {
                newest.insert(pid, (time, e.path()));
            }
        }
        for (_, (_, path)) in newest {
            hooked.add_capture(path);
        }
    }

    /// Trust the game's voice stream from an earlier session at once, and remember it once this
    /// session has established it.
    pub fn remember(&mut self, hooked: &mut Hooked, base: &std::path::Path) {
        let Some(exe) = hooked.exe().map(str::to_owned) else {
            return;
        };
        if self.looked_up.as_deref() != Some(exe.as_str()) {
            let game = remembered(base, &exe);
            hooked.remembered = game.as_ref().map(|g| g.group.clone());
            hooked.remembered_typing = game.and_then(|g| g.typing_ms);
            self.looked_up = Some(exe.clone());
        }
        // Saved once established, and again when the typing delay is first known or changes.
        let (Some(group), typing) = (hooked.voice_group().map(str::to_owned), hooked.typing()) else {
            return;
        };
        let changed = hooked.remembered.as_deref() != Some(group.as_str())
            || typing.is_some_and(|t| hooked.remembered_typing != Some(t));
        if changed {
            let game = Remembered { group, typing_ms: typing.or(hooked.remembered_typing) };
            if let Err(e) = remember(base, &exe, &game) {
                eprintln!("[sentence-audio] could not remember the game's voice stream: {e}");
            }
            hooked.remembered = Some(game.group);
            hooked.remembered_typing = game.typing_ms;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::staged_dll;

    #[test]
    fn the_injected_dll_is_a_content_keyed_copy_that_leaves_the_bundled_file_free() {
        let root = std::env::temp_dir().join(format!("kimochi-staged-dll-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bundled = root.join("bundle").join("kimochi-voicehook-x64.dll");
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"build one").unwrap();
        let base = root.join("data");
        let first = staged_dll(&bundled, &base).unwrap();
        assert!(first.starts_with(base.join("bin")));
        assert_eq!(first.file_name().unwrap(), "kimochi-voicehook-x64.dll");
        assert_eq!(std::fs::read(&first).unwrap(), b"build one");
        // The same build reuses its copy; a new build gets its own, the old one is untouched.
        assert_eq!(staged_dll(&bundled, &base).unwrap(), first);
        std::fs::write(&bundled, b"build two!").unwrap();
        let second = staged_dll(&bundled, &base).unwrap();
        assert_ne!(second, first);
        assert_eq!(std::fs::read(&second).unwrap(), b"build two!");
        assert_eq!(std::fs::read(&first).unwrap(), b"build one");
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod prune_tests {
    use super::prune_stale;
    use std::time::Duration;

    #[test]
    fn ended_sessions_captures_are_cleared_away_and_live_ones_kept() {
        let base = std::env::temp_dir().join(format!("kimochi-voice-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        for name in ["100-1794197338", "200-1794198254", "bin", "300-1794199999"] {
            std::fs::create_dir_all(base.join(name).join("clips")).unwrap();
            std::fs::write(
                base.join(name).join("events.jsonl"),
                b"{}
",
            )
            .unwrap();
        }
        std::fs::write(base.join("games.json"), b"{}").unwrap();
        // Nothing is stale yet.
        assert_eq!(prune_stale(&base, &[], Duration::from_secs(3600)), 0);
        // Everything is: the hooked game's (200) and app data that is not a capture stay.
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(prune_stale(&base, &[200], Duration::from_millis(1)), 2);
        let mut left: Vec<String> =
            std::fs::read_dir(&base).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, ["200-1794198254", "bin", "games.json"]);
        let _ = std::fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod remembered_tests {
    use super::{remember, remembered, Remembered};

    #[test]
    fn a_games_voice_stream_is_remembered_by_its_executable() {
        let base = std::env::temp_dir().join(format!("kimochi-voice-games-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(remembered(&base, r"C:GamesAAdvHD.exe"), None);
        let advhd = Remembered { group: "xaudio2.9 | float32 1ch 44100Hz | ".into(), typing_ms: Some(0.0) };
        let krkr = Remembered { group: "dsound | pcm16 1ch 22050Hz | ".into(), typing_ms: Some(120.0) };
        remember(&base, r"C:GamesAAdvHD.exe", &advhd).unwrap();
        remember(&base, r"C:GamesBSome Game_64.exe", &krkr).unwrap();
        // Paths differ in case between a capture's start event and the process list.
        assert_eq!(remembered(&base, r"c:gamesaadvhd.exe"), Some(advhd));
        assert_eq!(remembered(&base, r"C:GamesBSome Game_64.exe"), Some(krkr));
        // An entry from before typing delays were kept: the group alone.
        std::fs::write(base.join("games.json"), r#"{"c:gamescsiglusengine.exe": "dsound | pcm16 1ch 44100Hz | "}"#)
            .unwrap();
        assert_eq!(
            remembered(&base, r"C:GamesCSiglusEngine.exe"),
            Some(Remembered { group: "dsound | pcm16 1ch 44100Hz | ".into(), typing_ms: None })
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod prefix_tests {
    use super::{prefix_bases, prefix_home, windows_under};
    use std::path::Path;

    #[test]
    fn under_wine_the_dll_is_staged_and_captures_found_in_the_prefix_users_local_app_data() {
        let prefix = std::env::temp_dir().join(format!("kimochi-voice-prefix-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&prefix);
        let users = prefix.join("drive_c").join("users");
        for user in ["Public", "steamuser", "deck"] {
            std::fs::create_dir_all(users.join(user)).unwrap();
        }
        let local = |u: &str| users.join(u).join("AppData").join("Local").join("kimochi-voicehook");
        // Proton's user first, whatever the Unix user is called.
        let (base, windows) = prefix_home(&prefix, Some("deck")).unwrap();
        assert_eq!(base, local("steamuser"));
        assert_eq!(windows, r"C:\users\steamuser\AppData\Local\kimochi-voicehook");
        assert_eq!(prefix_bases(&prefix), vec![local("deck"), local("steamuser")]);
        std::fs::remove_dir_all(users.join("steamuser")).unwrap();
        assert_eq!(prefix_home(&prefix, Some("deck")).unwrap().0, local("deck"));
        assert_eq!(prefix_home(&prefix, Some("nobody")).unwrap().0, local("deck"));
        std::fs::remove_dir_all(users.join("deck")).unwrap();
        assert_eq!(prefix_home(&prefix, Some("deck")), None);
        let _ = std::fs::remove_dir_all(&prefix);

        let base = Path::new("/pfx/u/kimochi-voicehook");
        assert_eq!(
            windows_under(
                &base.join("bin").join("00ff").join("kimochi-voicehook-x64.dll"),
                base,
                r"C:\users\u\kimochi-voicehook"
            )
            .as_deref(),
            Some(r"C:\users\u\kimochi-voicehook\bin\00ff\kimochi-voicehook-x64.dll")
        );
        assert_eq!(windows_under(Path::new("/elsewhere/x.dll"), base, r"C:\x"), None);
    }
}
