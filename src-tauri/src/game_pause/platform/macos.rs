//! macOS game pause: `SIGSTOP` / `SIGCONT` on the game's same-user process set.
//!
//! A non-sandboxed app may signal any process of its own user, so no helper or entitlement
//! is needed. There is deliberately no `task_suspend` / private `pid_suspend` here: a
//! stopped process is visible to the system (`ps` shows `T`), survives Kimochi crashing
//! only until something sends `SIGCONT`, and is undone by the same call that any guard,
//! the journal or a user's `kill -CONT` can make.
//!
//! The work splits in three:
//!
//! - **Snapshot** ([`snapshot`]): every process the kernel lists, with parent, user, start
//!   time, executable path, stop state and responsible process.
//! - **Planning** ([`plan_from`]): pure, so it is unit-tested on synthetic snapshots. The
//!   game is the window owner plus its descendants (by parent pid), every process whose
//!   responsible process is the owner, every executable inside the same outermost `.app`
//!   bundle and, for Wine-based games, the other Wine processes of the same prefix (the
//!   prefix's server is neither a descendant nor in the game's bundle). Other users'
//!   processes, system executables, critical session processes and Kimochi's own tree are
//!   never included.
//! - **Signalling** ([`suspend`], [`resume`], [`resume_identities`]): every pid is checked
//!   against its identity (pid + start time) right before it is signalled, so a recycled
//!   pid is never touched. Suspend is all-or-nothing: any failure continues what was
//!   stopped. Resume is best effort over every pid, idempotent, and verifies that each one
//!   left the stopped state.
//!
//! Things macOS does to a stopped app (see the notes kept with the feature): the pointer
//! over its windows turns into the busy cursor after a couple of seconds and the Force
//! Quit window lists it as not responding; its windows keep their last frame; its audio
//! stops. Never activate a stopped app or make a synchronous call into it (accessibility
//! queries block until their timeout).

use super::super::backend::{
    Backend, Excluded, GameRef, Member, PauseError, PidResult, Plan, ProcIdentity, Refusal, RefusalKind, Role,
    Suspended,
};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

/// This build can pause games on macOS.
pub const SUPPORTED: bool = true;

pub fn backend() -> Box<dyn Backend> {
    Box::new(MacBackend { ctx: Context::current() })
}

const MECHANISM: &str = "SIGSTOP";
/// Longest descendant chain followed from the owner.
const MAX_DEPTH: usize = 8;
/// More processes than this is not a game; refuse rather than stop half a session.
const MAX_MEMBERS: usize = 64;
/// How long a stop or continue may take to show in the process state.
const SETTLE: Duration = Duration::from_millis(250);
/// `p_stat` of a stopped process (`SSTOP` in XNU's `sys/proc.h`).
const SSTOP: u32 = 4;
/// `p_stat` of a zombie.
const SZOMB: u32 = 5;

/// Executable names that are never stopped, whatever the planner thinks: the session,
/// the desktop, audio, input methods and the game store client.
const CRITICAL_NAMES: &[&str] = &[
    "launchd",
    "kernel_task",
    "WindowServer",
    "Dock",
    "Finder",
    "loginwindow",
    "SystemUIServer",
    "ControlCenter",
    "NotificationCenter",
    "coreaudiod",
    "Spotlight",
    "TextInputMenuAgent",
    "imklaunchagent",
    "steam_osx",
    "Steam Helper",
];

/// Executables under these prefixes belong to the system, never to a game.
const SYSTEM_PREFIXES: &[&str] = &["/System/", "/usr/", "/bin/", "/sbin/", "/Library/Apple/", "/private/var/db/"];

/// Executable names of Wine's loader, server and launcher.
fn wine_like(exe: &str) -> bool {
    let name = file_name(exe);
    name == "wineserver"
        || name.starts_with("wine64")
        || name.starts_with("wine-")
        || name == "wine"
        || name.starts_with("wine32")
        || name == "wine-preloader"
}

fn file_name(exe: &str) -> &str {
    exe.rsplit('/').next().unwrap_or(exe)
}

