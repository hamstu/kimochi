//! The Windows backend against real processes: this test binary started again as a throwaway
//! child (`child_process` below, which does nothing unless the environment asks it to). Every
//! test resumes and kills what it started; nothing else is ever suspended.
use super::super::super::backend::{Backend, GameRef, Member, ProcIdentity, RefusalKind, Role};
use super::super::super::guard::{Core, Reply, Request, HEARTBEAT_LOSS};
use super::super::super::journal::Journal;
use super::suspend::{self, ProcEntry};
use super::WindowsBackend;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

const CHILD_TEST: &str = "game_pause::platform::windows::tests::child_process";
const COUNTER: &str = "KIMOCHI_PAUSE_TEST_COUNTER";
const KIDS: &str = "KIMOCHI_PAUSE_TEST_KIDS";
const GUI: &str = "KIMOCHI_PAUSE_TEST_GUI";

// ---------------------------------------------------------------------------------------------
// The child.

/// A throwaway "game": bumps a counter in a file every few ms (so the test can see whether it
/// runs), starts `KIDS` children of the same program that do the same, optionally shows a
/// window, and exits by itself after a minute in case a test dies before killing it.
#[test]
fn child_process() {
    let Some(counter) = std::env::var_os(COUNTER) else { return };
    let counter = PathBuf::from(counter);
    let kids: usize = std::env::var(KIDS).ok().and_then(|k| k.parse().ok()).unwrap_or(0);
    let mut children = Vec::new();
    for i in 0..kids {
        let mut path = counter.clone().into_os_string();
        path.push(format!(".kid{i}"));
        children.push(spawn_child(Path::new(&path), 0, false));
    }
    if std::env::var_os(GUI).is_some() {
        let cloak = gui::cloak_flag(&counter);
        std::thread::spawn(move || gui::run(&cloak));
    }
    let started = Instant::now();
    let mut n = 0u64;
    while started.elapsed() < Duration::from_secs(60) {
        n += 1;
        let _ = std::fs::write(&counter, n.to_string());
        std::thread::sleep(Duration::from_millis(5));
    }
    for mut child in children {
        let _ = child.kill();
    }
}

