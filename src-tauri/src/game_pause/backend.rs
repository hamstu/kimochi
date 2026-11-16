//! What every OS backend implements, and the types shared between the app, the guard process and
//! the journal. Everything here is plain data (serde) except [`Backend`] itself: a plan is made in
//! the app, sent to the guard as JSON, carried out there, and written to the journal.
//!
//! Where it runs: [`Backend::plan`] runs in the app (it needs the selection). [`Backend::suspend`],
//! [`Backend::resume`] and [`Backend::refresh`] run only in the guard process, which owns every
//! pause; a backend that needs per-pause state (Windows keeps the process handles open) keeps it
//! inside its own value there. [`Backend::identity`] runs in both, and in orphan recovery.
use serde::{Deserialize, Serialize};

/// What the app knows about the game when a pause is asked for. Every field is optional except the
/// window's process: a backend uses what it needs and refuses with [`RefusalKind::NoPid`] when
/// that is not enough.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameRef {
    /// The process that owns the selected (or frontmost) game window.
    pub pid: Option<u32>,
    /// The capture source id string of the selection, when one is selected (`SourceId`).
    pub source: Option<String>,
    /// The native window handle/XID, as the source id carries it, when known.
    pub window: Option<u64>,
    /// Gaming Mode: the Steam app id Gamescope shows in front (`GAMESCOPE_FOCUSABLE_APPS`).
    pub steam_app_id: Option<u32>,
    /// The window's title, for logs and the refusal notice only.
    pub title: Option<String>,
}

impl GameRef {
    /// The key the one-time refusal notice and the logs use for "this game".
    pub fn key(&self) -> String {
        if let Some(id) = self.steam_app_id {
            return format!("steam:{id}");
        }
        match (&self.source, self.pid) {
            (Some(source), _) => source.clone(),
            (None, Some(pid)) => format!("pid:{pid}"),
            (None, None) => "unknown".into(),
        }
    }
}

/// A process as it was when it was looked at. `start` is the OS's process start time in whatever
/// unit it reports (Linux: `starttime` clock ticks from `/proc/<pid>/stat`; Windows: creation
/// FILETIME; macOS: start time in microseconds since the epoch), so `pid` + `start` names one
/// process for its whole life and never a later one that reused the pid.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcIdentity {
    pub pid: u32,
    pub start: u64,
    /// The executable's path (or name when the path cannot be read). Logged; never compared.
    pub exe: String,
}

impl ProcIdentity {
    /// Whether `now` (a fresh [`Backend::identity`]) is still this process.
    pub fn same_process(&self, now: &ProcIdentity) -> bool {
        self.pid == now.pid && self.start == now.start
    }
}

/// Why a process is part of the game. Logged in verbose plans.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    /// Owns the game window.
    Main,
    /// A descendant of the main process (or of the per-game launcher).
    Child,
    /// A launcher or wrapper that belongs to this game only.
    Launcher,
    /// A process outside the tree that still belongs to this game (same Wine prefix, same bundle,
    /// same game directory, a Wine server for this prefix).
    Sibling,
}

/// One process to stop.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: ProcIdentity,
    pub role: Role,
    /// Why it is included, in a few words ("descendant of reaper AppId=1234").
    pub why: String,
}

/// A process the plan looked at and left out, with why (verbose logs only).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Excluded {
    pub pid: u32,
    pub exe: String,
    pub why: String,
}

/// Every process that must stop for a game, in stop order (resume goes in reverse).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub game: GameRef,
    pub members: Vec<Member>,
    #[serde(default)]
    pub excluded: Vec<Excluded>,
    /// The mechanism, for logs ("SIGSTOP", "NtSuspendProcess", "process state change").
    pub mechanism: String,
}

/// Why a game cannot be paused. Shown to the reader once per game (non-blocking); input isolation
/// carries on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefusalKind {
    /// This build has no backend for the OS (or the session type).
    Unsupported,
    /// The window's process is unknown (a display is selected, or the window has no pid).
    NoPid,
    /// The process is gone.
    NotFound,
    /// A protected process (Windows PPL, a system image, a Store app container).
    Protected,
    /// Anti-cheat present or detected.
    AntiCheat,
    /// Runs elevated / as another user than Kimochi.
    Elevated,
    /// A process on the hard denylist (compositor, Steam client, audio server, Kimochi itself).
    Denylisted,
    /// The OS said no (`OpenProcess`/`kill` failed with access denied).
    PermissionDenied,
    /// Anything else; the detail says what.
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub kind: RefusalKind,
    /// For logs: which process and what the check found ("anticheat.sys loaded", "pid 4 is System").
    pub detail: String,
}

impl Refusal {
    pub fn new(kind: RefusalKind, detail: impl Into<String>) -> Self {
        Refusal { kind, detail: detail.into() }
    }
    pub fn unsupported() -> Self {
        Refusal::new(RefusalKind::Unsupported, "no game pause backend on this system")
    }
}

