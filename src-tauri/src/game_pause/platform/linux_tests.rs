//! Planning over made-up process tables, and the real mechanism on throwaway process trees this
//! test starts itself (never anything else).
use super::*;

const UID: u32 = 1000;

fn proc(pid: u32, ppid: u32, comm: &str, exe: &str) -> Proc {
    Proc {
        pid,
        ppid,
        uid: UID,
        state: 'S',
        start: u64::from(pid) * 10,
        comm: comm.into(),
        exe: Some(PathBuf::from(exe)),
        args: vec![exe.into()],
        wine_prefix: None,
        kernel: false,
    }
}
fn wine(pid: u32, ppid: u32, comm: &str, loader: &str, prefix: &str) -> Proc {
    Proc { wine_prefix: Some(prefix.into()), args: vec![format!("C:\\{comm}")], ..proc(pid, ppid, comm, loader) }
}
fn me() -> Me {
    Me { pid: 900, uid: UID, exe: Some("/opt/Kimochi/kimochi".into()), home: Some("/home/u".into()) }
}
fn pids(plan: &Plan) -> Vec<u32> {
    plan.members.iter().map(|m| m.id.pid).collect()
}
fn excluded(plan: &Plan) -> Vec<u32> {
    let mut out: Vec<u32> = plan.excluded.iter().map(|e| e.pid).collect();
    out.sort_unstable();
    out
}
fn game(pid: Option<u32>, app: Option<u32>) -> GameRef {
    GameRef { pid, steam_app_id: app, ..Default::default() }
}

const PROTON: &str = "/home/u/.steam/steam/steamapps/common/Proton 9.0/files/bin";
const PFX: &str = "/home/u/.steam/steam/steamapps/compatdata/413150/pfx";

/// Steam with two running games, Proton style, and Kimochi.
fn steam_table() -> Table {
    let reaper = |pid, app: u32| Proc {
        args: vec![
            "/home/u/.steam/steam/ubuntu12_32/reaper".into(),
            "SteamLaunch".into(),
            format!("AppId={app}"),
            "--".into(),
            "x".into(),
        ],
        ..proc(pid, 100, "reaper", "/home/u/.steam/steam/ubuntu12_32/reaper")
    };
    Table::new(vec![
        proc(1, 0, "systemd", "/usr/lib/systemd/systemd"),
        proc(100, 1, "steam", "/home/u/.steam/steam/ubuntu12_32/steam"),
        proc(101, 100, "steamwebhelper", "/home/u/.steam/steam/ubuntu12_32/steamwebhelper"),
        reaper(200, 413150),
        proc(201, 200, "steam-launch-wr", "/home/u/.steam/steam/ubuntu12_32/steam-launch-wrapper"),
        proc(202, 201, "pv-adverb", "/usr/libexec/steam-runtime-tools-0/pv-adverb"),
        proc(203, 202, "python3", "/usr/bin/python3.9"),
        wine(204, 202, "wineserver", &format!("{PROTON}/wineserver"), PFX),
        wine(205, 203, "steam.exe", &format!("{PROTON}/wine64-preloader"), PFX),
        wine(206, 205, "Game.exe", &format!("{PROTON}/wine64-preloader"), PFX),
        wine(207, 202, "winedevice.exe", &format!("{PROTON}/wine64-preloader"), PFX),
        reaper(300, 999),
        proc(301, 300, "other-game", "/home/u/Games/Other/other"),
        proc(900, 1, "kimochi", "/opt/Kimochi/kimochi"),
    ])
}

#[test]
fn a_steam_game_is_everything_under_its_launcher_wineserver_first() {
    let plan = plan_in(&steam_table(), &game(Some(206), Some(413150)), &me()).unwrap();
    assert_eq!(pids(&plan), vec![204, 203, 207, 205, 206]);
    // The wrappers are looked at and left out; Steam, the other game and Kimochi are not looked at.
    assert_eq!(excluded(&plan), vec![201, 202]);
    assert_eq!(plan.members.iter().find(|m| m.id.pid == 206).unwrap().role, Role::Main);
    assert_eq!(plan.mechanism, "SIGSTOP");
    assert_eq!(plan.members[0].id, ProcIdentity { pid: 204, start: 2040, exe: format!("{PROTON}/wineserver") });
}

