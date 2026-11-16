//! End to end with the real guard binary and this OS's real backend, on a throwaway process tree
//! the test starts. Ignored by default: it needs a built app binary.
//!
//!     cargo build && KIMOCHI_BIN=target/debug/kimochi \
//!       cargo test --bin kimochi game_pause::e2e_tests -- --ignored --test-threads=1
//!
//! 1. A holder process owns the guard's stdin, sends a suspend for the tree, and is `kill -9`ed:
//!    the guard must resume the tree at once (EOF), well before the heartbeat would.
//! 2. The guard itself is `kill -9`ed while the tree is stopped: the tree stays stopped, and a new
//!    guard started on the same journal resumes it (orphan recovery), as the app's start would.
use super::backend::{Backend, GameRef, Member, Plan, Role};
use super::guard::Reply;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Tree {
    root: Child,
    pids: Vec<u32>,
}

impl Drop for Tree {
    fn drop(&mut self) {
        for pid in self.pids.iter().rev() {
            unsafe {
                libc::kill(*pid as i32, libc::SIGCONT);
                libc::kill(*pid as i32, libc::SIGKILL);
            }
        }
        let _ = self.root.wait();
    }
}

fn tree() -> Tree {
    let root = Command::new("/bin/sh").args(["-c", "sleep 300 & sleep 300 & wait"]).spawn().unwrap();
    let pid = root.id();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let out = Command::new("pgrep").args(["-P", &pid.to_string()]).output().unwrap();
        let kids: Vec<u32> =
            String::from_utf8_lossy(&out.stdout).split_whitespace().filter_map(|p| p.parse().ok()).collect();
        if kids.len() == 2 || Instant::now() > deadline {
            let mut pids = vec![pid];
            pids.extend(kids);
            return Tree { root, pids };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn plan(backend: &dyn Backend, tree: &Tree) -> Plan {
    let members = tree
        .pids
        .iter()
        .enumerate()
        .map(|(i, pid)| Member {
            id: backend.identity(*pid).expect("identity of a test process"),
            role: if i == 0 { Role::Main } else { Role::Child },
            why: "test tree".into(),
        })
        .collect();
    Plan {
        game: GameRef { pid: Some(tree.pids[0]), ..Default::default() },
        members,
        excluded: Vec::new(),
        mechanism: "test".into(),
    }
}

fn all_stopped(backend: &dyn Backend, tree: &Tree, want: bool) -> bool {
    tree.pids.iter().all(|pid| backend.identity(*pid).and_then(|id| backend.stopped(&id)) == Some(want))
}

fn wait_for(mut check: impl FnMut() -> bool, within: Duration) -> Option<Duration> {
    let began = Instant::now();
    while began.elapsed() < within {
        if check() {
            return Some(began.elapsed());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    None
}

struct Guard {
    child: Child,
    replies: std::sync::mpsc::Receiver<Reply>,
}

/// A guard whose stdin is a FIFO; `holder` is the one process holding its write end.
fn guard(bin: &str, journal: &std::path::Path, fifo: &std::path::Path) -> Guard {
    let mut child = Command::new(bin)
        .arg(super::guard::FLAG)
        .arg(journal)
        .stdin(Stdio::from(
            std::fs::OpenOptions::new().read(true).write(false).open(fifo).unwrap_or_else(|_| panic!("open fifo")),
        ))
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let out = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            if let Ok(reply) = serde_json::from_str::<Reply>(&line) {
                eprintln!("guard: {line}");
                let _ = tx.send(reply);
            }
        }
    });
    Guard { child, replies: rx }
}

/// A process that writes `lines` to the FIFO and then holds it open, like the app.
fn holder(fifo: &std::path::Path, lines: &str) -> Child {
    Command::new("/bin/sh")
        .args(["-c", "exec 3>\"$FIFO_PATH\"; printf '%s\\n' \"$LINES\" >&3; exec sleep 300"])
        .env("LINES", lines)
        .env("FIFO_PATH", fifo)
        .spawn()
        .unwrap()
}

fn mkfifo(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
}

fn next(guard: &Guard) -> Reply {
    guard.replies.recv_timeout(Duration::from_secs(5)).expect("a reply from the guard")
}

#[test]
#[ignore]
fn real_guard_resumes_on_holder_death_and_recovers_after_its_own() {
    let Ok(bin) = std::env::var("KIMOCHI_BIN") else {
        eprintln!("KIMOCHI_BIN not set; skipped");
        return;
    };
    let backend = super::platform::backend();
    let dir = std::env::temp_dir().join(format!("kimochi-gp-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let journal = dir.join(super::journal::FILE);
    let fifo = dir.join("guard-stdin");

    // 1. The holder dies: EOF resumes the tree.
    let tree = tree();
    assert_eq!(tree.pids.len(), 3, "the test tree: sh and two sleeps");
    let request =
        serde_json::to_string(&super::guard::Request::Suspend { id: 1, plan: plan(backend.as_ref(), &tree) }).unwrap();
    mkfifo(&fifo);
    let mut hold = holder(&fifo, &request);
    let mut g = guard(&bin, &journal, &fifo);
    assert!(matches!(next(&g), Reply::Ready { .. }));
    assert!(matches!(next(&g), Reply::Suspended { id: 1, .. }));
    assert!(all_stopped(backend.as_ref(), &tree, true), "the tree is stopped");
    assert!(journal.exists(), "the journal names it");
    unsafe { libc::kill(hold.id() as i32, libc::SIGKILL) };
    let _ = hold.wait();
    let took = wait_for(|| all_stopped(backend.as_ref(), &tree, false), Duration::from_secs(5));
    let took = took.expect("the guard resumed the tree after the holder was killed");
    eprintln!("resumed {took:?} after kill -9 of the holder");
    assert!(took < Duration::from_millis(1500), "EOF, not the 3 s heartbeat, resumed it: {took:?}");
    assert!(matches!(next(&g), Reply::Resumed { id: None, ref reason, .. } if reason == "parent-exit"));
    let _ = g.child.wait();
    assert!(!journal.exists(), "the journal is cleared after the resume");

    // 2. The guard dies: the journal outlives it and the next guard resumes the orphans.
    mkfifo(&fifo);
    let request =
        serde_json::to_string(&super::guard::Request::Suspend { id: 2, plan: plan(backend.as_ref(), &tree) }).unwrap();
    let mut hold = holder(&fifo, &request);
    let mut g = guard(&bin, &journal, &fifo);
    assert!(matches!(next(&g), Reply::Ready { .. }));
    assert!(matches!(next(&g), Reply::Suspended { id: 2, .. }));
    unsafe { libc::kill(g.child.id() as i32, libc::SIGKILL) };
    let _ = g.child.wait();
    std::thread::sleep(Duration::from_millis(300));
    assert!(all_stopped(backend.as_ref(), &tree, true), "a killed guard cannot resume: the tree stays stopped");
    assert!(journal.exists());
    unsafe { libc::kill(hold.id() as i32, libc::SIGKILL) };
    let _ = hold.wait();
    mkfifo(&fifo);
    let mut hold = holder(&fifo, "");
    let mut g = guard(&bin, &journal, &fifo);
    match next(&g) {
        Reply::Ready { recovered, .. } => {
            assert_eq!(recovered.len(), 3, "{recovered:?}");
            assert!(recovered.iter().all(|r| r.outcome == "resumed"), "{recovered:?}");
        }
        other => panic!("{other:?}"),
    }
    assert!(all_stopped(backend.as_ref(), &tree, false), "recovered from the journal");
    assert!(!journal.exists());
    unsafe { libc::kill(hold.id() as i32, libc::SIGKILL) };
    let _ = hold.wait();
    let _ = g.child.wait();
    drop(tree);
    let _ = std::fs::remove_dir_all(&dir);
}
