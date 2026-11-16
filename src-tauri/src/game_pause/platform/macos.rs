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

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

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

/// A process as identified across time: a pid alone can be recycled.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProcIdentity {
    pub pid: u32,
    /// Start time in microseconds since the epoch, from the kernel.
    pub start_us: u64,
    /// Executable path (or the kernel's short name when the path is unreadable).
    pub exe: String,
}

/// One process in a [`snapshot`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcRecord {
    pub pid: u32,
    pub ppid: u32,
    pub uid: u32,
    pub start_us: u64,
    pub exe: String,
    pub stopped: bool,
    /// The process macOS holds responsible for this one (an app for its XPC helpers).
    pub responsible: Option<u32>,
}

impl ProcRecord {
    pub fn identity(&self) -> ProcIdentity {
        ProcIdentity { pid: self.pid, start_us: self.start_us, exe: self.exe.clone() }
    }
}

/// Why a process is in the plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    /// Owns the game's window.
    Owner,
    /// A descendant of the owner by parent pid.
    Descendant,
    /// macOS holds the owner responsible for it.
    Responsible,
    /// Runs an executable from the owner's `.app` bundle.
    SameBundle,
    /// Another Wine process of the owner's prefix.
    WinePrefix,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Member {
    pub identity: ProcIdentity,
    pub role: Role,
}

/// A process the planner looked at and left out, with the reason, for the verbose log.
#[derive(Clone, Debug, Serialize)]
pub struct Excluded {
    pub pid: u32,
    pub exe: String,
    pub why: &'static str,
}

/// Every process that must stop for this game, in stop order.
#[derive(Clone, Debug, Serialize)]
pub struct Plan {
    pub members: Vec<Member>,
    pub excluded: Vec<Excluded>,
    /// Whose user and whose process tree the plan was made for (reused by the second pass).
    #[serde(skip)]
    pub ctx: Context,
}

impl Plan {
    pub fn owner(&self) -> &ProcIdentity {
        &self.members[0].identity
    }
}

/// Why the game cannot be paused; the UI shows it once per game.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Refusal {
    /// The window's process is gone or was never known.
    NoProcess,
    /// The game runs as another user (or root); signalling it is not allowed.
    OtherUser,
    /// The window belongs to Kimochi itself.
    OwnProcess,
    /// A system or session process.
    Protected { exe: String },
    /// More processes than a game would have.
    TooMany { count: usize },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PauseError {
    /// The owner is no longer the process that was planned (exited or pid reused).
    OwnerChanged,
    /// `kill` failed for a pid; everything already stopped was continued.
    Signal { pid: u32, errno: i32 },
    /// A pid did not reach the stopped state in time; everything was continued.
    NotStopped { pid: u32 },
    /// Some pids are still stopped after resume's retries.
    StillStopped { pids: Vec<u32> },
}

