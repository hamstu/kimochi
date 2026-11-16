//! Pausing a game on Linux: every process that makes up the game is stopped with `SIGSTOP` and
//! continued with `SIGCONT`, for native games and Wine/Proton games alike (Wine's own process
//! suspension is not used: it needs the game's wineserver and Wine's own process ids).
//!
//! Which processes ([`plan_in`], pure over a snapshot of `/proc` so it is tested with made-up
//! tables):
//! - A game Steam started (Gaming Mode, or a desktop Steam game): every descendant of Steam's
//!   per-game launcher (`reaper … AppId=<id> -- …`), the launcher itself excluded. Under Proton
//!   that includes the game's wineserver: it is a descendant there.
//! - Any other window: its process and that process's descendants, plus, for a Wine game, every
//!   process of the same user in the same Wine prefix (its wineserver and Wine's own services),
//!   or, for a native game, every process running a program from the game's own folder (never a
//!   system folder such as `/usr/bin`).
//! - Never: Steam, Gamescope, the compositor, Xwayland, audio servers, D-Bus, input methods,
//!   portals, container supervisors and launch wrappers (a hard denylist, by name), another
//!   user's processes, kernel threads, zombies, Kimochi itself, its helpers and its ancestors, or
//!   a process someone else already stopped (it is not ours to continue).
//!
//! Order: a prefix's wineserver first (once it is stopped it cannot attach to a game process that
//! is half stopped, and the game's threads simply wait for it), then the game's processes parents
//! before children (a stopped parent starts no new children while the rest are stopped), then the
//! siblings. Resume goes in reverse.
//!
//! Every signal goes through a pidfd opened *before* the identity (pid + `starttime`) is checked,
//! so the process checked is the process signalled even if the pid is reused in between. After
//! stopping, every thread of every member is confirmed stopped (`/proc/<pid>/task/*/stat`), and the
//! guard's `refresh` catches children started during the pause and re-stops anything continued
//! behind our back. `SIGCONT` is sent unconditionally on resume (it is harmless to a running
//! process, and a stop that was still pending must not be left behind).
use super::super::backend::{
    Backend, Excluded, GameRef, Member, PauseError, PidResult, Plan, ProcIdentity, Refusal, RefusalKind, Role,
    Suspended,
};
use std::collections::{HashMap, HashSet, VecDeque};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const SUPPORTED: bool = true;

pub fn backend() -> Box<dyn Backend> {
    Box::new(Linux::default())
}

pub const MECHANISM: &str = "SIGSTOP";
/// The most processes one game may have (a runaway tree is refused rather than half stopped).
const MAX_MEMBERS: usize = 512;
/// How long a suspend waits for every thread to report stopped before it carries on anyway (a
/// thread in uninterruptible sleep stops when it leaves it; `refresh` checks again).
const CONFIRM_STOP: Duration = Duration::from_millis(500);
/// How long resume waits for each process to leave the stopped state before it signals again.
const CONFIRM_CONT: Duration = Duration::from_millis(100);
const CONT_TRIES: u32 = 3;

/// Processes that are never stopped, by `comm` (at most 15 bytes) or executable file name.
const NEVER: &[&str] = &[
    // Steam and Gamescope
    "steam",
    "steamwebhelper",
    "reaper",
    "gamescope",
    "gamescope-wl",
    "gamescopereaper",
    "gamescope-session",
    "mangoapp",
    // container supervisors and launch wrappers
    "bwrap",
    "flatpak",
    "flatpak-portal",
    "flatpak-session-helper",
    "flatpak-spawn",
    // display servers and compositors
    "Xwayland",
    "Xorg",
    "X",
    "gnome-shell",
    "mutter",
    "kwin_wayland",
    "kwin_x11",
    "plasmashell",
    "Hyprland",
    "sway",
    "weston",
    "labwc",
    "wayfire",
    "river",
    "niri",
    "cosmic-comp",
    "xfwm4",
    "openbox",
    "i3",
    // audio
    "pipewire",
    "pipewire-pulse",
    "wireplumber",
    "pulseaudio",
    "jackd",
    // session plumbing
    "init",
    "dbus-daemon",
    "dbus-broker",
    "dbus-broker-launch",
    "dbus-launch",
    "gamemoded",
    "sshd",
    "ssh-agent",
    "gpg-agent",
    "mozc_server",
];
/// Name prefixes that are never stopped.
const NEVER_PREFIX: &[&str] = &[
    "steam-",
    "steamwebhelper",
    "pressure-vessel",
    "pv-",
    "srt-",
    "systemd",
    "xdg-",
    "ibus",
    "fcitx",
    "kimochi",
    "at-spi",
    "gvfs",
    "gnome-session",
    "gnome-keyring",
    "gsd-",
    "kwin",
    "kded",
    "ksmserver",
    "dbus-",
    "pipewire",
];
/// Folders whose programs are never grouped together as "the same game" (system and shared
/// program folders, and the user's own `bin` folders).
const SHARED_FOLDERS: &[&str] = &[
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib32",
    "/lib64",
    "/etc",
    "/opt/google",
    "/snap",
    "/app",
    "/nix",
    "/run",
    "/var",
    "/proc",
    "/sys",
    "/dev",
    "/tmp",
];