/// The outermost `.app` bundle an executable lives in (`/Applications/Game.app`).
fn outer_bundle(exe: &str) -> Option<&str> {
    let end = exe.find(".app/")?;
    Some(&exe[..end + 4])
}

/// One process in a [`snapshot`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcRecord {
    pub pid: u32,
    pub ppid: u32,
    pub uid: u32,
    /// Start time in microseconds since the epoch, from the kernel.
    pub start_us: u64,
    pub exe: String,
    pub stopped: bool,
    /// The process macOS holds responsible for this one (an app for its XPC helpers).
    pub responsible: Option<u32>,
}

impl ProcRecord {
    pub fn identity(&self) -> ProcIdentity {
        ProcIdentity { pid: self.pid, start: self.start_us, exe: self.exe.clone() }
    }
}

/// Why a process is in the plan (finer than [`Role`], for the verbose log).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Why {
    Owner,
    Descendant,
    Responsible,
    SameBundle,
    WinePrefix,
}

impl Why {
    fn role(self) -> Role {
        match self {
            Why::Owner => Role::Main,
            Why::Descendant => Role::Child,
            Why::Responsible | Why::SameBundle | Why::WinePrefix => Role::Sibling,
        }
    }
    fn text(self) -> &'static str {
        match self {
            Why::Owner => "owns the game window",
            Why::Descendant => "descendant of the game",
            Why::Responsible => "the game is its responsible process",
            Why::SameBundle => "runs from the game's app bundle",
            Why::WinePrefix => "Wine process of the game's prefix",
        }
    }
}

/// Which processes are Kimochi's and whose user we are.
#[derive(Clone, Copy, Debug, Default)]
pub struct Context {
    pub self_pid: u32,
    pub uid: u32,
}

impl Context {
    pub fn current() -> Self {
        Context { self_pid: std::process::id(), uid: unsafe { libc::getuid() } }
    }
}

/// The Wine prefix a process runs in: `Some(Some(path))` from `WINEPREFIX`, `Some(None)`
/// when it is unset (the default prefix), `None` when the environment cannot be read.
pub type PrefixLookup<'a> = &'a dyn Fn(u32) -> Option<Option<String>>;

// ---------------------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------------------

