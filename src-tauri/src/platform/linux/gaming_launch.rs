//! Kimochi started in Gaming Mode without its launcher: the AppImage added to Steam by hand,
//! rather than through **Add to Steam** or the Gaming Mode installer.
//!
//! Steam starts every Gaming Mode app with `XDG_CURRENT_DESKTOP=gamescope`, but Kimochi's
//! Gamescope mode needs the rest of what `scripts/steam-deck/launch-from-steam.sh` and
//! `launch-gaming-mode.sh` set: the Gamescope Wayland socket its capture uses, XWayland `:0`
//! for its windows, the Steam app ID, and `KIMOCHI_GAMESCOPE_OVERLAY`. Without them Kimochi ran
//! as a plain X11 app inside Gamescope: the only source was a screen that X11 cannot read
//! ("X11 error … GetImage"), and no game could be chosen.
//!
//! So `relaunch_if_needed` runs this executable again, once, with the launcher's environment,
//! before anything else starts. The scripts stay the reference: a test checks every variable
//! they set is set here too. `KIMOCHI_GAMING_RELAUNCHED=1` marks the second run (it is in the
//! `startup` record), and `KIMOCHI_NO_GAMING_RELAUNCH=1` turns this off.
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// One change to the environment: set to a value, or removed.
type Change = (&'static str, Option<String>);

/// What the launcher scripts would change, when this process is in Gamescope without them;
/// `None` when it already has them, is elsewhere, or Gamescope's Wayland socket is missing (the
/// script refuses to start then, and the plain X11 path is all there is).
fn launcher_env(
    get: impl Fn(&str) -> Option<String>,
    socket_exists: impl Fn(&Path) -> bool,
    uid: u32,
) -> Option<Vec<Change>> {
    let set = |key: &str| get(key).filter(|value| !value.is_empty());
    let in_gamescope = set("XDG_CURRENT_DESKTOP").is_some_and(|desktop| desktop.eq_ignore_ascii_case("gamescope"));
    if !in_gamescope || set("KIMOCHI_GAMESCOPE_OVERLAY").is_some() || set("KIMOCHI_NO_GAMING_RELAUNCH").is_some() {
        return None;
    }
    let runtime = set("XDG_RUNTIME_DIR").unwrap_or_else(|| format!("/run/user/{uid}"));
    let wayland = set("KIMOCHI_GAMESCOPE_DISPLAY").unwrap_or_else(|| "gamescope-0".into());
    let socket = if wayland.starts_with('/') { PathBuf::from(&wayland) } else { Path::new(&runtime).join(&wayland) };
    if !socket_exists(&socket) {
        return None;
    }
    // launch-from-steam.sh
    let scale = set("KIMOCHI_GAMESCOPE_SCALE")
        .filter(|s| matches!(s.as_str(), "1" | "2" | "3" | "4"))
        .unwrap_or_else(|| "1".into());
    let ui_scale = set("KIMOCHI_GAMESCOPE_UI_SCALE").unwrap_or_else(|| "1.5".into());
    let app_id = set("KIMOCHI_STEAM_APP_ID").or_else(|| set("SteamAppId")).unwrap_or_default();
    let bus = set("DBUS_SESSION_BUS_ADDRESS").unwrap_or_else(|| format!("unix:path={runtime}/bus"));
    Some(vec![
        // Steam's overlay preload belongs to games, not to Kimochi.
        ("LD_PRELOAD", None),
        ("DISPLAY", Some(":0".into())),
        ("KIMOCHI_GAMESCOPE_SCALE", Some(scale.clone())),
        ("KIMOCHI_GAMESCOPE_UI_SCALE", Some(ui_scale)),
        ("KIMOCHI_STEAM_APP_ID", Some(app_id)),
        ("KIMOCHI_STEAM_MANAGED", Some("1".into())),
        // launch-gaming-mode.sh
        ("XDG_RUNTIME_DIR", Some(runtime)),
        ("WAYLAND_DISPLAY", Some(wayland)),
        ("XDG_SESSION_TYPE", Some("wayland".into())),
        ("XDG_CURRENT_DESKTOP", Some("gamescope".into())),
        ("GDK_BACKEND", Some("x11".into())),
        ("KIMOCHI_GAMESCOPE_OVERLAY", Some("x11".into())),
        ("GDK_SCALE", Some(scale)),
        ("GDK_DPI_SCALE", Some("1".into())),
        ("DBUS_SESSION_BUS_ADDRESS", Some(bus)),
        ("KIMOCHI_GAMING_RELAUNCHED", Some("1".into())),
    ])
}

/// Runs this executable again with the launcher's environment when it was started in Gaming
/// Mode without it. Returns only when that isn't needed or the new run could not start.
pub fn relaunch_if_needed() {
    let uid = unsafe { libc::getuid() };
    let Some(changes) = launcher_env(|key| std::env::var(key).ok(), |path| path.exists(), uid) else { return };
    let Ok(exe) = std::env::current_exe() else { return };
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let mut command = std::process::Command::new(exe);
    command.args(args);
    for (key, value) in changes {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
    eprintln!("Kimochi: started in Gaming Mode without its launcher; restarting with the launcher's settings");
    use std::os::unix::process::CommandExt as _;
    // `exec` keeps this process (Steam keeps tracking it, an AppImage keeps its mount); it only
    // returns on failure, and then Kimochi carries on as it was started.
    let error = command.exec();
    eprintln!("Kimochi: Gaming Mode restart failed: {error}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn changes(vars: &[(&str, &str)], socket: bool) -> Option<HashMap<&'static str, Option<String>>> {
        let vars: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        launcher_env(|key| vars.get(key).cloned(), |_| socket, 1000).map(|c| c.into_iter().collect())
    }

    #[test]
    fn a_hand_added_appimage_in_gaming_mode_gets_the_launchers_environment() {
        let steam = [
            ("XDG_CURRENT_DESKTOP", "gamescope"),
            ("XDG_SESSION_TYPE", "x11"),
            ("DISPLAY", ":1"),
            ("SteamAppId", "3141592653"),
            ("LD_PRELOAD", "/home/deck/.local/share/Steam/ubuntu12_32/gameoverlayrenderer.so"),
        ];
        let env = changes(&steam, true).expect("relaunch");
        assert_eq!(env["KIMOCHI_GAMESCOPE_OVERLAY"].as_deref(), Some("x11"));
        assert_eq!(env["WAYLAND_DISPLAY"].as_deref(), Some("gamescope-0"));
        assert_eq!(env["XDG_RUNTIME_DIR"].as_deref(), Some("/run/user/1000"));
        assert_eq!(env["DISPLAY"].as_deref(), Some(":0"));
        assert_eq!(env["KIMOCHI_STEAM_APP_ID"].as_deref(), Some("3141592653"));
        assert_eq!(env["GDK_SCALE"].as_deref(), Some("1"));
        assert_eq!(env["LD_PRELOAD"], None);
        assert!(env.contains_key("LD_PRELOAD"));
        // No socket: the launcher would refuse too, so nothing changes.
        assert!(changes(&steam, false).is_none());
    }

    #[test]
    fn the_launcher_desktop_mode_and_the_escape_hatch_are_left_alone() {
        let launched = [("XDG_CURRENT_DESKTOP", "gamescope"), ("KIMOCHI_GAMESCOPE_OVERLAY", "x11")];
        assert!(changes(&launched, true).is_none());
        assert!(changes(&[("XDG_CURRENT_DESKTOP", "KDE")], true).is_none());
        assert!(changes(&[], true).is_none());
        let off = [("XDG_CURRENT_DESKTOP", "gamescope"), ("KIMOCHI_NO_GAMING_RELAUNCH", "1")];
        assert!(changes(&off, true).is_none());
    }

    /// The scripts are the reference: everything they export or unset is set here too.
    #[test]
    fn every_variable_the_launcher_scripts_set_is_set() {
        let env = changes(&[("XDG_CURRENT_DESKTOP", "gamescope")], true).unwrap();
        let scripts = concat!(
            include_str!("../../../../scripts/steam-deck/launch-from-steam.sh"),
            include_str!("../../../../scripts/steam-deck/launch-gaming-mode.sh"),
        );
        let mut names = Vec::new();
        for line in scripts.lines().map(str::trim) {
            let Some(rest) = line.strip_prefix("export ").or_else(|| line.strip_prefix("unset ")) else { continue };
            names.extend(rest.split_whitespace().map(|word| word.split('=').next().unwrap_or(word)));
        }
        assert!(names.len() > 10, "{names:?}");
        for name in names {
            assert!(env.contains_key(name), "launch scripts set {name}, the relaunch does not");
        }
    }
}
