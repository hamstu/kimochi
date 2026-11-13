//! Temporary main-window geometry. Never persist the compact frame or forced pin.
use kimochi_capture::Rect;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{Emitter, Manager};

struct Saved {
    bounds: Rect,
    pinned: bool,
    maximized: bool,
    #[cfg(target_os = "macos")]
    mac: MacFrame,
}
static SAVED: Mutex<Option<Saved>> = Mutex::new(None);
#[cfg(target_os = "windows")]
static CROP_VISIBLE: Mutex<bool> = Mutex::new(false);
static ACTIVE: AtomicBool = AtomicBool::new(false);
static PIN_PENDING: AtomicBool = AtomicBool::new(false);

/// The setting that turns on mini mode when the source goes full screen. Off by default: a
/// reader with Kimochi on another monitor saw it shrink whenever a game went full screen.
pub const AUTO_MINI: &str = "autoMiniMode";

/// What a full-screen episode of the source asks of the main window: nothing, mini mode, or to
/// be kept over the game (pinned) without changing size.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Want {
    Nothing,
    Mini,
    Over,
}

/// One full-screen episode of the watched source. Mini mode is entered once per episode (an
/// expand by hand is respected); keeping Kimochi over the game lasts while the game is full screen
/// on Kimochi's display, unless the reader unpins it by hand.
#[derive(Default)]
struct AutoMini {
    source: String,
    entered: bool,
    /// The reader unpinned Kimochi during this episode: leave it unpinned.
    declined: bool,
}

impl AutoMini {
    /// `same_display`: the main window is on the display the source fills.
    fn observe(
        &mut self,
        source: &str,
        fullscreen: bool,
        on_screen: bool,
        settling: bool,
        same_display: bool,
        auto_mini: bool,
    ) -> Want {
        if self.source != source {
            self.source = source.to_owned();
            self.entered = false;
            self.declined = false;
        }
        if !fullscreen {
            self.entered = false;
            self.declined = false;
            return Want::Nothing;
        }
        if !on_screen || settling || !same_display {
            return Want::Nothing;
        }
        if auto_mini {
            if self.entered {
                return Want::Nothing;
            }
            self.entered = true;
            return Want::Mini;
        }
        if self.declined {
            Want::Nothing
        } else {
            Want::Over
        }
    }
}

static AUTO: Mutex<AutoMini> = Mutex::new(AutoMini { source: String::new(), entered: false, declined: false });

/// What keeping Kimochi over a full-screen game changed, to undo when it ends.
struct Over {
    pinned: bool,
    #[cfg(target_os = "macos")]
    mac: MacFrame,
}
static OVER: Mutex<Option<Over>> = Mutex::new(None);
static OVER_ACTIVE: AtomicBool = AtomicBool::new(false);
/// A main-thread check already queued, so the 10 Hz watch never stacks them.
static CHECK_PENDING: AtomicBool = AtomicBool::new(false);

/// The source stopped being watched: whatever its full screen asked of the main window ends.
pub fn forget_source(app: &tauri::AppHandle) {
    *AUTO.lock().unwrap() = AutoMini::default();
    if OVER_ACTIVE.load(Ordering::Relaxed) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(window) = handle.get_webview_window(crate::panels::MAIN) {
                let _ = set_over(&window, false);
            }
        });
    }
}

/// Whether the main window is kept over a full-screen game (mini mode, or pinned over it).
#[cfg(target_os = "windows")]
pub fn over_fullscreen() -> bool {
    active() || OVER_ACTIVE.load(Ordering::Relaxed)
}

