//! The hold manager: reference-counted holds by reason, the pause state machine and the pause
//! spans, with no I/O. It takes [`Input`]s and returns [`Effect`]s (requests for the guard,
//! events for the UI, log lines), so tests drive it with a fake clock, the fake backend and an
//! in-process guard; the app runs it on one thread (`app.rs`).
//!
//! The rules it keeps:
//! - A pause is wanted while the setting is on and any hold is live. A hold is live from when it
//!   is taken until it is released or goes [`HOLD_STALE`] without a refresh: holds are refreshed
//!   only by the reader's UI (the overlay's beat) or a physically held key, so a dead webview lets
//!   them lapse.
//! - Taking a hold twice, or releasing one never taken, changes nothing.
//! - When the last hold goes, the game resumes once the keys and buttons that drove the overlay
//!   are up (at most [`RELEASE_WAIT`]), so it never sees a release it did not see pressed. A hold
//!   taken again meanwhile cancels that resume.
//! - Forced resumes (setting off, game changed, another app in front, overlay hidden, game gone,
//!   the escape hatch) drop every hold and resume at once; the game is not paused again until the
//!   UI has reported no hold (the next beat with nothing in it), so a stale beat cannot re-pause.
//! - A guard that resumed on its own (heartbeat lost) is treated like a forced resume.
//! - A refusal is shown once per game; while the holds last it is not planned again.
use super::backend::{Backend, GameRef, PauseError, Plan, Refusal, RefusalKind};
use super::guard::{Reply, Request};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

/// A hold not refreshed for this long lapses. The overlay beats every 500 ms.
pub const HOLD_STALE: Duration = Duration::from_millis(2000);
/// The longest a resume waits for the keys and buttons to come up.
pub const RELEASE_WAIT: Duration = Duration::from_millis(1500);
/// How often a beat goes to the guard at most.
pub const BEAT_EVERY: Duration = Duration::from_millis(400);
/// How many finished pause spans are kept.
pub const SPANS_KEPT: usize = 1024;
/// Never more than this many, however recent.
pub const SPANS_CAP: usize = 8192;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    /// A lookup is in progress or a dictionary popup is up.
    Lookup,
    /// Controller navigation: the radial menu, read-along, the region pad.
    Navigation,
    /// The region editor (Quick Shot) or another modal overlay state.
    RegionEditor,
}

impl Reason {
    pub fn parse(text: &str) -> Option<Reason> {
        serde_json::from_value(Value::String(text.into())).ok()
    }
    pub fn name(self) -> &'static str {
        match self {
            Reason::Lookup => "lookup",
            Reason::Navigation => "navigation",
            Reason::RegionEditor => "regionEditor",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    /// A trigger fired (native: controller navigation on, region editor open).
    Hold(Reason),
    /// That trigger ended.
    Release(Reason),
    /// The overlay's beat: exactly the reasons it holds now. Refreshes those, releases the others
    /// that the UI owns.
    Beat(Vec<Reason>),
    SetEnabled(bool),
    /// Resume now and drop every hold; the text says why (logs).
    ForceResume(String),
    /// This process came to the front (never Kimochi): resume unless it is part of the game.
    Frontmost(u32),
    Guard(Reply),
    /// The guard process exited or its pipe broke.
    GuardGone,
    /// Called every ~100 ms.
    Tick,
    /// Changes nothing: the app thread marks it handled (`app::settle`), so a caller knows every
    /// input sent before it has been.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Barrier(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    /// A suspend is with the guard.
    Pausing,
    Paused,
    /// A resume is with the guard.
    Resuming,
}

/// The `game-pause` event and the `game_pause_status` command's state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub phase: Phase,
    pub holds: Vec<Reason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game: Option<String>,
    pub processes: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mechanism: Option<String>,
    /// The last refusal for the current game, if it could not be paused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refusal: Option<Refusal>,
}

/// Shown once per game when a pause was refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub game: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub kind: RefusalKind,
    pub detail: String,
}

/// One suspended interval of the game. `start_ms`/`end_ms` are Unix wall-clock milliseconds, the
/// clock recorded audio uses (`kimochi_capture::audio::now_ms`); `end_ms` is `None` while it lasts.
/// It opens (and is published) right before the suspend is sent to the guard, and closes once the
/// app learns the game runs again: the guard confirmed the resume, resumed on its own, rolled a
/// failed suspend back, or went away. Re-holds while paused do not open another. The monotonic
/// `*_mono` fields are milliseconds on [`Machine::new`]'s epoch.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseSpan {
    pub id: u64,
    pub start_ms: f64,
    pub end_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_mono: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_mono: Option<u64>,
}

/// Spans ended less than this long ago are always kept.
pub const SPANS_MIN_AGE_MS: f64 = 30.0 * 60.0 * 1000.0;

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Send(Request),
    Status(Status),
    Notice(Notice),
    /// A log line: `verbose` ones only when verbose logging is on.
    Log {
        verbose: bool,
        value: Value,
    },
}

