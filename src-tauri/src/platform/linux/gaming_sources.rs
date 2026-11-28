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
    trace_catalog(&sources);
    sources
}

/// Where `name_of` found an app's name: Steam's library, the window title, or neither.
fn name_origin(app: u32, title: &str) -> &'static str {
    if crate::steam_library::app_info(app).is_some() {
        "steam"
    } else if !title.trim().is_empty() {
        "title"
    } else {
        "number"
    }
}

/// Verbose logging only, and only when it changed: what Gamescope listed, which apps became
/// sources, and why the rest were left out (`gamescope-catalog`).
fn trace_catalog(sources: &[Source]) {
    if !crate::debug_report::verbose() {
        return;
    }
    let catalog = linux_gamescope::catalog_debug();
    let apps: Vec<serde_json::Value> = catalog
        .apps
        .iter()
        .map(|(app, title, verdict)| {
            serde_json::json!({
                "appId": app,
                "title": title,
                "verdict": verdict,
                "name": name_of(*app, title),
                "nameFrom": name_origin(*app, title),
            })
        })
        .collect();
    crate::debug_report::trace_changed(
        "gamescope-catalog",
        serde_json::json!({
            "check": "gamescope-catalog",
            "connected": catalog.connected,
            "captureActive": active(),
            "pipewireNode": linux_gamescope::available(),
            "focusableApps": catalog.focusable_apps,
            "focusableWindows": catalog.focusable_windows,
            "ownPid": catalog.own_pid,
            "ownAppId": catalog.own_app_id,
            "apps": apps,
            "sources": sources.iter().map(|s| serde_json::json!({"id": s.id, "name": s.name})).collect::<Vec<_>>(),
        }),
    );
}

/// The running app `decorate` named `name`.
fn app_named(name: &str) -> Option<u32> {
    linux_gamescope::running().into_iter().find(|app| name_of(app.app_id, &app.title) == name).map(|app| app.app_id)
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
    let chosen = sources
        .iter()
        .find(|s| game.is_some() && linux_gamescope::app_of(&s.id) == game)
        .or_else(|| sources.first())
        .cloned();
    crate::debug_report::trace_now(serde_json::json!({
        "check": "gaming-mode-default-source",
        "game": game,
        "ownAppId": super::gamescope_handoff::own_id(),
        "chosen": chosen.as_ref().map(|s| &s.id),
        "matchedGame": chosen.as_ref().is_some_and(|s| game.is_some() && linux_gamescope::app_of(&s.id) == game),
    }));
    chosen
}

/// Whether `source` (a Gamescope source id, or none) is what Gamescope shows while it draws `front`
/// (`GAMESCOPE_FOCUSED_APP_GFX`; `own` is Kimochi's app ID): a game's text belongs on screen only
/// over that game, and the screen's only over a game, never over Kimochi or Steam's own UI.
fn source_in_front(source: Option<&str>, front: u32, own: Option<u32>) -> bool {
    let game = front != 0 && front != linux_gamescope::STEAM_CLIENT_APP && Some(front) != own;
    match source.map(linux_gamescope::app_of) {
        None => true,
        Some(Some(0)) => game,
        Some(Some(app)) => app == front,
        Some(None) => true,
    }
}

/// The overlay's `source-focus` in Gaming Mode, where the window rules have nothing to go on (one
/// full-screen app at a time, Kimochi's main window always mapped): from what Gamescope draws in
/// front. None outside Gaming Mode, or when that cannot be read (the window rules then stand).
pub fn source_focus(source: Option<&str>) -> Option<crate::state::SourceFocus> {
    if !active() {
        return None;
    }
    let front = super::gamescope::graphics_app()?;
    let own = super::gamescope_handoff::own_id();
    let focused = source_in_front(source, front, own);
    Some(crate::state::SourceFocus {
        focused,
        present: true,
        held: false,
        source_front: focused,
        covered: !focused && Some(front) == own,
        front_window: front,
        source_window: source.and_then(linux_gamescope::app_of).unwrap_or(0),
    })
}

/// Whether the reader should move to `game`, just brought to the front, from the source
/// `selected` (a Gamescope source id, or none). Only from another game's window: the screen
/// already shows whatever is in front, and a source the player is already reading stays.
fn follows(selected: Option<&str>, game: u32) -> bool {
    match selected.map(linux_gamescope::app_of) {
        None => true,
        Some(Some(0)) => false,
        Some(Some(app)) => app != game,
        // Not a Gamescope source (a portal stream, clipboard…): the player chose it.
        Some(None) => false,
    }
}