/// One process as `/proc` showed it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub uid: u32,
    /// `/proc/<pid>/stat`'s state letter (`R`, `S`, `D`, `T`, `t`, `Z`, …).
    pub state: char,
    pub start: u64,
    pub comm: String,
    pub exe: Option<PathBuf>,
    /// The command line (read for every process: Steam's launcher is found by it).
    pub args: Vec<String>,
    /// The Wine prefix, for Wine's loaders and servers only.
    pub wine_prefix: Option<String>,
    pub kernel: bool,
}

impl Proc {
    fn exe_text(&self) -> String {
        match &self.exe {
            Some(exe) => exe.to_string_lossy().into_owned(),
            None => self.comm.clone(),
        }
    }
    fn identity(&self) -> ProcIdentity {
        ProcIdentity { pid: self.pid, start: self.start, exe: self.exe_text() }
    }
    fn exe_name(&self) -> Option<String> {
        self.exe.as_ref()?.file_name().map(|n| n.to_string_lossy().into_owned())
    }
    fn is_wine(&self) -> bool {
        self.exe.as_deref().is_some_and(crate::text_hook::wine::is_wine_loader)
    }
    fn is_wineserver(&self) -> bool {
        self.exe_name().is_some_and(|n| n.starts_with("wineserver")) || self.comm == "wineserver"
    }
    fn stopped(&self) -> bool {
        matches!(self.state, 'T' | 't')
    }
    fn dead(&self) -> bool {
        matches!(self.state, 'Z' | 'X' | 'x')
    }
    /// The Steam app id this process launches, when it is Steam's per-game launcher.
    fn steam_launcher_of(&self) -> Option<u32> {
        if self.comm != "reaper" && self.exe_name().as_deref() != Some("reaper") {
            return None;
        }
        self.args.iter().skip(1).take_while(|a| a.as_str() != "--").find_map(|a| a.strip_prefix("AppId=")?.parse().ok())
    }
}

/// Why a process is never stopped, when it is on the denylist.
pub fn denied(comm: &str, exe_name: Option<&str>) -> Option<String> {
    for name in [Some(comm), exe_name].into_iter().flatten() {
        if NEVER.contains(&name) || NEVER_PREFIX.iter().any(|p| name.starts_with(p)) {
            return Some(format!("{name} is never stopped"));
        }
    }
    None
}

/// The folder whose programs count as the same game as `exe`, unless it is a shared one.
fn game_folder(exe: &Path, home: Option<&Path>) -> Option<PathBuf> {
    let folder = exe.parent()?;
    let text = folder.to_string_lossy();
    if folder.components().count() < 3
        || SHARED_FOLDERS.iter().any(|s| text == *s || text.starts_with(&format!("{s}/")))
    {
        return None;
    }
    if let Some(home) = home {
        if folder == home
            || folder == home.join("bin")
            || folder == home.join(".local/bin")
            || folder == home.join(".cargo/bin")
        {
            return None;
        }
    }
    Some(folder.to_path_buf())
}

/// A snapshot of the processes on this machine.
#[derive(Clone, Debug, Default)]
pub struct Table {
    procs: HashMap<u32, Proc>,
    children: HashMap<u32, Vec<u32>>,
}

impl Table {
    pub fn new(procs: Vec<Proc>) -> Self {
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for p in &procs {
            children.entry(p.ppid).or_default().push(p.pid);
        }
        for list in children.values_mut() {
            list.sort_unstable();
        }
        Table { procs: procs.into_iter().map(|p| (p.pid, p)).collect(), children }
    }
    pub fn read() -> Self {
        let Ok(dir) = std::fs::read_dir("/proc") else { return Table::default() };
        Table::new(dir.flatten().filter_map(|e| e.file_name().to_str()?.parse().ok()).filter_map(read_proc).collect())
    }
    pub fn get(&self, pid: u32) -> Option<&Proc> {
        self.procs.get(&pid)
    }
    /// `root`'s descendants, breadth first (parents before children), at most `cap`.
    fn descendants(&self, root: u32, cap: usize) -> Vec<u32> {
        let mut out = Vec::new();
        let mut queue = VecDeque::from([root]);
        let mut seen = HashSet::from([root]);
        while let Some(pid) = queue.pop_front() {
            for child in self.children.get(&pid).into_iter().flatten() {
                if seen.insert(*child) && out.len() < cap {
                    out.push(*child);
                    queue.push_back(*child);
                }
            }
        }
        out
    }
    fn ancestors(&self, pid: u32) -> Vec<u32> {
        let mut out = Vec::new();
        let mut at = pid;
        while let Some(p) = self.procs.get(&at) {
            if p.ppid == 0 || p.ppid == at || out.len() >= 64 {
                break;
            }
            out.push(p.ppid);
            at = p.ppid;
        }
        out
    }
}

