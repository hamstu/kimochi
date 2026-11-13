//! Where a Screen AI component may already be on this computer, and what it was built for.
//!
//! Chrome's component updater keeps the library and its models in `<user data>/screen_ai/<version>/`
//! (library and models side by side). Kimochi's own download, and the copy owocr and
//! GameSentenceMiner fetch into `~/.config/screen_ai/`, keep Google's package layout instead:
//! `<root>/resources/<library>`. Everything here is pure path work over the environment it is
//! given, so the platform tables are testable on any OS.
use std::path::{Path, PathBuf};

/// The library's file name on `os` ("macos", "windows", anything else is Linux).
pub fn library_name(os: &str) -> &'static str {
    match os {
        "windows" => "chrome_screen_ai.dll",
        // Google names the macOS build `.so` too (it is a Mach-O image either way).
        _ => "libchromescreenai.so",
    }
}

/// The environment the search reads: home, and on Windows `%LOCALAPPDATA%`, on Linux
/// `$XDG_CONFIG_HOME`.
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub os: String,
    pub home: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub xdg_config_home: Option<PathBuf>,
}

impl Env {
    pub fn current() -> Self {
        let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
        Self {
            os: std::env::consts::OS.to_string(),
            home: var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }),
            local_app_data: var("LOCALAPPDATA"),
            xdg_config_home: var("XDG_CONFIG_HOME"),
        }
    }
}

/// A browser's `screen_ai` directory, which holds one directory per installed version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserRoot {
    /// "Google Chrome", "Chromium", …: what the settings say the copy came from.
    pub browser: &'static str,
    pub dir: PathBuf,
}

/// Every browser `screen_ai` directory worth looking in, most common first. Chrome is the one
/// known to download the component everywhere; the other Chromium browsers are listed because
/// they share the updater, and cost nothing to look for when they are absent.
pub fn browser_roots(env: &Env) -> Vec<BrowserRoot> {
    let mut roots = Vec::new();
    let mut add = |browser: &'static str, base: &Option<PathBuf>, parts: &[&str]| {
        if let Some(base) = base {
            let mut dir = base.clone();
            for part in parts {
                dir.push(part);
            }
            dir.push("screen_ai");
            roots.push(BrowserRoot { browser, dir });
        }
    };
    match env.os.as_str() {
        "macos" => {
            let support = env.home.as_ref().map(|h| h.join("Library/Application Support"));
            for (browser, parts) in [
                ("Google Chrome", &["Google", "Chrome"][..]),
                ("Google Chrome Beta", &["Google", "Chrome Beta"]),
                ("Google Chrome Dev", &["Google", "Chrome Dev"]),
                ("Google Chrome Canary", &["Google", "Chrome Canary"]),
                ("Chromium", &["Chromium"]),
                ("Microsoft Edge", &["Microsoft Edge"]),
                ("Brave", &["BraveSoftware", "Brave-Browser"]),
                ("Vivaldi", &["Vivaldi"]),
                ("Arc", &["Arc", "User Data"]),
            ] {
                add(browser, &support, parts);
            }
        }
        "windows" => {
            for (browser, parts) in [
                ("Google Chrome", &["Google", "Chrome", "User Data"][..]),
                ("Google Chrome Beta", &["Google", "Chrome Beta", "User Data"]),
                ("Google Chrome Dev", &["Google", "Chrome Dev", "User Data"]),
                ("Google Chrome Canary", &["Google", "Chrome SxS", "User Data"]),
                ("Chromium", &["Chromium", "User Data"]),
                ("Microsoft Edge", &["Microsoft", "Edge", "User Data"]),
                ("Brave", &["BraveSoftware", "Brave-Browser", "User Data"]),
                ("Vivaldi", &["Vivaldi", "User Data"]),
            ] {
                add(browser, &env.local_app_data, parts);
            }
        }
        _ => {
            let config = env.xdg_config_home.clone().or_else(|| env.home.as_ref().map(|h| h.join(".config")));
            for (browser, parts) in [
                ("Google Chrome", &["google-chrome"][..]),
                ("Google Chrome Beta", &["google-chrome-beta"]),
                ("Google Chrome Dev", &["google-chrome-unstable"]),
                ("Chromium", &["chromium"]),
                ("Microsoft Edge", &["microsoft-edge"]),
                ("Brave", &["BraveSoftware", "Brave-Browser"]),
                ("Vivaldi", &["vivaldi"]),
            ] {
                add(browser, &config, parts);
            }
            // Flatpak and Snap keep each browser's profile inside its sandbox.
            for (browser, parts) in [
                ("Google Chrome", &[".var", "app", "com.google.Chrome", "config", "google-chrome"][..]),
                ("Chromium", &[".var", "app", "org.chromium.Chromium", "config", "chromium"]),
                ("Brave", &[".var", "app", "com.brave.Browser", "config", "BraveSoftware", "Brave-Browser"]),
                ("Microsoft Edge", &[".var", "app", "com.microsoft.Edge", "config", "microsoft-edge"]),
                ("Chromium", &["snap", "chromium", "common", "chromium"]),
            ] {
                add(browser, &env.home, parts);
            }
        }
    }
    roots
}

