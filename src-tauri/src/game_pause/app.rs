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
    phase: Phase,
    /// The last `Input::Barrier` handled.
    barrier: u64,
}
static SHARED: Mutex<Shared> =
    Mutex::new(Shared { status: None, spans: Vec::new(), pids: Vec::new(), phase: Phase::Idle, barrier: 0 });
/// Notified after every turn of the game pause thread.
static CHANGED: Condvar = Condvar::new();
// Gaming Mode's ordering (Linux) is the only user of the barrier so far.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
static NEXT_BARRIER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
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
        shared = CHANGED.wait_timeout(shared, left).unwrap_or_else(|p| p.into_inner()).0;
    }
}

/// Waits (at most `timeout`) until every input sent before this call has been handled and no
/// suspend is in flight: the game is paused, or a pause was not wanted or refused. For what must
/// happen after the game stops (Gaming Mode stops Steam's controller reader only then). Returns
/// whether it settled in time. A no-op before [`start`].
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn settle(timeout: Duration) -> bool {
    // Off: nothing pauses, so nothing to wait for (and no round trip).
    if TX.get().is_none() || !ENABLED.load(std::sync::atomic::Ordering::Relaxed) {
        return true;
    }
    let id = NEXT_BARRIER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    send(Input::Barrier(id));
    let deadline = Instant::now() + timeout;
    let mut shared = SHARED.lock().unwrap_or_else(|p| p.into_inner());
    loop {
        if shared.barrier >= id && shared.phase != Phase::Pausing {
            return true;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        shared = CHANGED.wait_timeout(shared, left).unwrap_or_else(|p| p.into_inner()).0;
    }
}

/// Before anything that waits synchronously on a helper living beside the game (the text hook
/// helper inside a Wine prefix needs the prefix's wineserver, which a pause stops): wait for the
/// game to run again, at most `limit`, logging the deferral. False when it is still paused; the
/// caller then skips (or fails) and says so.
pub fn defer_while_paused(what: &str, limit: Duration) -> bool {
    if !paused() {
        return true;
    }
    let began = Instant::now();
    let resumed = wait_until_resumed(limit);
    crate::debug_report::record_now(json!({
        "check": "game-pause",
        "deferred": what,
        "waitedMs": began.elapsed().as_millis() as u64,
        "resumed": resumed,
    }));
    resumed
}

struct AppCx {
    app: tauri::AppHandle,
}

impl Context for AppCx {
    fn game(&self) -> GameRef {
        let selection = self.app.try_state::<crate::state::Shared>().and_then(|s| s.selection.lock().ok()?.clone());
        #[cfg(target_os = "linux")]
        {
            let steam = crate::platform::gamescope::focused_app_id();
            super::target::game_ref(
                selection.as_deref(),
                steam,
                &crate::platform::x11_window_host_pid,
                &crate::platform::game_window_open,
            )
        }
        // Only a selected window names the game: with a display (or nothing) selected, the app in
        // front could be anything (a browser, a call), and is never paused. The window must still
        // be open: `window_bounds` checks a Windows handle against the id's pid (handles are
        // recycled) and answers for a minimised window too; on macOS it does not (its query skips
        // minimised and ordered-out windows), so the full window list is read there.
        #[cfg(target_os = "macos")]
        {
            super::target::game_ref(selection.as_deref(), None, &|_| None, &crate::platform::game_window_open)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        super::target::game_ref(selection.as_deref(), None, &|_| None, &|id| {
            crate::platform::window_bounds(id).is_some()
        })
    }
    fn inputs_held(&self) -> bool {
        #[cfg(target_os = "macos")]
        let keys = crate::platform::menu_keys_held();
        #[cfg(not(target_os = "macos"))]
        let keys = false;
        crate::gamepad::any_button_held() || keys || crate::gamepad::lookup_held()
    }
    fn resume_blocked(&self) -> bool {
        // Gaming Mode: Steam runs again before the game (stop order game, Steam; resume reverse).
        #[cfg(target_os = "linux")]
        return crate::platform::steam_input::stopped();
        #[cfg(not(target_os = "linux"))]
        false
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
        recover_orphans(&app, &journal, backend.as_ref(), None, "app start");
        let mut last_orphan_check = Instant::now();
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
            let barrier = if let Input::Barrier(id) = input { Some(id) } else { None };
            let guard_gone = matches!(input, Input::GuardGone);
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
                        // Escape releases a freeze while the game is frozen (`freeze-escape`).
                        let frozen = status.phase == Phase::Paused && status.holds.contains(&manager::Reason::Freeze);
                        if let Err(error) = crate::hotkeys::set_freeze_keys(&app, frozen) {
                            log(&app, false, json!({ "check": "game-pause", "freezeKeys": error }));
                        }
                        FROZEN.store(
                            status.holds.contains(&manager::Reason::Freeze),
                            std::sync::atomic::Ordering::Relaxed,
                        );
                        // The controller menu kept the focus while the game was frozen: it goes
                        // back to the game once the game runs again.
                        if !frozen && status.phase == Phase::Idle {
                            crate::gamepad::hand_back_after_freeze(&app);
                        }
                        let _ = app.emit(EVENT_STATUS, &status);
                        SHARED.lock().unwrap_or_else(|p| p.into_inner()).status = Some(status);
                    }
                    Effect::Notice(notice) => {
                        let _ = app.emit(EVENT_NOTICE, &notice);
                    }
                    Effect::Log { verbose, value } => log(&app, verbose, value),
                }
            }
            if guard_gone {
                // The guard is gone, resumed or not (killed, crashed): say how it ended, and resume
                // whatever its journal still names at once rather than at the next pause.
                let status = client.take().map(|mut c| c.reap(Duration::from_millis(500)));
                log(&app, false, json!({ "check": "game-pause", "guard": "exited", "status": status }));
                recover_orphans(&app, &journal, backend.as_ref(), None, "guard gone");
            }
            // An orphaned journal (an older guard that died, or a resume that failed in it): resumed
            // once no guard of ours or of an earlier run is alive to do it.
            if last_orphan_check.elapsed() >= ORPHAN_CHECK_EVERY {
                last_orphan_check = Instant::now();
                if client.as_mut().is_none_or(|c| c.exited()) {
                    recover_orphans(&app, &journal, backend.as_ref(), None, "orphan check");
                }
            }
            // Whether the game may pause: the setting, or a freeze (which needs no setting) held or
            // still being undone.
            let may_pause = machine.enabled() || machine.frozen() || machine.phase() != Phase::Idle;
            ENABLED.store(may_pause, std::sync::atomic::Ordering::Relaxed);
            {
                let mut shared = SHARED.lock().unwrap_or_else(|p| p.into_inner());
                shared.pids = machine.paused_pids();
                shared.phase = machine.phase();
                if let Some(id) = barrier {
                    shared.barrier = shared.barrier.max(id);
                }
            }
            publish_spans(&app, machine.spans());
            CHANGED.notify_all();
        }
    });
    if let Err(e) = spawned {
        eprintln!("game pause: could not start its thread: {e}");
    }
}

