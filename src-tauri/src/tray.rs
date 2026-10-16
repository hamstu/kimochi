//! Tray icon, left-click popover and right-click menu, matching `createTray` in the
//! Electron build.
use crate::actions;
use crate::platform;
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
    menu.insert(&MenuItemBuilder::with_id("miniMode", "Mini mode")
        .build(app).map_err(|e| e.to_string())?, 1).map_err(|e| e.to_string())?;
    let store = settings.clone();
    let builder = TrayIconBuilder::with_id("kimochi").icon(icon);
    // Template rendering lets macOS invert it for the current menu bar appearance.
    // Other trays draw the same PNG as is.
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);
    builder
        .tooltip("Kimochi")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref().to_string();
            let _ = app.emit("tray:action", serde_json::json!({ "action": id }));
            match id.as_str() {
                "miniMode" => {
                    if let Some(service) = app.try_state::<Shared>() {
                        let _ = panels::act_existing(app, &service.settings, panels::MAIN, "mini", None);
                        let _ = panels::act_existing(app, &service.settings, panels::MAIN, "show", None);
                    }
                }
                "quit" => app.exit(0),
                "showControls" => {
                    if let Some(service) = app.try_state::<Shared>() {
                        let settings = service.settings.clone();
                        let _ = panels::act_existing(app, &settings, panels::MAIN, "show", None);
                    }
                }
                "openSettings" => {
                    if let Some(service) = app.try_state::<Shared>() {
                        let settings = service.settings.clone();
                        let _ = panels::act_existing(app, &settings, panels::MAIN, "show", None);
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
            let raw = rect.position.to_logical::<f64>(1.0);
            let raw_size = rect.size.to_logical::<f64>(1.0);
            let anchor = tray_anchor(raw.x, raw.y, raw_size.width, raw_size.height);
            toggle_popover(
                tray.app_handle(),
                &store,
                anchor.x,
                anchor.y,
                anchor.width,
                anchor.height,
            );
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The tray icon's rect in desktop points.
///
/// Tauri reports it in physical pixels. macOS divides by the first display's scale, as
/// it always has (the menu bar lives on the main display). Elsewhere the rect goes
/// through the same desktop-point conversion as every other native rectangle, so a
/// taskbar on a monitor with a different DPI from the primary places correctly.
fn tray_anchor(x: f64, y: f64, width: f64, height: f64) -> Rect {
    #[cfg(target_os = "macos")]
    {
        let scale = platform::display_infos()
            .first()
            .map(|d| d.scale_factor)
            .unwrap_or(1.0)
            .max(1.0);
        Rect {
            x: x / scale,
            y: y / scale,
            width: width / scale,
            height: height / scale,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        platform::DesktopGeometry::current().rect_to_desktop(Rect {
            x,
            y,
            width,
            height,
        })
    }
}

/// The display whose bounds (in desktop points) contain a point.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn display_containing(
    displays: &[platform::DisplayInfo],
    x: f64,
    y: f64,
) -> Option<&platform::DisplayInfo> {
    displays.iter().find(|d| {
        let b = &d.bounds;
        x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height
    })
}

/// Where the popover goes for a tray icon at this logical rect.
///
/// macOS: below the menu bar, with the same 4 point gap Electron uses. Elsewhere the
/// tray usually lives in a bottom taskbar, so the popover opens above the icon when the
/// icon is in the bottom half of its own display, and is kept on that display.
fn popover_bounds(x: f64, y: f64, width: f64, height: f64, popover: (f64, f64)) -> Rect {
    let (pw, ph) = popover;
    let centred_x = x + width / 2.0 - pw / 2.0;
    #[cfg(target_os = "macos")]
    {
        Rect {
            x: centred_x,
            y: y + height + 4.0,
            width: pw,
            height: ph,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let displays = platform::desktop_display_infos();
        let display = display_containing(&displays, x + width / 2.0, y + height / 2.0);
        popover_above(centred_x, y, height, (pw, ph), display.map(|d| d.work_area))
    }
}

/// Placement for a tray that can sit at the top or bottom of a display.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn popover_above(
    centred_x: f64,
    y: f64,
    height: f64,
    (pw, ph): (f64, f64),
    area: Option<Rect>,
) -> Rect {
    let Some(area) = area else {
        return Rect {
            x: centred_x,
            y: y + height + 4.0,
            width: pw,
            height: ph,
        };
    };
    let above = y + height / 2.0 > area.y + area.height / 2.0;
    let top = if above { y - ph - 4.0 } else { y + height + 4.0 };
    Rect {
        x: centred_x.max(area.x).min(area.x + area.width - pw),
        y: top.max(area.y).min(area.y + area.height - ph),
        width: pw,
        height: ph,
    }
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
            let _ = panels::act_existing(app, settings, POPOVER, "hide", None);
            return;
        }
    }
    let spec = panels::spec(POPOVER).expect("tray popover panel");
    let bounds = popover_bounds(x, y, width, height, (spec.width, spec.height));
    // The first click builds the popover, which must not happen inside this callback (it
    // deadlocks on WebView2); every later click runs inline as before.
    let settings = settings.clone();
    panels::with_panel(app, POPOVER, move |app, turn| {
        let _ = panels::act(turn, app, &settings, POPOVER, "place", Some(bounds));
        let _ = panels::act(turn, app, &settings, POPOVER, "show", None);
        if let Some(window) = app.get_webview_window(POPOVER) {
            // Dismiss on click-outside, like the Electron popover's blur handler. The
            // panel:state event that `hide` emits is what tells the UI it closed.
            let handle = app.clone();
            let store = settings.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Focused(false)) {
                    let _ = panels::act_existing(&handle, &store, POPOVER, "hide", None);
                }
            });
        }
    });
}

