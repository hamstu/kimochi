//! The overlay's Gamescope input claim (STEAM_OVERLAY + STEAM_INPUT_FOCUS) routes the
//! keyboard, touch and Steam's own menus to Kimochi. Nothing may leave it set by accident:
//! a separate session clears it when the claim stops being renewed (a hung main thread),
//! Kimochi exits or crashes, or the Steam/Quick Access buttons are pressed.
use super::steam_input::{spawn_lease, Lease};
use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use x11rb::{
    connection::Connection,
    protocol::xproto::{AtomEnum, ConnectionExt as _, PropMode},
    wrapper::ConnectionExt as _,
};

static LEASE: Mutex<Option<(u32, Lease)>> = Mutex::new(None);
/// Renewals arrive every 500 ms from controller navigation (ui/overlay.js, ui/region-pad.js).
const EXPIRY: Duration = Duration::from_millis(2500);

/// The overlay `xid` holds the claim: renew its guard, starting one if needed.
pub fn renew(xid: u32) {
    let Ok(mut lease) = LEASE.lock() else { return };
    if lease.as_mut().is_some_and(|(window, lease)| {
        *window != xid || lease.child.try_wait().ok().flatten().is_some()
    }) {
        *lease = None;
    }
    if lease.is_none() {
        match spawn_lease(&["claim", &xid.to_string()]) {
            Ok(child) => *lease = Some((xid, child)),
            Err(error) => {
                eprintln!("Gamescope input guard: {error}");
                return;
            }
        }
    }
    if let Some(pipe) = lease.as_mut().and_then(|(_, lease)| lease.pipe.as_mut()) {
        let _ = pipe.write_all(b"A");
    }
}
/// The claim was released normally; the guard leaves the properties alone.
pub fn release() {
    if let Ok(mut lease) = LEASE.lock() {
        *lease = None;
    }
}

/// Why the guard should clear the claim now, if it should.
fn expired(since_heartbeat: Duration, system_menu: bool) -> Option<&'static str> {
    if system_menu {
        Some("Steam's system button was pressed")
    } else if since_heartbeat >= EXPIRY {
        Some("Kimochi stopped renewing it")
    } else {
        None
    }
}

/// The guard session (`--gamescope-input-watchdog claim <xid>`).
pub fn run_watchdog(xid: u32) {
    let mut physical = super::deck_input::Reader::new();
    let mut heartbeat = Instant::now();
    let reason = loop {
        physical.poll();
        if super::steam_input::STOP.load(std::sync::atomic::Ordering::Relaxed) {
            break "Kimochi was terminated";
        }
        if let Some(reason) = expired(heartbeat.elapsed(), physical.system_menu()) {
            break reason;
        }
        let mut poll = libc::pollfd { fd: 0, events: libc::POLLIN, revents: 0 };
        let ready = unsafe { libc::poll(&mut poll, 1, 100) };
        if ready < 0 {
            break "the guard's pipe failed";
        }
        if ready == 0 {
            continue;
        }
        let mut buffer = [0_u8; 32];
        let count = unsafe { libc::read(0, buffer.as_mut_ptr().cast(), buffer.len()) };
        if count <= 0 {
            break "Kimochi exited";
        }
        let read = &buffer[..count as usize];
        if read.contains(&b'R') {
            return;
        }
        if read.contains(&b'A') {
            heartbeat = Instant::now();
        }
    };
    match clear(xid) {
        Ok(()) => eprintln!("Gamescope input guard: released the overlay's input claim ({reason})"),
        Err(error) => eprintln!("Gamescope input guard: {reason}, but the claim could not be cleared: {error}"),
    }
}
fn clear(xid: u32) -> Result<(), String> {
    let (conn, _) = x11rb::connect(None).map_err(|e| e.to_string())?;
    for name in [&b"STEAM_INPUT_FOCUS"[..], b"STEAM_OVERLAY"] {
        let atom = conn.intern_atom(false, name).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?.atom;
        // The window may already be gone with Kimochi; then there is nothing to clear.
        let _ = conn
            .change_property32(PropMode::REPLACE, xid, atom, AtomEnum::CARDINAL, &[0])
            .map_err(|e| e.to_string())?
            .check();
    }
    conn.flush().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_claim_ends_without_renewals_or_on_steams_button() {
        assert_eq!(expired(Duration::from_millis(600), false), None);
        assert!(expired(EXPIRY, false).is_some());
        assert!(expired(Duration::ZERO, true).is_some());
    }
}
