//! Game pause backend for Windows: suspends the game's processes with the handle-bound process
//! state change where Windows has it (Windows 11; closing the handle — the guard dying included —
//! resumes the game by itself), else `NtSuspendProcess`. No injection, and no message is ever
//! sent to the game. The mechanism is in `windows_suspend.rs`; this file fits it to
//! [`Backend`].
//!
//! Where state lives: `plan` runs in the app and keeps nothing. `suspend`, `resume` and `refresh`
//! run in the guard process, and the backend value there holds every frozen process's handles
//! (and each thread's pre-pause suspend count) until it resumes it. A member this value does not
//! hold — an orphan named by the journal after a crash — is resumed only if its identity still
//! matches and it is still fully frozen.
use std::path::PathBuf;
use std::sync::Mutex;

use super::super::backend::{
    Backend, Excluded, GameRef, Member, PauseError, PidResult, Plan, ProcIdentity, Refusal, RefusalKind, Role,
    Suspended,
};

#[path = "windows_suspend.rs"]
mod suspend;

use suspend::{FreezeError, Frozen, Identity, Planned, Recovery, Threads};

pub const SUPPORTED: bool = true;

pub fn backend() -> Box<dyn Backend> {
    Box::new(WindowsBackend::default())
}

/// The mechanism's name for logs and the plan.
fn mechanism() -> &'static str {
    if suspend::state_change_available() {
        "process state change"
    } else {
        "NtSuspendProcess"
    }
}

fn refusal(r: &suspend::Refusal) -> Refusal {
    use suspend::Refusal as R;
    let kind = match r {
        R::NoPid => RefusalKind::NoPid,
        R::OwnProcess => RefusalKind::Denylisted,
        R::System | R::Protected => RefusalKind::Protected,
        R::OtherUser | R::Elevated => RefusalKind::Elevated,
        R::Gone => RefusalKind::NotFound,
        R::Denied(_) => RefusalKind::PermissionDenied,
        R::Unsupported => RefusalKind::Unsupported,
    };
    Refusal::new(kind, format!("{} ({})", r.message(), r.code()))
}

fn proc_identity(id: &Identity) -> ProcIdentity {
    ProcIdentity { pid: id.pid, start: id.created, exe: id.exe.to_string_lossy().into_owned() }
}

fn identity(id: &ProcIdentity) -> Identity {
    Identity { pid: id.pid, created: id.start, exe: PathBuf::from(&id.exe) }
}

fn role(role: suspend::Role) -> Role {
    match role {
        suspend::Role::Window => Role::Main,
        suspend::Role::EngineChild | suspend::Role::SameProgram => Role::Child,
    }
}

fn why(role: suspend::Role) -> &'static str {
    match role {
        suspend::Role::Window => "owns the game window",
        suspend::Role::EngineChild => "the launcher's engine process",
        suspend::Role::SameProgram => "a child running the same program",
    }
}

fn planned(member: &Member) -> Planned {
    Planned {
        identity: identity(&member.id),
        role: if member.role == Role::Main { suspend::Role::Window } else { suspend::Role::SameProgram },
    }
}

fn frozen_result(step: &suspend::Step) -> PidResult {
    let mut note = step.mechanism.to_string();
    if step.escaped > 0 {
        note.push_str(&format!(", {} escaped thread(s) caught", step.escaped));
    }
    if step.corrected > 0 {
        note.push_str(&format!(", {} thread count(s) corrected", step.corrected));
    }
    if let Some(error) = &step.error {
        note.push_str(&format!(", {error}"));
    }
    PidResult { pid: step.pid, ok: step.error.is_none(), code: None, note, micros: step.micros }
}

#[derive(Default)]
pub struct WindowsBackend {
    /// Every process this value froze and has not resumed, in stop order.
    held: Mutex<Vec<Frozen>>,
    /// Forces the mechanism (tests run both); `None` picks the best available.
    state_change: Option<bool>,
}

