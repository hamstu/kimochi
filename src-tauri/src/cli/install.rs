//! Settings → Command line: putting a `kimochi` command on the user's PATH that runs this app's
//! own executable in command-line mode (cli/mod.rs).
//!
//! - **macOS**: a symlink, `/usr/local/bin/kimochi` (on every shell's PATH through
//!   `/etc/paths`). That folder usually needs an administrator, so the system's password prompt
//!   is shown when it isn't writable.
//! - **Linux**: a symlink in `~/.local/bin` to the AppImage or the executable. The `.deb`'s
//!   `/usr/bin/kimochi` is already the command, so there is nothing to install.
//! - **Windows**: a `kimochi.cmd` in `%LOCALAPPDATA%\dev.kimochi.app\bin`, added to the user's
//!   PATH. Kimochi is a GUI program, which the shells don't wait for and give no console; run
//!   from a batch file it is waited for, and it attaches to that console (cli/console.rs).
//!
//! Only what this installed is ever removed: a link or shim that points at a Kimochi.
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `kimochi` runs this Kimochi.
    pub installed: bool,
    /// It came with the app's package (Linux `.deb`): nothing to install or remove.
    pub built_in: bool,
    /// A command from another copy or location is in the way (it is replaced on install).
    pub stale: bool,
    /// Where the command lives.
    pub path: Option<PathBuf>,
    /// What it runs.
    pub target: Option<PathBuf>,
    /// Whether the command's folder is on PATH (as Kimochi sees it).
    pub on_path: bool,
    /// Something to tell the reader (a folder not on PATH, open a new terminal, …).
    pub note: Option<String>,
}

fn exe() -> Result<PathBuf, String> {
    super::launch::app_executable().ok_or_else(|| "native: can't find Kimochi's executable".to_string())
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn on_path(dir: &Path) -> bool {
    std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|p| p == dir || same_file(&p, dir)))
}

/// Whether a link we might replace or remove is one of ours: a symlink to a `kimochi` binary.
#[cfg(unix)]
fn ours(link: &Path) -> bool {
    std::fs::symlink_metadata(link).is_ok_and(|m| m.file_type().is_symlink())
        && std::fs::read_link(link).is_ok_and(|target| {
            let name = target.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_lowercase();
            name == "kimochi" || name.ends_with(".appimage") && name.contains("kimochi")
        })
}

// ------------------------------------------------------------------------------ macOS & Linux

#[cfg(target_os = "macos")]
fn link_path() -> Option<PathBuf> {
    Some(PathBuf::from("/usr/local/bin/kimochi"))
}

#[cfg(target_os = "linux")]
fn link_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/bin/kimochi"))
}

/// The package's own command (`/usr/bin/kimochi` from the `.deb`), when this is it.
#[cfg(target_os = "linux")]
fn built_in() -> Option<PathBuf> {
    if std::env::var_os("APPIMAGE").is_some() {
        return None;
    }
    let exe = exe().ok()?;
    let dir = exe.parent()?;
    (exe.file_name()? == "kimochi" && dir.starts_with("/usr") && on_path(dir)).then_some(exe)
}

#[cfg(unix)]
pub fn status() -> Result<Status, String> {
    let target = exe()?;
    #[cfg(target_os = "linux")]
    if let Some(command) = built_in() {
        return Ok(Status {
            installed: true,
            built_in: true,
            stale: false,
            path: Some(command.clone()),
            target: Some(command),
            on_path: true,
            note: None,
        });
    }
    let link = link_path().ok_or("native: no home folder")?;
    let present = std::fs::symlink_metadata(&link).is_ok();
    let installed = present && same_file(&link, &target);
    let dir = link.parent().map(Path::to_path_buf).unwrap_or_default();
    let on_path = on_path(&dir);
    let note = if present && !installed && !ours(&link) {
        Some(format!("{} is another program's; Kimochi leaves it alone.", link.display()))
    } else if installed && !on_path && cfg!(target_os = "linux") {
        Some(format!("{} isn't on your PATH. Add it in your shell's profile: export PATH=\"$HOME/.local/bin:$PATH\"", dir.display()))
    } else {
        None
    };
    Ok(Status {
        installed,
        built_in: false,
        stale: present && !installed && ours(&link),
        path: Some(link),
        target: Some(target),
        on_path,
        note,
    })
}

