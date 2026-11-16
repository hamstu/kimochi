//! The hold manager running in the app: one thread owns the [`Machine`], the guard client and the
//! backend used for planning. Everything else talks to it through [`send`] and reads the shared
//! state (status, pause spans) without blocking it.
use super::backend::GameRef;
use super::guard::{Client, Request};
use super::journal::Journal;
use super::manager::{self, Context, Effect, Input, Machine, PauseSpan, Phase, Status};
use serde_json::{json, Value};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Condvar, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// The setting: "Pause the game while reading". Machine-local, off by default.
pub const SETTING: &str = "pauseGameWhileReading";
/// Status changes (`manager::Status`).
pub const EVENT_STATUS: &str = "game-pause";
/// A pause was refused for a game, once per game per run (`manager::Notice`).
pub const EVENT_NOTICE: &str = "game-pause-notice";
/// A pause span opened (`endMs` null) or closed (`manager::PauseSpan`).
pub const EVENT_SPAN: &str = "game-pause-span";

/// The monotonic epoch of the spans' `*_mono` fields.
static EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);

struct Shared {
    status: Option<Status>,
    spans: Vec<PauseSpan>,
    /// The processes of the pause in effect (from the suspend request until the resume is
    /// confirmed).
    pids: Vec<u32>,
}
static SHARED: Mutex<Shared> = Mutex::new(Shared { status: None, spans: Vec::new(), pids: Vec::new() });
static RESUMED: Condvar = Condvar::new();
static TX: OnceLock<Mutex<Sender<Input>>> = OnceLock::new();

/// Hands `input` to the manager thread. A no-op before [`start`].
pub fn send(input: Input) {
    if let Some(tx) = TX.get() {
        let _ = tx.lock().unwrap_or_else(|p| p.into_inner()).send(input);
    }
}

/// The current status (`game_pause_status`).
pub fn status() -> Option<Status> {
    SHARED.lock().unwrap_or_else(|p| p.into_inner()).status.clone()
}

/// Whether a pause span is open (the game is suspended, or about to be, or not yet confirmed resumed).
pub fn paused() -> bool {
    SHARED.lock().unwrap_or_else(|p| p.into_inner()).spans.last().is_some_and(|s| s.end_ms.is_none())
}

/// Whether `pid` is part of the pause in effect: nothing may wait on it (Accessibility,
/// synchronous window messages) or bring it to the front.
// Read by macOS's Accessibility and activation paths today; Windows' foreground gating will too.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn holds_pid(pid: u32) -> bool {
    SHARED.lock().unwrap_or_else(|p| p.into_inner()).pids.contains(&pid)
}

/// Before Kimochi brings an application to the front (handing focus back after the controller
/// menu, a source brought forward): a paused game is resumed first, and this waits for it (at
/// most 1.5 s). False when it is still paused: then it must not be activated. Never call it from
/// the game pause thread; from the main thread only where a short wait is acceptable.
pub fn resume_before_activating(why: &str) -> bool {
    if !paused() {
        return true;
    }
    send(Input::ForceResume(why.into()));
    wait_until_resumed(Duration::from_millis(1500))
}

/// Pause spans that ended after `since_ms` (Unix wall-clock ms, `kimochi_capture::audio::now_ms`)
/// or are still open, oldest first. Any thread; never waits on anything but a short lock.
pub fn spans_since(since_ms: f64) -> Vec<PauseSpan> {
    manager::since(&SHARED.lock().unwrap_or_else(|p| p.into_inner()).spans, since_ms)
}

