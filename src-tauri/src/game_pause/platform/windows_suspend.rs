//! Pausing a game on Windows: suspend every process that makes up the game, resume it exactly.
//!
//! What it does, in order:
//!
//! - **Plan**: the window's process, plus its descendants that are part of the game (a thin
//!   launcher's engine child with another image extension, and children running the same
//!   program, as an Electron or NW.js game's renderers). Each comes with its identity (pid +
//!   creation time + image), so a pid that was reused by another program is never touched.
//!   Refused, with a reason the UI can show: no pid, Kimochi itself, Windows' own processes and
//!   Store apps, another user's processes, elevated processes while Kimochi is not, protected
//!   processes (which is how anti-cheat clients usually run), and any process Windows does not
//!   let Kimochi suspend.
//! - **Suspend**: per process, either the handle-bound process state change (Windows 11): the
//!   freeze belongs to a handle, and closing that handle — including the holder dying —
//!   undoes it; or `NtSuspendProcess`. Neither is atomic: a thread created during the call can
//!   escape, so a second pass suspends any thread whose suspend count did not go up. If any
//!   process cannot be suspended, everything already suspended is resumed (all or nothing).
//! - **Resume**: undoes exactly what suspend did, in reverse order, then verifies that no
//!   thread is left with a higher suspend count than it had before the pause (a thread the game
//!   suspended itself keeps its own count), and corrects any that are.
//!
//! Nothing here sends a message to, or waits on, the game: a frozen game cannot answer, and a
//! synchronous call into it would hang Kimochi.
//!
//! A `Frozen` value owns one process's handles; the backend (`windows.rs`) keeps them in the
//! guard process for the whole pause. `recover` resumes a process nobody holds any more (an
//! orphan named by the journal), and refuses to touch a pid whose identity no longer matches.
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use windows::core::{s, w, PWSTR};
use windows::Wdk::System::SystemInformation::{NtQuerySystemInformation, SystemProcessInformation};
use windows::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, FILETIME, HANDLE, STATUS_INFO_LENGTH_MISMATCH};
use windows::Win32::Security::{
    EqualSid, GetTokenInformation, TokenElevation, TokenUser, TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, GetProcessIdOfThread, GetProcessInformation, GetProcessTimes, OpenProcess,
    OpenProcessToken, OpenThread, ProcessProtectionLevelInfo, QueryFullProcessImageNameW, ResumeThread, SuspendThread,
    PROCESS_ACCESS_RIGHTS, PROCESS_NAME_WIN32, PROCESS_PROTECTION_LEVEL_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SET_INFORMATION, PROCESS_SUSPEND_RESUME, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};
use windows::Win32::System::WindowsProgramming::{SYSTEM_PROCESS_INFORMATION, SYSTEM_THREAD_INFORMATION};

use crate::text_hook::process::{is_engine_child, is_same_program, is_system_image};

/// Whether `now` is still the process `then` named (pid + creation time; the path is not
/// compared: it can read differently through another handle).
fn same(then: &Identity, now: Option<&Identity>) -> bool {
    now.is_some_and(|now| now.pid == then.pid && now.created == then.created)
}

/// A process handle (or any kernel handle) closed on drop.
struct Owned(HANDLE);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}
// Kernel handles may be used and closed from any thread.
unsafe impl Send for Owned {}
unsafe impl Sync for Owned {}

// ---------------------------------------------------------------------------------------------
// ntdll entry points, resolved at run time (none of them is in the Windows SDK import libs).

type NtStatus = i32;
type NtProcessFn = unsafe extern "system" fn(HANDLE) -> NtStatus;
type NtQueryInformationThreadFn = unsafe extern "system" fn(HANDLE, u32, *mut c_void, u32, *mut u32) -> NtStatus;
type NtCreateProcessStateChangeFn = unsafe extern "system" fn(*mut HANDLE, u32, *const c_void, HANDLE, u64) -> NtStatus;
type NtChangeProcessStateFn = unsafe extern "system" fn(HANDLE, HANDLE, u32, *mut c_void, usize, u64) -> NtStatus;

