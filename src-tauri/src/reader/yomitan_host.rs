//! Yomitan API setup status: whether the browser native-messaging host that serves the Yomitan
//! API is installed (and by which installer), kept apart from whether the API answers.
//!
//! The Yomitan API is a small HTTP server (`127.0.0.1:19633` by default) run by a native-messaging
//! host that the BROWSER starts when Yomitan's "Enable Yomitan API" setting is on. So the two
//! questions have different answers in normal use: a host can be installed while nothing answers
//! (the browser is closed, the setting is off, or the browser suspended the host), and Kimochi
//! never conflates them.
//!
//! Installed? Browsers find a host through a manifest named after it (`yomitan_api.json`): a file
//! in a per-browser directory on macOS and Linux, a registry key whose default value is the
//! manifest's path on Windows. The manifest's `path` names the program, which tells the installer
//! apart: upstream yomidevs/yomitan-api registers its Python script (`yomitan_api.py`, or a
//! `yomitan_api.bat` wrapper on Windows); Kimochi's preferred host, the Go port
//! (hamstu/go-yomitan-native-messaging-host), registers its binary (`yomitan-host-<os>-<arch>`).
//!
//! Reachable? `yomitan_api_check` asks the host itself (`/serverVersion`, answered by the host
//! alone) and then Yomitan through it (`/yomitanVersion`, a round trip into the extension).
//!
//! Everything here only reads: no manifest or registry key is ever written outside the explicit
//! install action (`yomitan_install.rs`).

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// The native-messaging host name Yomitan connects to (`chrome.runtime.connectNative`), and the
/// manifest's file name without `.json`. The same in upstream and the Go port.
pub const HOST_NAME: &str = "yomitan_api";

/// The Yomitan extension's ids, as the manifests allow them (upstream and the Go port agree).
#[cfg_attr(not(windows), allow(dead_code))]
pub const CHROME_ORIGIN: &str = "chrome-extension://likgccmbimhjbgkjambclfkhldnlhbnn/";
#[cfg_attr(not(windows), allow(dead_code))]
pub const FIREFOX_ID: &str = "{6b733b82-9261-47ee-a595-2dda294a4d08}";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Mac,
    Linux,
    Windows,
}

impl Os {
    pub fn current() -> Option<Os> {
        match std::env::consts::OS {
            "macos" => Some(Os::Mac),
            "linux" => Some(Os::Linux),
            "windows" => Some(Os::Windows),
            _ => None,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Os::Mac => "macos",
            Os::Linux => "linux",
            Os::Windows => "windows",
        }
    }
}

/// Where a browser looks for a native-messaging host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Registration {
    /// A directory holding `<name>.json` (macOS, Linux).
    Dir(PathBuf),
    /// A key under `HKEY_CURRENT_USER` whose default value is the manifest's path (Windows).
    Registry(String),
}

#[derive(Clone, Debug)]
pub struct BrowserLocation {
    pub id: &'static str,
    pub name: &'static str,
    pub registration: Registration,
}

/// Every browser location Kimochi looks at on `os`, for the user whose home is `home`.
pub fn browser_locations(os: Os, home: &Path) -> Vec<BrowserLocation> {
    let dir = |id, name, parts: &[&str]| {
        let mut path = home.to_path_buf();
        for part in parts {
            path.push(part);
        }
        BrowserLocation { id, name, registration: Registration::Dir(path) }
    };
    match os {
        Os::Mac => {
            const SUPPORT: [&str; 2] = ["Library", "Application Support"];
            let mac = |id, name, rest: &[&str]| {
                let parts: Vec<&str> = SUPPORT.iter().chain(rest).chain(["NativeMessagingHosts"].iter()).copied().collect();
                dir(id, name, &parts)
            };
            vec![
                mac("chrome", "Google Chrome", &["Google", "Chrome"]),
                mac("chromium", "Chromium", &["Chromium"]),
                mac("brave", "Brave", &["BraveSoftware", "Brave-Browser"]),
                mac("edge", "Microsoft Edge", &["Microsoft Edge"]),
                mac("vivaldi", "Vivaldi", &["Vivaldi"]),
                // Arc keeps its profile under "User Data"; the Go host's installer writes there.
                mac("arc", "Arc", &["Arc", "User Data"]),
                mac("firefox", "Firefox", &["Mozilla"]),
            ]
        }
        Os::Linux => {
            let linux = |id, name, rest: &[&str]| {
                let parts: Vec<&str> = [".config"].iter().chain(rest).chain(["NativeMessagingHosts"].iter()).copied().collect();
                dir(id, name, &parts)
            };
            vec![
                linux("chrome", "Google Chrome", &["google-chrome"]),
                linux("chromium", "Chromium", &["chromium"]),
                linux("brave", "Brave", &["BraveSoftware", "Brave-Browser"]),
                linux("edge", "Microsoft Edge", &["microsoft-edge"]),
                linux("vivaldi", "Vivaldi", &["vivaldi"]),
                dir("firefox", "Firefox", &[".mozilla", "native-messaging-hosts"]),
            ]
        }
        Os::Windows => windows_keys()
            .into_iter()
            .map(|(id, name, key)| BrowserLocation { id, name, registration: Registration::Registry(key) })
            .collect(),
    }
}