/// What the machine needs from the app.
pub trait Context {
    /// The game for the current selection.
    fn game(&self) -> GameRef;
    /// Whether a key or button that drove the overlay is still down.
    fn inputs_held(&self) -> bool;
    /// Whether something that must run again before the game is still stopped (Gaming Mode:
    /// Steam's controller reader). The game resumes after it, within the same bounded wait.
    fn resume_blocked(&self) -> bool {
        false
    }
}

struct Current {
    id: u64,
    game: GameRef,
    plan: Option<Plan>,
    count: usize,
    mechanism: String,
}

pub struct Machine {
    epoch: Instant,
    wall: fn() -> f64,
    enabled: bool,
    holds: BTreeMap<Reason, Instant>,
    phase: Phase,
    current: Option<Current>,
    /// The last hold went at this moment; the resume waits for the inputs.
    released_at: Option<Instant>,
    /// No pause until the UI reported no hold (after a forced resume or a refusal).
    suppressed: bool,
    refusal: Option<Refusal>,
    notified: HashSet<String>,
    next_id: u64,
    last_beat_sent: Option<Instant>,
    spans: VecDeque<PauseSpan>,
}

impl Machine {
    /// `wall` is the spans' wall clock (`kimochi_capture::audio::now_ms` in the app).
    pub fn new(epoch: Instant, wall: fn() -> f64) -> Self {
        Machine {
            epoch,
            wall,
            enabled: false,
            holds: BTreeMap::new(),
            phase: Phase::Idle,
            current: None,
            released_at: None,
            suppressed: false,
            refusal: None,
            notified: HashSet::new(),
            next_id: 1,
            last_beat_sent: None,
            spans: VecDeque::new(),
        }
    }