/// `THREADINFOCLASS::ThreadSuspendCount` (Windows 8.1+).
const THREAD_SUSPEND_COUNT: u32 = 35;
/// `PROCESS_STATE_CHANGE_TYPE`.
const STATE_CHANGE_SUSPEND: u32 = 0;
const STATE_CHANGE_RESUME: u32 = 1;
/// `PROCESS_STATE_ALL_ACCESS`: STANDARD_RIGHTS_REQUIRED | SYNCHRONIZE | PROCESS_STATE_CHANGE_STATE.
const PROCESS_STATE_ALL_ACCESS: u32 = 0x000F_0000 | 0x0010_0000 | 0x0001;
/// `PROTECTION_LEVEL_NONE` from `GetProcessInformation(ProcessProtectionLevelInfo)`.
const PROTECTION_LEVEL_NONE: u32 = 0xFFFF_FFFE;
/// `STILL_ACTIVE` from `GetExitCodeProcess`.
const STILL_ACTIVE: u32 = 259;

struct Nt {
    suspend: Option<NtProcessFn>,
    resume: Option<NtProcessFn>,
    query_thread: Option<NtQueryInformationThreadFn>,
    create_state_change: Option<NtCreateProcessStateChangeFn>,
    change_state: Option<NtChangeProcessStateFn>,
}

fn nt() -> &'static Nt {
    static NT: OnceLock<Nt> = OnceLock::new();
    NT.get_or_init(|| unsafe {
        let Ok(ntdll) = GetModuleHandleW(w!("ntdll.dll")) else {
            return Nt {
                suspend: None,
                resume: None,
                query_thread: None,
                create_state_change: None,
                change_state: None,
            };
        };
        macro_rules! sym {
            ($name:expr, $ty:ty) => {
                GetProcAddress(ntdll, $name).map(|f| std::mem::transmute::<_, $ty>(f))
            };
        }
        Nt {
            suspend: sym!(s!("NtSuspendProcess"), NtProcessFn),
            resume: sym!(s!("NtResumeProcess"), NtProcessFn),
            query_thread: sym!(s!("NtQueryInformationThread"), NtQueryInformationThreadFn),
            create_state_change: sym!(s!("NtCreateProcessStateChange"), NtCreateProcessStateChangeFn),
            change_state: sym!(s!("NtChangeProcessState"), NtChangeProcessStateFn),
        }
    })
}

fn nt_ok(status: NtStatus) -> Result<(), u32> {
    if status >= 0 {
        Ok(())
    } else {
        Err(status as u32)
    }
}

// ---------------------------------------------------------------------------------------------
// Types.

/// Which process this is, beyond its pid: Windows reuses pids, never (pid, creation time).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub pid: u32,
    /// Creation time as a FILETIME (100 ns ticks since 1601), from `GetProcessTimes`.
    pub created: u64,
    pub exe: PathBuf,
}

/// Why a game cannot be paused. The message is for the reader; `code` for logs and the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The window has no process id (or it is 0/4, the system).
    NoPid,
    /// The process is Kimochi itself.
    OwnProcess,
    /// Part of Windows, or a Store (packaged) app.
    System,
    /// Runs as another user.
    OtherUser,
    /// Runs as administrator while Kimochi does not.
    Elevated,
    /// A protected process (anti-cheat clients and some DRM run this way).
    Protected,
    /// The process ended.
    Gone,
    /// Windows refused to let Kimochi suspend it, for another reason (the Win32 error).
    Denied(u32),
    /// ntdll lacks the suspend entry points (never seen on supported Windows).
    Unsupported,
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Refusal::NoPid => "no-pid",
            Refusal::OwnProcess => "own-process",
            Refusal::System => "system",
            Refusal::OtherUser => "other-user",
            Refusal::Elevated => "elevated",
            Refusal::Protected => "protected",
            Refusal::Gone => "gone",
            Refusal::Denied(_) => "denied",
            Refusal::Unsupported => "unsupported",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Refusal::NoPid => "Kimochi cannot tell which program this window belongs to".into(),
            Refusal::OwnProcess => "this is Kimochi itself".into(),
            Refusal::System => "this is part of Windows or a Store app".into(),
            Refusal::OtherUser => "this game runs as another Windows user".into(),
            Refusal::Elevated => "this game runs as administrator and Kimochi does not".into(),
            Refusal::Protected => "Windows protects this game (often anti-cheat), so it cannot be paused".into(),
            Refusal::Gone => "the game is no longer running".into(),
            Refusal::Denied(code) => format!("Windows did not let Kimochi pause this game (error {code})"),
            Refusal::Unsupported => "this version of Windows cannot pause programs".into(),
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// Why a process is part of the game.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    /// Owns the game's window.
    Window,
    /// A launcher's engine (`game.exe` running `game.bin`).
    EngineChild,
    /// A child running the same program (a Chromium-based game's renderer).
    SameProgram,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub identity: Identity,
    pub role: Role,
}

