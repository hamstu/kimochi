// yomitan_install.rs — downloads and installs the local yomitan-api binary
// (Go-based native messaging host). Ported from anki-remote-mining's
// install_yomitan_native_host command.

use std::time::Duration;

const RELEASE_URL: &str =
    "https://github.com/hamstu/go-yomitan-native-messaging-host/releases/latest/download";

#[tauri::command]
pub async fn install_yomitan_native_host() -> Result<String, String> {
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
    let asset_name = format!("yomitan-host-{}-{}{}", os_name, arch_name, ext);
    let url = format!("{}/{}", RELEASE_URL, asset_name);

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
        return Err(format!(
            "Download failed with status: {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read download: {}", e))?;

    let temp_path = std::env::temp_dir().join(&asset_name);
    std::fs::write(&temp_path, &bytes).map_err(|e| format!("Failed to write binary: {}", e))?;

    // Make executable on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to set permissions: {}", e))?;
    }

    // Remove macOS quarantine attribute so the binary can run.
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(&temp_path)
            .output();
    }

    let output = std::process::Command::new(&temp_path)
        .arg("install")
        .output()
        .map_err(|e| format!("Failed to run installer: {}", e))?;

    // Clean up the temp file regardless of success.
    let _ = std::fs::remove_file(&temp_path);

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(format!(
            "Install failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}