/// Plan the stop set for `game`, whose window's process is `game.pid`.
pub fn plan_from(
    records: &[ProcRecord],
    game: &GameRef,
    ctx: Context,
    prefix_of: PrefixLookup,
) -> Result<Plan, Refusal> {
    let Some(owner) = game.pid else { return Err(Refusal::new(RefusalKind::NoPid, "no process for the window")) };
    let by_pid: HashMap<u32, &ProcRecord> = records.iter().map(|r| (r.pid, r)).collect();
    let Some(&own) = by_pid.get(&owner) else {
        return Err(Refusal::new(RefusalKind::NotFound, format!("pid {owner} is gone")));
    };
    if own.uid != ctx.uid {
        return Err(Refusal::new(RefusalKind::Elevated, format!("pid {owner} runs as uid {}", own.uid)));
    }
    if is_kimochi(&by_pid, own, ctx) {
        return Err(Refusal::new(RefusalKind::Denylisted, format!("pid {owner} is Kimochi's own process")));
    }
    if let Some((kind, why)) = protected(&own.exe) {
        return Err(Refusal::new(kind, format!("pid {owner} {}: {why}", own.exe)));
    }

    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for r in records {
        if r.pid != r.ppid {
            children.entry(r.ppid).or_default().push(r.pid);
        }
    }
    for list in children.values_mut() {
        list.sort_unstable();
    }

    // pid -> (role, depth for ordering)
    let mut chosen: BTreeMap<u32, (Why, usize)> = BTreeMap::new();
    let mut excluded: Vec<Excluded> = Vec::new();
    let mut seen_excluded: HashSet<u32> = HashSet::new();
    chosen.insert(owner, (Why::Owner, 0));

    let mut consider = |r: &ProcRecord,
                        role: Why,
                        depth: usize,
                        chosen: &mut BTreeMap<u32, (Why, usize)>,
                        excluded: &mut Vec<Excluded>|
     -> bool {
        if chosen.contains_key(&r.pid) {
            return false;
        }
        let why = if r.uid != ctx.uid {
            Some("another user's process")
        } else if is_kimochi(&by_pid, r, ctx) {
            Some("Kimochi's own process")
        } else {
            protected(&r.exe).map(|(_, why)| why)
        };
        match why {
            Some(why) => {
                if seen_excluded.insert(r.pid) {
                    excluded.push(Excluded { pid: r.pid, exe: r.exe.clone(), why: why.into() });
                }
                false
            }
            None => {
                chosen.insert(r.pid, (role, depth));
                true
            }
        }
    };

    // Descendants of everything chosen so far, breadth first, depth-capped. Run after each
    // rule so a bundle helper's or prefix sibling's children come along too.
    fn walk(
        start: &[(u32, usize)],
        children: &HashMap<u32, Vec<u32>>,
        by_pid: &HashMap<u32, &ProcRecord>,
        mut take: impl FnMut(&ProcRecord, usize) -> bool,
    ) {
        let mut queue: VecDeque<(u32, usize)> = start.iter().copied().collect();
        while let Some((pid, depth)) = queue.pop_front() {
            if depth >= MAX_DEPTH {
                continue;
            }
            for child in children.get(&pid).into_iter().flatten() {
                if let Some(r) = by_pid.get(child) {
                    if take(r, depth + 1) {
                        queue.push_back((*child, depth + 1));
                    }
                }
            }
        }
    }

    let roots = |chosen: &BTreeMap<u32, (Why, usize)>| -> Vec<(u32, usize)> {
        chosen.iter().map(|(pid, (_, depth))| (*pid, *depth)).collect()
    };

    let start = roots(&chosen);
    walk(&start, &children, &by_pid, |r, d| consider(r, Why::Descendant, d, &mut chosen, &mut excluded));

    for r in records {
        if r.pid != owner && r.responsible == Some(owner) {
            consider(r, Why::Responsible, 1, &mut chosen, &mut excluded);
        }
    }

    let owner_is_wine = wine_like(&own.exe);
    if !owner_is_wine {
        // A Wine wrapper's bundle hosts every prefix's server and its own interface: the
        // bundle rule would pull in other games, so Wine games use the prefix rule instead.
        if let Some(bundle) = outer_bundle(&own.exe) {
            for r in records {
                if r.pid != owner && outer_bundle(&r.exe) == Some(bundle) {
                    consider(r, Why::SameBundle, 1, &mut chosen, &mut excluded);
                }
            }
        }
    }

    let wine_members: Vec<u32> =
        chosen.keys().copied().filter(|pid| by_pid.get(pid).is_some_and(|r| wine_like(&r.exe))).collect();
    if !wine_members.is_empty() {
        let prefixes: HashSet<Option<String>> = wine_members.iter().filter_map(|pid| prefix_of(*pid)).collect();
        if !prefixes.is_empty() {
            for r in records {
                if chosen.contains_key(&r.pid) || r.uid != ctx.uid || !wine_like(&r.exe) {
                    continue;
                }
                if prefix_of(r.pid).is_some_and(|p| prefixes.contains(&p)) {
                    consider(r, Why::WinePrefix, 1, &mut chosen, &mut excluded);
                }
            }
        }
    }

    let start = roots(&chosen);
    walk(&start, &children, &by_pid, |r, d| consider(r, Why::Descendant, d, &mut chosen, &mut excluded));

    if chosen.len() > MAX_MEMBERS {
        return Err(Refusal::new(RefusalKind::Other, format!("{} processes is more than a game", chosen.len())));
    }

    // Stop order: the owner first (it can no longer start anything), then shallower before
    // deeper so a parent is stopped before its children, then by pid for determinism.
    let mut ranked: Vec<(usize, u32, Why)> = chosen
        .into_iter()
        .map(|(pid, (why, depth))| (if why == Why::Owner { 0 } else { depth + 1 }, pid, why))
        .collect();
    ranked.sort_by_key(|(rank, pid, _)| (*rank, *pid));
    let members = ranked
        .into_iter()
        .map(|(_, pid, why)| Member { id: by_pid[&pid].identity(), role: why.role(), why: why.text().into() })
        .collect();
    Ok(Plan { game: game.clone(), members, excluded, mechanism: MECHANISM.into() })
}