/// A descendant that was looked at and left out, for the verbose log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Excluded {
    pub pid: u32,
    pub name: String,
    pub why: String,
}

/// Every process that must stop for this game, in stop order (window process first).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tree {
    pub processes: Vec<Planned>,
    pub excluded: Vec<Excluded>,
}

/// How a process was frozen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mechanism {
    /// `NtCreateProcessStateChange` + `NtChangeProcessState`: undone when its handle closes.
    StateChange,
    /// `NtSuspendProcess`: stays until `NtResumeProcess`, whoever calls it.
    SuspendProcess,
}

impl Mechanism {
    pub fn name(self) -> &'static str {
        match self {
            Mechanism::StateChange => "state-change",
            Mechanism::SuspendProcess => "suspend-process",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FreezeError {
    /// Planning refused the process.
    Refused(Refusal),
    /// The suspend call failed (NTSTATUS).
    Suspend { pid: u32, status: u32 },
}

impl std::fmt::Display for FreezeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FreezeError::Refused(r) => write!(f, "{r}"),
            FreezeError::Suspend { pid, status } => write!(f, "suspending pid {pid} failed (NTSTATUS {status:#010x})"),
        }
    }
}

/// Per-process result of a suspend or resume, for the verbose log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Step {
    pub pid: u32,
    pub mechanism: &'static str,
    /// Threads frozen individually because they escaped the process-wide call.
    pub escaped: usize,
    /// Threads whose suspend count had to be corrected on resume.
    pub corrected: usize,
    pub micros: u64,
    pub error: Option<String>,
}

/// One frozen process: its handles, and what to undo.
pub(super) struct Frozen {
    pub(super) identity: Identity,
    pub(super) mechanism: Mechanism,
    process: Owned,
    /// The state change object, for `Mechanism::StateChange`. Closing it resumes the process.
    state: Option<Owned>,
    /// Each thread's suspend count before the pause (threads the game suspended itself).
    baseline: HashMap<u32, u32>,
    /// Process-wide suspends issued so far through `mechanism` (1, plus one per second pass
    /// that found an escaped thread). Each one is undone by one resume. Every one is the same
    /// kind as the first, so with the state change mechanism all of them belong to the handle
    /// and are undone when it closes, guard death included.
    suspends: u32,
}

// ---------------------------------------------------------------------------------------------
// Process facts.

fn filetime(t: FILETIME) -> u64 {
    (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)
}

fn open_process(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> Result<Owned, u32> {
    unsafe { OpenProcess(access, false, pid) }.map(Owned).map_err(|e| (e.code().0 as u32) & 0xFFFF)
}

fn image(handle: HANDLE) -> Option<PathBuf> {
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) }.ok()?;
    Some(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
}

fn created(handle: HANDLE) -> Option<u64> {
    let (mut c, mut e, mut k, mut u) = Default::default();
    unsafe { GetProcessTimes(handle, &mut c, &mut e, &mut k, &mut u) }.ok()?;
    Some(filetime(c))
}

fn running(handle: HANDLE) -> bool {
    let mut code = 0u32;
    unsafe { GetExitCodeProcess(handle, &mut code) }.is_ok() && code == STILL_ACTIVE
}

fn identity_of(handle: HANDLE, pid: u32) -> Option<Identity> {
    Some(Identity { pid, created: created(handle)?, exe: image(handle)? })
}

/// The process's identity now, or `None` if it is gone or cannot be inspected.
pub fn identity(pid: u32) -> Option<Identity> {
    let process = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION).ok()?;
    running(process.0).then(|| identity_of(process.0, pid)).flatten()
}

fn is_protected(handle: HANDLE) -> bool {
    let mut info = PROCESS_PROTECTION_LEVEL_INFORMATION::default();
    unsafe {
        GetProcessInformation(
            handle,
            ProcessProtectionLevelInfo,
            (&mut info as *mut PROCESS_PROTECTION_LEVEL_INFORMATION).cast(),
            std::mem::size_of::<PROCESS_PROTECTION_LEVEL_INFORMATION>() as u32,
        )
    }
    .is_ok()
        && info.ProtectionLevel.0 != PROTECTION_LEVEL_NONE
}