/// Who is asking: Kimochi's own processes are never part of a game.
#[derive(Clone, Debug)]
pub struct Me {
    pub pid: u32,
    pub uid: u32,
    pub exe: Option<PathBuf>,
    pub home: Option<PathBuf>,
}

impl Me {
    pub fn current() -> Self {
        Me {
            pid: std::process::id(),
            uid: unsafe { libc::geteuid() },
            exe: std::fs::read_link("/proc/self/exe").ok(),
            home: std::env::var_os("HOME").map(PathBuf::from),
        }
    }
    /// Kimochi's processes: the topmost ancestor running Kimochi's own program (the app, when this
    /// is its guard), every descendant of it, and every ancestor of it.
    fn own(&self, table: &Table) -> HashSet<u32> {
        let mut root = self.pid;
        for ancestor in table.ancestors(self.pid) {
            match (table.get(ancestor).and_then(|p| p.exe.as_ref()), &self.exe) {
                (Some(a), Some(b)) if a == b => root = ancestor,
                _ => break,
            }
        }
        let mut own: HashSet<u32> = table.descendants(root, usize::MAX).into_iter().collect();
        own.insert(root);
        own.insert(self.pid);
        own.extend(table.ancestors(root));
        own
    }
}

/// The Steam app id a game reference names: Gamescope's, else the one a Gamescope window source
/// carries (`gamescope:window:<app>:<pid>`).
fn steam_app(game: &GameRef) -> Option<u32> {
    game.steam_app_id.filter(|id| *id != 0).or_else(|| {
        let rest = game.source.as_deref()?.strip_prefix("gamescope:window:")?;
        rest.split(':').next()?.parse().ok().filter(|id| *id != 0)
    })
}

