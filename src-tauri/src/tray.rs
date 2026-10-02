//! Tray icon, left-click popover and right-click menu, matching `createTray` in the
//! Electron build.
use crate::actions;
use crate::native;
use crate::panels;
use crate::settings::Settings;
use crate::state::Shared;
use kimochi_capture::Rect;
use std::sync::Arc;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

/// The Electron app's macOS template icon, reused byte-for-byte so the menu bar looks
/// the same and follows light/dark mode automatically.
const TEMPLATE_ICON: &[u8] = include_bytes!("../../resources/app-icon-Template@2x.png");

const POPOVER: &str = "tray-popover";

pub fn setup(app: &tauri::AppHandle, settings: &Arc<Settings>) -> Result<(), String> {
    let icon = tauri::image::Image::from_bytes(TEMPLATE_ICON).map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(app)
        .items(&[
            &MenuItemBuilder::with_id("showControls", "Show Kimochi")
                .build(app)
                .map_err(|e| e.to_string())?,
            &MenuItemBuilder::with_id("openSettings", "Settings")
                .build(app)
                .map_err(|e| e.to_string())?,
        ])
        .separator()
        .items(&[&MenuItemBuilder::with_id("quit", "Quit")
            .build(app)
            .map_err(|e| e.to_string())?])
        .build()
        .map_err(|e| e.to_string())?;
    let store = settings.clone();
    TrayIconBuilder::with_id("kimochi")
        .icon(icon)
        // Template rendering lets macOS invert it for the current menu bar appearance.
        .icon_as_template(true)
        .tooltip("Kimochi")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref().to_string();
            let _ = app.emit("tray:action", serde_json::json!({ "action": id }));
            match id.as_str() {
                "quit" => app.exit(0),
                "showControls" => {
                    if let Some(service) = app.try_state::<Shared>() {
                        let settings = service.settings.clone();
                        let _ = panels::act(app, &settings, panels::MAIN, "show", None);
                    }
                }
                "openSettings" => {
                    if let Some(service) = app.try_state::<Shared>() {
                        let settings = service.settings.clone();
                        let _ = panels::act(app, &settings, panels::MAIN, "show", None);
                        let _ = app.emit("main:show-settings", serde_json::json!({}));
                    }
                }
                _ => {}
            }
        })
        .on_tray_icon_event(move |tray, event| {
            let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            else {
                return;
            };
            // The tray rect type is crate-private, so its geometry is unpacked here
            // rather than passed along.
            let scale = native::display_infos()
                .first()
                .map(|d| d.scale_factor)
                .unwrap_or(1.0)
                .max(1.0);
            let position: tauri::LogicalPosition<f64> = rect.position.to_logical(scale);
            let size: tauri::LogicalSize<f64> = rect.size.to_logical(scale);
            toggle_popover(
                tray.app_handle(),
                &store,
                position.x,
                position.y,
                size.width,
                size.height,
            );
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn toggle_popover(
    app: &tauri::AppHandle,
    settings: &Arc<Settings>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) {
    if let Some(window) = app.get_webview_window(POPOVER) {
        if window.is_visible().unwrap_or(false) {
            let _ = panels::act(app, settings, POPOVER, "hide", None);
            return;
        }
    }
    let spec = panels::spec(POPOVER).expect("tray popover panel");
    let bounds = Rect {
        x: x + width / 2.0 - spec.width / 2.0,
        // Below the menu bar on macOS, with the same 4 point gap Electron uses.
        y: y + height + 4.0,
        width: spec.width,
        height: spec.height,
    };
    let _ = panels::act(app, settings, POPOVER, "place", Some(bounds));
    let _ = panels::act(app, settings, POPOVER, "show", None);
    if let Some(window) = app.get_webview_window(POPOVER) {
        // Dismiss on click-outside, like the Electron popover's blur handler. The
        // panel:state event that `hide` emits is what tells the UI it closed.
        let handle = app.clone();
        let store = settings.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Focused(false)) {
                let _ = panels::act(&handle, &store, POPOVER, "hide", None);
            }
        });
    }
}

/// Tray actions that a panel may also trigger, kept in one list so the tray and the
/// UI cannot drift apart.
pub fn dispatch(app: &tauri::AppHandle, service: &Shared, action: &str) -> Result<(), String> {
    let settings = service.settings.clone();
    match action {
        "showControls" => {
            panels::act(app, &settings, panels::MAIN, "show", None)?;
        }
        "openSettings" => {
            // Settings is a view of the main window.
            panels::act(app, &settings, panels::MAIN, "show", None)?;
            let _ = app.emit("main:show-settings", serde_json::json!({}));
        }
        "openLog" => {
            panels::act(app, &settings, "log", "show", None)?;
        }
        "quit" => app.exit(0),
        name if actions::ACTIONS.contains(&name) => actions::dispatch(app, service, name),
        // Remaining tray toggles are view state owned by the overlay; it listens for
        // the event rather than Rust guessing at renderer state.
        _ => {}
    }
    let _ = app.emit("tray:action", serde_json::json!({ "action": action }));
    Ok(())
}
