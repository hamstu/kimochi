//! The guard process: the app binary started as `kimochi --game-pause-guard <journal>`, which owns
//! every pause. The app is never the only thing that can resume a game.
//!
//! Protocol: newline-delimited JSON. The app writes [`Request`]s to the guard's stdin and reads
//! [`Reply`]s from its stdout, in order (the guard handles one request at a time, so a `resume`
//! written right after a `suspend` is handled after it). The guard resumes everything it holds:
//! - on `resume` and `quit`;
//! - when no `beat` (or other request) arrived for [`HEARTBEAT_LOSS`] while paused;
//! - on EOF of stdin (the app exited, crashed or was killed);
//! - on SIGTERM/SIGINT/SIGHUP (Unix), and when it unwinds from a panic (`Drop for Core`);
//! - at start, any orphan its journal names (identity-checked).
//!
//! The app sends `beat` only when the reader's UI (or a physically held key) refreshed a hold, so
//! a hung app or a dead webview stops the beats and the guard resumes the game.
use super::backend::{Backend, PauseError, Plan, Suspended};
use super::journal::{Entry, Journal, Recovered};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// The command line flag that runs the guard instead of the app.
pub const FLAG: &str = "--game-pause-guard";
/// How long a pause outlives the last heartbeat.
pub const HEARTBEAT_LOSS: Duration = Duration::from_millis(3000);
/// How often the backend's `refresh` runs while paused.
pub const REFRESH_EVERY: Duration = Duration::from_millis(1000);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    /// Stop the plan's processes. A pause already held is resumed first.
    Suspend { id: u64, plan: Plan },
    /// Resume what is held (no-op when nothing is).
    Resume { id: u64, reason: String },
    /// The reader is still busy: keep holding.
    Beat,
    /// Resume and exit.
    Quit,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum Reply {
    /// The guard is up; `recovered` lists orphans of an earlier run it resumed.
    Ready { pid: u32, backend: String, recovered: Vec<Recovered> },
    /// The suspend `id` succeeded; `micros` is how long it took.
    Suspended { id: u64, suspended: Suspended, micros: u64 },
    /// The suspend `id` failed and was rolled back (nothing is stopped).
    Failed { id: u64, error: PauseError },
    /// Everything held was resumed. `id` is the request that asked, `None` when the guard did it
    /// on its own (`reason`: "heartbeat", "parent-exit", "signal", "replaced", "panic"); `held_ms`
    /// is how long the game was stopped.
    Resumed {
        id: Option<u64>,
        reason: String,
        count: usize,
        held_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<PauseError>,
    },
    /// The backend's `refresh` changed or failed (verbose).
    Refreshed {
        count: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<PauseError>,
    },
}

struct Held {
    suspended: Suspended,
    since: Instant,
}

/// The guard's logic without its I/O, driven by tests with a fake clock.
pub struct Core<'a> {
    backend: &'a dyn Backend,
    journal: Journal,
    held: Option<Held>,
    last_beat: Instant,
    last_refresh: Instant,
    heartbeat_loss: Duration,
    pid: u32,
}

fn wall_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

impl<'a> Core<'a> {
    pub fn new(backend: &'a dyn Backend, journal: Journal, now: Instant) -> Self {
        Core {
            backend,
            journal,
            held: None,
            last_beat: now,
            last_refresh: now,
            heartbeat_loss: HEARTBEAT_LOSS,
            pid: std::process::id(),
        }
    }
    pub fn with_heartbeat_loss(mut self, loss: Duration) -> Self {
        self.heartbeat_loss = loss;
        self
    }
    pub fn holding(&self) -> bool {
        self.held.is_some()
    }

    /// Resumes orphans of an earlier run, then says it is ready.
    pub fn start(&mut self) -> Reply {
        let recovered = self.journal.recover(self.backend, None);
        Reply::Ready { pid: self.pid, backend: self.backend.name().into(), recovered }
    }

