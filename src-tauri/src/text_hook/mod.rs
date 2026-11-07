//! The Text Hooker source: reads a game's text from inside it rather than off its pixels.
//!
//! The user picks a window as with a window source; Kimochi resolves the process behind it
//! (`process.rs`), makes sure a hooker is downloaded (`store.rs`; LunaHook first, Textractor
//! if LunaHook cannot be had or cannot attach), and runs the `kimochi-hookd` sidecar, which
//! injects the hook and reports text threads as JSON lines (`hookd/`, protocol in
//! COMMANDS.md). The sidecar runs as its own process so a crashing hook or an antivirus
//! quarantine never takes the app down.
//!
//! Of the threads the game produces, the dialogue one is chosen automatically: the thread
//! remembered for this game if one is, else the thread whose text is in the biggest block of
//! text on screen, read with the local OCR (`pick.rs`). The user can override the choice in
//! the source panel. Only the chosen thread's sentences reach the Log, as `texthook-line`
//! events taken in by the texthooker like clipboard or WebSocket text, after `clean.rs` has
//! taken out markup and applied the game's settings (Settings → Text Hooker).
//!
//! On Linux the same Windows helper and hookers hook Windows games running through Proton or
//! Wine: they run with the game's Wine, in its prefix (`wine.rs`).
pub mod clean;
pub mod pick;
pub mod process;
pub mod store;
pub mod wine;

use crate::state::Shared;
use pick::{Candidate, OcrLine, Signature};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// Engines in the order they are tried.
const ENGINES: &[&str] = &["luna", "textractor"];
/// How long after a burst the next can carry on its line (a typewriter paused for effect).
const CARRY_ON: Duration = Duration::from_secs(5);
/// Local OCR engines the thread choice can read the window with, best first after the one asked
/// for.
const OBSERVERS: &[&str] = &["oneocr", "ppocr", "meikiocr", "livetext"];
/// How long after a thread's newest text the screen is read, so the game has drawn it.
const PICK_DELAY: Duration = Duration::from_millis(700);
/// The fewest matched characters (scaled by the share of the thread they are) an automatic
/// choice accepts.
const PICK_MIN_MATCH: usize = 6;

#[derive(Debug, Clone)]
struct Thread {
    key: String,
    pid: u32,
    hookcode: String,
    name: String,
    ctx: u64,
    ctx2: u64,
    text: String,
    count: u64,
    recent: VecDeque<Instant>,
    last_at: Option<Instant>,
}

impl Thread {
    fn signature(&self) -> Signature {
        Signature::new(&self.hookcode, self.ctx, self.ctx2)
    }
    fn recent_count(&self) -> usize {
        self.recent.iter().filter(|t| t.elapsed() < Duration::from_secs(5)).count()
    }
}

#[derive(Default)]
struct Session {
    generation: u64,
    source_id: String,
    exe: Option<PathBuf>,
    /// The game's processes, as found when hooking started.
    targets: Vec<process::Target>,
    pids: Vec<u32>,
    engine: Option<&'static str>,
    phase: &'static str,
    detail: Option<String>,
    download: Option<(u64, u64)>,
    threads: Vec<Thread>,
    selected: Option<String>,
    selected_by: Option<&'static str>,
    pick_note: Option<String>,
    /// Why an earlier engine was given up for the one in use.
    fallback: Option<String>,
    pick_pending: bool,
    pick_running: bool,
    last_line: Option<String>,
    /// The id the last line was sent with: a line carried on in the next burst replaces it.
    last_id: Option<String>,
    /// Lines sent this session, for their ids.
    lines: u64,
    observer_engine: Option<String>,
    /// Hooks the hooker found in the game but could not insert (`failed_hook`): the game took the
    /// hook, yet the code its text goes through could not be patched.
    hook_failures: Vec<String>,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

struct Hook {
    app: tauri::AppHandle,
    session: Mutex<Session>,
}

static HOOK: OnceLock<Hook> = OnceLock::new();

fn hook() -> Option<&'static Hook> {
    HOOK.get()
}

