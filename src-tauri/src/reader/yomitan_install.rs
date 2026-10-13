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

const RELEASE_URL: &str =
    "https://github.com/hamstu/go-yomitan-native-messaging-host/releases/latest/download";

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

async fn download(asset: &str) -> Result<Vec<u8>, String> {
    let url = format!("{}/{}", RELEASE_URL, asset);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read download: {}", e))?;
    Ok(bytes.to_vec())
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
    std::fs::write(&exe, &bytes).map_err(|e| {
        format!("Could not write {} ({e}). If your browser is running the host, close the browser and try again.", exe.display())
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
        let _ = std::process::Command::new("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(temp_path)
            .output();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reader::yomitan_host::{classify_host_path, inspect_manifest, browser_locations, HostMethod, Os};

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
}
