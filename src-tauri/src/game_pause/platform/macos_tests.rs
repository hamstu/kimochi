//! Planning is tested on synthetic snapshots; signalling on throwaway process trees these
//! tests start themselves (copies of the test binary, re-run in a sleeper mode), which are
//! always continued and killed by pid when a test ends, pass or fail.

use super::*;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

const ME: u32 = 501;
const KIMOCHI: u32 = 9000;

fn ctx() -> Context {
    Context { self_pid: KIMOCHI, uid: ME }
}

fn rec(pid: u32, ppid: u32, exe: &str) -> ProcRecord {
    ProcRecord { pid, ppid, uid: ME, start_us: 1_000 + pid as u64, exe: exe.into(), stopped: false, responsible: None }
}

fn no_prefix(_: u32) -> Option<Option<String>> {
    None
}

/// One line per process for the verbose log: pid, role, why, executable; then the exclusions.
fn describe(plan: &Plan) -> Vec<String> {
    let mut lines: Vec<String> = plan
        .members
        .iter()
        .map(|m| format!("stop pid={} role={:?} why={} exe={}", m.id.pid, m.role, m.why, m.id.exe))
        .collect();
    lines.extend(plan.excluded.iter().map(|e| format!("skip pid={} why={} exe={}", e.pid, e.why, e.exe)));
    lines
}

fn game(pid: u32) -> GameRef {
    GameRef { pid: Some(pid), ..GameRef::default() }
}

fn pids(plan: &Plan) -> Vec<u32> {
    plan.members.iter().map(|m| m.id.pid).collect()
}

/// Why `pid` is in the plan, as the planner's finer reason.
fn role(plan: &Plan, pid: u32) -> Option<Why> {
    let m = plan.members.iter().find(|m| m.id.pid == pid)?;
    [Why::Owner, Why::Descendant, Why::Responsible, Why::SameBundle, Why::WinePrefix]
        .into_iter()
        .find(|w| w.text() == m.why && w.role() == m.role)
}

fn kind(r: Result<Plan, Refusal>) -> RefusalKind {
    r.unwrap_err().kind
}

fn session() -> Vec<ProcRecord> {
    vec![
        rec(1, 0, "/sbin/launchd"),
        rec(300, 1, "/System/Library/CoreServices/WindowServer"),
        rec(KIMOCHI, 1, "/Applications/Kimochi.app/Contents/MacOS/kimochi"),
        rec(9001, KIMOCHI, "/Applications/Kimochi.app/Contents/MacOS/kimochi"),
    ]
}

#[test]
fn the_owner_and_its_descendants_stop_parent_first() {
    let mut r = session();
    r.push(rec(100, 1, "/Games/Game.app/Contents/MacOS/Game"));
    r.push(rec(101, 100, "/Games/Game.app/Contents/MacOS/Audio"));
    r.push(rec(102, 101, "/Users/me/Library/Game/worker"));
    r.push(rec(50, 100, "/Users/me/Library/Game/early"));
    r.push(rec(200, 1, "/Applications/Other.app/Contents/MacOS/Other"));
    let plan = plan_from(&r, &game(100), ctx(), &no_prefix).unwrap();
    assert_eq!(pids(&plan), vec![100, 50, 101, 102]);
    assert_eq!(role(&plan, 100), Some(Why::Owner));
    assert_eq!(role(&plan, 102), Some(Why::Descendant));
    assert_eq!(role(&plan, 200), None);
}

#[test]
fn descendants_past_the_depth_cap_are_not_followed() {
    let mut r = session();
    r.push(rec(100, 1, "/g/Game"));
    for i in 0..12u32 {
        r.push(rec(101 + i, 100 + i, "/g/child"));
    }
    let plan = plan_from(&r, &game(100), ctx(), &no_prefix).unwrap();
    assert_eq!(plan.members.len(), 1 + MAX_DEPTH);
}