/// The token's user SID bytes and whether it is elevated.
fn token_facts(process: HANDLE) -> Option<(Vec<u8>, bool)> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
    let token = Owned(token);
    let mut elevation = TOKEN_ELEVATION::default();
    let mut len = 0u32;
    unsafe {
        GetTokenInformation(
            token.0,
            TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
    }
    .ok()?;
    let mut buf = vec![0u8; 256];
    unsafe { GetTokenInformation(token.0, TokenUser, Some(buf.as_mut_ptr().cast()), buf.len() as u32, &mut len) }
        .ok()?;
    buf.truncate(len as usize);
    Some((buf, elevation.TokenIsElevated != 0))
}

fn same_user(a: &[u8], b: &[u8]) -> bool {
    // Both buffers start with a TOKEN_USER whose SID pointer points into the same buffer.
    unsafe {
        let a = &*(a.as_ptr() as *const TOKEN_USER);
        let b = &*(b.as_ptr() as *const TOKEN_USER);
        EqualSid(a.User.Sid, b.User.Sid).is_ok()
    }
}

fn own_token() -> Option<&'static (Vec<u8>, bool)> {
    static OWN: OnceLock<Option<(Vec<u8>, bool)>> = OnceLock::new();
    OWN.get_or_init(|| token_facts(unsafe { GetCurrentProcess() })).as_ref()
}

/// Whether this one process may be paused, and its identity if so.
pub fn check(pid: u32) -> Result<Identity, Refusal> {
    if pid == 0 || pid == 4 {
        return Err(Refusal::NoPid);
    }
    if pid == std::process::id() {
        return Err(Refusal::OwnProcess);
    }
    let query = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION).map_err(|code| {
        if code == ERROR_ACCESS_DENIED.0 {
            Refusal::Denied(code)
        } else {
            Refusal::Gone
        }
    })?;
    if !running(query.0) {
        return Err(Refusal::Gone);
    }
    let identity = identity_of(query.0, pid).ok_or(Refusal::Gone)?;
    if is_system_image(&identity.exe) {
        return Err(Refusal::System);
    }
    if is_protected(query.0) {
        return Err(Refusal::Protected);
    }
    let theirs = token_facts(query.0);
    if let (Some((their_user, their_elevated)), Some((our_user, our_elevated))) = (&theirs, own_token()) {
        if !same_user(their_user, our_user) {
            return Err(Refusal::OtherUser);
        }
        if *their_elevated && !*our_elevated {
            return Err(Refusal::Elevated);
        }
    }
    // The right that matters. Refused for protected and elevated processes, and by anti-cheat
    // that strips handle rights.
    open_process(pid, PROCESS_SUSPEND_RESUME).map_err(|code| match theirs {
        // The token could not even be read: a process hardened against inspection.
        None if code == ERROR_ACCESS_DENIED.0 => Refusal::Protected,
        _ => Refusal::Denied(code),
    })?;
    Ok(identity)
}

// ---------------------------------------------------------------------------------------------
// Planning.

/// One entry of a process snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcEntry {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
}

fn snapshot_processes() -> Vec<ProcEntry> {
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };
    let snapshot = Owned(snapshot);
    let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut out = Vec::new();
    let mut ok = unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_ok();
    while ok {
        let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
        out.push(ProcEntry {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
            name: String::from_utf16_lossy(&entry.szExeFile[..len]),
        });
        ok = unsafe { Process32NextW(snapshot.0, &mut entry) }.is_ok();
    }
    out
}

/// Which descendants of `root` belong to the game, by the hooking rules: engine children of a
/// launcher and children running the same program, transitively. Pure, for tests. Returns the
/// included pids in stop order (root first, then breadth-first) and the excluded children.
///
/// Parent links in a snapshot can point at a pid that was reused since; a child created before
/// its "parent" is not one. `created` gives creation times where known to rule those out.
pub fn select_tree(
    root: u32,
    all: &[ProcEntry],
    created: &dyn Fn(u32) -> Option<u64>,
) -> (Vec<(u32, Role)>, Vec<Excluded>) {
    const MAX: usize = 64;
    let name_of = |pid: u32| all.iter().find(|p| p.pid == pid).map(|p| p.name.as_str());
    let mut included = vec![(root, Role::Window)];
    let mut excluded = Vec::new();
    let mut i = 0;
    while i < included.len() && included.len() < MAX {
        let parent = included[i].0;
        let parent_name = name_of(parent);
        let parent_created = created(parent);
        for child in all.iter().filter(|p| p.parent == parent && p.pid != parent && p.pid != 0) {
            if included.iter().any(|(pid, _)| *pid == child.pid) {
                continue;
            }
            if let (Some(p), Some(c)) = (parent_created, created(child.pid)) {
                if c < p {
                    excluded.push(Excluded {
                        pid: child.pid,
                        name: child.name.clone(),
                        why: "parent pid was reused".into(),
                    });
                    continue;
                }
            }
            let role = if is_engine_child(Path::new(&child.name)) {
                Some(Role::EngineChild)
            } else if is_same_program(parent_name, &child.name) {
                Some(Role::SameProgram)
            } else {
                None
            };
            match role {
                Some(role) => included.push((child.pid, role)),
                None => excluded.push(Excluded {
                    pid: child.pid,
                    name: child.name.clone(),
                    why: "not the game's engine or the same program".into(),
                }),
            }
        }
        i += 1;
    }
    (included, excluded)
}

