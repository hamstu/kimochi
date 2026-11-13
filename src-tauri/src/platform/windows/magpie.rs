//! Magpie, the window scaler (see `platform::scaler` for what a scaler does to an overlay).
//!
//! Read through Magpie's documented integration surface ("Interact with Magpie programmatically"
//! in its docs), nothing else:
//!
//!  - while it scales there is exactly one window of class `CLASS`, and once it is visible its
//!    properties `Magpie.SrcHWND`, `Magpie.Windowed`, `Magpie.Src*` and `Magpie.Dest*` describe the
//!    session, in physical desktop pixels (Kimochi is Per-Monitor-V2 aware, so they are ours);
//!  - it broadcasts the registered message `MagpieScalingChanged` when scaling starts or stops,
//!    when the game comes to the front or goes behind, and when a windowed session moves.
//!
//! One behaviour is read from Magpie's source rather than its docs (`CursorManager.cpp`, checked
//! against v0.12 and v0.13): while the game has the mouse, Magpie moves the real cursor onto the
//! game's own (hidden, unscaled) window, draws a copy of it on the picture, and marks its scaling
//! window `WS_EX_TRANSPARENT` so clicks fall through to the game. `GetCursorPos` then answers in the
//! game's coordinates, so `shown_cursor` maps it back to where the reader sees it. When the cursor
//! reaches a window above the picture that takes the mouse (an overlay word under the pointer, a
//! dictionary pop-up), Magpie lets go: it clears the style and puts the cursor there for real. The
//! cursor poll makes Kimochi's windows take the mouse exactly where the shown cursor is over them,
//! so this hand-over is all the integration clicking needs.
//!
//! Kimochi never changes Magpie's windows, moves the cursor, or sends Magpie anything.
use super::super::scaler::{Edges, Scaling};
use super::{hwnd_from, rect_of};
use std::cell::RefCell;
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    ChangeWindowMessageFilterEx, CreateWindowExW, DefWindowProcW, FindWindowW, GetPropW, GetWindowLongW, GetWindowRect,
    IsWindowVisible, RegisterClassExW, RegisterWindowMessageW, GWL_EXSTYLE, MSGFLT_ALLOW, WINDOW_STYLE, WNDCLASSEXW,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

/// The scaling window's class, which Magpie promises never to change.
const CLASS: PCWSTR = w!("Window_Magpie_967EB565-6F73-4E94-AE53-00CC42592A22");

/// A scaling session: Magpie's window, the game window it scales, and the geometry.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Session {
    pub window: usize,
    pub source: usize,
    pub scaling: Scaling,
}

impl Session {
    pub fn hwnd(&self) -> HWND {
        hwnd_from(self.window)
    }

    /// Magpie has handed the mouse to the game: the cursor is over the game's real window.
    pub fn captured(&self) -> bool {
        style(self.hwnd()) & WS_EX_TRANSPARENT.0 != 0
    }

    /// In the topmost band, which Magpie joins while the game it scales is in front.
    pub fn topmost(&self) -> bool {
        style(self.hwnd()) & WS_EX_TOPMOST.0 != 0
    }

    pub fn report(&self) -> serde_json::Value {
        let r = |e: Edges| [e.left, e.top, e.right, e.bottom];
        serde_json::json!({
            "window": self.window,
            "source": self.source,
            "windowed": self.scaling.windowed,
            "src": r(self.scaling.src),
            "dest": r(self.scaling.dest),
            "surface": r(self.scaling.surface),
            "captured": self.captured(),
            "topmost": self.topmost(),
        })
    }
}

fn style(hwnd: HWND) -> u32 {
    unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 }
}

/// One property, as Magpie stores it: an `INT_PTR` holding a signed 32-bit coordinate.
fn prop(hwnd: HWND, name: PCWSTR) -> isize {
    unsafe { GetPropW(hwnd, name) }.0 as isize
}

fn coord(hwnd: HWND, name: PCWSTR) -> f64 {
    f64::from(prop(hwnd, name) as i32)
}

