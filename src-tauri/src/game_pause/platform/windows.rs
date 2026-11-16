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

use suspend::{FreezeError, Frozen, Identity, Planned, Recovery};

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
    /// Freeze one member; `Ok(None)` when a child is gone (no longer part of the game).
    fn freeze(&self, member: &Member) -> Result<Option<(Frozen, PidResult)>, PauseError> {
        let state_change = self.state_change.unwrap_or_else(suspend::prefer_state_change);
        match suspend::freeze_one(&planned(member), state_change) {
            Ok((frozen, step)) => Ok(Some((frozen, frozen_result(&step)))),
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
        let mut done: Vec<Frozen> = Vec::new();
        let mut results = Vec::new();
        for member in &plan.members {
            match self.freeze(member) {
                Ok(Some((frozen, result))) => {
                    done.push(frozen);
                    results.push(result);
                }
                Ok(None) => results.push(PidResult {
                    pid: member.id.pid,
                    ok: true,
                    code: None,
                    note: "exited before the pause; skipped".into(),
                    micros: 0,
                }),
                Err(mut error) => {
                    // All or nothing.
                    while let Some(frozen) = done.pop() {
                        results.push(frozen_result(&suspend::thaw(frozen)));
                    }
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
        for id in suspended.members.iter().rev() {
            let held = {
                let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
                held.iter()
                    .rposition(|f| f.identity.pid == id.pid && f.identity.created == id.start)
                    .map(|i| held.remove(i))
            };
            let result = match held {
                Some(frozen) => frozen_result(&suspend::thaw(frozen)),
                // Not ours (an orphan, or already resumed): only if it is still this process
                // and still fully frozen.
                None => match suspend::recover(&identity(id)) {
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

    /// Catch threads created since the suspend (each held process), and children the game started
    /// since (frozen and added as members).
    fn refresh(&self, suspended: &mut Suspended) -> Result<(), PauseError> {
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        for frozen in held.iter_mut() {
            suspend::catch_escaped(frozen);
        }
        let Some(main) = suspended.members.first().map(|m| m.pid) else { return Ok(()) };
        // A protected or vanished child is left out; the game stays paused as planned.
        let Ok(tree) = suspend::plan(main) else { return Ok(()) };
        for p in tree.processes {
            let known =
                held.iter().any(|f| f.identity.pid == p.identity.pid && f.identity.created == p.identity.created);
            if known {
                continue;
            }
            let member = Member { id: proc_identity(&p.identity), role: role(p.role), why: why(p.role).into() };
            if let Ok(Some((frozen, _))) = self.freeze(&member) {
                suspended.members.push(member.id);
                held.push(frozen);
            }
        }
        Ok(())
    }
}

impl Drop for WindowsBackend {
    /// The guard is going away holding a pause: resume it (closing a state change handle would
    /// too, `NtSuspendProcess` would not).
    fn drop(&mut self) {
        let held = std::mem::take(&mut *self.held.lock().unwrap_or_else(|e| e.into_inner()));
        for frozen in held.into_iter().rev() {
            let _ = suspend::thaw(frozen);
        }
    }
}

#[cfg(test)]
#[path = "windows_tests.rs"]
mod tests;