/// The plan for `game` over the snapshot `table`. Pure.
pub fn plan_in(table: &Table, game: &GameRef, me: &Me) -> Result<Plan, Refusal> {
    let own = me.own(table);
    let refuse_root = |p: &Proc| -> Result<(), Refusal> {
        if p.kernel || p.pid <= 1 {
            return Err(Refusal::new(RefusalKind::Protected, format!("pid {} is part of the system", p.pid)));
        }
        if own.contains(&p.pid) {
            return Err(Refusal::new(RefusalKind::Denylisted, format!("pid {} is Kimochi's own", p.pid)));
        }
        if p.uid != me.uid {
            return Err(Refusal::new(
                RefusalKind::Elevated,
                format!("pid {} ({}) runs as uid {}", p.pid, p.comm, p.uid),
            ));
        }

        if let Some(why) = denied(&p.comm, p.exe_name().as_deref()) {
            return Err(Refusal::new(RefusalKind::Denylisted, format!("pid {}: {why}", p.pid)));
        }
        Ok(())
    };
    // (process, role, why), in stop order before the wineserver is moved to the front.
    let mut candidates: Vec<(u32, Role, String)> = Vec::new();
    let launcher_for = |app: u32, near: Option<u32>| -> Option<u32> {
        let launchers: Vec<u32> = table
            .procs
            .values()
            .filter(|p| p.uid == me.uid && p.steam_launcher_of() == Some(app) && !p.dead())
            .map(|p| p.pid)
            .collect();
        // The one above the window's process, else the only one.
        near.and_then(|pid| {
            let mut line = table.ancestors(pid);
            line.insert(0, pid);
            line.into_iter().find(|a| launchers.contains(a))
        })
        .or_else(|| (launchers.len() == 1).then(|| launchers[0]))
    };
    let main = game.pid.filter(|pid| *pid != 0);
    if let Some(pid) = main {
        let p = table.get(pid).ok_or_else(|| Refusal::new(RefusalKind::NotFound, format!("pid {pid} is gone")))?;
        refuse_root(p)?;
    }
    // A game Steam started: the launcher's tree. Gaming Mode names the app; on the desktop, the
    // window's process may sit under a launcher.
    let app = steam_app(game).or_else(|| {
        let pid = main?;
        table.ancestors(pid).into_iter().find_map(|a| table.get(a)?.steam_launcher_of())
    });
    let launcher = app.and_then(|app| launcher_for(app, main));
    if let (Some(launcher), Some(app)) = (launcher, app) {
        if let Some(pid) = main.filter(|pid| !table.descendants(launcher, MAX_MEMBERS * 2).contains(pid)) {
            candidates.push((pid, Role::Main, "owns the game window".into()));
        }
        for pid in table.descendants(launcher, MAX_MEMBERS * 2) {
            let role = if Some(pid) == main { Role::Main } else { Role::Child };
            candidates.push((pid, role, format!("under Steam's launcher for app {app} (pid {launcher})")));
        }
    } else if let Some(pid) = main {
        let p = &table.procs[&pid];
        candidates.push((pid, Role::Main, "owns the game window".into()));
        for child in table.descendants(pid, MAX_MEMBERS * 2) {
            candidates.push((child, Role::Child, format!("descendant of pid {pid}")));
        }
        if !p.is_wine() && !p.is_wineserver() {
            if let Some(folder) = p.exe.as_deref().and_then(|exe| game_folder(exe, me.home.as_deref())) {
                let mut siblings: Vec<&Proc> = table
                    .procs
                    .values()
                    .filter(|q| q.uid == me.uid && q.exe.as_deref().is_some_and(|e| e.starts_with(&folder)))
                    .collect();
                siblings.sort_by_key(|q| q.pid);
                for q in siblings {
                    candidates.push((q.pid, Role::Sibling, format!("runs from the game folder {}", folder.display())));
                }
            }
        }
    } else if let Some(app) = app {
        return Err(Refusal::new(RefusalKind::NotFound, format!("no Steam launcher for app {app}")));
    } else {
        return Err(Refusal::new(RefusalKind::NoPid, "the selection names no process"));
    }
    // Every Wine prefix the game runs in: its wineserver (which detaches from whoever started it,
    // so it is not always a descendant) and Wine's own services there.
    let mut prefixes: Vec<String> = candidates
        .iter()
        .filter_map(|(pid, _, _)| table.get(*pid))
        .filter(|p| p.is_wine() || p.is_wineserver())
        .filter_map(|p| p.wine_prefix.clone())
        .collect();
    prefixes.sort();
    prefixes.dedup();
    for prefix in prefixes {
        let mut siblings: Vec<&Proc> = table
            .procs
            .values()
            .filter(|q| {
                q.uid == me.uid && q.wine_prefix.as_ref() == Some(&prefix) && (q.is_wine() || q.is_wineserver())
            })
            .collect();
        siblings.sort_by_key(|q| q.pid);
        for q in siblings {
            candidates.push((q.pid, Role::Sibling, format!("same Wine prefix {prefix}")));
        }
    }

    let mut members = Vec::new();
    let mut excluded = Vec::new();
    let mut seen = HashSet::new();
    for (pid, role, why) in candidates {
        if !seen.insert(pid) {
            continue;
        }
        let Some(p) = table.get(pid) else { continue };
        let skip = if own.contains(&pid) {
            Some("Kimochi's own".to_string())
        } else if p.uid != me.uid {
            Some(format!("another user's (uid {})", p.uid))
        } else if p.kernel || pid <= 1 {
            Some("a kernel thread".into())
        } else if p.dead() {
            Some("exited".into())
        } else if p.stopped() {
            Some("already stopped by something else".into())
        } else if p.is_wineserver() && !STOP_WINESERVER {
            Some("Wine server (left running)".into())
        } else {
            denied(&p.comm, p.exe_name().as_deref())
        };
        match skip {
            Some(why) => excluded.push(Excluded { pid, exe: p.exe_text(), why }),
            None => members.push((p.is_wineserver(), Member { id: p.identity(), role, why })),
        }
    }
    if members.len() > MAX_MEMBERS {
        return Err(Refusal::new(RefusalKind::Other, format!("{} processes is more than a game has", members.len())));
    }
    // Stable: wineservers first, the rest keep their order.
    members.sort_by_key(|(server, _)| !server);
    let members: Vec<Member> = members.into_iter().map(|(_, m)| m).collect();
    if members.is_empty() {
        let detail = excluded.iter().map(|e| format!("{} {}: {}", e.pid, e.exe, e.why)).collect::<Vec<_>>().join("; ");
        let kind = if excluded.iter().any(|e| e.why.starts_with("another user")) {
            RefusalKind::Elevated
        } else {
            RefusalKind::Other
        };
        return Err(Refusal::new(kind, format!("nothing to stop ({detail})")));
    }
    Ok(Plan { game: game.clone(), members, excluded, mechanism: MECHANISM.into() })
}

/// Whether a prefix's wineserver is stopped with the game. Stopping it first means it can never
/// attach to (ptrace) a game process caught half stopped, which is how a late stop can leave a
/// Wine process stopped for good; leaving it running would let it serve other programs of the
/// same prefix. See docs/game-pause/linux-notes.md (not in the repository) for the test results.
const STOP_WINESERVER: bool = true;