impl WindowsBackend {
    /// Freeze one member; `Ok(None)` when a child is gone (no longer part of the game) or the
    /// member is already stopped by someone else (left alone, never ours to continue). `before`
    /// lists the threads just before the step; the caller catches escaped threads afterwards
    /// (`suspend::catch_escaped`, with one list for every member).
    fn freeze(&self, member: &Member, before: &Threads) -> Result<Option<(Frozen, suspend::Step)>, PauseError> {
        if stopped(&member.id, before) == Some(true) {
            return Ok(None);
        }
        let state_change = self.state_change.unwrap_or_else(suspend::prefer_state_change);
        match suspend::freeze_one(&planned(member), state_change, before) {
            Ok(done) => Ok(Some(done)),
            Err(FreezeError::Refused(suspend::Refusal::Gone)) if member.role != Role::Main => Ok(None),
            Err(FreezeError::Refused(r)) => {
                let r2 = refusal(&r);
                Err(PauseError {
                    pid: Some(member.id.pid),
                    code: match r {
                        suspend::Refusal::Denied(code) => Some(i64::from(code)),
                        _ => None,
                    },
                    refusal: Some(r2.kind),
                    ..PauseError::new(r2.detail)
                })
            }
            Err(FreezeError::Suspend { pid, status }) => Err(PauseError {
                pid: Some(pid),
                code: Some(i64::from(status)),
                // STATUS_ACCESS_DENIED: Windows will not let this game be paused.
                refusal: (status == 0xC000_0022).then_some(RefusalKind::PermissionDenied),
                ..PauseError::new(format!("suspending pid {pid} failed"))
            }),
        }
    }
}

/// Fully frozen (every listed thread suspended), by anyone. `None` when the pid is gone or now
/// names another process.
fn stopped(id: &ProcIdentity, threads: &Threads) -> Option<bool> {
    let now = suspend::identity(id.pid)?;
    (now.created == id.start).then(|| suspend::is_frozen_in(threads, id.pid))
}

/// Resume processes in reverse stop order, with one thread list taken while they are all frozen.
fn thaw_all(frozen: Vec<Frozen>) -> Vec<suspend::Step> {
    if frozen.is_empty() {
        return Vec::new();
    }
    let threads = Threads::now();
    frozen.into_iter().rev().map(|f| suspend::thaw(f, &threads)).collect()
}

