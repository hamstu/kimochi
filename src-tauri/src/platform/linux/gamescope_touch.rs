//! A game's global disabled-touch mode also affects overlay controls. Temporarily
//! select native touch passthrough while our controls have focus, with crash recovery.
use super::steam_input::{spawn_lease, Lease};
use std::io::Write;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::Manager;
use x11rb::{
    connection::Connection,
    protocol::xproto::{AtomEnum, ConnectionExt, PropMode},
    wrapper::ConnectionExt as _,
};

// Gamescope TouchClickModes::Passthrough delivers touch down/motion/up rather
// than synthesizing mouse clicks, preserving WebKit scrolling and gestures.
const TOUCH_MODE: u32 = 4;

static LEASE: Mutex<Option<Lease>> = Mutex::new(None);
static TIMER: AtomicBool = AtomicBool::new(false);
static EXITING: AtomicBool = AtomicBool::new(false);
fn owns_input() -> bool {
    let Some(desktop) = super::x11::desktop() else {
        return false;
    };
    let Some(mut window) = desktop
        .conn
        .get_input_focus()
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .map(|reply| reply.focus)
    else {
        return false;
    };
    // Native GTK file choosers are not Tauri webviews. Include their owned focus
    // window/ancestors so dictionary import remains touchable.
    for _ in 0..8 {
        if let Some(pid) = desktop.pid(window) {
            return pid == std::process::id();
        }
        let Some(parent) = desktop
            .conn
            .query_tree(window)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|reply| reply.parent)
        else {
            return false;
        };
        if parent == 0 || parent == window {
            return false;
        }
        window = parent;
    }
    false
}
fn update(active: bool) -> Result<(), String> {
    let mut lease = LEASE
        .lock()
        .map_err(|_| "Gamescope touch lease lock poisoned")?;
    let available = super::x11::desktop().is_some_and(|desktop| {
        desktop
            .conn
            .intern_atom(true, b"STEAM_TOUCH_CLICK_MODE")
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .filter(|reply| reply.atom != 0)
            .and_then(|reply| {
                desktop
                    .conn
                    .get_property(false, desktop.root, reply.atom, AtomEnum::CARDINAL, 0, 1)
                    .ok()
            })
            .and_then(|cookie| cookie.reply().ok())
            .and_then(|reply| reply.value32().and_then(|mut values| values.next()))
            .is_some()
    });
    if !active || !available {
        *lease = None;
        return Ok(());
    }
    if lease
        .as_mut()
        .is_some_and(|lease| lease.child.try_wait().ok().flatten().is_some())
    {
        *lease = None;
    }
    if lease.is_none() {
        *lease = Some(spawn_lease(&["touch"])?);
    }
    lease
        .as_mut()
        .and_then(|lease| lease.pipe.as_mut())
        .ok_or("Gamescope touch watchdog pipe unavailable")?
        .write_all(b"A")
        .map_err(|e| e.to_string())
}
pub fn show(app: &tauri::AppHandle) {
    if let Err(error) = update(true) {
        eprintln!("Gamescope touch: {error}");
    }
    if TIMER.swap(true, Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    glib::timeout_add_local(std::time::Duration::from_millis(500), move || {
        let active = !EXITING.load(Ordering::Relaxed)
            && owns_input()
            && app.webview_windows().values().any(|window| {
                window.label() != "overlay"
                    && super::gamescope::handles(window)
                    && window.is_visible().unwrap_or(false)
            });
        if let Err(error) = update(active) {
            eprintln!("Gamescope touch: {error}");
        }
        glib::ControlFlow::Continue
    });
}
pub fn stop() {
    EXITING.store(true, Ordering::Relaxed);
    let _ = update(false);
}
struct Restore {
    conn: x11rb::rust_connection::RustConnection,
    root: u32,
    atom: u32,
    original: u32,
}
impl Restore {
    fn read(&self) -> Option<u32> {
        self.conn
            .get_property(false, self.root, self.atom, AtomEnum::CARDINAL, 0, 1)
            .ok()?
            .reply()
            .ok()?
            .value32()?
            .next()
    }
    fn write(&self, value: u32) -> Result<(), String> {
        self.conn
            .change_property32(
                PropMode::REPLACE,
                self.root,
                self.atom,
                AtomEnum::CARDINAL,
                &[value],
            )
            .map_err(|e| e.to_string())?
            .check()
            .map_err(|e| e.to_string())?;
        self.conn.flush().map_err(|e| e.to_string())
    }
    fn heartbeat(&mut self) -> Result<(), String> {
        // Retain a newer game setting if Steam changes it during our ownership.
        if let Some(value) = self.read().filter(|value| *value != TOUCH_MODE) {
            self.original = value;
        }
        self.write(TOUCH_MODE)
    }
}
impl Drop for Restore {
    fn drop(&mut self) {
        // An external owner may already have selected another mode; don't overwrite it.
        let steam_focus = self
            .conn
            .intern_atom(true, b"GAMESCOPE_FOCUSED_APP")
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .filter(|reply| reply.atom != 0)
            .and_then(|reply| {
                self.conn
                    .get_property(false, self.root, reply.atom, AtomEnum::CARDINAL, 0, 1)
                    .ok()
            })
            .and_then(|cookie| cookie.reply().ok())
            .and_then(|reply| reply.value32().and_then(|mut values| values.next()))
            == Some(769);
        if self.read() == Some(TOUCH_MODE) && !steam_focus {
            let _ = self.write(self.original);
        }
        eprintln!(
            "Gamescope touch watchdog: released override (saved mode {})",
            self.original
        );
    }
}
pub fn run_watchdog() {
    let Ok((conn, screen)) = x11rb::connect(None) else {
        return;
    };
    let root = conn.setup().roots[screen].root;
    let Ok(cookie) = conn.intern_atom(true, b"STEAM_TOUCH_CLICK_MODE") else {
        return;
    };
    let Ok(reply) = cookie.reply() else {
        return;
    };
    if reply.atom == 0 {
        return;
    }
    let atom = reply.atom;
    let original = conn
        .get_property(false, root, atom, AtomEnum::CARDINAL, 0, 1)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .and_then(|reply| reply.value32().and_then(|mut values| values.next()));
    let Some(original) = original else {
        return;
    };
    let mut restore = Restore {
        conn,
        root,
        atom,
        original,
    };
    loop {
        if super::steam_input::STOP.load(Ordering::Relaxed) {
            break;
        }
        let mut poll = libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        };
        if unsafe { libc::poll(&mut poll, 1, 2500) } <= 0 {
            break;
        }
        let mut buffer = [0_u8; 32];
        let count = unsafe { libc::read(0, buffer.as_mut_ptr().cast(), buffer.len()) };
        if count <= 0 || buffer[..count as usize].contains(&b'R') {
            break;
        }
        if buffer[..count as usize].contains(&b'A') && restore.heartbeat().is_err() {
            break;
        }
    }
}