pub fn install(app: &tauri::AppHandle) {
    let _ = HOOK.set(Hook { app: app.clone(), session: Mutex::new(Session { phase: "idle", ..Default::default() }) });
}

impl Hook {
    fn lock(&self) -> MutexGuard<'_, Session> {
        self.session.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn root(&self) -> Result<PathBuf, String> {
        Ok(self.app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("texthook"))
    }
    fn publish(&self, session: &Session) {
        let _ = self.app.emit("texthook-status", status_of(session));
    }
    /// The hooked game's settings, as they are now (Settings → Text Hooker).
    fn config(&self, session: &Session) -> clean::GameConfig {
        let settings = &self.app.state::<Shared>().inner().settings;
        let read = |path: &[&str]| settings.get_path(path).ok().flatten().unwrap_or(Value::Null);
        let defaults = read(&["textHookerDefaults"]);
        let game = session.exe.as_deref().map_or(Value::Null, |exe| read(&["textHookerGames", &game_key(exe)]));
        clean::GameConfig::from_settings(&defaults, &game)
    }
    /// Sends a line. One that `carries_on` the last line (the rest of a line still typing out when
    /// its burst ended) replaces it, in the Log and on the overlay.
    fn line(&self, session: &mut Session, key: &str, text: &str, carries_on: bool) {
        let Some(text) = self.config(session).clean(text) else {
            if !text.trim().is_empty() {
                crate::debug_report::trace(&self.app, json!({ "check": "texthook-dropped", "chars": text.chars().count() }));
            }
            return;
        };
        let text = text.as_str();
        if session.last_line.as_deref() == Some(text) {
            return;
        }
        session.last_line = Some(text.to_string());
        let replaces = if carries_on { session.last_id.take() } else { None };
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        // Each line has its own screenshot of the source, taken now, under the line's id (the
        // Log line's ingest id), as a scan's lines share their scan's.
        session.lines += 1;
        let id = format!("hook-{at}-{}", session.lines);
        crate::screenshots::taken(
            &self.app,
            crate::screenshots::Scan {
                id: id.clone(),
                text: text.to_string(),
                groups: Vec::new(),
                info: Some(json!({ "source_id": session.source_id, "capturedAt": at })),
                detached: false,
                picture: None,
            },
        );
        session.last_id = Some(id.clone());
        let _ = self.app.emit("texthook-line", json!({ "text": text, "key": key, "at": at, "id": id, "replaces": replaces }));
    }
}

fn status_of(session: &Session) -> Value {
    let mut threads: Vec<&Thread> = session.threads.iter().filter(|t| !t.text.is_empty()).collect();
    // Engine hooks first, then the busiest: the order a person scans for the dialogue.
    threads.sort_by_key(|t| (pick::is_generic_api_hook(&t.hookcode), std::cmp::Reverse(t.last_at)));
    let manifest = store::manifest();
    json!({
        "supported": cfg!(any(windows, target_os = "linux")),
        "phase": session.phase,
        "detail": session.detail,
        "sourceId": session.source_id,
        "exe": session.exe.as_ref().map(|e| e.to_string_lossy()),
        "pids": session.pids,
        "engine": session.engine.and_then(|id| manifest.engines.get(id).map(|e| json!({ "id": id, "name": e.name, "version": e.version }))),
        "download": session.download.map(|(done, total)| json!({ "done": done, "total": total })),
        "selected": session.selected,
        "selectedBy": session.selected_by,
        "pickNote": session.pick_note,
        "fallback": session.fallback,
        "hookFailures": session.hook_failures,
        "threads": threads.iter().map(|t| json!({
            "key": t.key,
            "name": pick::display_name(&t.hookcode, &t.name),
            "hookcode": t.hookcode,
            "preview": t.text.chars().rev().take(160).collect::<Vec<_>>().into_iter().rev().collect::<String>(),
            "count": t.count,
            "generic": pick::is_generic_api_hook(&t.hookcode),
            "selected": session.selected.as_deref() == Some(t.key.as_str()),
        })).collect::<Vec<_>>(),
    })
}

