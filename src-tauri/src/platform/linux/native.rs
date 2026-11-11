//! Native Wayland capture's desktop answers: the compositor's window inventory
//! (`kimochi_capture::linux_native`) behind the picker, window bounds, focus, icons and
//! activation, the way X11's EWMH queries answer them on X11.
//!
//! Every native window source names its compositor window, so nothing here matches or guesses:
//! a source's bounds, visibility and focus are that window's, read again on each call (the
//! inventory is cached for a quarter second in capture-core).
//!
//! Coordinates: GNOME's Shell extension draws the overlay itself in the compositor's global
//! logical coordinates, so bounds stay global there. With a layer-shell overlay (KDE Plasma,
//! Hyprland, Sway, …) the overlay covers one output and bounds are relative to it; the overlay
//! is moved to the source window's output, as `kwin.rs` and `hyprland.rs` do for portal streams.
use kimochi_capture::linux_native::{self as nat, Inventory, NativeWindow};
use kimochi_capture::{Frame, Rect, Source, SourceId};

/// Whether this session captures through a compositor's own API (chosen once, at first use).
pub fn active() -> bool {
    !super::x11_session() && !super::gamescope::active() && !super::gaming_sources::active() && nat::init().is_some()
}

/// KDE Plasma up to 6.7 offers its screencast and window-list protocols (`zkde_screencast`,
/// `org_kde_plasma_window_management`) only to an executable that an installed desktop file names
/// in `Exec` and authorizes in `X-KDE-Wayland-Interfaces`. The `.deb` installs one for
/// `/usr/bin/kimochi`; an AppImage runs from a new mount each launch, and a dev build from its
/// target directory, so the app keeps a hidden user entry naming its current executable. Plasma 6.8
/// and later need none of this. Call before the capture backend is created.
pub fn authorize_kwin() {
    if super::x11_session() || super::session().compositor.as_deref() != Some("KDE") {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    if exe == std::path::Path::new("/usr/bin/kimochi") {
        return;
    }
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share")));
    let Some(applications) = data.map(|d| d.join("applications")) else { return };
    let entry = applications.join("dev.kimochi.KWinCapture.desktop");
    // KWin compares `Exec`'s first word with the client's executable, unquoted.
    let path = exe.to_string_lossy();
    if path.contains(char::is_whitespace) {
        return;
    }
    let text = format!(
        "[Desktop Entry]\nType=Application\nName=Kimochi\nComment=Lets Kimochi list and capture windows on KDE Plasma without the screen-share dialog\nExec={path}\nIcon=kimochi\nTerminal=false\nNoDisplay=true\nX-KDE-Wayland-Interfaces=zkde_screencast_unstable_v1,org_kde_plasma_window_management\nX-Kimochi-Generated=true\n"
    );
    if std::fs::read_to_string(&entry).ok().as_deref() == Some(text.as_str()) {
        return;
    }
    // Written fresh (not edited in place): KWin notices new files, not changed ones.
    let _ = std::fs::remove_file(&entry);
    if std::fs::create_dir_all(&applications).and_then(|()| std::fs::write(&entry, text)).is_ok() {
        kimochi_capture::linux_native::kwin::note_authorization_written();
    }
}

pub fn driver() -> Option<&'static str> {
    nat::driver_name()
}

pub fn is_source(id: &str) -> bool {
    nat::is_native_id(id)
}

fn inventory() -> Option<Inventory> {
    active().then(nat::inventory).flatten()
}

/// The app's own name for a window: the compositor's, else its desktop entry's `Name`.
fn app_name(window: &NativeWindow) -> Option<String> {
    window.app_name.clone().or_else(|| {
        let id = window.app_id.as_deref()?;
        Some(super::hyprland::desktop_entry(id).map(|(name, _)| name).unwrap_or_else(|| id.to_owned()))
    })
}

/// Name a native source's app after its desktop entry where the compositor gave only an id.
pub fn decorate(source: &mut Source, inventory: &Inventory) {
    if let Some(window) = nat::window_handle(&source.id).and_then(|h| inventory.window(&h).cloned()) {
        source.app = app_name(&window);
    }
}

