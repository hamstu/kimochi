//! The Agent engine: per-game scripts from the Agent collection (https://github.com/0xDC00/scripts)
//! that know where a game's text is, run inside the game by Frida. They reach games no generic
//! hooker does, emulated ones above all: a script hooks the game's own text routine inside the
//! emulator's recompiled code.
//!
//! When a game has a script (`index.rs`), it is the first engine tried; LunaHook and Textractor
//! follow if it cannot hook (`super::fall_back`). Nothing is bundled: Frida's `frida-inject` (pinned
//! in the texthook manifest, one build per target platform) and the collection at its pinned commit
//! (`scripts.rs`) are downloaded the first time a game needs them.
//!
//! The script frida-inject runs in the game is built here: `prelude.js` (which answers what the
//! collection's runtime asks its host for, inside the game, and reports on standard error),
//! `frida16.js` (the Frida 16 API the scripts were written for), the collection's own
//! `libLoader.js`, and the game's script, which libLoader loads. Standard error carries one marked
//! JSON line per event: `ready` once the script has loaded, `copy` per line of text, `log`.
//!
//! On macOS or Linux a Windows game runs under Wine or Proton: the Windows frida-inject runs in the game's
//! prefix with its Wine, as the hook helper does (`super::wine`), and sees the game as Windows
//! would.
#[cfg(target_os = "macos")]
pub(super) mod gadget;
pub mod index;
pub mod scripts;

use super::{fall_back, on_text, process, store, Hook, Session, Thread};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub use index::Script;

const PRELUDE: &str = include_str!("prelude.js");
const FRIDA16: &str = include_str!("frida16.js");
/// What starts each event line on frida-inject's standard error (after its colour code).
const MARK: &str = "\u{1}K ";
/// The engine's id in a session's engine list.
pub const ENGINE: &str = "agent";
/// What the hook codes of its thread start with (then the script's file name).
const HOOKCODE: &str = "AGENT:";
/// The longest text taken as one line; a script sending more is cut there, four times more dropped.
const MAX_CHARS: usize = 2000;
/// How long a script may take to load (some scan the game's memory first) before the next engine.
const STARTUP_LIMIT: Duration = Duration::from_secs(45);
/// How long a Unity game's runtime may take to come up before its script can hook it.
const UNITY_STARTUP: Duration = Duration::from_secs(20);

/// Whether a thread is the Agent script's.
pub fn is_agent(hookcode: &str) -> bool {
    hookcode.starts_with(HOOKCODE)
}

/// The texthook manifest's injector for this computer, if Agent runs here: Frida 17 on Windows (x64,
/// ARM64) and native Apple Silicon macOS; for Windows games under Wine, Frida 16, the last
/// that starts inside Wine.
pub fn injector(target: Option<&process::Target>) -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    if target.and_then(gadget::find).is_some() {
        return Some(gadget::ENGINE);
    }
    if target.is_some_and(|t| t.wine.is_some()) {
        return Some("agent-wine");
    }
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("agent-macos-arm64")
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        Some("agent-arm64")
    } else if cfg!(all(windows, target_arch = "x86_64")) {
        Some("agent-x64")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("agent-wine")
    } else {
        None
    }
}

/// The script for the game in `target`, whose window is titled `window_title`, if Agent runs here
/// and the collection has one.
pub fn script_for(target: &process::Target, window_title: Option<&str>, language: &str) -> Option<&'static Script> {
    injector(Some(target))?;
    // Development: every game has the script named here (a file put in the collection's folder),
    // to try the engine on a game the collection does not know.
    #[cfg(debug_assertions)]
    if let Some(file) = std::env::var("KIMOCHI_AGENT_SCRIPT").ok().filter(|f| !f.is_empty()) {
        static TEST: std::sync::OnceLock<Script> = std::sync::OnceLock::new();
        return Some(TEST.get_or_init(|| Script {
            title: file.trim_end_matches(".js").to_string(),
            file,
            platform: "pc".into(),
            ids: Vec::new(),
            steam: Vec::new(),
            lang: None,
            version: None,
            author: None,
            generic: false,
        }));
    }
    let steam = index::steam_app_id(&target.exe);
    index::find(&index::Game { exe: &target.exe, window_title, steam, language })
}

