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

#[derive(Default)]
struct AutoMini {
    source: String,
    entered: bool,
}

impl AutoMini {
    fn observe(&mut self, source: &str, fullscreen: bool, on_screen: bool, settling: bool) -> bool {
        if self.source != source {
            self.source = source.to_owned();
            self.entered = false;
        }
        if !fullscreen {
            self.entered = false;
        }
        let enter = fullscreen && on_screen && !settling && !self.entered;
        if enter {
            self.entered = true;
        }
        enter
    }
}

static AUTO: Mutex<AutoMini> = Mutex::new(AutoMini {
    source: String::new(),
    entered: false,
});

pub fn forget_source() {
    *AUTO.lock().unwrap() = AutoMini::default();
}

pub fn observe_source(
    app: &tauri::AppHandle,
    service: &crate::state::Shared,
    source: &str,
    state: &crate::platform::WindowState,
) {
    if !AUTO
        .lock()
        .unwrap()
        .observe(source, state.fullscreen, state.on_screen, state.settling)
    {
        return;
    }
    let source = source.to_owned();
    let handle = app.clone();
    let service = service.clone();
    let _ = app.run_on_main_thread(move || {
        // A selection or shape change can overtake this queued main-thread turn.
        if service.watching.lock().unwrap().as_deref() != Some(source.as_str())
            || !service.source_fullscreen.load(Ordering::Relaxed)
        {
            return;
        }
        if let Some(window) = handle.get_webview_window(crate::panels::MAIN) {
            let result = set(&window, true);
            crate::record(
                &handle,
                &service,
                serde_json::json!({
                    "check": "mini-fullscreen", "sourceId": source, "error": result.err(),
                }),
            );
        }
    });
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
        window
            .set_min_size(Some(tauri::LogicalSize::new(280., 200.)))
            .map_err(|e| e.to_string())?;
        window.set_always_on_top(true).map_err(|e| e.to_string())?;
        crate::platform::desktop_place(
            window,
            crate::platform::clamp_to_visible(Rect {
                width: 320.,
                height: 560.,
                ..bounds
            }),
        )?;
    } else if let Some(previous) = saved.as_ref() {
        let spec = crate::panels::spec(crate::panels::MAIN).ok_or("main panel unavailable")?;
        window
            .set_min_size(Some(tauri::LogicalSize::new(
                spec.min_width,
                spec.min_height,
            )))
            .map_err(|e| e.to_string())?;
        window
            .set_always_on_top(previous.pinned)
            .map_err(|e| e.to_string())?;
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
    fn enters_once_per_source_fullscreen_episode_and_respects_manual_expand() {
        let mut policy = AutoMini::default();
        assert!(!policy.observe("game", false, true, false));
        assert!(policy.observe("game", true, true, false));
        assert!(!policy.observe("game", true, true, false));
        assert!(!policy.observe("game", true, false, false));
        assert!(!policy.observe("game", true, true, false));
        assert!(!policy.observe("game", false, true, false));
        assert!(policy.observe("game", true, true, false));
        assert!(policy.observe("another", true, true, false));
    }
    #[test]
    fn selecting_fullscreen_waits_until_visible_and_finished_settling() {
        let mut policy = AutoMini::default();
        assert!(!policy.observe("game", true, false, false));
        assert!(!policy.observe("game", true, true, true));
        assert!(policy.observe("game", true, true, false));
    }
}
