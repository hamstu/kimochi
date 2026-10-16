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
    spaces: usize,
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
            spaces: mac_spaces(window, None)?,
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
        mac_spaces(window, Some(previous.spaces))?;
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

// Mini mode must join the source's full-screen Space. Restore the main window's
// exact behavior on expand; the platform's reference overlay implementation stays unchanged.
#[cfg(target_os = "macos")]
fn mac_spaces(window: &tauri::WebviewWindow, restore: Option<usize>) -> Result<usize, String> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior as Behavior};
    objc2::MainThreadMarker::new().ok_or("Mini mode requires the main thread")?;
    unsafe {
        let native = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        let original = (*native).collectionBehavior();
        let next = restore.map(Behavior).unwrap_or(
            (original - Behavior::MoveToActiveSpace - Behavior::FullScreenPrimary)
                | Behavior::CanJoinAllSpaces
                | Behavior::FullScreenAuxiliary,
        );
        (*native).setCollectionBehavior(next);
        Ok(original.0)
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