// ---------------------------------------------------------------------------- memory

/// The thread chosen per game, by exe path: `<local data>/texthook/games.json`.
fn memory_path(hook: &Hook) -> Option<PathBuf> {
    hook.root().ok().map(|r| r.join("games.json"))
}
fn game_key(exe: &std::path::Path) -> String {
    exe.to_string_lossy().to_lowercase()
}
fn remembered(hook: &Hook, exe: &std::path::Path) -> Option<Signature> {
    let text = std::fs::read_to_string(memory_path(hook)?).ok()?;
    let games: BTreeMap<String, Signature> = serde_json::from_str(&text).ok()?;
    games.get(&game_key(exe)).cloned()
}
fn remember(hook: &Hook, exe: &std::path::Path, signature: Option<Signature>) {
    let Some(path) = memory_path(hook) else { return };
    let mut games: BTreeMap<String, Signature> =
        std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    match signature {
        Some(s) => games.insert(game_key(exe), s),
        None => games.remove(&game_key(exe)),
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec_pretty(&games).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Where a game's icon is kept, taken from its window while it was hooked.
fn icon_path(hook: &Hook, exe: &std::path::Path) -> Option<PathBuf> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    game_key(exe).hash(&mut hasher);
    hook.root().ok().map(|r| r.join("icons").join(format!("{:016x}.png", hasher.finish())))
}
fn save_icon(hook: &Hook, pid: u32, exe: &std::path::Path) {
    let Some(path) = icon_path(hook, exe) else { return };
    let name = exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let identity = crate::platform::AppIdentity { name, pid: Some(pid) };
    let png = crate::platform::with_pool(|| crate::platform::app_icon_png(&identity, 128));
    if let (Some(png), Some(parent)) = (png, path.parent()) {
        let _ = std::fs::create_dir_all(parent);
        let _ = std::fs::write(&path, png);
    }
}

// ---------------------------------------------------------------------------- sidecar

fn hookd_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let name = "kimochi-hookd-x64.exe";
    let bundled = app.path().resource_dir().map(|d| d.join("hookd").join(name)).ok();
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/hookd").join(name);
    bundled
        .into_iter()
        .chain([development])
        .find(|p| p.is_file())
        .ok_or_else(|| "The text hook helper is missing from this build of Kimochi.".into())
}

fn send(session: &mut Session, command: Value) -> Result<(), String> {
    let stdin = session.stdin.as_mut().ok_or("the hook helper is not running")?;
    writeln!(stdin, "{command}").and_then(|_| stdin.flush()).map_err(|e| format!("the hook helper stopped: {e}"))
}

fn stop_child(session: &mut Session) {
    // Closing stdin asks the helper to detach from every game and exit; it is killed only if
    // it does not.
    session.stdin = None;
    if let Some(mut child) = session.child.take() {
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
            let _ = child.wait();
        });
    }
}

/// Starts the helper for `engine`, waits for it to say it is ready, and attaches to `targets`.
fn launch(hook: &'static Hook, generation: u64, engine: &'static str, dir: &std::path::Path, targets: &[process::Target]) -> Result<(), String> {
    let exe = hookd_path(&hook.app)?;
    let mut command = Command::new(&exe);
    command.arg(engine).arg("--dir").arg(dir);
    // Under Wine the helper runs in the game's prefix, so it sees the game as Windows would, and
    // takes the hooker's folder as a Windows path.
    #[cfg(target_os = "linux")]
    if let Some(wine) = targets.first().and_then(|t| t.wine.as_ref()) {
        command = wine::command(wine, &exe);
        command.arg(engine).arg("--dir").arg(wine::windows_path(dir));
    }
    if engine == "luna" {
        let flush_ms = hook.config(&hook.lock()).flush_ms;
        command.args(["--flush-ms", &flush_ms.to_string()]);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start the hook helper: {e}"))?;
    let stdout = child.stdout.take().ok_or("no output from the hook helper")?;
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || read_events(hook, generation, engine, BufReader::new(stdout), ready_tx));
    {
        let mut session = hook.lock();
        if session.generation != generation {
            let _ = child.kill();
            return Err("cancelled".into());
        }
        session.stdin = child.stdin.take();
        session.child = Some(child);
        session.engine = Some(engine);
        session.phase = "attaching";
        session.detail = None;
        hook.publish(&session);
    }
    match ready_rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("the hook helper did not start".into()),
    }
    let mut session = hook.lock();
    for target in targets {
        send(&mut session, json!({ "cmd": "attach", "pid": target.pid, "bits": target.bits }))?;
    }
    Ok(())
}