#[test]
fn gaming_mode_finds_the_launcher_by_app_id_alone() {
    let by_app = plan_in(&steam_table(), &game(None, Some(413150)), &me()).unwrap();
    assert_eq!(pids(&by_app), vec![204, 203, 207, 205, 206]);
    let by_source = GameRef { source: Some("gamescope:window:413150:206".into()), ..Default::default() };
    assert_eq!(pids(&plan_in(&steam_table(), &by_source, &me()).unwrap()), vec![204, 203, 207, 205, 206]);
    let other = plan_in(&steam_table(), &game(None, Some(999)), &me()).unwrap();
    assert_eq!(pids(&other), vec![301]);
    assert_eq!(plan_in(&steam_table(), &game(None, Some(4242)), &me()).unwrap_err().kind, RefusalKind::NotFound);
}

#[test]
fn a_desktop_steam_game_is_found_through_the_launcher_above_its_window() {
    // No app id from Gamescope: the window's process sits under the launcher.
    let plan = plan_in(&steam_table(), &game(Some(206), None), &me()).unwrap();
    assert_eq!(pids(&plan), vec![204, 203, 207, 205, 206]);
}

#[test]
fn a_desktop_wine_game_takes_its_prefix_with_it_and_no_other() {
    let loader = "/usr/lib/wine/wine64";
    let table = Table::new(vec![
        proc(1, 0, "systemd", "/usr/lib/systemd/systemd"),
        proc(50, 1, "systemd", "/usr/lib/systemd/systemd"),
        proc(400, 50, "bash", "/usr/bin/bash"),
        wine(500, 400, "game.exe", loader, "/home/u/.wine"),
        wine(501, 500, "game.bin", loader, "/home/u/.wine"),
        // The wineserver detached: it is not under the game.
        wine(600, 50, "wineserver", "/usr/lib/wine/wineserver64", "/home/u/.wine"),
        wine(601, 50, "services.exe", loader, "/home/u/.wine"),
        wine(700, 50, "other.exe", loader, "/home/u/other-prefix"),
        wine(701, 50, "wineserver", "/usr/lib/wine/wineserver64", "/home/u/other-prefix"),
        // Same prefix, another user (never) and Kimochi's text hook helper (never).
        Proc { uid: 1001, ..wine(800, 50, "intruder.exe", loader, "/home/u/.wine") },
        wine(901, 900, "kimochi-hookd.e", loader, "/home/u/.wine"),
        proc(900, 50, "kimochi", "/opt/Kimochi/kimochi"),
    ]);
    let plan = plan_in(&table, &game(Some(500), None), &me()).unwrap();
    assert_eq!(pids(&plan), vec![600, 500, 501, 601]);
    assert!(plan.members.iter().filter(|m| [600, 601].contains(&m.id.pid)).all(|m| m.role == Role::Sibling));
    assert_eq!(excluded(&plan), vec![901], "another user's is not even looked at");
}

#[test]
fn a_native_game_takes_programs_from_its_own_folder_but_never_a_system_one() {
    let table = Table::new(vec![
        proc(1, 0, "systemd", "/usr/lib/systemd/systemd"),
        proc(400, 1, "bash", "/usr/bin/bash"),
        proc(500, 400, "game.x86_64", "/home/u/Games/Foo/game.x86_64"),
        proc(501, 500, "UnityGfx", "/home/u/Games/Foo/game.x86_64"),
        proc(502, 1, "crashhandler", "/home/u/Games/Foo/crashhandler"),
        proc(503, 1, "bar", "/home/u/Games/Bar/bar"),
        proc(510, 400, "foo", "/usr/bin/foo"),
        proc(511, 1, "vim", "/usr/bin/vim"),
        proc(520, 400, "mygame", "/home/u/.local/bin/mygame"),
        proc(521, 1, "claude", "/home/u/.local/bin/claude"),
    ]);
    assert_eq!(pids(&plan_in(&table, &game(Some(500), None), &me()).unwrap()), vec![500, 501, 502]);
    assert_eq!(pids(&plan_in(&table, &game(Some(510), None), &me()).unwrap()), vec![510]);
    assert_eq!(pids(&plan_in(&table, &game(Some(520), None), &me()).unwrap()), vec![520]);
}

