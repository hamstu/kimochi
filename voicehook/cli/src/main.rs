//! voicehook: start or attach to a game with the voice hook in it, and summarise a capture.
//!
//! ```text
//! voicehook launch [--out DIR] [--no-wait] <game.exe> [game args...]
//! voicehook attach <pid | exe name>
//! voicehook report <capture dir>
//! voicehook ps [name]
//! voicehook web [--out DIR] [--restore] <Game.exe | app dir> [args...]   (NW.js games)
//! ```
//! The x64 build (`voicehook.exe`) and the x86 build (`voicehook32.exe`) sit side by side with
//! `voicehook_x64.dll` and `voicehook_x86.dll`; each hands a target of the other bitness to
//! its sibling.
mod cdp;
mod inject;
mod web;

use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use windows_sys::Win32::System::SystemInformation::GetLocalTime;
use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};

const ME_64: bool = cfg!(target_pointer_width = "64");

fn usage() -> ExitCode {
    eprintln!(
        "voicehook {}\n\n  voicehook launch [--out DIR] [--no-wait] <game.exe> [game args...]\n  voicehook attach <pid | exe name>\n  voicehook report <capture dir>\n  voicehook ps [name]\n  voicehook web [--out DIR] [--restore] <Game.exe | app dir> [args...]   (NW.js: RPG Maker MV/MZ, TyranoScript...)",
        env!("CARGO_PKG_VERSION")
    );
    ExitCode::from(2)
}

fn here() -> PathBuf {
    std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default()
}

fn dll_for(x64: bool) -> PathBuf {
    here().join(if x64 { "voicehook_x64.dll" } else { "voicehook_x86.dll" })
}

/// Runs the sibling build (other bitness) with the same arguments.
fn delegate(args: &[String]) -> ExitCode {
    let sibling = here().join(if ME_64 { "voicehook32.exe" } else { "voicehook.exe" });
    if !sibling.exists() {
        eprintln!("voicehook: the target needs {}, which is missing", sibling.display());
        return ExitCode::FAILURE;
    }
    match std::process::Command::new(&sibling).args(&args[1..]).status() {
        Ok(s) => ExitCode::from(s.code().unwrap_or(1) as u8),
        Err(e) => {
            eprintln!("voicehook: cannot run {}: {e}", sibling.display());
            ExitCode::FAILURE
        }
    }
}

fn stamp() -> String {
    let mut t = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut t) };
    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let Some(cmd) = args.get(1) else { return usage() };
    let result = match cmd.as_str() {
        "launch" => return launch(&args),
        "attach" => return attach(&args),
        "web" => match web::run(&args, |stem| here().join("captures").join(format!("{stem}_web_{}", stamp()))) {
            Ok(Some(out)) => report(&out),
            Ok(None) => Ok(()),
            Err(e) => Err(e),
        },
        "report" => match args.get(2) {
            Some(dir) => report(Path::new(dir)),
            None => return usage(),
        },
        "ps" => {
            for (pid, exe) in inject::find_processes(args.get(2).map_or("", String::as_str)) {
                let bits = match inject::is_x86_process(pid) {
                    Ok(true) => "x86",
                    Ok(false) => "x64",
                    Err(_) => "?",
                };
                println!("{pid:>7}  {bits:<3}  {exe}");
            }
            Ok(())
        }
        _ => return usage(),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("voicehook: {e}");
            ExitCode::FAILURE
        }
    }
}