#[cfg(unix)]
fn writable(dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else { return false };
    // SAFETY: a NUL-terminated path for the duration of the call.
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(unix)]
pub fn install() -> Result<Status, String> {
    let before = status()?;
    if before.built_in || before.installed {
        return Ok(before);
    }
    let link = before.path.clone().ok_or("native: nowhere to install")?;
    let target = before.target.clone().ok_or("native: can't find Kimochi's executable")?;
    if std::fs::symlink_metadata(&link).is_ok() && !ours(&link) {
        return Err(format!("invalid: {} already exists and isn't Kimochi's. Remove it first.", link.display()));
    }
    let dir = link.parent().ok_or("native: bad path")?;
    if cfg!(target_os = "linux") {
        std::fs::create_dir_all(dir).map_err(|e| format!("native: {}: {e}", dir.display()))?;
    }
    if writable(dir) {
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&target, &link).map_err(|e| format!("native: {}: {e}", link.display()))?;
    } else {
        privileged(&format!("mkdir -p {} && ln -sfn {} {}", sh(dir), sh(&target), sh(&link)))?;
    }
    status()
}

#[cfg(unix)]
pub fn uninstall() -> Result<Status, String> {
    let before = status()?;
    let Some(link) = before.path.clone().filter(|_| !before.built_in) else { return Ok(before) };
    if std::fs::symlink_metadata(&link).is_err() {
        return Ok(before);
    }
    if !ours(&link) {
        return Err(format!("invalid: {} isn't Kimochi's; it was left alone.", link.display()));
    }
    let dir = link.parent().unwrap_or(Path::new("/"));
    if writable(dir) {
        std::fs::remove_file(&link).map_err(|e| format!("native: {}: {e}", link.display()))?;
    } else {
        privileged(&format!("rm -f {}", sh(&link)))?;
    }
    status()
}

/// A shell word: single-quoted, with any single quote closed, escaped and reopened.
#[cfg(unix)]
fn sh(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"))
}

