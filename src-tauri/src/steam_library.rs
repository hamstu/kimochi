//! Kimochi in the Steam library (Steam Deck / SteamOS, and Linux with Steam generally).
//!
//! Gaming Mode runs Kimochi as a sidecar launched from its own Steam library entry
//! (`scripts/steam-deck/launch-from-steam.sh`). This module sets that entry up from inside the
//! app, in Desktop Mode:
//!
//! 1. **The launcher bundle.** The gaming-mode scripts are embedded here (`include_str!`, the
//!    scripts in `scripts/steam-deck/` stay the single source) and the embedded
//!    `install-gaming-mode.sh --link <executable>` lays out
//!    `$XDG_DATA_HOME/kimochi/gaming-mode/{launch.sh,current,releases/}` exactly as the tarball
//!    install does, except the new release holds a symlink to the AppImage we run from
//!    (`$APPIMAGE`; the self-updater replaces that file in place) instead of a copy. `launch.sh`
//!    keeps its path and content, so an existing Steam shortcut to it stays valid, and earlier
//!    releases stay for rollback. The installer also writes `kimochi-gaming-mode.desktop`
//!    (`Name=Kimochi`: Steam names a shortcut added from a desktop file after its Name) and the
//!    portal's `dev.kimochi.app.desktop` when there is none.
//! 2. **Adding it to Steam.** Never by writing `shortcuts.vdf`: Steam owns that file and rewrites
//!    it. SteamOS's `steamos-add-to-steam <file>` when it exists; otherwise what that script does:
//!    touch `/tmp/addnonsteamgamefile`, then `steam steam://addnonsteamgame/<percent-encoded
//!    path>` (Python's `quote(path, safe='')`), which the running Steam client picks up. Both get
//!    the desktop file, so the entry is named Kimochi and shows the hicolor `kimochi` icon.
//!    Steam must be running; otherwise the caller hears `steamNotRunning`, with the launcher in
//!    place for the manual Add a Non-Steam Game route.
//! 3. **Artwork.** `shortcuts.vdf` is then read (binary VDF, read only, `vdf`) for the new entry's
//!    app ID, and the library art (`resources/steam-library/`, from `branding/steam-library.mjs`)
//!    is written into `userdata/<user>/config/grid/` as `<appid>p.png`, `<appid>.png`,
//!    `<appid>_hero.png` and `<appid>_logo.png`. Only files that are missing: art a user chose
//!    is never replaced, and nothing else in Steam's folders is touched. Steam shows new grid
//!    art after it restarts, which switching to Gaming Mode does. A launch that finds Kimochi's
//!    entry without its art (Steam wrote the file late, or the entry was added by hand) fills
//!    it in (`start`).
//!
//! The Steam user is the one `config/loginusers.vdf` marks `MostRecent`, or the only one with a
//! `userdata` folder; other users' files are never read or written.
//!
//! Other platforms build this module for its parsers and tests; its commands answer
//! `supported: false` there.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------- binary VDF

/// Valve's binary KeyValues, as `shortcuts.vdf` stores them. Read only.
pub mod vdf {
    /// One value. Maps keep their order and duplicate keys, as the file has them.
    #[derive(Debug, Clone, PartialEq)]
    pub enum Node {
        Map(Vec<(String, Node)>),
        Str(String),
        Int(i32),
        Float(f32),
        U64(u64),
        I64(i64),
    }

    impl Node {
        /// A child by key, ignoring case (older Steam wrote `appname`/`exe`, newer `AppName`/`Exe`).
        pub fn get(&self, key: &str) -> Option<&Node> {
            match self {
                Node::Map(entries) => entries
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(key))
                    .map(|(_, v)| v),
                _ => None,
            }
        }
        pub fn as_str(&self) -> Option<&str> {
            match self {
                Node::Str(s) => Some(s),
                _ => None,
            }
        }
        /// An int32 field read as the unsigned value Steam uses in file names (app IDs).
        pub fn as_u32(&self) -> Option<u32> {
            match self {
                Node::Int(v) => Some(*v as u32),
                Node::U64(v) => u32::try_from(*v).ok(),
                Node::I64(v) => u32::try_from(*v).ok(),
                _ => None,
            }
        }
        pub fn entries(&self) -> &[(String, Node)] {
            match self {
                Node::Map(entries) => entries,
                _ => &[],
            }
        }
    }

    const MAP: u8 = 0x00;
    const STRING: u8 = 0x01;
    const INT32: u8 = 0x02;
    const FLOAT32: u8 = 0x03;
    const POINTER: u8 = 0x04;
    const COLOR: u8 = 0x06;
    const UINT64: u8 = 0x07;
    const END: u8 = 0x08;
    const INT64: u8 = 0x0a;
    const END_ALT: u8 = 0x0b;
    /// Far deeper than `shortcuts.vdf` (root → shortcuts → entry → tags) ever goes.
    const MAX_DEPTH: usize = 32;

    struct Reader<'a> {
        bytes: &'a [u8],
        at: usize,
    }

    impl Reader<'_> {
        fn byte(&mut self) -> Option<u8> {
            let b = *self.bytes.get(self.at)?;
            self.at += 1;
            Some(b)
        }
        fn take<const N: usize>(&mut self) -> Result<[u8; N], String> {
            let slice = self
                .bytes
                .get(self.at..self.at + N)
                .ok_or_else(|| format!("truncated value at byte {}", self.at))?;
            self.at += N;
            Ok(slice.try_into().expect("slice of N bytes"))
        }
        fn cstring(&mut self) -> Result<String, String> {
            let rest = &self.bytes[self.at.min(self.bytes.len())..];
            let end = rest
                .iter()
                .position(|&b| b == 0)
                .ok_or_else(|| format!("unterminated string at byte {}", self.at))?;
            let text = String::from_utf8_lossy(&rest[..end]).into_owned();
            self.at += end + 1;
            Ok(text)
        }
        /// A map's entries up to its end marker (or, at the top level, the end of the file).
        fn map(&mut self, depth: usize) -> Result<Vec<(String, Node)>, String> {
            if depth > MAX_DEPTH {
                return Err("nesting too deep".into());
            }
            let mut entries = Vec::new();
            loop {
                let Some(kind) = self.byte() else {
                    return if depth == 0 {
                        Ok(entries)
                    } else {
                        Err("missing end of map".into())
                    };
                };
                if kind == END || kind == END_ALT {
                    return Ok(entries);
                }
                let key = self.cstring()?;
                let value = match kind {
                    MAP => Node::Map(self.map(depth + 1)?),
                    STRING => Node::Str(self.cstring()?),
                    INT32 | POINTER | COLOR => Node::Int(i32::from_le_bytes(self.take()?)),
                    FLOAT32 => Node::Float(f32::from_le_bytes(self.take()?)),
                    UINT64 => Node::U64(u64::from_le_bytes(self.take()?)),
                    INT64 => Node::I64(i64::from_le_bytes(self.take()?)),
                    other => {
                        return Err(format!("unknown value type 0x{other:02x} at byte {}", self.at - 1))
                    }
                };
                entries.push((key, value));
            }
        }
    }

    /// The whole file as one map (`shortcuts.vdf`: `{"shortcuts": {"0": {...}, "1": {...}}}`).
    pub fn parse(bytes: &[u8]) -> Result<Node, String> {
        let mut reader = Reader { bytes, at: 0 };
        let entries = reader.map(0)?;
        Ok(Node::Map(entries))
    }
}