/// How often the game pause thread looks for an orphaned journal while it has no guard.
const ORPHAN_CHECK_EVERY: Duration = Duration::from_secs(2);
/// Guard stderr lines logged at the normal level per guard; later ones are verbose only.
const STDERR_NORMAL_LINES: usize = 50;
/// The guard the app talks to now; replies and exits of earlier ones are ignored.
static GUARD_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Whether the game may pause: the setting as the game pause thread last applied it, or a freeze.
static ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether the reader holds a freeze (Freeze game), as the game pause thread last reported it.
static FROZEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether the reader froze the game (Freeze game): the controller menu then keeps the focus
/// instead of resuming the game to hand it back (cheap, any thread).
pub fn frozen_now() -> bool {
    FROZEN.load(std::sync::atomic::Ordering::Relaxed)
}

/// Whether the game may pause: the setting is on, as the game pause thread last applied it, or
/// the reader froze it (cheap, any thread).
pub fn enabled_now() -> bool {
    ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Whether `pid` is a guard process (Kimochi's own executable) that is still running.
fn guard_alive(backend: &dyn super::backend::Backend, pid: u32) -> bool {
    let name = |path: &str| std::path::Path::new(path).file_name().map(|n| n.to_owned());
    let ours = std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_owned()));
    pid != std::process::id()
        && backend.identity(pid).is_some_and(|id| ours.is_some() && name(id.exe.trim_end_matches(" (deleted)")) == ours)
}

/// Resumes what the journal names unless a guard that can still do it is alive (`live`, or the one
/// that wrote the entry), and logs each process.
fn recover_orphans(
    app: &tauri::AppHandle,
    journal: &Option<Journal>,
    backend: &dyn super::backend::Backend,
    live: Option<u32>,
    by: &str,
) {
    let Some(journal) = journal else { return };
    if !journal.path().exists() {
        return;
    }
    if let Some(entry) = journal.read() {
        if live == Some(entry.guard) || guard_alive(backend, entry.guard) {
            return;
        }
    }
    for r in journal.recover(backend, None) {
        log(
            app,
            false,
            json!({ "check": "game-pause", "recovered": r.pid, "exe": r.exe, "outcome": r.outcome, "since": r.since, "by": by }),
        );
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
        // Each guard's replies and exit count only while it is the current one: a late exit of an
        // earlier guard must not end the pause a new one holds.
        let generation = GUARD_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let current = move || GUARD_GENERATION.load(std::sync::atomic::Ordering::SeqCst) == generation;
        let lines = std::sync::atomic::AtomicUsize::new(0);
        *client = Some(Client::spawn(
            journal.path(),
            move |reply| {
                if current() {
                    let _ = replies.send(Input::Guard(reply));
                }
            },
            move || {
                if current() {
                    let _ = gone.send(Input::GuardGone);
                }
            },
            move |line| {
                eprintln!("game pause guard: {line}");
                let value = json!({ "check": "game-pause", "guardStderr": line });
                // Panics and missing tools belong in a normal log; a chatty backend only so far.
                if lines.fetch_add(1, std::sync::atomic::Ordering::Relaxed) < STDERR_NORMAL_LINES {
                    crate::debug_report::record_now(value);
                } else {
                    crate::debug_report::trace_now(value);
                }
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
    shared.spans = spans;
    drop(shared);
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

/// The overlay's beat: exactly the reasons it holds now ("lookup", "navigation", "regionEditor"
/// while the setting is on; "freeze" whatever it is). Sent every 500 ms while any is held, at once
/// when one starts, and once with none when they all end.
#[tauri::command]
pub fn game_pause_beat(reasons: Vec<String>) {
    send(Input::Beat(reasons.iter().filter_map(|r| manager::Reason::parse(r)).collect()));
}

/// The escape hatch ("Resume paused game", Settings and the tray): resume everything now,
/// including whatever the journal names from an earlier run.
#[tauri::command]
pub async fn game_pause_resume_all(app: tauri::AppHandle) -> Value {
    // Waits for the resume and the journal: never on the main thread.
    tauri::async_runtime::spawn_blocking(move || resume_all(&app)).await.unwrap_or(Value::Null)
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