#[test]
fn processes_the_owner_is_responsible_for_come_along() {
    let mut r = session();
    r.push(rec(100, 1, "/g/Game"));
    let mut xpc = rec(400, 1, "/Users/me/Library/Helpers/Renderer");
    xpc.responsible = Some(100);
    r.push(xpc);
    let mut system_xpc = rec(401, 1, "/System/Library/Frameworks/VideoToolbox.framework/XPCServices/Decoder");
    system_xpc.responsible = Some(100);
    r.push(system_xpc);
    let plan = plan_from(&r, &game(100), ctx(), &no_prefix).unwrap();
    assert_eq!(role(&plan, 400), Some(Why::Responsible));
    assert_eq!(role(&plan, 401), None);
    assert!(plan.excluded.iter().any(|e| e.pid == 401 && e.why == "system executable"));
}

#[test]
fn executables_from_the_same_outer_bundle_come_along() {
    let mut r = session();
    r.push(rec(100, 1, "/Games/Game.app/Contents/MacOS/Game"));
    r.push(rec(110, 1, "/Games/Game.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper"));
    r.push(rec(111, 110, "/tmp/helper-child"));
    r.push(rec(120, 1, "/Games/GameTwo.app/Contents/MacOS/GameTwo"));
    let plan = plan_from(&r, &game(100), ctx(), &no_prefix).unwrap();
    assert_eq!(role(&plan, 110), Some(Why::SameBundle));
    assert_eq!(role(&plan, 111), Some(Why::Descendant), "a bundle helper's children too");
    assert_eq!(role(&plan, 120), None, "a bundle whose name merely starts the same is another app");
}

#[test]
fn wine_games_take_their_prefix_server_but_not_the_wrapper_or_other_prefixes() {
    let wrapper = "/Applications/Wrapper.app/Contents";
    let mut r = session();
    r.push(rec(700, 1, &format!("{wrapper}/MacOS/Wrapper")));
    r.push(rec(100, 700, &format!("{wrapper}/SharedSupport/wine/bin/wine64-preloader")));
    r.push(rec(101, 1, &format!("{wrapper}/SharedSupport/wine/bin/wineserver")));
    r.push(rec(102, 1, &format!("{wrapper}/SharedSupport/wine/bin/wine64-preloader"))); // services.exe
    r.push(rec(103, 102, &format!("{wrapper}/SharedSupport/wine/bin/wine64-preloader"))); // its child
    r.push(rec(200, 1, &format!("{wrapper}/SharedSupport/wine/bin/wineserver"))); // another prefix
    r.push(rec(201, 1, &format!("{wrapper}/SharedSupport/wine/bin/wine64-preloader")));
    r.push(rec(300, 1, "/usr/local/bin/wineserver")); // prefix unreadable
    let prefix = |pid: u32| match pid {
        100..=103 => Some(Some("/Users/me/pfx/a".to_string())),
        200 | 201 => Some(Some("/Users/me/pfx/b".to_string())),
        _ => None,
    };
    let plan = plan_from(&r, &game(100), ctx(), &prefix).unwrap();
    assert_eq!(role(&plan, 101), Some(Why::WinePrefix));
    assert_eq!(role(&plan, 102), Some(Why::WinePrefix));
    assert!(matches!(role(&plan, 103), Some(Why::WinePrefix | Why::Descendant)));
    for other in [700, 200, 201, 300] {
        assert_eq!(role(&plan, other), None, "pid {other} must not stop");
    }
}

#[test]
fn the_default_prefix_matches_only_the_default_prefix() {
    let mut r = session();
    r.push(rec(100, 1, "/opt/wine/bin/wine64-preloader"));
    r.push(rec(101, 1, "/opt/wine/bin/wineserver"));
    r.push(rec(102, 1, "/opt/wine/bin/wineserver"));
    let prefix = |pid: u32| match pid {
        100 | 101 => Some(None),
        102 => Some(Some("/elsewhere".to_string())),
        _ => None,
    };
    let plan = plan_from(&r, &game(100), ctx(), &prefix).unwrap();
    assert_eq!(pids(&plan), vec![100, 101]);
}

