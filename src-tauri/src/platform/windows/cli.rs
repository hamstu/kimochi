//! Spawning the explain CLIs (`claude`, `codex`, ...): direct, windowless, PATH-resolved.
//!
//! macOS goes through `zsh -ilc` to get the user's login PATH; a Windows GUI process
//! already inherits the user's PATH from Explorer, so the program is resolved here and
//! spawned directly, with no shell in between unless the tool only exists as a script
//! shim.
use super::rules;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

/// `CREATE_NO_WINDOW`: a console program started from a GUI process would otherwise
/// flash a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Spawn `program` with `args`, stdout/stderr piped, `stdin` (if any) written and closed
/// on a helper thread, no console window.
///
/// Resolution (`rules::resolve_program`) prefers a real `.exe`/`.com` anywhere on PATH
/// over a `.cmd`/`.bat` shim, even one earlier on PATH. When a shim is all there is, it
/// is spawned by its full path and Rust's standard library runs it through `cmd.exe /c`
/// with `cmd`-aware argument escaping (the CVE-2024-24576 fix; it refuses arguments it
/// cannot escape safely rather than letting them be reinterpreted).
///
/// Known limit: killing a shim's `Child` kills `cmd.exe`, not the `node.exe` it started,
/// which keeps running until it finishes on its own. A Job Object would fix that; it is
/// not set up here because `Child` cannot carry one. The callers' prompts go through
/// stdin, so only short flag arguments ever reach `cmd.exe`.
pub fn run_cli(
    program: &str,
    args: &[&str],
    stdin: Option<&str>,
    cwd: Option<&Path>,
) -> Result<std::process::Child, String> {
    let dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let resolved = rules::resolve_program(program, &dirs, |p| p.is_file())
        .ok_or_else(|| format!("{program} was not found on PATH"))?;
    let mut command = std::process::Command::new(resolved);
    command.args(args).creation_flags(CREATE_NO_WINDOW);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    super::super::spawn_cli(command, stdin)
}