/// The live session, read from the window server. The properties are only guaranteed once the
/// window is visible, so an invisible one is not a session yet.
fn read() -> Option<Session> {
    let hwnd = unsafe { FindWindowW(CLASS, PCWSTR::null()) }.ok()?;
    if hwnd.is_invalid() || !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return None;
    }
    let source = prop(hwnd, w!("Magpie.SrcHWND")) as usize;
    if source == 0 {
        return None;
    }
    let mut surface = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut surface) }.ok()?;
    let scaling = Scaling {
        src: Edges {
            left: coord(hwnd, w!("Magpie.SrcLeft")),
            top: coord(hwnd, w!("Magpie.SrcTop")),
            right: coord(hwnd, w!("Magpie.SrcRight")),
            bottom: coord(hwnd, w!("Magpie.SrcBottom")),
        },
        dest: Edges {
            left: coord(hwnd, w!("Magpie.DestLeft")),
            top: coord(hwnd, w!("Magpie.DestTop")),
            right: coord(hwnd, w!("Magpie.DestRight")),
            bottom: coord(hwnd, w!("Magpie.DestBottom")),
        },
        surface: Edges::of(rect_of(surface)),
        windowed: prop(hwnd, w!("Magpie.Windowed")) != 0,
    };
    scaling.usable().then_some(Session { window: hwnd.0 as usize, source, scaling })
}

/// How long a read is reused. The cursor poll asks 60–120 times a second; a session's geometry
/// changes when it starts, stops or (windowed) moves, and each of those is broadcast, which drops
/// the cached read at once (`forget`).
const FRESH: Duration = Duration::from_millis(100);

static CACHE: Mutex<Option<(Instant, Option<Session>)>> = Mutex::new(None);

/// The current session, if Magpie is scaling anything.
pub fn session() -> Option<Session> {
    let mut cache = CACHE.lock().unwrap();
    if let Some((at, session)) = *cache {
        if at.elapsed() < FRESH {
            return session;
        }
    }
    let session = read();
    *cache = Some((Instant::now(), session));
    session
}

/// The last read, without reading again or waiting: for the low-level mouse hook, which must not
/// block. `None` while another thread holds the cache, which costs one press its projection.
pub fn cached() -> Option<Session> {
    CACHE.try_lock().ok().and_then(|cache| cache.and_then(|(_, session)| session))
}

/// The session scaling `window`, if Magpie is scaling that one.
pub fn scaling(window: HWND) -> Option<Session> {
    session().filter(|session| session.source == window.0 as usize)
}

/// The current session for logs and bug reports; null while Magpie scales nothing.
pub fn report() -> serde_json::Value {
    session().map_or(serde_json::Value::Null, |session| session.report())
}

fn forget() {
    *CACHE.lock().unwrap() = None;
}

/// The cursor as the previous sample reported it, and whether Magpie had it then.
static LAST_CURSOR: Mutex<Option<(bool, (f64, f64))>> = Mutex::new(None);

/// Where the reader sees the cursor that `GetCursorPos` reports at `real`.
///
/// While Magpie has handed the mouse to the game, that is `real` mapped onto the picture. Magpie
/// changes its window's style a moment before it moves the cursor (to the game, or back to the
/// picture), so a sample taken in between would pair the new style with the old position and jump
/// across the screen; the sample where the two disagree with the previous one repeats the previous
/// answer instead.
pub fn shown_cursor(real: (f64, f64)) -> (f64, f64) {
    let Some(session) = session() else {
        *LAST_CURSOR.lock().unwrap() = None;
        return real;
    };
    let captured = session.captured() && session.scaling.in_src(real);
    let shown = if captured { session.scaling.show_cursor(real) } else { real };
    let mut last = LAST_CURSOR.lock().unwrap();
    let answer = match *last {
        Some((was, previous)) if was != captured => previous,
        _ => shown,
    };
    *last = Some((captured, shown));
    answer
}

/// `shown_cursor` for a press the mouse hook sees: no waiting, no history. `None` when the press
/// is not one Magpie is handing to the game.
pub fn shown_press(real: (f64, f64)) -> Option<(f64, f64)> {
    let session = cached()?;
    (session.captured() && session.scaling.in_src(real)).then(|| session.scaling.show_cursor(real))
}