// ---- /proc ----

/// The fields after the command name in `/proc/<pid>/stat` (the name may hold spaces and `)`).
fn stat_fields(stat: &str) -> Option<(&str, Vec<&str>)> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    Some((stat.get(open + 1..close)?, stat.get(close + 1..)?.split_whitespace().collect()))
}

/// (state, ppid, flags, starttime) from `/proc/<pid>/stat`.
fn parse_stat(stat: &str) -> Option<(String, char, u32, u64, u64)> {
    let (comm, fields) = stat_fields(stat)?;
    let state = fields.first()?.chars().next()?;
    let ppid = fields.get(1)?.parse().ok()?;
    let flags = fields.get(6)?.parse().ok()?;
    let start = fields.get(19)?.parse().ok()?;
    Some((comm.to_string(), state, ppid, flags, start))
}

const PF_KTHREAD: u64 = 0x0020_0000;

fn read_proc(pid: u32) -> Option<Proc> {
    let dir = PathBuf::from(format!("/proc/{pid}"));
    let uid = std::fs::metadata(&dir).ok()?.uid();
    let (comm, state, ppid, flags, start) = parse_stat(&std::fs::read_to_string(dir.join("stat")).ok()?)?;
    let exe = std::fs::read_link(dir.join("exe")).ok();
    let args: Vec<String> = std::fs::read(dir.join("cmdline"))
        .map(|b| {
            b.split(|c| *c == 0).filter(|a| !a.is_empty()).map(|a| String::from_utf8_lossy(a).into_owned()).collect()
        })
        .unwrap_or_default();
    let mut proc =
        Proc { pid, ppid, uid, state, start, comm, exe, args, wine_prefix: None, kernel: flags & PF_KTHREAD != 0 };
    if proc.is_wine() || proc.is_wineserver() {
        proc.wine_prefix = std::fs::read(dir.join("environ")).ok().and_then(|env| wine_prefix(&env));
    }
    Some(proc)
}

/// The Wine prefix from a process environment: `WINEPREFIX`, else `$HOME/.wine`.
fn wine_prefix(environ: &[u8]) -> Option<String> {
    let var = |key: &[u8]| {
        environ
            .split(|b| *b == 0)
            .find_map(|kv| kv.strip_prefix(key)?.strip_prefix(b"="))
            .map(|v| String::from_utf8_lossy(v).into_owned())
    };
    let prefix = var(b"WINEPREFIX").filter(|p| !p.is_empty()).or_else(|| Some(format!("{}/.wine", var(b"HOME")?)))?;
    Some(prefix.trim_end_matches('/').to_string())
}

fn read_identity(pid: u32) -> Option<ProcIdentity> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (comm, _, _, _, start) = parse_stat(&stat)?;
    let exe = std::fs::read_link(format!("/proc/{pid}/exe")).map(|e| e.to_string_lossy().into_owned()).unwrap_or(comm);
    Some(ProcIdentity { pid, start, exe })
}

/// Every thread's state letter.
fn thread_states(pid: u32) -> Option<Vec<char>> {
    let mut out = Vec::new();
    for task in std::fs::read_dir(format!("/proc/{pid}/task")).ok()?.flatten() {
        let Ok(stat) = std::fs::read_to_string(task.path().join("stat")) else { continue };
        out.push(parse_stat(&stat)?.1);
    }
    Some(out)
}

/// Whether every thread of `pid` is stopped (exited threads count). `None`: the process is gone.
fn all_stopped(pid: u32) -> Option<bool> {
    let states = thread_states(pid)?;
    Some(!states.is_empty() && states.iter().all(|s| matches!(s, 'T' | 't' | 'Z' | 'X' | 'x')))
}
/// Whether any thread of `pid` is stopped. `None`: gone.
fn any_stopped(pid: u32) -> Option<bool> {
    Some(thread_states(pid)?.iter().any(|s| matches!(s, 'T' | 't')))
}

// ---- signals ----

/// What became of one signal.
#[derive(Debug, PartialEq)]
enum Sent {
    Done,
    /// The process exited.
    Gone,
    /// The pid names another process now.
    Reused,
    /// The process was already stopped by something else (stop only: not adopted).
    NotOurs,
    Failed(i32, String),
}

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

/// A pidfd for `pid`, or `None` where the kernel has none (then `kill` is used).
struct PidFd(i32);
impl Drop for PidFd {
    fn drop(&mut self) {
        unsafe { libc::close(self.0) };
    }
}
fn pidfd_open(pid: u32) -> Result<Option<PidFd>, i32> {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
    if fd >= 0 {
        return Ok(Some(PidFd(fd as i32)));
    }
    match errno() {
        libc::ENOSYS => Ok(None),
        e => Err(e),
    }
}