/// Every process that must stop for the game whose window belongs to `pid`.
///
/// The window's own process must pass `check`, or the whole game is refused. A child that does
/// not pass (protected, elevated) refuses the game too: pausing only part of it would leave the
/// rest running against a frozen partner, which is worse than not pausing.
pub fn plan(pid: u32) -> Result<Tree, Refusal> {
    if nt().suspend.is_none() || nt().resume.is_none() {
        return Err(Refusal::Unsupported);
    }
    check(pid)?;
    let all = snapshot_processes();
    let (selected, excluded) =
        select_tree(pid, &all, &|p| open_process(p, PROCESS_QUERY_LIMITED_INFORMATION).ok().and_then(|h| created(h.0)));
    let mut processes = Vec::with_capacity(selected.len());
    for (p, role) in selected {
        match check(p) {
            Ok(identity) => processes.push(Planned { identity, role }),
            // A child that exited since the snapshot is simply not part of the game any more.
            Err(Refusal::Gone) if p != pid => {}
            Err(refusal) => return Err(refusal),
        }
    }
    Ok(Tree { processes, excluded })
}

// ---------------------------------------------------------------------------------------------
// Threads.

/// Every thread on the system, by process, as of one moment. Listing threads is where a pause
/// spent its time (Windows lists them for the whole system at once), so each step takes one list
/// and shares it with every process it touches: a 40-process game (a browser) took 5 s to pause
/// when each process listed every thread several times.
pub(super) struct Threads(HashMap<u32, Vec<u32>>);

impl Threads {
    /// One `NtQuerySystemInformation(SystemProcessInformation)` call; Tool Help if that fails.
    pub(super) fn now() -> Threads {
        system_threads().unwrap_or_else(toolhelp_threads)
    }

    pub(super) fn of(&self, pid: u32) -> &[u32] {
        self.0.get(&pid).map_or(&[], Vec::as_slice)
    }
}

fn system_threads() -> Option<Threads> {
    // About 1 MB with ten thousand threads; grown to what the call asks for, with room for the
    // processes started in between.
    let mut len: usize = 2 << 20;
    for _ in 0..6 {
        // u64s, so the records are aligned.
        let mut buffer = vec![0u64; len.div_ceil(8)];
        let size = u32::try_from(buffer.len() * 8).ok()?;
        let mut needed = 0u32;
        let status = unsafe {
            NtQuerySystemInformation(SystemProcessInformation, buffer.as_mut_ptr().cast(), size, &mut needed)
        };
        if status == STATUS_INFO_LENGTH_MISMATCH {
            len = (needed as usize + (256 << 10)).max(len * 2);
            continue;
        }
        nt_ok(status.0).ok()?;
        let written = (needed as usize).min(buffer.len() * 8);
        let bytes = unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), written) };
        return Some(Threads(parse_system_threads(bytes)));
    }
    None
}

/// Walk the `SYSTEM_PROCESS_INFORMATION` records, never past the bytes written.
fn parse_system_threads(bytes: &[u8]) -> HashMap<u32, Vec<u32>> {
    let head = std::mem::size_of::<SYSTEM_PROCESS_INFORMATION>();
    let each = std::mem::size_of::<SYSTEM_THREAD_INFORMATION>();
    let mut out = HashMap::new();
    let mut at = 0usize;
    while at + head <= bytes.len() {
        let process: SYSTEM_PROCESS_INFORMATION = unsafe { std::ptr::read_unaligned(bytes.as_ptr().add(at).cast()) };
        let first = at + head;
        let fit = (bytes.len() - first) / each;
        let tids = (0..(process.NumberOfThreads as usize).min(fit))
            .map(|i| {
                let thread: SYSTEM_THREAD_INFORMATION =
                    unsafe { std::ptr::read_unaligned(bytes.as_ptr().add(first + i * each).cast()) };
                thread.ClientId.UniqueThread.0 as usize as u32
            })
            .collect();
        out.insert(process.UniqueProcessId.0 as usize as u32, tids);
        if process.NextEntryOffset == 0 {
            break;
        }
        at += process.NextEntryOffset as usize;
    }
    out
}