    /// Every process of the pause in effect, from the suspend request until the resume is confirmed.
    pub fn paused_pids(&self) -> Vec<u32> {
        if self.phase == Phase::Idle {
            return Vec::new();
        }
        let Some(current) = &self.current else { return Vec::new() };
        let mut pids: Vec<u32> = current.plan.iter().flat_map(|p| p.members.iter().map(|m| m.id.pid)).collect();
        pids.extend(current.game.pid);
        pids.sort_unstable();
        pids.dedup();
        pids
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn holds(&self) -> Vec<Reason> {
        self.holds.keys().copied().collect()
    }
    /// Every pause span still kept, oldest first (the last may be open).
    pub fn spans(&self) -> Vec<PauseSpan> {
        self.spans.iter().copied().collect()
    }
    fn ms(&self, at: Instant) -> u64 {
        at.saturating_duration_since(self.epoch).as_millis() as u64
    }

    pub fn status(&self) -> Status {
        Status {
            enabled: self.enabled,
            phase: self.phase,
            holds: self.holds(),
            game: self.current.as_ref().map(|c| c.game.key()),
            processes: self.current.as_ref().map_or(0, |c| c.count),
            mechanism: self.current.as_ref().map(|c| c.mechanism.clone()).filter(|m| !m.is_empty()),
            refusal: self.refusal.clone(),
        }
    }

    pub fn handle(&mut self, input: Input, now: Instant, backend: &dyn Backend, cx: &dyn Context) -> Vec<Effect> {
        let mut out = Vec::new();
        let before = (self.phase, self.holds(), self.enabled);
        match input {
            Input::Hold(reason) => {
                if self.holds.insert(reason, now).is_none() {
                    self.log_verbose(&mut out, json!({ "hold": reason.name(), "taken": true }));
                }
                self.beat(&mut out, now);
            }
            Input::Release(reason) => {
                if self.holds.remove(&reason).is_some() {
                    self.log_verbose(&mut out, json!({ "hold": reason.name(), "taken": false }));
                }
            }
            Input::Beat(reasons) => {
                if reasons.is_empty() {
                    self.suppressed = false;
                }
                // The UI owns lookup and the region editor outright; navigation is also taken
                // natively, and a beat without it ends it only after that native hold went stale.
                for reason in [Reason::Lookup, Reason::RegionEditor] {
                    if !reasons.contains(&reason) && self.holds.remove(&reason).is_some() {
                        self.log_verbose(&mut out, json!({ "hold": reason.name(), "taken": false, "by": "beat" }));
                    }
                }
                for reason in reasons {
                    if self.holds.insert(reason, now).is_none() {
                        self.log_verbose(&mut out, json!({ "hold": reason.name(), "taken": true, "by": "beat" }));
                    }
                }
                self.beat(&mut out, now);
            }
            Input::SetEnabled(on) => {
                self.enabled = on;
                if !on {
                    self.force(&mut out, "setting turned off", now);
                }
            }
            Input::ForceResume(why) => self.force(&mut out, &why, now),
            Input::Frontmost(pid) => {
                let ours = self.current.as_ref().is_some_and(|c| {
                    c.game.pid == Some(pid)
                        || c.plan.as_ref().is_some_and(|p| p.members.iter().any(|m| m.id.pid == pid))
                });
                if !ours && matches!(self.phase, Phase::Pausing | Phase::Paused) {
                    self.log(&mut out, json!({ "frontmost": pid }));
                    self.force(&mut out, "another app came to the front", now);
                }
            }
            Input::Guard(reply) => self.on_reply(&mut out, reply, now),
            Input::GuardGone => {
                if self.phase != Phase::Idle {
                    self.log(&mut out, json!({ "guard": "gone", "phase": self.phase }));
                    self.end_span(now);
                    self.phase = Phase::Idle;
                    self.current = None;
                    self.suppressed = !self.holds.is_empty();
                    self.holds.clear();
                }
            }
            Input::Barrier(_) => {}
            Input::Tick => {
                let stale: Vec<Reason> = self
                    .holds
                    .iter()
                    .filter(|(_, at)| now.saturating_duration_since(**at) >= HOLD_STALE)
                    .map(|(r, _)| *r)
                    .collect();
                for reason in stale {
                    self.holds.remove(&reason);
                    self.log_verbose(&mut out, json!({ "hold": reason.name(), "taken": false, "by": "stale" }));
                }
                // The game exited while paused (its window is gone with it).
                if self.phase == Phase::Paused {
                    if let Some(main) = self.current.as_ref().and_then(|c| c.plan.as_ref()?.members.first().cloned()) {
                        let alive = backend.identity(main.id.pid).is_some_and(|now| main.id.same_process(&now));
                        if !alive {
                            self.force(&mut out, "the game exited", now);
                        }
                    }
                }
            }
        }
        self.reconcile(&mut out, now, backend, cx);
        if before != (self.phase, self.holds(), self.enabled) {
            out.push(Effect::Status(self.status()));
        }
        out
    }

    fn wanted(&self) -> bool {
        self.enabled && !self.holds.is_empty() && !self.suppressed
    }

    fn beat(&mut self, out: &mut Vec<Effect>, now: Instant) {
        if !matches!(self.phase, Phase::Pausing | Phase::Paused) {
            return;
        }
        if self.last_beat_sent.is_some_and(|at| now.saturating_duration_since(at) < BEAT_EVERY) {
            return;
        }
        self.last_beat_sent = Some(now);
        out.push(Effect::Send(Request::Beat));
    }

    fn force(&mut self, out: &mut Vec<Effect>, why: &str, now: Instant) {
        let had_holds = !self.holds.is_empty();
        self.holds.clear();
        self.released_at = None;
        if had_holds || matches!(self.phase, Phase::Pausing | Phase::Paused) {
            self.suppressed = true;
        }
        if matches!(self.phase, Phase::Pausing | Phase::Paused) {
            self.send_resume(out, why, now);
        }
    }

    fn send_resume(&mut self, out: &mut Vec<Effect>, why: &str, _now: Instant) {
        let id = self.next_id;
        self.next_id += 1;
        self.phase = Phase::Resuming;
        self.released_at = None;
        self.log_verbose(out, json!({ "resume": "asked", "reason": why, "id": id }));
        out.push(Effect::Send(Request::Resume { id, reason: why.into() }));
    }

    fn reconcile(&mut self, out: &mut Vec<Effect>, now: Instant, backend: &dyn Backend, cx: &dyn Context) {
        if self.wanted() {
            self.released_at = None;
            if self.phase == Phase::Idle {
                self.start_pause(out, now, backend, cx);
            }
            return;
        }
        if self.holds.is_empty() && !self.suppressed {
            // Nothing held any more: a later hold may try again (a refused game too).
            self.refusal = None;
        }
        match self.phase {
            Phase::Pausing => self.send_resume(out, "released", now),
            Phase::Paused => {
                let since = *self.released_at.get_or_insert(now);
                let waited = now.saturating_duration_since(since);
                if (cx.inputs_held() || cx.resume_blocked()) && waited < RELEASE_WAIT {
                    return;
                }
                if waited > Duration::ZERO {
                    self.log_verbose(out, json!({ "resume": "waited for release", "ms": waited.as_millis() as u64 }));
                }
                self.send_resume(out, "released", now);
            }
            Phase::Idle | Phase::Resuming => {}
        }
    }

    fn start_pause(&mut self, out: &mut Vec<Effect>, now: Instant, backend: &dyn Backend, cx: &dyn Context) {
        if self.refusal.is_some() {
            return;
        }
        let game = cx.game();
        let planned_at = Instant::now();
        match backend.plan(&game) {
            Err(refusal) => self.refuse(out, &game, refusal),
            Ok(plan) if plan.members.is_empty() => {
                self.refuse(out, &game, Refusal::new(RefusalKind::NotFound, "no process to pause"))
            }
            Ok(plan) => {
                let id = self.next_id;
                self.next_id += 1;
                self.log_verbose(
                    out,
                    json!({
                        "plan": id,
                        "game": game.key(),
                        "mechanism": plan.mechanism,
                        "members": plan.members.iter().map(|m| json!({"pid": m.id.pid, "exe": m.id.exe, "role": m.role, "why": m.why})).collect::<Vec<_>>(),
                        "excluded": plan.excluded,
                        "holds": self.holds(),
                        "planMicros": planned_at.elapsed().as_micros() as u64,
                    }),
                );
                self.current = Some(Current {
                    id,
                    game: game.clone(),
                    count: plan.members.len(),
                    mechanism: plan.mechanism.clone(),
                    plan: Some(plan.clone()),
                });
                self.phase = Phase::Pausing;
                self.last_beat_sent = Some(now);
                let wall = (self.wall)();
                self.spans.push_back(PauseSpan {
                    id,
                    start_ms: wall,
                    end_ms: None,
                    start_mono: Some(self.ms(now)),
                    end_mono: None,
                });
                while self.spans.len() > SPANS_CAP
                    || (self.spans.len() > SPANS_KEPT
                        && self.spans.front().and_then(|s| s.end_ms).is_some_and(|end| wall - end > SPANS_MIN_AGE_MS))
                {
                    self.spans.pop_front();
                }
                out.push(Effect::Send(Request::Suspend { id, plan }));
            }
        }
    }

    fn refuse(&mut self, out: &mut Vec<Effect>, game: &GameRef, refusal: Refusal) {
        let key = game.key();
        let first = self.notified.insert(format!("{key}\u{0}{:?}", refusal.kind));
        let value = json!({ "refused": refusal.kind, "detail": refusal.detail, "game": key, "pid": game.pid });
        if first {
            self.log(out, value);
            out.push(Effect::Notice(Notice {
                game: key,
                title: game.title.clone(),
                kind: refusal.kind,
                detail: refusal.detail.clone(),
            }));
        } else {
            self.log_verbose(out, value);
        }
        self.refusal = Some(refusal);
        out.push(Effect::Status(self.status()));
    }

    fn on_reply(&mut self, out: &mut Vec<Effect>, reply: Reply, now: Instant) {
        match reply {
            Reply::Ready { pid, backend, recovered } => {
                self.log_verbose(out, json!({ "guard": "ready", "pid": pid, "backend": backend }));
                for r in recovered {
                    self.log(out, json!({ "recovered": r.pid, "exe": r.exe, "outcome": r.outcome, "since": r.since, "by": "guard" }));
                }
            }
            Reply::Suspended { id, suspended, micros } => {
                let Some(current) = self.current.as_mut().filter(|c| c.id == id) else { return };
                current.count = suspended.members.len();
                current.mechanism = suspended.mechanism.clone();
                let game = current.game.key();
                if self.phase == Phase::Pausing {
                    self.phase = Phase::Paused;
                }
                self.log(
                    out,
                    json!({ "paused": game, "processes": suspended.members.len(), "mechanism": suspended.mechanism, "micros": micros }),
                );
                if !suspended.results.is_empty() {
                    self.log_verbose(out, json!({ "suspendResults": suspended.results }));
                }
            }
            Reply::Failed { id, error } => {
                let Some(current) = self.current.take().filter(|c| c.id == id) else { return };
                // Published already: closed now that the rollback is done (some processes may have
                // been stopped for a moment).
                self.end_span(now);
                if self.phase == Phase::Pausing {
                    self.phase = Phase::Idle;
                }
                self.failed(out, &current.game, error);
            }
            Reply::Resumed { id, reason, count, held_ms, error, results } => {
                if !results.is_empty() {
                    self.log_verbose(out, json!({ "resumeResults": results }));
                }
                let game = self.current.as_ref().map(|c| c.game.key());
                let by_guard = id.is_none();
                let mut value = json!({ "resumed": game, "processes": count, "heldMs": held_ms, "reason": reason });
                if let Some(error) = &error {
                    value["error"] = json!(error.to_string());
                    value["results"] = json!(error.results);
                }
                if by_guard {
                    value["by"] = json!("guard");
                }
                self.log(out, value);
                self.end_span(now);
                self.current = None;
                self.phase = Phase::Idle;
                if by_guard && reason != "replaced" {
                    // The guard gave up on us (heartbeat lost): do not pause again until the UI
                    // shows it is alive and done.
                    self.suppressed = true;
                    self.holds.clear();
                }
            }
            Reply::Refreshed { count, error } => {
                if let Some(c) = self.current.as_mut() {
                    c.count = count;
                }
                self.log_verbose(out, json!({ "refreshed": count, "error": error.map(|e| e.to_string()) }));
            }
        }
    }

    fn failed(&mut self, out: &mut Vec<Effect>, game: &GameRef, error: PauseError) {
        match error.refusal {
            Some(kind) => self.refuse(out, game, Refusal::new(kind, error.to_string())),
            None => {
                self.log(
                    out,
                    json!({ "pauseFailed": game.key(), "error": error.to_string(), "results": error.results }),
                );
                // A transient failure: not again until the holds clear.
                self.refusal = Some(Refusal::new(RefusalKind::Other, error.message));
            }
        }
    }

    fn end_span(&mut self, now: Instant) {
        let mono = self.ms(now);
        let wall = (self.wall)();
        if let Some(span) = self.spans.back_mut().filter(|s| s.end_ms.is_none()) {
            span.end_ms = Some(wall.max(span.start_ms));
            span.end_mono = Some(mono);
        }
    }

    fn log(&self, out: &mut Vec<Effect>, value: Value) {
        out.push(Effect::Log { verbose: false, value: with_check(value) });
    }
    fn log_verbose(&self, out: &mut Vec<Effect>, value: Value) {
        out.push(Effect::Log { verbose: true, value: with_check(value) });
    }
}

fn with_check(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.insert("check".into(), json!("game-pause"));
    }
    value
}

