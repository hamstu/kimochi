//! One Kimochi at a time, whichever build it is.
//!
//! Two copies fight over everything that is per-machine rather than per-process: the
//! global shortcuts, the gamepad, the keyboard watcher, ScreenCaptureKit streams of the
//! same window, the overlay's place above the game. The release app and a `tauri dev`
//! build have different identifiers and different data directories, so nothing else
//! stops them running side by side — and a copy left hung in the background (a
//! "zombie" window) once quietly broke capture for the live one.
//!
//! So the newest launch takes over. It is the one the user just asked for, and a stale
//! or stuck copy is exactly what needs replacing:
//!
//!  1. A lock file in a directory every build shares, holding the owner's pid. Whoever
//!     cannot take the lock asks that pid to quit.
//!  2. A sweep for any other `kimochi` process of this user, so builds from before the
//!     lock existed are caught too. Every build's executable is named `kimochi`.
//!
//! Each one is asked to quit (SIGTERM) and, if it has not gone after a short wait, is
//! killed. The lock is then held for the life of this process; the kernel drops it when
//! the process ends, however it ends.
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// What happened at startup, logged once the app's log exists.
static REPORT: OnceLock<serde_json::Value> = OnceLock::new();

const EXECUTABLE: &str = "kimochi";
const QUIT_WAIT: Duration = Duration::from_millis(2500);
const KILL_WAIT: Duration = Duration::from_millis(1500);

fn lock_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Application Support/Kimochi/instance.lock"))
}

fn alive(pid: i32) -> bool {
    // Signal 0 checks for existence. EPERM means it exists but is someone else's.
    pid > 0 && unsafe { libc::kill(pid, 0) } == 0
}

fn wait_gone(pid: i32, limit: Duration) -> bool {
    let start = Instant::now();
    while alive(pid) {
        if start.elapsed() > limit {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

/// Ask nicely, then insist. Returns how it ended: "quit", "killed" or "survived".
fn stop(pid: i32) -> &'static str {
    unsafe { libc::kill(pid, libc::SIGTERM) };
    if wait_gone(pid, QUIT_WAIT) {
        return "quit";
    }
    unsafe { libc::kill(pid, libc::SIGKILL) };
    if wait_gone(pid, KILL_WAIT) {
        "killed"
    } else {
        "survived"
    }
}

/// Other `kimochi` processes belonging to this user, by exact executable name.
fn others() -> Vec<i32> {
    let own = std::process::id() as i32;
    let uid = unsafe { libc::getuid() };
    let Ok(output) = Command::new("/usr/bin/pgrep")
        .args(["-x", "-U", &uid.to_string(), EXECUTABLE])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .filter(|&pid| pid != own)
        .collect()
}

fn try_lock(file: &File) -> bool {
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
}

/// Become the only Kimochi. Call first thing in `main`, before any window, shortcut or
/// capture exists.
pub fn take_over() {
    let mut stopped = Vec::new();
    let mut lock = None;
    if let Some(path) = lock_path() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(mut file) = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
        {
            if !try_lock(&file) {
                let mut held = String::new();
                let _ = file.read_to_string(&mut held);
                if let Ok(pid) = held.trim().parse::<i32>() {
                    if pid != std::process::id() as i32 && alive(pid) {
                        stopped.push(
                            serde_json::json!({"pid": pid, "via": "lock", "outcome": stop(pid)}),
                        );
                    }
                }
            }
            lock = Some(file);
        }
    }

    for pid in others() {
        stopped.push(serde_json::json!({"pid": pid, "via": "sweep", "outcome": stop(pid)}));
    }

    let mut held = false;
    if let Some(mut file) = lock {
        let start = Instant::now();
        while !try_lock(&file) && start.elapsed() < KILL_WAIT {
            std::thread::sleep(Duration::from_millis(50));
        }
        held = try_lock(&file);
        if held {
            let _ = file.set_len(0);
            let _ = file.seek(SeekFrom::Start(0));
            let _ = write!(file, "{}", std::process::id());
            let _ = file.flush();
        }
        // Held until this process ends; the kernel releases it however that happens.
        std::mem::forget(file);
    }

    let _ = REPORT.set(serde_json::json!({
        "check": "single-instance",
        "pid": std::process::id(),
        "lockHeld": held,
        "replaced": stopped,
    }));
}

/// The startup report, for the app log.
pub fn report() -> Option<serde_json::Value> {
    REPORT.get().cloned()
}
