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
    /// Resume what is held. Always answered with `Resumed` (with `count` 0 when nothing was held).
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
        /// Per-process results and notes (`Backend::resume_with_results`), for the verbose log.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        results: Vec<super::backend::PidResult>,
    },
    /// A resume that had failed was tried again: `error` is `None` once those processes run.
    Retried {
        count: usize,
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

/// The first wait before a failed resume is tried again; it doubles up to `RETRY_MAX`.
const RETRY_FIRST: Duration = Duration::from_millis(1000);
const RETRY_MAX: Duration = Duration::from_secs(30);

/// The guard's logic without its I/O, driven by tests with a fake clock.
pub struct Core<'a> {
    backend: &'a dyn Backend,
    journal: Journal,
    held: Option<Held>,
    /// Processes a resume failed to continue: retried with backoff, and kept in the journal (with
    /// whatever a later pause adds) until they run.
    stuck: Option<Suspended>,
    next_retry: Instant,
    retry_wait: Duration,
    last_beat: Instant,
    last_refresh: Instant,
    heartbeat_loss: Duration,
    pid: u32,
}

fn wall_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// `extra`'s members not already in `into`, appended.
fn merge(into: &mut Suspended, extra: &Suspended) {
    for member in &extra.members {
        if !into.members.iter().any(|m| m.pid == member.pid && m.start == member.start) {
            into.members.push(member.clone());
        }
    }
}

impl<'a> Core<'a> {
    pub fn new(backend: &'a dyn Backend, journal: Journal, now: Instant) -> Self {
        Core {
            backend,
            journal,
            held: None,
            stuck: None,
            next_retry: now,
            retry_wait: RETRY_FIRST,
            last_beat: now,
            last_refresh: now,
            heartbeat_loss: HEARTBEAT_LOSS,
            pid: std::process::id(),
        }
    }
    #[cfg(test)]
    pub fn holding(&self) -> bool {
        self.held.is_some()
    }
    #[cfg(test)]
    pub fn stuck(&self) -> usize {
        self.stuck.as_ref().map_or(0, |s| s.members.len())
    }

    /// Resumes orphans of an earlier run, then says it is ready.
    pub fn start(&mut self) -> Reply {
        let recovered = self.journal.recover(self.backend, None);
        Reply::Ready { pid: self.pid, backend: self.backend.name().into(), recovered }
    }

    /// The app is alive now. `serve` calls it after every request is handled, so a slow request
    /// (a suspend that parks audio first) never counts against the heartbeat.
    pub fn touch(&mut self, now: Instant) {
        self.last_beat = now;
    }

    pub fn handle(&mut self, request: Request, now: Instant) -> Vec<Reply> {
        self.last_beat = now;
        match request {
            Request::Beat => Vec::new(),
            Request::Resume { id, reason } => vec![self.release(Some(id), &reason, now).unwrap_or(Reply::Resumed {
                // Nothing held (a suspend that failed, or a resume already done): still answered,
                // so the app never waits for a reply that will not come.
                id: Some(id),
                reason,
                count: 0,
                held_ms: 0,
                error: None,
                results: Vec::new(),
            })],
            Request::Quit => self.release(None, "quit", now).into_iter().collect(),
            Request::Suspend { id, plan } => {
                let mut out: Vec<Reply> = self.release(None, "replaced", now).into_iter().collect();
                out.push(self.suspend(id, plan, now));
                out
            }
        }
    }

    /// The journal entry for what may be stopped now: the pause held (or `pending`, a plan about
    /// to be suspended) and every process a resume failed on. Cleared when there is none.
    fn persist(&self, pending: Option<&Suspended>) -> std::io::Result<()> {
        let mut all = match (pending, &self.held) {
            (Some(p), _) => p.clone(),
            (None, Some(held)) => held.suspended.clone(),
            (None, None) => match &self.stuck {
                Some(stuck) => stuck.clone(),
                None => {
                    self.journal.clear();
                    return Ok(());
                }
            },
        };
        if let Some(stuck) = &self.stuck {
            merge(&mut all, stuck);
        }
        self.journal.write(&Entry {
            game: all.game,
            members: all.members,
            mechanism: all.mechanism,
            at: wall_ms(),
            guard: self.pid,
            boot: super::journal::boot_id(),
        })
    }

    fn suspend(&mut self, id: u64, plan: Plan, now: Instant) -> Reply {
        // The whole plan goes in the journal first: a crash halfway through still names every
        // process that might be stopped. Processes already stopped by someone else are left out:
        // recovery must never continue them.
        let pending = Suspended {
            game: plan.game.clone(),
            members: plan
                .members
                .iter()
                .filter(|m| self.backend.stopped(&m.id) != Some(true))
                .map(|m| m.id.clone())
                .collect(),
            mechanism: plan.mechanism.clone(),
            results: Vec::new(),
        };
        if let Err(e) = self.persist(Some(&pending)) {
            return Reply::Failed { id, error: PauseError::new(format!("journal: {e}")) };
        }
        let started = Instant::now();
        match self.backend.suspend(&plan) {
            Ok(suspended) => {
                self.held = Some(Held { suspended: suspended.clone(), since: now });
                // The plan entry is still there and still covers everything stopped if this fails.
                let _ = self.persist(None);
                self.last_refresh = now;
                Reply::Suspended { id, suspended, micros: started.elapsed().as_micros() as u64 }
            }
            Err(error) => {
                let _ = self.persist(None);
                Reply::Failed { id, error }
            }
        }
    }