/// Spans that ended after `since_ms` or are still open, oldest first.
pub fn since(spans: &[PauseSpan], since_ms: f64) -> Vec<PauseSpan> {
    spans.iter().filter(|s| s.end_ms.is_none_or(|end| end > since_ms)).copied().collect()
}

#[cfg(test)]
mod tests {
    use super::super::backend::{fake::Fake, RefusalKind};
    use super::super::guard::Core;
    use super::super::journal::Journal;
    use super::*;
    use std::cell::Cell;

    fn wall() -> f64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0
    }

    struct Cx {
        game: GameRef,
        held: Cell<bool>,
    }
    impl Context for Cx {
        fn game(&self) -> GameRef {
            self.game.clone()
        }
        fn inputs_held(&self) -> bool {
            self.held.get()
        }
    }

    /// The machine, an in-process guard on the same fake backend, and a clock.
    struct Rig {
        fake: &'static Fake,
        machine: Machine,
        guard: Core<'static>,
        cx: Cx,
        now: Instant,
        notices: Vec<Notice>,
        logs: Vec<Value>,
        /// Guard replies not yet delivered (to test races).
        hold_replies: bool,
        pending: Vec<Reply>,
    }

    fn journal(name: &str) -> Journal {
        let dir = std::env::temp_dir().join(format!("kimochi-gp-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Journal::in_dir(&dir)
    }

    impl Rig {
        fn new(name: &str) -> Rig {
            let fake: &'static Fake = Box::leak(Box::new(Fake::new()));
            fake.spawn(100, 1, None);
            fake.spawn(101, 2, Some(100));
            fake.spawn(102, 3, Some(101));
            let now = Instant::now();
            let mut machine = Machine::new(now, wall);
            let cx = Cx {
                game: GameRef { pid: Some(100), source: Some("win:1".into()), ..Default::default() },
                held: Cell::new(false),
            };
            let _ = machine.handle(Input::SetEnabled(true), now, fake, &cx);
            Rig {
                fake,
                machine,
                guard: Core::new(fake, journal(name), now),
                cx,
                now,
                notices: Vec::new(),
                logs: Vec::new(),
                hold_replies: false,
                pending: Vec::new(),
            }
        }
        fn input(&mut self, input: Input) {
            let mut queue = vec![input];
            while let Some(input) = queue.pop() {
                let effects = self.machine.handle(input, self.now, self.fake, &self.cx);
                for effect in effects {
                    match effect {
                        Effect::Send(request) => {
                            let replies = self.guard.handle(request, self.now);
                            if self.hold_replies {
                                self.pending.extend(replies);
                            } else {
                                queue.extend(replies.into_iter().rev().map(Input::Guard));
                            }
                        }
                        Effect::Notice(n) => self.notices.push(n),
                        Effect::Log { value, .. } => self.logs.push(value),
                        Effect::Status(_) => {}
                    }
                }
            }
        }
        fn deliver(&mut self) {
            self.hold_replies = false;
            for reply in std::mem::take(&mut self.pending) {
                self.input(Input::Guard(reply));
            }
        }
        fn advance(&mut self, ms: u64) {
            self.now += Duration::from_millis(ms);
            for reply in self.guard.tick(self.now) {
                self.input(Input::Guard(reply));
            }
            self.input(Input::Tick);
        }
        fn stopped(&self) -> bool {
            self.fake.any_stopped()
        }
    }

    #[test]
    fn lookup_pauses_the_whole_tree_and_resumes_on_release() {
        let mut rig = Rig::new("basic");
        rig.input(Input::Beat(vec![Reason::Lookup]));
        assert_eq!(rig.machine.phase(), Phase::Paused);
        assert!(rig.fake.stopped(100) && rig.fake.stopped(101) && rig.fake.stopped(102));
        rig.input(Input::Beat(vec![]));
        assert_eq!(rig.machine.phase(), Phase::Idle);
        assert!(!rig.stopped());
        // Resumed in reverse order.
        assert_eq!(rig.fake.calls()[3..], ["cont 102", "cont 101", "cont 100"]);
        let spans = rig.machine.spans();
        assert_eq!(spans.len(), 1);
        assert!(spans[0].end_ms.is_some_and(|end| end >= spans[0].start_ms));
    }

    #[test]
    fn holds_are_counted_by_reason() {
        let mut rig = Rig::new("refcount");
        rig.input(Input::Hold(Reason::Navigation));
        rig.input(Input::Hold(Reason::Navigation));
        rig.input(Input::Beat(vec![Reason::Navigation, Reason::Lookup]));
        assert!(rig.stopped());
        rig.input(Input::Release(Reason::Navigation));
        assert!(rig.stopped(), "lookup still holds it");
        rig.input(Input::Release(Reason::RegionEditor)); // never taken: nothing happens
        assert!(rig.stopped());
        rig.input(Input::Beat(vec![]));
        assert!(!rig.stopped());
        assert_eq!(rig.machine.phase(), Phase::Idle);
    }

    #[test]
    fn rapid_open_close_never_leaves_the_game_paused() {
        let mut rig = Rig::new("rapid");
        for i in 0..200 {
            // Replies arrive late half the time, as from a real guard.
            rig.hold_replies = i % 2 == 0;
            rig.input(Input::Hold(Reason::Navigation));
            rig.input(Input::Release(Reason::Navigation));
            if i % 3 == 0 {
                rig.deliver();
            }
            rig.input(Input::Beat(if i % 5 == 0 { vec![Reason::Lookup] } else { vec![] }));
        }
        rig.deliver();
        rig.input(Input::Beat(vec![]));
        rig.deliver();
        assert_eq!(rig.machine.phase(), Phase::Idle, "{:?}", rig.machine.status());
        assert!(!rig.stopped());
        assert!(!rig.guard.holding());
        assert!(rig.machine.spans().iter().all(|s| s.end_ms.is_some()));
    }

    #[test]
    fn resume_waits_for_buttons_up_but_not_forever() {
        let mut rig = Rig::new("release");
        rig.input(Input::Hold(Reason::Navigation));
        assert!(rig.stopped());
        rig.cx.held.set(true);
        rig.input(Input::Release(Reason::Navigation));
        assert!(rig.stopped(), "B is still down");
        rig.advance(500);
        rig.input(Input::Beat(vec![]));
        assert!(rig.stopped());
        // Taken again before the resume: nothing changes, the game stays paused.
        rig.input(Input::Hold(Reason::Navigation));
        rig.input(Input::Release(Reason::Navigation));
        rig.advance(1000);
        assert!(rig.stopped());
        rig.advance(600);
        assert!(!rig.stopped(), "RELEASE_WAIT caps the wait");
        rig.cx.held.set(false);
        rig.input(Input::Hold(Reason::Navigation));
        rig.input(Input::Release(Reason::Navigation));
        assert!(!rig.stopped(), "buttons up: at once");
    }

    #[test]
    fn stale_holds_lapse_and_live_beats_keep_the_pause() {
        let mut rig = Rig::new("stale");
        rig.input(Input::Beat(vec![Reason::Lookup]));
        // A live UI beats every 500 ms: no timeout however long the reader reads.
        for _ in 0..40 {
            rig.advance(500);
            rig.input(Input::Beat(vec![Reason::Lookup]));
        }
        assert!(rig.stopped());
        // The webview dies: no more beats.
        rig.advance(1000);
        rig.advance(1000);
        assert!(!rig.stopped());
        assert_eq!(rig.machine.phase(), Phase::Idle);
    }

    #[test]
    fn guard_resumes_on_heartbeat_loss_even_if_the_app_hangs() {
        let mut rig = Rig::new("heartbeat");
        rig.input(Input::Beat(vec![Reason::Lookup]));
        assert!(rig.stopped());
        // The app hangs: no machine ticks, only the guard's clock runs.
        rig.now += Duration::from_millis(3100);
        let replies = rig.guard.tick(rig.now);
        assert!(!rig.stopped());
        assert!(matches!(&replies[..], [Reply::Resumed { id: None, reason, .. }] if reason == "heartbeat"));
        // The app wakes up with an old beat: it does not pause again until the UI reports no hold.
        for reply in replies {
            rig.input(Input::Guard(reply));
        }
        rig.input(Input::Beat(vec![Reason::Lookup]));
        assert!(!rig.stopped());
        rig.input(Input::Beat(vec![]));
        rig.input(Input::Beat(vec![Reason::Lookup]));
        assert!(rig.stopped());
    }

    #[test]
    fn forced_resumes_drop_every_hold() {
        for force in [Input::SetEnabled(false), Input::ForceResume("selection changed".into())] {
            let mut rig = Rig::new("force");
            rig.input(Input::Hold(Reason::Navigation));
            rig.input(Input::Beat(vec![Reason::Lookup, Reason::Navigation]));
            assert!(rig.stopped());
            rig.input(force.clone());
            assert!(!rig.stopped(), "{force:?}");
            assert!(rig.machine.holds().is_empty());
            // The stale beat still in flight does not pause it again.
            rig.input(Input::Beat(vec![Reason::Lookup]));
            assert!(!rig.stopped());
        }
    }

    #[test]
    fn off_by_default_and_never_pauses_when_off() {
        let fake = Fake::new();
        fake.spawn(100, 1, None);
        let cx = Cx { game: GameRef { pid: Some(100), ..Default::default() }, held: Cell::new(false) };
        let mut machine = Machine::new(Instant::now(), wall);
        let effects = machine.handle(Input::Hold(Reason::Lookup), Instant::now(), &fake, &cx);
        assert!(effects.iter().all(|e| !matches!(e, Effect::Send(_))));
        assert_eq!(machine.phase(), Phase::Idle);
    }

    #[test]
    fn refusal_is_noticed_once_per_game_and_not_replanned_while_held() {
        let mut rig = Rig::new("refuse");
        rig.fake.state.lock().unwrap().refuse = Some(RefusalKind::AntiCheat);
        rig.input(Input::Beat(vec![Reason::Lookup]));
        rig.input(Input::Beat(vec![Reason::Lookup]));
        assert_eq!(rig.notices.len(), 1);
        assert_eq!(rig.notices[0].kind, RefusalKind::AntiCheat);
        let refused_logs = rig.logs.iter().filter(|l| l.get("refused").is_some()).count();
        assert_eq!(refused_logs, 1);
        rig.input(Input::Beat(vec![]));
        rig.input(Input::Beat(vec![Reason::Lookup]));
        assert_eq!(rig.notices.len(), 1, "once per game");
        assert_eq!(rig.machine.status().refusal.map(|r| r.kind), Some(RefusalKind::AntiCheat));
        assert!(!rig.stopped());
    }

    #[test]
    fn partial_suspend_failure_rolls_back_and_is_reported() {
        let mut rig = Rig::new("rollback");
        rig.fake.state.lock().unwrap().fail_suspend.insert(102);
        rig.input(Input::Beat(vec![Reason::Lookup]));
        assert!(!rig.stopped());
        assert_eq!(rig.machine.phase(), Phase::Idle);
        assert!(rig.logs.iter().any(|l| l.get("pauseFailed").is_some()));
        let spans = rig.machine.spans();
        assert!(spans.len() == 1 && spans[0].end_ms.is_some(), "a failed pause's span is closed");
        // Not retried every beat while the holds last.
        let stops = rig.fake.calls().iter().filter(|c| c.starts_with("stop")).count();
        rig.input(Input::Beat(vec![Reason::Lookup]));
        assert_eq!(rig.fake.calls().iter().filter(|c| c.starts_with("stop")).count(), stops);
    }

    #[test]
    fn pid_reuse_between_plan_and_suspend_is_refused() {
        let mut rig = Rig::new("reuse");
        rig.hold_replies = true;
        // Plan sees pid 101 as start 2; it exits and a new process takes pid 101 before the guard
        // gets the request.
        let plan = rig.fake.plan(&rig.cx.game).unwrap();
        rig.fake.exit(101);
        rig.fake.spawn(101, 99, None);
        let replies = rig.guard.handle(Request::Suspend { id: 7, plan }, rig.now);
        assert!(matches!(&replies[..], [Reply::Failed { .. }]));
        assert!(!rig.stopped());
    }

    #[test]
    fn game_exit_while_paused_resumes_and_clears() {
        let mut rig = Rig::new("exit");
        rig.input(Input::Beat(vec![Reason::Lookup]));
        assert!(rig.stopped());
        rig.fake.exit(100);
        rig.advance(100);
        assert_eq!(rig.machine.phase(), Phase::Idle);
        assert!(!rig.fake.stopped(101));
    }

    #[test]
    fn spans_since_keeps_open_and_recent() {
        let span = |id, start: f64, end: Option<f64>| PauseSpan {
            id,
            start_ms: start,
            end_ms: end,
            start_mono: None,
            end_mono: None,
        };
        let spans = [span(1, 10.0, Some(20.0)), span(2, 30.0, Some(40.0)), span(3, 50.0, None)];
        assert_eq!(since(&spans, 25.0).iter().map(|s| s.id).collect::<Vec<_>>(), [2, 3]);
        assert_eq!(since(&spans, 100.0).iter().map(|s| s.id).collect::<Vec<_>>(), [3]);
    }

    #[test]
    fn one_span_per_suspended_interval() {
        let mut rig = Rig::new("onespan");
        rig.input(Input::Beat(vec![Reason::Lookup]));
        rig.input(Input::Hold(Reason::Navigation));
        rig.input(Input::Beat(vec![Reason::Lookup, Reason::Navigation]));
        rig.input(Input::Release(Reason::Navigation));
        assert_eq!(rig.machine.spans().len(), 1);
        rig.input(Input::Beat(vec![]));
        rig.input(Input::Beat(vec![Reason::Lookup]));
        rig.input(Input::Beat(vec![]));
        let spans = rig.machine.spans();
        assert_eq!(spans.len(), 2);
        assert!(spans[0].id < spans[1].id && spans.iter().all(|s| s.end_ms.is_some()));
    }

    #[test]
    fn guard_crash_mid_pause_is_recovered_from_the_journal() {
        let fake = Fake::new();
        fake.spawn(100, 1, None);
        fake.spawn(101, 2, Some(100));
        let j = journal("crash");
        let plan = fake.plan(&GameRef { pid: Some(100), ..Default::default() }).unwrap();
        {
            let mut core = Core::new(&fake, j.clone(), Instant::now());
            core.handle(Request::Suspend { id: 1, plan }, Instant::now());
            assert!(fake.any_stopped());
            // A hard kill: no Drop, no resume.
            std::mem::forget(core);
        }
        assert!(fake.any_stopped());
        let mut next = Core::new(&fake, j, Instant::now());
        let Reply::Ready { recovered, .. } = next.start() else { panic!() };
        assert_eq!(recovered.len(), 2);
        assert!(!fake.any_stopped());
    }

    #[test]
    fn recovery_never_continues_a_process_stopped_by_someone_else() {
        let fake = Fake::new();
        fake.spawn(100, 1, None);
        fake.spawn(101, 2, Some(100));
        fake.state.lock().unwrap().procs.get_mut(&101).unwrap().stopped = true; // a debugger's
        let j = journal("notours");
        let plan = fake.plan(&GameRef { pid: Some(100), ..Default::default() }).unwrap();
        let mut core = Core::new(&fake, j.clone(), Instant::now());
        let replies = core.handle(Request::Suspend { id: 1, plan }, Instant::now());
        let Reply::Suspended { suspended, .. } = &replies[0] else { panic!("{replies:?}") };
        assert_eq!(suspended.members.iter().map(|m| m.pid).collect::<Vec<_>>(), [100]);
        assert_eq!(j.read().unwrap().members.iter().map(|m| m.pid).collect::<Vec<_>>(), [100]);
        std::mem::forget(core);
        Core::new(&fake, j, Instant::now()).start();
        assert!(!fake.stopped(100));
        assert!(fake.stopped(101), "someone else's stop is left alone");
    }

    #[test]
    fn guard_eof_and_drop_resume() {
        let fake = Fake::new();
        fake.spawn(100, 1, None);
        let plan = fake.plan(&GameRef { pid: Some(100), ..Default::default() }).unwrap();
        let mut core = Core::new(&fake, journal("eof"), Instant::now());
        core.handle(Request::Suspend { id: 1, plan: plan.clone() }, Instant::now());
        assert!(matches!(core.shutdown("parent-exit", Instant::now()), Some(Reply::Resumed { .. })));
        assert!(!fake.any_stopped());
        core.handle(Request::Suspend { id: 2, plan }, Instant::now());
        drop(core);
        assert!(!fake.any_stopped(), "a panicking guard resumes on unwind");
    }

    #[test]
    fn serve_speaks_the_protocol_and_resumes_on_eof() {
        let fake: &'static Fake = Box::leak(Box::new(Fake::new()));
        fake.spawn(100, 1, None);
        let plan = fake.plan(&GameRef { pid: Some(100), ..Default::default() }).unwrap();
        let input = format!(
            "{}\n{}\n",
            serde_json::to_string(&Request::Suspend { id: 1, plan }).unwrap(),
            serde_json::to_string(&Request::Beat).unwrap()
        );
        let mut output = Vec::new();
        super::super::guard::serve(fake, journal("serve"), std::io::Cursor::new(input.into_bytes()), &mut output);
        let replies: Vec<Reply> =
            String::from_utf8(output).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert!(matches!(replies[0], Reply::Ready { .. }));
        assert!(matches!(replies[1], Reply::Suspended { id: 1, .. }));
        assert!(matches!(&replies[2], Reply::Resumed { id: None, reason, .. } if reason == "parent-exit"));
        assert!(!fake.any_stopped());
    }
}