fn spawn_child(counter: &Path, kids: usize, gui: bool) -> Child {
    let _ = std::fs::remove_file(counter);
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", CHILD_TEST, "--nocapture", "--test-threads=1"])
        .env(COUNTER, counter)
        .env(KIDS, kids.to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if gui {
        command.env(GUI, "1");
    } else {
        command.env_remove(GUI);
    }
    command.spawn().expect("spawn the test child")
}

fn read_counter(path: &Path) -> Option<u64> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// Whether the counter moves within `within`.
fn advances(path: &Path, within: Duration) -> bool {
    let start = read_counter(path);
    let started = Instant::now();
    while started.elapsed() < within {
        std::thread::sleep(Duration::from_millis(20));
        let now = read_counter(path);
        if now.is_some() && now != start {
            return true;
        }
    }
    false
}

/// A started child tree, killed (by pid) on drop.
struct Tree {
    root: Child,
    counters: Vec<PathBuf>,
    _dir: TempDir,
}

impl Tree {
    fn start(name: &str, kids: usize, gui: bool) -> Tree {
        let dir = TempDir::new(name);
        let main = dir.0.join("main");
        let root = spawn_child(&main, kids, gui);
        let mut counters = vec![main.clone()];
        for i in 0..kids {
            let mut path = main.clone().into_os_string();
            path.push(format!(".kid{i}"));
            counters.push(PathBuf::from(path));
        }
        let started = Instant::now();
        while counters.iter().any(|c| read_counter(c).is_none()) {
            assert!(started.elapsed() < Duration::from_secs(20), "children did not start");
            std::thread::sleep(Duration::from_millis(20));
        }
        Tree { root, counters, _dir: dir }
    }
    fn pid(&self) -> u32 {
        self.root.id()
    }
    fn game(&self) -> GameRef {
        GameRef { pid: Some(self.pid()), ..Default::default() }
    }
    fn all_run(&self) -> bool {
        self.counters.iter().all(|c| advances(c, Duration::from_secs(2)))
    }
    fn none_run(&self) -> bool {
        // Long enough for several 5 ms ticks.
        self.counters.iter().all(|c| !advances(c, Duration::from_millis(300)))
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        // Kids first, by the pids the tree has now; then the root.
        let all = snapshot();
        let mut pids = vec![self.root.id()];
        let mut i = 0;
        while i < pids.len() {
            let parent = pids[i];
            pids.extend(all.iter().filter(|p| p.parent == parent).map(|p| p.pid));
            i += 1;
        }
        for pid in pids.into_iter().skip(1) {
            kill(pid);
        }
        let _ = self.root.kill();
        let _ = self.root.wait();
    }
}

struct TempDir(PathBuf);
impl TempDir {
    fn new(name: &str) -> TempDir {
        let dir = std::env::temp_dir().join(format!("kimochi-pause-{}-{name}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        TempDir(dir)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        // Only the folder this test made.
        if self.0.file_name().is_some_and(|n| n.to_string_lossy().starts_with("kimochi-pause-")) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn kill(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        if let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, pid) {
            let _ = TerminateProcess(h, 1);
            let _ = CloseHandle(h);
        }
    }
}

fn snapshot() -> Vec<ProcEntry> {
    processes().into_iter().map(|(pid, parent, name)| ProcEntry { pid, parent, name }).collect()
}

fn processes() -> Vec<(u32, u32, String)> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut e).is_ok();
        while ok {
            let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
            out.push((e.th32ProcessID, e.th32ParentProcessID, String::from_utf16_lossy(&e.szExeFile[..len])));
            ok = Process32NextW(snap, &mut e).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    out
}

fn backend(state_change: bool) -> WindowsBackend {
    WindowsBackend { state_change: Some(state_change), held: Default::default() }
}

/// No thread of `pid` is suspended (the children never suspend their own threads).
fn all_threads_running(pid: u32) -> bool {
    let counts = suspend::counts(pid);
    !counts.is_empty() && counts.values().all(|c| *c == 0)
}

fn mechanisms() -> Vec<bool> {
    if suspend::state_change_available() {
        vec![true, false]
    } else {
        eprintln!("process state change unavailable here; testing NtSuspendProcess only");
        vec![false]
    }
}

// ---------------------------------------------------------------------------------------------
// Pure rules.

fn entry(pid: u32, parent: u32, name: &str) -> ProcEntry {
    ProcEntry { pid, parent, name: name.into() }
}

#[test]
fn the_native_thread_list_matches_tool_help() {
    use windows::Win32::System::Threading::GetCurrentThreadId;
    let own = std::process::id();
    // This thread and four parked ones stay alive while both lists are taken (other tests may
    // start or end threads in between, so only these are compared).
    let (tx, rx) = std::sync::mpsc::channel();
    let parked: Vec<_> = (0..4)
        .map(|_| {
            let tx = tx.clone();
            std::thread::spawn(move || {
                tx.send(unsafe { GetCurrentThreadId() }).unwrap();
                std::thread::park_timeout(Duration::from_secs(10));
            })
        })
        .collect();
    let mut ours: Vec<u32> = (0..4).map(|_| rx.recv().unwrap()).collect();
    ours.push(unsafe { GetCurrentThreadId() });
    let native = suspend::Threads::now().of(own).to_vec();
    let toolhelp = suspend::toolhelp_threads_of(own);
    for tid in &ours {
        assert!(native.contains(tid), "{tid} missing from {native:?}");
        assert!(toolhelp.contains(tid), "{tid} missing from {toolhelp:?}");
    }
    assert!(suspend::Threads::now().of(u32::MAX).is_empty());
    for t in parked {
        t.thread().unpark();
        let _ = t.join();
    }
}

#[test]
fn the_tree_is_the_window_process_its_engine_and_same_program_children() {
    let all = vec![
        entry(10, 1, "Launcher.exe"),
        entry(11, 10, "Launcher.bin"), // engine child
        entry(12, 10, "crashpad.exe"), // unrelated helper
        entry(13, 11, "Launcher.bin"), // same program under the engine
        entry(14, 99, "Launcher.bin"), // not a descendant
        entry(15, 10, "launcher.exe"), // same program (case-insensitive)
        entry(16, 15, "launcher.exe"), // grand-child, same program
    ];
    let (included, excluded) = suspend::select_tree(10, &all, &|_| None);
    let pids: Vec<u32> = included.iter().map(|(p, _)| *p).collect();
    assert_eq!(pids, vec![10, 11, 15, 13, 16]);
    assert_eq!(included[0].1, suspend::Role::Window);
    assert_eq!(included[1].1, suspend::Role::EngineChild);
    assert_eq!(included[2].1, suspend::Role::SameProgram);
    assert_eq!(excluded.iter().map(|e| e.pid).collect::<Vec<_>>(), vec![12]);
}

#[test]
fn a_child_older_than_its_parent_belongs_to_a_reused_pid() {
    let all = vec![entry(10, 1, "game.exe"), entry(11, 10, "game.exe")];
    // 11 was created before 10: its parent was an earlier process that had pid 10.
    let created = |pid: u32| Some(if pid == 10 { 200 } else { 100 });
    let (included, excluded) = suspend::select_tree(10, &all, &created);
    assert_eq!(included.len(), 1);
    assert_eq!(excluded[0].why, "parent pid was reused");
}

#[test]
fn refusals_name_a_reason() {
    let b = WindowsBackend::default();
    let refuse = |pid: Option<u32>| b.plan(&GameRef { pid, ..Default::default() }).unwrap_err().kind;
    assert_eq!(refuse(None), RefusalKind::NoPid);
    assert_eq!(refuse(Some(0)), RefusalKind::NoPid);
    assert_eq!(refuse(Some(4)), RefusalKind::NoPid);
    assert_eq!(refuse(Some(std::process::id())), RefusalKind::Denylisted);
    // A process that is gone (pids are multiples of 4; this one is never handed out).
    assert_eq!(refuse(Some(0xFFFF_FFF1)), RefusalKind::NotFound);
}

#[test]
fn windows_own_processes_are_refused() {
    // The session's Windows shell or any process from the Windows directory we can find.
    let system = processes()
        .into_iter()
        .find(|(_, _, name)| name.eq_ignore_ascii_case("explorer.exe") || name.eq_ignore_ascii_case("sihost.exe"));
    let Some((pid, _, _)) = system else { return };
    let refusal = WindowsBackend::default().plan(&GameRef { pid: Some(pid), ..Default::default() }).unwrap_err();
    assert_eq!(refusal.kind, RefusalKind::Protected, "{refusal:?}");
}

#[test]
fn protected_processes_are_refused() {
    // csrss / services run protected (and as SYSTEM): never pausable.
    for (pid, _, name) in processes() {
        if name.eq_ignore_ascii_case("csrss.exe") || name.eq_ignore_ascii_case("services.exe") {
            let kind =
                WindowsBackend::default().plan(&GameRef { pid: Some(pid), ..Default::default() }).unwrap_err().kind;
            assert!(
                matches!(kind, RefusalKind::Protected | RefusalKind::PermissionDenied | RefusalKind::Elevated),
                "{name}: {kind:?}"
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Real processes.

#[test]
fn suspends_and_resumes_a_process_tree_with_each_mechanism() {
    for state_change in mechanisms() {
        let tree = Tree::start(&format!("tree-{state_change}"), 2, false);
        let b = backend(state_change);
        let plan = b.plan(&tree.game()).unwrap();
        assert_eq!(plan.members.len(), 3, "{plan:#?}");
        assert_eq!(plan.members[0].role, Role::Main);
        assert!(tree.all_run());

        let suspended = b.suspend(&plan).unwrap();
        assert_eq!(suspended.members.len(), 3);
        assert_eq!(suspended.mechanism, if state_change { "process state change" } else { "NtSuspendProcess" });
        assert!(tree.none_run(), "the game still runs while paused ({state_change})");
        for m in &suspended.members {
            assert!(suspend::is_frozen(m.pid), "pid {} not frozen", m.pid);
        }
        // refresh while paused changes nothing and keeps it frozen.
        let mut s2 = suspended.clone();
        b.refresh(&mut s2).unwrap();
        assert_eq!(s2.members.len(), 3);
        assert!(tree.none_run());

        b.resume(&suspended).unwrap();
        for m in &suspended.members {
            assert!(all_threads_running(m.pid), "pid {} left a thread suspended", m.pid);
        }
        assert!(tree.all_run(), "the game did not run again ({state_change})");
        // Idempotent: a second resume touches nothing.
        b.resume(&suspended).unwrap();
        for m in &suspended.members {
            assert!(all_threads_running(m.pid));
        }
    }
}

#[test]
fn a_failure_part_way_rolls_back_everything() {
    let tree = Tree::start("rollback", 1, false);
    let b = WindowsBackend::default();
    let mut plan = b.plan(&tree.game()).unwrap();
    // A last member whose identity no longer matches (its creation time is wrong) and is the
    // window process: suspend must refuse it and resume the two before it.
    let mut stale = plan.members[0].clone();
    stale.id.start += 1;
    plan.members.push(Member { role: Role::Main, ..stale });
    let error = b.suspend(&plan).unwrap_err();
    assert_eq!(error.refusal, Some(RefusalKind::NotFound), "{error:?}");
    assert!(tree.all_run(), "rolled-back processes must run");
    for m in &plan.members {
        assert!(all_threads_running(m.id.pid));
    }
    assert!(b.held.lock().unwrap().is_empty());
}

#[test]
fn a_reused_pid_is_never_suspended_or_resumed() {
    let tree = Tree::start("reuse", 0, false);
    let b = WindowsBackend::default();
    let real = b.identity(tree.pid()).unwrap();
    let imposter = ProcIdentity { start: real.start - 1, ..real.clone() };
    let plan = super::super::super::backend::Plan {
        game: tree.game(),
        members: vec![Member { id: imposter.clone(), role: Role::Main, why: "test".into() }],
        excluded: Vec::new(),
        mechanism: "test".into(),
    };
    assert!(b.suspend(&plan).is_err());
    assert!(tree.all_run());

    // Frozen for real, then a resume naming the wrong identity must leave it alone.
    let real_plan = b.plan(&tree.game()).unwrap();
    let suspended = b.suspend(&real_plan).unwrap();
    let other = WindowsBackend::default();
    let wrong = super::super::super::backend::Suspended { members: vec![imposter], ..suspended.clone() };
    other.resume(&wrong).unwrap();
    assert!(tree.none_run(), "a resume for another identity touched the game");
    b.resume(&suspended).unwrap();
    assert!(tree.all_run());
}

#[test]
fn an_escaped_thread_is_caught_by_refresh() {
    let tree = Tree::start("escape", 0, false);
    let b = backend(false);
    let plan = b.plan(&tree.game()).unwrap();
    let mut suspended = b.suspend(&plan).unwrap();
    // Let one thread out, as a thread created during the suspend would be.
    let tid = *suspend::counts(tree.pid()).keys().next().unwrap();
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
        unsafe {
            let t = OpenThread(THREAD_SUSPEND_RESUME, false, tid).unwrap();
            ResumeThread(t);
            let _ = CloseHandle(t);
        }
    }
    assert!(!suspend::is_frozen(tree.pid()));
    b.refresh(&mut suspended).unwrap();
    assert!(suspend::is_frozen(tree.pid()), "refresh did not catch the escaped thread");
    b.resume(&suspended).unwrap();
    assert!(all_threads_running(tree.pid()), "{:?}", suspend::counts(tree.pid()));
    assert!(tree.all_run());
}

#[test]
fn state_change_freeze_undoes_itself_when_its_holder_lets_go() {
    if !suspend::state_change_available() {
        eprintln!("skipped: process state change unavailable");
        return;
    }
    let tree = Tree::start("holder", 1, false);
    let b = backend(true);
    let plan = b.plan(&tree.game()).unwrap();
    let suspended = b.suspend(&plan).unwrap();
    assert!(tree.none_run());
    // The guard dies: its handles close, nothing resumes explicitly.
    for frozen in std::mem::take(&mut *b.held.lock().unwrap()) {
        suspend::abandon(frozen);
    }
    assert!(tree.all_run(), "closing the state change handles did not resume the game");
    for m in &suspended.members {
        assert!(all_threads_running(m.pid));
    }
}

#[test]
fn journal_recovery_resumes_an_orphaned_nt_suspend() {
    let tree = Tree::start("orphan", 1, false);
    let dir = TempDir::new("orphan-journal");
    let journal = Journal::in_dir(&dir.0);
    let b = backend(false);
    let plan = b.plan(&tree.game()).unwrap();
    let suspended = b.suspend(&plan).unwrap();
    journal
        .write(&super::super::super::journal::Entry {
            game: suspended.game.clone(),
            members: suspended.members.clone(),
            mechanism: suspended.mechanism.clone(),
            at: 1,
            guard: 1,
            boot: super::super::super::journal::boot_id(),
        })
        .unwrap();
    // The guard dies without resuming: NtSuspendProcess freezes stay.
    for frozen in std::mem::take(&mut *b.held.lock().unwrap()) {
        suspend::abandon(frozen);
    }
    assert!(tree.none_run(), "an NtSuspendProcess freeze should outlive its holder");
    // The next guard's start.
    let next = WindowsBackend::default();
    let recovered = journal.recover(&next, None);
    assert_eq!(recovered.len(), 2, "{recovered:?}");
    assert!(recovered.iter().all(|r| r.outcome == "resumed"), "{recovered:?}");
    assert!(tree.all_run());
    for m in &suspended.members {
        assert!(all_threads_running(m.pid));
    }
}

#[test]
fn the_guard_resumes_on_heartbeat_loss() {
    let tree = Tree::start("guard", 1, false);
    let dir = TempDir::new("guard-journal");
    let b = WindowsBackend::default();
    let plan = b.plan(&tree.game()).unwrap();
    let t0 = Instant::now();
    let mut core = Core::new(&b, Journal::in_dir(&dir.0), t0);
    let replies = core.handle(Request::Suspend { id: 1, plan }, t0);
    assert!(matches!(replies.last(), Some(Reply::Suspended { .. })), "{replies:?}");
    assert!(tree.none_run());
    // Beats keep it; then they stop.
    assert!(core.tick(t0 + HEARTBEAT_LOSS / 2).is_empty());
    let replies = core.tick(t0 + HEARTBEAT_LOSS + Duration::from_millis(100));
    assert!(matches!(replies.as_slice(), [Reply::Resumed { reason, .. }] if reason == "heartbeat"), "{replies:?}");
    assert!(tree.all_run());
    assert!(Journal::in_dir(&dir.0).read().is_none());
}

#[test]
fn a_process_stopped_by_someone_else_is_left_alone() {
    let tree = Tree::start("foreign", 1, false);
    let b = backend(false);
    let plan = b.plan(&tree.game()).unwrap();
    let kid = plan.members[1].id.clone();
    // Someone else stops the child first.
    let other = backend(false);
    let foreign = other
        .suspend(&super::super::super::backend::Plan { members: vec![plan.members[1].clone()], ..plan.clone() })
        .unwrap();
    assert_eq!(b.stopped(&kid), Some(true));
    assert_eq!(b.stopped(&plan.members[0].id), Some(false));
    let ours = b.suspend(&plan).unwrap();
    assert_eq!(ours.members, vec![plan.members[0].id.clone()], "a foreign-stopped member is not ours");
    b.resume(&ours).unwrap();
    assert!(suspend::is_frozen(kid.pid), "our resume continued a process someone else stopped");
    other.resume(&foreign).unwrap();
    assert!(tree.all_run());
    // A wrong identity is unknown, not "running".
    assert_eq!(b.stopped(&ProcIdentity { start: kid.start + 1, ..kid }), None);
}

#[test]
fn dropping_the_backend_resumes_what_it_holds() {
    let tree = Tree::start("drop", 0, false);
    {
        let b = backend(false);
        let plan = b.plan(&tree.game()).unwrap();
        b.suspend(&plan).unwrap();
        assert!(tree.none_run());
    }
    assert!(tree.all_run());
    assert!(all_threads_running(tree.pid()));
}

#[test]
fn rapid_pause_and_resume_never_leaves_the_game_paused() {
    let tree = Tree::start("rapid", 1, false);
    let b = WindowsBackend::default();
    for _ in 0..50 {
        let plan = b.plan(&tree.game()).unwrap();
        let s = b.suspend(&plan).unwrap();
        b.resume(&s).unwrap();
    }
    let plan = b.plan(&tree.game()).unwrap();
    for m in &plan.members {
        assert!(all_threads_running(m.id.pid), "pid {}: {:?}", m.id.pid, suspend::counts(m.id.pid));
    }
    assert!(tree.all_run());
}

/// A window source names its pid only while that window is still open as that process
/// (`AppCx::game` asks `window_bounds`): in every state a game's window can be in, and never once
/// the window is destroyed or the handle belongs to another process.
#[test]
fn a_selected_window_names_its_pid_only_while_it_is_open() {
    use crate::platform::{picker_sources, window_bounds, window_fullscreen};
    use kimochi_capture::SourceId;
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::UI::WindowsAndMessaging::{
        IsIconic, IsWindow, IsWindowVisible, IsZoomed, SetWindowLongW, SetWindowPos, ShowWindowAsync, GWL_STYLE,
        HWND_BOTTOM, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_MAXIMIZE,
        SW_MINIMIZE, SW_SHOWNOACTIVATE, WS_POPUP, WS_VISIBLE,
    };

    let tree = Tree::start("window", 0, true);
    let pid = tree.pid();
    // The id exactly as the picker lists it.
    let started = Instant::now();
    let selection = loop {
        let listed = picker_sources()
            .unwrap()
            .into_iter()
            .find(|source| source.kind == "window" && SourceId::parse(&source.id).and_then(|id| id.pid()) == Some(pid));
        if let Some(source) = listed {
            break source.id;
        }
        assert!(started.elapsed() < Duration::from_secs(10), "the child's window was never listed");
        std::thread::sleep(Duration::from_millis(50));
    };
    let id = SourceId::parse(&selection).unwrap();
    let hwnd = gui::find_window(pid).unwrap();
    // What `AppCx::game` does on Windows.
    let named = |selection: &str| {
        super::super::super::target::game_ref(Some(selection), None, &|_| None, &|id| window_bounds(id).is_some()).pid
    };
    let settle = |state: &str, settled: &dyn Fn() -> bool| {
        let started = Instant::now();
        while !settled() {
            assert!(started.elapsed() < Duration::from_secs(5), "{state}: the window never got there");
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    let expect = |state: &str, want: Option<u32>| assert_eq!(named(&selection), want, "{state}");

    settle("normal", &|| unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() });
    expect("normal", Some(pid));

    unsafe { ShowWindowAsync(hwnd, SW_MINIMIZE) }.ok().unwrap();
    settle("minimised", &|| unsafe { IsIconic(hwnd) }.as_bool());
    expect("minimised", Some(pid));

    unsafe { ShowWindowAsync(hwnd, SW_MAXIMIZE) }.ok().unwrap();
    settle("maximised", &|| unsafe { IsZoomed(hwnd) }.as_bool());
    expect("maximised", Some(pid));

    // Borderless full screen: no caption, the monitor's size.
    let mut monitor = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe {
        assert!(GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut monitor).as_bool());
        SetWindowLongW(hwnd, GWL_STYLE, (WS_POPUP | WS_VISIBLE).0 as i32);
        let r = monitor.rcMonitor;
        SetWindowPos(
            hwnd,
            None,
            r.left,
            r.top,
            r.right - r.left,
            r.bottom - r.top,
            SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED,
        )
        .unwrap();
    }
    settle("borderless full screen", &|| window_fullscreen(&id) == Some(true));
    expect("borderless full screen", Some(pid));

    unsafe { SetWindowPos(hwnd, Some(HWND_BOTTOM), 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE) }.unwrap();
    expect("behind every other window", Some(pid));

    unsafe { ShowWindowAsync(hwnd, SW_HIDE) }.ok().unwrap();
    settle("hidden", &|| !unsafe { IsWindowVisible(hwnd) }.as_bool());
    expect("hidden", Some(pid));

    // Cloaked by DWM, as a window on another virtual desktop is.
    unsafe { ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE) }.ok().unwrap();
    std::fs::write(gui::cloak_flag(&tree.counters[0]), b"").unwrap();
    settle("cloaked", &|| {
        let mut cloaked = 0u32;
        let read = unsafe {
            DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut core::ffi::c_void, 4)
        };
        read.is_ok() && cloaked != 0
    });
    expect("cloaked", Some(pid));

    // The handle with someone else's pid: refused.
    let (handle, _) = selection.rsplit_once(':').unwrap();
    let foreign = format!("{handle}:{}", std::process::id());
    assert_eq!(named(&foreign), None, "a handle another process owns");

    // The game closed: refused, even though its pid is in the id.
    drop(tree);
    settle("destroyed", &|| !unsafe { IsWindow(Some(hwnd)) }.as_bool());
    expect("destroyed", None);
}

/// Measured, not asserted: what a frozen window does (ghosting, message timeouts). Run with
/// `cargo test ... ghost -- --ignored --nocapture`; findings go to docs/game-pause/windows-notes.md.
#[test]
#[ignore]
fn observe_a_frozen_window() {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{IsHungAppWindow, SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_NULL};
    let tree = Tree::start("ghost", 0, true);
    let hwnd = {
        let started = Instant::now();
        loop {
            if let Some(h) = gui::find_window(tree.pid()) {
                break h;
            }
            assert!(started.elapsed() < Duration::from_secs(10), "no window");
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    let ping = || {
        let t = Instant::now();
        let r = unsafe { SendMessageTimeoutW(hwnd, WM_NULL, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 1000, None) };
        (r.0 != 0, t.elapsed())
    };
    eprintln!("running: ping {:?}, hung {}", ping(), unsafe { IsHungAppWindow(hwnd) }.as_bool());
    for state_change in mechanisms() {
        let b = backend(state_change);
        let s = b.suspend(&b.plan(&tree.game()).unwrap()).unwrap();
        eprintln!("mechanism {}", s.mechanism);
        for secs in [0u64, 3, 6, 9] {
            if secs > 0 {
                // Queue input to the window itself (nothing system-wide), as a reader's mouse
                // moving over it would.
                for _ in 0..30 {
                    unsafe {
                        let _ = windows::Win32::UI::WindowsAndMessaging::PostMessageW(
                            Some(hwnd),
                            windows::Win32::UI::WindowsAndMessaging::WM_MOUSEMOVE,
                            WPARAM(0),
                            LPARAM(0x0010_0010),
                        );
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
            eprintln!("frozen {secs}s: ping {:?}, hung {}", ping(), unsafe { IsHungAppWindow(hwnd) }.as_bool());
        }
        let t = Instant::now();
        b.resume(&s).unwrap();
        eprintln!("resume took {:?}", t.elapsed());
        std::thread::sleep(Duration::from_millis(200));
        eprintln!("resumed: ping {:?}, hung {}", ping(), unsafe { IsHungAppWindow(hwnd) }.as_bool());
    }
}

/// Measured, not asserted: the steps of `force_foreground` against a frozen game's thread, as
/// when the reader opens the controller menu while a lookup pause holds the game. Brings this
/// test's own window to the front for a moment. Run with `-- --ignored --nocapture`.
#[test]
#[ignore]
fn foreground_steps_against_a_frozen_thread() {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, PeekMessageW,
        SendMessageTimeoutW, SetForegroundWindow, ASFW_ANY, MSG, PM_NOREMOVE, SMTO_ABORTIFHUNG, SMTO_ERRORONEXIT,
        WM_NULL,
    };
    let tree = Tree::start("attach", 0, true);
    let game = {
        let started = Instant::now();
        loop {
            if let Some(h) = gui::find_window(tree.pid()) {
                break h;
            }
            assert!(started.elapsed() < Duration::from_secs(10), "no window");
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    let game_thread = unsafe { GetWindowThreadProcessId(game, None) };
    // Make the game the foreground window, as it is while the reader plays.
    unsafe {
        let _ = AllowSetForegroundWindow(ASFW_ANY);
        let _ = SetForegroundWindow(game);
    }
    std::thread::sleep(Duration::from_millis(300));
    eprintln!("game is foreground: {}", unsafe { GetForegroundWindow() } == game);
    let b = WindowsBackend::default();
    let s = b.suspend(&b.plan(&tree.game()).unwrap()).unwrap();
    eprintln!("frozen ({})", s.mechanism);
    // Our "Kimochi window", on a thread with its own queue.
    let (tx, rx) = std::sync::mpsc::channel();
    let game_raw = game.0 as usize;
    std::thread::spawn(move || {
        let game = windows::Win32::Foundation::HWND(game_raw as *mut _);
        let ours_window = gui::create("kimochi pause test (ours)");
        let mut msg = MSG::default();
        unsafe {
            let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        }
        let ours = unsafe { GetCurrentThreadId() };
        let step = |name: &str, f: &dyn Fn() -> String| {
            let t = Instant::now();
            let r = f();
            eprintln!("  {name}: {r} in {:?}", t.elapsed());
        };
        step("SetForegroundWindow(ours)", &|| format!("{:?}", unsafe { SetForegroundWindow(ours_window) }.as_bool()));
        step("AttachThreadInput(ours, game, true)", &|| {
            format!("{}", unsafe { AttachThreadInput(ours, game_thread, true) }.as_bool())
        });
        step("BringWindowToTop(ours)", &|| format!("{:?}", unsafe { BringWindowToTop(ours_window) }.is_ok()));
        step("SetForegroundWindow(ours) attached", &|| {
            format!("{:?}", unsafe { SetForegroundWindow(ours_window) }.as_bool())
        });
        step("AttachThreadInput(ours, game, false)", &|| {
            format!("{}", unsafe { AttachThreadInput(ours, game_thread, false) }.as_bool())
        });
        step("SendMessageTimeout(ours, WM_NULL, 500)", &|| {
            let r = unsafe {
                SendMessageTimeoutW(
                    ours_window,
                    WM_NULL,
                    WPARAM(0),
                    LPARAM(0),
                    SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT,
                    500,
                    None,
                )
            };
            format!("{}", r.0 != 0)
        });
        step("SendMessageTimeout(game, WM_NULL, 500)", &|| {
            let r = unsafe {
                SendMessageTimeoutW(game, WM_NULL, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT, 500, None)
            };
            format!("{}", r.0 != 0)
        });
        eprintln!("  ours is foreground: {}", unsafe { GetForegroundWindow() } == ours_window);
        let _ = tx.send(());
    });
    let finished = rx.recv_timeout(Duration::from_secs(20)).is_ok();
    eprintln!("sequence finished: {finished}");
    b.resume(&s).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(finished, "a step blocked on the frozen thread");
}

mod gui {
    //! A plain window with a message loop, for `observe_a_frozen_window` and the window checks.
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CLOAK};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, EnumWindows, GetMessageW, GetWindowThreadProcessId, ShowWindow,
        TranslateMessage, MSG, SW_SHOWNOACTIVATE, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    pub fn run(cloak: &std::path::Path) {
        let hwnd = create("kimochi pause test");
        // Cloaks the window (as Windows does to one on another virtual desktop) once the test asks,
        // by creating `cloak`: only the window's own process may cloak it.
        let (cloak, handle) = (cloak.to_owned(), hwnd.0 as usize);
        std::thread::spawn(move || {
            while !cloak.exists() {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            let on = windows::core::BOOL::from(true);
            unsafe {
                let _ = DwmSetWindowAttribute(
                    HWND(handle as *mut _),
                    DWMWA_CLOAK,
                    &on as *const _ as *const core::ffi::c_void,
                    std::mem::size_of_val(&on) as u32,
                );
            }
        });
        pump();
    }

    /// The file whose existence makes the child cloak its window.
    pub fn cloak_flag(counter: &std::path::Path) -> std::path::PathBuf {
        let mut path = counter.to_owned().into_os_string();
        path.push(".cloak");
        path.into()
    }

    pub fn create(title: &str) -> HWND {
        let title = windows::core::HSTRING::from(title);
        unsafe {
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                &title,
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                100,
                100,
                320,
                200,
                None,
                None,
                None,
                None,
            )
            .expect("CreateWindowExW");
            // The first ShowWindow takes the launcher's show state (minimised, hidden); the
            // second shows it for real, without taking the foreground.
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            hwnd
        }
    }

    fn pump() {
        unsafe {
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    pub fn find_window(pid: u32) -> Option<HWND> {
        struct Search {
            pid: u32,
            found: Option<HWND>,
        }
        unsafe extern "system" fn each(h: HWND, data: LPARAM) -> windows::core::BOOL {
            let search = &mut *(data.0 as *mut Search);
            let mut owner = 0u32;
            GetWindowThreadProcessId(h, Some(&mut owner));
            if owner == search.pid {
                search.found = Some(h);
                return false.into();
            }
            true.into()
        }
        let mut search = Search { pid, found: None };
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut search as *mut Search as isize));
        }
        search.found
    }
}

/// Prints the real plan (or refusal) for `KIMOCHI_PAUSE_PLAN_PID` as JSON, for driving the guard
/// by hand on a real game (`docs/game-pause` scripts). Read-only.
#[test]
#[ignore]
fn print_plan() {
    let Some(pid) = std::env::var("KIMOCHI_PAUSE_PLAN_PID").ok().and_then(|p| p.parse().ok()) else { return };
    match WindowsBackend::default().plan(&GameRef { pid: Some(pid), ..Default::default() }) {
        Ok(plan) => println!("PLAN {}", serde_json::to_string(&plan).unwrap()),
        Err(refusal) => println!("REFUSAL {}", serde_json::to_string(&refusal).unwrap()),
    }
}
