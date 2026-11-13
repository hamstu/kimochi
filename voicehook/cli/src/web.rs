//! `voicehook web`: captures an NW.js game (RPG Maker MV/MZ, TyranoScript, other HTML5 engines)
//! by injecting `web.js` into its pages through the manifest's `inject_js_end`.
//!
//! Most shipped NW.js games are "normal" builds, with remote debugging (CDP) compiled out, so a
//! script in the page is the way in. NW.js pages have Node, so the script writes the capture
//! (events.jsonl + clips/) itself, in the native hook's format.
//!
//! The game's package.json is backed up to `package.json.voicehook-bak`, patched, and restored
//! when the game exits (or by `voicehook web --restore <game>` after a crash).
use serde_json::Value;
use std::path::{Path, PathBuf};

const SCRIPT: &str = include_str!("web.js");
const SCRIPT_NAME: &str = "voicehook-web.js";
const BACKUP: &str = "package.json.voicehook-bak";

fn app_dir(target: &Path) -> Result<PathBuf, String> {
    let dir =
        if target.is_dir() { target.to_path_buf() } else { target.parent().map(Path::to_path_buf).unwrap_or_default() };
    if !dir.join("package.json").exists() {
        return Err(format!("{}: no package.json (not an NW.js app)", dir.display()));
    }
    Ok(dir)
}

/// Puts the original package.json back and removes our script. Ok(true) if there was a backup.
pub fn restore(dir: &Path) -> Result<bool, String> {
    let backup = dir.join(BACKUP);
    if !backup.exists() {
        return Ok(false);
    }
    std::fs::copy(&backup, dir.join("package.json")).map_err(|e| format!("restoring package.json: {e}"))?;
    std::fs::remove_file(&backup).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(dir.join(SCRIPT_NAME));
    Ok(true)
}

fn install(dir: &Path, out: &Path) -> Result<(), String> {
    if restore(dir)? {
        println!("voicehook: restored package.json left patched by an earlier run");
    }
    let pkg_path = dir.join("package.json");
    let text = std::fs::read_to_string(&pkg_path).map_err(|e| format!("{}: {e}", pkg_path.display()))?;
    let mut pkg: Value =
        serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("package.json: {e}"))?;
    if let Some(existing) = pkg.get("inject_js_end").and_then(Value::as_str) {
        return Err(format!("package.json already injects {existing}; not touching it"));
    }
    std::fs::copy(&pkg_path, dir.join(BACKUP)).map_err(|e| format!("backing up package.json: {e}"))?;
    let out_js = out.display().to_string().replace('\\', "\\\\").replace('\'', "\\'");
    std::fs::write(dir.join(SCRIPT_NAME), SCRIPT.replace("__VOICEHOOK_OUT__", &out_js)).map_err(|e| e.to_string())?;
    pkg["inject_js_end"] = Value::String(SCRIPT_NAME.into());
    std::fs::write(&pkg_path, serde_json::to_string_pretty(&pkg).unwrap()).map_err(|e| e.to_string())?;
    Ok(())
}