/// Run a shell command as an administrator, after the system's own password prompt.
#[cfg(target_os = "macos")]
fn privileged(script: &str) -> Result<(), String> {
    let quoted = script.replace('\\', "\\\\").replace('"', "\\\"");
    let output = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(format!(
            "do shell script \"{quoted}\" with prompt \"Kimochi wants to add the kimochi command to /usr/local/bin.\" with administrator privileges"
        ))
        .output()
        .map_err(|e| format!("native: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let error = String::from_utf8_lossy(&output.stderr);
    // -128: the reader pressed Cancel.
    if error.contains("-128") {
        return Err("invalid: cancelled".into());
    }
    Err(format!("native: {}", error.trim()))
}

#[cfg(target_os = "linux")]
fn privileged(_script: &str) -> Result<(), String> {
    Err("native: that folder isn't writable".into())
}

// ------------------------------------------------------------------------------ Windows

#[cfg(windows)]
fn bin_dir() -> Option<PathBuf> {
    super::endpoint::local_dir().map(|dir| dir.join("bin"))
}

#[cfg(windows)]
const SHIM_MARK: &str = "rem kimochi-cli";

/// The batch file: runs the app's executable with the same arguments and passes its exit code on.
#[cfg(windows)]
fn shim(exe: &Path) -> String {
    // `%` is the only character a batch file treats specially inside quotes.
    let exe = exe.display().to_string().replace('%', "%%");
    format!("@echo off\r\n{SHIM_MARK}: Kimochi's command line (Settings > Command line)\r\n\"{exe}\" %*\r\nexit /b %ERRORLEVEL%\r\n")
}

/// The user's own PATH, as stored (not this process's, which predates an install).
#[cfg(windows)]
fn user_path() -> String {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_ANY};
    let mut size = 0u32;
    if unsafe { RegGetValueW(HKEY_CURRENT_USER, w!("Environment"), w!("Path"), RRF_RT_ANY, None, None, Some(&mut size)) }.is_err() {
        return String::new();
    }
    let mut data = vec![0u16; (size as usize).div_ceil(2)];
    if unsafe {
        RegGetValueW(HKEY_CURRENT_USER, w!("Environment"), w!("Path"), RRF_RT_ANY, None, Some(data.as_mut_ptr().cast()), Some(&mut size))
    }
    .is_err()
    {
        return String::new();
    }
    let end = data.iter().position(|&c| c == 0).unwrap_or(data.len());
    String::from_utf16_lossy(&data[..end])
}

#[cfg(windows)]
fn path_has(path: &str, dir: &Path) -> bool {
    let dir = dir.to_string_lossy().trim_end_matches('\\').to_lowercase();
    path.split(';').any(|entry| entry.trim().trim_end_matches('\\').to_lowercase() == dir)
}

/// Add `dir` to the user's PATH or take it out, through PowerShell's registry access so the
/// stored PATH keeps its `%VARIABLES%` unexpanded, then tell running programs (a new terminal
/// sees it; one already open does not).
#[cfg(windows)]
fn set_user_path(dir: &Path, add: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$dir = $env:KIMOCHI_CLI_DIR.TrimEnd('\')
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$old = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$kept = @($old -split ';' | Where-Object { $_.Trim() -and ($_.Trim().TrimEnd('\') -ine $dir) })
if ($env:KIMOCHI_CLI_ADD -eq '1') { $kept += $dir }
$key.SetValue('Path', ($kept -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
$key.Close()
# Setting any user variable broadcasts WM_SETTINGCHANGE, so new terminals see the new PATH.
[Environment]::SetEnvironmentVariable('KIMOCHI_CLI_REFRESH', $null, 'User')
"#;
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT])
        .env("KIMOCHI_CLI_DIR", dir)
        .env("KIMOCHI_CLI_ADD", if add { "1" } else { "0" })
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("native: PowerShell: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("native: couldn't change PATH: {}", String::from_utf8_lossy(&output.stderr).trim()))
    }
}

#[cfg(windows)]
pub fn status() -> Result<Status, String> {
    let target = exe()?;
    let dir = bin_dir().ok_or("native: no local data folder")?;
    let file = dir.join("kimochi.cmd");
    let text = std::fs::read_to_string(&file).ok();
    let present = text.as_deref().is_some_and(|t| t.contains(SHIM_MARK));
    let current = text.as_deref() == Some(shim(&target).as_str());
    let on_path = path_has(&user_path(), &dir);
    let installed = current && on_path;
    // This process's PATH predates the install, as an open terminal's does.
    let note = if installed && !on_path(&dir) {
        Some("Open a new terminal to use it: one that was already open still has the old PATH.".to_string())
    } else {
        None
    };
    Ok(Status { installed, built_in: false, stale: present && !installed, path: Some(file), target: Some(target), on_path, note })
}

#[cfg(windows)]
pub fn install() -> Result<Status, String> {
    let target = exe()?;
    let dir = bin_dir().ok_or("native: no local data folder")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("native: {}: {e}", dir.display()))?;
    std::fs::write(dir.join("kimochi.cmd"), shim(&target)).map_err(|e| format!("native: {e}"))?;
    if !path_has(&user_path(), &dir) {
        set_user_path(&dir, true)?;
    }
    status()
}

#[cfg(windows)]
pub fn uninstall() -> Result<Status, String> {
    let dir = bin_dir().ok_or("native: no local data folder")?;
    let file = dir.join("kimochi.cmd");
    if std::fs::read_to_string(&file).is_ok_and(|t| t.contains(SHIM_MARK)) {
        std::fs::remove_file(&file).map_err(|e| format!("native: {e}"))?;
    }
    if path_has(&user_path(), &dir) {
        set_user_path(&dir, false)?;
    }
    let _ = std::fs::remove_dir(&dir);
    status()
}

#[cfg(not(any(unix, windows)))]
pub fn status() -> Result<Status, String> {
    Err("native: not on this system".into())
}
#[cfg(not(any(unix, windows)))]
pub fn install() -> Result<Status, String> {
    status()
}
#[cfg(not(any(unix, windows)))]
pub fn uninstall() -> Result<Status, String> {
    status()
}

// ------------------------------------------------------------------------------ commands

/// Whether the `kimochi` command is installed, and where.
#[tauri::command]
pub async fn cli_status() -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(status).await.map_err(|e| e.to_string())?
}

/// Install the `kimochi` command (macOS may show the system's administrator prompt).
#[tauri::command]
pub async fn cli_install() -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(install).await.map_err(|e| e.to_string())?
}

/// Remove the `kimochi` command, if it is Kimochi's.
#[tauri::command]
pub async fn cli_uninstall() -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(uninstall).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn shell_words_survive_quotes_and_spaces() {
        use std::path::Path;
        assert_eq!(super::sh(Path::new("/Applications/Kimochi.app")), "'/Applications/Kimochi.app'");
        assert_eq!(super::sh(Path::new("/tmp/it's here")), r"'/tmp/it'\''s here'");
    }

    #[cfg(unix)]
    #[test]
    fn only_links_to_a_kimochi_are_ours() {
        let dir = std::env::temp_dir().join(format!("kimochi-cli-links-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ours = dir.join("ours");
        let theirs = dir.join("theirs");
        let file = dir.join("file");
        std::os::unix::fs::symlink("/Applications/Kimochi.app/Contents/MacOS/kimochi", &ours).unwrap();
        std::os::unix::fs::symlink("/usr/bin/env", &theirs).unwrap();
        std::fs::write(&file, "x").unwrap();
        assert!(super::ours(&ours));
        assert!(!super::ours(&theirs));
        assert!(!super::ours(&file));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
