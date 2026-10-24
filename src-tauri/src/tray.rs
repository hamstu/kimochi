//! The tray icon and its native menu: the system's own pop-up menu, the same on a click of
//! either button, with the few things worth reaching from the menu bar or taskbar.
use crate::panels;
use crate::state::Shared;
use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Emitter, Manager, Wry,
};

/// The icon without its tile or colour (`branding/tray-template.svg`), black on transparent,
/// so macOS draws it as a template and recolours it for the menu bar.
#[cfg(target_os = "macos")]
const ICON: &[u8] = include_bytes!("../../resources/tray-template@2x.png");
/// Linux tray hosts display the image as supplied, on dark and light panels alike, so they get
/// the same glyph in white with a dark keyline (`branding/tray-linux.svg`).
#[cfg(target_os = "linux")]
const ICON: &[u8] = include_bytes!("../../branding/tray-linux@2x.png");
/// Windows trays show the icon as it is, on light and dark taskbars alike, so they get the
/// full-colour app icon (`branding/icon-square.svg`).
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const ICON: &[u8] = include_bytes!("../icons/32x32.png");

// Item ids are prefixed: the app's own menu handler (main.rs) sees these clicks too, and opens a
// panel whose label matches the id, so a bare "settings" would also open the Settings panel.

/// The Mini Mode item, kept so its check follows the main window however mini mode changes.
struct TrayMenu {
    mini: CheckMenuItem<Wry>,
}

pub fn setup(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if let Err(error) = crate::platform::icons::refresh() {
        eprintln!("Could not refresh the Linux app icon: {error}");
    }
    let e = |e: tauri::Error| e.to_string();
    let icon = tauri::image::Image::from_bytes(ICON).map_err(e)?;
    let mini = CheckMenuItemBuilder::with_id("tray-mini", "Mini Mode")
        .checked(crate::compact::active())
        .build(app)
        .map_err(e)?;
    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("tray-show", "Open Kimochi").build(app).map_err(e)?)
        .item(&mini)
        .separator()
        .item(&MenuItemBuilder::with_id("tray-settings", "Settings…").build(app).map_err(e)?)
        .item(&MenuItemBuilder::with_id("tray-about", "About Kimochi").build(app).map_err(e)?)
        .separator()
        .item(&MenuItemBuilder::with_id("tray-quit", "Quit Kimochi").build(app).map_err(e)?)
        .build()
        .map_err(e)?;
    app.manage(TrayMenu { mini });
    let builder = TrayIconBuilder::with_id("kimochi").icon(icon);
    // Template rendering lets macOS invert it for the current menu bar appearance.
    // Linux uses its own light glyph with a dark keyline for untinted hosts.
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);
    builder
        .tooltip("Kimochi")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            if let Err(error) = act(app, event.id().as_ref()) {
                if let Some(service) = app.try_state::<Shared>() {
                    service.set_status(format!("Tray: {error}"));
                }
            }
        })
        .build(app)
        .map_err(e)?;
    Ok(())
}

fn act(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    if id == "tray-quit" {
        app.exit(0);
        return Ok(());
    }
    let service = app.try_state::<Shared>().ok_or("native: not ready")?;
    let settings = service.settings.clone();
    match id {
        "tray-show" => {
            panels::act_existing(app, &settings, panels::MAIN, "show", None)?;
        }
        "tray-mini" => {
            let next = if crate::compact::active() { "expand" } else { "mini" };
            panels::act_existing(app, &settings, panels::MAIN, next, None)?;
            panels::act_existing(app, &settings, panels::MAIN, "show", None)?;
        }
        "tray-settings" => open_settings(app, None)?,
        "tray-about" => open_settings(app, Some("about"))?,
        _ => {}
    }
    sync_mini(app);
    Ok(())
}

/// Show Settings, which is a view of the main window: on `page` when given (a `SettingsTabName`),
/// otherwise on whichever page it showed last.
pub fn open_settings(app: &tauri::AppHandle, page: Option<&str>) -> Result<(), String> {
    let service = app.try_state::<Shared>().ok_or("native: not ready")?;
    if let Some(page) = page {
        service.settings.set("settingsActiveTab", serde_json::json!(page))?;
        let _ = app.emit(
            "settings:changed",
            serde_json::json!({ "key": "settingsActiveTab", "value": page }),
        );
    }
    panels::act_existing(app, &service.settings, panels::MAIN, "show", None)?;
    let _ = app.emit("main:show-settings", serde_json::json!({}));
    Ok(())
}

/// Check Mini Mode when the main window is mini. A check item flips itself when clicked, so
/// this also puts it right after a toggle that failed.
pub fn sync_mini(app: &tauri::AppHandle) {
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let _ = menu.mini.set_checked(crate::compact::active());
    }
}