/// The reader pinned or unpinned the main window by hand while it was kept over the game: their
/// choice stands, and nothing is undone later.
pub fn pinned_by_hand(window: &tauri::WebviewWindow) {
    if !OVER_ACTIVE.load(Ordering::Relaxed) {
        return;
    }
    AUTO.lock().unwrap().declined = true;
    #[cfg(target_os = "macos")]
    if let Some(over) = OVER.lock().unwrap().as_ref() {
        let _ = mac_mini(window, Some(&over.mac));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    OVER.lock().unwrap().take();
    OVER_ACTIVE.store(false, Ordering::Relaxed);
}

/// Keep the main window over a full-screen game, pinned and (on macOS) on its Space, or put it
/// back as it was. Never persisted; a no-op while mini mode, which does the same and more, is on.
fn set_over(window: &tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    let mut over = OVER.lock().unwrap();
    if enabled == over.is_some() || (enabled && active()) {
        return Ok(());
    }
    if enabled {
        let pinned = window.is_always_on_top().map_err(|e| e.to_string())?;
        *over = Some(Over {
            pinned,
            #[cfg(target_os = "macos")]
            mac: mac_mini(window, None)?,
        });
        OVER_ACTIVE.store(true, Ordering::Relaxed);
        window.set_always_on_top(true).map_err(|e| e.to_string())?;
    } else if let Some(previous) = over.take() {
        OVER_ACTIVE.store(false, Ordering::Relaxed);
        #[cfg(target_os = "macos")]
        mac_mini(window, Some(&previous.mac))?;
        window.set_always_on_top(previous.pinned).map_err(|e| e.to_string())?;
    }
    let pinned = enabled || over.is_some() || window.is_always_on_top().unwrap_or(false);
    let _ = window.emit("panel:state", serde_json::json!({ "label": crate::panels::MAIN, "pinned": pinned }));
    Ok(())
}

/// Whether the main window's centre is on `display`.
fn on_display(window: &tauri::WebviewWindow, display: Option<kimochi_capture::Rect>) -> bool {
    let (Some(display), Ok(bounds)) = (display, crate::platform::desktop_bounds(window)) else {
        return false;
    };
    let (x, y) = (bounds.x + bounds.width / 2., bounds.y + bounds.height / 2.);
    x >= display.x && y >= display.y && x < display.x + display.width && y < display.y + display.height
}

pub fn observe_source(
    app: &tauri::AppHandle,
    service: &crate::state::Shared,
    source: &str,
    state: &crate::platform::WindowState,
) {
    // Nothing to decide outside full screen unless something is to be undone.
    if !state.fullscreen && !OVER_ACTIVE.load(Ordering::Relaxed) {
        AUTO.lock().unwrap().observe(source, false, false, false, false, false);
        return;
    }
    // Where the main window is takes the main thread; one check at a time is plenty.
    if CHECK_PENDING.swap(true, Ordering::Relaxed) {
        return;
    }
    let source = source.to_owned();
    let state = *state;
    let handle = app.clone();
    let service = service.clone();
    let queued = app.run_on_main_thread(move || {
        CHECK_PENDING.store(false, Ordering::Relaxed);
        let Some(window) = handle.get_webview_window(crate::panels::MAIN) else {
            return;
        };
        // A selection change can overtake this queued main-thread turn.
        if service.watching.lock().unwrap().as_deref() != Some(source.as_str()) {
            return;
        }
        let same_display = on_display(&window, state.display);
        let auto_mini = service.settings.get_or(AUTO_MINI, false);
        let want = AUTO.lock().unwrap().observe(
            &source,
            state.fullscreen,
            state.on_screen,
            state.settling,
            same_display,
            auto_mini,
        );
        let (result, check) = match want {
            Want::Mini => {
                let _ = set_over(&window, false);
                let result = set(&window, true);
                crate::tray::sync_mini(&handle);
                (result, "mini-fullscreen")
            }
            Want::Over => (set_over(&window, true), "over-fullscreen"),
            // The episode is over, Kimochi left the game's display, or the reader declined:
            // put the pin back as it was.
            Want::Nothing => (set_over(&window, false), "over-fullscreen-ended"),
        };
        if want != Want::Nothing || result.is_err() {
            crate::record(
                &handle,
                &service,
                serde_json::json!({
                    "check": check, "sourceId": source, "error": result.err(),
                }),
            );
        }
    });
    if queued.is_err() {
        CHECK_PENDING.store(false, Ordering::Relaxed);
    }
}

pub fn maintain_pin(app: &tauri::AppHandle) {
    if !active() || PIN_PENDING.swap(true, Ordering::Relaxed) {
        return;
    }
    let handle = app.clone();
    if app
        .run_on_main_thread(move || {
            if active() {
                if let Some(window) = handle.get_webview_window(crate::panels::MAIN) {
                    if !window.is_always_on_top().unwrap_or(false) {
                        let _ = window.set_always_on_top(true);
                    }
                }
            }
            PIN_PENDING.store(false, Ordering::Relaxed);
        })
        .is_err()
    {
        PIN_PENDING.store(false, Ordering::Relaxed);
    }
}

pub fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

pub fn set(window: &tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    let mut saved = SAVED.lock().unwrap();
    if enabled == saved.is_some() {
        return Ok(());
    }
    if enabled {
        // Pinned over the game already: mini mode does that and more, and keeps the pin to undo.
        let _ = set_over(window, false);
        let bounds = crate::platform::desktop_bounds(window)?;
        *saved = Some(Saved {
            bounds,
            pinned: window.is_always_on_top().map_err(|e| e.to_string())?,
            maximized: window.is_maximized().map_err(|e| e.to_string())?,
            #[cfg(target_os = "macos")]
            mac: mac_mini(window, None)?,
        });
        ACTIVE.store(true, Ordering::Relaxed);
        window.unmaximize().map_err(|e| e.to_string())?;
        window.set_min_size(Some(tauri::LogicalSize::new(280., 200.))).map_err(|e| e.to_string())?;
        window.set_always_on_top(true).map_err(|e| e.to_string())?;
        crate::platform::desktop_place(
            window,
            crate::platform::clamp_to_visible(Rect { width: 320., height: 560., ..bounds }),
        )?;
    } else if let Some(previous) = saved.as_ref() {
        let spec = crate::panels::spec(crate::panels::MAIN).ok_or("main panel unavailable")?;
        window
            .set_min_size(Some(tauri::LogicalSize::new(spec.min_width, spec.min_height)))
            .map_err(|e| e.to_string())?;
        window.set_always_on_top(previous.pinned).map_err(|e| e.to_string())?;
        crate::platform::desktop_place(window, crate::platform::clamp_to_visible(previous.bounds))?;
        if previous.maximized {
            window.maximize().map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "macos")]
        mac_mini(window, Some(&previous.mac))?;
        saved.take();
        ACTIVE.store(false, Ordering::Relaxed);
    }
    let _ = window.emit("main:mini", enabled);
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn crop(app: &tauri::AppHandle, editing: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window(crate::panels::MAIN) else {
        return Ok(());
    };
    let mut restore = CROP_VISIBLE.lock().unwrap();
    if editing {
        if !*restore && window.is_visible().map_err(|e| e.to_string())? {
            window.hide().map_err(|e| e.to_string())?;
            *restore = true;
        }
    } else if *restore {
        // Native non-activating show: do not steal focus back from the game.
        crate::platform::order_front(&window)?;
        *restore = false;
    }
    Ok(())
}

/// What mini mode changes on the main window's `NSWindow`, kept to undo on expand.
#[cfg(target_os = "macos")]
struct MacFrame {
    behavior: usize,
    class: &'static objc2::runtime::AnyClass,
    style: usize,
}

/// `NSWindowStyleMaskNonactivatingPanel`, as in `platform::make_panel`.
#[cfg(target_os = "macos")]
const NONACTIVATING_PANEL: usize = 1 << 7;

// Mini mode must show over the source's full-screen Space. Only a non-activating `NSPanel`
// of a background app is drawn over another app's full-screen window, so mini mode re-classes
// the main window into one (the same in-place technique as `platform::make_panel`, with the
// same size guard) and joins every Space. Expand restores the exact class, style and behavior.
#[cfg(target_os = "macos")]
fn mac_mini(window: &tauri::WebviewWindow, restore: Option<&MacFrame>) -> Result<MacFrame, String> {
    use objc2::runtime::AnyObject;
    use objc2::ClassType;
    use objc2_app_kit::{NSPanel, NSWindow, NSWindowCollectionBehavior as Behavior, NSWindowStyleMask};
    objc2::MainThreadMarker::new().ok_or("Mini mode requires the main thread")?;
    unsafe {
        let native = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        let current = MacFrame {
            behavior: (*native).collectionBehavior().0,
            class: (*(native as *mut AnyObject)).class(),
            style: (*native).styleMask().0,
        };
        if let Some(previous) = restore {
            if current.class != previous.class {
                objc2::ffi::object_setClass(native as *mut AnyObject, previous.class);
            }
            (*native).setStyleMask(NSWindowStyleMask(previous.style));
            (*native).setCollectionBehavior(Behavior(previous.behavior));
            return Ok(current);
        }
        let original = Behavior(current.behavior);
        (*native).setCollectionBehavior(
            (original - Behavior::MoveToActiveSpace - Behavior::FullScreenPrimary)
                | Behavior::CanJoinAllSpaces
                | Behavior::FullScreenAuxiliary,
        );
        let panel = NSPanel::class();
        if std::env::var_os("KIMOCHI_NO_PANEL").is_none()
            && current.class != panel
            && panel.instance_size() <= current.class.instance_size()
        {
            objc2::ffi::object_setClass(native as *mut AnyObject, panel);
            (*native).setStyleMask(NSWindowStyleMask(current.style | NONACTIVATING_PANEL));
            // On by default for panels: it would hide mini mode as the reader clicks into the game.
            (*native).setHidesOnDeactivate(false);
        }
        Ok(current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mini_mode_enters_once_per_episode_on_kimochis_display_only_when_turned_on() {
        let mut policy = AutoMini::default();
        let mut see = |source: &str, fullscreen: bool, on_screen: bool, same: bool| {
            policy.observe(source, fullscreen, on_screen, false, same, true)
        };
        assert_eq!(see("game", false, true, true), Want::Nothing);
        assert_eq!(see("game", true, true, false), Want::Nothing, "another display: left alone");
        assert_eq!(see("game", true, true, true), Want::Mini);
        assert_eq!(see("game", true, true, true), Want::Nothing, "an expand by hand stands");
        assert_eq!(see("game", false, true, true), Want::Nothing);
        assert_eq!(see("game", true, true, true), Want::Mini);
        assert_eq!(see("another", true, true, true), Want::Mini);
    }
    #[test]
    fn by_default_kimochi_is_kept_over_the_game_on_its_display_until_unpinned() {
        let mut policy = AutoMini::default();
        assert_eq!(policy.observe("game", true, true, false, true, false), Want::Over);
        assert_eq!(policy.observe("game", true, true, false, true, false), Want::Over);
        assert_eq!(policy.observe("game", true, true, false, false, false), Want::Nothing, "moved to another display");
        assert_eq!(policy.observe("game", true, true, false, true, false), Want::Over, "and back");
        policy.declined = true;
        assert_eq!(policy.observe("game", true, true, false, true, false), Want::Nothing, "unpinned by hand");
        assert_eq!(policy.observe("game", false, true, false, true, false), Want::Nothing);
        assert_eq!(policy.observe("game", true, true, false, true, false), Want::Over, "a new episode");
    }
    #[test]
    fn selecting_fullscreen_waits_until_visible_and_finished_settling() {
        let mut policy = AutoMini::default();
        assert_eq!(policy.observe("game", true, false, false, true, true), Want::Nothing);
        assert_eq!(policy.observe("game", true, true, true, true, true), Want::Nothing);
        assert_eq!(policy.observe("game", true, true, false, true, true), Want::Mini);
    }
}