    pub fn handle(&mut self, request: Request, now: Instant) -> Vec<Reply> {
        self.last_beat = now;
        match request {
            Request::Beat => Vec::new(),
            Request::Resume { id, reason } => self.release(Some(id), &reason, now).into_iter().collect(),
            Request::Quit => self.release(None, "quit", now).into_iter().collect(),
            Request::Suspend { id, plan } => {
                let mut out: Vec<Reply> = self.release(None, "replaced", now).into_iter().collect();
                out.push(self.suspend(id, plan, now));
                out
            }
        }
    }

    fn suspend(&mut self, id: u64, plan: Plan, now: Instant) -> Reply {
        // The whole plan goes in the journal first: a crash halfway through still names every
        // process that might be stopped.
        let mut entry = Entry {
            game: plan.game.clone(),
            members: plan.members.iter().map(|m| m.id.clone()).collect(),
            mechanism: plan.mechanism.clone(),
            at: wall_ms(),
            guard: self.pid,
        };
        if let Err(e) = self.journal.write(&entry) {
            return Reply::Failed { id, error: PauseError::new(format!("journal: {e}")) };
        }
        let started = Instant::now();
        match self.backend.suspend(&plan) {
            Ok(suspended) => {
                entry.members = suspended.members.clone();
                if self.journal.write(&entry).is_err() {
                    // The plan entry is still there and still covers everything stopped.
                }
                self.held = Some(Held { suspended: suspended.clone(), since: now });
                self.last_refresh = now;
                Reply::Suspended { id, suspended, micros: started.elapsed().as_micros() as u64 }
            }
            Err(error) => {
                self.journal.clear();
                Reply::Failed { id, error }
            }
        }
    }

    fn release(&mut self, id: Option<u64>, reason: &str, now: Instant) -> Option<Reply> {
        let held = self.held.take()?;
        let error = self.backend.resume(&held.suspended).err();
        // A failed resume keeps the journal so the next start retries the ones still matching.
        if error.is_none() {
            self.journal.clear();
        }
        Some(Reply::Resumed {
            id,
            reason: reason.into(),
            count: held.suspended.members.len(),
            held_ms: now.saturating_duration_since(held.since).as_millis() as u64,
            error,
        })
    }

    /// Heartbeat loss and the periodic refresh. Call often (every ~100 ms).
    pub fn tick(&mut self, now: Instant) -> Vec<Reply> {
        if self.held.is_none() {
            return Vec::new();
        }
        if now.saturating_duration_since(self.last_beat) >= self.heartbeat_loss {
            return self.release(None, "heartbeat", now).into_iter().collect();
        }
        if now.saturating_duration_since(self.last_refresh) >= REFRESH_EVERY {
            self.last_refresh = now;
            let Some(held) = self.held.as_mut() else { return Vec::new() };
            let before = held.suspended.members.len();
            let result = self.backend.refresh(&mut held.suspended);
            let after = held.suspended.members.len();
            if after != before {
                let entry = Entry {
                    game: held.suspended.game.clone(),
                    members: held.suspended.members.clone(),
                    mechanism: held.suspended.mechanism.clone(),
                    at: wall_ms(),
                    guard: self.pid,
                };
                let _ = self.journal.write(&entry);
            }
            if after != before || result.is_err() {
                return vec![Reply::Refreshed { count: after, error: result.err() }];
            }
        }
        Vec::new()
    }

    /// Resumes on the way out (EOF, signal).
    pub fn shutdown(&mut self, reason: &str, now: Instant) -> Option<Reply> {
        self.release(None, reason, now)
    }
}

impl Drop for Core<'_> {
    fn drop(&mut self) {
        if let Some(held) = self.held.take() {
            if self.backend.resume(&held.suspended).is_ok() {
                self.journal.clear();
            }
        }
    }
}

static STOP: AtomicBool = AtomicBool::new(false);