#[test]
fn what_never_stops_inside_a_game_tree() {
    let table = Table::new(vec![
        proc(1, 0, "systemd", "/usr/lib/systemd/systemd"),
        proc(500, 1, "game", "/home/u/Games/G/game"),
        proc(501, 500, "pipewire", "/usr/bin/pipewire"),
        Proc { uid: 0, ..proc(502, 500, "helper", "/home/u/Games/G/helper-suid") },
        Proc { state: 'Z', ..proc(503, 500, "dead", "/home/u/Games/G/dead") },
        Proc { state: 'T', ..proc(504, 500, "debugged", "/home/u/Games/G/debugged") },
        proc(505, 500, "child", "/home/u/Games/G/child"),
        Proc { kernel: true, exe: None, ..proc(506, 500, "kworker/0:1", "") },
    ]);
    let plan = plan_in(&table, &game(Some(500), None), &me()).unwrap();
    assert_eq!(pids(&plan), vec![500, 505]);
    assert_eq!(excluded(&plan), vec![501, 502, 503, 504, 506]);
    let why = |pid| plan.excluded.iter().find(|e| e.pid == pid).unwrap().why.clone();
    assert!(why(504).contains("already stopped"), "{}", why(504));
    assert!(why(502).contains("another user"), "{}", why(502));
}

#[test]
fn the_game_itself_is_refused_with_a_reason() {
    let table = Table::new(vec![
        proc(1, 0, "systemd", "/usr/lib/systemd/systemd"),
        proc(2, 0, "gnome-shell", "/usr/bin/gnome-shell"),
        Proc { uid: 0, ..proc(3, 1, "game", "/home/u/Games/G/game") },
        proc(900, 1, "kimochi", "/opt/Kimochi/kimochi"),
        Proc { state: 'T', ..proc(4, 1, "stopped", "/home/u/Games/S/stopped") },
    ]);
    let kind = |g: GameRef| plan_in(&table, &g, &me()).unwrap_err().kind;
    assert_eq!(kind(game(Some(2), None)), RefusalKind::Denylisted);
    assert_eq!(kind(game(Some(3), None)), RefusalKind::Elevated);
    assert_eq!(kind(game(Some(900), None)), RefusalKind::Denylisted);
    assert_eq!(kind(game(Some(1), None)), RefusalKind::Protected);
    assert_eq!(kind(game(Some(77), None)), RefusalKind::NotFound);
    assert_eq!(kind(game(None, None)), RefusalKind::NoPid);
    assert_eq!(kind(game(Some(4), None)), RefusalKind::Other);
}

#[test]
fn kimochi_s_own_processes_are_found_from_its_guard() {
    let table = Table::new(vec![
        proc(1, 0, "systemd", "/usr/lib/systemd/systemd"),
        proc(800, 1, "reaper", "/home/u/.steam/steam/ubuntu12_32/reaper"),
        proc(900, 800, "kimochi", "/opt/Kimochi/kimochi"),
        proc(901, 900, "kimochi", "/opt/Kimochi/kimochi"),
        proc(902, 900, "kimochi-screen", "/opt/Kimochi/kimochi-screenai-worker"),
        proc(903, 1, "game", "/home/u/Games/G/game"),
    ]);
    let guard = Me { pid: 901, ..me() };
    let own = guard.own(&table);
    for pid in [1, 800, 900, 901, 902] {
        assert!(own.contains(&pid), "{pid}");
    }
    assert!(!own.contains(&903));
}

#[test]
fn the_denylist_matches_names_not_games() {
    for name in [
        "steam",
        "steamwebhelper",
        "pv-adverb",
        "pressure-vessel-wrap",
        "srt-bwrap",
        "gamescope",
        "Xwayland",
        "pipewire-pulse",
        "wireplumber",
        "kimochi-hookd.e",
        "ibus-daemon",
        "fcitx5",
        "xdg-desktop-portal-gnome",
        "kwin_wayland",
        "steam-runtime-launcher-service",
    ] {
        assert!(denied(name, None).is_some(), "{name}");
    }
    for name in
        ["steam.exe", "Game.exe", "gnome-mines", "python3", "wineserver", "game.x86_64", "steamtinkerlaunch-game"]
    {
        assert!(denied(name, None).is_none(), "{name}");
    }
    assert!(denied("game", Some("bwrap")).is_some());
}