/// Blocks until no pause is open, at most `timeout`. Returns whether the game is running.
pub fn wait_until_resumed(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let mut shared = SHARED.lock().unwrap_or_else(|p| p.into_inner());
    loop {
        if !shared.spans.last().is_some_and(|s| s.end_ms.is_none()) {
            return true;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        shared = RESUMED.wait_timeout(shared, left).unwrap_or_else(|p| p.into_inner()).0;
    }
}

struct AppCx {
    app: tauri::AppHandle,
}

impl Context for AppCx {
    fn game(&self) -> GameRef {
        let selection = self.app.try_state::<crate::state::Shared>().and_then(|s| s.selection.lock().ok()?.clone());
        let ours = std::process::id();
        // While the menu has activation, the game is the app it will hand back to.
        let frontmost =
            crate::platform::frontmost_pid().filter(|pid| *pid != ours).or_else(crate::gamepad::returning_to);
        #[cfg(target_os = "linux")]
        let steam = crate::platform::gamescope::focused_app_id();
        #[cfg(not(target_os = "linux"))]
        let steam = None;
        super::target::game_ref(selection.as_deref(), frontmost, steam)
    }
    fn inputs_held(&self) -> bool {
        #[cfg(target_os = "macos")]
        let keys = crate::platform::menu_keys_held();
        #[cfg(not(target_os = "macos"))]
        let keys = false;
        crate::gamepad::any_button_held() || keys || crate::gamepad::lookup_held()
    }
}

/// Starts the manager thread, recovers what a previous run left paused, and applies the setting.
pub fn start(app: &tauri::AppHandle, enabled: bool) {
    let (tx, rx) = channel::<Input>();
    if TX.set(Mutex::new(tx.clone())).is_err() {
        return;
    }
    let _ = *EPOCH;
    let app = app.clone();
    let journal = app.path().app_data_dir().ok().map(|dir| Journal::in_dir(&dir));
    let spawned = std::thread::Builder::new().name("game-pause".into()).spawn(move || {
        let backend = super::platform::backend();
        if let Some(journal) = &journal {
            for r in journal.recover(backend.as_ref(), None) {
                log(&app, false, json!({ "check": "game-pause", "recovered": r.pid, "exe": r.exe, "outcome": r.outcome, "since": r.since, "by": "app" }));
            }
        }
        let cx = AppCx { app: app.clone() };
        let mut machine = Machine::new(*EPOCH, kimochi_capture::audio::now_ms);
        let mut client: Option<Client> = None;
        let mut pending = vec![Input::SetEnabled(enabled)];
        let mut quitting: Option<Instant> = None;
        loop {
            if quitting.is_some_and(|at| machine.phase() == Phase::Idle || at.elapsed() >= Duration::from_millis(800)) {
                // The guard resumes (if it has not yet) and exits when its pipe closes.
                drop(client.take());
                break;
            }
            let input = match pending.pop() {
                Some(input) => input,
                None => match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(input) => input,
                    Err(RecvTimeoutError::Timeout) => Input::Tick,
                    Err(RecvTimeoutError::Disconnected) => break,
                },
            };
            if matches!(&input, Input::ForceResume(why) if why == QUIT) {
                quitting = Some(Instant::now());
            }
            for effect in machine.handle(input, Instant::now(), backend.as_ref(), &cx) {
                match effect {
                    Effect::Send(request) => {
                        if let Err(e) = deliver(&mut client, &journal, &tx, &request) {
                            log(&app, false, json!({ "check": "game-pause", "guard": "unavailable", "error": e }));
                            client = None;
                            pending.push(Input::GuardGone);
                        }
                    }
                    Effect::Status(status) => {
                        let _ = app.emit(EVENT_STATUS, &status);
                        SHARED.lock().unwrap_or_else(|p| p.into_inner()).status = Some(status);
                    }
                    Effect::Notice(notice) => {
                        let _ = app.emit(EVENT_NOTICE, &notice);
                    }
                    Effect::Log { verbose, value } => log(&app, verbose, value),
                }
            }
            SHARED.lock().unwrap_or_else(|p| p.into_inner()).pids = machine.paused_pids();
            publish_spans(&app, machine.spans());
        }
    });
    if let Err(e) = spawned {
        eprintln!("game pause: could not start its thread: {e}");
    }
}

/// The `ForceResume` reason the app sends on quit; the manager thread ends after it.
pub const QUIT: &str = "app quit";

/// Resumes and stops the guard before the app exits; waits briefly for the resume.
pub fn shutdown() {
    if TX.get().is_none() {
        return;
    }
    send(Input::ForceResume(QUIT.into()));
    wait_until_resumed(Duration::from_millis(1000));
}