impl Backend for WindowsBackend {
    fn name(&self) -> &'static str {
        "windows-nt"
    }

    fn plan(&self, game: &GameRef) -> Result<Plan, Refusal> {
        let pid = game.pid.ok_or_else(|| Refusal::new(RefusalKind::NoPid, "no window process for the selection"))?;
        let tree = suspend::plan(pid).map_err(|r| refusal(&r))?;
        Ok(Plan {
            game: game.clone(),
            members: tree
                .processes
                .iter()
                .map(|p| Member { id: proc_identity(&p.identity), role: role(p.role), why: why(p.role).into() })
                .collect(),
            excluded: tree.excluded.into_iter().map(|e| Excluded { pid: e.pid, exe: e.name, why: e.why }).collect(),
            mechanism: mechanism().into(),
        })
    }

    fn suspend(&self, plan: &Plan) -> Result<Suspended, PauseError> {
        let mut done: Vec<(Frozen, suspend::Step)> = Vec::new();
        let mut results = Vec::new();
        let before = Threads::now();
        for member in &plan.members {
            match self.freeze(member, &before) {
                Ok(Some(frozen)) => done.push(frozen),
                Ok(None) => results.push(PidResult {
                    pid: member.id.pid,
                    ok: true,
                    code: None,
                    note: "exited, or already stopped by someone else; left alone".into(),
                    micros: 0,
                }),
                Err(mut error) => {
                    // All or nothing.
                    let (frozen, steps): (Vec<_>, Vec<_>) = done.into_iter().unzip();
                    results.extend(steps.iter().chain(&thaw_all(frozen)).map(frozen_result));
                    results.push(PidResult {
                        pid: member.id.pid,
                        ok: false,
                        code: error.code,
                        note: error.message.clone(),
                        micros: 0,
                    });
                    error.results = results;
                    return Err(error);
                }
            }
        }
        // Threads started while the calls ran: one list, taken once every process is suspended.
        let after = Threads::now();
        let done: Vec<Frozen> = done
            .into_iter()
            .map(|(mut frozen, mut step)| {
                step.escaped = suspend::catch_escaped(&mut frozen, &after);
                results.push(frozen_result(&step));
                frozen
            })
            .collect();
        let members = done.iter().map(|f| proc_identity(&f.identity)).collect();
        let used = done.first().map_or(mechanism(), |f| match f.mechanism {
            suspend::Mechanism::StateChange => "process state change",
            suspend::Mechanism::SuspendProcess => "NtSuspendProcess",
        });
        self.held.lock().unwrap_or_else(|e| e.into_inner()).extend(done);
        Ok(Suspended { game: plan.game.clone(), members, mechanism: used.into(), results })
    }

    fn resume(&self, suspended: &Suspended) -> Result<(), PauseError> {
        let mut failures = Vec::new();
        let mut results = Vec::new();
        // Listed while every member is still frozen, and shared by all of them.
        let threads = Threads::now();
        for id in suspended.members.iter().rev() {
            let held = {
                let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
                held.iter()
                    .rposition(|f| f.identity.pid == id.pid && f.identity.created == id.start)
                    .map(|i| held.remove(i))
            };
            let result = match held {
                Some(frozen) => frozen_result(&suspend::thaw(frozen, &threads)),
                // Not ours (an orphan, or already resumed): only if it is still this process
                // and still fully frozen.
                None => match suspend::recover(&identity(id), &threads) {
                    Recovery::Resumed { corrected } => PidResult {
                        pid: id.pid,
                        ok: true,
                        code: None,
                        note: format!("orphan resumed, {corrected} thread count(s) corrected"),
                        micros: 0,
                    },
                    Recovery::NotFrozen => {
                        PidResult { pid: id.pid, ok: true, code: None, note: "not frozen".into(), micros: 0 }
                    }
                    Recovery::Mismatch => PidResult {
                        pid: id.pid,
                        ok: true,
                        code: None,
                        note: "gone or pid reused; left alone".into(),
                        micros: 0,
                    },
                },
            };
            if !result.ok {
                failures.push(result.clone());
            }
            results.push(result);
        }
        match failures.first() {
            None => Ok(()),
            Some(first) => Err(PauseError {
                pid: Some(first.pid),
                results,
                ..PauseError::new(format!(
                    "resume incomplete: {}",
                    failures.iter().map(|f| format!("pid {}: {}", f.pid, f.note)).collect::<Vec<_>>().join("; ")
                ))
            }),
        }
    }

    fn identity(&self, pid: u32) -> Option<ProcIdentity> {
        suspend::identity(pid).map(|id| proc_identity(&id))
    }

    fn stopped(&self, id: &ProcIdentity) -> Option<bool> {
        stopped(id, &Threads::now())
    }

    /// Catch threads created since the suspend (each held process), and children the game started
    /// since (frozen and added as members).
    fn refresh(&self, suspended: &mut Suspended) -> Result<(), PauseError> {
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        let threads = Threads::now();
        for frozen in held.iter_mut() {
            suspend::catch_escaped(frozen, &threads);
        }
        let Some(main) = suspended.members.first().map(|m| m.pid) else { return Ok(()) };
        // A protected or vanished child is left out; the game stays paused as planned.
        let Ok(tree) = suspend::plan(main) else { return Ok(()) };
        let mut added = Vec::new();
        for p in tree.processes {
            let known =
                held.iter().any(|f| f.identity.pid == p.identity.pid && f.identity.created == p.identity.created);
            if known {
                continue;
            }
            let member = Member { id: proc_identity(&p.identity), role: role(p.role), why: why(p.role).into() };
            if let Ok(Some((frozen, _))) = self.freeze(&member, &threads) {
                suspended.members.push(member.id);
                added.push(frozen);
            }
        }
        if !added.is_empty() {
            let after = Threads::now();
            for frozen in &mut added {
                suspend::catch_escaped(frozen, &after);
            }
            held.extend(added);
        }
        Ok(())
    }
}

impl Drop for WindowsBackend {
    /// The guard is going away holding a pause: resume it (closing a state change handle would
    /// too, `NtSuspendProcess` would not).
    fn drop(&mut self) {
        thaw_all(std::mem::take(&mut *self.held.lock().unwrap_or_else(|e| e.into_inner())));
    }
}

#[cfg(test)]
#[path = "windows_tests.rs"]
mod tests;
