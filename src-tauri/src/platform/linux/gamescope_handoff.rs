//! Steam-managed controls and the ICCCM activation handoff missing in Gamescope.
//! One-shot WM_TAKE_FOCUS on validated Wine input-owner transitions; no focus loop.
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, AtomicU32, Ordering},
    time::{Duration, Instant},
};
use x11rb::{
    connection::Connection,
    protocol::{
        xproto::{
            AtomEnum, ClientMessageEvent, ConnectionExt as _, CreateWindowAux, EventMask, PropMode,
            WindowClass,
        },
        Event,
    },
    rust_connection::RustConnection,
    wrapper::ConnectionExt as _,
};

static STARTED: AtomicBool = AtomicBool::new(false);
static LAST_GAME: AtomicU32 = AtomicU32::new(0);
/// The app Kimochi last put on the base layer (the game, or Kimochi itself); 0 once a pick
/// in Steam's own menu takes over.
static RETURNED: AtomicU32 = AtomicU32::new(0);
pub(super) fn own_id() -> Option<u32> {
    std::env::var("KIMOCHI_STEAM_APP_ID")
        .ok()?
        .parse()
        .ok()
        .filter(|v| *v != 0)
}
fn game(id: u32) -> bool {
    id != 0 && id != 769 && Some(id) != own_id()
}
struct Link {
    conn: RustConnection,
    root: u32,
    helper: u32,
    time_atom: u32,
    /// Interned once: this is polled ten times a second, and every intern is a round trip.
    atoms: std::cell::RefCell<HashMap<&'static [u8], u32>>,
}
impl Link {
    fn connect(name: &str) -> Result<Self, String> {
        let (conn, screen) = x11rb::connect(Some(name)).map_err(|e| e.to_string())?;
        let root = conn.setup().roots[screen].root;
        let helper = conn.generate_id().map_err(|e| e.to_string())?;
        conn.create_window(
            0,
            helper,
            root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
        )
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
        let time_atom = conn
            .intern_atom(false, b"KIMOCHI_SERVER_TIME")
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?
            .atom;
        Ok(Self {
            conn,
            root,
            helper,
            time_atom,
            atoms: Default::default(),
        })
    }
    fn atom(&self, name: &'static [u8]) -> Option<u32> {
        if let Some(atom) = self.atoms.borrow().get(name) {
            return Some(*atom);
        }
        let atom = self.conn.intern_atom(false, name).ok()?.reply().ok()?.atom;
        self.atoms.borrow_mut().insert(name, atom);
        Some(atom)
    }
    fn values(&self, window: u32, name: &'static [u8]) -> Option<Vec<u32>> {
        Some(
            self.conn
                .get_property(false, window, self.atom(name)?, AtomEnum::ANY, 0, 64)
                .ok()?
                .reply()
                .ok()?
                .value32()?
                .collect(),
        )
    }
    fn scalar(&self, window: u32, name: &'static [u8]) -> Option<u32> {
        self.values(window, name)?.first().copied()
    }
    fn display(&self, name: &'static [u8]) -> Option<String> {
        let bytes = self
            .values(self.root, name)?
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>();
        let text = String::from_utf8(bytes.split(|v| *v == 0).next()?.to_vec()).ok()?;
        let number = text.strip_prefix(':')?;
        (!number.is_empty() && number.bytes().all(|v| v.is_ascii_digit())).then_some(text)
    }
    fn timestamp(&self) -> Result<u32, String> {
        self.conn
            .change_property8(
                PropMode::REPLACE,
                self.helper,
                self.time_atom,
                AtomEnum::STRING,
                &[1],
            )
            .map_err(|e| e.to_string())?
            .check()
            .map_err(|e| e.to_string())?;
        self.conn.flush().map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_millis(200);
        while Instant::now() < deadline {
            if let Some(Event::PropertyNotify(event)) =
                self.conn.poll_for_event().map_err(|e| e.to_string())?
            {
                if event.window == self.helper && event.atom == self.time_atom {
                    return Ok(event.time);
                }
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        Err("X server timestamp timed out".into())
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Target {
    app: u32,
    display: String,
    window: u32,
}
fn coherent(
    input: Option<u32>,
    graphics: Option<u32>,
    window_app: Option<u32>,
    wine: bool,
    protocol: bool,
) -> bool {
    input.is_some_and(game) && input == graphics && input == window_app && wine && protocol
}
fn target(root: &Link, links: &mut HashMap<String, Link>) -> Option<Target> {
    let app = root.scalar(root.root, b"GAMESCOPE_FOCUSED_APP")?;
    let graphics = root.scalar(root.root, b"GAMESCOPE_FOCUSED_APP_GFX")?;
    if !game(app) || app != graphics {
        return None;
    }
    let name = root.display(b"GAMESCOPE_KEYBOARD_FOCUS_DISPLAY")?;
    if root.display(b"GAMESCOPE_MOUSE_FOCUS_DISPLAY")? != name {
        return None;
    }
    if !links.contains_key(&name) {
        links.insert(name.clone(), Link::connect(&name).ok()?);
    }
    let link = links.get(&name)?;
    let mut window = link.conn.get_input_focus().ok()?.reply().ok()?.focus;
    for _ in 0..16 {
        if window <= 1 || window == link.root {
            return None;
        }
        if let Some(window_app) = link.scalar(window, b"STEAM_GAME") {
            let wine = link.scalar(window, b"_WINE_HWND_STYLE").is_some();
            let protocols = link.values(window, b"WM_PROTOCOLS")?;
            let supported = protocols.contains(&link.atom(b"WM_TAKE_FOCUS")?);
            return coherent(Some(app), Some(graphics), Some(window_app), wine, supported)
                .then_some(Target {
                    app,
                    display: name,
                    window,
                });
        }
        let parent = link.conn.query_tree(window).ok()?.reply().ok()?.parent;
        if parent == window {
            return None;
        }
        window = parent;
    }
    None
}
#[derive(Debug, PartialEq, Eq)]
enum Steer { Keep, Reselect, Release }
/// Steam owns GAMESCOPECTRL_BASELAYER_APPID and rewrites it from its own running-app
/// list (`[…, <its app>, 769]`), which nothing outside Steam's UI can reorder
/// (steamui's `SetRunningApp` is only called from its own menus and launches). So after
/// Kimochi switches between itself and the game, a rewrite that swaps the two back while
/// Steam's UI did not have input (volume OSD, notifications) is stale: put ours back. A
/// pick made from Steam's menu, or of any third app, is the user's and ends the guard.
/// `game` is the game Kimochi last saw in front.
fn steer(returned: u32, own: Option<u32>, game: u32, order: &[u32], focusable: &[u32], steam_ui: bool) -> Steer {
    if returned == 0 { return Steer::Keep; }
    if !focusable.contains(&returned) { return Steer::Release; }
    let pick = order.iter().find(|id| focusable.contains(id)).copied();
    if pick == Some(returned) { return Steer::Keep; }
    let ours = own.is_some() && (pick == own || (Some(returned) == own && pick == Some(game)));
    if ours && !steam_ui { Steer::Reselect } else { Steer::Release }
}
pub(super) fn start() {
    if !super::gamescope::active() || STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        let root = match Link::connect(":0") {
            Ok(root) => root,
            Err(error) => {
                eprintln!("Gamescope handoff: {error}");
                return;
            }
        };
        let mut links = HashMap::new();
        let mut previous = None;
        let mut order = None;
        let mut steam_ui = false;
        loop {
            let current_order = root.values(root.root, b"GAMESCOPECTRL_BASELAYER_APPID");
            if current_order != order {
                let focusable = root.values(root.root, b"GAMESCOPE_FOCUSABLE_APPS").unwrap_or_default();
                let returned = RETURNED.load(Ordering::SeqCst);
                match steer(returned, own_id(), LAST_GAME.load(Ordering::SeqCst), current_order.as_deref().unwrap_or_default(), &focusable, steam_ui) {
                    Steer::Keep => {}
                    Steer::Release => RETURNED.store(0, Ordering::SeqCst),
                    Steer::Reselect => match select(returned) {
                        Ok(()) => eprintln!("Gamescope return: Steam rewrote the base layer outside its menu; kept app {returned}"),
                        Err(error) => eprintln!("Gamescope return: {error}"),
                    },
                }
                order = current_order;
            }
            steam_ui = root.scalar(root.root, b"GAMESCOPE_FOCUSED_APP") == Some(769);
            if let Some(id) = root
                .scalar(root.root, b"GAMESCOPE_FOCUSED_APP_GFX")
                .filter(|id| game(*id))
            {
                LAST_GAME.store(id, Ordering::SeqCst);
            }
            let current = target(&root, &mut links);
            if current != previous {
                if let Some(next) = &current {
                    let link = &links[&next.display];
                    let result = link.timestamp().and_then(|timestamp| {
                        if target(&root,&mut links).as_ref()!=Some(next) { return Ok(()); }
                        let link = &links[&next.display];
                        let event = ClientMessageEvent::new(32,next.window,link.atom(b"WM_PROTOCOLS").ok_or("WM_PROTOCOLS unavailable")?,
                            [link.atom(b"WM_TAKE_FOCUS").ok_or("WM_TAKE_FOCUS unavailable")?,timestamp,0,0,0]);
                        link.conn.send_event(false,next.window,EventMask::NO_EVENT,event).map_err(|e|e.to_string())?.check().map_err(|e|e.to_string())?;
                        link.conn.flush().map_err(|e|e.to_string())?;
                        eprintln!("Gamescope Wine focus handoff: app={} display={} window={} timestamp={timestamp}",next.app,next.display,next.window);
                        Ok(())
                    });
                    if let Err(error) = result {
                        eprintln!("Gamescope Wine focus handoff: {error}");
                    }
                }
                previous = current;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
}
pub(super) fn game_id() -> Option<u32> {
    let d = super::x11::desktop()?;
    let atom = d
        .conn
        .intern_atom(true, b"GAMESCOPE_FOCUSABLE_APPS")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let values = d.property32(d.root, atom, AtomEnum::CARDINAL)?;
    let last = LAST_GAME.load(Ordering::SeqCst);
    if game(last) && values.contains(&last) {
        return Some(last);
    }
    let mut games = values.into_iter().filter(|id| game(*id));
    let first = games.next()?;
    games.next().is_none().then_some(first)
}
fn priority(mut order: Vec<u32>, app: u32) -> Vec<u32> {
    order.retain(|id| *id != app);
    order.insert(0, app);
    order
}
/// Explicit app-switch action only. Steam's own later menu actions remain authoritative.
pub(super) fn select(app: u32) -> Result<(), String> {
    let d = super::x11::desktop().ok_or("Gamescope X connection unavailable")?;
    let atom = d
        .conn
        .intern_atom(false, b"GAMESCOPECTRL_BASELAYER_APPID")
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .atom;
    if own_id().is_some() { RETURNED.store(app, Ordering::SeqCst); }
    let order = priority(
        d.property32(d.root, atom, AtomEnum::CARDINAL)
            .unwrap_or_default(),
        app,
    );
    d.conn
        .change_property32(PropMode::REPLACE, d.root, atom, AtomEnum::CARDINAL, &order)
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    d.conn.flush().map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activation_requires_the_selected_wine_game() {
        assert!(coherent(
            Some(1244090),
            Some(1244090),
            Some(1244090),
            true,
            true
        ));
        for (input, graphics, window, wine, protocol) in [
            (Some(769), Some(1244090), Some(1244090), true, true),
            (Some(1244090), Some(769), Some(1244090), true, true),
            (Some(1244090), Some(1244090), None, true, true),
            (Some(1244090), Some(1244090), Some(1244090), false, true),
            (Some(1244090), Some(1244090), Some(1244090), true, false),
        ] {
            assert!(!coherent(input, graphics, window, wine, protocol));
        }
    }
    #[test]
    fn stale_steam_rewrite_cannot_raise_kimochi_over_the_returned_game() {
        let (own, game) = (Some(3826138355), 1244090);
        let focusable = [3826138355, 1244090, 769];
        let steam = [413091, 3826138355, 769];
        assert_eq!(steer(game, own, game, &steam, &focusable, false), Steer::Reselect);
        assert_eq!(steer(game, own, game, &[game, 413091, 3826138355, 769], &focusable, false), Steer::Keep);
        // Chosen in Steam's menu, another app or Home, the game gone, or no return pending.
        assert_eq!(steer(game, own, game, &steam, &focusable, true), Steer::Release);
        assert_eq!(steer(game, own, game, &[413091, 769], &focusable, false), Steer::Release);
        assert_eq!(steer(game, own, game, &steam, &[3826138355, 769], false), Steer::Release);
        assert_eq!(steer(0, own, game, &steam, &focusable, false), Steer::Keep);
        assert_eq!(steer(game, None, game, &steam, &focusable, false), Steer::Release);
    }
    #[test]
    fn stale_steam_rewrite_cannot_put_the_game_back_over_kimochi() {
        let (own, game) = (3826138355, 1244090);
        let focusable = [own, game, 769];
        let steam = [413091, game, 769];
        assert_eq!(steer(own, Some(own), game, &steam, &focusable, false), Steer::Reselect);
        assert_eq!(steer(own, Some(own), game, &[own, 413091, game, 769], &focusable, false), Steer::Keep);
        // Chosen in Steam's menu, or a third app, is the user's.
        assert_eq!(steer(own, Some(own), game, &steam, &focusable, true), Steer::Release);
        assert_eq!(steer(own, Some(own), game, &[42, 769], &[own, game, 42, 769], false), Steer::Release);
    }
    #[test]
    fn explicit_switch_preserves_other_app_priorities_without_duplicates() {
        assert_eq!(
            priority(vec![413091, 769, 123, 42], 42),
            vec![42, 413091, 769, 123]
        );
    }
}