fn launch(args: &[String]) -> ExitCode {
    let mut out: Option<PathBuf> = None;
    let mut wait = true;
    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "--out" => {
                out = args.get(i + 1).map(PathBuf::from);
                i += 2;
            }
            "--no-wait" => {
                wait = false;
                i += 1;
            }
            _ => break,
        }
    }
    let Some(exe) = args.get(i) else { return usage() };
    let exe = match std::fs::canonicalize(exe) {
        Ok(p) => PathBuf::from(p.to_string_lossy().trim_start_matches(r"\\?\")),
        Err(e) => {
            eprintln!("voicehook: {exe}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let machine = match inject::pe_machine(&exe) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("voicehook: {e}");
            return ExitCode::FAILURE;
        }
    };
    let x64 = match machine {
        0x8664 => true,
        0x14c => false,
        m => {
            eprintln!("voicehook: {} is built for machine {m:#x}; only x86 and x64 games are supported", exe.display());
            return ExitCode::FAILURE;
        }
    };
    if x64 != ME_64 {
        return delegate(args);
    }
    let dll = dll_for(x64);
    if !dll.exists() {
        eprintln!("voicehook: {} is missing", dll.display());
        return ExitCode::FAILURE;
    }
    let stem = exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "game".into());
    let out = out.unwrap_or_else(|| here().join("captures").join(format!("{stem}_{}", stamp())));
    if let Err(e) = std::fs::create_dir_all(&out) {
        eprintln!("voicehook: cannot create {}: {e}", out.display());
        return ExitCode::FAILURE;
    }
    let out = std::fs::canonicalize(&out)
        .map(|p| PathBuf::from(p.to_string_lossy().trim_start_matches(r"\\?\")))
        .unwrap_or(out);
    // Inherited by the game: where the hook writes.
    std::env::set_var("VOICEHOOK_OUT", &out);
    let (process, pid) = match inject::launch(&exe, &args[i + 1..], &dll) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("voicehook: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!(
        "voicehook: {} running as pid {pid} ({}-bit), capturing to\n  {}",
        exe.display(),
        if x64 { 64 } else { 32 },
        out.display()
    );
    if !wait {
        return ExitCode::SUCCESS;
    }
    println!("voicehook: waiting for the game to exit (Ctrl+C leaves it running; `voicehook report` the folder later)");
    let mut code = 0u32;
    unsafe {
        WaitForSingleObject(process.0, INFINITE);
        GetExitCodeProcess(process.0, &mut code);
    }
    println!("voicehook: the game exited ({code})\n");
    if let Err(e) = report(&out) {
        eprintln!("voicehook: {e}");
    }
    ExitCode::SUCCESS
}

fn attach(args: &[String]) -> ExitCode {
    let Some(target) = args.get(2) else { return usage() };
    let pid = match target.parse::<u32>() {
        Ok(pid) => pid,
        Err(_) => {
            let found = inject::find_processes(target);
            match found.as_slice() {
                [] => {
                    eprintln!("voicehook: no process named {target}");
                    return ExitCode::FAILURE;
                }
                [(pid, _)] => *pid,
                many => {
                    eprintln!("voicehook: several processes named {target}; pass a pid:");
                    for (pid, exe) in many {
                        eprintln!("  {pid}  {exe}");
                    }
                    return ExitCode::FAILURE;
                }
            }
        }
    };
    let x86 = match inject::is_x86_process(pid) {
        Ok(x) => x,
        Err(e) => {
            eprintln!("voicehook: {e}");
            return ExitCode::FAILURE;
        }
    };
    if x86 == ME_64 {
        return delegate(args);
    }
    let dll = dll_for(!x86);
    let process = match inject::open_process(pid) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("voicehook: {e}");
            return ExitCode::FAILURE;
        }
    };
    let ready = inject::ready_event(pid);
    if let Err(e) = inject::inject(process.0, pid, &dll) {
        eprintln!("voicehook: {e}");
        return ExitCode::FAILURE;
    }
    unsafe { WaitForSingleObject(ready.0, 15_000) };
    println!(
        "voicehook: hooked pid {pid}; captures go to {}\\captures\\<exe>_{pid}_<time> (voicehook.log there says what was hooked)",
        here().display()
    );
    ExitCode::SUCCESS
}

#[derive(Default)]
struct StreamSum {
    api: String,
    fmt: String,
    info: String,
    clips: Vec<(f64, f64, bool)>, // (start, dur, looping) of audible clips
    silent: usize,
    replays: usize,
    data_events: usize,
}

fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

/// Summarises a capture: what loaded, which streams there were, and every audible clip.
fn report(dir: &Path) -> Result<(), String> {
    let path = dir.join("events.jsonl");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let events: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let t0 = events.first().and_then(|e| e["t"].as_f64()).unwrap_or(0.0);
    let mut streams: BTreeMap<u64, StreamSum> = BTreeMap::new();
    let mut clips = Vec::new();
    println!("capture: {}", dir.display());
    for e in &events {
        let s = e["s"].as_u64().unwrap_or(0);
        match e["ev"].as_str().unwrap_or("") {
            "start" => println!("process: {} ({}-bit)", e["exe"].as_str().unwrap_or("?"), e["bits"]),
            "modules" => {
                let list: Vec<&str> =
                    e["audio"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                println!(
                    "{} {}",
                    if e["first"].as_bool() == Some(true) { "audio-ish modules at start:" } else { "loaded later:" },
                    list.join(", ")
                );
            }
            "stream" => {
                let st = streams.entry(s).or_default();
                st.api = e["api"].as_str().unwrap_or("?").into();
                st.fmt = e["fmt"].as_str().unwrap_or("?").into();
                st.info = e["info"].to_string();
            }
            "data" => streams.entry(s).or_default().data_events += 1,
            "replay" => streams.entry(s).or_default().replays += 1,
            "clip" => {
                let st = streams.entry(s).or_default();
                let start = e["start"].as_f64().unwrap_or(t0);
                let dur = e["dur"].as_f64().unwrap_or(0.0);
                if e["silent"].as_bool() == Some(true) {
                    st.silent += 1;
                } else {
                    st.clips.push((start, dur, e["looping"].as_bool() == Some(true)));
                    clips.push(e.clone());
                }
            }
            _ => {}
        }
    }
    println!("\nstreams ({}):", streams.len());
    println!(
        "  {:>4}  {:<10} {:<22} {:>5} {:>6} {:>8} {:>8} {:>5} {:>7}",
        "id", "api", "format", "clips", "silent", "total s", "median s", "loop", "replays"
    );
    for (id, st) in &streams {
        if st.clips.is_empty() && st.silent == 0 && st.data_events == 0 {
            continue;
        }
        let total: f64 = st.clips.iter().map(|c| c.1).sum();
        let mut durs: Vec<f64> = st.clips.iter().map(|c| c.1).collect();
        let looping = st.clips.iter().any(|c| c.2);
        println!(
            "  {:>4}  {:<10} {:<22} {:>5} {:>6} {:>8.1} {:>8.2} {:>5} {:>7}",
            id,
            st.api,
            st.fmt,
            st.clips.len(),
            st.silent,
            total,
            median(&mut durs),
            if looping { "yes" } else { "" },
            st.replays
        );
    }
    clips.sort_by(|a, b| a["start"].as_f64().partial_cmp(&b["start"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
    println!("\naudible clips ({}), by start time:", clips.len());
    for c in clips.iter().take(400) {
        println!(
            "  {:>8.2}s  s{:<4} {:<10} {:>6.2}s  peak {:.2}  {:<8} {}{}",
            (c["start"].as_f64().unwrap_or(t0) - t0) / 1000.0,
            c["s"],
            c["api"].as_str().unwrap_or("?"),
            c["dur"].as_f64().unwrap_or(0.0),
            c["peak"].as_f64().unwrap_or(0.0),
            c["why"].as_str().unwrap_or(""),
            c["file"].as_str().unwrap_or("-"),
            if c["looping"].as_bool() == Some(true) { "  (looping)" } else { "" }
        );
    }
    if clips.len() > 400 {
        println!("  ... {} more in events.jsonl", clips.len() - 400);
    }
    Ok(())
}