/// Whether `r` is Kimochi, one of its descendants, or a helper it is responsible for.
fn is_kimochi(by_pid: &HashMap<u32, &ProcRecord>, r: &ProcRecord, ctx: Context) -> bool {
    if r.pid == ctx.self_pid || r.responsible == Some(ctx.self_pid) {
        return true;
    }
    let mut pid = r.ppid;
    for _ in 0..64 {
        if pid == ctx.self_pid {
            return true;
        }
        if pid <= 1 {
            return false;
        }
        match by_pid.get(&pid) {
            Some(p) if p.ppid != pid => pid = p.ppid,
            _ => return false,
        }
    }
    false
}

/// Why an executable is never stopped, if it is one of those.
fn protected(exe: &str) -> Option<(RefusalKind, &'static str)> {
    if SYSTEM_PREFIXES.iter().any(|p| exe.starts_with(p)) {
        return Some((RefusalKind::Protected, "system executable"));
    }
    if CRITICAL_NAMES.contains(&file_name(exe)) {
        return Some((RefusalKind::Denylisted, "session process"));
    }
    if exe.is_empty() || !exe.starts_with('/') {
        return Some((RefusalKind::Other, "executable path unknown"));
    }
    None
}

// ---------------------------------------------------------------------------------------
// Process information (live)
// ---------------------------------------------------------------------------------------

fn bsd_info(pid: u32) -> Option<libc::proc_bsdinfo> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let got = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (got == size && info.pbi_pid == pid).then_some(info)
}