#[test]
fn stat_lines_parse_with_awkward_names() {
    let tail = (4..=52).map(|v| v.to_string()).collect::<Vec<_>>().join(" ");
    let (comm, state, ppid, flags, start) = parse_stat(&format!("123 (we ird) (name) T {tail}")).unwrap();
    assert_eq!((comm.as_str(), state, ppid, flags, start), ("we ird) (name", 'T', 4, 9, 22));
    assert!(parse_stat("123 (x) S 1").is_none());
    assert!(parse_stat("garbage").is_none());
}

#[test]
fn the_wine_prefix_comes_from_the_environment() {
    assert_eq!(wine_prefix(b"HOME=/home/u\0WINEPREFIX=/games/pfx/\0"), Some("/games/pfx".into()));
    assert_eq!(wine_prefix(b"HOME=/home/u\0WINEPREFIX=\0"), Some("/home/u/.wine".into()));
    assert_eq!(wine_prefix(b"PATH=/bin\0"), None);
}

#[test]
fn game_folders_are_never_shared_ones() {
    let home = Some(Path::new("/home/u"));
    assert_eq!(game_folder(Path::new("/home/u/Games/Foo/foo"), home), Some("/home/u/Games/Foo".into()));
    assert_eq!(game_folder(Path::new("/opt/SomeGame/game"), home), Some("/opt/SomeGame".into()));
    for exe in [
        "/usr/bin/foo",
        "/usr/games/foo",
        "/home/u/foo",
        "/home/u/bin/foo",
        "/home/u/.local/bin/foo",
        "/tmp/x/foo",
        "/app/bin/foo",
        "/foo",
        "/opt/foo",
    ] {
        assert_eq!(game_folder(Path::new(exe), home), None, "{exe}");
    }
}

// ---- the real thing, on processes this test starts ----