#[test]
fn refusals() {
    let mut r = session();
    let mut root_game = rec(100, 1, "/g/Game");
    root_game.uid = 0;
    r.push(root_game);
    r.push(rec(101, 1, "/System/Applications/Chess.app/Contents/MacOS/Chess"));
    r.push(rec(102, 1, "/Applications/Steam.app/Contents/MacOS/steam_osx"));
    r.push(rec(103, 1, "Game")); // path unreadable
    assert_eq!(kind(plan_from(&r, &game(100), ctx(), &no_prefix)), RefusalKind::Elevated);
    assert_eq!(kind(plan_from(&r, &game(101), ctx(), &no_prefix)), RefusalKind::Protected);
    assert_eq!(kind(plan_from(&r, &game(102), ctx(), &no_prefix)), RefusalKind::Denylisted);
    assert_eq!(kind(plan_from(&r, &game(103), ctx(), &no_prefix)), RefusalKind::Other);
    assert_eq!(kind(plan_from(&r, &game(4242), ctx(), &no_prefix)), RefusalKind::NotFound);
    assert_eq!(kind(plan_from(&r, &game(KIMOCHI), ctx(), &no_prefix)), RefusalKind::Denylisted);
    assert_eq!(kind(plan_from(&r, &game(9001), ctx(), &no_prefix)), RefusalKind::Denylisted);
    assert_eq!(kind(plan_from(&r, &GameRef::default(), ctx(), &no_prefix)), RefusalKind::NoPid);
}

#[test]
fn kimochi_its_helpers_and_other_users_are_never_members() {
    let mut r = session();
    // A game Kimochi launched itself is a descendant of Kimochi: still refused, since
    // stopping it is stopping part of Kimochi's tree.
    r.push(rec(100, 1, "/g/Game"));
    let mut helper = rec(101, 100, "/g/helper");
    helper.uid = 0;
    r.push(helper);
    let mut ours = rec(102, 1, "/Applications/Kimochi.app/Contents/MacOS/webview-helper");
    ours.responsible = Some(KIMOCHI);
    r.push(ours);
    let mut odd = rec(103, 1, "/g/odd");
    odd.responsible = Some(100);
    r.push(odd.clone());
    let mut ours_too = rec(104, 1, "/g/odd2");
    ours_too.responsible = Some(100);
    ours_too.ppid = 9001;
    r.push(ours_too);
    let plan = plan_from(&r, &game(100), ctx(), &no_prefix).unwrap();
    assert_eq!(pids(&plan), vec![100, 103]);
    assert!(plan.excluded.iter().any(|e| e.pid == 101 && e.why == "another user's process"));
    assert!(plan.excluded.iter().any(|e| e.pid == 104 && e.why == "Kimochi's own process"));
}

#[test]
fn a_session_of_processes_is_refused() {
    let mut r = session();
    r.push(rec(100, 1, "/g/Game"));
    for i in 0..(MAX_MEMBERS as u32 + 5) {
        r.push(rec(1000 + i, 100, "/g/child"));
    }
    assert_eq!(kind(plan_from(&r, &game(100), ctx(), &no_prefix)), RefusalKind::Other);
}

#[test]
fn bundles_and_wine_names() {
    assert_eq!(outer_bundle("/A/Game.app/Contents/Helpers/H.app/Contents/MacOS/H"), Some("/A/Game.app"));
    assert_eq!(outer_bundle("/usr/bin/true"), None);
    assert!(wine_like("/x/wine64-preloader"));
    assert!(wine_like("/x/wineserver"));
    assert!(wine_like("/x/wine"));
    assert!(!wine_like("/x/winery"));
    assert!(!wine_like("/x/Game.exe"));
}

#[test]
fn procargs_environment_parsing() {
    let mut buf = 2i32.to_ne_bytes().to_vec();
    buf.extend_from_slice(b"/x/wine64-preloader\0\0\0\0wine64-preloader\0game.exe\0PATH=/bin\0WINEPREFIX=/p/a/\0\0");
    assert_eq!(parse_procargs_env(&buf, "WINEPREFIX"), Some(Some("/p/a".into())));
    assert_eq!(parse_procargs_env(&buf, "HOME"), Some(None));
    assert_eq!(parse_procargs_env(&[1, 0], "WINEPREFIX"), None);
}