fn read_events(
    hook: &'static Hook,
    generation: u64,
    engine: &'static str,
    stdout: impl BufRead,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
) {
    let mut attach_errors = 0usize;
    for line in stdout.lines() {
        let Ok(line) = line else { break };
        let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
        let mut session = hook.lock();
        if session.generation != generation {
            return;
        }
        let str_of = |k: &str| event[k].as_str().unwrap_or_default().to_string();
        match event["event"].as_str().unwrap_or_default() {
            "ready" => {
                let _ = ready.send(Ok(()));
            }
            "error" => {
                let _ = ready.send(Err(str_of("text")));
                session.detail = Some(str_of("text"));
            }
            "attached" => {
                session.phase = "hooked";
                session.detail = None;
                // The reader's own hook codes for this game, each time it is hooked.
                if let Some(pid) = event["pid"].as_u64() {
                    for code in hook.config(&session).hook_codes {
                        let _ = send(&mut session, json!({ "cmd": "insert", "pid": pid, "code": code }));
                    }
                }
            }
            "attach_error" => {
                attach_errors += 1;
                session.detail = Some(str_of("text"));
                if attach_errors >= session.pids.len().max(1) && session.phase != "hooked" {
                    // Nothing attached: hand over to the next engine.
                    drop(session);
                    fall_back(hook, generation, engine, str_of("text"));
                    return;
                }
            }
            "thread" => {
                let key = str_of("key");
                if !session.threads.iter().any(|t| t.key == key) {
                    let hex = |k: &str| u64::from_str_radix(event[k].as_str().unwrap_or("0"), 16).unwrap_or(0);
                    session.threads.push(Thread {
                        key,
                        pid: event["pid"].as_u64().unwrap_or(0) as u32,
                        hookcode: str_of("hookcode"),
                        name: str_of("name"),
                        ctx: hex("ctx"),
                        ctx2: hex("ctx2"),
                        text: String::new(),
                        count: 0,
                        recent: VecDeque::new(),
                        last_at: None,
                    });
                }
                continue;
            }
            "info" => {
                let Some(code) = failed_hook(event["text"].as_str().unwrap_or_default()) else { continue };
                if session.hook_failures.contains(&code) || session.hook_failures.len() >= 32 {
                    continue;
                }
                crate::debug_report::trace(&hook.app, json!({ "check": "texthook-hook-failed", "hookcode": code }));
                session.hook_failures.push(code);
            }
            "thread_removed" => {
                let key = str_of("key");
                session.threads.retain(|t| t.key != key);
                if session.selected.as_deref() == Some(key.as_str()) {
                    session.selected = None;
                    session.selected_by = None;
                }
            }
            "text" => {
                on_text(hook, &mut session, &str_of("key"), &str_of("text"));
            }
            "disconnected" => {
                let pid = event["pid"].as_u64().unwrap_or(0) as u32;
                session.threads.retain(|t| t.pid != pid);
                session.pids.retain(|p| *p != pid);
                if session.pids.is_empty() {
                    session.phase = "ended";
                    session.detail = Some("The game has closed.".into());
                    stop_child(&mut session);
                }
            }
            _ => continue,
        }
        hook.publish(&session);
    }
    let _ = ready.send(Err("the hook helper exited".into()));
    let mut session = hook.lock();
    if session.generation == generation && session.phase != "ended" && session.phase != "idle" {
        session.phase = "failed";
        session.detail.get_or_insert_with(|| "The hook helper stopped.".into());
        session.child = None;
        session.stdin = None;
        hook.publish(&session);
    }
}