/// Outputs, then the windows a reader could pick.
pub fn picker_sources() -> Result<Vec<Source>, String> {
    let inventory = inventory().ok_or("native: the compositor's window list is unavailable")?;
    let mut sources = nat::sources(&inventory, std::process::id());
    for source in &mut sources {
        decorate(source, &inventory);
    }
    Ok(sources)
}

/// `bounds` (global logical) where the overlay draws: unchanged for GNOME's Shell overlay, else
/// relative to the window's output, moving the layer overlay there when it is elsewhere.
fn overlay_rect(inventory: &Inventory, window: &NativeWindow, bounds: Rect) -> Option<Rect> {
    if !super::layer::available() {
        return Some(bounds);
    }
    let output = window
        .output
        .as_deref()
        .and_then(|h| inventory.output(h))
        .or_else(|| (inventory.outputs.len() == 1).then(|| &inventory.outputs[0]))?;
    if inventory.outputs.len() > 1 {
        super::layer::follow_output(output.bounds);
    }
    Some(Rect {
        x: bounds.x - output.bounds.x,
        y: bounds.y - output.bounds.y,
        width: bounds.width,
        height: bounds.height,
    })
}

/// Can the overlay be drawn over this window now: shown, on this workspace, and in front
/// (Kimochi's own windows and the window's own app aside).
fn drawable(inventory: &Inventory, window: &NativeWindow) -> bool {
    let own = std::process::id();
    let foreground = inventory
        .focused()
        .is_none_or(|f| f.handle == window.handle || f.pid == Some(own) || (f.pid.is_some() && f.pid == window.pid));
    foreground
        && !window.minimized
        && window.on_screen != Some(false)
        && !(driver() == Some("kwin") && !crate::compact::active() && covered_by_own_window(inventory, window))
}

/// Whether the reader is using one of Kimochi's ordinary windows (the main window, the dictionary)
/// that is in front of the game and over part of it. Kimochi focused counts as the game in front,
/// so its windows can sit beside the game; but the overlay's text must not be drawn over one that
/// covers it (as `kwin.rs` does for portal streams). Only where the inventory is front to back
/// (KWin's stacking order), and never in Mini mode, whose small window sits over the game on purpose.
fn covered_by_own_window(inventory: &Inventory, game: &NativeWindow) -> bool {
    let own = std::process::id();
    let Some(game_bounds) = game.bounds else { return false };
    let overlaps = |a: &Rect, b: &Rect| a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    inventory
        .windows
        .iter()
        // Front to back: only the windows in front of the game.
        .take_while(|w| w.handle != game.handle)
        .any(|w| {
            w.pid == Some(own)
                && w.focused
                // The overlay and pop-ups skip the taskbar: auxiliary.
                && !w.auxiliary
                && !w.minimized
                && w.on_screen != Some(false)
                && w.output == game.output
                && w.bounds.is_some_and(|b| overlaps(&b, &game_bounds))
        })
}

/// A native window source's bounds (where the overlay draws) and whether it is drawable now.
pub fn window_bounds(id: &SourceId) -> Option<(Rect, bool)> {
    let inventory = inventory()?;
    let window = inventory.window(id.handle())?;
    let rect = overlay_rect(&inventory, window, window.bounds?)?;
    Some((rect, drawable(&inventory, window)))
}

/// A native frame's `source_bounds` in the overlay's coordinates (capture-core reports global).
pub fn enrich(frame: &mut Frame) {
    if !super::layer::available() {
        return;
    }
    let Some(handle) = nat::window_handle(&frame.info.source_id) else { return };
    let Some(inventory) = inventory() else { return };
    let Some(window) = inventory.window(&handle) else { return };
    if let Some(bounds) = frame.info.source_bounds {
        frame.info.source_bounds = overlay_rect(&inventory, window, bounds);
    }
}

/// The focused window, as a source id with its process.
pub fn front_window() -> Option<super::super::FrontWindow> {
    let inventory = inventory()?;
    let focused = inventory.focused()?;
    Some(super::super::FrontWindow {
        window: SourceId::parse(&nat::window_source_id(focused)),
        pid: focused.pid.unwrap_or(0),
    })
}

pub fn frontmost_app() -> Option<String> {
    let inventory = inventory()?;
    app_name(inventory.focused()?)
}

pub fn frontmost_pid() -> Option<u32> {
    inventory()?.focused()?.pid
}