/// The same list through Tool Help (slower: it copies every thread on the system first).
fn toolhelp_threads() -> Threads {
    let mut out: HashMap<u32, Vec<u32>> = HashMap::new();
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }) else {
        return Threads(out);
    };
    let snapshot = Owned(snapshot);
    let mut entry = THREADENTRY32 { dwSize: std::mem::size_of::<THREADENTRY32>() as u32, ..Default::default() };
    let mut ok = unsafe { Thread32First(snapshot.0, &mut entry) }.is_ok();
    while ok {
        out.entry(entry.th32OwnerProcessID).or_default().push(entry.th32ThreadID);
        ok = unsafe { Thread32Next(snapshot.0, &mut entry) }.is_ok();
    }
    Threads(out)
}

/// Tool Help's list, to check the native one against (tests).
#[cfg(test)]
pub(super) fn toolhelp_threads_of(pid: u32) -> Vec<u32> {
    toolhelp_threads().of(pid).to_vec()
}

/// Open a listed thread, only if it still belongs to `pid`: a list is shared by a whole step, and a
/// thread that ended since may have left its id to another process's thread.
fn open_thread(pid: u32, tid: u32) -> Option<Owned> {
    let thread =
        Owned(unsafe { OpenThread(THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION, false, tid) }.ok()?);
    (unsafe { GetProcessIdOfThread(thread.0) } == pid).then_some(thread)
}

/// A thread's suspend count, read without changing it.
fn suspend_count(thread: HANDLE) -> Option<u32> {
    let query = nt().query_thread?;
    let mut count = 0u32;
    let status = unsafe {
        query(
            thread,
            THREAD_SUSPEND_COUNT,
            (&mut count as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
            std::ptr::null_mut(),
        )
    };
    if status >= 0 {
        return Some(count);
    }
    // Older Windows: SuspendThread returns the previous count; undo it at once.
    let previous = unsafe { SuspendThread(thread) };
    if previous == u32::MAX {
        return None;
    }
    unsafe { ResumeThread(thread) };
    Some(previous)
}

/// Every live thread's suspend count.
#[cfg(test)]
pub(super) fn counts(pid: u32) -> HashMap<u32, u32> {
    counts_in(&Threads::now(), pid)
}

/// Each listed thread's suspend count, read now.
fn counts_in(threads: &Threads, pid: u32) -> HashMap<u32, u32> {
    threads
        .of(pid)
        .iter()
        .filter_map(|&tid| {
            let thread = open_thread(pid, tid)?;
            Some((tid, suspend_count(thread.0)?))
        })
        .collect()
}

#[cfg(test)]
pub fn is_frozen(pid: u32) -> bool {
    is_frozen_in(&Threads::now(), pid)
}

/// Whether every listed thread of the process is suspended: what a pause leaves behind.
pub(super) fn is_frozen_in(threads: &Threads, pid: u32) -> bool {
    let counts = counts_in(threads, pid);
    !counts.is_empty() && counts.values().all(|c| *c > 0)
}

// ---------------------------------------------------------------------------------------------
// Suspend and resume.

/// Whether the handle-bound process state change works here (Windows 11). Probed once, against
/// a throwaway handle to our own process (opening a state change suspends nothing).
pub fn state_change_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        let (Some(create), Some(_)) = (nt().create_state_change, nt().change_state) else {
            return false;
        };
        let Ok(own) = open_process(std::process::id(), PROCESS_SET_INFORMATION | PROCESS_SUSPEND_RESUME) else {
            return false;
        };
        let mut state = HANDLE::default();
        let ok = unsafe { create(&mut state, PROCESS_STATE_ALL_ACCESS, std::ptr::null(), own.0, 0) } >= 0;
        drop(Owned(state));
        ok
    })
}

/// Opt out of the state change mechanism (tests compare both; a support switch).
pub(super) fn prefer_state_change() -> bool {
    std::env::var_os("KIMOCHI_PAUSE_NO_STATE_CHANGE").is_none() && state_change_available()
}