/// The hook code in a hooker's message that it could not insert a hook it found, as LunaHook says
/// it (`钩子注入失败 <code>`, or its English `Failed to insert hook <code>`): the hooker reached
/// the game but could not patch the code there, which a fresh start of the game often gets past
/// (the patch needs free memory near that code). `None` for any other message.
fn failed_hook(message: &str) -> Option<String> {
    let rest = message
        .strip_prefix("钩子注入失败")
        .or_else(|| {
            let lower = message.to_ascii_lowercase();
            ["failed to insert hook", "hook insert failed", "insert hook failed"]
                .iter()
                .find(|p| lower.starts_with(*p))
                .map(|p| &message[p.len()..])
        })?
        .trim_matches(|c: char| c.is_whitespace() || c == ':' || c == '：');
    Some(rest.split_whitespace().next().unwrap_or("").to_string())
}

fn on_text(hook: &'static Hook, session: &mut Session, key: &str, text: &str) {
    let Some(index) = session.threads.iter().position(|t| t.key == key) else { return };
    // A burst can hold more than one line typed out (clicking quickly): each is its own line. One
    // that pauses while typing for longer than the hooker waits comes in pieces: a piece that
    // carries on the line the last one ended on finishes that line.
    let (lines, carries_on) = {
        let thread = &session.threads[index];
        let recent = thread.last_at.is_some_and(|at| at.elapsed() < CARRY_ON);
        match recent.then(|| pick::typewriter_lines_after(&thread.text, text)).flatten() {
            Some(lines) => (lines, true),
            None => (pick::typewriter_lines(text), false),
        }
    };
    {
        let thread = &mut session.threads[index];
        thread.text = lines.last().cloned().unwrap_or_default();
        thread.count += 1;
        thread.last_at = Some(Instant::now());
        thread.recent.push_back(Instant::now());
        while thread.recent.len() > 32 {
            thread.recent.pop_front();
        }
    }
    if session.selected.as_deref() == Some(key) {
        crate::debug_report::trace(&hook.app, json!({ "check": "texthook-burst", "text": text, "lines": lines, "carriesOn": carries_on }));
        for (i, line) in lines.iter().enumerate() {
            hook.line(session, key, line, carries_on && i == 0);
        }
        return;
    }
    if session.selected.is_some() {
        return;
    }
    // A thread chosen for this game before is taken back as soon as it speaks.
    let saved = session.exe.as_deref().and_then(|exe| remembered(hook, exe));
    if saved.as_ref() == Some(&session.threads[index].signature()) {
        session.selected = Some(key.to_string());
        session.selected_by = Some("saved");
        session.pick_note = None;
        for (i, line) in lines.iter().enumerate() {
            hook.line(session, key, line, carries_on && i == 0);
        }
        return;
    }
    session.pick_pending = true;
    if !session.pick_running {
        session.pick_running = true;
        let generation = session.generation;
        std::thread::spawn(move || pick_loop(hook, generation));
    }
}