/// The icon of an app with a window on the desktop: its desktop entry's icon from the theme.
pub fn app_icon_png(name: &str, pid: Option<u32>, target: isize) -> Option<Vec<u8>> {
    let inventory = inventory()?;
    let window = inventory
        .windows
        .iter()
        .find(|w| app_name(w).as_deref() == Some(name))
        .or_else(|| pid.and_then(|pid| inventory.windows.iter().find(|w| w.pid == Some(pid))))?;
    let id = window.app_id.as_deref()?;
    let icon = super::hyprland::desktop_entry(id).map(|(_, icon)| icon).unwrap_or_else(|| id.to_owned());
    super::gnome::icon_png(&icon, target.clamp(16, 256) as i32)
}

/// Bring a native window source forward (unminimize, switch workspace, focus).
pub fn activate(id: &SourceId) -> Result<serde_json::Value, String> {
    nat::activate(id.handle()).map_err(|e| format!("native: {}", e.message))?;
    Ok(serde_json::json!({"window": true, "backend": driver()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimochi_capture::linux_native::NativeOutput;

    fn window(handle: &str, pid: u32, focused: bool) -> NativeWindow {
        NativeWindow {
            handle: handle.into(),
            title: "Game".into(),
            app_id: Some("game".into()),
            app_name: Some("Game".into()),
            pid: Some(pid),
            bounds: Some(Rect { x: 2000.0, y: 100.0, width: 800.0, height: 600.0 }),
            output: Some("DP-2".into()),
            minimized: false,
            on_screen: Some(true),
            focused,
            auxiliary: false,
        }
    }

    #[test]
    fn a_window_is_drawable_only_in_front_and_on_screen() {
        let game = window("1", 10, false);
        let mut inv = Inventory { windows: vec![game.clone(), window("2", 20, true)], outputs: vec![] };
        assert!(!drawable(&inv, &game), "another app is focused");
        inv.windows[1].pid = Some(std::process::id());
        assert!(drawable(&inv, &game), "Kimochi itself focused");
        inv.windows[1].pid = Some(10);
        assert!(drawable(&inv, &game), "the game's own other window");
        let mut minimized = game.clone();
        minimized.minimized = true;
        assert!(!drawable(&inv, &minimized));
        let mut away = game;
        away.on_screen = Some(false);
        assert!(!drawable(&inv, &away));
    }

    #[test]
    fn kimochis_own_window_in_front_of_the_game_covers_it() {
        let game = window("1", 10, false);
        let mut own = window("2", std::process::id(), true);
        own.bounds = Some(Rect { x: 2400.0, y: 300.0, width: 900.0, height: 700.0 });
        let inv = Inventory { windows: vec![own.clone(), game.clone()], outputs: vec![] };
        assert!(covered_by_own_window(&inv, &game), "in front and over it");
        let behind = Inventory { windows: vec![game.clone(), own.clone()], outputs: vec![] };
        assert!(!covered_by_own_window(&behind, &game), "behind the game");
        let mut beside = own.clone();
        beside.bounds = Some(Rect { x: 0.0, y: 0.0, width: 900.0, height: 700.0 });
        let inv = Inventory { windows: vec![beside, game.clone()], outputs: vec![] };
        assert!(!covered_by_own_window(&inv, &game), "beside the game");
        let mut overlay = own;
        overlay.auxiliary = true;
        let inv = Inventory { windows: vec![overlay, game.clone()], outputs: vec![] };
        assert!(!covered_by_own_window(&inv, &game), "the overlay itself");
    }

    #[test]
    fn layer_bounds_are_relative_to_the_window_output() {
        let inv = Inventory {
            windows: vec![],
            outputs: vec![NativeOutput {
                handle: "DP-2".into(),
                name: "Right".into(),
                bounds: Rect { x: 1920.0, y: 0.0, width: 2560.0, height: 1440.0 },
                scale: 1.0,
                primary: false,
            }],
        };
        let w = window("1", 10, true);
        // Without a layer-shell overlay (GNOME's Shell draws it) bounds stay global.
        if !super::super::layer::available() {
            assert_eq!(overlay_rect(&inv, &w, w.bounds.unwrap()), w.bounds);
        }
    }
}
