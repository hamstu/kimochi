//! Keys for Kimochi's portal shortcuts on Hyprland.
//!
//! Hyprland's shortcuts portal registers an application's actions but ignores the keys it asks
//! for: an action fires only when a bind in the Hyprland config dispatches `global` to it
//! (`bind = ALT, Z, global, Kimochi:dev.kimochi.app.triggerScan`). Without one, the Scan shortcut
//! went to the game. While Kimochi runs it adds those binds itself, at runtime only: nothing is
//! written to the config, they go when the shortcuts change or Kimochi quits, they come back
//! after Hyprland reloads its config, and a key combination the config already binds is left
//! alone and reported instead.
//!
//! The dictionary Shift is bound the same way (`Shift_L`/`Shift_R`, non-consuming), so the
//! overlay's words let clicks through to the game until Shift is held, as elsewhere (`shift.rs`).
use serde::Deserialize;
use std::sync::Mutex;

/// Starts the description of every bind Kimochi adds, so one left by a crashed run is known.
const MARK: &str = "Kimochi: ";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Parser {
    /// `hyprland.conf`: `keyword bindd …`.
    Legacy,
    /// `hyprland.lua` (0.55 and later): `eval hl.bind(…)`.
    Lua,
}

#[derive(Clone, Debug, PartialEq)]
struct Combo {
    mods: Vec<&'static str>,
    key: String,
}

impl Combo {
    /// An Electron-style accelerator (`Alt+Z`, `CommandOrControl+Shift+Space`) in Hyprland's terms.
    /// `None` for anything Hyprland could not bind, or whose key is not a plain keysym name.
    fn parse(accelerator: &str) -> Option<Combo> {
        let mut parts: Vec<&str> = accelerator.split('+').map(str::trim).collect();
        let key = parts.pop().filter(|k| !k.is_empty())?;
        let mut mods = Vec::new();
        for part in parts {
            let modifier = match part {
                "CommandOrControl" | "CmdOrCtrl" | "Control" | "Ctrl" => "CTRL",
                "Shift" => "SHIFT",
                "Alt" | "Option" => "ALT",
                "Super" | "Meta" | "Command" | "Cmd" => "SUPER",
                _ => return None,
            };
            if !mods.contains(&modifier) {
                mods.push(modifier);
            }
        }
        let key = match key {
            "Space" => "space",
            "Enter" | "Return" => "Return",
            "Esc" | "Escape" => "Escape",
            "ScrollLock" => "Scroll_Lock",
            "PageUp" => "Prior",
            "PageDown" => "Next",
            other => other,
        };
        // Spelled into a command (and Lua): keysym names only.
        key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_').then(|| Combo { mods, key: key.to_owned() })
    }
    fn modmask(&self) -> u32 {
        self.mods.iter().map(|m| match *m { "SHIFT" => 1, "CTRL" => 4, "ALT" => 8, _ => 64 }).sum()
    }
    fn matches(&self, bind: &Bind) -> bool {
        bind.submap.is_empty() && bind.modmask == self.modmask() && bind.key.eq_ignore_ascii_case(&self.key)
    }
    /// Lua's spelling, `ALT + Z`.
    fn lua(&self) -> String {
        self.mods.iter().map(|m| m.to_string()).chain([self.key.clone()]).collect::<Vec<_>>().join(" + ")
    }
    /// `hyprland.conf`'s, `ALT, Z`.
    fn legacy(&self) -> String {
        format!("{}, {}", self.mods.join(" "), self.key)
    }
    fn label(&self) -> String {
        self.mods.iter().map(|m| match *m { "CTRL" => "Ctrl", "SHIFT" => "Shift", "ALT" => "Alt", _ => "Super" })
            .map(str::to_owned).chain([self.key.clone()]).collect::<Vec<_>>().join("+")
    }
}

#[derive(Deserialize)]
struct Bind {
    modmask: u32,
    key: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    submap: String,
    #[serde(default)]
    dispatcher: String,
    #[serde(default)]
    arg: String,
}

impl Bind {
    /// Whether this bind (one the user wrote, not Kimochi) already fires `global`. A
    /// `hyprland.conf` bind says what it dispatches; a Lua one is opaque (`__lua`), so one whose
    /// description names Kimochi is taken at its word.
    fn fires(&self, global: &str) -> bool {
        (self.dispatcher == "global" && self.arg == global)
            || (self.dispatcher == "__lua" && self.description.to_ascii_lowercase().contains("kimochi"))
    }
}