fn exe_path(pid: u32, info: &libc::proc_bsdinfo) -> String {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe { libc::proc_pidpath(pid as libc::c_int, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n > 0 {
        buf.truncate(n as usize);
        return String::from_utf8_lossy(&buf).into_owned();
    }
    let comm: Vec<u8> = info.pbi_comm.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
    String::from_utf8_lossy(&comm).into_owned()
}

fn start_us(info: &libc::proc_bsdinfo) -> u64 {
    info.pbi_start_tvsec.saturating_mul(1_000_000).saturating_add(info.pbi_start_tvusec)
}

type ResponsibleFn = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;

/// `responsibility_get_pid_responsible_for_pid`: private, so looked up at run time and
/// simply absent if a future macOS drops it.
fn responsible_fn() -> Option<ResponsibleFn> {
    static FN: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let addr = *FN.get_or_init(|| unsafe {
        libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid".as_ptr()) as usize
    });
    (addr != 0).then(|| unsafe { std::mem::transmute::<usize, ResponsibleFn>(addr) })
}

/// The process macOS holds responsible for `pid`, if it is another process.
pub fn responsible_pid(pid: u32) -> Option<u32> {
    let f = responsible_fn()?;
    let r = unsafe { f(pid as libc::pid_t) };
    (r > 0 && r as u32 != pid).then_some(r as u32)
}

/// The live record for one pid.
pub fn record(pid: u32) -> Option<ProcRecord> {
    let info = bsd_info(pid)?;
    Some(ProcRecord {
        pid,
        ppid: info.pbi_ppid,
        uid: info.pbi_uid,
        start_us: start_us(&info),
        exe: exe_path(pid, &info),
        stopped: info.pbi_status == SSTOP,
        responsible: if info.pbi_uid == unsafe { libc::getuid() } { responsible_pid(pid) } else { None },
    })
}

/// The identity of a live pid (pid + start time + executable).
pub fn identity(pid: u32) -> Option<ProcIdentity> {
    record(pid).map(|r| r.identity())
}

/// Every process the kernel lists.
pub fn snapshot() -> Vec<ProcRecord> {
    let mut pids: Vec<libc::c_int> = vec![0; 4096];
    loop {
        let bytes = (pids.len() * std::mem::size_of::<libc::c_int>()) as libc::c_int;
        let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        if n < 0 {
            return Vec::new();
        }
        if (n as usize) < pids.len() {
            pids.truncate(n as usize);
            break;
        }
        pids.resize(pids.len() * 2, 0);
    }
    pids.into_iter().filter(|p| *p > 0).filter_map(|p| record(p as u32)).collect()
}

/// `WINEPREFIX` from a same-user process's environment (`KERN_PROCARGS2`).
pub fn wine_prefix(pid: u32) -> Option<Option<String>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    let mut size: libc::size_t = 0;
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    let mut buf = vec![0u8; size];
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    buf.truncate(size);
    parse_procargs_env(&buf, "WINEPREFIX")
}

/// Find `key` in a `KERN_PROCARGS2` buffer: `argc`, the exec path, padding, `argc`
/// arguments, then the environment, each NUL-terminated.
fn parse_procargs_env(buf: &[u8], key: &str) -> Option<Option<String>> {
    if buf.len() < 4 {
        return None;
    }
    let argc = i32::from_ne_bytes(buf[..4].try_into().ok()?);
    let mut i = 4;
    // exec path
    while i < buf.len() && buf[i] != 0 {
        i += 1;
    }
    while i < buf.len() && buf[i] == 0 {
        i += 1;
    }
    let mut strings = buf[i..].split(|b| *b == 0);
    for _ in 0..argc.max(0) {
        strings.next()?;
    }
    let prefix = format!("{key}=");
    for s in strings {
        if s.is_empty() {
            break;
        }
        if let Some(value) = s.strip_prefix(prefix.as_bytes()) {
            return Some(Some(String::from_utf8_lossy(value).trim_end_matches('/').to_string()));
        }
    }
    Some(None)
}

/// Plan against the live process list, as Kimochi (`ctx`).
pub fn plan_with(game: &GameRef, ctx: Context) -> Result<Plan, Refusal> {
    plan_from(&snapshot(), game, ctx, &|pid| wine_prefix(pid))
}

// ---------------------------------------------------------------------------------------
// Signalling (live)
// ---------------------------------------------------------------------------------------

/// The live state of a process, if it still is the one `id` names.
enum Live {
    Matches { stopped: bool },
    Gone,
    Different,
}

fn live(id: &ProcIdentity) -> Live {
    match bsd_info(id.pid) {
        None => Live::Gone,
        Some(info) if info.pbi_status == SZOMB => Live::Gone,
        Some(info) if start_us(&info) != id.start => Live::Different,
        Some(info) => Live::Matches { stopped: info.pbi_status == SSTOP },
    }
}

#[cfg(test)]
thread_local! {
    /// A pid whose stop fails with `EPERM`, for the rollback test.
    static REFUSE_PID: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

fn signal(pid: u32, sig: libc::c_int) -> Result<(), i32> {
    if pid <= 1 {
        return Err(libc::EPERM);
    }
    #[cfg(test)]
    if sig == libc::SIGSTOP && REFUSE_PID.get() == pid {
        return Err(libc::EPERM);
    }
    if unsafe { libc::kill(pid as libc::pid_t, sig) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(0))
    }
}

fn result(pid: u32, began: Instant, outcome: Result<(), i32>, note: &str) -> PidResult {
    PidResult {
        pid,
        ok: outcome.is_ok(),
        code: outcome.err().map(i64::from),
        note: note.into(),
        micros: began.elapsed().as_micros() as u64,
    }
}

fn failure(message: &str, pid: u32, errno: Option<i32>, results: Vec<PidResult>) -> PauseError {
    PauseError {
        message: message.into(),
        pid: Some(pid),
        code: errno.map(i64::from),
        refusal: (errno == Some(libc::EPERM)).then_some(RefusalKind::PermissionDenied),
        results,
    }
}

/// Stop every member of `plan`, owner first. All or nothing: on any failure everything this
/// call stopped is continued again before the error is returned. Processes already stopped by
/// someone else, gone, or recycled are left out of the result, so they are never continued.
pub fn suspend_plan(plan: &Plan, ctx: Context) -> Result<Suspended, PauseError> {
    let mut stopped: Vec<ProcIdentity> = Vec::new();
    let mut results: Vec<PidResult> = Vec::new();

    let rollback = |stopped: &[ProcIdentity], err: PauseError| -> PauseError {
        let _ = resume_identities(stopped);
        err
    };

    for (i, m) in plan.members.iter().enumerate() {
        let owner = i == 0;
        let began = Instant::now();
        let pid = m.id.pid;
        match live(&m.id) {
            Live::Gone | Live::Different if owner => {
                return Err(rollback(&stopped, failure("the game's process changed", pid, None, results)));
            }
            Live::Gone => results.push(result(pid, began, Ok(()), "exited")),
            Live::Different => results.push(result(pid, began, Ok(()), "pid reused, skipped")),
            Live::Matches { stopped: true } => results.push(result(pid, began, Ok(()), "already stopped, not ours")),
            Live::Matches { stopped: false } => match signal(pid, libc::SIGSTOP) {
                Ok(()) => {
                    results.push(result(pid, began, Ok(()), ""));
                    stopped.push(m.id.clone());
                }
                Err(libc::ESRCH) if !owner => results.push(result(pid, began, Ok(()), "exited")),
                Err(errno) => {
                    results.push(result(pid, began, Err(errno), "kill(SIGSTOP)"));
                    let message = if errno == libc::ESRCH { "the game's process exited" } else { "could not stop" };
                    return Err(rollback(&stopped, failure(message, pid, Some(errno), results)));
                }
            },
        }
    }

    // A process started between the snapshot and the owner's stop escaped the plan.
    if !stopped.is_empty() {
        let known: HashSet<u32> = plan.members.iter().map(|m| m.id.pid).collect();
        if let Err((pid, errno)) = stop_newcomers(&plan.game, ctx, &known, &mut stopped, &mut results) {
            return Err(rollback(&stopped, failure("could not stop", pid, Some(errno), results)));
        }
    }

    // Signals are delivered asynchronously; confirm every stop landed.
    let deadline = Instant::now() + SETTLE;
    for id in &stopped {
        loop {
            match live(id) {
                Live::Matches { stopped: true } | Live::Gone | Live::Different => break,
                Live::Matches { stopped: false } if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(2))
                }
                Live::Matches { stopped: false } => {
                    let err = failure("did not stop in time", id.pid, None, results);
                    return Err(rollback(&stopped, err));
                }
            }
        }
    }

    Ok(Suspended { game: plan.game.clone(), members: stopped, mechanism: MECHANISM.into(), results })
}