/// What the injector still needs, summed by `size` over its files (0 when it is here).
fn injector_missing(root: &Path, target: Option<&process::Target>, size: fn(&store::File) -> u64) -> u64 {
    let Some(engine) = injector(target) else { return 0 };
    match store::installed(root, engine) {
        Some(_) => 0,
        None => store::manifest().engines.get(engine).map_or(0, |e| e.files.iter().map(size).sum()),
    }
}

/// The collection's download, if it is not here yet.
fn collection_missing(root: &Path) -> u64 {
    if scripts::installed(root).is_some() {
        0
    } else {
        scripts::download_size()
    }
}

/// The bytes still to download before Agent can run (0 when it is ready).
pub fn missing_bytes(root: &Path, target: Option<&process::Target>) -> u64 {
    if injector(target).is_none() {
        return 0;
    }
    injector_missing(root, target, store::File::download_size) + collection_missing(root)
}

/// What the status says about the script: shown on the game's card.
pub fn describe(script: &Script, root: Option<&Path>, target: Option<&process::Target>) -> Value {
    json!({
        "file": script.file,
        "title": script.title,
        "platform": script.platform,
        "author": script.author,
        "version": script.version,
        "download": root.map_or(0, |root| missing_bytes(root, target)),
        "collection": index::index().repository,
    })
}

/// The engine's name and version, for the status.
pub fn engine_status(target: Option<&process::Target>) -> Value {
    let version = injector(target).and_then(|id| store::manifest().engines.get(id)).map(|e| e.version.clone());
    json!({ "id": ENGINE, "name": "Agent", "version": version })
}

/// Installs what is missing and hooks the session's game with its script. Anything that fails
/// before the script is running hands over to the next engine.
pub(super) fn run(hook: &'static Hook, generation: u64) {
    let (targets, script) = {
        let session = hook.lock();
        if session.generation != generation {
            return;
        }
        (session.targets.clone(), session.agent)
    };
    let result = (|| {
        let script = script.ok_or("no Agent script fits this game")?;
        let target = targets.first().ok_or("the game has closed")?;
        let (injector, collection) = install(hook, generation, target)?;
        launch(hook, generation, &injector, &collection, script, target, Instant::now())
    })();
    if let Err(reason) = result {
        if reason != "cancelled" {
            fall_back(hook, generation, ENGINE, reason);
        }
    }
}

/// The injector's folder and the collection's, downloaded first if they are not here yet, with one
/// progress bar for both.
fn install(hook: &'static Hook, generation: u64, target: &process::Target) -> Result<(PathBuf, PathBuf), String> {
    let engine = injector(Some(target)).ok_or("Agent does not run on this computer")?;
    let root = hook.root()?;
    // One bar for both: the injector's download and unpacking (`File::work`), then the collection.
    let injector_work = injector_missing(&root, Some(target), store::File::work);
    let missing = injector_work + collection_missing(&root);
    if missing > 0 {
        let mut session = hook.lock();
        if session.generation != generation {
            return Err("cancelled".into());
        }
        session.phase = "downloading";
        session.engine = Some(ENGINE);
        session.download = Some((0, missing));
        hook.publish(&session);
    }
    let report = |done: u64| {
        let mut session = hook.lock();
        if session.generation == generation {
            session.download = Some((done.min(missing), missing));
            hook.publish(&session);
        }
    };
    let fetch = store::HttpFetch::new()?;
    let injector = match store::installed(&root, engine) {
        Some(dir) => dir,
        None => store::install(&fetch, &root, engine, &|done, _| report(done))?,
    };
    let collection = scripts::install(&fetch, &root, &|n| report(injector_work + n.min(scripts::download_size())))?;
    let mut session = hook.lock();
    if session.generation != generation {
        return Err("cancelled".into());
    }
    session.download = None;
    Ok((injector, collection))
}

