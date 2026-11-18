// yomitan_install.rs — downloads and installs the Yomitan API native-messaging host Kimochi
// prefers: the Go port (hamstu/go-yomitan-native-messaging-host). Ported from anki-remote-mining's
// install_yomitan_native_host command.
//
// macOS and Linux: the downloaded binary's own `install` copies itself into every browser's
// NativeMessagingHosts folder and writes `yomitan_api.json` beside it, so the temporary download
// can go. Windows: the binary's installer writes one manifest next to itself and no registry
// keys, so Kimochi does that part: the binary is kept in Kimochi's local data folder, with a
// Chromium manifest and a Firefox manifest beside it, and each browser's
// `HKCU\Software\<browser>\NativeMessagingHosts\yomitan_api` key names the right one.
//
// This is the only code that writes native-messaging registrations, and only when the user asks
// (the Yomitan API setup's Install button). Detection is `yomitan_host.rs`.

use super::yomitan_host::{windows_keys, CHROME_ORIGIN, FIREFOX_ID, HOST_NAME};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The helper version this Kimochi installs, and updates an older Kimochi helper to. v3 relays
/// requests concurrently (a slow one, like an audio download, no longer holds up the others) and
/// says what it is (`yomitan-host version`, and `/serverVersion`'s `host`/`hostVersion`).
pub const HOST_VERSION: &str = "v3";
const RELEASE_URL: &str = "https://github.com/hamstu/go-yomitan-native-messaging-host/releases/download";

/// sha256 of each `HOST_VERSION` asset (the release's `SHA256SUMS`). A download must match, and an
/// installed Kimochi helper whose program matches none of these is an older version.
const HOST_SHA256: &[(&str, &str)] = &[
    ("yomitan-host-darwin-amd64", "e862e6e307b598a8ae7ce542c6c4bcb490868ca0c5e7170caaa4295f846a9d0f"),
    ("yomitan-host-darwin-arm64", "5bf6572ab3bf2c80118c1284514d08a5b95c3bece7d9462412448da9b42edb88"),
    ("yomitan-host-linux-386", "55904806e568727547f29687add6d8fe27400a51cc1bf58a200f97f2511bef9a"),
    ("yomitan-host-linux-amd64", "c954f51d138877be5a6ecda5284340dd48cb5e5997f96754f15e42047af6cdc6"),
    ("yomitan-host-linux-arm", "6771e0d9c32fc0183cccb930df2973a4de95aa8403b4ea08653cc128856bb300"),
    ("yomitan-host-linux-arm64", "45fa13303003bd2f6166b9b17b3fb1a19b93216f6141b8ced1dd65139bc41a70"),
    ("yomitan-host-windows-386.exe", "b96fd96abfc44c159946ca2d292068d69474eea51ef508d30acc01afac7b5905"),
    ("yomitan-host-windows-amd64.exe", "68f4c4416b48c61ebd50b60df454ea0fa236b6df8888f405d6e0998afd1a926d"),
    ("yomitan-host-windows-arm64.exe", "337a77ba3a52e09992833d2466a299ca7f48aacb1920b7b41557817c9d9f4f2d"),
];

fn pinned_sha256(asset: &str) -> Option<&'static str> {
    HOST_SHA256.iter().find(|(name, _)| *name == asset).map(|(_, hash)| *hash)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether the program at `path` is this Kimochi's helper version, by its sha256 against this
/// platform's pinned asset; None when it cannot be read or nothing is pinned for this platform.
/// Hashed once per (path, size, modified time): status checks ask every few seconds.
pub fn is_current(path: &Path) -> Option<bool> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    type Seen = Mutex<HashMap<PathBuf, (u64, std::time::SystemTime, bool)>>;
    static SEEN: OnceLock<Seen> = OnceLock::new();
    let expected = pinned_sha256(&asset_name().ok()?)?;
    let meta = std::fs::metadata(path).ok()?;
    let (len, modified) = (meta.len(), meta.modified().ok()?);
    let seen = SEEN.get_or_init(Default::default);
    if let Some((l, m, current)) = seen.lock().ok()?.get(path) {
        if *l == len && *m == modified {
            return Some(*current);
        }
    }
    let current = sha256_hex(&std::fs::read(path).ok()?) == expected;
    seen.lock().ok()?.insert(path.to_path_buf(), (len, modified, current));
    Some(current)
}

/// The release asset for this OS and architecture.
fn asset_name() -> Result<String, String> {
    let os_name = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        other => return Err(format!("Unsupported OS: {}", other)),
    };
    let arch_name = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "x86" => "386",
        "arm" => "arm",
        other => return Err(format!("Unsupported architecture: {}", other)),
    };
    let ext = if os_name == "windows" { ".exe" } else { "" };
    Ok(format!("yomitan-host-{}-{}{}", os_name, arch_name, ext))
}