/// One non-Steam shortcut, as much of it as matters here.
#[derive(Debug, Clone, PartialEq)]
pub struct Shortcut {
    pub app_id: u32,
    pub name: String,
    pub exe: String,
    pub launch_options: String,
    pub shortcut_path: String,
}

/// Steam's legacy shortcut ID (before entries stored `appid`): CRC-32 of exe + name, top bit set.
fn legacy_app_id(exe: &str, name: &str) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in exe.bytes().chain(name.bytes()) {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc | 0x8000_0000
}

/// Every shortcut in a `shortcuts.vdf`.
pub fn shortcuts(bytes: &[u8]) -> Result<Vec<Shortcut>, String> {
    let root = vdf::parse(bytes)?;
    let list = root.get("shortcuts").ok_or("no shortcuts map")?;
    Ok(list
        .entries()
        .iter()
        .filter_map(|(_, entry)| {
            let text = |key: &str| entry.get(key).and_then(vdf::Node::as_str).unwrap_or("").to_owned();
            let (name, exe) = (text("AppName"), text("Exe"));
            if name.is_empty() && exe.is_empty() {
                return None;
            }
            let app_id = entry
                .get("appid")
                .and_then(vdf::Node::as_u32)
                .unwrap_or_else(|| legacy_app_id(&exe, &name));
            Some(Shortcut {
                app_id,
                name,
                exe,
                launch_options: text("LaunchOptions"),
                shortcut_path: text("ShortcutPath"),
            })
        })
        .collect())
}

/// The path fragments that identify Kimochi's entry: the gaming-mode launcher (an entry added
/// from the desktop file runs `/bin/sh` with the launcher as its launch options), the desktop file
/// itself, and the executable the user may have added directly.
pub fn markers(layout: &Layout, executable: Option<&Path>) -> Vec<String> {
    let mut markers = vec![
        layout.launcher().to_string_lossy().into_owned(),
        layout.desktop().to_string_lossy().into_owned(),
        // Any data directory: the same layout under another XDG_DATA_HOME or user.
        "kimochi/gaming-mode/launch.sh".to_owned(),
        "applications/kimochi-gaming-mode.desktop".to_owned(),
    ];
    if let Some(executable) = executable {
        markers.push(executable.to_string_lossy().into_owned());
    }
    markers.retain(|m| !m.is_empty());
    markers
}

/// Kimochi's entry among the shortcuts, if there is one.
pub fn find_kimochi<'a>(shortcuts: &'a [Shortcut], markers: &[String]) -> Option<&'a Shortcut> {
    shortcuts.iter().find(|s| {
        [&s.exe, &s.launch_options, &s.shortcut_path]
            .iter()
            .any(|field| markers.iter().any(|m| field.contains(m.as_str())))
    })
}

// ---------------------------------------------------------------- text VDF (loginusers.vdf)