/// What happened to one process in a suspend or resume (verbose logs).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PidResult {
    pub pid: u32,
    pub ok: bool,
    /// errno / NTSTATUS / Win32 error, when there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    /// How long this process took, in microseconds.
    #[serde(default)]
    pub micros: u64,
}

/// What a successful suspend stopped. It is what gets written to the journal and handed back to
/// [`Backend::resume`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suspended {
    pub game: GameRef,
    /// The processes that are stopped now, in the order they were stopped.
    pub members: Vec<ProcIdentity>,
    pub mechanism: String,
    #[serde(default)]
    pub results: Vec<PidResult>,
}

/// A suspend or resume that failed. `suspend` returns it only after it has rolled back what it
/// had stopped; `resume` returns it after trying every process.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i64>,
    /// When the failure means "this game cannot be paused" (access denied, protected), the
    /// refusal to show; otherwise a transient error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refusal: Option<RefusalKind>,
    #[serde(default)]
    pub results: Vec<PidResult>,
}

impl PauseError {
    pub fn new(message: impl Into<String>) -> Self {
        PauseError { message: message.into(), pid: None, code: None, refusal: None, results: Vec::new() }
    }
}

impl std::fmt::Display for PauseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)?;
        if let Some(pid) = self.pid {
            write!(f, " (pid {pid}")?;
            if let Some(code) = self.code {
                write!(f, ", code {code}")?;
            }
            write!(f, ")")?;
        }
        Ok(())
    }
}

/// The per-OS mechanism. Implementations must be `Send + Sync`; the guard calls them from one
/// thread, the app from several.
pub trait Backend: Send + Sync {
    /// A short name for logs ("linux-sigstop", "windows-nt", "macos-sigstop", "fake").
    fn name(&self) -> &'static str;

    /// Every process that must stop for `game`, in stop order. Refuse (never panic) when the game
    /// cannot be paused safely: protected/anti-cheat/elevated/denylisted/other user's/Kimochi's
    /// own processes, or no pid. Must not change anything.
    fn plan(&self, game: &GameRef) -> Result<Plan, Refusal>;

    /// Stops every member of `plan`, all or nothing: on any failure, resumes what it had stopped
    /// and returns the error. Must check each member's identity right before stopping it and never
    /// stop a process whose identity changed (pid reuse). Never makes a synchronous call into the
    /// game.
    fn suspend(&self, plan: &Plan) -> Result<Suspended, PauseError>;

    /// Resumes every process of `suspended`, in reverse order. Idempotent; best effort on every
    /// pid (one failure does not stop the others); skips any pid whose identity no longer matches.
    /// Returns an error listing what failed after trying all of them.
    fn resume(&self, suspended: &Suspended) -> Result<(), PauseError>;

    /// The identity of `pid` now, or `None` when it is gone or cannot be read.
    fn identity(&self, pid: u32) -> Option<ProcIdentity>;

    /// Called by the guard about once a second while paused: catch threads or children that
    /// escaped a non-atomic suspend, re-check stopped state. May add members. Default: nothing.
    fn refresh(&self, _suspended: &mut Suspended) -> Result<(), PauseError> {
        Ok(())
    }
}

/// Whether this build can pause games, for the settings UI (`game_pause_status`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub supported: bool,
    pub backend: String,
    /// Shown under the setting when unsupported or limited ("Not available on this system yet").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The backend of a platform that cannot pause games (yet).
pub struct Unsupported;

impl Backend for Unsupported {
    fn name(&self) -> &'static str {
        "unsupported"
    }
    fn plan(&self, _game: &GameRef) -> Result<Plan, Refusal> {
        Err(Refusal::unsupported())
    }
    fn suspend(&self, _plan: &Plan) -> Result<Suspended, PauseError> {
        Err(PauseError { refusal: Some(RefusalKind::Unsupported), ..PauseError::new("unsupported") })
    }
    fn resume(&self, _suspended: &Suspended) -> Result<(), PauseError> {
        Ok(())
    }
    fn identity(&self, _pid: u32) -> Option<ProcIdentity> {
        None
    }
}

#[cfg(test)]
pub mod fake {
    //! An in-memory process table that records every suspend and resume, with failures to order.
    use super::*;
    use std::collections::{BTreeMap, HashSet};
    use std::sync::Mutex;

    #[derive(Clone, Debug)]
    pub struct FakeProc {
        pub start: u64,
        pub exe: String,
        pub parent: Option<u32>,
        pub stopped: bool,
    }