/// Sends `signal` to `id` if (and only if) the pid is still that process. `skip_if_stopped`: on a
/// stop, leave a process that is already stopped alone (something else stopped it: not ours).
fn send(id: &ProcIdentity, signal: i32, me: &Me, skip_if_stopped: bool) -> Sent {
    if id.pid <= 1 || id.pid == me.pid {
        return Sent::Failed(libc::EPERM, "refusing to signal init or Kimochi".into());
    }
    // Opened first: the identity checked below is then the identity signalled.
    let fd = match pidfd_open(id.pid) {
        Ok(fd) => fd,
        Err(libc::ESRCH) => return Sent::Gone,
        Err(e) => return Sent::Failed(e, "pidfd_open".into()),
    };
    let dir = PathBuf::from(format!("/proc/{}", id.pid));
    let Some(now) = read_identity(id.pid) else { return Sent::Gone };
    if !id.same_process(&now) {
        return Sent::Reused;
    }
    match std::fs::metadata(&dir) {
        Ok(m) if m.uid() == me.uid => {}
        Ok(m) => return Sent::Failed(libc::EPERM, format!("runs as uid {}", m.uid())),
        Err(_) => return Sent::Gone,
    }
    if signal == libc::SIGSTOP {
        let comm = std::fs::read_to_string(dir.join("comm")).unwrap_or_default();
        let exe = std::fs::read_link(dir.join("exe")).ok();
        let exe_name = exe.as_ref().and_then(|e| e.file_name()).map(|n| n.to_string_lossy().into_owned());
        if let Some(why) = denied(comm.trim(), exe_name.as_deref()) {
            return Sent::Failed(libc::EPERM, why);
        }
        if skip_if_stopped && any_stopped(id.pid) == Some(true) {
            return Sent::NotOurs;
        }
    }
    let result = match &fd {
        Some(fd) => unsafe {
            libc::syscall(libc::SYS_pidfd_send_signal, fd.0, signal, std::ptr::null::<libc::siginfo_t>(), 0)
        },
        None => unsafe { libc::kill(id.pid as libc::pid_t, signal) as libc::c_long },
    };
    if result == 0 {
        return Sent::Done;
    }
    match errno() {
        libc::ESRCH => Sent::Gone,
        e => Sent::Failed(e, if signal == libc::SIGSTOP { "SIGSTOP".into() } else { "SIGCONT".into() }),
    }
}

fn micros(since: Instant) -> u64 {
    since.elapsed().as_micros() as u64
}
fn result(pid: u32, ok: bool, code: Option<i64>, note: impl Into<String>, started: Instant) -> PidResult {
    PidResult { pid, ok, code, note: note.into(), micros: micros(started) }
}

/// Stops `members` in order; on a failure, continues what it stopped (reverse order) and fails.
/// Members that exited, were reused or were already stopped by something else are skipped.
fn stop_all<'a>(
    members: impl IntoIterator<Item = &'a ProcIdentity>,
    me: &Me,
    stopped: &mut Vec<ProcIdentity>,
    results: &mut Vec<PidResult>,
) -> Result<(), PauseError> {
    let first_new = stopped.len();
    for id in members {
        let started = Instant::now();
        match send(id, libc::SIGSTOP, me, true) {
            Sent::Done => {
                stopped.push(id.clone());
                results.push(result(id.pid, true, None, "stopped", started));
            }
            Sent::Gone => results.push(result(id.pid, true, None, "exited before it was stopped", started)),
            Sent::Reused => results.push(result(id.pid, true, None, "pid reused by another process; skipped", started)),
            Sent::NotOurs => {
                results.push(result(id.pid, true, None, "already stopped by something else; left alone", started))
            }
            Sent::Failed(code, what) => {
                results.push(result(id.pid, false, Some(code.into()), format!("{what} failed"), started));
                let undo: Vec<ProcIdentity> = stopped.drain(first_new..).collect();
                continue_all(undo.iter().rev(), me, results);
                let refusal = (code == libc::EPERM || code == libc::EACCES).then_some(RefusalKind::PermissionDenied);
                return Err(PauseError {
                    message: format!("could not stop {} ({what}: {})", id.exe, std::io::Error::from_raw_os_error(code)),
                    pid: Some(id.pid),
                    code: Some(code.into()),
                    refusal,
                    results: std::mem::take(results),
                });
            }
        }
    }
    Ok(())
}