/// `voicehook web [--out DIR] [--restore] <Game.exe | app dir> [args...]`
pub fn run(args: &[String], default_out: impl FnOnce(&str) -> PathBuf) -> Result<Option<PathBuf>, String> {
    let mut out: Option<PathBuf> = None;
    let mut only_restore = false;
    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "--out" => {
                out = args.get(i + 1).map(PathBuf::from);
                i += 2;
            }
            "--restore" => {
                only_restore = true;
                i += 1;
            }
            _ => break,
        }
    }
    let target = PathBuf::from(
        args.get(i).ok_or("usage: voicehook web [--out DIR] [--restore] <Game.exe | app dir> [args...]")?,
    );
    let base =
        if target.is_dir() { target.clone() } else { target.parent().map(Path::to_path_buf).unwrap_or_default() };
    if !base.join("package.json").exists()
        && (base.join("resources").join("app.asar").exists() || base.join("resources").join("app").is_dir())
    {
        return electron(&target, &base, &args[i + 1..], out, default_out).map(Some);
    }
    let dir = app_dir(&target)?;
    if only_restore {
        println!("voicehook: {}", if restore(&dir)? { "package.json restored" } else { "nothing to restore" });
        return Ok(None);
    }
    let exe = if target.is_file() {
        target.clone()
    } else {
        ["Game.exe", "nw.exe", "game.exe"]
            .iter()
            .map(|n| dir.join(n))
            .find(|p| p.exists())
            .ok_or("no Game.exe/nw.exe in the app folder; pass the exe")?
    };
    let stem = exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "game".into());
    let out = out.unwrap_or_else(|| default_out(&stem));
    std::fs::create_dir_all(out.join("clips")).map_err(|e| format!("{}: {e}", out.display()))?;
    let out = std::fs::canonicalize(&out)
        .map(|p| PathBuf::from(p.to_string_lossy().trim_start_matches(r"\\?\")))
        .unwrap_or(out);
    std::fs::write(
        out.join("voicehook.log"),
        format!("voicehook web: {} (script injected via package.json inject_js_end)\n", exe.display()),
    )
    .map_err(|e| e.to_string())?;
    let start = serde_json::json!({"ev": "start", "exe": exe.display().to_string(), "pid": 0, "bits": 0, "adapter": "web",
        "t": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)});
    std::fs::write(out.join("events.jsonl"), format!("{start}\n")).map_err(|e| e.to_string())?;
    install(&dir, &out)?;
    println!(
        "voicehook: {} patched (backup {BACKUP}); capturing to\n  {}",
        dir.join("package.json").display(),
        out.display()
    );
    let status = std::process::Command::new(&exe).args(&args[i + 1..]).current_dir(&dir).status();
    // NW.js keeps helper processes for a moment; the manifest is only read at start anyway.
    let restored = restore(&dir);
    match (&status, &restored) {
        (_, Err(e)) => eprintln!("voicehook: {e} (run `voicehook web --restore` on the game)"),
        _ => println!("voicehook: package.json restored"),
    }
    status.map_err(|e| format!("{}: {e}", exe.display()))?;
    Ok(Some(out))
}

fn new_capture(exe: &Path, out: PathBuf, how: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(out.join("clips")).map_err(|e| format!("{}: {e}", out.display()))?;
    let out = std::fs::canonicalize(&out)
        .map(|p| PathBuf::from(p.to_string_lossy().trim_start_matches(r"\\?\")))
        .unwrap_or(out);
    std::fs::write(out.join("voicehook.log"), format!("voicehook web: {} ({how})\n", exe.display()))
        .map_err(|e| e.to_string())?;
    let start = serde_json::json!({"ev": "start", "exe": exe.display().to_string(), "pid": 0, "bits": 0, "adapter": "web",
        "t": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)});
    std::fs::write(out.join("events.jsonl"), format!("{start}\n")).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Electron games (app.asar): started with a DevTools port, `web.js` put into every page over
/// CDP. Needs Node in the page (TyranoScript's Electron builds have it), as the script writes the
/// capture itself.
fn electron(
    target: &Path,
    dir: &Path,
    extra: &[String],
    out: Option<PathBuf>,
    default_out: impl FnOnce(&str) -> PathBuf,
) -> Result<PathBuf, String> {
    let exe = if target.is_file() {
        target.to_path_buf()
    } else {
        std::fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .find(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")))
            .ok_or("no exe in the app folder; pass it")?
    };
    let stem = exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "game".into());
    let out = new_capture(&exe, out.unwrap_or_else(|| default_out(&stem)), "Electron, script injected over CDP")?;
    let port = 9300 + (std::process::id() % 600) as u16;
    let mut child = std::process::Command::new(&exe)
        .arg(format!("--remote-debugging-port={port}"))
        .args(extra)
        .current_dir(dir)
        .spawn()
        .map_err(|e| format!("{}: {e}", exe.display()))?;
    println!("voicehook: {} (Electron) on DevTools port {port}; capturing to\n  {}", exe.display(), out.display());
    let out_js = out.display().to_string().replace('\\', "\\\\").replace('\'', "\\'");
    let script = SCRIPT.replace("__VOICEHOOK_OUT__", &out_js);
    match crate::cdp::pages(port, std::time::Duration::from_secs(30)) {
        Ok(pages) => {
            for url in pages {
                let r = (|| -> Result<String, String> {
                    let mut ws = crate::cdp::Ws::connect(&url)?;
                    let node = ws.call(
                        "Runtime.evaluate",
                        serde_json::json!({"expression": "typeof require", "returnByValue": true}),
                    )?;
                    ws.call("Page.addScriptToEvaluateOnNewDocument", serde_json::json!({"source": script}))?;
                    ws.call("Runtime.evaluate", serde_json::json!({"expression": script}))?;
                    Ok(node["result"]["value"].as_str().unwrap_or("?").to_string())
                })();
                match r {
                    Ok(node) if node == "function" => println!("voicehook: script injected into {url}"),
                    Ok(node) => eprintln!("voicehook: injected, but the page has no Node (typeof require = {node}); nothing will be written"),
                    Err(e) => eprintln!("voicehook: {url}: {e}"),
                }
            }
        }
        Err(e) => eprintln!("voicehook: {e}"),
    }
    let _ = child.wait();
    Ok(out)
}