/// `(browser id, name, HKCU subkey)` for each browser that reads a host from the registry.
pub fn windows_keys() -> Vec<(&'static str, &'static str, String)> {
    [
        ("chrome", "Google Chrome", r"Software\Google\Chrome"),
        ("chromium", "Chromium", r"Software\Chromium"),
        ("brave", "Brave", r"Software\BraveSoftware\Brave-Browser"),
        ("edge", "Microsoft Edge", r"Software\Microsoft\Edge"),
        ("vivaldi", "Vivaldi", r"Software\Vivaldi"),
        ("firefox", "Firefox", r"Software\Mozilla"),
    ]
    .into_iter()
    .map(|(id, name, base)| (id, name, format!(r"{base}\NativeMessagingHosts\{HOST_NAME}")))
    .collect()
}

/// Who installed a host, read off the program its manifest names.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HostMethod {
    /// yomidevs/yomitan-api: its Python script, or the `.bat` wrapper its installer writes on Windows.
    Official,
    /// The Go host Kimochi installs (hamstu/go-yomitan-native-messaging-host).
    Kimochi,
    /// Something else registered under the same name.
    Unknown,
}

/// The last component of a path written for any OS (a Windows path is classified on any OS).
fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

pub fn classify_host_path(path: &str) -> HostMethod {
    let name = file_name(path.trim()).to_ascii_lowercase();
    if name.ends_with(".py") {
        return HostMethod::Official;
    }
    if (name.ends_with(".bat") || name.ends_with(".cmd")) && name.starts_with("yomitan_api") {
        return HostMethod::Official;
    }
    if name.starts_with("yomitan-host") || name.starts_with("go-yomitan-native-messaging-host") {
        return HostMethod::Kimochi;
    }
    HostMethod::Unknown
}

/// Whether `path` is absolute in either convention (`/x`, `C:\x`, `\\server\x`).
fn is_absolute_any(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || path.starts_with(r"\\")
        || (bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/'))
}

/// One browser's registration, as found.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestReport {
    pub browser: String,
    pub browser_name: String,
    pub manifest_path: String,
    /// The program the manifest names, resolved against the manifest's folder when relative
    /// (Windows allows that).
    pub host_path: Option<String>,
    /// None when the manifest could not be read as a Yomitan API manifest.
    pub method: Option<HostMethod>,
    /// Whether the program the manifest names exists.
    pub host_exists: bool,
    /// Why this registration cannot work, in words.
    pub problem: Option<String>,
}

impl ManifestReport {
    pub fn usable(&self) -> bool {
        self.method.is_some() && self.host_exists && self.problem.is_none()
    }
}