/// Continues every one of `members` (in the order given), confirming each left the stopped
/// state. Returns the pids that could not be continued.
fn continue_all<'a>(
    members: impl IntoIterator<Item = &'a ProcIdentity>,
    me: &Me,
    results: &mut Vec<PidResult>,
) -> Vec<(u32, i64, String)> {
    let mut failed = Vec::new();
    for id in members {
        let started = Instant::now();
        let mut outcome = None;
        for _ in 0..CONT_TRIES {
            match send(id, libc::SIGCONT, me, false) {
                Sent::Done => {}
                Sent::Gone => {
                    outcome = Some(result(id.pid, true, None, "exited", started));
                    break;
                }
                Sent::Reused => {
                    outcome = Some(result(id.pid, true, None, "pid reused by another process; skipped", started));
                    break;
                }
                Sent::NotOurs => unreachable!("only stops skip stopped processes"),
                Sent::Failed(code, what) => {
                    outcome = Some(result(id.pid, false, Some(code.into()), format!("{what} failed"), started));
                    failed.push((id.pid, code.into(), what));
                    break;
                }
            }
            let deadline = Instant::now() + CONFIRM_CONT;
            loop {
                match any_stopped(id.pid) {
                    None => {
                        outcome = Some(result(id.pid, true, None, "exited", started));
                        break;
                    }
                    Some(false) => {
                        outcome = Some(result(id.pid, true, None, "continued", started));
                        break;
                    }
                    Some(true) if Instant::now() >= deadline => break,
                    Some(true) => std::thread::sleep(Duration::from_millis(2)),
                }
            }
            if outcome.is_some() {
                break;
            }
        }
        match outcome {
            Some(r) => results.push(r),
            None => {
                results.push(result(id.pid, false, None, "still stopped after SIGCONT", started));
                failed.push((id.pid, 0, "still stopped after SIGCONT".into()));
            }
        }
    }
    failed
}