#[test]
fn identities_round_trip_through_a_journal() {
    let id = ProcIdentity { pid: 7, start: 123, exe: "/g/Game".into() };
    let json = serde_json::to_string(&vec![id.clone()]).unwrap();
    let back: Vec<ProcIdentity> = serde_json::from_str(&json).unwrap();
    assert_eq!(back, vec![id]);
}

// ---------------------------------------------------------------------------------------
// Live: throwaway trees of our own
// ---------------------------------------------------------------------------------------

const CHILD_ENV: &str = "KIMOCHI_PAUSE_TEST_CHILD";

/// Not a test: the body of the throwaway processes. Spawns `KIMOCHI_PAUSE_TEST_CHILD`
/// children of its own, then sleeps until its parent goes away (or a minute passes).
#[test]
#[ignore]
fn pause_test_child() {
    let Ok(kids) = std::env::var(CHILD_ENV) else { return };
    let kids: usize = kids.parse().unwrap_or(0);
    let parent = std::os::unix::process::parent_id();
    let mut spawned: Vec<Child> =
        (0..kids).map(|_| sleeper(&std::env::current_exe().unwrap(), 0, &[]).expect("spawn grandchild")).collect();
    let began = Instant::now();
    while std::os::unix::process::parent_id() == parent && began.elapsed() < Duration::from_secs(60) {
        std::thread::sleep(Duration::from_millis(50));
    }
    for c in &mut spawned {
        let _ = c.kill();
        let _ = c.wait();
    }
}

fn child_test_name() -> String {
    let path = module_path!();
    let inner = path.split_once("::").map(|(_, rest)| rest).unwrap_or(path);
    format!("{inner}::pause_test_child")
}