    fn release(&mut self, id: Option<u64>, reason: &str, now: Instant) -> Option<Reply> {
        let held = self.held.take()?;
        let (results, error) = match self.backend.resume_with_results(&held.suspended) {
            Ok(results) => (results, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        if error.is_some() {
            // Kept, retried, and still named in the journal until they run (resume is idempotent and
            // skips any pid that is another process now).
            match &mut self.stuck {
                Some(stuck) => merge(stuck, &held.suspended),
                None => self.stuck = Some(held.suspended.clone()),
            }
            self.retry_wait = RETRY_FIRST;
            self.next_retry = now + RETRY_FIRST;
        }
        let _ = self.persist(None);
        Some(Reply::Resumed {
            id,
            reason: reason.into(),
            count: held.suspended.members.len(),
            held_ms: now.saturating_duration_since(held.since).as_millis() as u64,
            error,
            results,
        })
    }

    /// Heartbeat loss, the periodic refresh, and retries of a failed resume. Call often (~100 ms).
    pub fn tick(&mut self, now: Instant) -> Vec<Reply> {
        let mut out = Vec::new();
        if self.stuck.is_some() && now >= self.next_retry {
            if let Some(stuck) = self.stuck.take() {
                match self.backend.resume(&stuck) {
                    Ok(()) => {
                        let _ = self.persist(None);
                        out.push(Reply::Retried { count: stuck.members.len(), error: None });
                    }
                    Err(error) => {
                        self.stuck = Some(stuck.clone());
                        self.retry_wait = (self.retry_wait * 2).min(RETRY_MAX);
                        self.next_retry = now + self.retry_wait;
                        out.push(Reply::Retried { count: stuck.members.len(), error: Some(error) });
                    }
                }
            }
        }
        if self.held.is_none() {
            return out;
        }
        if now.saturating_duration_since(self.last_beat) >= self.heartbeat_loss {
            out.extend(self.release(None, "heartbeat", now));
            return out;
        }
        if now.saturating_duration_since(self.last_refresh) >= REFRESH_EVERY {
            self.last_refresh = now;
            let Some(held) = self.held.as_mut() else { return out };
            let before = held.suspended.members.len();
            let result = self.backend.refresh(&mut held.suspended);
            let after = held.suspended.members.len();
            if after != before {
                let _ = self.persist(None);
            }
            if after != before || result.is_err() {
                out.push(Reply::Refreshed { count: after, error: result.err() });
            }
        }
        out
    }

    /// Resumes on the way out (EOF, signal).
    pub fn shutdown(&mut self, reason: &str, now: Instant) -> Option<Reply> {
        let reply = self.release(None, reason, now);
        // One more try for anything a resume failed on; what still fails stays in the journal.
        if let Some(stuck) = self.stuck.take() {
            if self.backend.resume(&stuck).is_err() {
                self.stuck = Some(stuck);
            }
            let _ = self.persist(None);
        }
        reply
    }
}

impl Drop for Core<'_> {
    fn drop(&mut self) {
        if let Some(held) = self.held.take() {
            if self.backend.resume(&held.suspended).is_err() {
                match &mut self.stuck {
                    Some(stuck) => merge(stuck, &held.suspended),
                    None => self.stuck = Some(held.suspended),
                }
            }
        }
        if let Some(stuck) = self.stuck.take() {
            if self.backend.resume(&stuck).is_err() {
                self.stuck = Some(stuck);
            }
        }
        let _ = self.persist(None);
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
                // The app was alive when it sent this, however long handling it took.
                core.touch(Instant::now());
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
    pub fn spawn(
        journal: &std::path::Path,
        on_reply: impl Fn(Reply) + Send + 'static,
        on_gone: impl FnOnce() + Send + 'static,
        on_stderr: impl Fn(String) + Send + 'static,
    ) -> Result<Client, String> {
        use std::process::{Command, Stdio};
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut command = Command::new(exe);
        command.arg(FLAG).arg(journal).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
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
        // What the backend says on the guard's stderr (notes, warnings) goes to the app's log.
        if let Some(stderr) = child.stderr.take() {
            std::thread::Builder::new()
                .name("game-pause-guard-stderr".into())
                .spawn(move || {
                    for line in std::io::BufReader::new(stderr).lines() {
                        let Ok(line) = line else { break };
                        on_stderr(line);
                    }
                })
                .map_err(|e| e.to_string())?;
        }
        std::thread::Builder::new()
            .name("game-pause-guard".into())
            .spawn(move || {
                for line in std::io::BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if let Ok(reply) = serde_json::from_str::<Reply>(&line) {
                        on_reply(reply);
                    }
                }
                on_gone();
            })
            .map_err(|e| e.to_string())?;
        Ok(Client { child: Some(child), stdin })
    }

    /// How the guard ended: waits up to `wait` for it (and reaps it), else "still running".
    pub fn reap(&mut self, wait: Duration) -> String {
        let deadline = Instant::now() + wait;
        let Some(child) = self.child.as_mut() else { return "unknown".into() };
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.child = None;
                    return status.to_string();
                }
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                Ok(None) => return "still running".into(),
                Err(e) => return format!("unknown: {e}"),
            }
        }
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