/// Reads one manifest's text (or the error reading it) into a report. `exists` answers for the
/// program it names, so tests need no files.
pub fn inspect_manifest(
    location: &BrowserLocation,
    manifest_path: &str,
    contents: Result<String, String>,
    exists: &dyn Fn(&str) -> bool,
) -> ManifestReport {
    let mut report = ManifestReport {
        browser: location.id.into(),
        browser_name: location.name.into(),
        manifest_path: manifest_path.into(),
        host_path: None,
        method: None,
        host_exists: false,
        problem: None,
    };
    let text = match contents {
        Ok(text) => text,
        Err(error) => {
            report.problem = Some(format!("The manifest could not be read ({error})."));
            return report;
        }
    };
    let manifest: Value = match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
        Ok(value) => value,
        Err(_) => {
            report.problem = Some("The manifest is not valid JSON.".into());
            return report;
        }
    };
    if manifest.get("name").and_then(Value::as_str) != Some(HOST_NAME) {
        report.problem = Some(format!("The manifest does not name the {HOST_NAME} host."));
        return report;
    }
    let Some(raw) = manifest.get("path").and_then(Value::as_str).filter(|p| !p.trim().is_empty()) else {
        report.problem = Some("The manifest names no program.".into());
        return report;
    };
    let resolved = if is_absolute_any(raw) {
        raw.to_string()
    } else {
        let folder = manifest_path.rfind(['/', '\\']).map(|i| &manifest_path[..=i]).unwrap_or("");
        format!("{folder}{raw}")
    };
    report.method = Some(classify_host_path(&resolved));
    report.host_exists = exists(&resolved);
    if !report.host_exists {
        report.problem = Some("The program this manifest names is missing.".into());
    }
    report.host_path = Some(resolved);
    report
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub os: &'static str,
    /// At least one browser has a working registration.
    pub installed: bool,
    /// The installer behind the working registrations: Kimochi's when any is Kimochi's, else
    /// upstream's, else unknown. Null when nothing works.
    pub method: Option<HostMethod>,
    /// Every registration found, working or not, one per browser location.
    pub browsers: Vec<ManifestReport>,
}

pub fn summarize(os: Os, browsers: Vec<ManifestReport>) -> HostStatus {
    let usable: Vec<HostMethod> = browsers.iter().filter(|r| r.usable()).filter_map(|r| r.method).collect();
    let method = [HostMethod::Kimochi, HostMethod::Official, HostMethod::Unknown]
        .into_iter()
        .find(|m| usable.contains(m));
    HostStatus { os: os.id(), installed: method.is_some(), method, browsers }
}

/// The default value of a `reg query <key> /ve` answer. The value's label is localised
/// ("(Default)", "(既定)"), so the line is found by its type instead.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_reg_default(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let (_, rest) = line.split_once("REG_EXPAND_SZ").or_else(|| line.split_once("REG_SZ"))?;
        let value = rest.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

#[cfg(windows)]
fn query_registry(key: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("reg")
        .args(["query", &format!(r"HKCU\{key}"), "/ve"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_reg_default(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(windows))]
fn query_registry(_key: &str) -> Option<String> {
    None
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Looks at every location on this computer. Reads only.
pub fn detect() -> HostStatus {
    let Some(os) = Os::current() else {
        return HostStatus { os: "other", installed: false, method: None, browsers: vec![] };
    };
    let home = home().unwrap_or_default();
    let exists = |path: &str| Path::new(path).is_file();
    let mut reports = Vec::new();
    for location in browser_locations(os, &home) {
        let manifest = match &location.registration {
            Registration::Dir(dir) => {
                let file = dir.join(format!("{HOST_NAME}.json"));
                if !file.is_file() {
                    continue;
                }
                file
            }
            Registration::Registry(key) => match query_registry(key) {
                Some(path) => PathBuf::from(path),
                None => continue,
            },
        };
        let contents = std::fs::read_to_string(&manifest).map_err(|e| e.kind().to_string());
        reports.push(inspect_manifest(&location, &manifest.to_string_lossy(), contents, &exists));
    }
    summarize(os, reports)
}

#[tauri::command]
pub async fn yomitan_host_status() -> Result<HostStatus, String> {
    tauri::async_runtime::spawn_blocking(detect)
        .await
        .map_err(|e| format!("native: {e}"))
}

// ---------------------------------------------------------------- reachability

/// What the API answered. `server` is the host process itself; `yomitan` is a round trip into
/// the extension through it.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApiStatus {
    pub url: String,
    pub server: bool,
    pub yomitan: bool,
    pub yomitan_version: Option<String>,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

/// Short, so a 1 s poll never piles up: the host answers `/serverVersion` itself, at once.
const SERVER_TIMEOUT: Duration = Duration::from_millis(1500);
/// The extension's answer goes through the browser's native-messaging pipe.
const YOMITAN_TIMEOUT: Duration = Duration::from_secs(4);

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Kimochi")
            .pool_idle_timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest client")
    })
}