/// The game whose Log session lines read from the screen belong to: the one being played,
/// while the screen is the source. The screen reads whatever is in front and has no session of
/// its own, so its lines stayed in whichever session was open: a second game's went into the
/// first game's (#312). None for any other source (a game's window already names its session).
fn screen_game(selected: Option<&str>, playing: Option<u32>) -> Option<u32> {
    (selected.map(linux_gamescope::app_of) == Some(Some(0))).then_some(playing).flatten().filter(|app| *app != 0)
}

/// The source a reading is filed under in the Log when it is not the selected one: the game
/// being played, as `{sourceId, type, name, appName}`, while the screen is selected
/// (`screen_game`). The id stays the screen's, which is what was captured.
pub fn session_source(selected: Option<&str>) -> Option<serde_json::Value> {
    // Asked on every state snapshot: the game and its name are looked up twice a second at most.
    /// When the game was last looked up, and the game (app id and name) found then.
    type Looked = (std::time::Instant, Option<(u32, String)>);
    static LAST: std::sync::Mutex<Option<Looked>> = std::sync::Mutex::new(None);
    if !active() || selected.map(linux_gamescope::app_of) != Some(Some(0)) {
        return None;
    }
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    let fresh = last.as_ref().filter(|(at, _)| at.elapsed() < std::time::Duration::from_millis(500));
    let game = match fresh {
        Some((_, game)) => game.clone(),
        None => {
            let known = last.as_ref().and_then(|(_, game)| game.clone());
            let game = screen_game(selected, super::gamescope_handoff::game_id()).map(|app| {
                let name = known.filter(|(id, _)| *id == app).map(|(_, name)| name).unwrap_or_else(|| {
                    sources()
                        .into_iter()
                        .find(|s| linux_gamescope::app_of(&s.id) == Some(app))
                        .map(|s| s.name)
                        .unwrap_or_else(|| name_of(app, ""))
                });
                (app, name)
            });
            *last = Some((std::time::Instant::now(), game.clone()));
            game
        }
    };
    let (_, name) = game?;
    Some(serde_json::json!({ "sourceId": selected, "type": "window", "name": name, "appName": name }))
}

/// Whether the follower is done with the game now in front: it is not one to follow, or its
/// window was found (and selected). Otherwise the game is looked for again on the next poll.
fn settled(follows: bool, listed: bool) -> bool {
    !follows || listed
}

/// Keep the source on the game being played. Switching games through Steam (its library,
/// the Steam button, Quick Access) brings another app to the front; when the reader was on
/// a different game's window, select the one now in front, with the crop saved for it, as
/// choosing it in Change source would. Polls the game the handoff last saw in front.
pub fn follow(service: crate::state::Shared) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !active() || STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new().name("kimochi-game-follow".into()).spawn(move || {
        let mut seen = super::gamescope_handoff::last_game();
        // The game last reported as in front but not listed yet, so it is reported once.
        let mut waiting = 0;
        let mut ticks: u32 = 0;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            ticks = ticks.wrapping_add(1);
            if ticks.is_multiple_of(8) {
                rebind_restarted(&service);
            }
            let game = super::gamescope_handoff::last_game();
            if game == 0 || game == seen {
                continue;
            }
            // Once a second while waiting for a game's window to be listed.
            if game == waiting && !ticks.is_multiple_of(4) {
                continue;
            }
            let selected = service.selection.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let follow = follows(selected.as_deref(), game);
            let found = if follow {
                sources().into_iter().find(|s| linux_gamescope::app_of(&s.id) == Some(game))
            } else {
                None
            };
            // A game comes to the front before its window is among the sources (while it starts):
            // ask again next time rather than staying on the last game for good (#312).
            if settled(follow, found.is_some()) {
                seen = game;
            }
            if settled(follow, found.is_some()) || waiting != game {
                crate::debug_report::trace_now(serde_json::json!({
                    "check": "gaming-mode-front-game",
                    "game": game,
                    "selected": selected,
                    "follows": follow,
                    // A game in front that is not among the sources: see `gamescope-catalog` for why.
                    "listed": found.as_ref().map(|s| &s.id),
                }));
            }
            waiting = game;
            let Some(source) = found else {
                continue;
            };
            match crate::sources::select_keeping_crop(&service, &source.id) {
                Ok(_) => {
                    service.set_status(format!("Reading · {}", source.name));
                    service.log(serde_json::json!({"check": "gaming-mode-source-follow", "sourceId": source.id, "from": selected}));
                }
                Err(error) => eprintln!("Gaming Mode: could not follow {}: {error}", source.name),
            }
        }
    });
    if let Err(error) = spawned {
        eprintln!("Gaming Mode: game follower not started: {error}");
    }
}