fn sleeper(exe: &Path, kids: usize, env: &[(&str, &str)]) -> std::io::Result<Child> {
    let mut cmd = Command::new(exe);
    cmd.args(["--ignored", "--exact", &child_test_name(), "--test-threads=1", "-q"])
        .env(CHILD_ENV, kids.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.spawn()
}

/// A throwaway process (and its tree) that is always continued and killed, by pid.
struct Tree {
    child: Child,
}

impl Tree {
    fn spawn(exe: &Path, kids: usize, env: &[(&str, &str)]) -> Tree {
        let tree = Tree { child: sleeper(exe, kids, env).expect("spawn test child") };
        let pid = tree.pid();
        wait_for(|| tree.descendants().len() == kids && record(pid).is_some(), "children to start");
        tree
    }
    fn pid(&self) -> u32 {
        self.child.id()
    }
    fn descendants(&self) -> Vec<u32> {
        let records = snapshot();
        let mut out = Vec::new();
        let mut frontier = vec![self.pid()];
        while let Some(p) = frontier.pop() {
            for r in records.iter().filter(|r| r.ppid == p) {
                out.push(r.pid);
                frontier.push(r.pid);
            }
        }
        out
    }
    fn all(&self) -> Vec<u32> {
        let mut v = vec![self.pid()];
        v.extend(self.descendants());
        v
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        for pid in self.all().into_iter().rev() {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGCONT);
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
        let _ = self.child.wait();
    }
}

fn wait_for(mut ok: impl FnMut() -> bool, what: &str) {
    let began = Instant::now();
    while !ok() {
        assert!(began.elapsed() < Duration::from_secs(20), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Kimochi as someone else: the trees here are this test's own children.
fn other() -> Context {
    Context { self_pid: u32::MAX, uid: unsafe { libc::getuid() } }
}

fn plan(owner: u32) -> Result<Plan, Refusal> {
    plan_with(&game(owner), other())
}

fn suspend(plan: &Plan) -> Result<Suspended, PauseError> {
    suspend_plan(plan, other())
}

fn resume(suspended: &Suspended) -> Result<(), PauseError> {
    resume_identities(&suspended.members)
}

fn is_stopped(pid: u32) -> bool {
    record(pid).is_some_and(|r| r.stopped)
}

fn test_exe() -> PathBuf {
    std::env::current_exe().unwrap()
}

/// A scratch directory removed at the end of the test.
struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("kimochi-pause-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
    /// A copy of the test binary at `rel` (a clone on APFS, so cheap).
    fn exe(&self, rel: &str) -> PathBuf {
        let path = self.0.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::copy(test_exe(), &path).unwrap();
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // Only ever our own uniquely named folder under the temp dir.
        if self.0.starts_with(std::env::temp_dir()) && self.0.to_string_lossy().contains("kimochi-pause-") {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[test]
fn suspend_and_resume_a_tree() {
    let scratch = Scratch::new("tree");
    let tree = Tree::spawn(&scratch.exe("bin/game"), 2, &[]);
    let first = plan(tree.pid()).expect("plan");
    let mut planned = pids(&first);
    planned.sort_unstable();
    let mut expected = tree.all();
    expected.sort_unstable();
    assert_eq!(planned, expected, "{:#?}", describe(&first));

    let began = Instant::now();
    let fresh = plan(tree.pid()).unwrap();
    let planning = began.elapsed();
    let began = Instant::now();
    let suspended = suspend(&fresh).expect("suspend");
    eprintln!("plan {planning:?}, suspend {:?} (incl. second pass)", began.elapsed());
    assert_eq!(suspended.members.len(), 3);
    for pid in tree.all() {
        assert!(is_stopped(pid), "pid {pid} should be stopped");
    }
    resume(&suspended).expect("resume");
    for pid in tree.all() {
        assert!(!is_stopped(pid), "pid {pid} should run");
    }
    // Idempotent.
    resume(&suspended).expect("second resume");
}

#[test]
fn a_recycled_pid_is_never_signalled() {
    let scratch = Scratch::new("reuse");
    let tree = Tree::spawn(&scratch.exe("bin/game"), 0, &[]);
    let mut plan = plan(tree.pid()).unwrap();
    plan.members[0].id.start += 1;
    let err = suspend(&plan).unwrap_err();
    assert_eq!((err.pid, err.refusal), (Some(tree.pid()), None), "{err}");
    assert!(!is_stopped(tree.pid()));

    // Resume with a stale identity leaves a stopped process alone.
    unsafe { libc::kill(tree.pid() as libc::pid_t, libc::SIGSTOP) };
    wait_for(|| is_stopped(tree.pid()), "manual stop");
    resume_identities(&[plan.members[0].id.clone()]).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert!(is_stopped(tree.pid()), "a stale identity must not continue the process");
}

#[test]
fn a_failed_stop_rolls_back_what_was_stopped() {
    let scratch = Scratch::new("rollback");
    let tree = Tree::spawn(&scratch.exe("bin/game"), 2, &[]);
    let plan = plan(tree.pid()).unwrap();
    // The last member refuses the signal (as another user's process would), after the
    // owner and the first child were already stopped: the pause must undo itself.
    let last = plan.members.last().unwrap().id.pid;
    REFUSE_PID.set(last);
    let err = suspend(&plan).unwrap_err();
    REFUSE_PID.set(0);
    assert_eq!(
        (err.pid, err.code, err.refusal),
        (Some(last), Some(libc::EPERM as i64), Some(RefusalKind::PermissionDenied))
    );
    for pid in tree.all() {
        assert!(!is_stopped(pid), "pid {pid} must have been continued");
    }
}

#[test]
fn a_process_someone_else_stopped_is_left_to_them() {
    let scratch = Scratch::new("already");
    let tree = Tree::spawn(&scratch.exe("bin/game"), 1, &[]);
    let kid = tree.descendants()[0];
    unsafe { libc::kill(kid as libc::pid_t, libc::SIGSTOP) };
    wait_for(|| is_stopped(kid), "manual stop");
    let suspended = suspend(&plan(tree.pid()).unwrap()).unwrap();
    assert!(!suspended.members.iter().any(|id| id.pid == kid));
    assert!(suspended.results.iter().any(|r| r.pid == kid && r.note.starts_with("already stopped")));
    resume(&suspended).unwrap();
    assert!(!is_stopped(tree.pid()));
    assert!(is_stopped(kid), "not ours to continue");
}

#[test]
fn a_journal_recovers_a_pause_whose_owner_vanished() {
    let scratch = Scratch::new("journal");
    let tree = Tree::spawn(&scratch.exe("bin/game"), 2, &[]);
    let suspended = suspend(&plan(tree.pid()).unwrap()).unwrap();
    // Kimochi "crashes": all that survives is the journal on disk.
    let journal = serde_json::to_vec(&suspended.members).unwrap();
    drop(suspended);
    let ids: Vec<ProcIdentity> = serde_json::from_slice(&journal).unwrap();
    resume_identities(&ids).unwrap();
    for pid in tree.all() {
        assert!(!is_stopped(pid));
    }
}

#[test]
fn a_bundle_helper_outside_the_tree_stops_with_the_game() {
    let scratch = Scratch::new("bundle");
    let game = Tree::spawn(&scratch.exe("Game.app/Contents/MacOS/Game"), 0, &[]);
    let helper = Tree::spawn(&scratch.exe("Game.app/Contents/Helpers/Helper"), 0, &[]);
    let other = Tree::spawn(&scratch.exe("Other.app/Contents/MacOS/Other"), 0, &[]);
    let plan = plan(game.pid()).unwrap();
    assert_eq!(role(&plan, helper.pid()), Some(Why::SameBundle), "{:#?}", describe(&plan));
    assert_eq!(role(&plan, other.pid()), None);
    let suspended = suspend(&plan).unwrap();
    assert!(is_stopped(helper.pid()) && !is_stopped(other.pid()));
    resume(&suspended).unwrap();
    assert!(!is_stopped(helper.pid()) && !is_stopped(game.pid()));
}

#[test]
fn a_wine_game_takes_its_prefix_server() {
    let scratch = Scratch::new("wine");
    let pfx_a = scratch.0.join("pfx-a");
    let pfx_b = scratch.0.join("pfx-b");
    let (a, b) = (pfx_a.to_str().unwrap(), pfx_b.to_str().unwrap());
    let game = Tree::spawn(&scratch.exe("wine/bin/wine64-preloader"), 0, &[("WINEPREFIX", a)]);
    let server = Tree::spawn(&scratch.exe("wine/bin/wineserver"), 0, &[("WINEPREFIX", a)]);
    let other = Tree::spawn(&scratch.exe("wine/bin/wineserver2"), 0, &[("WINEPREFIX", b)]);
    assert_eq!(wine_prefix(server.pid()), Some(Some(a.to_string())));
    let plan = plan(game.pid()).unwrap();
    assert_eq!(role(&plan, server.pid()), Some(Why::WinePrefix), "{:#?}", describe(&plan));
    assert_eq!(role(&plan, other.pid()), None);
    let suspended = suspend(&plan).unwrap();
    assert!(is_stopped(server.pid()) && is_stopped(game.pid()));
    resume(&suspended).unwrap();
    assert!(!is_stopped(server.pid()));
}

#[test]
fn live_records_are_sane() {
    let me = record(std::process::id()).unwrap();
    assert_eq!(me.uid, unsafe { libc::getuid() });
    assert!(!me.stopped && me.start_us > 0 && me.exe.starts_with('/'));
    // The responsible-process lookup is private; it may be absent, but must never crash
    // and never name the process itself.
    assert_ne!(responsible_pid(std::process::id()), Some(std::process::id()));
    // Our own process is never a plan's owner.
    assert_eq!(kind(plan_with(&game(std::process::id()), Context::current())), RefusalKind::Denylisted);
}

#[test]
fn refresh_stops_again_a_member_someone_continued() {
    let scratch = Scratch::new("refresh");
    let tree = Tree::spawn(&scratch.exe("bin/game"), 0, &[]);
    let backend = MacBackend { ctx: other() };
    let mut suspended = backend.suspend(&backend.plan(&game(tree.pid())).unwrap()).unwrap();
    assert_eq!(suspended.members.len(), 1);

    // Someone continues the game behind our back; refresh stops it again.
    unsafe { libc::kill(tree.pid() as libc::pid_t, libc::SIGCONT) };
    wait_for(|| !is_stopped(tree.pid()), "manual continue");
    backend.refresh(&mut suspended).unwrap();
    wait_for(|| is_stopped(tree.pid()), "refresh to stop it again");
    backend.resume(&suspended).unwrap();
    assert!(!is_stopped(tree.pid()));
}

#[test]
fn refresh_adds_a_member_the_plan_missed() {
    let scratch = Scratch::new("late");
    let tree = Tree::spawn(&scratch.exe("bin/game"), 1, &[]);
    let kid = tree.descendants()[0];
    let backend = MacBackend { ctx: other() };
    let mut plan = backend.plan(&game(tree.pid())).unwrap();
    // The plan was made a moment before the child existed.
    plan.members.retain(|m| m.id.pid != kid);
    let mut suspended = suspend_plan(&plan, other()).unwrap();
    // suspend's own second pass already catches it…
    assert!(suspended.members.iter().any(|id| id.pid == kid), "{:?}", suspended.results);
    // …and so does refresh, when it was not there yet.
    suspended.members.retain(|id| id.pid != kid);
    unsafe { libc::kill(kid as libc::pid_t, libc::SIGCONT) };
    backend.refresh(&mut suspended).unwrap();
    assert!(suspended.members.iter().any(|id| id.pid == kid));
    assert!(is_stopped(kid));
    backend.resume(&suspended).unwrap();
    assert!(!is_stopped(kid) && !is_stopped(tree.pid()));
}

#[test]
fn the_guard_resumes_a_real_game_when_the_heartbeat_stops() {
    use super::super::super::guard::{Core, Reply, Request};
    use super::super::super::journal::Journal;
    let scratch = Scratch::new("guard");
    let tree = Tree::spawn(&scratch.exe("bin/game"), 2, &[]);
    let backend = MacBackend { ctx: other() };
    let journal = Journal::in_dir(&scratch.0);
    let t0 = Instant::now();
    let mut core = Core::new(&backend, journal, t0);
    let plan = backend.plan(&game(tree.pid())).unwrap();
    let replies = core.handle(Request::Suspend { id: 1, plan }, t0);
    assert!(matches!(replies.last(), Some(Reply::Suspended { .. })), "{replies:?}");
    for pid in tree.all() {
        assert!(is_stopped(pid));
    }
    // The app goes quiet (the guard's clock is driven by hand: no real wait).
    let replies = core.tick(t0 + super::super::super::guard::HEARTBEAT_LOSS + Duration::from_millis(100));
    assert!(matches!(replies.as_slice(), [Reply::Resumed { reason, .. }] if reason == "heartbeat"), "{replies:?}");
    for pid in tree.all() {
        assert!(!is_stopped(pid));
    }
}

#[test]
fn a_journal_left_by_a_dead_guard_is_recovered_on_start() {
    use super::super::super::guard::Core;
    use super::super::super::journal::Journal;
    let scratch = Scratch::new("orphan");
    let tree = Tree::spawn(&scratch.exe("bin/game"), 1, &[]);
    let backend = MacBackend { ctx: other() };
    {
        let mut core = Core::new(&backend, Journal::in_dir(&scratch.0), Instant::now());
        let plan = backend.plan(&game(tree.pid())).unwrap();
        core.handle(super::super::super::guard::Request::Suspend { id: 1, plan }, Instant::now());
        // The guard dies without running its drop (as with SIGKILL).
        std::mem::forget(core);
    }
    assert!(is_stopped(tree.pid()));
    let mut fresh = Core::new(&backend, Journal::in_dir(&scratch.0), Instant::now());
    fresh.start();
    for pid in tree.all() {
        assert!(!is_stopped(pid), "pid {pid} should be recovered");
    }
}