/// From Kimochi's mirror first, then GitHub (`download_mirror`); either must match the pin.
async fn download(asset: &str) -> Result<Vec<u8>, String> {
    let url = format!("{RELEASE_URL}/{HOST_VERSION}/{asset}");
    let Some(expected) = pinned_sha256(asset) else {
        return Err(format!("Kimochi has no {HOST_VERSION} helper for this computer ({asset})."));
    };
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    let mut error = String::new();
    for source in crate::download_mirror::sources(&url, expected) {
        let attempt = async {
            let response = client.get(&source).send().await.map_err(|e| format!("Download failed: {}", e))?;
            if !response.status().is_success() {
                return Err(format!("Download failed with status: {}", response.status()));
            }
            let bytes = response.bytes().await.map_err(|e| format!("Failed to read download: {}", e))?;
            if sha256_hex(&bytes) != expected {
                return Err(format!(
                    "The downloaded helper ({asset}) is not the {HOST_VERSION} release Kimochi expects."
                ));
            }
            Ok(bytes.to_vec())
        };
        match attempt.await {
            Ok(bytes) => return Ok(bytes),
            Err(e) => {
                eprintln!("kimochi: Yomitan API helper from {}: {e}", crate::download_mirror::host_of(&source));
                error = e;
            }
        }
    }
    Err(error)
}

/// A native-messaging manifest for `host`: Chromium browsers allow origins, Firefox extension ids.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn manifest_json(firefox: bool, host: &Path) -> String {
    let mut manifest = serde_json::json!({
        "name": HOST_NAME,
        "description": "Yomitan API",
        "type": "stdio",
        "path": host.to_string_lossy(),
    });
    if firefox {
        manifest["allowed_extensions"] = serde_json::json!([FIREFOX_ID]);
    } else {
        manifest["allowed_origins"] = serde_json::json!([CHROME_ORIGIN]);
    }
    serde_json::to_string_pretty(&manifest).expect("manifest")
}

/// The Windows layout under `dir`: the binary, and `(HKCU subkey, manifest)` for each browser.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_layout(dir: &Path) -> (PathBuf, PathBuf, PathBuf, Vec<(String, PathBuf)>) {
    let exe = dir.join("yomitan-host.exe");
    let chromium = dir.join(format!("{HOST_NAME}.json"));
    let firefox = dir.join(format!("{HOST_NAME}_firefox.json"));
    let keys = windows_keys()
        .into_iter()
        .map(|(id, _, key)| (key, if id == "firefox" { firefox.clone() } else { chromium.clone() }))
        .collect();
    (exe, chromium, firefox, keys)
}

#[cfg(windows)]
async fn install(app: &tauri::AppHandle, bytes: Vec<u8>) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    use tauri::Manager;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Could not find Kimochi's data folder: {e}"))?
        .join("yomitan-host");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let (exe, chromium, firefox, keys) = windows_layout(&dir);
    replace_running(&exe, &bytes).map_err(|e| {
        format!(
            "Could not write {} ({e}). If your browser is running the host, close the browser and try again.",
            exe.display()
        )
    })?;
    std::fs::write(&chromium, manifest_json(false, &exe)).map_err(|e| format!("Could not write the manifest: {e}"))?;
    std::fs::write(&firefox, manifest_json(true, &exe)).map_err(|e| format!("Could not write the manifest: {e}"))?;
    let mut lines = vec![format!("Host installed to {}", exe.display())];
    for (key, manifest) in keys {
        let output = std::process::Command::new("reg")
            .args(["add", &format!(r"HKCU\{key}"), "/ve", "/t", "REG_SZ", "/d"])
            .arg(&manifest)
            .arg("/f")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Could not run reg.exe: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "Could not register the host under HKCU\\{key}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        lines.push(format!("Registered HKCU\\{key}"));
    }
    Ok(lines.join("\n"))
}

/// Puts `bytes` at `exe` even while the browser runs the old program there: Windows will not
/// overwrite a running program but lets it be renamed, so the old one moves aside (`.old`, removed
/// on the next install) and the new one is renamed into place. The browser starts the new one the
/// next time it starts the helper.
#[cfg_attr(not(windows), allow(dead_code))]
fn replace_running(exe: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let fresh = exe.with_extension("exe.new");
    let old = exe.with_extension("exe.old");
    let _ = std::fs::remove_file(&old);
    std::fs::write(&fresh, bytes)?;
    if exe.exists() {
        if let Err(error) = std::fs::rename(exe, &old) {
            let _ = std::fs::remove_file(&fresh);
            return Err(error);
        }
    }
    std::fs::rename(&fresh, exe)
}

#[cfg(not(windows))]
async fn install(_app: &tauri::AppHandle, bytes: Vec<u8>) -> Result<String, String> {
    let asset = asset_name()?;
    // A folder of our own, so a stale file of the same name elsewhere in temp is never run.
    let temp_dir = std::env::temp_dir().join(format!("kimochi-yomitan-host-{}", std::process::id()));
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create a temporary folder: {}", e))?;
    let temp_path = temp_dir.join(&asset);
    let result = run_unix_installer(&temp_path, &bytes);
    // Clean up regardless of success: the installer copied the binary where browsers look.
    let _ = std::fs::remove_dir_all(&temp_dir);
    result
}