/// A small text KeyValues reader for `loginusers.vdf`: quoted keys and values, `{}` blocks,
/// `//` comments. Enough for Steam's own config files; never executes `#include`s.
fn text_vdf(text: &str) -> vdf::Node {
    #[derive(PartialEq)]
    enum Token {
        Text(String),
        Open,
        Close,
    }
    let mut tokens = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '{' => tokens.push(Token::Open),
            '}' => tokens.push(Token::Close),
            '"' => {
                let mut value = String::new();
                while let Some(ch) = chars.next() {
                    match ch {
                        '"' => break,
                        '\\' => match chars.next() {
                            Some('n') => value.push('\n'),
                            Some('t') => value.push('\t'),
                            Some(other) => value.push(other),
                            None => {}
                        },
                        other => value.push(other),
                    }
                }
                tokens.push(Token::Text(value));
            }
            '/' if chars.peek() == Some(&'/') => {
                for ch in chars.by_ref() {
                    if ch == '\n' {
                        break;
                    }
                }
            }
            c if c.is_whitespace() => {}
            other => {
                // An unquoted token.
                let mut value = String::from(other);
                while let Some(&next) = chars.peek() {
                    if next.is_whitespace() || next == '{' || next == '}' || next == '"' {
                        break;
                    }
                    value.push(next);
                    chars.next();
                }
                tokens.push(Token::Text(value));
            }
        }
    }
    fn block(tokens: &mut std::iter::Peekable<std::vec::IntoIter<Token>>, depth: usize) -> Vec<(String, vdf::Node)> {
        let mut entries = Vec::new();
        while let Some(token) = tokens.next() {
            match token {
                Token::Close => break,
                Token::Open => {}
                Token::Text(key) => match tokens.next() {
                    Some(Token::Text(value)) => entries.push((key, vdf::Node::Str(value))),
                    Some(Token::Open) if depth < 32 => entries.push((key, vdf::Node::Map(block(tokens, depth + 1)))),
                    _ => break,
                },
            }
        }
        entries
    }
    vdf::Node::Map(block(&mut tokens.into_iter().peekable(), 0))
}

/// The 64-bit SteamID of an individual account → its 32-bit account ID (the `userdata` folder).
const STEAM_ID64_BASE: u64 = 76_561_197_960_265_728;

/// The account `loginusers.vdf` marks as most recently signed in, as a `userdata` folder name.
pub fn most_recent_user(loginusers: &str) -> Option<u32> {
    let root = text_vdf(loginusers);
    let users = root.get("users")?.entries();
    let account = |id: &str| {
        let id: u64 = id.parse().ok()?;
        (id > STEAM_ID64_BASE && id - STEAM_ID64_BASE <= u64::from(u32::MAX))
            .then(|| (id - STEAM_ID64_BASE) as u32)
    };
    let recent = users
        .iter()
        .find(|(_, user)| user.get("MostRecent").and_then(vdf::Node::as_str) == Some("1"));
    match (recent, users) {
        (Some((id, _)), _) => account(id),
        // Newer clients may leave MostRecent out when only one account has signed in.
        (None, [(id, _)]) => account(id),
        _ => None,
    }
}

// ---------------------------------------------------------------- device detection

/// What `/etc/os-release` and the DMI tables say about this machine.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Device {
    pub steam_os: bool,
    pub steam_deck: bool,
}

/// One `os-release` value, unquoted.
fn os_release_value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines().find_map(|line| {
        let (k, v) = line.trim().split_once('=')?;
        (k == key).then(|| v.trim().trim_matches(|c| c == '"' || c == '\''))
    })
}

pub fn detect(os_release: &str, board_vendor: &str, product_name: &str) -> Device {
    let id = os_release_value(os_release, "ID").unwrap_or("");
    let vendor = board_vendor.trim();
    let product = product_name.trim();
    Device {
        steam_os: id.eq_ignore_ascii_case("steamos"),
        // LCD (Jupiter) and OLED (Galileo) Steam Decks, whatever OS they run.
        steam_deck: vendor.eq_ignore_ascii_case("valve")
            && ["jupiter", "galileo"].iter().any(|p| product.eq_ignore_ascii_case(p)),
    }
}

/// Python's `urllib.parse.quote(s, safe='')`, which `steamos-add-to-steam` uses for the URL.
pub fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn add_url(desktop: &Path) -> String {
    format!("steam://addnonsteamgame/{}", percent_encode(&desktop.to_string_lossy()))
}

// ---------------------------------------------------------------- layout

/// Where the gaming-mode launcher lives (the layout `install-gaming-mode.sh` writes).
#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    /// `$XDG_DATA_HOME`, or `~/.local/share`.
    pub data: PathBuf,
}

impl Layout {
    pub fn from_env(xdg_data_home: Option<&str>, home: &Path) -> Layout {
        let data = xdg_data_home
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".local/share"));
        Layout { data }
    }
    pub fn install_dir(&self) -> PathBuf {
        self.data.join("kimochi/gaming-mode")
    }
    /// The stable path Steam shortcuts run (through `/bin/sh`).
    pub fn launcher(&self) -> PathBuf {
        self.install_dir().join("launch.sh")
    }
    pub fn current(&self) -> PathBuf {
        self.install_dir().join("current")
    }
    pub fn desktop(&self) -> PathBuf {
        self.data.join("applications/kimochi-gaming-mode.desktop")
    }
}

/// The library art, by Steam's grid file suffix. Each is skipped when a file with that name in
/// any image format Steam reads is already there.
pub const ART_SUFFIXES: [&str; 4] = ["p", "", "_hero", "_logo"];

pub fn grid_file(app_id: u32, suffix: &str) -> String {
    format!("{app_id}{suffix}.png")
}

/// Whether a grid image for `app_id` + `suffix` already exists in any format Steam accepts.
pub fn grid_has(grid: &Path, app_id: u32, suffix: &str) -> bool {
    ["png", "jpg", "jpeg", "webp"]
        .iter()
        .any(|ext| grid.join(format!("{app_id}{suffix}.{ext}")).exists())
}

// ---------------------------------------------------------------- answers

fn unsupported(reason: &str) -> Value {
    json!({
        "supported": false, "steamDeck": false, "steamOs": false, "steamInstalled": false,
        "steamRunning": false, "gamingMode": false, "added": false, "appId": null,
        "artwork": false, "launcher": false, "reason": reason,
    })
}

/// `steam_library_status() -> SteamLibraryStatus` (COMMANDS.md → Steam library).
#[tauri::command]
pub async fn steam_library_status() -> Value {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(host::status)
            .await
            .unwrap_or_else(|e| unsupported(&e.to_string()))
    }
    #[cfg(not(target_os = "linux"))]
    {
        unsupported("Adding Kimochi to Steam is for Linux (Steam Deck / SteamOS).")
    }
}