/// What a `MagpieScalingChanged` broadcast says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    /// Scaling ended.
    Stopped,
    /// The game went behind another window; scaling goes on underneath.
    Behind,
    /// Scaling started, or the game came back to the front: Magpie has just put its window at the
    /// top of the topmost band, over Kimochi's.
    Front,
    /// A windowed session moved or was resized.
    Moved,
    /// The reader started dragging or resizing a windowed session.
    Moving,
}

impl Change {
    fn of(event: usize, detail: isize) -> Option<Change> {
        match (event, detail) {
            (0, 0) => Some(Change::Stopped),
            (0, _) => Some(Change::Behind),
            (1, _) => Some(Change::Front),
            (2, _) => Some(Change::Moved),
            (3, _) => Some(Change::Moving),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Change::Stopped => "stopped",
            Change::Behind => "behind",
            Change::Front => "front",
            Change::Moved => "moved",
            Change::Moving => "moving",
        }
    }
}

static MESSAGE: AtomicU32 = AtomicU32::new(0);

/// What `watch` was given, called on the main thread for each broadcast.
type OnChange = Box<dyn Fn(Change)>;

thread_local! {
    static ON_CHANGE: RefCell<Option<OnChange>> = const { RefCell::new(None) };
}

/// Hear Magpie's broadcasts for the life of the process. Call once, on the main thread: the
/// listening window is created there and tao's message loop delivers to it, so `on_change` runs
/// on the main thread too, where Kimochi's windows can be reordered at once.
///
/// A broadcast reaches top-level windows only, so this is a hidden top-level window, not a
/// message-only one. Magpie may run elevated or not; a message from a lower integrity level is
/// filtered out unless the window allows it (`ChangeWindowMessageFilterEx`), as Magpie's docs say.
pub fn watch(on_change: impl Fn(Change) + 'static) {
    let message = unsafe { RegisterWindowMessageW(w!("MagpieScalingChanged")) };
    if message == 0 {
        eprintln!("platform: Magpie notifications unavailable");
        return;
    }
    MESSAGE.store(message, Ordering::Relaxed);
    ON_CHANGE.with(|slot| *slot.borrow_mut() = Some(Box::new(on_change)));
    unsafe {
        let instance = GetModuleHandleW(None).ok().map(|m| m.into());
        let class = w!("KimochiScalerWatch");
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(watch_proc),
            hInstance: instance.unwrap_or_default(),
            lpszClassName: class,
            ..Default::default()
        };
        RegisterClassExW(&wc);
        // Never shown; tool window and no-activate so nothing could ever list or focus it.
        match CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class,
            w!(""),
            WINDOW_STYLE(WS_POPUP.0),
            0,
            0,
            0,
            0,
            None,
            None,
            instance,
            None,
        ) {
            // Leaked on purpose: it lives as long as the process.
            Ok(hwnd) => {
                let _ = ChangeWindowMessageFilterEx(hwnd, message, MSGFLT_ALLOW, None);
            }
            Err(e) => eprintln!("platform: Magpie notifications unavailable: {e}"),
        }
    }
}

unsafe extern "system" fn watch_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let message = MESSAGE.load(Ordering::Relaxed);
    if message != 0 && msg == message {
        forget();
        if let Some(change) = Change::of(wparam.0, lparam.0) {
            ON_CHANGE.with(|slot| {
                if let Some(on_change) = slot.borrow().as_ref() {
                    on_change(change);
                }
            });
        }
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::Change;

    #[test]
    fn broadcasts_are_read_as_magpie_documents_them() {
        assert_eq!(Change::of(0, 0), Some(Change::Stopped));
        assert_eq!(Change::of(0, 1), Some(Change::Behind));
        assert_eq!(Change::of(1, 0x1234), Some(Change::Front));
        assert_eq!(Change::of(2, 0x1234), Some(Change::Moved));
        assert_eq!(Change::of(3, 0x1234), Some(Change::Moving));
        assert_eq!(Change::of(9, 0), None);
    }
}