/// What [`suspend`] stopped, in stop order. Only these are ever continued.
#[derive(Clone, Debug, Serialize)]
pub struct Suspended {
    pub stopped: Vec<ProcIdentity>,
    /// Processes planned but not stopped by us: already stopped by someone else, exited,
    /// or recycled. Never continued by [`resume`].
    pub skipped: Vec<(ProcIdentity, &'static str)>,
    /// Processes that appeared during the pause and were stopped in the second pass.
    pub late: usize,
    pub took: Duration,
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

/// Plan the stop set for the game whose window `owner` owns.
pub fn plan_from(records: &[ProcRecord], owner: u32, ctx: Context, prefix_of: PrefixLookup) -> Result<Plan, Refusal> {
    let by_pid: HashMap<u32, &ProcRecord> = records.iter().map(|r| (r.pid, r)).collect();
    let Some(&own) = by_pid.get(&owner) else { return Err(Refusal::NoProcess) };
    if own.uid != ctx.uid {
        return Err(Refusal::OtherUser);
    }
    if is_kimochi(&by_pid, own, ctx) {
        return Err(Refusal::OwnProcess);
    }
    if protected(&own.exe).is_some() {
        return Err(Refusal::Protected { exe: own.exe.clone() });
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
    let mut chosen: BTreeMap<u32, (Role, usize)> = BTreeMap::new();
    let mut excluded: Vec<Excluded> = Vec::new();
    let mut seen_excluded: HashSet<u32> = HashSet::new();
    chosen.insert(owner, (Role::Owner, 0));

    let mut consider = |r: &ProcRecord,
                        role: Role,
                        depth: usize,
                        chosen: &mut BTreeMap<u32, (Role, usize)>,
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
            protected(&r.exe)
        };
        match why {
            Some(why) => {
                if seen_excluded.insert(r.pid) {
                    excluded.push(Excluded { pid: r.pid, exe: r.exe.clone(), why });
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

    let roots = |chosen: &BTreeMap<u32, (Role, usize)>| -> Vec<(u32, usize)> {
        chosen.iter().map(|(pid, (_, depth))| (*pid, *depth)).collect()
    };

    let start = roots(&chosen);
    walk(&start, &children, &by_pid, |r, d| consider(r, Role::Descendant, d, &mut chosen, &mut excluded));

    for r in records {
        if r.pid != owner && r.responsible == Some(owner) {
            consider(r, Role::Responsible, 1, &mut chosen, &mut excluded);
        }
    }

    let owner_is_wine = wine_like(&own.exe);
    if !owner_is_wine {
        // A Wine wrapper's bundle hosts every prefix's server and its own interface: the
        // bundle rule would pull in other games, so Wine games use the prefix rule instead.
        if let Some(bundle) = outer_bundle(&own.exe) {
            for r in records {
                if r.pid != owner && outer_bundle(&r.exe) == Some(bundle) {
                    consider(r, Role::SameBundle, 1, &mut chosen, &mut excluded);
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
                    consider(r, Role::WinePrefix, 1, &mut chosen, &mut excluded);
                }
            }
        }
    }

    let start = roots(&chosen);
    walk(&start, &children, &by_pid, |r, d| consider(r, Role::Descendant, d, &mut chosen, &mut excluded));

    if chosen.len() > MAX_MEMBERS {
        return Err(Refusal::TooMany { count: chosen.len() });
    }

    // Stop order: the owner first (it can no longer start anything), then shallower before
    // deeper so a parent is stopped before its children, then by pid for determinism.
    let mut ranked: Vec<(usize, u32, Role)> = chosen
        .into_iter()
        .map(|(pid, (role, depth))| (if role == Role::Owner { 0 } else { depth + 1 }, pid, role))
        .collect();
    ranked.sort_by_key(|(rank, pid, _)| (*rank, *pid));
    let members = ranked.into_iter().map(|(_, pid, role)| Member { identity: by_pid[&pid].identity(), role }).collect();
    Ok(Plan { members, excluded, ctx })
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
fn protected(exe: &str) -> Option<&'static str> {
    if SYSTEM_PREFIXES.iter().any(|p| exe.starts_with(p)) {
        return Some("system executable");
    }
    if CRITICAL_NAMES.contains(&file_name(exe)) {
        return Some("session process");
    }
    if exe.is_empty() || !exe.starts_with('/') {
        return Some("executable path unknown");
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

/// Plan against the live process list.
pub fn plan(owner: u32) -> Result<Plan, Refusal> {
    plan_with(owner, Context::current())
}

/// [`plan`] for another notion of "Kimochi" (tests plan for their own children).
pub fn plan_with(owner: u32, ctx: Context) -> Result<Plan, Refusal> {
    plan_from(&snapshot(), owner, ctx, &|pid| wine_prefix(pid))
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
        Some(info) if start_us(&info) != id.start_us => Live::Different,
        Some(info) => Live::Matches { stopped: info.pbi_status == SSTOP },
    }
}

#[cfg(test)]
thread_local! {
    /// A pid whose next signal fails with `EPERM`, for the rollback test.
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

/// Stop every member of `plan`, owner first. All or nothing: on any failure everything this
/// call stopped is continued again before the error is returned.
pub fn suspend(plan: &Plan) -> Result<Suspended, PauseError> {
    let began = Instant::now();
    let mut stopped: Vec<ProcIdentity> = Vec::new();
    let mut skipped: Vec<(ProcIdentity, &'static str)> = Vec::new();

    let fail = |stopped: &[ProcIdentity], err: PauseError| -> PauseError {
        let _ = resume_identities(stopped);
        err
    };

    for (i, m) in plan.members.iter().enumerate() {
        let owner = i == 0;
        match live(&m.identity) {
            Live::Gone | Live::Different if owner => return Err(fail(&stopped, PauseError::OwnerChanged)),
            Live::Gone => skipped.push((m.identity.clone(), "exited")),
            Live::Different => skipped.push((m.identity.clone(), "pid reused")),
            Live::Matches { stopped: true } => skipped.push((m.identity.clone(), "already stopped")),
            Live::Matches { stopped: false } => match signal(m.identity.pid, libc::SIGSTOP) {
                Ok(()) => stopped.push(m.identity.clone()),
                Err(libc::ESRCH) if !owner => skipped.push((m.identity.clone(), "exited")),
                Err(libc::ESRCH) => return Err(fail(&stopped, PauseError::OwnerChanged)),
                Err(errno) => return Err(fail(&stopped, PauseError::Signal { pid: m.identity.pid, errno })),
            },
        }
    }

    // A process started between the snapshot and the owner's stop escaped the plan: take
    // a second look at the tree and stop newcomers. Cheap, and the owner can no longer
    // spawn by now.
    let mut late = 0;
    if !stopped.is_empty() {
        let records = snapshot();
        let known: HashSet<u32> = plan.members.iter().map(|m| m.identity.pid).collect();
        if let Ok(again) = plan_from(&records, plan.owner().pid, plan.ctx, &|pid| wine_prefix(pid)) {
            for m in again.members.into_iter().filter(|m| !known.contains(&m.identity.pid)) {
                let Some(r) = records.iter().find(|r| r.pid == m.identity.pid) else { continue };
                if r.stopped {
                    continue;
                }
                match signal(m.identity.pid, libc::SIGSTOP) {
                    Ok(()) => {
                        stopped.push(m.identity);
                        late += 1;
                    }
                    Err(libc::ESRCH) => {}
                    Err(errno) => return Err(fail(&stopped, PauseError::Signal { pid: m.identity.pid, errno })),
                }
            }
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
                    return Err(fail(&stopped, PauseError::NotStopped { pid: id.pid }));
                }
            }
        }
    }

    Ok(Suspended { stopped, skipped, late, took: began.elapsed() })
}

/// Continue everything [`suspend`] stopped, in reverse order.
pub fn resume(suspended: &Suspended) -> Result<(), PauseError> {
    resume_identities(&suspended.stopped)
}

/// Continue each process that still is the one its identity names, last first, and check
/// that each left the stopped state. Never signals a recycled pid. Idempotent, and best
/// effort: one failure does not stop the others. Also the recovery path for a journal.
pub fn resume_identities(ids: &[ProcIdentity]) -> Result<(), PauseError> {
    let mut pending: Vec<&ProcIdentity> = ids.iter().rev().collect();
    for attempt in 0..4 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(10 * attempt));
        }
        for id in &pending {
            if let Live::Matches { stopped: true } = live(id) {
                let _ = signal(id.pid, libc::SIGCONT);
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
    Err(PauseError::StillStopped { pids: pending.iter().map(|id| id.pid).collect() })
}

/// One line per process for the verbose log: pid, role, executable; then the exclusions.
pub fn describe(plan: &Plan) -> Vec<String> {
    let mut lines: Vec<String> = plan
        .members
        .iter()
        .map(|m| format!("stop pid={} role={:?} exe={}", m.identity.pid, m.role, m.identity.exe))
        .collect();
    lines.extend(plan.excluded.iter().map(|e| format!("skip pid={} why={} exe={}", e.pid, e.why, e.exe)));
    lines
}

#[cfg(test)]
#[path = "macos_tests.rs"]
mod tests;