/// Suspend one process. `before` lists the threads as they were just before the step; the caller
/// then catches the threads that escaped ([`catch_escaped`]) with one list taken once every
/// process of the step is suspended.
pub(super) fn freeze_one(
    planned: &Planned,
    use_state_change: bool,
    before: &Threads,
) -> Result<(Frozen, Step), FreezeError> {
    let started = Instant::now();
    let pid = planned.identity.pid;
    let refused = |code: u32| {
        FreezeError::Refused(if code == ERROR_ACCESS_DENIED.0 { Refusal::Denied(code) } else { Refusal::Gone })
    };
    let process = if use_state_change {
        open_process(pid, PROCESS_SUSPEND_RESUME | PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION)
            .or_else(|_| open_process(pid, PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION))
    } else {
        open_process(pid, PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION)
    }
    .map_err(refused)?;
    // The pid must still be the process that was planned.
    if !same(&planned.identity, identity_of(process.0, pid).as_ref()) || !running(process.0) {
        return Err(FreezeError::Refused(Refusal::Gone));
    }
    let baseline = counts_in(before, pid);

    let mut mechanism = Mechanism::SuspendProcess;
    let mut state = None;
    if use_state_change {
        if let Some(create) = nt().create_state_change {
            let mut handle = HANDLE::default();
            if unsafe { create(&mut handle, PROCESS_STATE_ALL_ACCESS, std::ptr::null(), process.0, 0) } >= 0 {
                mechanism = Mechanism::StateChange;
                state = Some(Owned(handle));
            }
        }
    }
    let mut frozen = Frozen { identity: planned.identity.clone(), mechanism, process, state, baseline, suspends: 0 };
    if let Err(status) = suspend_once(&mut frozen) {
        // Nothing to undo: the one suspend failed (a state change object closes on drop).
        return Err(FreezeError::Suspend { pid, status });
    }
    let step = Step {
        pid,
        mechanism: mechanism.name(),
        escaped: 0,
        corrected: 0,
        micros: started.elapsed().as_micros() as u64,
        error: None,
    };
    Ok((frozen, step))
}

/// One process-wide suspend through the frozen process's mechanism.
fn suspend_once(frozen: &mut Frozen) -> Result<(), u32> {
    let status = match (&frozen.state, nt().change_state, nt().suspend) {
        (Some(state), Some(change), _) => unsafe {
            change(state.0, frozen.process.0, STATE_CHANGE_SUSPEND, std::ptr::null_mut(), 0, 0)
        },
        (None, _, Some(suspend)) => unsafe { suspend(frozen.process.0) },
        _ => return Err(0xC000_0002), // STATUS_NOT_IMPLEMENTED
    };
    nt_ok(status)?;
    frozen.suspends += 1;
    Ok(())
}

/// One process-wide resume through the frozen process's mechanism.
fn resume_once(frozen: &mut Frozen) -> Result<(), u32> {
    let status = match (&frozen.state, nt().change_state, nt().resume) {
        (Some(state), Some(change), _) => unsafe {
            change(state.0, frozen.process.0, STATE_CHANGE_RESUME, std::ptr::null_mut(), 0, 0)
        },
        (None, _, Some(resume)) => unsafe { resume(frozen.process.0) },
        _ => return Err(0xC000_0002),
    };
    nt_ok(status)?;
    frozen.suspends -= 1;
    Ok(())
}

/// Threads not above their pre-pause count: created during (or since) the process-wide suspend.
fn escaped_threads(frozen: &Frozen, threads: &Threads) -> usize {
    counts_in(threads, frozen.identity.pid)
        .into_iter()
        .filter(|(tid, count)| *count <= frozen.baseline.get(tid).copied().unwrap_or(0))
        .count()
}

/// The second pass: while some thread escaped the process-wide suspend (it is not above its
/// pre-pause count), suspend the whole process once more, through the same mechanism. The other
/// threads go one deeper, which `thaw` undoes. Bounded. Returns how many threads had escaped.
/// `after` is a thread list taken after the suspend; a pass that caught some lists them again.
pub(super) fn catch_escaped(frozen: &mut Frozen, after: &Threads) -> usize {
    let mut caught = 0;
    let mut escaped = escaped_threads(frozen, after);
    for _ in 0..3 {
        if escaped == 0 || suspend_once(frozen).is_err() {
            break;
        }
        caught += escaped;
        escaped = escaped_threads(frozen, &Threads::now());
    }
    caught
}