/// A throwaway process tree: `sh -c <script>`, killed (after a SIGCONT) when dropped.
struct Tree {
    child: std::process::Child,
}
impl Tree {
    fn spawn(script: &str, children: usize) -> Tree {
        let child = std::process::Command::new("sh").arg("-c").arg(script).spawn().unwrap();
        let tree = Tree { child };
        let deadline = Instant::now() + Duration::from_secs(5);
        while tree.descendants().len() < children {
            assert!(Instant::now() < deadline, "the test tree did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
        tree
    }
    fn root(&self) -> u32 {
        self.child.id()
    }
    fn descendants(&self) -> Vec<u32> {
        Table::read().descendants(self.root(), 64)
    }
    fn all(&self) -> Vec<u32> {
        let mut all = vec![self.root()];
        all.extend(self.descendants());
        all
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        for pid in self.all() {
            unsafe {
                libc::kill(pid as i32, libc::SIGCONT);
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
        let _ = self.child.wait();
    }
}

/// The backend as an unrelated caller (this test's children are otherwise Kimochi's own).
fn linux() -> Linux {
    Linux {
        me: Some(Me { pid: 0x7fff_fff0, uid: unsafe { libc::geteuid() }, exe: None, home: None }),
        ..Default::default()
    }
}
fn stopped(pid: u32) -> bool {
    all_stopped(pid) == Some(true)
}
fn running(pid: u32) -> bool {
    any_stopped(pid) == Some(false)
}
fn window(pid: u32) -> GameRef {
    GameRef { pid: Some(pid), ..Default::default() }
}

#[test]
fn a_tree_is_stopped_and_continued() {
    let tree = Tree::spawn("sleep 60 & sleep 60 & wait", 2);
    let backend = linux();
    let plan = backend.plan(&window(tree.root())).unwrap();
    assert_eq!(pids(&plan), tree.all());
    let suspended = backend.suspend(&plan).unwrap();
    assert_eq!(suspended.members.len(), 3);
    assert!(tree.all().into_iter().all(stopped));
    assert!(suspended.results.iter().all(|r| r.ok), "{:?}", suspended.results);
    backend.resume(&suspended).unwrap();
    assert!(tree.all().into_iter().all(running));
    // Idempotent.
    backend.resume(&suspended).unwrap();
    assert!(tree.all().into_iter().all(running));
}

#[test]
fn every_thread_of_a_threaded_process_stops() {
    let script = "python3 -c 'import threading,time\nfor _ in range(4): threading.Thread(target=time.sleep,args=(60,),daemon=True).start()\ntime.sleep(60)'";
    let tree = Tree::spawn(script, 1);
    std::thread::sleep(Duration::from_millis(300));
    let backend = linux();
    let python = tree.descendants()[0];
    assert!(thread_states(python).unwrap().len() >= 5);
    let suspended = backend.suspend(&backend.plan(&window(tree.root())).unwrap()).unwrap();
    assert!(thread_states(python).unwrap().iter().all(|s| *s == 'T'));
    backend.resume(&suspended).unwrap();
    assert!(thread_states(python).unwrap().iter().all(|s| *s != 'T'));
}

#[test]
fn a_failure_part_way_rolls_back_what_was_stopped() {
    let tree = Tree::spawn("sleep 60 & sleep 60 & wait", 2);
    let backend = linux();
    let mut plan = backend.plan(&window(tree.root())).unwrap();
    // A process that may never be signalled, last: init, refused before any signal is sent.
    let init = backend.identity(1).unwrap();
    plan.members.push(Member { id: init, role: Role::Sibling, why: "test".into() });
    let error = backend.suspend(&plan).unwrap_err();
    assert_eq!(error.pid, Some(1));
    assert_eq!(error.refusal, Some(RefusalKind::PermissionDenied));
    assert!(tree.all().into_iter().all(running));
    // Another user's process the same way, when there is one to point at.
    let table = Table::read();
    if let Some(other) = table.procs.values().find(|p| p.uid != unsafe { libc::geteuid() } && p.pid > 1 && !p.kernel) {
        let mut plan = backend.plan(&window(tree.root())).unwrap();
        plan.members.push(Member { id: other.identity(), role: Role::Sibling, why: "test".into() });
        let error = backend.suspend(&plan).unwrap_err();
        assert_eq!(error.pid, Some(other.pid));
        assert!(tree.all().into_iter().all(running));
    }
}

#[test]
fn a_reused_pid_is_never_signalled() {
    let game = Tree::spawn("sleep 60 & wait", 1);
    // A process that is not part of the game, named by a plan with its pid but an older start:
    // the pid was "reused" by it.
    let bystander = Tree::spawn("sleep 60 & wait", 1);
    let backend = linux();
    let mut plan = backend.plan(&window(game.root())).unwrap();
    let mut stale = backend.identity(bystander.root()).unwrap();
    stale.start -= 1;
    plan.members.insert(0, Member { id: stale.clone(), role: Role::Child, why: "test".into() });
    let suspended = backend.suspend(&plan).unwrap();
    assert!(running(bystander.root()));
    assert!(!suspended.members.iter().any(|m| m.pid == bystander.root()));
    assert!(suspended.results.iter().any(|r| r.pid == bystander.root() && r.note.contains("reused")));
    assert!(game.all().into_iter().all(stopped));
    // Resume never signals a mismatched identity either.
    unsafe { libc::kill(bystander.root() as i32, libc::SIGSTOP) };
    std::thread::sleep(Duration::from_millis(50));
    backend.resume(&Suspended { members: vec![stale], ..suspended.clone() }).unwrap();
    assert!(stopped(bystander.root()));
    backend.resume(&suspended).unwrap();
    assert!(game.all().into_iter().all(running));
}

#[test]
fn a_process_stopped_by_someone_else_is_left_stopped() {
    let tree = Tree::spawn("sleep 60 & sleep 60 & wait", 2);
    let theirs = tree.descendants()[0];
    unsafe { libc::kill(theirs as i32, libc::SIGSTOP) };
    std::thread::sleep(Duration::from_millis(50));
    let backend = linux();
    let plan = backend.plan(&window(tree.root())).unwrap();
    assert!(!pids(&plan).contains(&theirs));
    // Even when a plan made earlier names it.
    let mut stale = plan.clone();
    stale.members.push(Member { id: backend.identity(theirs).unwrap(), role: Role::Child, why: "test".into() });
    let suspended = backend.suspend(&stale).unwrap();
    assert!(!suspended.members.iter().any(|m| m.pid == theirs));
    backend.resume(&suspended).unwrap();
    assert!(stopped(theirs));
    assert!(running(tree.root()));
}

#[test]
fn stopped_tells_who_is_stopped_and_only_for_that_process() {
    let tree = Tree::spawn("sleep 60 & wait", 1);
    let backend = linux();
    let id = backend.identity(tree.root()).unwrap();
    assert_eq!(backend.stopped(&id), Some(false));
    unsafe { libc::kill(tree.root() as i32, libc::SIGSTOP) };
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(backend.stopped(&id), Some(true));
    assert_eq!(backend.stopped(&ProcIdentity { start: id.start + 1, ..id.clone() }), None);
    unsafe { libc::kill(tree.root() as i32, libc::SIGCONT) };
}

#[test]
fn a_child_started_after_the_plan_is_caught() {
    let tree = Tree::spawn("sleep 60 & sleep 0.4; sleep 60 & wait", 2);
    let backend = linux();
    let plan = backend.plan(&window(tree.root())).unwrap();
    std::thread::sleep(Duration::from_millis(700));
    let late: Vec<u32> = tree.descendants().into_iter().filter(|pid| !pids(&plan).contains(pid)).collect();
    assert_eq!(late.len(), 1, "the late child exists and was not planned");
    let suspended = backend.suspend(&plan).unwrap();
    assert!(suspended.members.iter().any(|m| m.pid == late[0]));
    assert!(tree.all().into_iter().all(stopped));
    backend.resume(&suspended).unwrap();
    assert!(tree.all().into_iter().all(running));
}

#[test]
fn refresh_stops_again_what_was_continued_behind_its_back() {
    let tree = Tree::spawn("sleep 60 & sleep 60 & wait", 2);
    let backend = linux();
    let mut suspended = backend.suspend(&backend.plan(&window(tree.root())).unwrap()).unwrap();
    let poked = tree.descendants()[1];
    unsafe { libc::kill(poked as i32, libc::SIGCONT) };
    std::thread::sleep(Duration::from_millis(50));
    assert!(running(poked));
    backend.refresh(&mut suspended).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert!(tree.all().into_iter().all(stopped));
    assert!(suspended.results.iter().any(|r| r.pid == poked && r.note == "stopped again"));
    backend.resume(&suspended).unwrap();
    assert!(tree.all().into_iter().all(running));
}

#[test]
fn a_journal_left_by_a_crash_resumes_the_game() {
    use super::super::super::journal::{Entry, Journal};
    let tree = Tree::spawn("sleep 60 & sleep 60 & wait", 2);
    let backend = linux();
    let suspended = backend.suspend(&backend.plan(&window(tree.root())).unwrap()).unwrap();
    let dir = std::env::temp_dir().join(format!("kimochi-linux-journal-{}", std::process::id()));
    let journal = Journal::in_dir(&dir);
    let entry = Entry {
        game: suspended.game.clone(),
        members: suspended.members.clone(),
        mechanism: MECHANISM.into(),
        at: 1,
        guard: 1,
        boot: crate::game_pause::journal::boot_id(),
    };
    journal.write(&entry).unwrap();
    // The guard and the app are gone; a new start recovers.
    let recovered = journal.recover(&backend, None);
    assert_eq!(recovered.len(), 3);
    assert!(recovered.iter().all(|r| r.outcome == "resumed"), "{recovered:?}");
    assert!(tree.all().into_iter().all(running));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_guard_resumes_when_the_heartbeat_stops() {
    use super::super::super::guard::{Core, Reply, Request};
    use super::super::super::journal::Journal;
    let tree = Tree::spawn("sleep 60 & sleep 60 & wait", 2);
    let backend = linux();
    let dir = std::env::temp_dir().join(format!("kimochi-linux-guard-{}", std::process::id()));
    let now = Instant::now();
    let mut core = Core::new(&backend, Journal::in_dir(&dir), now);
    let plan = backend.plan(&window(tree.root())).unwrap();
    let replies = core.handle(Request::Suspend { id: 1, plan }, now);
    assert!(matches!(replies.last(), Some(Reply::Suspended { .. })), "{replies:?}");
    assert!(tree.all().into_iter().all(stopped));
    let replies = core.tick(now + super::super::super::guard::HEARTBEAT_LOSS + Duration::from_millis(100));
    assert!(matches!(replies.first(), Some(Reply::Resumed { reason, .. }) if reason == "heartbeat"), "{replies:?}");
    assert!(tree.all().into_iter().all(running));
    // And when the guard itself goes away holding a pause.
    let plan = backend.plan(&window(tree.root())).unwrap();
    core.handle(Request::Suspend { id: 2, plan }, Instant::now());
    assert!(tree.all().into_iter().all(stopped));
    drop(core);
    assert!(tree.all().into_iter().all(running));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn rapid_pause_and_resume_never_leaves_the_game_stopped() {
    let tree = Tree::spawn("sleep 60 & sleep 60 & wait", 2);
    let backend = linux();
    for _ in 0..100 {
        let suspended = backend.suspend(&backend.plan(&window(tree.root())).unwrap()).unwrap();
        backend.resume(&suspended).unwrap();
    }
    assert!(tree.all().into_iter().all(running));
}

// ---- PipeWire parking, against the session's real PipeWire ----

/// A sine as a 16-bit mono 48 kHz WAV.
fn sine_wav(path: &Path, freq: f64, seconds: u32) {
    let rate = 48_000u32;
    let samples: Vec<i16> = (0..rate * seconds)
        .map(|i| (8000.0 * (2.0 * std::f64::consts::PI * freq * f64::from(i) / f64::from(rate)).sin()) as i16)
        .collect();
    let data: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
    let mut wav = Vec::new();
    wav.extend(b"RIFF");
    wav.extend((36 + data.len() as u32).to_le_bytes());
    wav.extend(b"WAVEfmt ");
    wav.extend(16u32.to_le_bytes());
    wav.extend(1u16.to_le_bytes());
    wav.extend(1u16.to_le_bytes());
    wav.extend(rate.to_le_bytes());
    wav.extend((rate * 2).to_le_bytes());
    wav.extend(2u16.to_le_bytes());
    wav.extend(16u16.to_le_bytes());
    wav.extend(b"data");
    wav.extend((data.len() as u32).to_le_bytes());
    wav.extend(data);
    std::fs::write(path, wav).unwrap();
}

/// The samples of a 16-bit WAV's first channel.
fn wav_samples(path: &Path) -> (Vec<i16>, u32) {
    let bytes = std::fs::read(path).unwrap();
    let channels = u16::from_le_bytes([bytes[22], bytes[23]]) as usize;
    let rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]) as usize;
        if &bytes[at..at + 4] == b"data" {
            let end = (at + 8 + size).min(bytes.len());
            let all: Vec<i16> = bytes[at + 8..end].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
            return (all.into_iter().step_by(channels).collect(), rate);
        }
        at += 8 + size;
    }
    (Vec::new(), rate)
}

/// The longest stretch of silence, in ms, between the first and the last sound.
fn longest_silence_ms(samples: &[i16], rate: u32) -> u64 {
    let loud = |s: &i16| s.unsigned_abs() > 200;
    let (Some(first), Some(last)) = (samples.iter().position(loud), samples.iter().rposition(loud)) else {
        return u64::MAX;
    };
    let (mut run, mut longest) = (0u64, 0u64);
    for s in &samples[first..=last] {
        run = if loud(s) { 0 } else { run + 1 };
        longest = longest.max(run);
    }
    longest * 1000 / u64::from(rate)
}

fn pw(dump_filter: impl Fn(&serde_json::Value) -> bool) -> bool {
    let out = std::process::Command::new("pw-dump").output().unwrap();
    dump_filter(&serde_json::from_slice(&out.stdout).unwrap())
}

#[test]
#[ignore = "needs a PipeWire session with pw-play and pw-record; run by hand"]
fn a_paused_native_pipewire_game_does_not_silence_other_apps() {
    use std::process::{Command, Stdio};
    if std::process::Command::new("pw-dump").output().map(|o| !o.status.success()).unwrap_or(true) {
        eprintln!("no PipeWire here; skipped");
        return;
    }
    let dir = std::env::temp_dir().join(format!("kimochi-park-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    sine_wav(&dir.join("other.wav"), 440.0, 60);
    sine_wav(&dir.join("game.wav"), 1000.0, 60);
    // The "real" output: a null sink of this test's own (never the user's speakers).
    let sink = format!("kimochi-pause-test-sink-{}", std::process::id());
    let mut owner =
        Command::new("pw-cli").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    {
        use std::io::Write;
        let line = format!("create-node adapter {{ factory.name=support.null-audio-sink node.name={sink} media.class=Audio/Sink object.linger=false audio.position=[FL FR] priority.session=0 priority.driver=0 }}\n");
        owner.stdin.as_mut().unwrap().write_all(line.as_bytes()).unwrap();
    }
    std::thread::sleep(Duration::from_millis(800));
    let spawn = |args: &[&str]| {
        Command::new(args[0]).args(&args[1..]).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap()
    };
    let record = dir.join("record.wav");
    let mut recorder = spawn(&[
        "pw-record",
        "-P",
        "{ stream.capture.sink=true }",
        "--target",
        &sink,
        "--channels",
        "1",
        "--rate",
        "48000",
        record.to_str().unwrap(),
    ]);
    std::thread::sleep(Duration::from_millis(300));
    let mut other = spawn(&["pw-play", "--target", &sink, dir.join("other.wav").to_str().unwrap()]);
    let mut game = spawn(&["pw-play", "--target", &sink, dir.join("game.wav").to_str().unwrap()]);
    std::thread::sleep(Duration::from_millis(1500));

    let backend = linux();
    let plan = backend.plan(&window(game.id())).unwrap();
    let suspended = backend.suspend(&plan).unwrap();
    let notes: Vec<&str> =
        suspended.results.iter().filter(|r| r.note.starts_with("audio:")).map(|r| r.note.as_str()).collect();
    eprintln!("{notes:#?}");
    assert!(notes.iter().any(|n| n.contains("parked 1 stream")), "{notes:?}");
    assert!(stopped(game.id()));
    std::thread::sleep(Duration::from_millis(3000));
    let notes = backend.resume_with_results(&suspended).unwrap();
    assert!(running(game.id()));
    assert!(notes.iter().any(|r| r.note.contains("park sink") && r.note.contains("removed")), "{notes:?}");
    assert!(notes.iter().any(|r| r.pid == game.id() && r.note == "continued"), "{notes:?}");
    assert!(pw(|d| audio::park_sinks(d).is_empty()), "the park sink is gone");
    assert!(pw(|d| !audio::metadata(d, "default").iter().any(|e| e.key == audio::RESTORE_KEY)), "nothing left saved");
    assert!(
        pw(|d| audio::metadata(d, "default").iter().all(|e| !e.value.starts_with(audio::PARK_PREFIX))),
        "no stream points at a park sink"
    );
    std::thread::sleep(Duration::from_millis(1000));

    // The guard dies while holding the pause: its park sink goes with its pw-cli, and a later
    // resume by another process (the journal's recovery) puts the stream back.
    let suspended = backend.suspend(&backend.plan(&window(game.id())).unwrap()).unwrap();
    let owner_pid = backend.audio.lock().unwrap().as_ref().map(|p| p.owner_pid()).expect("parked again");
    unsafe { libc::kill(owner_pid as i32, libc::SIGKILL) };
    std::thread::sleep(Duration::from_millis(500));
    assert!(pw(|d| audio::park_sinks(d).is_empty()), "the park sink died with its owner");
    assert!(
        pw(|d| audio::metadata(d, "default").iter().any(|e| e.key == audio::RESTORE_KEY)),
        "what to restore is still known"
    );
    let recovery = linux();
    recovery.resume(&suspended).unwrap();
    assert!(running(game.id()));
    assert!(pw(|d| !audio::metadata(d, "default").iter().any(|e| e.key == audio::RESTORE_KEY)));
    // The first backend's leftover (its owner already dead) is harmless.
    drop(backend);

    std::thread::sleep(Duration::from_millis(500));
    for child in [&mut other, &mut game] {
        let _ = child.kill();
        let _ = child.wait();
    }
    unsafe { libc::kill(recorder.id() as i32, libc::SIGINT) };
    let _ = recorder.wait();
    let _ = owner.kill();
    let _ = owner.wait();
    let (samples, rate) = wav_samples(&record);
    let silence = longest_silence_ms(&samples, rate);
    eprintln!("recorded {} ms, longest silence {silence} ms", samples.len() as u64 * 1000 / u64::from(rate));
    // Without parking, the output is silent for the whole 3 s pause.
    assert!(silence < 300, "the other app went quiet for {silence} ms");
    let _ = std::fs::remove_dir_all(dir);
}