/// The live id of the game `selected` (a Gamescope window source) names, when that game is still
/// running but under a new process: its id carries the pid, so a game restarted from Steam left the
/// reader on a source that no longer exists ("that source has closed" from Crop and every scan).
/// None while the selected id is live, or for the screen and anything not a Gamescope window.
fn restarted<'a>(selected: Option<&str>, live: &'a [String]) -> Option<&'a String> {
    let selected = selected?;
    let app = linux_gamescope::app_of(selected).filter(|app| *app != 0)?;
    if live.iter().any(|id| id == selected) {
        return None;
    }
    live.iter().find(|id| linux_gamescope::app_of(id) == Some(app))
}

/// Move the selection to the same game's new window after the game restarted (`restarted`),
/// keeping the crop saved for it.
fn rebind_restarted(service: &crate::state::Shared) {
    let selected = service.selection.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if selected.as_deref().and_then(linux_gamescope::app_of).is_none_or(|app| app == 0) {
        return;
    }
    let live: Vec<String> = sources().into_iter().map(|s| s.id).collect();
    let Some(id) = restarted(selected.as_deref(), &live) else { return };
    match crate::sources::select_keeping_crop(service, id) {
        Ok(_) => {
            service.log(serde_json::json!({"check": "gaming-mode-source-rebound", "sourceId": id, "from": selected}))
        }
        Err(error) => eprintln!("Gaming Mode: could not follow the restarted game to {id}: {error}"),
    }
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

#[cfg(test)]
mod tests {
    use super::{follows, restarted, screen_game, settled, source_in_front};

    #[test]
    fn lines_read_from_the_screen_belong_to_the_game_being_played() {
        assert_eq!(screen_game(Some("gamescope:display:0"), Some(310360)), Some(310360));
        // No game running: the screen's lines stay where they are.
        assert_eq!(screen_game(Some("gamescope:display:0"), None), None);
        assert_eq!(screen_game(Some("gamescope:display:0"), Some(0)), None);
        // A game's window names its own session; other sources and no source are left alone.
        assert_eq!(screen_game(Some("gamescope:window:1263470:42"), Some(310360)), None);
        assert_eq!(screen_game(Some("clipboard"), Some(310360)), None);
        assert_eq!(screen_game(None, Some(310360)), None);
    }

    #[test]
    fn a_game_in_front_but_not_listed_yet_is_looked_for_again() {
        // Followed and found, or not one to follow: done with this game.
        assert!(settled(true, true));
        assert!(settled(false, false));
        // To follow, but its window is not among the sources yet (#312): ask again.
        assert!(!settled(true, false));
    }

    #[test]
    fn a_restarted_game_is_found_again_by_its_app_id() {
        let live = vec!["gamescope:display:0".to_string(), "gamescope:window:3311684016:529547".to_string()];
        // The game restarted: same app, new pid.
        assert_eq!(restarted(Some("gamescope:window:3311684016:523473"), &live), Some(&live[1]));
        // Still the live window, the screen, another game that quit, or nothing selected: stay.
        assert_eq!(restarted(Some("gamescope:window:3311684016:529547"), &live), None);
        assert_eq!(restarted(Some("gamescope:display:0"), &live), None);
        assert_eq!(restarted(Some("gamescope:window:1263470:94460"), &live), None);
        assert_eq!(restarted(Some("portal:window:12"), &live), None);
        assert_eq!(restarted(None, &live), None);
    }

    const OWN: Option<u32> = Some(3148519714);

    #[test]
    fn a_game_s_text_shows_only_over_that_game() {
        let sakura = Some("gamescope:window:3280396386:384924");
        assert!(source_in_front(sakura, 3280396386, OWN));
        assert!(!source_in_front(sakura, 3456462794, OWN), "another game");
        assert!(!source_in_front(sakura, 769, OWN), "Steam's menus");
        assert!(!source_in_front(sakura, 3148519714, OWN), "Kimochi itself");
    }

    #[test]
    fn the_screen_s_text_shows_over_any_game_but_not_kimochi_or_steam() {
        let screen = Some("gamescope:display:0");
        assert!(source_in_front(screen, 3280396386, OWN));
        assert!(!source_in_front(screen, 769, OWN));
        assert!(!source_in_front(screen, 3148519714, OWN));
        assert!(source_in_front(None, 769, OWN), "no source: nothing to hide");
    }

    #[test]
    fn the_reader_moves_to_the_game_brought_to_the_front() {
        assert!(follows(Some("gamescope:window:3280396386:384924"), 3456462794));
        assert!(follows(None, 3456462794));
    }

    #[test]
    fn the_same_game_the_screen_and_other_sources_stay() {
        assert!(!follows(Some("gamescope:window:3456462794:389160"), 3456462794));
        assert!(!follows(Some("gamescope:display:0"), 3456462794));
        assert!(!follows(Some("portal:display:80"), 3456462794));
    }
}
