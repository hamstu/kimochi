//! System sleep/wake and application activation: the Linux counterpart of the macOS
//! `NSWorkspace` notifications.
//!
//! - **Sleep/wake** come from systemd-logind's `PrepareForSleep(bool)` signal on the
//!   system bus (true before suspend, false after resume), on both X11 and Wayland. A
//!   system without logind (no systemd, elogind not running) simply never reports
//!   either; that is logged, not an error.
//! - **Activation** (X11 only) comes from `PropertyNotify` of `_NET_ACTIVE_WINDOW` on
//!   the root window, reported once per change of active *process* with its process
//!   name, our own included, as on macOS. Wayland does not disclose which application
//!   is active, so nothing is reported there.
//!
//! The callbacks are `'static` but not `Send`, as on macOS, and are honoured the same
//! way: they are stored on the calling thread, which must be the main (GTK) thread, and
//! only ever run there. The watcher threads hand each event to the main loop with
//! `glib::idle_add_once` (the closure carries only `Send` data), and the main loop runs
//! the stored callback. `setup`, where `main.rs` calls this, is the main thread.
use super::{rules, session, x11, Backend};
use std::cell::{Cell, RefCell};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ChangeWindowAttributesAux, ConnectionExt as _, EventMask};
use x11rb::protocol::Event;

struct Handlers {
    on_sleep: Box<dyn Fn()>,
    on_wake: Box<dyn Fn()>,
    on_activate: Box<dyn Fn(String)>,
    suspended: Cell<bool>,
}

thread_local! {
    /// Only ever set on the main thread; the idle callbacks run there.
    static HANDLERS: RefCell<Option<Handlers>> = const { RefCell::new(None) };
}

enum Notice {
    /// logind's `PrepareForSleep(start)`.
    Sleep(bool),
    Activate(String),
}

/// Run the stored callback for `notice` on the main loop.
fn deliver(notice: Notice) {
    glib::idle_add_once(move || {
        HANDLERS.with(|h| {
            let Some(h) = &*h.borrow() else {
                return;
            };
            match notice {
                Notice::Sleep(start) => {
                    let (report, suspended) = rules::sleep_transition(h.suspended.get(), start);
                    h.suspended.set(suspended);
                    match report {
                        Some(true) => (h.on_sleep)(),
                        Some(false) => (h.on_wake)(),
                        None => {}
                    }
                }
                Notice::Activate(name) => (h.on_activate)(name),
            }
        });
    });
}

/// Observe sleep, wake and (on X11) application activation for the life of the
/// process. Must be called on the main thread.
pub fn observe_workspace(
    on_sleep: impl Fn() + 'static,
    on_wake: impl Fn() + 'static,
    on_activate: impl Fn(String) + 'static,
) {
    HANDLERS.with(|h| {
        *h.borrow_mut() = Some(Handlers {
            on_sleep: Box::new(on_sleep),
            on_wake: Box::new(on_wake),
            on_activate: Box::new(on_activate),
            suspended: Cell::new(false),
        })
    });
    let _ = std::thread::Builder::new()
        .name("kimochi-logind".into())
        .spawn(|| {
            if let Err(e) = watch_logind() {
                eprintln!("platform: sleep/wake notifications unavailable: {e}");
            }
        });
    if session().backend == Backend::X11 {
        let _ = std::thread::Builder::new()
            .name("kimochi-activation".into())
            .spawn(|| {
                if let Err(e) = watch_activation() {
                    eprintln!("platform: activation notifications unavailable: {e}");
                }
            });
    }
}

fn watch_logind() -> Result<(), String> {
    let conn = zbus::blocking::Connection::system().map_err(|e| e.to_string())?;
    let proxy = zbus::blocking::Proxy::new(
        &conn,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )
    .map_err(|e| e.to_string())?;
    for message in proxy
        .receive_signal("PrepareForSleep")
        .map_err(|e| e.to_string())?
    {
        if let Ok(start) = message.body().deserialize::<bool>() {
            deliver(Notice::Sleep(start));
        }
    }
    Err("logind signal stream ended".into())
}

fn watch_activation() -> Result<(), String> {
    let (conn, root) = x11::event_connection()?;
    let active_atom = conn
        .intern_atom(false, b"_NET_ACTIVE_WINDOW")
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .atom;
    conn.change_window_attributes(
        root,
        &ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE),
    )
    .map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())?;
    let mut last_pid = None;
    loop {
        match conn.wait_for_event().map_err(|e| e.to_string())? {
            Event::PropertyNotify(e) if e.window == root && e.atom == active_atom => {
                let Some(pid) = x11::frontmost_pid() else {
                    continue;
                };
                // Per application, not per window, as NSWorkspace reports it.
                if last_pid.replace(pid) == Some(pid) {
                    continue;
                }
                if let Some(name) = kimochi_capture::x11::process_name(pid) {
                    deliver(Notice::Activate(name));
                }
            }
            _ => {}
        }
    }
}