fn deliver(
    client: &mut Option<Client>,
    journal: &Option<Journal>,
    tx: &Sender<Input>,
    request: &Request,
) -> Result<(), String> {
    if client.as_mut().is_some_and(|c| c.exited()) {
        *client = None;
    }
    if client.is_none() {
        // Only a suspend needs a guard; nothing to beat or resume without one.
        if !matches!(request, Request::Suspend { .. }) {
            return Ok(());
        }
        let journal = journal.as_ref().ok_or("no app data folder for the journal")?;
        let replies = tx.clone();
        let gone = tx.clone();
        *client = Some(Client::spawn(
            journal.path(),
            move |reply| {
                let _ = replies.send(Input::Guard(reply));
            },
            move || {
                let _ = gone.send(Input::GuardGone);
            },
        )?);
    }
    client.as_mut().ok_or("no guard")?.send(request)
}

fn publish_spans(app: &tauri::AppHandle, spans: Vec<PauseSpan>) {
    let mut shared = SHARED.lock().unwrap_or_else(|p| p.into_inner());
    if shared.spans == spans {
        return;
    }
    // Every span that opened or closed since the last publish, in order (an open and its close
    // in one turn are both announced).
    let mut events = Vec::new();
    for span in &spans {
        match shared.spans.iter().find(|s| s.id == span.id) {
            Some(old) if old == span => {}
            Some(_) => events.push(*span),
            None => {
                if span.end_ms.is_some() {
                    events.push(PauseSpan { end_ms: None, end_mono: None, ..*span });
                }
                events.push(*span);
            }
        }
    }
    let open = spans.last().is_some_and(|s| s.end_ms.is_none());
    shared.spans = spans;
    drop(shared);
    if !open {
        RESUMED.notify_all();
    }
    for span in events {
        let _ = app.emit(EVENT_SPAN, span);
    }
}

fn log(app: &tauri::AppHandle, verbose: bool, value: Value) {
    if verbose {
        crate::debug_report::trace(app, value);
    } else if let Some(service) = app.try_state::<crate::state::Shared>() {
        crate::record(app, &service, value);
    }
}

/// Whether the reader turned the setting on.
pub fn enabled(settings: &crate::settings::Settings) -> bool {
    settings.get_or(SETTING, false)
}

/// Another application came to the front (`front`, never Kimochi or the app controller navigation
/// returns to): the reader went elsewhere, so the game runs again.
pub fn frontmost_changed(front: Option<u32>) {
    let Some(front) = front else { return };
    if front == std::process::id() || crate::gamepad::returning_to() == Some(front) || !paused() {
        return;
    }
    send(Input::Frontmost(front));
}

/// Settings → the game pause row: whether this build can pause, the setting, and the state.
#[tauri::command]
pub fn game_pause_status(state: tauri::State<crate::state::Shared>) -> Value {
    json!({
        "capability": super::platform::capability(),
        "enabled": enabled(&state.settings),
        "status": status(),
    })
}

/// The overlay's beat while the setting is on: exactly the reasons it holds now ("lookup",
/// "navigation", "regionEditor"). Sent every 500 ms while any is held, at once when one starts,
/// and once with none when they all end.
#[tauri::command]
pub fn game_pause_beat(reasons: Vec<String>) {
    send(Input::Beat(reasons.iter().filter_map(|r| manager::Reason::parse(r)).collect()));
}

/// The escape hatch ("Resume paused game", Settings and the tray): resume everything now,
/// including whatever the journal names from an earlier run.
#[tauri::command]
pub fn game_pause_resume_all(app: tauri::AppHandle) -> Value {
    resume_all(&app)
}

pub fn resume_all(app: &tauri::AppHandle) -> Value {
    send(Input::ForceResume("resumed by the reader".into()));
    let resumed = wait_until_resumed(Duration::from_millis(1500));
    let recovered = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| Journal::in_dir(&dir).recover(super::platform::backend().as_ref(), None))
        .unwrap_or_default();
    let value = json!({ "check": "game-pause", "resumeAll": true, "running": resumed, "recovered": recovered });
    log(app, false, value.clone());
    value
}

/// The pages' [`spans_since`]: spans that ended after `since` (Unix ms) or are still open.
#[tauri::command]
pub fn game_pause_spans(since: Option<f64>) -> Vec<PauseSpan> {
    spans_since(since.unwrap_or(0.0))
}