/// Re-plan the game and stop processes that are not in `known` yet (children started during
/// the pause, or in the moment before the owner stopped). Appends to `stopped`.
fn stop_newcomers(
    game: &GameRef,
    ctx: Context,
    known: &HashSet<u32>,
    stopped: &mut Vec<ProcIdentity>,
    results: &mut Vec<PidResult>,
) -> Result<usize, (u32, i32)> {
    let records = snapshot();
    let Ok(again) = plan_from(&records, game, ctx, &|pid| wine_prefix(pid)) else { return Ok(0) };
    let mut added = 0;
    for m in again.members.into_iter().filter(|m| !known.contains(&m.id.pid)) {
        if stopped.iter().any(|s| s.pid == m.id.pid) {
            continue;
        }
        if records.iter().any(|r| r.pid == m.id.pid && r.stopped) {
            continue;
        }
        let began = Instant::now();
        match signal(m.id.pid, libc::SIGSTOP) {
            Ok(()) => {
                results.push(result(m.id.pid, began, Ok(()), "late member"));
                stopped.push(m.id);
                added += 1;
            }
            Err(libc::ESRCH) => {}
            Err(errno) => {
                results.push(result(m.id.pid, began, Err(errno), "kill(SIGSTOP), late member"));
                return Err((m.id.pid, errno));
            }
        }
    }
    Ok(added)
}

