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
mod unity;
pub mod wine;

use crate::language::Language;
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
/// How soon after a row of the text box the next row can join it: this, and the time the row
/// takes to type out at ten characters a second.
const JOIN_BASE: Duration = Duration::from_millis(300);
const JOIN_PER_CHAR: Duration = Duration::from_millis(100);
/// Local OCR engines the thread choice can read the window with, best first after the one asked
/// for.
const OBSERVERS: &[&str] = &["oneocr", "ppocr", "meikiocr", "livetext"];
/// How long after a thread's newest text the screen is read, so the game has drawn it.
const PICK_DELAY: Duration = Duration::from_millis(700);
/// The fewest matched characters (scaled by the share of the thread they are) an automatic
/// choice accepts.
const PICK_MIN_MATCH: usize = 6;
/// How old an IL2CPP game must be before the hooker attaches to it.
const IL2CPP_STARTUP: Duration = Duration::from_secs(20);
/// Pieces in a row of a glyph or two after which a chosen thread is taken as drawing glyphs.
const GLYPHS: u32 = 3;
/// Lines from other engine threads, with the chosen one silent, after which the screen is read again.
const MISSED_LINES: u32 = 3;

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
    /// Of those, pieces that held script codes (`clean::strip_codes`): a thread that mixes them in
    /// with the dialogue is a worse choice than one that sends the dialogue alone.
    noisy: u64,
    /// Pieces in a row of a character or two: a text object per glyph (Unity CatSystem draws its
    /// line one TextMeshPro object per character), not a line.
    glyphs: u32,
    recent: VecDeque<Instant>,
    last_at: Option<Instant>,
    /// Some text it carried read as the language being read (`pick::looks_japanese`; the name is
    /// from when that was always Japanese). Sticky: the hook menu lists the thread from then on,
    /// even while it carries other text.
    japanese: bool,
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
    /// Lines other threads have sent since the chosen one last spoke, and the last of them.
    missed: u32,
    missed_text: String,
    pick_note: Option<String>,
    /// Why an earlier engine was given up for the one in use.
    fallback: Option<String>,
    pick_pending: bool,
    pick_running: bool,
    last_line: Option<String>,
    /// The id the last line was sent with: a line carried on in the next burst replaces it.
    last_id: Option<String>,
    /// The thread the last line came from, and when it was sent: a piece that carries on its
    /// sentence soon after is joined to it.
    last_key: Option<String>,
    last_sent: Option<Instant>,
    /// How long the last piece sent was (a row of the text box, when the game sends rows).
    last_piece_chars: usize,
    /// Lines sent this session, for their ids.
    lines: u64,
    observer_engine: Option<String>,
    /// Hooks the hooker found in the game but could not insert (`failed_hook`): the game took the
    /// hook, yet the code its text goes through could not be patched.
    hook_failures: Vec<String>,
    /// The Unity text requests (`unity.rs`), once the hooker could not hook a Unity game's text.
    unity: Vec<unity::Request>,
    /// When the text being handled was set in the game (Unix ms), for a source that says.
    text_at: Option<u64>,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    /// The code page the helper decodes ANSI text with, when it can be changed while it runs (a
    /// LunaHook helper whose `ready` said so); None for Textractor and an older helper.
    code_page: Option<u32>,
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
    /// Whether the Log takes the hooked text: the reader's Text hooking switch (the Log's input
    /// is the hooked game). Off, the game stays hooked, so turning it back on is instant.
    fn reading_text(&self) -> bool {
        self.app.try_state::<Shared>().is_none_or(|service| {
            service.settings.get_path(&["superTexthooker", "inputSource"]).ok().flatten().is_none_or(|value| value == json!("hook"))
        })
    }

    fn lock(&self) -> MutexGuard<'_, Session> {
        self.session.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn root(&self) -> Result<PathBuf, String> {
        Ok(self.app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("texthook"))
    }
    fn publish(&self, session: &Session) {
        let _ = self.app.emit("texthook-status", status_of(session));
    }
    /// The language being read (the `language` setting); Japanese before the app is up.
    fn language(&self) -> &'static Language {
        self.app.try_state::<Shared>().map_or_else(|| crate::language::get("ja"), |service| crate::language::current(&service.settings))
    }
    /// The hooked game's settings, as they are now (Settings → Text Hooker).
    fn config(&self, session: &Session) -> clean::GameConfig {
        let settings = &self.app.state::<Shared>().inner().settings;
        let read = |path: &[&str]| settings.get_path(path).ok().flatten().unwrap_or(Value::Null);
        let defaults = read(&["textHookerDefaults"]);
        let game = session.exe.as_deref().map_or(Value::Null, |exe| read(&["textHookerGames", &game_key(exe)]));
        clean::GameConfig::from_settings(&defaults, &game, self.language())
    }
    /// Sends a line. One that `carries_on` the last line (the rest of a line still typing out when
    /// its burst ended) replaces it, in the Log and on the overlay. So does a piece that carries on
    /// the sentence the last line from this thread left unfinished, soon after it: games that send
    /// their text box a row at a time (SiglusEngine, at each line break and ruby) are joined back
    /// up, unless the game's settings say not to.
    fn line(&self, session: &mut Session, key: &str, text: &str, carries_on: bool) {
        // Text hooking turned off for now: the game stays hooked, but its lines go nowhere, and
        // the next line sent once it is back on starts afresh rather than carrying on one the Log
        // never had.
        if !self.reading_text() {
            session.last_key = None;
            session.last_line = None;
            session.last_id = None;
            return;
        }
        let config = self.config(session);
        let Some(mut text) = config.clean(text) else {
            if !text.trim().is_empty() {
                crate::debug_report::trace(&self.app, json!({ "check": "texthook-dropped", "chars": text.chars().count() }));
            }
            return;
        };
        if session.last_line.as_deref() == Some(text.as_str()) {
            return;
        }
        let mut carries_on = carries_on;
        // The next row comes once the row before has typed out: soon after a short row, later
        // after a long one, even at a slow text speed (ten characters a second). A line the reader
        // clicked on to comes later than that.
        let window = (JOIN_BASE + JOIN_PER_CHAR * session.last_piece_chars as u32).min(CARRY_ON);
        // Rows are joined for engines that hand over a row at a time, never for a Unity text box,
        // which is set whole.
        let recent = session.last_key.as_deref() == Some(key)
            && session.last_sent.is_some_and(|at| at.elapsed() < window)
            && !session.threads.iter().any(|t| t.key == key && unity::is_unity(&t.hookcode));
        let piece_chars = text.chars().count();
        if !carries_on && config.join_lines && recent {
            if let Some(before) = session.last_line.as_deref() {
                // A language that spaces its words has a space between the rows (they come trimmed).
                let joined = if config.spaces { format!("{before} {text}") } else { format!("{before}{text}") };
                if clean::continues_in(before, &text, config.japanese) && !before.ends_with(&text) && joined.chars().count() <= config.max_chars {
                    crate::debug_report::trace(&self.app, json!({ "check": "texthook-joined", "before": before, "piece": text }));
                    text = joined;
                    carries_on = true;
                }
            }
        }
        let text = text.as_str();
        session.last_key = Some(key.to_string());
        session.last_sent = Some(Instant::now());
        session.last_piece_chars = piece_chars;
        session.last_line = Some(text.to_string());
        let replaces = if carries_on { session.last_id.take() } else { None };
        // When the game set the text, if the source says (the Unity text, timed by the DLL on the
        // clock its voice clips are timed by); else now.
        let at = session.text_at.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        });
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
    // Engine hooks first, then in the order the hooker found them. Not by the latest text: with
    // several threads busy, every line reordered the open menu under the pointer.
    threads.sort_by_key(|t| pick::is_generic(&t.hookcode, &t.name));
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
        "unityText": !session.unity.is_empty(),
        "threads": threads.iter().map(|t| json!({
            "key": t.key,
            "name": pick::display_name(&t.hookcode, &t.name),
            "hookcode": t.hookcode,
            "preview": t.text.chars().rev().take(160).collect::<Vec<_>>().into_iter().rev().collect::<String>(),
            "count": t.count,
            "japanese": t.japanese,
            "generic": pick::is_generic(&t.hookcode, &t.name),
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
    // takes the hooker's folder as a Windows path; both copied where the game can reach them,
    // for a game in a sandbox that does not see Kimochi's folders.
    #[cfg(target_os = "linux")]
    if let Some(wine) = targets.first().and_then(|t| t.wine.as_ref()) {
        command = wine::command(wine, &wine::reachable(wine, &exe)?);
        command.arg(engine).arg("--dir").arg(wine::windows_path(&wine::reachable_dir(wine, dir)?));
    }
    if engine == "luna" {
        let flush_ms = hook.config(&hook.lock()).flush_ms;
        command.args(["--flush-ms", &flush_ms.to_string()]);
        // The language's ANSI code page for a game's multibyte text (932 for Japanese, as
        // always); a helper from before languages ignores it and stays on 932.
        command.args(["--codepage", &crate::language::hook_code_page(hook.language()).to_string()]);
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
                session.code_page = event["codepage"].as_u64().and_then(|c| u32::try_from(c).ok());
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
                        noisy: 0,
                        glyphs: 0,
                        recent: VecDeque::new(),
                        last_at: None,
                        japanese: false,
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
                if unity::is_unity_failure(&code) && session.unity.is_empty() {
                    read_unity_text(hook, &mut session, false);
                }
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
                session.targets.retain(|p| p.pid != pid);
                if session.pids.is_empty() {
                    session.phase = "ended";
                    session.detail = Some("The game has closed.".into());
                    stop_child(&mut session);
                }
            }
            _ => continue,
        }
        hook.publish(&session);
        let disconnected = event["event"] == "disconnected";
        drop(session);
        if disconnected { refresh_voice_hook(); }
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

/// The voice hook DLL reads this Unity game's text (`unity.rs`). With `then_hooker`, the text
/// hooker starts once the DLL is watching the text (or has said it cannot), so that the DLL's
/// breakpoint is in before the hooker patches the same function: a hooker that patches it after
/// copies the breakpoint along, which the DLL follows; one that patched it first leaves the DLL
/// out.
fn read_unity_text(hook: &'static Hook, session: &mut Session, then_hooker: bool) {
    let mut then_hooker = then_hooker;
    for target in session.targets.clone() {
        let start_hooker = std::mem::take(&mut then_hooker);
        let generation = session.generation;
        let request = match unity::request(target.pid) {
            Ok(r) => r,
            Err(e) => {
                // With no request made, `texthook_start` starts the hooker itself.
                crate::debug_report::trace(&hook.app, json!({ "check": "texthook-unity-text", "ok": false, "error": e }));
                continue;
            }
        };
        session.unity.push(request);
        crate::debug_report::trace(&hook.app, json!({ "check": "texthook-unity-text", "ok": true, "pid": target.pid }));
        let app = hook.app.clone();
        std::thread::spawn(move || {
            // Usually in already, for sentence audio; loading it again is harmless.
            let injected = inject_voice_dll(&app, &target);
            if start_hooker {
                if injected.is_ok() {
                    let watching = unity::wait_for_watch(&crate::sentence_audio::voice_hook::base_dir(), target.pid, Duration::from_secs(10));
                    crate::debug_report::trace(&app, json!({ "check": "texthook-unity-text", "watch": watching }));
                }
                std::thread::spawn(move || run(hook, generation, ENGINES[0]));
            }
            if let Err(e) = injected {
                crate::debug_report::trace(&app, json!({ "check": "texthook-unity-text", "ok": false, "error": e }));
                return;
            }
            unity::follow(hook, generation, target.pid);
        });
    }
}

fn on_text(hook: &'static Hook, session: &mut Session, key: &str, text: &str) {
    let language = hook.language();
    let Some(index) = session.threads.iter().position(|t| t.key == key) else { return };
    // A line drawn several times over (CatSystem2) is the line once.
    let collapsed = pick::collapse_repeated_sentences(text, language);
    let text = collapsed.as_str();
    // A burst can hold more than one line typed out (clicking quickly): each is its own line. One
    // that pauses while typing for longer than the hooker waits comes in pieces: a piece that
    // carries on the line the last one ended on finishes that line.
    let (lines, carries_on) = {
        let thread = &session.threads[index];
        let recent = thread.last_at.is_some_and(|at| at.elapsed() < CARRY_ON);
        // A Unity text object's text arrives settled, the whole text box (`unity::Settle`): one line,
        // never frames of a typewriter to take apart.
        if unity::is_unity(&thread.hookcode) {
            // One that extends the object's last carries it on, however late: a typewriter paused
            // for longer than it takes to settle (live Unity: 9 s between the pieces).
            let carries_on = !thread.text.is_empty() && text != thread.text && text.starts_with(thread.text.as_str());
            (vec![text.to_string()], carries_on)
        } else {
            match recent.then(|| pick::typewriter_lines_after(&thread.text, text)).flatten() {
                Some(lines) => (lines, true),
                None => (pick::typewriter_lines(text), false),
            }
        }
    };
    {
        let thread = &mut session.threads[index];
        thread.text = lines.last().cloned().unwrap_or_default();
        thread.japanese |= pick::looks_japanese(&thread.text, language);
        thread.count += 1;
        thread.noisy += u64::from(clean::has_codes(text));
        thread.glyphs = if pick::normalize(text).chars().count() <= 2 { thread.glyphs.saturating_add(1) } else { 0 };
        thread.last_at = Some(Instant::now());
        thread.recent.push_back(Instant::now());
        while thread.recent.len() > 32 {
            thread.recent.pop_front();
        }
    }
    if let Some(better) = cleaner_thread(session, index, language) {
        crate::debug_report::trace(&hook.app, json!({ "check": "texthook-reselected", "from": session.selected, "to": better }));
        let thread = session.threads.iter().find(|t| t.key == better).cloned();
        if let Some(thread) = thread {
            if let Some(exe) = session.exe.clone() {
                remember(hook, &exe, Some(thread.signature()));
            }
            // The line already sent stays; the next rows of it come from the new thread.
            if session.last_key == session.selected {
                session.last_key = Some(better.clone());
            }
            session.selected = Some(better);
            session.selected_by = Some("auto");
            hook.publish(session);
        }
        if session.selected.as_deref() != Some(key) {
            return;
        }
    }
    if session.selected.as_deref() == Some(key) {
        crate::debug_report::trace(&hook.app, json!({ "check": "texthook-burst", "text": text, "lines": lines, "carriesOn": carries_on }));
        session.missed = 0;
        for (i, line) in lines.iter().enumerate() {
            hook.line(session, key, line, carries_on && i == 0);
        }
        return;
    }
    // Another engine thread sending a line while the chosen one says nothing: each line once, however
    // many threads send it and however many pieces it is typed out in.
    {
        let spoken = &session.threads[index];
        let shown = pick::normalize(text);
        if pick::another_line(&session.missed_text, &shown, PICK_MIN_MATCH * pick::letter_scale(language), language) && !pick::is_generic(&spoken.hookcode, &spoken.name) {
            session.missed = session.missed.saturating_add(1);
            session.missed_text = shown;
        }
    }
    // A thread chosen automatically that has said one thing only and nothing since (a menu drawn
    // once, the largest text on screen when it was read), while this one keeps speaking; or one
    // that has missed the last few lines other threads sent (a hook that starts a thread per line,
    // as Majiro's does beside the one that keeps going): the screen is read again.
    if session.selected_by == Some("auto") && (session.threads[index].count >= 3 || session.missed >= MISSED_LINES) {
        let stale = session
            .threads
            .iter()
            .find(|t| session.selected.as_deref() == Some(t.key.as_str()))
            .is_some_and(|t| (t.count <= 1 && t.last_at.is_some_and(|at| at.elapsed() > Duration::from_secs(10))) || session.missed >= MISSED_LINES);
        if stale {
            session.missed = 0;
            crate::debug_report::trace(&hook.app, json!({ "check": "texthook-repick", "from": session.selected }));
            session.selected = None;
            session.selected_by = None;
            hook.publish(session);
        }
    }
    if session.selected.is_some() {
        return;
    }
    // A thread chosen for this game before is taken back as soon as it speaks.
    let saved = session.exe.as_deref().and_then(|exe| remembered(hook, exe));
    if unity::remembers_by_signature(&session.threads[index].hookcode) && saved.as_ref() == Some(&session.threads[index].signature()) {
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

/// A thread to take over from the chosen one, now that thread `index` has spoken: the chosen one
/// (picked automatically or remembered, never by hand) keeps mixing script codes in with its
/// text, and another engine thread that has never sent one sends most of that same text.
/// SiglusEngine sends its dialogue through several threads, one of them with the script's asset
/// names, its speakers' names and its ruby readings in it; when the screen is read they show the
/// same line, and which is chosen is down to chance.
fn cleaner_thread(session: &Session, index: usize, language: &Language) -> Option<String> {
    let selected = session.selected.as_deref()?;
    if session.selected_by == Some("manual") {
        return None;
    }
    let chosen = session.threads.iter().find(|t| t.key == selected)?;
    // A text object that showed the line once and has shown a glyph at a time since: a thread
    // showing whole lines takes over.
    let spoken = &session.threads[index];
    if chosen.glyphs >= GLYPHS && spoken.key != selected && spoken.count >= 3 && spoken.glyphs == 0 && !pick::is_generic(&spoken.hookcode, &spoken.name) {
        let text = pick::normalize(&spoken.text);
        if text.chars().count() >= PICK_MIN_MATCH * pick::letter_scale(language) && pick::reads_as(&text, language) {
            return Some(spoken.key.clone());
        }
    }
    // A Unity text object showing what the chosen hooker thread has: the object is set when the
    // line is shown, the hooker's string functions whenever the game handles the string.
    if !unity::is_unity(&chosen.hookcode) && !chosen.text.is_empty() {
        let text = pick::normalize(&chosen.text);
        if let Some(unity) = session.threads.iter().find(|t| unity::is_unity(&t.hookcode) && t.count >= 2 && pick::normalize(&t.text) == text) {
            return Some(unity.key.clone());
        }
    }
    if chosen.noisy < 2 || chosen.noisy * 5 < chosen.count {
        return None;
    }
    let shown = pick::normalize(&clean::strip_codes(&chosen.text));
    let spoken = &session.threads[index];
    let others: Vec<&Thread> = if spoken.key == selected { session.threads.iter().collect() } else { vec![spoken] };
    others
        .into_iter()
        .filter(|t| t.key != selected && t.noisy == 0 && t.count >= 3 && !pick::is_generic(&t.hookcode, &t.name))
        .find(|t| {
            let text = pick::normalize(&t.text);
            let length = text.chars().count();
            length >= 4 * pick::letter_scale(language)
                && pick::reads_as(&text, language)
                && 10 * length >= 7 * shown.chars().count()
                && shown.contains(&text)
        })
        .map(|t| t.key.clone())
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
            // Text hooking off for now: the window is not read until it is back on.
            if !hook.reading_text() {
                continue;
            }
            session.pick_pending = false;
            // A Unity text object that has said one thing only is likely a label (a button, a
            // menu): it says the same thing again and again, and is never sent twice.
            // And the hooker's thread with the same text as a Unity text object is left to the
            // object: the object is set when the line is shown, the hooker's string functions
            // whenever the game handles the string.
            let unity_texts: Vec<&str> = session.threads.iter().filter(|t| unity::is_unity(&t.hookcode) && t.count >= 2).map(|t| t.text.as_str()).collect();
            let candidates: Vec<Thread> = session
                .threads
                .iter()
                .filter(|t| !t.text.is_empty() && (!unity::is_unity(&t.hookcode) || t.count >= 2))
                .filter(|t| unity::is_unity(&t.hookcode) || !unity_texts.contains(&t.text.as_str()))
                .cloned()
                .collect();
            (session.source_id.clone(), session.observer_engine.clone(), candidates)
        };
        let outcome = read_screen(hook, &source_id, observer_engine.as_deref()).map(|blocks| {
            let list: Vec<Candidate> = candidates
                .iter()
                .map(|t| Candidate { key: &t.key, hookcode: &t.hookcode, name: &t.name, text: &t.text, recent: t.recent_count(), count: t.count, noise: t.noisy as f64 / t.count.max(1) as f64 })
                .collect();
            pick::score(&list, &blocks, hook.language())
        });
        let mut session = hook.lock();
        if session.generation != generation || session.selected.is_some() {
            continue;
        }
        match outcome {
            Ok(scored) => match pick::chosen(&scored, PICK_MIN_MATCH as f64, hook.language()) {
                Some(best) => {
                    let key = best.key.clone();
                    let thread = session.threads.iter().find(|t| t.key == key).cloned();
                    if let Some(thread) = thread {
                        session.selected = Some(key.clone());
                        session.selected_by = Some("auto");
                        session.pick_note = None;
                        // A generic thread won only because nothing better showed the line yet:
                        // the screen is read again next time, not this one taken back.
                        if let Some(exe) = session.exe.clone().filter(|_| !pick::is_generic(&thread.hookcode, &thread.name)) {
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
    // Only engines that read the language; Screen AI last for a language other than Japanese,
    // which no engine of `OBSERVERS` may read off macOS and Windows.
    let language = hook.language();
    let others = (!language.is_japanese()).then_some("screenai");
    let mut tried = Vec::new();
    let mut read = None;
    for name in engine.into_iter().chain(OBSERVERS.iter().copied()).chain(others) {
        if tried.contains(&name) || !crate::language::engine_supports(name, &language.code) {
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

/// The process behind a window source: in its id, or for a window shared through the Wayland
/// portal (which names none) the one KWin or Hyprland linked the stream to. A portal window is
/// linked once its first frames arrive, so it becomes hookable then.
fn window_pid(source_id: &str) -> Option<u32> {
    let id = kimochi_capture::SourceId::parse(source_id).filter(|s| s.is_window())?;
    if let Some(pid) = id.pid() {
        return Some(pid);
    }
    #[cfg(target_os = "linux")]
    if source_id.starts_with("portal:window:") {
        return crate::platform::tracking::linked_pid(source_id);
    }
    None
}

/// Which of these window sources can be hooked, and why not when one cannot.
#[tauri::command]
pub async fn texthook_targets(source_ids: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = serde_json::Map::new();
        for id in source_ids {
            let pid = window_pid(&id);
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

/// A session in this phase is hooking its game, or has: starting it again would only interrupt it.
fn keeps_going(phase: &str) -> bool {
    matches!(phase, "starting" | "downloading" | "attaching" | "hooked")
}

/// Hooks the game behind window source `source_id`; replaces any earlier session, unless it is
/// one hooking the same game.
#[tauri::command]
pub async fn texthook_start(source_id: String, observer_engine: Option<String>) -> Result<Value, String> {
    let hook = hook().ok_or("text hooking is not available")?;
    if !cfg!(any(windows, target_os = "linux")) {
        return Err("Text Hooker works on Windows and Linux.".into());
    }
    let pid = window_pid(&source_id).ok_or("Choose an app window to hook.")?;
    #[cfg(target_os = "linux")]
    let helper = hookd_path(&hook.app);
    let found = tauri::async_runtime::spawn_blocking(move || {
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
    .map_err(|e| e.to_string())
    .and_then(|found| found);
    let targets = match found {
        Ok(targets) => targets,
        Err(reason) => {
            // The game's card waits on a session for its window: one that failed, with why, rather
            // than none (which reads as still starting).
            let mut session = hook.lock();
            stop_child(&mut session);
            let generation = session.generation + 1;
            *session = Session { generation, source_id, phase: "failed", detail: Some(reason.clone()), ..Default::default() };
            hook.publish(&session);
            drop(session);
            refresh_voice_hook();
            return Err(reason);
        }
    };
    let generation = {
        let mut session = hook.lock();
        // The same game, already being hooked or hooked (the game started with Hook automatically
        // on, and the reader turned Text hooking on too): that session goes on. Stopping it while
        // it attaches leaves the hooker's DLL in the game with no host, which then never reconnects.
        let pids: Vec<u32> = targets.iter().map(|t| t.pid).collect();
        if session.source_id == source_id && session.pids == pids && keeps_going(session.phase) {
            session.observer_engine = observer_engine.or(session.observer_engine.take());
            return Ok(status_of(&session));
        }
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
        // A Unity (Mono) game's text is read by the voice hook DLL too, from the start: the
        // hooker reaches it, when it can, through string functions that run at all times for
        // all sorts of strings, which tell little of when a line is shown (`unity.rs`).
        if cfg!(windows) && targets.iter().any(|t| t.wine.is_none() && unity::is_mono_game(&t.exe)) {
            read_unity_text(hook, &mut session, true);
        }
        hook.publish(&session);
        generation
    };
    refresh_voice_hook();
    if let Some(target) = targets.first() {
        // The window's own process: under Wine the target's id is the prefix's.
        let exe = target.exe.clone();
        std::thread::spawn(move || save_icon(hook, pid, &exe));
    }
    // A Unity game's hooker starts once the DLL is watching its text (`read_unity_text`).
    if hook.lock().unity.is_empty() {
        // An IL2CPP game the hooker attaches to while it starts up hangs (LunaHook, live): a game
        // started moments ago (Hook automatically) is given until `IL2CPP_STARTUP` to start first.
        let starting = targets
            .first()
            .filter(|t| t.wine.is_none() && unity::is_il2cpp_game(&t.exe))
            .and_then(|t| process::age(t.pid))
            .and_then(|age| IL2CPP_STARTUP.checked_sub(age));
        std::thread::spawn(move || {
            if let Some(wait) = starting {
                std::thread::sleep(wait);
                if hook.lock().generation != generation {
                    return;
                }
            }
            run(hook, generation, ENGINES[0])
        });
    }
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
    let status = status_of(&session);
    drop(session);
    refresh_voice_hook();
    Ok(status)
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

/// The language changed: a running LunaHook helper decodes the game's ANSI text with the new
/// language's code page from the next line (`language::hook_code_page`).
pub fn language_changed() {
    let Some(hook) = hook() else { return };
    let page = crate::language::hook_code_page(hook.language());
    let mut session = hook.lock();
    if session.code_page.is_some_and(|current| current != page)
        && send(&mut session, json!({ "cmd": "codepage", "codepage": page })).is_ok()
    {
        session.code_page = Some(page);
    }
}

/// Update sentence audio when the selected text-hook game or its settings change.
pub fn refresh_voice_hook() {
    let Some(hook) = hook() else {
        return;
    };
    let targets = hook.lock().targets.clone();
    let Some(service) = hook
        .app
        .try_state::<std::sync::Arc<crate::sentence_audio::SentenceAudio>>()
    else {
        return;
    };
    let config = service.config();
    // Windows games, natively or (on Linux) through Wine or Proton.
    let enabled = (cfg!(windows) || cfg!(target_os = "linux")) && config.enabled && config.voice_hook && hook.reading_text();
    if enabled {
        let mut bases: Vec<PathBuf> = Vec::new();
        for target in &targets {
            let found = match &target.wine {
                Some(wine) => crate::sentence_audio::voice_hook::prefix_bases(&wine.prefix),
                None => vec![crate::sentence_audio::voice_hook::base_dir()],
            };
            for base in found {
                if !bases.contains(&base) {
                    bases.push(base);
                }
            }
        }
        service.hook_targets(targets.iter().map(|t| t.pid).collect(), bases);
    } else {
        service.hook_targets(Vec::new(), Vec::new());
    }
    if !enabled {
        return;
    }
    for target in targets {
        if !service.hook_attempt(target.pid) {
            continue;
        }
        let app = hook.app.clone();
        let service = service.inner().clone();
        std::thread::spawn(move || {
            if let Err(e) = inject_voice_dll(&app, &target) {
                service.hook_failed(e);
            }
        });
    }
}

/// Injects the voice hook DLL into `target`, from a staged copy (so a rebuild or an update can
/// replace the app's own while the game runs). Loading it into a game that has it is harmless.
fn inject_voice_dll(app: &tauri::AppHandle, target: &process::Target) -> Result<(), String> {
    let helper = hookd_path(app)?.with_file_name(if target.bits == 32 {
        "kimochi-hookd-x86.exe"
    } else {
        "kimochi-hookd-x64.exe"
    });
    let dll = helper.with_file_name(if target.bits == 32 {
        "kimochi-voicehook-x86.dll"
    } else {
        "kimochi-voicehook-x64.dll"
    });
    if !dll.is_file() {
        return Err(
            "The voice hook DLL is missing from this build; using system audio.".into(),
        );
    }
    let prepare = |e: String| format!("The voice hook DLL could not be prepared; using system audio: {e}");
    // Under Wine the helper injects from inside the game's prefix, and the DLL is staged in the
    // prefix so that the game (inside Steam's runtime container, for Proton) can load it.
    #[cfg(target_os = "linux")]
    let mut command = {
        let wine = target.wine.as_ref().ok_or("Audio hooking reads Windows games running through Proton or Wine.")?;
        let user = std::env::var("USER").ok();
        let (base, windows_base) = crate::sentence_audio::voice_hook::prefix_home(&wine.prefix, user.as_deref())
            .ok_or_else(|| prepare("the game's Wine prefix has no user folder".into()))?;
        let staged = crate::sentence_audio::voice_hook::staged_dll(&dll, &base).map_err(prepare)?;
        let path = crate::sentence_audio::voice_hook::windows_under(&staged, &base, &windows_base)
            .ok_or_else(|| prepare("the staged copy is outside the prefix".into()))?;
        let mut command = wine::command(wine, &wine::reachable(wine, &helper).map_err(prepare)?);
        command.args(["inject", "--pid", &target.pid.to_string(), "--dll", &path]);
        command
    };
    #[cfg(not(target_os = "linux"))]
    let mut command = {
        let dll = crate::sentence_audio::voice_hook::staged_dll(&dll, &crate::sentence_audio::voice_hook::base_dir()).map_err(prepare)?;
        let mut command = Command::new(helper);
        command.args(["inject", "--pid", &target.pid.to_string(), "--dll"]).arg(dll);
        command
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Voice hook failed; using system audio: {}",
            String::from_utf8_lossy(&output.stdout)
        ))
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