/// `steam_library_add() -> {state, message, appId, status}` (COMMANDS.md → Steam library).
#[tauri::command]
pub async fn steam_library_add(app: tauri::AppHandle) -> Value {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        let result = tauri::async_runtime::spawn_blocking(host::add)
            .await
            .unwrap_or_else(|e| json!({"state": "failed", "message": e.to_string(), "appId": null}));
        crate::record(
            &app,
            &app.state::<crate::state::Shared>(),
            json!({"check": "steam-library-add", "state": result["state"], "message": result["message"], "appId": result["appId"]}),
        );
        result
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        json!({
            "state": "unsupported", "appId": null,
            "message": "Adding Kimochi to Steam is for Linux (Steam Deck / SteamOS).",
            "status": unsupported("Adding Kimochi to Steam is for Linux (Steam Deck / SteamOS)."),
        })
    }
}

/// At launch (Linux): give Kimochi's existing entry any library art it is missing.
pub fn start() {
    #[cfg(target_os = "linux")]
    std::thread::Builder::new()
        .name("steam-library".into())
        .spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(5));
            host::ensure_artwork();
        })
        .ok();
}

// ---------------------------------------------------------------- Linux

#[cfg(target_os = "linux")]
mod host {
    use super::*;
    use std::process::{Command, Stdio};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// The embedded launcher bundle: the scripts in `scripts/steam-deck/`, and the icon the
    /// installer puts in hicolor (the one Steam shows for the entry).
    const SCRIPTS: [(&str, &str); 4] = [
        ("install-gaming-mode.sh", include_str!("../../scripts/steam-deck/install-gaming-mode.sh")),
        ("launch-from-steam.sh", include_str!("../../scripts/steam-deck/launch-from-steam.sh")),
        ("launch-gaming-mode.sh", include_str!("../../scripts/steam-deck/launch-gaming-mode.sh")),
        ("launch-gaming-mode-service.sh", include_str!("../../scripts/steam-deck/launch-gaming-mode-service.sh")),
    ];
    const ICON: &[u8] = include_bytes!("../icons/128x128.png");
    /// In `ART_SUFFIXES` order.
    const ART: [&[u8]; 4] = [
        include_bytes!("../../resources/steam-library/capsule.png"),
        include_bytes!("../../resources/steam-library/wide.png"),
        include_bytes!("../../resources/steam-library/hero.png"),
        include_bytes!("../../resources/steam-library/logo.png"),
    ];

    /// One add at a time (a second press waits, then finds the entry).
    static ADDING: Mutex<()> = Mutex::new(());

    fn home() -> Option<PathBuf> {
        std::env::var_os("HOME").map(PathBuf::from).filter(|p| p.is_absolute())
    }

    fn layout() -> Option<Layout> {
        Some(Layout::from_env(std::env::var("XDG_DATA_HOME").ok().as_deref(), &home()?))
    }

    fn read(path: &str) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    fn device() -> Device {
        let os = std::fs::read_to_string("/etc/os-release")
            .or_else(|_| std::fs::read_to_string("/usr/lib/os-release"))
            .unwrap_or_default();
        detect(&os, &read("/sys/class/dmi/id/board_vendor"), &read("/sys/class/dmi/id/product_name"))
    }