/// The script frida-inject runs: the prelude with the game's paths, the Frida 16 shim, and the
/// collection's runtime, which loads `mission` (`dir` and `mission` as the game sees them).
fn build_script(loader: &str, dir: &str, mission: &str) -> String {
    let params = json!({ "dir": dir, "mission": mission, "maxChars": MAX_CHARS });
    [
        format!("globalThis.__kimochi = {params};"),
        PRELUDE.to_string(),
        FRIDA16.to_string(),
        // Frida's own send and recv are read-only: libLoader's are the prelude's. Whether it loaded
        // the game's script is said either way (frida-inject itself says nothing of a failure).
        ";try { (function (send, recv) {".to_string(),
        loader.to_string(),
        "\n}).call(globalThis, globalThis.__kimochi.send, globalThis.__kimochi.recv);".to_string(),
        "globalThis.__kimochi.ready(); } catch (e) { globalThis.__kimochi.failed(e); }".to_string(),
    ]
    .join("\n")
}

/// A path as the game sees it: as it is on Windows; under Wine, the prefix's view of where the
/// game can reach it.
#[cfg(windows)]
fn game_path(_target: &process::Target, path: &Path, _dir: bool) -> Result<String, String> {
    Ok(path.to_string_lossy().into_owned())
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn game_path(target: &process::Target, path: &Path, dir: bool) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    if target.wine.is_none() {
        return Ok(path.to_string_lossy().into_owned());
    }
    let wine = target.wine.as_ref().ok_or("Agent hooks Windows games only")?;
    let reachable = if dir { super::wine::reachable_dir(wine, path)? } else { super::wine::reachable(wine, path)? };
    Ok(super::wine::windows_path(&reachable))
}
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn game_path(_target: &process::Target, _path: &Path, _dir: bool) -> Result<String, String> {
    Err("Agent does not run on this computer".into())
}

/// The command that runs frida-inject on the game, as the game's platform needs it.
fn injector_command(target: &process::Target, exe: &Path) -> Result<Command, String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        #[cfg(target_os = "macos")]
        if target.wine.is_none() {
            return Ok(Command::new(exe));
        }
        let wine = target.wine.as_ref().ok_or("Agent hooks Windows games only")?;
        Ok(super::wine::command(wine, &super::wine::reachable(wine, exe)?))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = target;
        Ok(Command::new(exe))
    }
}