/// Where owocr and GameSentenceMiner put the copy they fetch (Google's package layout): a user
/// who already set it up for them needs nothing more.
pub fn shared_config_root(env: &Env) -> Option<PathBuf> {
    env.home.as_ref().map(|h| h.join(".config").join("screen_ai"))
}

/// A version directory name ("153.7", "140.20") as numbers, for ordering; `None` for anything
/// else (Chrome leaves `.tmp` and other names around while it updates).
pub fn parse_version(name: &str) -> Option<Vec<u32>> {
    let parts: Option<Vec<u32>> = name.split('.').map(|p| p.parse().ok()).collect();
    parts.filter(|p| !p.is_empty())
}

/// A usable component directory: the one the library and its models are read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Component {
    /// The directory holding the library; model paths the library asks for are relative to it.
    pub dir: PathBuf,
    pub version: String,
}

/// The newest version in a browser's `screen_ai` directory that has the library.
pub fn newest_in(root: &Path, os: &str) -> Option<Component> {
    let library = library_name(os);
    std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let version = parse_version(&name)?;
            let dir = entry.path();
            dir.join(library).is_file().then_some((version, name, dir))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, version, dir)| Component { dir, version })
}

/// A copy in Google's package layout (`<root>/resources/<library>`), with its version from the
/// package's `manifest.json` when that says (Chrome's component manifest has `"version"`).
pub fn package_in(root: &Path, os: &str) -> Option<Component> {
    let dir = root.join("resources");
    if !dir.join(library_name(os)).is_file() {
        return None;
    }
    let version = std::fs::read_to_string(root.join("manifest.json"))
        .ok()
        .and_then(|json| json_string(&json, "version"))
        .unwrap_or_default();
    Some(Component { dir, version })
}

/// The string value of a top-level `"key": "value"` pair in small, trusted JSON; enough for a
/// manifest's version without a JSON dependency.
fn json_string(json: &str, key: &str) -> Option<String> {
    let at = json.find(&format!("\"{key}\""))? + key.len() + 2;
    let rest = json[at..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}

/// The CPU a library was built for, read from its header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arch {
    X64,
    Arm64,
    X86,
    Other,
}

impl Arch {
    /// The architecture this program was built for.
    pub fn current() -> Self {
        match std::env::consts::ARCH {
            "x86_64" => Arch::X64,
            "aarch64" => Arch::Arm64,
            "x86" => Arch::X86,
            _ => Arch::Other,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Arch::X64 => "x64",
            Arch::Arm64 => "ARM64",
            Arch::X86 => "x86",
            Arch::Other => "an unsupported CPU",
        }
    }
}

/// Every architecture in a library's header: one for a thin image, several for a universal
/// Mach-O. Empty when the header is unreadable or unknown.
pub fn architectures(header: &[u8]) -> Vec<Arch> {
    let u16le = |at: usize| header.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
    let u32le = |at: usize| header.get(at..at + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()));
    let u32be = |at: usize| header.get(at..at + 4).map(|b| u32::from_be_bytes(b.try_into().unwrap()));
    let mach = |cpu: u32| match cpu {
        0x0100_0007 => Arch::X64,
        0x0100_000c => Arch::Arm64,
        7 => Arch::X86,
        _ => Arch::Other,
    };
    if header.starts_with(b"\x7fELF") {
        return vec![match u16le(18) {
            Some(0x3e) => Arch::X64,
            Some(0xb7) => Arch::Arm64,
            Some(0x03) => Arch::X86,
            _ => Arch::Other,
        }];
    }
    if header.starts_with(b"MZ") {
        let Some(pe) = u32le(60).map(|o| o as usize) else { return vec![] };
        if header.get(pe..pe + 4) != Some(b"PE\0\0") {
            return vec![];
        }
        return vec![match u16le(pe + 4) {
            Some(0x8664) => Arch::X64,
            Some(0xaa64) => Arch::Arm64,
            Some(0x014c) => Arch::X86,
            _ => Arch::Other,
        }];
    }
    if u32le(0) == Some(0xfeed_facf) {
        return u32le(4).map(mach).into_iter().collect();
    }
    if u32be(0) == Some(0xcafe_babe) {
        let count = u32be(4).unwrap_or(0).min(16) as usize;
        return (0..count).filter_map(|i| u32be(8 + i * 20)).map(mach).collect();
    }
    vec![]
}