    /// The AppImage we run from, or the installed binary.
    fn executable() -> Option<PathBuf> {
        std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute() && p.is_file())
            .or_else(|| std::env::current_exe().ok())
    }

    fn gaming_mode() -> bool {
        crate::platform::gamescope::active()
            || std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|d| d.eq_ignore_ascii_case("gamescope"))
    }

    /// A Steam installation, native or Flatpak.
    struct Root {
        path: PathBuf,
        flatpak: bool,
    }

    fn roots(home: &Path) -> Vec<Root> {
        let candidates = [
            (".local/share/Steam", false),
            (".steam/steam", false),
            (".steam/root", false),
            (".var/app/com.valvesoftware.Steam/.local/share/Steam", true),
            (".var/app/com.valvesoftware.Steam/data/Steam", true),
        ];
        let mut seen = Vec::new();
        let mut roots = Vec::new();
        for (relative, flatpak) in candidates {
            let Ok(path) = home.join(relative).canonicalize() else { continue };
            if !path.join("userdata").is_dir() && !path.join("config").is_dir() {
                continue;
            }
            if seen.contains(&path) {
                continue;
            }
            seen.push(path.clone());
            roots.push(Root { path, flatpak });
        }
        roots
    }

    /// The signed-in (most recent) Steam user's `userdata` folder.
    fn user_dir(root: &Path) -> Option<PathBuf> {
        let userdata = root.join("userdata");
        if let Some(id) = std::fs::read_to_string(root.join("config/loginusers.vdf"))
            .ok()
            .and_then(|text| most_recent_user(&text))
        {
            let dir = userdata.join(id.to_string());
            if dir.is_dir() {
                return Some(dir);
            }
        }
        // No record of who signed in last: only an unambiguous single user.
        let users: Vec<PathBuf> = std::fs::read_dir(&userdata)
            .ok()?
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name();
                let name = name.to_string_lossy();
                name != "0" && name.chars().all(|c| c.is_ascii_digit()) && e.path().is_dir()
            })
            .map(|e| e.path())
            .collect();
        (users.len() == 1).then(|| users[0].clone())
    }

    /// Whether this user's Steam client is running (`pgrep -x steam`, as SteamOS's script checks).
    fn steam_running() -> bool {
        use std::os::unix::fs::MetadataExt;
        let uid = std::fs::metadata("/proc/self").map(|m| m.uid()).ok();
        let Ok(entries) = std::fs::read_dir("/proc") else { return false };
        entries.filter_map(|e| e.ok()).any(|e| {
            e.file_name().to_string_lossy().chars().all(|c| c.is_ascii_digit())
                && std::fs::read_to_string(e.path().join("comm")).is_ok_and(|c| c.trim_end() == "steam")
                && e.metadata().map(|m| Some(m.uid()) == uid).unwrap_or(false)
        })
    }

    fn entry(user: &Path, markers: &[String]) -> Option<Shortcut> {
        let bytes = std::fs::read(user.join("config/shortcuts.vdf")).ok()?;
        let list = shortcuts(&bytes).ok()?;
        find_kimochi(&list, markers).cloned()
    }

    fn has_artwork(user: &Path, app_id: u32) -> bool {
        let grid = user.join("config/grid");
        ART_SUFFIXES.iter().all(|s| grid_has(&grid, app_id, s))
    }

    /// Write the missing library art for `app_id`. Never replaces an existing image.
    fn install_artwork(user: &Path, app_id: u32) -> Result<(), String> {
        let grid = user.join("config/grid");
        std::fs::create_dir_all(&grid).map_err(|e| format!("grid folder: {e}"))?;
        for (suffix, bytes) in ART_SUFFIXES.iter().zip(ART) {
            if grid_has(&grid, app_id, suffix) {
                continue;
            }
            let name = grid_file(app_id, suffix);
            let staging = grid.join(format!(".{name}.kimochi-{}", std::process::id()));
            std::fs::write(&staging, bytes).map_err(|e| format!("{name}: {e}"))?;
            std::fs::rename(&staging, grid.join(&name)).map_err(|e| {
                let _ = std::fs::remove_file(&staging);
                format!("{name}: {e}")
            })?;
        }
        Ok(())
    }

    /// The launcher bundle points at `executable` and matches the embedded scripts.
    fn launcher_current(layout: &Layout, executable: &Path) -> bool {
        let current = layout.current();
        let same_target = match (current.join("Kimochi.AppImage").canonicalize(), executable.canonicalize()) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        same_target
            && layout.launcher().is_file()
            && std::fs::read_to_string(layout.desktop()).is_ok_and(|d| d.lines().any(|l| l == "Name=Kimochi"))
            && SCRIPTS.iter().all(|(name, text)| {
                std::fs::read_to_string(current.join("scripts").join(name)).is_ok_and(|s| s == *text)
            })
    }

    /// A host command without the AppImage runtime's environment (its libraries, GTK/GIO modules
    /// and Python paths would leak into Steam's and KDE's tools), and without our own launch
    /// variables.
    fn host_command(program: &str) -> Command {
        let mut command = Command::new(program);
        for key in [
            "LD_LIBRARY_PATH", "LD_PRELOAD", "PYTHONHOME", "PYTHONPATH", "PERLLIB",
            "GDK_PIXBUF_MODULE_FILE", "GDK_PIXBUF_MODULEDIR", "GIO_EXTRA_MODULES", "GIO_MODULE_DIR",
            "GSETTINGS_SCHEMA_DIR", "GTK_PATH", "GTK_EXE_PREFIX", "GTK_DATA_PREFIX", "GTK_IM_MODULE_FILE",
            "GTK_THEME", "GDK_BACKEND", "QT_PLUGIN_PATH", "QT_QPA_PLATFORM_PLUGIN_PATH",
            "APPDIR", "APPIMAGE", "ARGV0", "OWD", "WEBKIT_DISABLE_DMABUF_RENDERER",
        ] {
            command.env_remove(key);
        }
        if let Some(appdir) = std::env::var_os("APPDIR").map(PathBuf::from) {
            for key in ["PATH", "XDG_DATA_DIRS"] {
                if let Ok(value) = std::env::var(key) {
                    let kept: Vec<&str> = value.split(':').filter(|p| !Path::new(p).starts_with(&appdir)).collect();
                    command.env(key, kept.join(":"));
                }
            }
        }
        command.stdin(Stdio::null());
        command
    }

    /// Run the embedded installer in `--link` mode against `executable`.
    fn install_launcher(layout: &Layout, executable: &Path) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let staging = std::env::temp_dir().join(format!("kimochi-gaming-mode-{}-{nanos}", std::process::id()));
        let result = (|| {
            std::fs::create_dir(&staging).map_err(|e| e.to_string())?;
            for (name, text) in SCRIPTS {
                let path = staging.join(name);
                std::fs::write(&path, text).map_err(|e| e.to_string())?;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
            }
            std::fs::write(staging.join("kimochi.png"), ICON).map_err(|e| e.to_string())?;
            let output = host_command("/bin/sh")
                .arg(staging.join("install-gaming-mode.sh"))
                .arg("--link")
                .arg(executable)
                .env("XDG_DATA_HOME", &layout.data)
                .output()
                .map_err(|e| e.to_string())?;
            if output.status.success() {
                Ok(())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(stderr.trim().lines().last().unwrap_or("the installer failed").to_owned())
            }
        })();
        let _ = std::fs::remove_dir_all(&staging);
        result.map_err(|e| format!("Could not set up the Gaming Mode launcher: {e}"))
    }

    fn on_path(program: &str) -> Option<PathBuf> {
        std::env::var_os("PATH")?
            .to_string_lossy()
            .split(':')
            .map(|dir| Path::new(dir).join(program))
            .find(|p| p.is_file())
    }

    /// Wait for a short-lived helper; one that outlives `limit` is reaped in the background.
    fn wait(mut child: std::process::Child, limit: Duration) -> Result<(), String> {
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => return Ok(()),
                Ok(Some(status)) => {
                    let mut message = String::new();
                    if let Some(mut stderr) = child.stderr.take() {
                        use std::io::Read;
                        let _ = stderr.read_to_string(&mut message);
                    }
                    let message = message.trim().lines().last().unwrap_or("").to_owned();
                    return Err(if message.is_empty() { format!("exited with {status}") } else { message });
                }
                Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(100)),
                Ok(None) => {
                    std::thread::spawn(move || child.wait());
                    return Ok(());
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    }

    /// Ask the running Steam client to add the desktop file as a non-Steam game.
    fn request_add(root: &Root, desktop: &Path) -> Result<(), String> {
        if !root.flatpak {
            if let Some(tool) = on_path("steamos-add-to-steam") {
                let child = host_command(&tool.to_string_lossy())
                    .arg(desktop)
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped())
                    .spawn()
                    .map_err(|e| e.to_string())?;
                return wait(child, Duration::from_secs(20)).map_err(|e| format!("steamos-add-to-steam: {e}"));
            }
        }
        // What steamos-add-to-steam does: the marker file, then the URL for the running client.
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("/tmp/addnonsteamgamefile")
            .and_then(|f| f.set_modified(std::time::SystemTime::now()))
            .map_err(|e| format!("/tmp/addnonsteamgamefile: {e}"))?;
        let url = add_url(desktop);
        let mut command = match (root.flatpak, on_path("steam"), on_path("flatpak")) {
            (false, Some(steam), _) => {
                let mut c = host_command(&steam.to_string_lossy());
                c.arg(&url);
                c
            }
            (_, _, Some(flatpak)) if root.flatpak => {
                let mut c = host_command(&flatpak.to_string_lossy());
                c.args(["run", "com.valvesoftware.Steam", &url]);
                c
            }
            _ => return Err("Steam's command is not available".into()),
        };
        let child = command.stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
        wait(child, Duration::from_secs(10)).map_err(|e| format!("steam: {e}"))
    }

    pub fn status() -> Value {
        let (Some(home), Some(layout)) = (home(), layout()) else {
            return unsupported("HOME is not set.");
        };
        let device = device();
        let roots = roots(&home);
        let executable = executable();
        let markers = markers(&layout, executable.as_deref());
        let user = roots.iter().find_map(|r| user_dir(&r.path));
        let found = user.as_deref().and_then(|u| entry(u, &markers));
        json!({
            "supported": true,
            "steamDeck": device.steam_deck,
            "steamOs": device.steam_os,
            "steamInstalled": !roots.is_empty(),
            "steamRunning": steam_running(),
            "gamingMode": gaming_mode(),
            "added": found.is_some(),
            "appId": found.as_ref().map(|s| s.app_id),
            "artwork": match (&user, &found) { (Some(u), Some(s)) => has_artwork(u, s.app_id), _ => false },
            "launcher": executable.as_deref().is_some_and(|e| launcher_current(&layout, e)),
            "reason": if roots.is_empty() { Some("Steam is not installed for this user.") } else { None },
        })
    }

    fn reply(state: &str, message: &str, app_id: Option<u32>) -> Value {
        json!({"state": state, "message": message, "appId": app_id, "status": status()})
    }

    pub fn add() -> Value {
        let _one = ADDING.lock().unwrap_or_else(|e| e.into_inner());
        let (Some(home), Some(layout), Some(executable)) = (home(), layout(), executable()) else {
            return reply("failed", "Kimochi could not find its own executable or your home folder.", None);
        };
        let roots = roots(&home);
        let Some(root) = roots.first() else {
            return reply("unsupported", "Steam is not installed for this user.", None);
        };
        let Some(user) = roots.iter().find_map(|r| user_dir(&r.path)) else {
            return reply("failed", "Kimochi could not tell which Steam account is signed in. Open Steam and sign in, then try again.", None);
        };
        let markers = markers(&layout, Some(&executable));
        if !launcher_current(&layout, &executable) {
            if let Err(error) = install_launcher(&layout, &executable) {
                return reply("failed", &error, None);
            }
        }
        if let Some(existing) = entry(&user, &markers) {
            let art = install_artwork(&user, existing.app_id);
            let message = match art {
                Ok(()) => "Kimochi is in your Steam library.".to_owned(),
                Err(e) => format!("Kimochi is in your Steam library, but its artwork could not be saved: {e}"),
            };
            return reply("added", &message, Some(existing.app_id));
        }
        if !steam_running() {
            return reply("steamNotRunning", "Steam is not running. Open Steam, then try again, or add Kimochi by hand.", None);
        }
        if let Err(error) = request_add(root, &layout.desktop()) {
            return reply("failed", &format!("Steam did not accept Kimochi: {error}"), None);
        }
        // Steam writes the new entry into shortcuts.vdf shortly after accepting it.
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(500));
            if let Some(added) = entry(&user, &markers) {
                return match install_artwork(&user, added.app_id) {
                    Ok(()) => reply("added", "Kimochi is in your Steam library.", Some(added.app_id)),
                    Err(e) => reply("added", &format!("Kimochi is in your Steam library, but its artwork could not be saved: {e}"), Some(added.app_id)),
                };
            }
        }
        reply(
            "pending",
            "Steam took the request, but Kimochi is not in its library yet. Check your library; Kimochi adds its artwork the next time it starts.",
            None,
        )
    }

    pub fn ensure_artwork() {
        let (Some(home), Some(layout)) = (home(), layout()) else { return };
        let markers = markers(&layout, executable().as_deref());
        for root in roots(&home) {
            let Some(user) = user_dir(&root.path) else { continue };
            if let Some(found) = entry(&user, &markers) {
                if !has_artwork(&user, found.app_id) {
                    if let Err(e) = install_artwork(&user, found.app_id) {
                        eprintln!("Steam library artwork: {e}");
                    }
                }
                return;
            }
        }
    }
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    /// A binary VDF writer for fixtures, mirroring Steam's layout.
    enum F<'a> {
        Map(&'a str, Vec<F<'a>>),
        Str(&'a str, &'a str),
        Int(&'a str, i32),
    }
    fn write(node: &F, out: &mut Vec<u8>) {
        let key = |out: &mut Vec<u8>, k: &str| {
            out.extend_from_slice(k.as_bytes());
            out.push(0);
        };
        match node {
            F::Map(k, children) => {
                out.push(0);
                key(out, k);
                for c in children {
                    write(c, out);
                }
                out.push(8);
            }
            F::Str(k, v) => {
                out.push(1);
                key(out, k);
                key(out, v);
            }
            F::Int(k, v) => {
                out.push(2);
                key(out, k);
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
    }
    fn file(entries: Vec<F>) -> Vec<u8> {
        let mut out = Vec::new();
        write(&F::Map("shortcuts", entries), &mut out);
        out.push(8);
        out
    }
    fn entry<'a>(index: &'a str, app_id: i32, name: &'a str, exe: &'a str, options: &'a str, path: &'a str) -> F<'a> {
        F::Map(
            index,
            vec![
                F::Int("appid", app_id),
                F::Str("AppName", name),
                F::Str("Exe", exe),
                F::Str("StartDir", "/usr/bin/"),
                F::Str("icon", ""),
                F::Str("ShortcutPath", path),
                F::Str("LaunchOptions", options),
                F::Int("IsHidden", 0),
                F::Map("tags", vec![F::Str("0", "Emulation")]),
            ],
        )
    }
    fn layout() -> Layout {
        Layout::from_env(None, Path::new("/home/deck"))
    }

    #[test]
    fn parses_shortcuts_with_negative_app_ids_and_nested_tags() {
        let bytes = file(vec![
            entry("0", -1_996_000_000, "Google Chrome", "\"/usr/bin/flatpak\"", "run com.google.Chrome", "/var/lib/flatpak/app/com.google.Chrome.desktop"),
            entry("1", 0x7200_0001, "日本語 Game", "\"/home/deck/game.sh\"", "", ""),
        ]);
        let list = shortcuts(&bytes).unwrap();
        assert_eq!(list.len(), 2);
        // Grid files use the unsigned value of Steam's int32 field.
        assert_eq!(list[0].app_id, (-1_996_000_000i32) as u32);
        assert_eq!(list[0].app_id, 2_298_967_296);
        assert_eq!(list[1].name, "日本語 Game");
        assert_eq!(list[0].launch_options, "run com.google.Chrome");
    }

    #[test]
    fn reads_every_value_type_steam_writes() {
        let mut bytes = vec![0];
        bytes.extend_from_slice(b"shortcuts\0");
        bytes.extend_from_slice(b"\x000\0");
        bytes.extend_from_slice(b"\x01AppName\0Kimochi\0");
        bytes.extend_from_slice(b"\x03scale\0");
        bytes.extend_from_slice(&1.5f32.to_le_bytes());
        bytes.extend_from_slice(b"\x07big\0");
        bytes.extend_from_slice(&u64::MAX.to_le_bytes());
        bytes.extend_from_slice(b"\x0awide\0");
        bytes.extend_from_slice(&(-5i64).to_le_bytes());
        bytes.extend_from_slice(b"\x08\x08\x08");
        let root = vdf::parse(&bytes).unwrap();
        let first = &root.get("shortcuts").unwrap().entries()[0].1;
        assert_eq!(first.get("appname").and_then(vdf::Node::as_str), Some("Kimochi"));
        assert_eq!(first.get("scale"), Some(&vdf::Node::Float(1.5)));
        assert_eq!(first.get("big"), Some(&vdf::Node::U64(u64::MAX)));
        assert_eq!(first.get("wide"), Some(&vdf::Node::I64(-5)));
    }

    #[test]
    fn rejects_truncated_and_unknown_data_without_panicking() {
        let bytes = file(vec![entry("0", 1, "A", "/a", "", "")]);
        for cut in 0..bytes.len() - 1 {
            // Any prefix either parses (a whole top-level map) or errors; it never panics.
            let _ = vdf::parse(&bytes[..cut]);
        }
        assert!(vdf::parse(b"\x00shortcuts\0\x02appid\0\x01").is_err());
        assert!(vdf::parse(b"\x00shortcuts\0\x05wide\0").is_err());
        assert!(vdf::parse(b"\x00shortcuts\0\x01AppName\0unterminated").is_err());
        let deep: Vec<u8> = std::iter::repeat_n(b"\x00k\0".as_slice(), 64).flatten().copied().collect();
        assert!(vdf::parse(&deep).is_err());
    }

    #[test]
    fn computes_the_legacy_app_id_when_an_entry_has_none() {
        let mut bytes = vec![0];
        bytes.extend_from_slice(b"shortcuts\0\x000\0\x01AppName\0Kimochi\0\x01Exe\0\"/bin/sh\"\0\x08\x08\x08");
        let list = shortcuts(&bytes).unwrap();
        assert_eq!(list[0].app_id & 0x8000_0000, 0x8000_0000);
        assert_eq!(list[0].app_id, legacy_app_id("\"/bin/sh\"", "Kimochi"));
    }

    #[test]
    fn finds_kimochi_by_launcher_desktop_file_or_executable_only() {
        let l = layout();
        let launcher = "\"/home/deck/.local/share/kimochi/gaming-mode/launch.sh\"";
        let desktop = "/home/deck/.local/share/applications/kimochi-gaming-mode.desktop";
        let bytes = file(vec![
            // The Steam Deck devkit shortcut is a different thing; never Kimochi's entry.
            entry("0", 11, "Devkit Game: kimochi_steamdeck", "\"/home/deck/devkit-game/kimochi_steamdeck/launch.sh\"", "", ""),
            entry("1", 22, "Kimochi", "\"/bin/sh\"", launcher, desktop),
        ]);
        let list = shortcuts(&bytes).unwrap();
        let markers = markers(&l, Some(Path::new("/home/deck/Applications/Kimochi.AppImage")));
        assert_eq!(find_kimochi(&list, &markers).map(|s| s.app_id), Some(22));
        // Added by hand from the Add a Non-Steam Game list: Exe is the launcher itself.
        let by_hand = shortcuts(&file(vec![entry("0", 33, "Kimochi Gaming Mode", launcher, "", "")])).unwrap();
        assert_eq!(find_kimochi(&by_hand, &markers).map(|s| s.app_id), Some(33));
        // The AppImage added directly.
        let direct = shortcuts(&file(vec![entry("0", 44, "Kimochi", "\"/home/deck/Applications/Kimochi.AppImage\"", "", "")])).unwrap();
        assert_eq!(find_kimochi(&direct, &markers).map(|s| s.app_id), Some(44));
        let other = shortcuts(&file(vec![entry("0", 55, "Cemu", "\"/usr/bin/bash\"", "/home/deck/cemu.sh", "")])).unwrap();
        assert_eq!(find_kimochi(&other, &markers), None);
        assert_eq!(find_kimochi(&other, &super::markers(&l, None)), None);
    }

    #[test]
    fn reads_the_most_recent_user_from_loginusers() {
        let text = r#""users"
{
	"76561197960265729"
	{
		"AccountName"		"someone"
		"MostRecent"		"0"
	}
	// a comment
	"76561197971758321"
	{
		"AccountName"		"deck \"owner\""
		"MostRecent"		"1"
	}
}"#;
        assert_eq!(most_recent_user(text), Some(11_492_593));
        // The Deck's own file: one account and no MostRecent key.
        assert_eq!(
            most_recent_user(r#""users" { "76561197971758321" { "AutoLogin" "1" "timestamp" "1792007653" } }"#),
            Some(11_492_593)
        );
        assert_eq!(
            most_recent_user(r#""users" { "76561197960265729" { "MostRecent" "0" } "76561197960265730" { } }"#),
            None
        );
        assert_eq!(most_recent_user("garbage {{{"), None);
    }

    #[test]
    fn detects_steamos_and_both_steam_deck_models() {
        let steamos = "NAME=\"SteamOS\"\nID=steamos\nID_LIKE=arch\nVARIANT_ID=steamdeck\n";
        assert_eq!(detect(steamos, "Valve\n", "Jupiter\n"), Device { steam_os: true, steam_deck: true });
        assert_eq!(detect(steamos, "Valve", "Galileo"), Device { steam_os: true, steam_deck: true });
        // Bazzite and friends on a Deck: a Deck, not SteamOS.
        assert_eq!(detect("ID=bazzite\nID_LIKE=\"fedora\"\n", "Valve", "Jupiter"), Device { steam_os: false, steam_deck: true });
        // A Legion Go running SteamOS.
        assert_eq!(detect("ID=\"steamos\"", "LENOVO", "83E1"), Device { steam_os: true, steam_deck: false });
        assert_eq!(detect("ID=ubuntu\nID_LIKE=debian\n", "ASUSTeK", "Jupiter"), Device::default());
        assert_eq!(detect("", "", ""), Device::default());
    }

    #[test]
    fn percent_encodes_like_python_quote_with_no_safe_characters() {
        assert_eq!(
            add_url(Path::new("/home/deck/.local/share/applications/kimochi-gaming-mode.desktop")),
            "steam://addnonsteamgame/%2Fhome%2Fdeck%2F.local%2Fshare%2Fapplications%2Fkimochi-gaming-mode.desktop"
        );
        assert_eq!(percent_encode("a b~_.-%/日"), "a%20b~_.-%25%2F%E6%97%A5");
    }

    #[test]
    fn lays_out_the_gaming_mode_launcher_like_the_installer() {
        let l = layout();
        assert_eq!(l.launcher(), Path::new("/home/deck/.local/share/kimochi/gaming-mode/launch.sh"));
        assert_eq!(l.current(), Path::new("/home/deck/.local/share/kimochi/gaming-mode/current"));
        assert_eq!(l.desktop(), Path::new("/home/deck/.local/share/applications/kimochi-gaming-mode.desktop"));
        let custom = Layout::from_env(Some("/data/xdg"), Path::new("/home/deck"));
        assert_eq!(custom.launcher(), Path::new("/data/xdg/kimochi/gaming-mode/launch.sh"));
        // A relative XDG_DATA_HOME is invalid by the spec and ignored.
        assert_eq!(Layout::from_env(Some("rel"), Path::new("/home/deck")), l);
    }

    #[test]
    fn names_grid_art_as_steam_expects() {
        let names: Vec<String> = ART_SUFFIXES.iter().map(|s| grid_file(2_298_967_296, s)).collect();
        assert_eq!(names, ["2298967296p.png", "2298967296.png", "2298967296_hero.png", "2298967296_logo.png"]);
        let dir = std::env::temp_dir().join(format!("kimochi-grid-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("42_hero.jpg"), b"user art").unwrap();
        assert!(grid_has(&dir, 42, "_hero"));
        assert!(!grid_has(&dir, 42, "p"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