/// Tray actions that a panel may also trigger, kept in one list so the tray and the
/// UI cannot drift apart.
pub fn dispatch(app: &tauri::AppHandle, service: &Shared, action: &str) -> Result<(), String> {
    let settings = service.settings.clone();
    match action {
        "showControls" => {
            panels::act_existing(app, &settings, panels::MAIN, "show", None)?;
        }
        "openSettings" => {
            // Settings is a view of the main window.
            panels::act_existing(app, &settings, panels::MAIN, "show", None)?;
            let _ = app.emit("main:show-settings", serde_json::json!({}));
        }
        "openLog" => {
            panels::act_existing(app, &settings, panels::MAIN, "show", None)?;
        }
        "quit" => app.exit(0),
        name if actions::ACTIONS.contains(&name) => {
            crate::gamepad::note_menu_origin(false);
            actions::dispatch(app, service, name)
        }
        // Remaining tray toggles are view state owned by the overlay; it listens for
        // the event rather than Rust guessing at renderer state.
        _ => {}
    }
    let _ = app.emit("tray:action", serde_json::json!({ "action": action }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area() -> Option<Rect> {
        Some(Rect {
            x: 0.,
            y: 0.,
            width: 1920.,
            height: 1040.,
        })
    }

    #[test]
    fn a_bottom_taskbar_icon_opens_the_popover_above_it() {
        let r = popover_above(1800., 1000., 30., (300., 400.), area());
        assert_eq!(r.y, 1000. - 400. - 4.);
        // An icon in the taskbar itself, below the work area, still gets a popover
        // inside the work area, just above the taskbar.
        let r = popover_above(1800., 1045., 30., (300., 400.), area());
        assert_eq!(r.y, 1040. - 400.);
        // And it stays on the display.
        assert_eq!(r.x, 1920. - 300.);
    }

    #[test]
    fn a_top_tray_icon_opens_the_popover_below_it() {
        let r = popover_above(500., 0., 24., (300., 400.), area());
        assert_eq!(r.y, 28.);
        assert_eq!(r.x, 500.);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keeps_the_menu_bar_placement() {
        let r = popover_bounds(1000., 0., 24., 24., (300., 400.));
        assert_eq!((r.x, r.y, r.width, r.height), (862., 28., 300., 400.));
    }
}