/// Continue each process that still is the one its identity names, last first, and check
/// that each left the stopped state. Never signals a recycled pid. Idempotent, and best
/// effort: one failure does not stop the others. Also the recovery path for a journal.
pub fn resume_identities(ids: &[ProcIdentity]) -> Result<(), PauseError> {
    let mut pending: Vec<&ProcIdentity> = ids.iter().rev().collect();
    let mut last_errno: Option<i32> = None;
    for attempt in 0..4u64 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(10 * attempt));
        }
        for id in &pending {
            if let Live::Matches { stopped: true } = live(id) {
                if let Err(errno) = signal(id.pid, libc::SIGCONT) {
                    last_errno = Some(errno);
                }
            }
        }
        let deadline = Instant::now() + SETTLE / 2;
        pending.retain(|id| loop {
            match live(id) {
                Live::Matches { stopped: true } if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(2))
                }
                Live::Matches { stopped: true } => break true,
                _ => break false,
            }
        });
        if pending.is_empty() {
            return Ok(());
        }
    }
    let results = pending
        .iter()
        .map(|id| PidResult {
            pid: id.pid,
            ok: false,
            code: last_errno.map(i64::from),
            note: "still stopped".into(),
            micros: 0,
        })
        .collect();
    let pids: Vec<String> = pending.iter().map(|id| id.pid.to_string()).collect();
    Err(PauseError {
        message: format!("still stopped after resume: {}", pids.join(", ")),
        pid: pending.first().map(|id| id.pid),
        code: last_errno.map(i64::from),
        refusal: None,
        results,
    })
}

/// Called while paused: stop late children, and stop again any member someone continued.
pub fn refresh_suspended(suspended: &mut Suspended, ctx: Context) -> Result<(), PauseError> {
    let mut results = Vec::new();
    for id in &suspended.members {
        if let Live::Matches { stopped: false } = live(id) {
            let began = Instant::now();
            let outcome = signal(id.pid, libc::SIGSTOP);
            results.push(result(id.pid, began, outcome, "continued by someone else; stopped again"));
        }
    }
    let known: HashSet<u32> = suspended.members.iter().map(|id| id.pid).collect();
    let mut stopped = std::mem::take(&mut suspended.members);
    let outcome = stop_newcomers(&suspended.game, ctx, &known, &mut stopped, &mut results);
    suspended.members = stopped;
    suspended.results.extend(results.iter().cloned());
    match outcome {
        Ok(_) => Ok(()),
        Err((pid, errno)) => Err(failure("could not stop a late member", pid, Some(errno), results)),
    }
}

/// The macOS backend. Holds no per-pause state: a stopped process stays stopped by itself, and
/// every signal is re-checked against the process's identity.
pub struct MacBackend {
    /// Who "Kimochi" is for the planner: the app when planning, the guard when refreshing.
    ctx: Context,
}

impl Backend for MacBackend {
    fn name(&self) -> &'static str {
        "macos-sigstop"
    }
    fn plan(&self, game: &GameRef) -> Result<Plan, Refusal> {
        plan_with(game, self.ctx)
    }
    fn suspend(&self, plan: &Plan) -> Result<Suspended, PauseError> {
        suspend_plan(plan, self.ctx)
    }
    fn resume(&self, suspended: &Suspended) -> Result<(), PauseError> {
        resume_identities(&suspended.members)
    }
    fn identity(&self, pid: u32) -> Option<ProcIdentity> {
        identity(pid)
    }
    fn refresh(&self, suspended: &mut Suspended) -> Result<(), PauseError> {
        refresh_suspended(suspended, self.ctx)
    }
}

#[cfg(test)]
#[path = "macos_tests.rs"]
mod tests;
