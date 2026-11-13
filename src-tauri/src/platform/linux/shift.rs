//! Shift (and the other modifiers) on Wayland, for the overlay's pointer feed (`super::cursor`).
//!
//! A layer-shell overlay never has the keyboard, and nothing may take Shift from the game, so the
//! state comes from a source that only watches:
//!
//! - **KDE Plasma**: KWin hands XWayland the modifier keys whichever window has the keyboard
//!   ("Legacy X11 App Support" in System Settings, `[Xwayland] XwaylandEavesdrops` in kwinrc; on by
//!   default in Plasma 6, where the default is `Combinations`). Any X11 connection then reads them
//!   from `QueryPointer`'s mask, as on an X11 session. The game still gets every key.
//! - **Hyprland**: two non-consuming portal bindings on `Shift_L`/`Shift_R` (`shortcuts.rs`), whose
//!   edges land here through [`portal_shift`], once one has arrived (Hyprland fires only the
//!   bindings its config names).
//!
//! Anywhere else there is no source and the overlay keeps taking the mouse over its text.
use super::super::Modifiers;
use super::rules;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt as _, Window};
use x11rb::rust_connection::RustConnection;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// KWin's XWayland modifier relay, read over an X11 connection.
    XWayland,
    /// Hyprland's portal Shift bindings.
    Portal,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::XWayland => "xwayland",
            Source::Portal => "portal",
        }
    }
}

/// The portal confirmed the two Shift bindings (Hyprland).
static PORTAL_BOUND: AtomicBool = AtomicBool::new(false);
/// A Shift press has arrived through them. Hyprland only fires a portal binding the user has
/// also put in their Hyprland config, so a bound pair proves nothing until it does.
static PORTAL_SEEN: AtomicBool = AtomicBool::new(false);
/// Either portal Shift binding is down.
static PORTAL_HELD: AtomicBool = AtomicBool::new(false);

/// The portal bound (or dropped) the Shift bindings.
pub fn portal_bound(bound: bool) {
    PORTAL_BOUND.store(bound, Ordering::SeqCst);
    if !bound {
        PORTAL_HELD.store(false, Ordering::SeqCst);
    }
}

/// A portal Shift binding's edge: whether any Shift is held now. True the first time a press
/// arrives, when the source has just become usable (capabilities change).
pub fn portal_shift(held: bool) -> bool {
    PORTAL_HELD.store(held, Ordering::SeqCst);
    held && !PORTAL_SEEN.swap(true, Ordering::SeqCst)
}

fn kde() -> bool {
    super::session().compositor.as_deref() == Some("KDE")
}

/// Where Shift comes from in this session, if anywhere. Cheap: asked at the pointer poll's rate.
pub fn source() -> Option<Source> {
    if std::env::var_os("KIMOCHI_WAYLAND_SHIFT").is_some_and(|v| v == "0") {
        return None;
    }
    if kde() {
        return (eavesdrops() && xwayland().is_some()).then_some(Source::XWayland);
    }
    (PORTAL_BOUND.load(Ordering::SeqCst) && PORTAL_SEEN.load(Ordering::SeqCst)).then_some(Source::Portal)
}

/// The held modifiers and whether the primary button is down (only known over an X11 window; else
/// `false`). `None` when this session has no source or it failed just now.
pub fn read() -> Option<(Modifiers, bool)> {
    match source()? {
        Source::Portal => {
            Some((Modifiers { shift: PORTAL_HELD.load(Ordering::SeqCst), ..Modifiers::default() }, false))
        }
        Source::XWayland => {
            let mut slot = XWAYLAND.lock().ok()?;
            let (conn, root) = slot.connection.as_ref()?;
            match conn.query_pointer(*root).ok().and_then(|cookie| cookie.reply().ok()) {
                Some(reply) => {
                    let held = rules::held_state(u16::from(reply.mask));
                    Some((
                        Modifiers { shift: held.shift, ctrl: held.ctrl, alt: held.alt, meta: held.meta },
                        held.primary,
                    ))
                }
                None => {
                    // XWayland went away (restarted with the session, or killed): reconnect later.
                    slot.connection = None;
                    slot.tried = Some(Instant::now());
                    None
                }
            }
        }
    }
}

struct XWayland {
    connection: Option<(RustConnection, Window)>,
    /// When a connection was last attempted; retried every [`RETRY`].
    tried: Option<Instant>,
}

static XWAYLAND: Mutex<XWayland> = Mutex::new(XWayland { connection: None, tried: None });
const RETRY: Duration = Duration::from_secs(5);

