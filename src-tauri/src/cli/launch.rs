//! Finding the app's own executable, and starting the app from the command line.
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// The executable the `kimochi` command should run, and the app to start: the AppImage on
/// Linux (this process runs from its temporary mount, which is gone once it exits), otherwise
/// this executable, symlinks resolved.
pub fn app_executable() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    if let Some(image) = std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|p| p.is_absolute() && p.is_file()) {
        return Some(image);
    }
    let exe = std::env::current_exe().ok()?;
    Some(plain(std::fs::canonicalize(&exe).unwrap_or(exe)))
}

/// Windows' `canonicalize` gives `\\?\C:\…` paths; the shim, the shell and the reader want
/// `C:\…`. A UNC path (`\\?\UNC\…`) is left as it is.
fn plain(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|p| p.strip_prefix(r"\\?\")) {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_drive_paths_become_plain() {
        assert_eq!(plain(PathBuf::from(r"\\?\C:\Kimochi\kimochi.exe")), PathBuf::from(r"C:\Kimochi\kimochi.exe"));
        assert_eq!(plain(PathBuf::from(r"\\?\UNC\server\share\k.exe")), PathBuf::from(r"\\?\UNC\server\share\k.exe"));
        assert_eq!(plain(PathBuf::from("/usr/bin/kimochi")), PathBuf::from("/usr/bin/kimochi"));
    }
}

/// The `.app` bundle this executable is inside, if any (a development build has none).
#[cfg(target_os = "macos")]
pub fn bundle() -> Option<PathBuf> {
    let exe = app_executable()?;
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.ends_with("MacOS") && contents.ends_with("Contents") && bundle.extension().is_some_and(|e| e == "app"))
        .then(|| bundle.to_path_buf())
}

/// Start the app, detached from this terminal: it keeps running after the command ends, and
/// Ctrl+C or closing the terminal does not reach it.
pub fn start_app() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if let Some(bundle) = bundle() {
        // Through Launch Services, as a double-click would: the app is not this shell's child.
        let status = Command::new("/usr/bin/open")
            .arg(&bundle)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;
        return if status.success() { Ok(()) } else { Err(format!("`open {}` failed", bundle.display())) };
    }
    let exe = app_executable().ok_or("can't find Kimochi's executable")?;
    let mut command = Command::new(&exe);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid only detaches the child from this terminal's session; it allocates
        // nothing and is async-signal-safe.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn().map(|_| ()).map_err(|e| format!("{}: {e}", exe.display()))
}
