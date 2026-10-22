//! Gaming Mode sources: Gamescope's running apps (`kimochi_capture::linux_gamescope`),
//! named and drawn the way Steam's library shows them.
//!
//! Gamescope knows app IDs, not names, and a game's window is often on its second
//! XWayland server, out of reach of a title lookup. Steam's own files name them: an
//! installed game's `appmanifest_<appid>.acf`, a non-Steam shortcut's `shortcuts.vdf`
//! entry (`steam_library::app_info`, read only). The icon is the one Steam keeps in
//! `appcache/librarycache/<appid>/`, or the shortcut's own.
use kimochi_capture::{linux_gamescope, Source};

/// Capture reads Gamescope's apps (rather than the portal's composed screen).
pub fn active() -> bool {
    kimochi_capture::gamescope_capture_now()
}

/// Steam's name for an app, else its window title, else its number.
fn name_of(app: u32, title: &str) -> String {
    crate::steam_library::app_info(app)
        .map(|info| info.name)
        .or_else(|| Some(title.trim().to_owned()).filter(|t| !t.is_empty()))
        .unwrap_or_else(|| format!("App {app}"))
}

/// Give an app source Steam's name, as both its name and its app (the UI shows the app
/// name and keys icons and saved crops on it). The screen keeps its own name.
pub fn decorate(source: &mut Source) {
    let Some(app) = linux_gamescope::app_of(&source.id).filter(|app| *app != 0) else { return };
    let name = name_of(app, &source.name);
    source.name = name.clone();
    source.app = Some(name);
}

pub fn sources() -> Vec<Source> {
    let mut sources = linux_gamescope::sources();
    for source in &mut sources {
        decorate(source);
    }
    sources
}

/// The running app `decorate` named `name`.
fn app_named(name: &str) -> Option<u32> {
    linux_gamescope::running()
        .into_iter()
        .find(|app| name_of(app.app_id, &app.title) == name)
        .map(|app| app.app_id)
}

/// Steam's icon for the running app named `name`, as PNG no larger than `target`.
pub fn icon_png(name: &str, target: isize) -> Option<Vec<u8>> {
    let path = crate::steam_library::app_info(app_named(name)?)?.icon?;
    let mut image = image::ImageReader::open(&path).ok()?.with_guessed_format().ok()?.decode().ok()?;
    let edge = target.clamp(16, 256) as u32;
    if image.width() > edge || image.height() > edge {
        image = image.resize(edge, edge, image::imageops::FilterType::Triangle);
    }
    let mut png = Vec::new();
    image.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    Some(png)
}

/// The source to start from when nothing saved matches: the game being played, else
/// the screen.
pub fn default_source() -> Option<Source> {
    let sources = sources();
    let game = super::gamescope_handoff::game_id();
    sources
        .iter()
        .find(|s| game.is_some() && linux_gamescope::app_of(&s.id) == game)
        .or_else(|| sources.first())
        .cloned()
}

/// "Bring to front" for a Gaming Mode source: switch to that app (the screen: back to
/// the game), handing input back to Steam as the Return to game button does.
pub fn activate(app: &tauri::AppHandle, source_id: &str) -> Result<(), String> {
    match linux_gamescope::app_of(source_id) {
        Some(0) => {
            super::gamescope::return_to_game(app);
            Ok(())
        }
        Some(target) => {
            super::gamescope::return_to(app, Some(target));
            Ok(())
        }
        None => Err("invalid: not a Gaming Mode source".into()),
    }
}