/// An X11 connection to the session's XWayland, opened on first use (which also starts XWayland
/// where KWin runs it on demand). `Some(())` while one is open.
fn xwayland() -> Option<()> {
    let mut slot = XWAYLAND.lock().ok()?;
    if slot.connection.is_some() {
        return Some(());
    }
    if slot.tried.is_some_and(|at| at.elapsed() < RETRY) {
        return None;
    }
    slot.tried = Some(Instant::now());
    std::env::var_os("DISPLAY")?;
    match x11rb::connect(None) {
        Ok((conn, screen)) => {
            let root = conn.setup().roots.get(screen)?.root;
            slot.connection = Some((conn, root));
            Some(())
        }
        Err(error) => {
            eprintln!("Wayland Shift: XWayland unreachable: {error}");
            None
        }
    }
}

/// Whether KWin relays the modifier keys to XWayland: the user's kwinrc, else the system's, else
/// KWin's own default (its kcfg), else Plasma 6's default.
fn eavesdrops() -> bool {
    static CACHE: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
    let Ok(mut cache) = CACHE.lock() else { return false };
    if let Some((at, value)) = *cache {
        if at.elapsed() < RETRY {
            return value;
        }
    }
    let value = read_eavesdrops();
    *cache = Some((Instant::now(), value));
    value
}

fn read_eavesdrops() -> bool {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let user = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| home.map(|h| h.join(".config")));
    let system = std::env::var("XDG_CONFIG_DIRS").unwrap_or_else(|_| "/etc/xdg".into());
    let files = user.into_iter().chain(system.split(':').filter(|d| !d.is_empty()).map(PathBuf::from));
    for dir in files {
        if let Ok(text) = std::fs::read_to_string(dir.join("kwinrc")) {
            if let Some(mode) = ini_value(&text, "Xwayland", "XwaylandEavesdrops") {
                return mode_relays_modifiers(&mode);
            }
        }
    }
    for dir in ["/usr/share/config.kcfg", "/usr/local/share/config.kcfg"] {
        if let Ok(text) = std::fs::read_to_string(format!("{dir}/kwin.kcfg")) {
            if let Some(mode) = kcfg_default(&text, "XwaylandEavesdrops") {
                return mode_relays_modifiers(&mode);
            }
        }
    }
    std::env::var("KDE_SESSION_VERSION").is_ok_and(|v| v.trim().parse::<u32>().is_ok_and(|v| v >= 6))
}

/// `None` keeps every key from XWayland; the other modes (`Modifiers`, `Combinations`, `All`) all
/// include the modifier keys.
fn mode_relays_modifiers(mode: &str) -> bool {
    !mode.trim().eq_ignore_ascii_case("none")
}

/// One `key=value` of a KConfig file (`[Group]` headers, `key[$i]=` markers allowed).
fn ini_value(text: &str, group: &str, key: &str) -> Option<String> {
    let mut inside = false;
    let mut found = None;
    for line in text.lines().map(str::trim) {
        if let Some(header) = line.strip_prefix('[') {
            inside = header.split(']').next() == Some(group);
            continue;
        }
        if !inside {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else { continue };
        let name = name.trim();
        let name = name.split_once('[').map_or(name, |(n, _)| n).trim();
        if name == key {
            found = Some(value.trim().to_owned());
        }
    }
    found
}

/// The `<default>` of one `<entry name="…">` in a kcfg file.
fn kcfg_default(text: &str, entry: &str) -> Option<String> {
    let start = text.find(&format!("name=\"{entry}\""))?;
    let rest = &text[start..];
    let end = rest.find("</entry>").unwrap_or(rest.len());
    let body = &rest[..end];
    let open = body.find("<default>")? + "<default>".len();
    let close = body[open..].find("</default>")? + open;
    Some(body[open..close].trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_eavesdrop_mode() {
        let rc = "[Plugins]\nblurEnabled=true\n\n[Xwayland]\nScale=1\nXwaylandEavesdrops=None\n";
        assert_eq!(ini_value(rc, "Xwayland", "XwaylandEavesdrops").as_deref(), Some("None"));
        assert!(!mode_relays_modifiers("None"));
        assert!(mode_relays_modifiers("Modifiers"));
        assert!(mode_relays_modifiers("Combinations"));
        assert_eq!(
            ini_value("[Xwayland][$i]\nXwaylandEavesdrops[$i]=All\n", "Xwayland", "XwaylandEavesdrops").as_deref(),
            Some("All")
        );
        assert_eq!(ini_value("[Other]\nXwaylandEavesdrops=None\n", "Xwayland", "XwaylandEavesdrops"), None);
    }

    #[test]
    fn reads_kwins_default() {
        let kcfg = r#"<entry name="XwaylandEavesdrops" type="Enum">
            <choices><choice name="None"/><choice name="Combinations"/></choices>
            <default>Combinations</default>
        </entry>
        <entry name="XwaylandEavesdropsMouse" type="Bool"><default>false</default></entry>"#;
        assert_eq!(kcfg_default(kcfg, "XwaylandEavesdrops").as_deref(), Some("Combinations"));
        assert_eq!(kcfg_default(kcfg, "XwaylandEavesdropsMouse").as_deref(), Some("false"));
    }
}
