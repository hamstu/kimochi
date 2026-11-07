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

/// A process's arguments (`argv`), from the kernel. Empty when they can't be read.
fn arguments(pid: i32) -> Vec<String> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    // SAFETY: the first call only asks for the buffer's size; the second fills a buffer of it.
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return Vec::new();
    }
    let mut buffer = vec![0u8; size];
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buffer.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return Vec::new();
    }
    buffer.truncate(size);
    parse_procargs(&buffer)
}

/// `KERN_PROCARGS2`: argc (a C int), the executable path, NUL padding, then argc strings.
fn parse_procargs(buffer: &[u8]) -> Vec<String> {
    let Some(count) = buffer.get(..4).map(|b| i32::from_ne_bytes([b[0], b[1], b[2], b[3]]).max(0) as usize) else {
        return Vec::new();
    };
    let rest = &buffer[4..];
    let Some(path_end) = rest.iter().position(|&b| b == 0) else { return Vec::new() };
    let start = rest[path_end..].iter().position(|&b| b != 0).map_or(rest.len(), |i| path_end + i);
    rest[start..]
        .split(|&b| b == 0)
        .take(count)
        .map(|arg| String::from_utf8_lossy(arg).into_owned())
        .collect()
}

/// Other `kimochi` processes belonging to this user, by exact executable name. The `kimochi`
/// command line (a terminal's `kimochi watch`, say) runs the same executable but is not an
/// app, and is left alone.
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
        .filter(|&pid| !crate::cli::is_cli_args(&arguments(pid)))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn procargs_give_the_arguments_after_the_path() {
        let mut buffer = 3i32.to_ne_bytes().to_vec();
        buffer.extend_from_slice(b"/usr/local/bin/kimochi\0\0\0\0kimochi\0watch\0--json\0PATH=/bin\0");
        assert_eq!(parse_procargs(&buffer), ["kimochi", "watch", "--json"]);
        assert!(crate::cli::is_cli_args(&parse_procargs(&buffer)));
        let own = arguments(std::process::id() as i32);
        assert!(!own.is_empty(), "this test's own arguments are readable");
    }
}