/// Reads the window while no thread is chosen and threads keep producing text.
fn pick_loop(hook: &'static Hook, generation: u64) {
    loop {
        std::thread::sleep(PICK_DELAY);
        let (source_id, observer_engine, candidates) = {
            let mut session = hook.lock();
            if session.generation != generation || session.selected.is_some() || !session.pick_pending {
                if session.generation == generation {
                    session.pick_running = false;
                }
                return;
            }
            session.pick_pending = false;
            let candidates: Vec<Thread> = session.threads.iter().filter(|t| !t.text.is_empty()).cloned().collect();
            (session.source_id.clone(), session.observer_engine.clone(), candidates)
        };
        let outcome = read_screen(hook, &source_id, observer_engine.as_deref()).map(|blocks| {
            let list: Vec<Candidate> = candidates
                .iter()
                .map(|t| Candidate { key: &t.key, hookcode: &t.hookcode, text: &t.text, recent: t.recent_count() })
                .collect();
            pick::score(&list, &blocks)
        });
        let mut session = hook.lock();
        if session.generation != generation || session.selected.is_some() {
            continue;
        }
        match outcome {
            Ok(scored) => match scored.first() {
                Some(best) if best.effective >= PICK_MIN_MATCH as f64 => {
                    let key = best.key.clone();
                    let thread = session.threads.iter().find(|t| t.key == key).cloned();
                    if let Some(thread) = thread {
                        session.selected = Some(key.clone());
                        session.selected_by = Some("auto");
                        session.pick_note = None;
                        if let Some(exe) = session.exe.clone() {
                            remember(hook, &exe, Some(thread.signature()));
                        }
                        hook.line(&mut session, &key, &thread.text, false);
                    }
                }
                _ => session.pick_note = Some("No hooked text matches the screen yet. Advance the game, or choose a thread.".into()),
            },
            Err(e) => session.pick_note = Some(format!("Could not read the window to choose a thread: {e}")),
        }
        hook.publish(&session);
    }
}

fn read_screen(hook: &Hook, source_id: &str, engine: Option<&str>) -> Result<Vec<pick::Block>, String> {
    use kimochi_capture::TextObserver;
    let service = hook.app.state::<Shared>().inner().clone();
    let frame = crate::sources::capture_whole(&service, source_id)?;
    // A panic during an earlier read leaves the engines usable; it must not end every read after.
    let mut observer = service.observer.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // The engine the page asked for (the Auto OCR watcher), else whichever local engine this
    // computer has: a hint from a page that has not loaded its capabilities yet may name an
    // engine that does not exist here.
    let mut tried = Vec::new();
    let mut read = None;
    for name in engine.into_iter().chain(OBSERVERS.iter().copied()) {
        if tried.contains(&name) {
            continue;
        }
        tried.push(name);
        observer.select(name);
        if !observer.status().supported {
            continue;
        }
        match observer.observe(&frame, Duration::from_secs(5)) {
            Ok(found) => {
                read = Some(found);
                break;
            }
            Err(e) if matches!(e.code, "unsupported" | "unavailable" | "stalled") => continue,
            Err(e) => return Err(e.message),
        }
    }
    let read = read.ok_or("no local OCR engine is ready on this computer")?;
    let lines: Vec<OcrLine> = read
        .lines
        .iter()
        .map(|l| OcrLine { text: l.text.clone(), x: l.x, y: l.y, width: l.width, height: l.height })
        .collect();
    Ok(pick::blocks(&lines))
}

/// Moves to the next engine after `failed` could not be installed, started or attached.
fn fall_back(hook: &'static Hook, generation: u64, failed: &'static str, reason: String) {
    let next = ENGINES.iter().skip_while(|e| **e != failed).nth(1).copied();
    let mut session = hook.lock();
    if session.generation != generation {
        return;
    }
    stop_child(&mut session);
    session.threads.clear();
    match next {
        Some(engine) => {
            let name = |id: &str| store::manifest().engines.get(id).map_or(id.to_string(), |e| e.name.clone());
            session.fallback = Some(format!("{} could not hook this game: {reason}", name(failed)));
            session.detail = session.fallback.clone();
            hook.publish(&session);
            drop(session);
            std::thread::spawn(move || run(hook, generation, engine));
        }
        None => {
            session.phase = "failed";
            session.detail = Some(reason);
            hook.publish(&session);
        }
    }
}