/// Starts frida-inject on the game with `script` and reads what it says.
fn launch(
    hook: &'static Hook,
    generation: u64,
    injector: &Path,
    collection: &Path,
    script: &'static Script,
    target: &process::Target,
    started: Instant,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if let Some(run) = gadget::find(target) {
        return gadget::attach(hook, generation, collection, script, target, run, started);
    }
    // Attaching waits on the game, which a game pause stops: never while paused.
    if !crate::game_pause::app::defer_while_paused("Agent start", Duration::from_secs(30)) {
        return Err("busy: the game is paused".into());
    }
    if crate::game_pause::app::holds_pid(target.pid)
        && !crate::game_pause::app::resume_before_activating("attaching the Agent script")
    {
        return Err("busy: the game is paused".into());
    }
    let loader = std::fs::read_to_string(collection.join("libLoader.js")).map_err(|e| format!("libLoader.js: {e}"))?;
    let dir = game_path(target, collection, true)?;
    let separator = if cfg!(target_os = "macos") && target.wine.is_none() { "/" } else { "\\" };
    let mission = format!("{dir}{separator}{}", script.file);
    // One file per session, in a folder of its own (under Wine it is copied where the game can
    // reach it, folder and all).
    let run_dir = collection.with_file_name("agent-run");
    std::fs::create_dir_all(&run_dir).map_err(|e| e.to_string())?;
    let file = run_dir.join(format!("hook-{generation}.js"));
    std::fs::write(&file, build_script(&loader, &dir, &mission)).map_err(|e| e.to_string())?;
    let native = cfg!(target_os = "macos") && target.wine.is_none();
    let exe = injector.join(if native { "frida-inject" } else { "frida-inject.exe" });
    #[cfg(unix)]
    if native {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    let mut command = injector_command(target, &exe)?;
    command.args(["-p", &target.pid.to_string(), "-s", &game_path(target, &file, false)?, "-R", "qjs"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    // Frida probes stdin with tcgetattr even without interactive mode. On macOS
    // /dev/null returns ENODEV, which it treats as fatal; a pipe returns ENOTTY.
    let mut child = command
        .stdin(if native { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start Agent: {e}"))?;
    let stderr = child.stderr.take().ok_or("no output from Agent")?;
    {
        let mut session = hook.lock();
        if session.generation != generation {
            let _ = child.kill();
            return Err("cancelled".into());
        }
        session.child = Some(child);
        session.stdin = None;
        session.engine = Some(ENGINE);
        session.phase = "attaching";
        session.detail = None;
        hook.publish(&session);
    }
    crate::debug_report::trace(
        &hook.app,
        json!({ "check": "texthook-agent-start", "script": script.file, "pid": target.pid }),
    );
    let context = Arc::new(Context {
        injector: injector.to_path_buf(),
        collection: collection.to_path_buf(),
        script,
        target: target.clone(),
        started,
    });
    let run = Arc::new(Mutex::new(Run::default()));
    // A script that neither loads nor fails (a scan of the game's memory that never ends) is given
    // up after a while, for the next engine.
    std::thread::spawn(move || {
        std::thread::sleep(STARTUP_LIMIT);
        let stuck = {
            let session = hook.lock();
            session.generation == generation && session.engine == Some(ENGINE) && session.phase == "attaching"
        };
        if stuck {
            fall_back(hook, generation, ENGINE, "the script did not start".into());
        }
    });
    // The game closing, or frida-inject stopping: noticed here, since its standard error may stay
    // open after it (a Frida helper it started keeps it), and the reader would never hear the end.
    {
        let (context, run) = (context.clone(), run.clone());
        std::thread::spawn(move || watch(hook, generation, &context, &run));
    }
    std::thread::spawn(move || {
        read(hook, generation, &context, &run, BufReader::new(stderr));
        // The output ended: frida-inject has exited.
        let end = finish(hook, generation, &context, &run, Ending::Exited);
        again(hook, generation, &context, end);
    });
    Ok(())
}

/// What a session's run of frida-inject needs to be started again.
struct Context {
    injector: PathBuf,
    collection: PathBuf,
    script: &'static Script,
    target: process::Target,
    /// When the first run started (a Unity game's runtime is waited for from then).
    started: Instant,
}

/// What a run of frida-inject has said so far, shared by its reader and its watcher.
#[derive(Default)]
struct Run {
    ready: bool,
    spoke: bool,
    /// The script's log said the game's Unity runtime is not up yet.
    not_ready: bool,
    /// Its last few messages of its own and warnings, for why it stopped.
    said: VecDeque<String>,
    /// Its end has been dealt with, by whichever noticed it first.
    over: bool,
}

impl Run {
    fn note(&mut self, text: String) {
        self.said.push_back(text);
        if self.said.len() > 6 {
            self.said.pop_front();
        }
    }
}

/// How frida-inject's run ended, for what follows.
#[derive(Debug, PartialEq)]
enum End {
    /// Superseded, or handled already (handed over, the game closed).
    Done,
    /// The script could not find the game's Unity runtime yet: worth trying again.
    RuntimeNotReady,
}

/// What ended a run.
#[derive(Debug, PartialEq)]
enum Ending {
    Exited,
    GameClosed,
}

/// A Unity game whose runtime was not up yet: the script is tried again, until it is or the time
/// for it is up.
fn again(hook: &'static Hook, generation: u64, context: &Context, end: End) {
    if end != End::RuntimeNotReady || hook.lock().generation != generation {
        return;
    }
    if context.started.elapsed() >= UNITY_STARTUP {
        fall_back(hook, generation, ENGINE, "the game's Unity runtime did not come up".into());
        return;
    }
    std::thread::sleep(Duration::from_millis(750));
    if hook.lock().generation != generation {
        return;
    }
    let result = launch(
        hook,
        generation,
        &context.injector,
        &context.collection,
        context.script,
        &context.target,
        context.started,
    );
    if let Err(reason) = result {
        if reason != "cancelled" {
            fall_back(hook, generation, ENGINE, reason);
        }
    }
}

/// Whether the process is still running: `None` where that cannot be told (under Wine its id is
/// the prefix's).
#[cfg(windows)]
fn running(pid: u32) -> Option<bool> {
    use windows::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER};
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    const STILL_ACTIVE: u32 = 259;
    let handle = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(handle) => handle,
        // No such process any more.
        Err(e) if e.code() == ERROR_INVALID_PARAMETER.to_hresult() => return Some(false),
        Err(_) => return None,
    };
    let mut code = 0u32;
    let read = unsafe { GetExitCodeProcess(handle, &mut code) }.is_ok();
    let _ = unsafe { CloseHandle(handle) };
    read.then_some(code == STILL_ACTIVE)
}
#[cfg(not(windows))]
fn running(_pid: u32) -> Option<bool> {
    None
}

fn target_running(target: &process::Target) -> Option<bool> {
    #[cfg(target_os = "macos")]
    if target.wine.is_none() {
        let pid = i32::try_from(target.pid).ok()?;
        return Some(
            unsafe { libc::kill(pid, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM),
        );
    }
    running(target.pid)
}

/// Every half second, while the run is the session's: the game gone, or frida-inject gone.
fn watch(hook: &'static Hook, generation: u64, context: &Context, run: &Mutex<Run>) {
    loop {
        std::thread::sleep(Duration::from_millis(500));
        let ending = {
            let mut session = hook.lock();
            if session.generation != generation || session.engine != Some(ENGINE) {
                return;
            }
            if run.lock().unwrap_or_else(|e| e.into_inner()).over {
                return;
            }
            let exited = session.child.as_mut().is_none_or(|child| matches!(child.try_wait(), Ok(Some(_))));
            if target_running(&context.target) == Some(false) {
                Some(Ending::GameClosed)
            } else if exited {
                Some(Ending::Exited)
            } else {
                None
            }
        };
        if let Some(ending) = ending {
            let end = finish(hook, generation, context, run, ending);
            again(hook, generation, context, end);
            return;
        }
    }
}

/// One event line: the JSON after the mark, the colour codes around it taken off.
pub fn event_of(line: &str) -> Option<Value> {
    let at = line.find(MARK)?;
    let json = line[at + MARK.len()..].trim_end_matches(['\r', '\n']);
    let json = json.strip_suffix("\u{1b}[0m").unwrap_or(json);
    serde_json::from_str(json).ok()
}

/// What frida-inject says of its own (no mark), its colour codes off.
fn plain(line: &str) -> String {
    let mut out = String::new();
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // `ESC [ … m`
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}

/// A script's error as the card says it: `Error:` off, and any path down to its file name
/// (`Module C:\…\NS_x.js not found!` → `Module NS_x.js not found!`).
pub fn plain_error(text: &str) -> String {
    let text = text.trim().trim_start_matches("Error:").trim();
    let line = text.lines().next().unwrap_or_default();
    line.split(' ')
        .map(|word| {
            let is_path = word.contains(":\\") || word.starts_with('/') || word.starts_with("\\\\");
            match word.rsplit(['\\', '/']).next() {
                Some(name) if is_path && !name.is_empty() => name,
                _ => word,
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether the script's log says the game's Unity (Mono) runtime is not there yet.
fn runtime_not_ready(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("mono not found") || lower.contains("mono is not ready") || lower.contains("il2cpp not found")
}

fn kill(session: &mut Session) {
    #[cfg(target_os = "macos")]
    gadget::stop(session);
    if let Some(mut child) = session.child.take() {
        let _ = child.kill();
        std::thread::spawn(move || child.wait());
    }
}

/// Reads frida-inject's events until its output ends, or the script ended the run itself.
fn read(hook: &'static Hook, generation: u64, context: &Context, run: &Mutex<Run>, mut stderr: impl BufRead) {
    let (script, pid) = (context.script, context.target.pid);
    let key = format!("{pid}:agent");
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match stderr.read_until(b'\n', &mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&buffer);
        let Some(event) = event_of(&line) else {
            let text = plain(&line);
            if !text.is_empty() {
                run.lock().unwrap_or_else(|e| e.into_inner()).note(text);
            }
            continue;
        };
        let mut session = hook.lock();
        let mut state = run.lock().unwrap_or_else(|e| e.into_inner());
        if session.generation != generation || state.over {
            return;
        }
        match event["cmd"].as_str().unwrap_or_default() {
            "ready" => {
                state.ready = true;
                session.phase = "hooked";
                session.detail = None;
                add_thread(&mut session, &key, pid, script);
                hook.publish(&session);
                crate::debug_report::trace(
                    &hook.app,
                    json!({ "check": "texthook-agent-ready", "script": script.file }),
                );
            }
            "copy" => {
                let text = event["text"].as_str().unwrap_or_default();
                if text.trim().is_empty() {
                    continue;
                }
                if !session.threads.iter().any(|t| t.key == key) {
                    add_thread(&mut session, &key, pid, script);
                }
                state.spoke = true;
                drop(state);
                on_text(hook, &mut session, &key, text);
                hook.publish(&session);
            }
            "log" => {
                let text = event["text"].as_str().unwrap_or_default();
                if !state.spoke && runtime_not_ready(text) {
                    state.not_ready = true;
                }
                if event["level"] != "info" {
                    state.note(text.to_string());
                }
                crate::debug_report::trace(
                    &hook.app,
                    json!({ "check": "texthook-agent-log", "level": event["level"], "text": text }),
                );
            }
            // The script could not load (a library it needs, the game's code it looks for): it says
            // so itself, and frida-inject, which would stay, is stopped.
            "error" if !state.ready => {
                let text = event["text"].as_str().unwrap_or("the script did not load").to_string();
                crate::debug_report::trace(
                    &hook.app,
                    json!({ "check": "texthook-agent-error", "text": text, "stack": event["stack"] }),
                );
                state.over = true;
                if state.not_ready || runtime_not_ready(&text) {
                    kill(&mut session);
                    drop((state, session));
                    again(hook, generation, context, End::RuntimeNotReady);
                    return;
                }
                drop((state, session));
                fall_back(hook, generation, ENGINE, plain_error(&text));
                return;
            }
            // The script gave up on this game (a version it does not know).
            "detach" if !state.spoke => {
                state.over = true;
                drop((state, session));
                fall_back(hook, generation, ENGINE, format!("the {} script stopped", script.title));
                return;
            }
            _ => {}
        }
    }
}

/// The run has ended (`ending`): the game closed, the session is over; frida-inject stopped before
/// the script ran or spoke, the next engine; after, the session failed. Once per run.
fn finish(hook: &'static Hook, generation: u64, context: &Context, run: &Mutex<Run>, ending: Ending) -> End {
    let mut session = hook.lock();
    let mut state = run.lock().unwrap_or_else(|e| e.into_inner());
    if session.generation != generation || state.over {
        return End::Done;
    }
    state.over = true;
    kill(&mut session);
    let key = format!("{}:agent", context.target.pid);
    let closed = ending == Ending::GameClosed || state.said.iter().any(|s| s.to_lowercase().contains("terminated"));
    if closed {
        session.phase = "ended";
        session.detail = Some("The game has closed.".into());
        session.threads.retain(|t| t.key != key);
        hook.publish(&session);
        return End::Done;
    }
    if state.not_ready && !state.spoke {
        return End::RuntimeNotReady;
    }
    let what = state.said.iter().rev().find(|s| !s.is_empty()).cloned();
    if !state.ready || !state.spoke {
        drop((state, session));
        fall_back(hook, generation, ENGINE, what.unwrap_or_else(|| "the script did not load".into()));
        return End::Done;
    }
    session.phase = "failed";
    session.detail = Some(format!("Agent stopped{}", what.map(|w| format!(": {w}")).unwrap_or_default()));
    session.threads.retain(|t| t.key != key);
    hook.publish(&session);
    End::Done
}

/// The script's one thread, chosen at once: it is the game's dialogue, whatever else the game draws.
fn add_thread(session: &mut Session, key: &str, pid: u32, script: &Script) {
    if !session.threads.iter().any(|t| t.key == key) {
        session.threads.push(Thread {
            key: key.to_string(),
            pid,
            hookcode: format!("{HOOKCODE}{}", script.file),
            name: script.title.clone(),
            ctx: 0,
            ctx2: 0,
            text: String::new(),
            count: 0,
            noisy: 0,
            glyphs: 0,
            recent: VecDeque::new(),
            last_at: None,
            japanese: true,
            foreign: 0,
            box_start: String::new(),
            fresh: false,
        });
    }
    session.selected = Some(key.to_string());
    session.selected_by = Some("agent");
    session.pick_note = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_lines_are_read_through_their_colour_codes() {
        let line = "\u{1b}[0;31m\u{1}K {\"cmd\":\"copy\",\"text\":\"猫が\\n窓の外\"}\u{1b}[0m\r\n";
        assert_eq!(event_of(line).unwrap(), json!({ "cmd": "copy", "text": "猫が\n窓の外" }));
        assert!(event_of("Failed to attach: unable to access process").is_none());
        assert_eq!(plain("\u{1b}[0;31mFailed to attach: denied\u{1b}[0m\r\n"), "Failed to attach: denied");
    }

    #[test]
    fn the_injected_script_runs_libloader_with_the_preludes_send_and_recv() {
        let built = build_script("function main(){}main();", r"C:\K\scripts", r"C:\K\scripts\NS_x.js");
        let params = built.lines().next().unwrap();
        assert!(params.starts_with("globalThis.__kimochi = {"), "{params}");
        let value: Value =
            serde_json::from_str(params.trim_start_matches("globalThis.__kimochi = ").trim_end_matches(';')).unwrap();
        assert_eq!(value["dir"], r"C:\K\scripts");
        assert_eq!(value["mission"], r"C:\K\scripts\NS_x.js");
        // The loader's own `send` and `recv` are the prelude's, after the shim, and it says whether
        // it has loaded.
        let loader = built.find("function main(){}").unwrap();
        assert!(built[..loader].ends_with(";try { (function (send, recv) {\n"));
        assert!(built.find("findGlobalExportByName").unwrap() < loader);
        assert!(built
            .trim_end()
            .ends_with("globalThis.__kimochi.ready(); } catch (e) { globalThis.__kimochi.failed(e); }"));
    }

    #[test]
    fn script_errors_are_said_with_file_names_not_paths() {
        assert_eq!(
            plain_error(r"Error: Module C:\Users\a\texthook\agent-scripts-1\NS_x.js not found!"),
            "Module NS_x.js not found!"
        );
        assert_eq!(plain_error("Hook not found!\n    at libYuzu.js:12"), "Hook not found!");
    }

    #[test]
    fn a_unity_runtime_not_up_yet_is_told_from_the_log() {
        assert!(runtime_not_ready("Mono not found!"));
        assert!(!runtime_not_ready("Attach: TMP_Text.set_text"));
    }
}