/// The binds Kimochi added, and the shortcuts it was asked to bind (kept to add them again after
/// Hyprland reloads its config, which drops every bind made at runtime).
static ADDED: Mutex<Vec<Combo>> = Mutex::new(Vec::new());
static WANTED: Mutex<Vec<Shortcut>> = Mutex::new(Vec::new());

/// One portal shortcut to give a key.
#[derive(Clone, Debug)]
pub struct Shortcut {
    /// The portal's shortcut id, `dev.kimochi.app.triggerScan`.
    pub id: String,
    /// Electron-style (`Alt+Z`), or a bare keysym (`Shift_L`).
    pub accelerator: String,
    pub description: String,
    /// Watches a key without taking it from the game (the dictionary Shift): non-consuming,
    /// transparent and whatever else is held. Optional, so never reported when it can't be bound.
    pub passive: bool,
}

fn send(command: String) -> Option<String> {
    super::hyprland::request(command.as_bytes()).map(|reply| String::from_utf8_lossy(&reply).trim().to_owned())
}

/// The config language, once a command has shown it.
static PARSER: Mutex<Option<Parser>> = Mutex::new(None);

/// Send a command in this Hyprland's config language: the legacy parser takes `keyword`, the Lua
/// one refuses it ("keyword can't work with non-legacy parsers") and takes `eval`.
fn command(legacy: String, lua: String) -> Option<String> {
    let known = *PARSER.lock().unwrap();
    if known != Some(Parser::Lua) {
        let reply = send(legacy)?;
        if !reply.contains("non-legacy") {
            *PARSER.lock().unwrap() = Some(Parser::Legacy);
            return Some(reply);
        }
        *PARSER.lock().unwrap() = Some(Parser::Lua);
    }
    send(lua)
}

fn add(combo: &Combo, global: &str, description: &str, passive: bool) -> Option<String> {
    let (flags, options) = if passive { ("nti", ", non_consuming = true, transparent = true, ignore_mods = true") } else { ("", "") };
    command(
        format!("keyword bind{flags}d {},{MARK}{description},global,{global}", combo.legacy()),
        format!("eval hl.bind(\"{}\", hl.dsp.global(\"{global}\"), {{description = \"{MARK}{description}\"{options}}})", combo.lua()),
    )
}

fn remove(combo: &Combo) {
    let _ = command(format!("keyword unbind {}", combo.legacy()), format!("eval hl.unbind(\"{}\")", combo.lua()));
}

/// Whether Kimochi can add binds here (Hyprland, with its socket).
pub fn available() -> bool {
    super::hyprland::available()
}

#[derive(Deserialize)]
struct Global {
    name: String,
}

/// Give each shortcut its key: a bind dispatching to the global shortcut Hyprland registered for
/// its id (`<app id>:<shortcut id>`, the app id as the portal identified Kimochi). Returns the
/// failures as `(shortcut id, reason)`; passive shortcuts are never among them.
pub fn bind(shortcuts: Vec<Shortcut>) -> Vec<(String, String)> {
    unbind();
    *WANTED.lock().unwrap() = shortcuts.clone();
    watch_reloads();
    apply(&shortcuts)
}

fn apply(shortcuts: &[Shortcut]) -> Vec<(String, String)> {
    let Some(existing) = super::hyprland::request(b"j/binds").and_then(|data| serde_json::from_slice::<Vec<Bind>>(&data).ok()) else {
        return shortcuts.iter().filter(|s| !s.passive).map(|s| (s.id.clone(), "Hyprland's socket did not answer".into())).collect();
    };
    // A crashed run's binds still dispatch to this app; take them back rather than call them taken.
    for bind in existing.iter().filter(|b| b.description.starts_with(MARK)) {
        let mods = ["SHIFT", "CTRL", "ALT", "SUPER"].into_iter()
            .filter(|m| bind.modmask & match *m { "SHIFT" => 1, "CTRL" => 4, "ALT" => 8, _ => 64 } != 0).collect();
        remove(&Combo { mods, key: bind.key.clone() });
    }
    let globals: Vec<Global> = super::hyprland::request(b"j/globalshortcuts")
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    let mut failed = Vec::new();
    let mut added = ADDED.lock().unwrap();
    for shortcut in shortcuts {
        let (id, accelerator) = (&shortcut.id, &shortcut.accelerator);
        let mut fail = |reason: String| if !shortcut.passive { failed.push((id.clone(), reason)) };
        let Some(combo) = Combo::parse(accelerator) else {
            fail(format!("{accelerator} can't be bound on Hyprland"));
            continue;
        };
        let Some(global) = globals.iter().rev().map(|g| &g.name).find(|n| {
            // Spelled into a command: an app id is reverse-DNS, nothing else is trusted.
            n.chars().all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
                && n.rsplit_once(':').is_some_and(|(_, tail)| tail == id)
        }) else {
            fail("Hyprland has not registered this shortcut".into());
            continue;
        };
        if let Some(bind) = existing.iter().find(|b| !b.description.starts_with(MARK) && combo.matches(b)) {
            if !bind.fires(global) {
                fail(format!("{} is already bound in your Hyprland config", combo.label()));
            }
            continue;
        }
        match add(&combo, global, &shortcut.description, shortcut.passive) {
            Some(reply) if reply == "ok" => added.push(combo),
            reply => fail(format!("Hyprland refused {}: {}", combo.label(), reply.unwrap_or_default())),
        }
    }
    eprintln!("Hyprland shortcut binds: added {} ({:?} config), {} failed", added.len(), *PARSER.lock().unwrap(), failed.len());
    failed
}