/// Installs `engine` if needed and launches it on the session's targets.
fn run(hook: &'static Hook, generation: u64, engine: &'static str) {
    let targets: Vec<process::Target> = {
        let session = hook.lock();
        if session.generation != generation {
            return;
        }
        session.targets.clone()
    };
    let result = (|| {
        let root = hook.root()?;
        let dir = match store::installed(&root, engine) {
            Some(dir) => dir,
            None => {
                {
                    let mut session = hook.lock();
                    session.phase = "downloading";
                    session.engine = Some(engine);
                    hook.publish(&session);
                }
                let fetch = store::HttpFetch::new()?;
                store::install(&fetch, &root, engine, &|done, total| {
                    let mut session = hook.lock();
                    if session.generation == generation {
                        session.download = Some((done, total));
                        hook.publish(&session);
                    }
                })?
            }
        };
        {
            let mut session = hook.lock();
            session.download = None;
        }
        launch(hook, generation, engine, &dir, &targets)
    })();
    if let Err(reason) = result {
        if reason != "cancelled" {
            fall_back(hook, generation, engine, reason);
        }
    }
}

// ---------------------------------------------------------------------------- commands

/// Which of these window sources can be hooked, and why not when one cannot.
#[tauri::command]
pub async fn texthook_targets(source_ids: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = serde_json::Map::new();
        for id in source_ids {
            let pid = kimochi_capture::SourceId::parse(&id).filter(|s| s.is_window()).and_then(|s| s.pid());
            let value = match pid.map(process::target) {
                Some(Ok(target)) => json!({ "hookable": true, "bits": target.bits, "exe": target.exe }),
                Some(Err(reason)) => json!({ "hookable": false, "reason": reason }),
                None => json!({ "hookable": false, "reason": "Only app windows can be hooked." }),
            };
            out.insert(id, value);
        }
        Value::Object(out)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Hooks the game behind window source `source_id`; replaces any earlier session.
#[tauri::command]
pub async fn texthook_start(source_id: String, observer_engine: Option<String>) -> Result<Value, String> {
    let hook = hook().ok_or("text hooking is not available")?;
    if !cfg!(any(windows, target_os = "linux")) {
        return Err("Text Hooker works on Windows and Linux.".into());
    }
    let pid = kimochi_capture::SourceId::parse(&source_id)
        .filter(|s| s.is_window())
        .and_then(|s| s.pid())
        .ok_or("Choose an app window to hook.")?;
    #[cfg(target_os = "linux")]
    let helper = hookd_path(&hook.app);
    let targets = tauri::async_runtime::spawn_blocking(move || {
        let found = process::game_processes(pid);
        if found.is_empty() {
            return Err(process::target(pid).err().unwrap_or_else(|| "This app cannot be hooked.".into()));
        }
        // Under Wine the hooker addresses the game by the prefix's process id, which only a
        // program inside the prefix can see.
        #[cfg(target_os = "linux")]
        if found[0].wine.is_some() {
            return wine::windows_targets(&helper?, &found[0]);
        }
        Ok(found)
    })
    .await
    .map_err(|e| e.to_string())??;
    let generation = {
        let mut session = hook.lock();
        stop_child(&mut session);
        let generation = session.generation + 1;
        *session = Session {
            generation,
            source_id,
            exe: targets.first().map(|t| t.exe.clone()),
            pids: targets.iter().map(|t| t.pid).collect(),
            targets: targets.clone(),
            phase: "starting",
            observer_engine,
            ..Default::default()
        };
        hook.publish(&session);
        generation
    };
    if let Some(target) = targets.first() {
        // The window's own process: under Wine the target's id is the prefix's.
        let exe = target.exe.clone();
        std::thread::spawn(move || save_icon(hook, pid, &exe));
    }
    std::thread::spawn(move || run(hook, generation, ENGINES[0]));
    Ok(status_of(&hook.lock()))
}

/// Detaches from the game and stops the helper.
#[tauri::command]
pub fn texthook_stop() -> Result<Value, String> {
    let hook = hook().ok_or("text hooking is not available")?;
    let mut session = hook.lock();
    stop_child(&mut session);
    let generation = session.generation + 1;
    *session = Session { generation, phase: "idle", ..Default::default() };
    hook.publish(&session);
    Ok(status_of(&session))
}

#[tauri::command]
pub fn texthook_status() -> Value {
    match hook() {
        Some(hook) => status_of(&hook.lock()),
        None => json!({ "supported": false, "phase": "idle", "threads": [] }),
    }
}

/// Chooses thread `key` by hand and remembers it for this game; `None` forgets the choice and
/// goes back to choosing automatically.
#[tauri::command]
pub fn texthook_select(key: Option<String>) -> Result<Value, String> {
    let hook = hook().ok_or("text hooking is not available")?;
    let mut session = hook.lock();
    let exe = session.exe.clone();
    match key {
        Some(key) => {
            let thread = session.threads.iter().find(|t| t.key == key).cloned().ok_or("That thread has gone.")?;
            session.selected = Some(key.clone());
            session.selected_by = Some("manual");
            session.pick_note = None;
            if let Some(exe) = &exe {
                remember(hook, exe, Some(thread.signature()));
            }
            hook.line(&mut session, &key, &thread.text, false);
        }
        None => {
            session.selected = None;
            session.selected_by = None;
            session.last_line = None;
            if let Some(exe) = &exe {
                remember(hook, exe, None);
            }
            session.pick_pending = true;
            if !session.pick_running {
                session.pick_running = true;
                let generation = session.generation;
                std::thread::spawn(move || pick_loop(hook, generation));
            }
        }
    }
    hook.publish(&session);
    Ok(status_of(&session))
}

/// Inserts hook code `code` into the hooked game now (the page also keeps it for the game).
#[tauri::command]
pub fn texthook_insert(code: String) -> Result<(), String> {
    let hook = hook().ok_or("text hooking is not available")?;
    let code = code.trim();
    if code.is_empty() {
        return Err("Enter a hook code.".into());
    }
    let mut session = hook.lock();
    if session.phase != "hooked" {
        return Err("No game is hooked.".into());
    }
    for pid in session.pids.clone() {
        send(&mut session, json!({ "cmd": "insert", "pid": pid, "code": code }))?;
    }
    Ok(())
}

/// The icon kept for the game at `exe`, as a data URI; null when there is none.
#[tauri::command]
pub fn texthook_game_icon(exe: String) -> Option<String> {
    use base64::Engine as _;
    let png = std::fs::read(icon_path(hook()?, std::path::Path::new(&exe))?).ok()?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
}

/// What is kept natively for the game at `exe`: the hook code of the thread remembered for it.
#[tauri::command]
pub fn texthook_game(exe: String) -> Value {
    let thread = hook().and_then(|hook| remembered(hook, std::path::Path::new(&exe)));
    json!({ "thread": thread.map(|s| s.hookcode) })
}

/// Forgets the thread remembered for the game at `exe`, and with `all` its icon too.
#[tauri::command]
pub fn texthook_forget(exe: String, all: bool) -> Result<(), String> {
    let hook = hook().ok_or("text hooking is not available")?;
    let exe = std::path::Path::new(&exe);
    remember(hook, exe, None);
    if all {
        if let Some(path) = icon_path(hook, exe) {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

/// Stops the helper when the app quits, so the game is detached cleanly.
pub fn shutdown() {
    if let Some(hook) = hook() {
        stop_child(&mut hook.lock());
    }
}

#[cfg(test)]
mod tests {
    use super::failed_hook;

    #[test]
    fn a_hook_the_hooker_could_not_insert_is_told_apart() {
        assert_eq!(
            failed_hook("钩子注入失败 EXHMXF2@Unity.TextMeshPro:TMPro:TMP_Text:set_text:1:JIT:UNITY").as_deref(),
            Some("EXHMXF2@Unity.TextMeshPro:TMPro:TMP_Text:set_text:1:JIT:UNITY")
        );
        assert_eq!(failed_hook("Failed to insert hook: HQXF1@mscorlib:System:String:Substring").as_deref(), Some("HQXF1@mscorlib:System:String:Substring"));
        assert_eq!(failed_hook("MH_ERROR_MEMORY_ALLOC"), None);
        assert_eq!(failed_hook("注入钩子: String:String: 000001DCD4B56610"), None);
        assert_eq!(failed_hook("移除钩子: String:String:"), None);
    }
}