    #[derive(Default)]
    pub struct FakeState {
        pub procs: BTreeMap<u32, FakeProc>,
        /// Pids whose suspend fails (to test rollback).
        pub fail_suspend: HashSet<u32>,
        /// Pids whose resume fails.
        pub fail_resume: HashSet<u32>,
        /// Pids the plan refuses with this kind.
        pub refuse: Option<RefusalKind>,
        /// Every call, in order: "stop 10", "cont 10".
        pub calls: Vec<String>,
    }

    #[derive(Default)]
    pub struct Fake {
        pub state: Mutex<FakeState>,
    }

    impl Fake {
        pub fn new() -> Self {
            Fake::default()
        }
        pub fn spawn(&self, pid: u32, start: u64, parent: Option<u32>) {
            self.state
                .lock()
                .unwrap()
                .procs
                .insert(pid, FakeProc { start, exe: format!("/games/proc{pid}.exe"), parent, stopped: false });
        }
        /// The process exits; `respawn` makes a new process reuse its pid.
        pub fn exit(&self, pid: u32) {
            self.state.lock().unwrap().procs.remove(&pid);
        }
        pub fn stopped(&self, pid: u32) -> bool {
            self.state.lock().unwrap().procs.get(&pid).is_some_and(|p| p.stopped)
        }
        pub fn any_stopped(&self) -> bool {
            self.state.lock().unwrap().procs.values().any(|p| p.stopped)
        }
        pub fn calls(&self) -> Vec<String> {
            self.state.lock().unwrap().calls.clone()
        }
    }

    impl Backend for Fake {
        fn name(&self) -> &'static str {
            "fake"
        }
        fn plan(&self, game: &GameRef) -> Result<Plan, Refusal> {
            let state = self.state.lock().unwrap();
            if let Some(kind) = state.refuse {
                return Err(Refusal::new(kind, "fake refusal"));
            }
            let root = game.pid.ok_or_else(|| Refusal::new(RefusalKind::NoPid, "no pid"))?;
            let proc = state.procs.get(&root).ok_or_else(|| Refusal::new(RefusalKind::NotFound, "gone"))?;
            let mut members = vec![Member {
                id: ProcIdentity { pid: root, start: proc.start, exe: proc.exe.clone() },
                role: Role::Main,
                why: "window owner".into(),
            }];
            let mut frontier = vec![root];
            while let Some(parent) = frontier.pop() {
                for (pid, p) in state.procs.iter().filter(|(_, p)| p.parent == Some(parent)) {
                    members.push(Member {
                        id: ProcIdentity { pid: *pid, start: p.start, exe: p.exe.clone() },
                        role: Role::Child,
                        why: format!("child of {parent}"),
                    });
                    frontier.push(*pid);
                }
            }
            Ok(Plan { game: game.clone(), members, excluded: Vec::new(), mechanism: "fake-stop".into() })
        }
        fn suspend(&self, plan: &Plan) -> Result<Suspended, PauseError> {
            let mut state = self.state.lock().unwrap();
            let mut done: Vec<ProcIdentity> = Vec::new();
            for member in &plan.members {
                let pid = member.id.pid;
                let matches = state.procs.get(&pid).is_some_and(|p| p.start == member.id.start);
                if !matches || state.fail_suspend.contains(&pid) {
                    for id in done.iter().rev() {
                        if let Some(p) = state.procs.get_mut(&id.pid) {
                            p.stopped = false;
                        }
                        state.calls.push(format!("cont {}", id.pid));
                    }
                    let message = if matches { "fake suspend failure" } else { "identity changed" };
                    return Err(PauseError { pid: Some(pid), ..PauseError::new(message) });
                }
                state.procs.get_mut(&pid).unwrap().stopped = true;
                state.calls.push(format!("stop {pid}"));
                done.push(member.id.clone());
            }
            Ok(Suspended {
                game: plan.game.clone(),
                members: done,
                mechanism: plan.mechanism.clone(),
                results: Vec::new(),
            })
        }
        fn resume(&self, suspended: &Suspended) -> Result<(), PauseError> {
            let mut state = self.state.lock().unwrap();
            let mut failed = None;
            for id in suspended.members.iter().rev() {
                if state.fail_resume.contains(&id.pid) {
                    failed = Some(id.pid);
                    continue;
                }
                match state.procs.get_mut(&id.pid) {
                    Some(p) if p.start == id.start => {
                        p.stopped = false;
                        state.calls.push(format!("cont {}", id.pid));
                    }
                    _ => state.calls.push(format!("skip {}", id.pid)),
                }
            }
            match failed {
                Some(pid) => Err(PauseError { pid: Some(pid), ..PauseError::new("fake resume failure") }),
                None => Ok(()),
            }
        }
        fn identity(&self, pid: u32) -> Option<ProcIdentity> {
            let state = self.state.lock().unwrap();
            state.procs.get(&pid).map(|p| ProcIdentity { pid, start: p.start, exe: p.exe.clone() })
        }
    }
}