/// Runs the guard loop on `input`/`output` until EOF, `quit` or a signal. The guard's `main`.
pub fn serve(backend: &dyn Backend, journal: Journal, input: impl BufRead + Send + 'static, mut output: impl Write) {
    let (tx, rx) = std::sync::mpsc::channel::<Option<Request>>();
    std::thread::spawn(move || {
        for line in input.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            // A line that does not parse is ignored; it still proves the app alive.
            let _ = tx.send(serde_json::from_str(&line).ok());
        }
    });
    let mut core = Core::new(backend, journal, Instant::now());
    let mut say = |reply: &Reply| {
        if let Ok(line) = serde_json::to_string(reply) {
            let _ = writeln!(output, "{line}");
            let _ = output.flush();
        }
    };
    say(&core.start());
    loop {
        if STOP.load(Ordering::Relaxed) {
            if let Some(reply) = core.shutdown("signal", Instant::now()) {
                say(&reply);
            }
            return;
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Some(Request::Quit)) => {
                for reply in core.handle(Request::Quit, Instant::now()) {
                    say(&reply);
                }
                return;
            }
            Ok(Some(request)) => {
                for reply in core.handle(request, Instant::now()) {
                    say(&reply);
                }
            }
            Ok(None) => core.handle(Request::Beat, Instant::now()).into_iter().for_each(|r| say(&r)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                if let Some(reply) = core.shutdown("parent-exit", Instant::now()) {
                    say(&reply);
                }
                return;
            }
        }
        for reply in core.tick(Instant::now()) {
            say(&reply);
        }
    }
}

#[cfg(unix)]
extern "C" fn terminate(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}

/// Runs the guard when the binary was started as one (`main` calls this first). Returns whether it
/// did, in which case the process should exit.
pub fn run_if_invoked() -> bool {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(FLAG) {
        return false;
    }
    let Some(journal) = args.next() else { return true };
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGTERM, terminate as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, terminate as *const () as libc::sighandler_t);
        libc::signal(libc::SIGHUP, terminate as *const () as libc::sighandler_t);
        // The app gone mid-write must not kill the guard before it resumes.
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    let backend = super::platform::backend();
    let stdin = std::io::BufReader::new(std::io::stdin());
    serve(backend.as_ref(), Journal::new(journal), stdin, std::io::stdout());
    true
}

/// The app's end of a guard: spawns it, writes requests, hands each reply to `on_reply` from a
/// reader thread. Dropping it closes stdin, which makes the guard resume and exit.
pub struct Client {
    child: Option<std::process::Child>,
    stdin: Option<std::process::ChildStdin>,
}

impl Client {
    pub fn spawn(journal: &std::path::Path, on_reply: impl Fn(Reply) + Send + 'static) -> Result<Client, String> {
        use std::process::{Command, Stdio};
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut command = Command::new(exe);
        command.arg(FLAG).arg(journal).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        #[cfg(unix)]
        unsafe {
            use std::os::unix::process::CommandExt;
            // Its own session: a Ctrl-C to the app's terminal must not take the guard down with it
            // before it resumes the game; the closed pipe tells it the app is gone.
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|e| format!("game pause guard: {e}"))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("game pause guard: no stdout")?;
        std::thread::Builder::new()
            .name("game-pause-guard".into())
            .spawn(move || {
                for line in std::io::BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if let Ok(reply) = serde_json::from_str::<Reply>(&line) {
                        on_reply(reply);
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Client { child: Some(child), stdin })
    }

    pub fn pid(&self) -> u32 {
        self.child.as_ref().map_or(0, |c| c.id())
    }

    /// Whether the guard process has exited.
    pub fn exited(&mut self) -> bool {
        self.child.as_mut().is_none_or(|c| c.try_wait().ok().flatten().is_some())
    }

    pub fn send(&mut self, request: &Request) -> Result<(), String> {
        let pipe = self.stdin.as_mut().ok_or("game pause guard: pipe closed")?;
        let line = serde_json::to_string(request).map_err(|e| e.to_string())?;
        writeln!(pipe, "{line}").and_then(|_| pipe.flush()).map_err(|e| format!("game pause guard: {e}"))
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        if let Some(mut pipe) = self.stdin.take() {
            let _ = writeln!(pipe, "{}", serde_json::to_string(&Request::Quit).unwrap_or_default());
        }
        // Reap without blocking; never kill the guard (it must get to resume).
        if let Some(mut child) = self.child.take() {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
}