/// Remove every bind Kimochi added, and stop adding them back after reloads.
pub fn unbind() {
    WANTED.lock().unwrap().clear();
    let added = std::mem::take(&mut *ADDED.lock().unwrap());
    for combo in added {
        remove(&combo);
    }
}

/// Add the binds again whenever Hyprland reloads its config (`hyprctl reload`, a saved config,
/// Omarchy changing theme): a reload drops every bind made at runtime. One thread, on Hyprland's
/// event socket, for the life of the process.
fn watch_reloads() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        std::thread::spawn(|| loop {
            if let Some(stream) = super::hyprland::events() {
                use std::io::BufRead;
                for line in std::io::BufReader::new(stream).lines() {
                    let Ok(line) = line else { break };
                    if !line.starts_with("configreloaded>>") {
                        continue;
                    }
                    let wanted = WANTED.lock().unwrap().clone();
                    if wanted.is_empty() {
                        continue;
                    }
                    // The reload already dropped them; unbinding now would take the config's own.
                    ADDED.lock().unwrap().clear();
                    let failed = apply(&wanted);
                    eprintln!("Hyprland config reloaded: shortcut binds added again ({} failed)", failed.len());
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(5));
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerators_become_hyprland_combinations() {
        let scan = Combo::parse("Alt+Z").unwrap();
        assert_eq!((scan.lua(), scan.legacy(), scan.modmask()), ("ALT + Z".into(), "ALT, Z".into(), 8));
        let menu = Combo::parse("CommandOrControl+Shift+Space").unwrap();
        assert_eq!((menu.lua(), menu.modmask(), menu.label()), ("CTRL + SHIFT + space".into(), 5, "Ctrl+Shift+space".into()));
        assert_eq!(Combo::parse("Insert").unwrap().legacy(), ", Insert");
        assert_eq!(Combo::parse("Shift+F9").unwrap().modmask(), 1);
        // Never spelled into a command: quotes, separators, unknown modifiers.
        assert!(Combo::parse("Alt+\"").is_none());
        assert!(Combo::parse("Alt+,").is_none());
        assert!(Combo::parse("Hyper+Z").is_none());
        assert!(Combo::parse("").is_none());
    }

    #[test]
    fn the_users_own_kimochi_bind_is_not_a_conflict() {
        let bind = |v: serde_json::Value| serde_json::from_value::<Bind>(v).unwrap();
        let global = "Kimochi:dev.kimochi.app.triggerScan";
        assert!(bind(serde_json::json!({"modmask":5,"key":"8","dispatcher":"global","arg":global})).fires(global));
        assert!(!bind(serde_json::json!({"modmask":5,"key":"8","dispatcher":"exec","arg":"foot"})).fires(global));
        assert!(bind(serde_json::json!({"modmask":5,"key":"8","dispatcher":"__lua","arg":"265","description":"Kimochi scan"})).fires(global));
        assert!(!bind(serde_json::json!({"modmask":5,"key":"8","dispatcher":"__lua","arg":"12","description":"Screenshot"})).fires(global));
    }

    #[test]
    fn a_taken_combination_is_matched_by_mask_and_key() {
        let bind: Bind = serde_json::from_value(serde_json::json!({"modmask":8,"key":"z","description":"","submap":""})).unwrap();
        assert!(Combo::parse("Alt+Z").unwrap().matches(&bind));
        assert!(!Combo::parse("Alt+Shift+Z").unwrap().matches(&bind));
        let submap: Bind = serde_json::from_value(serde_json::json!({"modmask":8,"key":"Z","submap":"resize"})).unwrap();
        assert!(!Combo::parse("Alt+Z").unwrap().matches(&submap));
    }
}