/// The architectures of the library file at `path` (its first 4 KiB, enough for any header).
pub fn library_architectures(path: &Path) -> Vec<Arch> {
    use std::io::Read;
    let mut header = vec![0u8; 4096];
    let Ok(mut file) = std::fs::File::open(path) else { return vec![] };
    let mut read = 0;
    while read < header.len() {
        match file.read(&mut header[read..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => read += n,
        }
    }
    header.truncate(read);
    architectures(&header)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(os: &str) -> Env {
        Env {
            os: os.into(),
            home: Some(PathBuf::from("/home/u")),
            local_app_data: Some(PathBuf::from("C:/Users/u/AppData/Local")),
            xdg_config_home: None,
        }
    }

    #[test]
    fn chrome_comes_first_on_every_os() {
        for (os, expected) in [
            ("macos", "/home/u/Library/Application Support/Google/Chrome/screen_ai"),
            ("windows", "C:/Users/u/AppData/Local/Google/Chrome/User Data/screen_ai"),
            ("linux", "/home/u/.config/google-chrome/screen_ai"),
        ] {
            let roots = browser_roots(&env(os));
            assert_eq!(roots[0].browser, "Google Chrome");
            assert_eq!(roots[0].dir, PathBuf::from(expected), "{os}");
        }
    }

    #[test]
    fn linux_honours_xdg_config_home_and_looks_in_flatpak() {
        let mut e = env("linux");
        e.xdg_config_home = Some(PathBuf::from("/cfg"));
        let roots = browser_roots(&e);
        assert_eq!(roots[0].dir, PathBuf::from("/cfg/google-chrome/screen_ai"));
        assert!(roots.iter().any(|r| r.dir.starts_with("/home/u/.var/app/com.google.Chrome")));
    }

    #[test]
    fn versions_order_numerically() {
        assert!(parse_version("153.7") > parse_version("9.50"));
        assert!(parse_version("140.20") > parse_version("140.3"));
        assert_eq!(parse_version("153.7.tmp"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn newest_version_with_a_library_wins() {
        let root = std::env::temp_dir().join(format!("kimochi-screenai-locate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (version, with_library) in [("140.20", true), ("153.7", true), ("160.1", false), ("x", true)] {
            let dir = root.join(version);
            std::fs::create_dir_all(&dir).unwrap();
            if with_library {
                std::fs::write(dir.join(library_name("linux")), b"").unwrap();
            }
        }
        let found = newest_in(&root, "linux").unwrap();
        assert_eq!(found.version, "153.7");
        assert_eq!(found.dir, root.join("153.7"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn package_layout_reads_its_manifest_version() {
        let root = std::env::temp_dir().join(format!("kimochi-screenai-package-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("resources")).unwrap();
        assert_eq!(package_in(&root, "macos"), None);
        std::fs::write(root.join("resources").join(library_name("macos")), b"").unwrap();
        std::fs::write(root.join("manifest.json"), r#"{ "name": "x", "version" : "153.7" }"#).unwrap();
        let found = package_in(&root, "macos").unwrap();
        assert_eq!((found.dir, found.version.as_str()), (root.join("resources"), "153.7"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn headers_name_their_architecture() {
        let mut elf = vec![0u8; 64];
        elf[..4].copy_from_slice(b"\x7fELF");
        elf[18] = 0xb7;
        assert_eq!(architectures(&elf), vec![Arch::Arm64]);

        let mut pe = vec![0u8; 256];
        pe[..2].copy_from_slice(b"MZ");
        pe[60] = 128;
        pe[128..132].copy_from_slice(b"PE\0\0");
        pe[132..134].copy_from_slice(&0x8664u16.to_le_bytes());
        assert_eq!(architectures(&pe), vec![Arch::X64]);

        let mut macho = vec![0u8; 32];
        macho[..4].copy_from_slice(&0xfeed_facfu32.to_le_bytes());
        macho[4..8].copy_from_slice(&0x0100_000cu32.to_le_bytes());
        assert_eq!(architectures(&macho), vec![Arch::Arm64]);

        let mut fat = vec![0u8; 64];
        fat[..4].copy_from_slice(&0xcafe_babeu32.to_be_bytes());
        fat[4..8].copy_from_slice(&2u32.to_be_bytes());
        fat[8..12].copy_from_slice(&0x0100_0007u32.to_be_bytes());
        fat[28..32].copy_from_slice(&0x0100_000cu32.to_be_bytes());
        assert_eq!(architectures(&fat), vec![Arch::X64, Arch::Arm64]);

        assert!(architectures(b"nope").is_empty());
    }
}
