//! Read-only Gamescope application identity. Input focus may belong to Steam or
//! Kimochi, so use the graphics app property, never the input-owner property.
use crate::application_context::ApplicationContext;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _};

pub fn available() -> bool {
    super::gamescope::active()
}

fn game_id(id: u32, own: Option<u32>) -> Option<u32> {
    (id != 0 && id != 769 && Some(id) != own).then_some(id)
}

fn detected_id() -> Option<u32> {
    let d = super::x11::desktop()?;
    let atom = d
        .conn
        .intern_atom(true, b"GAMESCOPE_FOCUSED_APP_GFX")
        .ok()?
        .reply()
        .ok()?
        .atom;
    if atom == 0 {
        return None;
    }
    let id = *d.property32(d.root, atom, AtomEnum::CARDINAL)?.first()?;
    game_id(
        id,
        std::env::var("KIMOCHI_STEAM_APP_ID")
            .ok()
            .and_then(|v| v.parse().ok()),
    )
}

// Steam's local manifests contain no credentials. This small quoted-string reader
// handles VDF escapes without interpreting commands or following network URLs.
fn quoted_values(text: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch != '"' {
            continue;
        }
        let mut value = String::new();
        let mut closed = false;
        while let Some(ch) = chars.next() {
            match ch {
                '"' => {
                    closed = true;
                    break;
                }
                '\\' => {
                    if let Some(next) = chars.next() {
                        value.push(next);
                    }
                }
                other => value.push(other),
            }
        }
        if closed {
            values.push(value);
        }
    }
    values
}

fn manifest_name(text: &str, id: u32) -> Option<String> {
    let tokens = quoted_values(text);
    let value = |key: &str| {
        tokens
            .windows(2)
            .find(|pair| pair[0] == key)
            .map(|pair| pair[1].clone())
    };
    if value("appid")?.parse::<u32>().ok()? != id {
        return None;
    }
    let name = value("name")?;
    let name = name.trim();
    (!name.is_empty() && name.len() <= 512 && !name.chars().any(char::is_control))
        .then(|| name.to_string())
}

fn library_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths = vec![home.join(".steam/steam"), home.join(".local/share/Steam")];
    for root in paths.clone() {
        if let Ok(text) = std::fs::read_to_string(root.join("steamapps/libraryfolders.vdf")) {
            for pair in quoted_values(&text).windows(2) {
                if pair[0] == "path" {
                    let path = PathBuf::from(&pair[1]);
                    if path.is_absolute() && !paths.contains(&path) {
                        paths.push(path);
                    }
                }
            }
        }
    }
    paths
}

fn local_name(id: u32) -> Option<String> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    library_paths(&home).into_iter().find_map(|root| {
        let text =
            std::fs::read_to_string(root.join(format!("steamapps/appmanifest_{id}.acf"))).ok()?;
        manifest_name(&text, id)
    })
}

struct Cache {
    at: Instant,
    value: Option<ApplicationContext>,
    names: HashMap<u32, String>,
}
static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

pub fn current() -> Option<ApplicationContext> {
    if !available() {
        return None;
    }
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(c) = cache.as_ref() {
        if c.at.elapsed() < Duration::from_secs(1) {
            return c.value.clone();
        }
    }
    let mut names = cache
        .as_mut()
        .map(|c| std::mem::take(&mut c.names))
        .unwrap_or_default();
    let value = detected_id().and_then(|id| {
        let name = names
            .entry(id)
            .or_insert_with(|| local_name(id).unwrap_or_else(|| format!("Steam game {id}")))
            .clone();
        if name.eq_ignore_ascii_case("kimochi") {
            return None;
        }
        Some(ApplicationContext {
            id: format!("steam:{id}"),
            name,
            provider: "steam".into(),
            manual: false,
        })
    });
    *cache = Some(Cache {
        at: Instant::now(),
        value: value.clone(),
        names,
    });
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ignores_shell_and_own_launcher() {
        assert_eq!(game_id(769, None), None);
        assert_eq!(game_id(0, None), None);
        assert_eq!(game_id(3826138355, Some(3826138355)), None);
        assert_eq!(game_id(1244090, Some(3826138355)), Some(1244090));
    }
    #[test]
    fn verifies_local_manifest_identity_and_handles_unicode_and_escapes() {
        let manifest = r#""AppState" { "appid" "42" "name" "日本語 \"Game\"" }"#;
        assert_eq!(
            manifest_name(manifest, 42).as_deref(),
            Some("日本語 \"Game\"")
        );
        assert_eq!(manifest_name(manifest, 43), None);
        assert_eq!(manifest_name(r#""appid" "42" "name" "  ""#, 42), None);
    }
}
