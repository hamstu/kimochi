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
}
static SAVED: Mutex<Option<Saved>> = Mutex::new(None);
static CROP_VISIBLE: Mutex<bool> = Mutex::new(false);
static ACTIVE: AtomicBool = AtomicBool::new(false);

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
        saved.take();
        ACTIVE.store(false, Ordering::Relaxed);
    }
    let _ = window.emit("main:mini", enabled);
    Ok(())
}

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
        super::order_front(&window)?;
        *restore = false;
    }
    Ok(())
}
