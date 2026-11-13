//! kimochi-hookd: Kimochi's text-hook sidecar.
//!
//! It runs outside the app so a crashing hook or an antivirus quarantine can never take Kimochi
//! down, and so the same exe can later run inside a game's Wine/Proton prefix. Two builds ship:
//! x64 hosts LunaHook (`LunaHost64.dll` serves 32- and 64-bit games over per-process pipes) and
//! injects 64-bit games; i686 only injects 32-bit games (`inject`), because `LoadLibraryW`'s
//! address has to come from a process of the game's bitness.
//!
//! ```text
//! kimochi-hookd luna --dir <LunaHook dir> [--flush-ms 400] [--codepage 932]
//! kimochi-hookd textractor --dir <Textractor dir>
//! kimochi-hookd inject --pid <pid> --dll <path>
//! kimochi-hookd processes
//! ```
//! `luna` and `textractor` read JSON commands on stdin and write JSON events on stdout
//! (`protocol.rs`, documented in COMMANDS.md). Stdin closing detaches everything and exits.
//! `processes` lists the processes it can see and exits: on Linux the app runs this exe with the
//! game's own Wine, in the game's prefix, where the game's process ids are Wine's, not Linux's.
mod protocol;

#[cfg(windows)]
mod inject;
#[cfg(windows)]
mod luna;
#[cfg(windows)]
mod processes;
#[cfg(windows)]
mod textractor;

#[cfg(windows)]
pub use inject::wide;

use protocol::emit;
use serde_json::json;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match run(&args) {
        Ok(()) => 0,
        Err(e) => {
            emit("error", json!({ "text": e }));
            1
        }
    };
    std::process::exit(code);
}

#[cfg(not(windows))]
fn run(_args: &[String]) -> Result<(), String> {
    Err("kimochi-hookd runs on Windows (or inside a Wine prefix)".into())
}

/// Injects into a process of the other bitness by running the sibling build of this exe.
#[cfg(windows)]
pub fn inject_with_bits(pid: u32, bits: u32, dll: &std::path::Path) -> Result<(), String> {
    let ours = if cfg!(target_pointer_width = "64") { 64 } else { 32 };
    if bits == ours {
        return inject::inject(pid, dll);
    }
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let sibling = me.with_file_name(if bits == 32 { "kimochi-hookd-x86.exe" } else { "kimochi-hookd-x64.exe" });
    if !sibling.is_file() {
        return Err(format!("{} is missing", sibling.display()));
    }
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new(&sibling)
        .args(["inject", "--pid", &pid.to_string(), "--dll"])
        .arg(dll)
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| format!("{}: {e}", sibling.display()))?;
    if output.status.success() {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Err(text
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .find_map(|v| v["text"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("the {bits}-bit injector failed")))
}

#[cfg(windows)]
fn run(args: &[String]) -> Result<(), String> {
    use protocol::{parse_command, Command};
    use std::io::BufRead;
    use std::path::PathBuf;

    let mode = args.first().map(String::as_str).unwrap_or("");
    if mode == "inject" {
        let pid = arg(args, "--pid").and_then(|p| p.parse().ok()).ok_or("--pid is required")?;
        let dll = PathBuf::from(arg(args, "--dll").ok_or("--dll is required")?);
        inject::inject(pid, &dll)?;
        emit("injected", json!({ "pid": pid }));
        return Ok(());
    }
    if mode == "processes" {
        return processes::list();
    }
    let dir = PathBuf::from(arg(args, "--dir").ok_or("--dir is required")?);

    enum Engine {
        Luna(luna::Luna),
        Textractor(textractor::Textractor),
    }
    let mut engine = match mode {
        "luna" => {
            let flush = arg(args, "--flush-ms").and_then(|v| v.parse().ok()).unwrap_or(400);
            Engine::Luna(luna::Luna::load(&dir, flush, protocol::code_page_arg(args))?)
        }
        "textractor" => Engine::Textractor(textractor::Textractor::new(&dir)?),
        _ => {
            return Err(
                "usage: kimochi-hookd luna|textractor --dir <dir> | inject --pid <pid> --dll <path> | processes".into(),
            )
        }
    };
    // `codepage` tells the app this helper takes the `codepage` command (an older one would answer
    // it with an error); Textractor's CLI has no setting for it.
    let mut ready = json!({ "engine": mode, "version": env!("CARGO_PKG_VERSION") });
    if matches!(engine, Engine::Luna(_)) {
        ready["codepage"] = json!(protocol::code_page_arg(args));
    }
    emit("ready", ready);

    let mut attached: Vec<u32> = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let command = match parse_command(&line) {
            Ok(c) => c,
            Err(e) => {
                emit("error", json!({ "text": e }));
                continue;
            }
        };
        let result = match (&mut engine, command) {
            (_, Command::Quit) => break,
            (Engine::Luna(l), Command::Attach { pid, bits, pc_hooks }) => {
                attached.push(pid);
                l.attach(pid, bits, pc_hooks).map_err(|e| (pid, e))
            }
            (Engine::Textractor(t), Command::Attach { pid, bits, .. }) => {
                attached.push(pid);
                t.attach(pid, bits).map_err(|e| (pid, e))
            }
            (Engine::Luna(l), Command::Detach { pid }) => {
                attached.retain(|p| *p != pid);
                l.detach(pid).map_err(|e| (pid, e))
            }
            (Engine::Textractor(t), Command::Detach { pid }) => {
                attached.retain(|p| *p != pid);
                t.detach(pid).map_err(|e| (pid, e))
            }
            (Engine::Luna(l), Command::Insert { pid, code }) => l.insert(pid, &code).map_err(|e| (pid, e)),
            (Engine::Textractor(t), Command::Insert { pid, code }) => t.insert(pid, &code).map_err(|e| (pid, e)),
            (Engine::Luna(l), Command::PcHooks { pid }) => l.pc_hooks(pid).map_err(|e| (pid, e)),
            (Engine::Textractor(_), Command::PcHooks { .. }) => Ok(()),
            (Engine::Luna(l), Command::CodePage { codepage }) => {
                // Not an attach failure: the text keeps coming in the code page it had.
                if let Err(e) = l.settings(codepage) {
                    emit("info", json!({ "level": "warning", "text": format!("code page {codepage}: {e}") }));
                }
                Ok(())
            }
            (Engine::Textractor(_), Command::CodePage { .. }) => Ok(()),
        };
        if let Err((pid, e)) = result {
            emit("attach_error", json!({ "pid": pid, "text": e }));
        }
    }
    for pid in attached {
        match &mut engine {
            Engine::Luna(l) => {
                let _ = l.detach(pid);
            }
            Engine::Textractor(t) => {
                let _ = t.detach(pid);
            }
        }
    }
    // Give the hook DLLs a moment to receive the detach before the pipes close.
    std::thread::sleep(std::time::Duration::from_millis(300));
    Ok(())
}