#[cfg(not(windows))]
fn run_unix_installer(temp_path: &Path, bytes: &[u8]) -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(temp_path, bytes).map_err(|e| format!("Failed to write binary: {}", e))?;
    std::fs::set_permissions(temp_path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("Failed to set permissions: {}", e))?;

    // Remove macOS quarantine attribute so the binary can run.
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("xattr").args(["-d", "com.apple.quarantine"]).arg(temp_path).output();
    }

    let output = std::process::Command::new(temp_path)
        .arg("install")
        .output()
        .map_err(|e| format!("Failed to run installer: {}", e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(format!("Install failed: {}", String::from_utf8_lossy(&output.stderr)))
    }
}

#[tauri::command]
pub async fn install_yomitan_native_host(app: tauri::AppHandle) -> Result<String, String> {
    let asset = asset_name()?;
    let bytes = download(&asset).await?;
    install(&app, bytes).await
}

/// At startup: a Kimochi helper older than `HOST_VERSION` registered in any browser is replaced
/// with `HOST_VERSION`, quietly (it is Kimochi's own program, installed when the user asked for
/// it). The browser keeps running the old one until it next starts the helper. Other helpers are
/// left alone: the Yomitan API setup recommends Kimochi's instead.
pub fn update_if_outdated(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Out of the way of startup.
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        let Ok(status) = tauri::async_runtime::spawn_blocking(super::yomitan_host::detect).await else { return };
        if !status.kimochi_outdated {
            return;
        }
        match install_yomitan_native_host(app).await {
            Ok(_) => eprintln!("kimochi: updated the Yomitan API helper to {HOST_VERSION}"),
            Err(error) => eprintln!("kimochi: could not update the Yomitan API helper: {error}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reader::yomitan_host::{browser_locations, classify_host_path, inspect_manifest, HostMethod, Os};

    #[test]
    fn manifests_match_what_detection_accepts() {
        let exe = Path::new("/x/yomitan-host.exe");
        let chrome: serde_json::Value = serde_json::from_str(&manifest_json(false, exe)).unwrap();
        assert_eq!(chrome["allowed_origins"][0], CHROME_ORIGIN);
        assert!(chrome.get("allowed_extensions").is_none());
        let firefox: serde_json::Value = serde_json::from_str(&manifest_json(true, exe)).unwrap();
        assert_eq!(firefox["allowed_extensions"][0], FIREFOX_ID);

        let location = browser_locations(Os::Windows, Path::new("/")).remove(0);
        let report = inspect_manifest(&location, "/x/yomitan_api.json", Ok(manifest_json(false, exe)), &|_| true);
        assert_eq!(report.method, Some(HostMethod::Kimochi));
    }

    #[test]
    fn windows_layout_points_firefox_at_its_own_manifest() {
        let (exe, chromium, firefox, keys) = windows_layout(Path::new("/data/yomitan-host"));
        assert_eq!(classify_host_path(&exe.to_string_lossy()), HostMethod::Kimochi);
        assert_eq!(keys.len(), 6);
        for (key, manifest) in keys {
            if key.starts_with(r"Software\Mozilla\") {
                assert_eq!(manifest, firefox);
            } else {
                assert_eq!(manifest, chromium);
            }
            assert!(key.ends_with(r"\NativeMessagingHosts\yomitan_api"));
        }
    }

    /// The helper is replaced while the old program is still there (on Windows, still running):
    /// the old one moves aside, the new one takes its name, and the next install clears the old.
    #[test]
    fn a_helper_is_replaced_in_place() {
        let dir = std::env::temp_dir().join(format!("kimochi-replace-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("yomitan-host.exe");
        replace_running(&exe, b"v2").unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"v2");
        replace_running(&exe, b"v3").unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"v3");
        assert_eq!(std::fs::read(exe.with_extension("exe.old")).unwrap(), b"v2");
        assert!(!exe.with_extension("exe.new").exists());
        replace_running(&exe, b"v4").unwrap();
        assert_eq!(std::fs::read(exe.with_extension("exe.old")).unwrap(), b"v3", "the older .old is gone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every platform Kimochi asks for has a pinned hash, so downloads are verified everywhere.
    #[test]
    fn every_asset_kimochi_asks_for_is_pinned() {
        for asset in [
            "yomitan-host-darwin-arm64",
            "yomitan-host-darwin-amd64",
            "yomitan-host-linux-amd64",
            "yomitan-host-linux-arm64",
            "yomitan-host-windows-amd64.exe",
            "yomitan-host-windows-arm64.exe",
        ] {
            let hash = pinned_sha256(asset).unwrap_or_else(|| panic!("{asset} is not pinned"));
            assert_eq!(hash.len(), 64);
        }
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