#[tauri::command]
pub async fn yomitan_api_check(window: tauri::WebviewWindow, url: String) -> Result<ApiStatus, String> {
    if window.label() == crate::OVERLAY {
        return Err("invalid: yomitan_api_check is not available to the extension host".into());
    }
    let base = crate::validate_configured_api_url(url.trim())?;
    let base = base.as_str().trim_end_matches('/').to_string();
    let mut status = ApiStatus { url: base.clone(), ..ApiStatus::default() };
    let started = Instant::now();
    let server = client()
        .post(format!("{base}/serverVersion"))
        .json(&serde_json::json!({}))
        .timeout(SERVER_TIMEOUT)
        .send()
        .await;
    match server {
        Ok(response) if response.status().is_success() => status.server = true,
        Ok(response) => {
            status.error = Some(format!("HTTP {}", response.status().as_u16()));
            return Ok(status);
        }
        Err(error) => {
            status.error = Some(if error.is_connect() {
                "Nothing is listening at this address.".into()
            } else if error.is_timeout() {
                "The address did not answer in time.".into()
            } else {
                error.to_string()
            });
            return Ok(status);
        }
    }
    status.latency_ms = Some(started.elapsed().as_millis() as u64);
    let yomitan = client()
        .post(format!("{base}/yomitanVersion"))
        .json(&serde_json::json!({}))
        .timeout(YOMITAN_TIMEOUT)
        .send()
        .await;
    match yomitan {
        Ok(response) if response.status().is_success() => {
            status.yomitan = true;
            status.yomitan_version = response
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("version").and_then(Value::as_str).map(str::to_string));
        }
        Ok(response) => status.error = Some(format!("Yomitan answered HTTP {}", response.status().as_u16())),
        Err(error) => status.error = Some(format!("Yomitan did not answer through the host ({error})")),
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn location(os: Os, id: &str) -> BrowserLocation {
        browser_locations(os, Path::new("/home/u"))
            .into_iter()
            .find(|l| l.id == id)
            .expect("location")
    }

    fn manifest(path: &str) -> String {
        serde_json::json!({
            "name": "yomitan_api",
            "description": "Yomitan API",
            "type": "stdio",
            "path": path,
            "allowed_origins": [CHROME_ORIGIN]
        })
        .to_string()
    }

    const ALL: fn(&str) -> bool = |_| true;
    const NONE: fn(&str) -> bool = |_| false;

    #[test]
    fn classifies_each_installer() {
        // Upstream on macOS copies its script beside the manifest.
        assert_eq!(
            classify_host_path("/Users/u/Library/Application Support/Google/Chrome/NativeMessagingHosts/yomitan_api.py"),
            HostMethod::Official
        );
        // Upstream on Linux points at the clone.
        assert_eq!(classify_host_path("/home/u/src/yomitan-api/yomitan_api.py"), HostMethod::Official);
        // Upstream on Windows writes a .bat wrapper around Python.
        assert_eq!(classify_host_path(r"C:\Users\u\yomitan-api\yomitan_api.bat"), HostMethod::Official);
        assert_eq!(classify_host_path(r"C:\Users\u\yomitan-api\YOMITAN_API.CMD"), HostMethod::Official);
        // The Go host, as Kimochi installs it on each OS.
        assert_eq!(
            classify_host_path("/Users/u/Library/Application Support/Mozilla/NativeMessagingHosts/yomitan-host-darwin-arm64"),
            HostMethod::Kimochi
        );
        assert_eq!(
            classify_host_path("/home/u/.config/chromium/NativeMessagingHosts/yomitan-host-linux-amd64"),
            HostMethod::Kimochi
        );
        assert_eq!(
            classify_host_path(r"C:\Users\u\AppData\Local\com.kimochi.app\yomitan-host\yomitan-host.exe"),
            HostMethod::Kimochi
        );
        // A build from source keeps the module's name.
        assert_eq!(
            classify_host_path("/Users/u/Library/Application Support/Arc/User Data/NativeMessagingHosts/go-yomitan-native-messaging-host"),
            HostMethod::Kimochi
        );
        assert_eq!(classify_host_path("/opt/something/else"), HostMethod::Unknown);
        assert_eq!(classify_host_path(r"C:\tools\other.bat"), HostMethod::Unknown);
    }

    #[test]
    fn locations_per_os() {
        let mac = browser_locations(Os::Mac, Path::new("/Users/u"));
        let chrome = mac.iter().find(|l| l.id == "chrome").unwrap();
        assert_eq!(
            chrome.registration,
            Registration::Dir(PathBuf::from("/Users/u/Library/Application Support/Google/Chrome/NativeMessagingHosts"))
        );
        let firefox = mac.iter().find(|l| l.id == "firefox").unwrap();
        assert_eq!(
            firefox.registration,
            Registration::Dir(PathBuf::from("/Users/u/Library/Application Support/Mozilla/NativeMessagingHosts"))
        );
        for id in ["chromium", "brave", "edge", "vivaldi", "arc"] {
            assert!(mac.iter().any(|l| l.id == id), "macOS {id}");
        }

        let linux = browser_locations(Os::Linux, Path::new("/home/u"));
        let brave = linux.iter().find(|l| l.id == "brave").unwrap();
        assert_eq!(
            brave.registration,
            Registration::Dir(PathBuf::from("/home/u/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"))
        );
        let firefox = linux.iter().find(|l| l.id == "firefox").unwrap();
        assert_eq!(firefox.registration, Registration::Dir(PathBuf::from("/home/u/.mozilla/native-messaging-hosts")));
        for id in ["chrome", "chromium", "edge", "vivaldi"] {
            assert!(linux.iter().any(|l| l.id == id), "Linux {id}");
        }

        let windows = browser_locations(Os::Windows, Path::new(r"C:\Users\u"));
        let edge = windows.iter().find(|l| l.id == "edge").unwrap();
        assert_eq!(
            edge.registration,
            Registration::Registry(r"Software\Microsoft\Edge\NativeMessagingHosts\yomitan_api".into())
        );
        let firefox = windows.iter().find(|l| l.id == "firefox").unwrap();
        assert_eq!(
            firefox.registration,
            Registration::Registry(r"Software\Mozilla\NativeMessagingHosts\yomitan_api".into())
        );
        assert_eq!(windows.len(), 6);
    }

    #[test]
    fn inspects_an_upstream_manifest_on_macos() {
        let path = "/Users/u/Library/Application Support/Google/Chrome/NativeMessagingHosts/yomitan_api.py";
        let report = inspect_manifest(
            &location(Os::Mac, "chrome"),
            "/Users/u/Library/Application Support/Google/Chrome/NativeMessagingHosts/yomitan_api.json",
            Ok(manifest(path)),
            &ALL,
        );
        assert_eq!(report.method, Some(HostMethod::Official));
        assert_eq!(report.host_path.as_deref(), Some(path));
        assert!(report.usable());
    }

    #[test]
    fn inspects_a_kimochi_manifest_on_linux_with_its_binary_missing() {
        let report = inspect_manifest(
            &location(Os::Linux, "chromium"),
            "/home/u/.config/chromium/NativeMessagingHosts/yomitan_api.json",
            Ok(manifest("/home/u/.config/chromium/NativeMessagingHosts/yomitan-host-linux-amd64")),
            &NONE,
        );
        assert_eq!(report.method, Some(HostMethod::Kimochi));
        assert!(!report.host_exists);
        assert!(!report.usable());
        assert!(report.problem.unwrap().contains("missing"));
    }

    #[test]
    fn inspects_a_firefox_manifest() {
        let text = serde_json::json!({
            "name": "yomitan_api",
            "type": "stdio",
            "path": "/home/u/.mozilla/native-messaging-hosts/yomitan-host-linux-arm64",
            "allowed_extensions": [FIREFOX_ID]
        })
        .to_string();
        let report = inspect_manifest(
            &location(Os::Linux, "firefox"),
            "/home/u/.mozilla/native-messaging-hosts/yomitan_api.json",
            Ok(text),
            &ALL,
        );
        assert_eq!(report.method, Some(HostMethod::Kimochi));
        assert!(report.usable());
    }

    #[test]
    fn inspects_windows_manifests_with_absolute_and_relative_paths() {
        let official = inspect_manifest(
            &location(Os::Windows, "chrome"),
            r"C:\Users\u\yomitan-api\yomitan_api.json",
            Ok(manifest(r"C:\Users\u\yomitan-api\yomitan_api.bat")),
            &ALL,
        );
        assert_eq!(official.method, Some(HostMethod::Official));
        assert_eq!(official.host_path.as_deref(), Some(r"C:\Users\u\yomitan-api\yomitan_api.bat"));

        // A relative path is the manifest's folder's (Chrome and Firefox on Windows allow that).
        let relative = inspect_manifest(
            &location(Os::Windows, "edge"),
            r"C:\Users\u\AppData\Local\Kimochi\yomitan-host\yomitan_api.json",
            Ok(manifest("yomitan-host.exe")),
            &|p: &str| p == r"C:\Users\u\AppData\Local\Kimochi\yomitan-host\yomitan-host.exe",
        );
        assert_eq!(relative.method, Some(HostMethod::Kimochi));
        assert!(relative.usable());
    }

    #[test]
    fn reports_broken_manifests() {
        let loc = location(Os::Mac, "brave");
        let unreadable = inspect_manifest(&loc, "/m.json", Err("permission denied".into()), &ALL);
        assert!(unreadable.problem.unwrap().contains("permission denied"));
        assert_eq!(unreadable.method, None);

        let garbage = inspect_manifest(&loc, "/m.json", Ok("{not json".into()), &ALL);
        assert_eq!(garbage.method, None);
        assert!(garbage.problem.is_some());

        let other = inspect_manifest(&loc, "/m.json", Ok(r#"{"name":"other","path":"/x"}"#.into()), &ALL);
        assert_eq!(other.method, None);

        let no_path = inspect_manifest(&loc, "/m.json", Ok(r#"{"name":"yomitan_api"}"#.into()), &ALL);
        assert_eq!(no_path.method, None);

        // A byte-order mark (Notepad's UTF-8) is not a broken manifest.
        let bom = inspect_manifest(&loc, "/m.json", Ok(format!("\u{feff}{}", manifest("/x/yomitan_api.py"))), &ALL);
        assert_eq!(bom.method, Some(HostMethod::Official));
    }

    #[test]
    fn summary_prefers_kimochi_then_official_and_ignores_broken_ones() {
        let loc = location(Os::Mac, "chrome");
        let official = inspect_manifest(&loc, "/a.json", Ok(manifest("/a/yomitan_api.py")), &ALL);
        let kimochi = inspect_manifest(&loc, "/b.json", Ok(manifest("/b/yomitan-host-darwin-arm64")), &ALL);
        let broken = inspect_manifest(&loc, "/c.json", Ok(manifest("/c/yomitan-host-darwin-arm64")), &NONE);
        let unknown = inspect_manifest(&loc, "/d.json", Ok(manifest("/d/host")), &ALL);

        let both = summarize(Os::Mac, vec![official.clone(), kimochi.clone()]);
        assert!(both.installed);
        assert_eq!(both.method, Some(HostMethod::Kimochi));

        let upstream = summarize(Os::Mac, vec![official, broken.clone()]);
        assert_eq!(upstream.method, Some(HostMethod::Official));

        let only_broken = summarize(Os::Mac, vec![broken]);
        assert!(!only_broken.installed);
        assert_eq!(only_broken.method, None);
        assert_eq!(only_broken.browsers.len(), 1);

        assert_eq!(summarize(Os::Linux, vec![unknown]).method, Some(HostMethod::Unknown));
        let nothing = summarize(Os::Windows, vec![]);
        assert!(!nothing.installed);
        assert_eq!(nothing.os, "windows");
    }

    #[test]
    fn parses_reg_query_output() {
        let english = "\r\nHKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\yomitan_api\r\n    (Default)    REG_SZ    C:\\Users\\u\\yomitan-api\\yomitan_api.json\r\n\r\n";
        assert_eq!(parse_reg_default(english).as_deref(), Some(r"C:\Users\u\yomitan-api\yomitan_api.json"));
        let japanese = "\nHKEY_CURRENT_USER\\Software\\Mozilla\\NativeMessagingHosts\\yomitan_api\n    (既定)    REG_EXPAND_SZ    C:\\Program Files\\x\\yomitan_api.json\n";
        assert_eq!(parse_reg_default(japanese).as_deref(), Some(r"C:\Program Files\x\yomitan_api.json"));
        let unset = "\nHKEY_CURRENT_USER\\Software\\Vivaldi\\NativeMessagingHosts\\yomitan_api\n    (Default)    REG_SZ    \n";
        assert_eq!(parse_reg_default(unset), None);
        assert_eq!(parse_reg_default(""), None);
    }

    #[test]
    fn status_serializes_for_the_frontend() {
        let loc = location(Os::Mac, "firefox");
        let report = inspect_manifest(&loc, "/a.json", Ok(manifest("/a/yomitan-host-darwin-arm64")), &ALL);
        let value = serde_json::to_value(summarize(Os::Mac, vec![report])).unwrap();
        assert_eq!(value["method"], "kimochi");
        assert_eq!(value["browsers"][0]["browserName"], "Firefox");
        assert_eq!(value["browsers"][0]["hostExists"], true);
    }
}