/// Waits (bounded) until every thread of every stopped process is stopped; notes the stragglers.
fn confirm_stopped(stopped: &[ProcIdentity], results: &mut Vec<PidResult>) {
    let deadline = Instant::now() + CONFIRM_STOP;
    let mut waiting: Vec<&ProcIdentity> = stopped.iter().collect();
    while !waiting.is_empty() {
        waiting.retain(|id| all_stopped(id.pid) == Some(false));
        if waiting.is_empty() || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    for id in waiting {
        results.push(PidResult {
            pid: id.pid,
            ok: true,
            code: None,
            note: "stop still pending after 500 ms (uninterruptible wait?)".into(),
            micros: CONFIRM_STOP.as_micros() as u64,
        });
    }
}

#[derive(Default)]
pub struct Linux {
    /// Who counts as Kimochi; tests stand in for an unrelated caller (their throwaway processes
    /// are their own children, which Kimochi never stops).
    me: Option<Me>,
    /// The game's native PipeWire streams parked for the pause held now (see `linux_audio`).
    audio: std::sync::Mutex<Option<audio::Parked>>,
}

/// Audio steps as log lines in a suspend's results (pid 0: they are about the game as a whole).
fn audio_results(steps: audio::Steps) -> Vec<PidResult> {
    steps.into_iter().map(|note| PidResult { pid: 0, ok: true, code: None, note, micros: 0 }).collect()
}

impl Linux {
    fn me(&self) -> Me {
        self.me.clone().unwrap_or_else(Me::current)
    }
    /// Members of a fresh plan for the same game that are not stopped yet.
    fn second_pass(
        &self,
        game: &GameRef,
        me: &Me,
        stopped: &mut Vec<ProcIdentity>,
        results: &mut Vec<PidResult>,
    ) -> Result<usize, PauseError> {
        let mut added = 0;
        for _ in 0..3 {
            let Ok(plan) = plan_in(&Table::read(), game, me) else { break };
            let new: Vec<ProcIdentity> = plan
                .members
                .into_iter()
                .map(|m| m.id)
                .filter(|id| !stopped.iter().any(|s| s.same_process(id)))
                .collect();
            if new.is_empty() {
                break;
            }
            let before = stopped.len();
            stop_all(new.iter(), me, stopped, results)?;
            added += stopped.len() - before;
        }
        Ok(added)
    }
}

impl Backend for Linux {
    fn name(&self) -> &'static str {
        "linux-sigstop"
    }

    fn plan(&self, game: &GameRef) -> Result<Plan, Refusal> {
        plan_in(&Table::read(), game, &self.me())
    }

    fn suspend(&self, plan: &Plan) -> Result<Suspended, PauseError> {
        let me = self.me();
        let mut stopped = Vec::new();
        let mut results = Vec::new();
        // While the game still runs: its own PipeWire streams must leave the shared output first.
        let mut steps = Vec::new();
        let pids: Vec<u32> = plan.members.iter().map(|m| m.id.pid).collect();
        let parked = audio::park(&pids, &mut steps);
        let fail = |error: PauseError, parked, mut steps: audio::Steps| {
            audio::unpark(parked, &mut steps);
            let mut results = error.results.clone();
            results.extend(audio_results(steps));
            Err(PauseError { results, ..error })
        };
        if let Err(error) = stop_all(plan.members.iter().map(|m| &m.id), &me, &mut stopped, &mut results) {
            return fail(error, parked, steps);
        }
        // Children started while the plan was carried out.
        if let Err(error) = self.second_pass(&plan.game, &me, &mut stopped, &mut results) {
            let mut results = error.results.clone();
            continue_all(stopped.iter().rev(), &me, &mut results);
            return fail(PauseError { results, ..error }, parked, steps);
        }
        if stopped.is_empty() {
            let error = PauseError {
                refusal: Some(RefusalKind::NotFound),
                results,
                ..PauseError::new("none of the game's processes is running any more")
            };
            return fail(error, parked, steps);
        }
        confirm_stopped(&stopped, &mut results);
        results.extend(audio_results(steps));
        if let Some(previous) = std::mem::replace(&mut *self.audio.lock().unwrap_or_else(|e| e.into_inner()), parked) {
            // A pause is always resumed before the next; should one not have been, its sink goes.
            drop(previous);
        }
        Ok(Suspended { game: plan.game.clone(), members: stopped, mechanism: MECHANISM.into(), results })
    }

    fn resume(&self, suspended: &Suspended) -> Result<(), PauseError> {
        self.resume_with_results(suspended).map(|_| ())
    }

    fn resume_with_results(&self, suspended: &Suspended) -> Result<Vec<PidResult>, PauseError> {
        let me = self.me();
        let mut results = Vec::new();
        let failed = continue_all(suspended.members.iter().rev(), &me, &mut results);
        // Once the game runs again: its streams back where they were (also streams parked by a
        // guard that died, found through the metadata), and the park sink gone.
        let mut steps = Vec::new();
        let parked = self.audio.lock().unwrap_or_else(|e| e.into_inner()).take();
        audio::unpark(parked, &mut steps);
        results.extend(audio_results(steps));
        match failed.first() {
            None => Ok(results),
            Some((pid, code, _)) => Err(PauseError {
                message: format!(
                    "could not resume {}",
                    failed.iter().map(|(pid, _, what)| format!("{pid} ({what})")).collect::<Vec<_>>().join(", ")
                ),
                pid: Some(*pid),
                code: (*code != 0).then_some(*code),
                refusal: None,
                results,
            }),
        }
    }

    fn identity(&self, pid: u32) -> Option<ProcIdentity> {
        read_identity(pid)
    }

    fn stopped(&self, id: &ProcIdentity) -> Option<bool> {
        let fd = pidfd_open(id.pid).ok()?;
        if !read_identity(id.pid).is_some_and(|now| id.same_process(&now)) {
            return None;
        }
        let stopped = any_stopped(id.pid);
        drop(fd);
        stopped
    }

    fn refresh(&self, suspended: &mut Suspended) -> Result<(), PauseError> {
        let me = self.me();
        let mut results = Vec::new();
        // Continued behind our back (a debugger, a stray SIGCONT): stop again. Gone: drop.
        let mut gone = Vec::new();
        for id in &suspended.members {
            match all_stopped(id.pid) {
                None => gone.push(id.pid),
                Some(true) => {}
                Some(false) => {
                    // A process with a stop still pending also lands here; a second SIGSTOP is
                    // harmless. It is ours, so it is stopped even if some thread already is.
                    let started = Instant::now();
                    match send(id, libc::SIGSTOP, &me, false) {
                        Sent::Done => results.push(result(id.pid, true, None, "stopped again", started)),
                        Sent::Gone | Sent::Reused => gone.push(id.pid),
                        Sent::NotOurs => {}
                        Sent::Failed(code, what) => {
                            results.push(result(id.pid, false, Some(code.into()), format!("{what} failed"), started))
                        }
                    }
                }
            }
        }
        suspended.members.retain(|id| !gone.contains(&id.pid));
        let before = suspended.members.len();
        let added = self.second_pass(&suspended.game, &me, &mut suspended.members, &mut results);
        suspended.results = results.clone();
        match added {
            Ok(_) => {
                if suspended.members.len() > before {
                    confirm_stopped(&suspended.members[before..], &mut suspended.results);
                }
                match results.iter().find(|r| !r.ok).cloned() {
                    Some(r) => Err(PauseError {
                        pid: Some(r.pid),
                        code: r.code,
                        results,
                        ..PauseError::new(format!("refresh: pid {}: {}", r.pid, r.note))
                    }),
                    None => Ok(()),
                }
            }
            // The new processes were rolled back; the ones already held stay held.
            Err(error) => Err(error),
        }
    }
}

#[path = "linux_audio.rs"]
mod audio;

#[cfg(test)]
#[path = "linux_tests.rs"]
mod tests;