/// Close the handles without resuming: what the guard dying does (tests).
#[cfg(test)]
pub(super) fn abandon(frozen: Frozen) {
    let Frozen { process, state, .. } = frozen;
    // Without resuming: as if the holder died. Closing the state change object is what death
    // does to it; a `NtSuspendProcess` freeze stays.
    drop(state);
    drop(process);
}

/// Resume one process and verify no thread is left above its pre-pause suspend count. `threads`
/// is a list taken while the process was still frozen (threads it starts once resumed were never
/// ours), shared by every process the step resumes.
pub(super) fn thaw(frozen: Frozen, threads: &Threads) -> Step {
    let started = Instant::now();
    let pid = frozen.identity.pid;
    let mut frozen = frozen;
    let mut errors = Vec::new();
    while frozen.suspends > 0 {
        if let Err(status) = resume_once(&mut frozen) {
            // A state change object resumes when it closes (just below); settle catches the rest.
            errors.push(format!("{} resume failed ({status:#010x})", frozen.mechanism.name()));
            break;
        }
    }
    let Frozen { process, state, baseline, mechanism, .. } = frozen;
    drop(state);
    let corrected = if running(process.0) { settle(threads, pid, &baseline) } else { 0 };
    let still = if running(process.0) { left_suspended(threads, pid, &baseline) } else { 0 };
    if still > 0 {
        errors.push(format!("{still} thread(s) still suspended"));
    } else if running(process.0) {
        // Whatever went wrong above, every thread is back at its pre-pause count now.
        errors.clear();
    }
    Step {
        pid,
        mechanism: mechanism.name(),
        escaped: 0,
        corrected,
        micros: started.elapsed().as_micros() as u64,
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    }
}

/// Resume threads that sit above their pre-pause count (unknown threads: above 0). Returns how
/// many threads needed it.
fn settle(threads: &Threads, pid: u32, baseline: &HashMap<u32, u32>) -> usize {
    let mut corrected = 0;
    for &tid in threads.of(pid) {
        let Some(thread) = open_thread(pid, tid) else { continue };
        let floor = baseline.get(&tid).copied().unwrap_or(0);
        let mut touched = false;
        // Bounded: a suspend count cannot exceed 127.
        for _ in 0..128 {
            match suspend_count(thread.0) {
                Some(count) if count > floor => {
                    if unsafe { ResumeThread(thread.0) } == u32::MAX {
                        break;
                    }
                    touched = true;
                }
                _ => break,
            }
        }
        corrected += usize::from(touched);
    }
    corrected
}

pub(super) fn left_suspended(threads: &Threads, pid: u32, baseline: &HashMap<u32, u32>) -> usize {
    counts_in(threads, pid).into_iter().filter(|(tid, count)| *count > baseline.get(tid).copied().unwrap_or(0)).count()
}

/// What `recover` did with one process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Recovery {
    /// The process was still frozen and has been resumed.
    Resumed { corrected: usize },
    /// The process is running normally (its holder's handle closed, or another resume ran).
    NotFrozen,
    /// The pid now belongs to another process, or the process is gone: left alone.
    Mismatch,
}

/// Resume an orphan (after Kimochi and its guard died, or a process this guard does not hold).
/// Touches the pid only if its identity still matches and it is still fully frozen, so a game
/// that resumed already does not get its own suspended threads woken. Threads the second pass
/// froze one by one are not known any more; `settle` brings every thread down to 0.
/// `threads` is a list taken before (a frozen process starts no threads).
pub fn recover(identity: &Identity, threads: &Threads) -> Recovery {
    let pid = identity.pid;
    let Ok(process) = open_process(pid, PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION) else {
        return Recovery::Mismatch;
    };
    if !running(process.0) || !same(identity, identity_of(process.0, pid).as_ref()) {
        return Recovery::Mismatch;
    }
    if !is_frozen_in(threads, pid) {
        return Recovery::NotFrozen;
    }
    if let Some(resume) = nt().resume {
        unsafe { resume(process.0) };
    }
    // Anything still above 0 after that was ours: the game's own suspended threads cannot be
    // told apart any more, but a fully frozen game is the worse outcome.
    let corrected = if is_frozen_in(threads, pid) { settle(threads, pid, &HashMap::new()) } else { 0 };
    Recovery::Resumed { corrected }
}
