//! Modal Deck input ownership. Steam reads HID directly, bypassing X focus.
//! A separate session resumes Steam on EOF, heartbeat timeout or termination.
use std::io::Write;
use std::os::unix::{fs::MetadataExt, process::CommandExt};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

static LEASE: Mutex<Option<Lease>> = Mutex::new(None);
pub(super) static STOP: AtomicBool = AtomicBool::new(false);
const FLAG: &str = "--gamescope-input-watchdog";

fn start_time(stat: &str) -> Option<&str> {
    stat.rsplit_once(')')?.1.split_whitespace().nth(19)
}
fn identity(pid: u32) -> Option<String> {
    let path = std::path::PathBuf::from(format!("/proc/{pid}"));
    if path.metadata().ok()?.uid() != unsafe { libc::geteuid() }
        || std::fs::read_to_string(path.join("comm")).ok()?.trim() != "steam"
    {
        return None;
    }
    let stat = std::fs::read_to_string(path.join("stat")).ok()?;
    Some(start_time(&stat)?.to_owned())
}
fn steam() -> Option<(u32, String)> {
    std::fs::read_dir("/proc")
        .ok()?
        .flatten()
        .find_map(|entry| {
            let pid = entry.file_name().to_str()?.parse().ok()?;
            // Do not take ownership of a process another tool has already stopped.
            let stat = std::fs::read_to_string(entry.path().join("stat")).ok()?;
            let state = stat.rsplit_once(')')?.1.split_whitespace().next()?;
            if matches!(state, "T" | "t" | "Z" | "X") {
                return None;
            }
            Some((pid, identity(pid)?))
        })
}
pub(super) struct Lease {
    pub(super) child: Child,
    pub(super) pipe: Option<ChildStdin>,
}
pub(super) fn spawn_lease(args: &[&str]) -> Result<Lease, String> {
    let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
    command
        .arg(FLAG)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let pipe = child.stdin.take();
    Ok(Lease { child, pipe })
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(mut pipe) = self.pipe.take() {
            let _ = pipe.write_all(b"R");
        }
        // Reap without blocking GTK. Never kill the independent resume watchdog.
        let pid = self.child.id();
        std::thread::spawn(move || unsafe {
            libc::waitpid(pid as i32, std::ptr::null_mut(), 0);
        });
    }
}
pub fn update(active: bool) -> Result<(), String> {
    let mut lease = LEASE
        .lock()
        .map_err(|_| "Steam input lease lock poisoned")?;
    if !active {
        *lease = None;
        return Ok(());
    }
    if lease
        .as_mut()
        .is_some_and(|lease| lease.child.try_wait().ok().flatten().is_some())
    {
        *lease = None;
        return Err("Steam input watchdog expired; close and reopen controller navigation".into());
    }
    if lease.is_none() {
        let (pid, token) = steam().ok_or("Steam input: no same-user Steam process found")?;
        *lease = Some(spawn_lease(&[&pid.to_string(), &token, &std::process::id().to_string()])?);
    }
    lease
        .as_mut()
        .and_then(|lease| lease.pipe.as_mut())
        .ok_or("Steam input watchdog pipe unavailable")?
        .write_all(b"A")
        .map_err(|e| e.to_string())
}
/// System buttons must reach Steam while still physically held, rather than
/// waiting for the normal B/confirm release delay.
pub fn handoff() {
    if let Ok(mut lease) = LEASE.lock() {
        if let Some(pipe) = lease.as_mut().and_then(|lease| lease.pipe.as_mut()) {
            let _ = pipe.write_all(b"H");
        }
        *lease = None;
    }
}
extern "C" fn terminate(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}
pub(super) fn signals(name: &std::ffi::CStr) {
    unsafe {
        libc::prctl(libc::PR_SET_NAME, name.as_ptr());
        libc::signal(libc::SIGTERM, terminate as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, terminate as *const () as libc::sighandler_t);
        libc::signal(libc::SIGHUP, terminate as *const () as libc::sighandler_t);
    }
}
struct Resume {
    pid: u32,
    token: String,
}
impl Drop for Resume {
    fn drop(&mut self) {
        if identity(self.pid).as_deref() == Some(&self.token) {
            unsafe {
                libc::kill(self.pid as i32, libc::SIGCONT);
            }
            eprintln!("Gamescope input watchdog: resumed Steam PID {}", self.pid);
        }
    }
}
/// Runs before Tauri, single-instance registration or GTK initialization.
pub fn run_watchdog() -> bool {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some(FLAG) {
        return false;
    }
    if args.get(2).map(String::as_str) == Some("touch") {
        if super::gamescope::active() {
            signals(c"kimochi-touch");
            super::gamescope_touch::run_watchdog();
        }
        return true;
    }
    let Some(pid) = args.get(2).and_then(|value| value.parse::<u32>().ok()) else {
        return true;
    };
    let Some(token) = args.get(3) else {
        return true;
    };
    if !super::gamescope::active() || identity(pid).as_deref() != Some(token) {
        return true;
    }
    let Some(owner) = args.get(4).and_then(|value| value.parse::<u32>().ok()) else { return true; };
    signals(c"kimochi-input");
    let mut last_heartbeat = std::time::Instant::now();
    let mut paused = false;
    let mut resume = None;
    loop {
        if STOP.load(Ordering::Relaxed)
            || !super::gamescope_focus::owns_input(owner)
            || last_heartbeat.elapsed() >= std::time::Duration::from_millis(2500)
        {
            break;
        }
        let mut poll = libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut poll, 1, 100) };
        if ready < 0 { break; }
        if ready == 0 { continue; }
        let mut buffer = [0_u8; 32];
        let count = unsafe { libc::read(0, buffer.as_mut_ptr().cast(), buffer.len()) };
        if count <= 0 {
            break;
        }
        if buffer[..count as usize].contains(&b'H') {
            break;
        }
        if buffer[..count as usize].contains(&b'R') {
            // Let the physical B/confirm release settle before Steam reads HID again.
            std::thread::sleep(std::time::Duration::from_millis(250));
            break;
        }
        if buffer[..count as usize].contains(&b'A') {
            last_heartbeat = std::time::Instant::now();
        }
        if !paused && buffer[..count as usize].contains(&b'A') {
            if identity(pid).as_deref() != Some(token) {
                break;
            }
            resume = Some(Resume {
                pid,
                token: token.clone(),
            });
            if unsafe { libc::kill(pid as i32, libc::SIGSTOP) } != 0 {
                break;
            }
            paused = true;
            if let Err(error) = super::controller_neutral::release() {
                eprintln!("Gamescope input watchdog: {error}; releasing input");
                break;
            }
            eprintln!("Gamescope input watchdog: paused Steam PID {pid}");
        }
    }
    drop(resume);
    true
}
#[cfg(test)]
mod tests {
    use super::start_time;
    #[test]
    fn stat_handles_spaces_and_parentheses_in_name() {
        let suffix = (3..=22)
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            start_time(&format!("123 (steam (test)) {suffix}")),
            Some("22")
        );
    }
    #[test]
    fn malformed_stat_has_no_identity() {
        assert_eq!(start_time("invalid"), None);
        assert_eq!(start_time("123 (steam) S 1"), None);
    }
}
