//! Shortcuts through the XDG GlobalShortcuts portal, never X11 grabs.
use super::{forget_failure, Backend, Bound, Run, Shortcut};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::Emitter;
use zbus::{
    blocking::{Connection, MessageIterator, Proxy},
    zvariant::{OwnedObjectPath, OwnedValue, Value as BusValue},
    MatchRule,
};

static CONNECTION: Mutex<Option<Connection>> = Mutex::new(None);
type Dict = HashMap<String, OwnedValue>;

/// The portal's id for an action.
pub(super) fn id(name: &str) -> String {
    format!("dev.kimochi.app.{name}")
}

/// A shortcut offered with a bare keysym as its trigger (`Shift_L`), held rather than pressed.
pub(super) struct Held {
    pub name: &'static str,
    pub key: &'static str,
    pub description: &'static str,
}

/// The plain portal, as KDE Plasma and other desktops serve it.
pub(super) struct Portal;

impl Backend for Portal {
    fn id(&self) -> &'static str {
        "portal"
    }
    fn bind(&self, run: &Run, shortcuts: &[Shortcut]) -> Result<Bound, String> {
        bind(run, shortcuts, &[], |_| Vec::new())
    }
    fn stop(&self) {
        if let Some(connection) = CONNECTION.lock().unwrap().take() {
            let _ = connection.close();
        }
    }
}

/// Accelerator spelling is the XDG Shortcuts specification, not Electron syntax.
fn trigger(accelerator: &str) -> String {
    accelerator
        .split('+')
        .map(|part| match part {
            "CommandOrControl" | "Control" | "Ctrl" => "CTRL",
            "Shift" => "SHIFT",
            "Alt" => "ALT",
            "Super" | "Meta" => "LOGO",
            "Space" => "space",
            "Enter" => "Return",
            "ScrollLock" => "Scroll_Lock",
            other => other,
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn text(value: &str) -> OwnedValue {
    OwnedValue::try_from(BusValue::from(value)).expect("owned string")
}

fn request<B: serde::Serialize + zbus::zvariant::DynamicType>(
    conn: &Connection,
    proxy: &Proxy<'_>,
    token: &str,
    method: &str,
    body: &B,
) -> Result<Dict, String> {
    let sender = conn.unique_name().ok_or("missing bus name")?.as_str().trim_start_matches(':').replace('.', "_");
    let path = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
    let request = Proxy::new(conn, "org.freedesktop.portal.Desktop", path.as_str(), "org.freedesktop.portal.Request")
        .map_err(|e| e.to_string())?;
    let mut responses = request.receive_signal("Response").map_err(|e| e.to_string())?;
    let returned: OwnedObjectPath = proxy.call(method, body).map_err(|e| e.to_string())?;
    if returned.as_str() != path {
        return Err("Portal returned an unexpected request handle".into());
    }
    let response = responses.next().ok_or("Portal response stream closed")?;
    let (code, data): (u32, Dict) = response.body().deserialize().map_err(|e| e.to_string())?;
    if code != 0 {
        return Err(if code == 1 {
            "Shortcut configuration cancelled".into()
        } else {
            format!("Shortcut portal refused request (response {code})")
        });
    }
    Ok(data)
}

/// Portals require a desktop entry even for an unsandboxed development build/AppImage.
/// Preserve user entries; only update entries carrying our generated marker.
fn desktop_identity() -> Result<(), String> {
    let home = std::env::var_os("HOME").ok_or("HOME unavailable")?;
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(home).join(".local/share"));
    let applications = data.join("applications");
    let entry = applications.join("Kimochi.desktop");
    let existing = std::fs::read_to_string(&entry).ok();
    let generated = existing.as_deref().is_some_and(|s| s.contains("X-Kimochi-Generated=true"));
    if existing.is_some() && !generated {
        return Ok(());
    }
    let dirs = std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
    // AppImage adds its private usr/share to XDG_DATA_DIRS. The host portal
    // cannot see that mount, so it still needs the generated user entry.
    let appdir = std::env::var_os("APPDIR").map(std::path::PathBuf::from);
    if dirs.split(':').any(|d| {
        let directory = std::path::Path::new(d);
        !appdir.as_ref().is_some_and(|root| directory.starts_with(root))
            && directory.join("applications/Kimochi.desktop").exists()
    }) {
        if generated {
            std::fs::remove_file(&entry).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let executable = std::env::var_os("APPIMAGE")
        .map(std::path::PathBuf::from)
        .unwrap_or(std::env::current_exe().map_err(|e| e.to_string())?);
    let escaped = executable.to_string_lossy().replace('\\', r"\\").replace('"', r#"\""#).replace('%', "%%");
    std::fs::create_dir_all(&applications).map_err(|e| e.to_string())?;
    std::fs::write(entry, format!("[Desktop Entry]\nType=Application\nName=Kimochi\nExec=\"{escaped}\"\nIcon=kimochi\nTerminal=false\nStartupWMClass=kimochi\nCategories=Education;\nX-Kimochi-Generated=true\n")).map_err(|e| e.to_string())
}

/// Bind `shortcuts` and `held` through the portal. `after` gets the portal ids the portal bound
/// and returns failures to report (Hyprland's binds); a shortcut that then fires drops its failure.
pub(super) fn bind(
    run: &Run,
    shortcuts: &[Shortcut],
    held: &[Held],
    after: impl FnOnce(&[String]) -> Vec<Value>,
) -> Result<Bound, String> {
    desktop_identity()?;
    let conn = zbus::blocking::connection::Builder::session()
        .map_err(|e| e.to_string())?
        .method_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    {
        let mut connection = CONNECTION.lock().unwrap();
        if !run.current() {
            return Err("superseded".into());
        }
        *connection = Some(conn.clone());
    }
    // Match Tauri's generated Kimochi.desktop entry. Register this connection
    // before any portal call so unsandboxed builds have a stable application ID.
    let registry = Proxy::new(
        &conn,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.host.portal.Registry",
    )
    .map_err(|e| e.to_string())?;
    // The portal finds Kimochi.desktop through GLib's watched index of desktop files, which
    // learns of an entry `desktop_identity` has only just written a moment later (measured on
    // KDE Plasma 6: the first launch of an AppImage failed with "App info not found").
    let mut attempt = 0;
    loop {
        match registry.call::<_, _, ()>("Register", &("Kimochi", Dict::new())) {
            Ok(()) => break,
            Err(e) if attempt < 10 && e.to_string().contains("App info not found") => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("Could not identify Kimochi to the shortcut portal: {e}")),
        }
    }
    let portal = Proxy::new(
        &conn,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.GlobalShortcuts",
    )
    .map_err(|e| e.to_string())?;
    let token = format!("kimochi_shortcuts_{}", run.generation);
    let mut options = Dict::new();
    options.insert("handle_token".into(), text(&token));
    options.insert("session_handle_token".into(), text(&token));
    let mut result = request(&conn, &portal, &token, "CreateSession", &(options,))?;
    let session = String::try_from(result.remove("session_handle").ok_or("Portal omitted shortcut session")?)
        .map_err(|e| e.to_string())?;
    let session = OwnedObjectPath::try_from(session).map_err(|e| e.to_string())?;
    let mut bindings = Vec::new();
    for shortcut in shortcuts {
        let mut data = Dict::new();
        data.insert("description".into(), text(&shortcut.description));
        data.insert("preferred_trigger".into(), text(&trigger(&shortcut.accelerator)));
        bindings.push((id(&shortcut.name), data));
    }
    for shortcut in held {
        let mut data = Dict::new();
        data.insert("description".into(), text(shortcut.description));
        data.insert("preferred_trigger".into(), text(shortcut.key));
        bindings.push((id(shortcut.name), data));
    }
    let bind_token = format!("{token}_bind");
    let mut options = Dict::new();
    options.insert("handle_token".into(), text(&bind_token));
    let mut result = request(&conn, &portal, &bind_token, "BindShortcuts", &(&session, bindings, "", options))?;
    let rule = MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender("org.freedesktop.portal.Desktop")
        .map_err(|e| e.to_string())?
        .path("/org/freedesktop/portal/desktop")
        .map_err(|e| e.to_string())?
        .interface("org.freedesktop.portal.GlobalShortcuts")
        .map_err(|e| e.to_string())?
        .build();
    let signals = MessageIterator::for_match_rule(rule, &conn, Some(32)).map_err(|e| e.to_string())?;
    if !run.current() {
        return Err("superseded".into());
    }
    let bound: Vec<(String, Dict)> = Vec::try_from(result.remove("shortcuts").ok_or("Portal omitted bound shortcuts")?)
        .map_err(|e| e.to_string())?;
    let bound: Vec<String> = bound.into_iter().map(|(id, _)| id).collect();
    let registered: Vec<String> =
        bound.iter().map(|id| id.strip_prefix("dev.kimochi.app.").unwrap_or(id).to_string()).collect();
    crate::platform::linux::shift::portal_bound(registered.iter().any(|name| name.starts_with("dictionaryShift")));
    let failed = after(&bound);
    let registered: Vec<String> =
        registered.into_iter().filter(|name| !failed.iter().any(|f| f["name"] == name.as_str())).collect();
    let report = json!({"backend":"portal","pending":false,"registered":registered,"failed":failed});
    let app = run.app.clone();
    let generation = run.generation;
    let listen = move || {
        let run = Run { app, generation };
        let mut modifiers = DictionaryModifiers::default();
        for signal in signals {
            if !run.current() {
                break;
            }
            let signal = signal.map_err(|e| e.to_string())?;
            let member = signal.header().member().map(|m| m.as_str().to_owned()).unwrap_or_default();
            if member != "Activated" && member != "Deactivated" {
                continue;
            }
            let (source, id, time, _options): (OwnedObjectPath, String, u64, Dict) =
                signal.body().deserialize().map_err(|e| e.to_string())?;
            if source != session {
                continue;
            }
            let Some(action) = id.strip_prefix("dev.kimochi.app.") else { continue };
            if let Some(shift) = modifiers.update(action, member == "Activated") {
                if crate::platform::linux::shift::portal_shift(shift) {
                    run.capabilities_changed();
                }
                let _ = run.app.emit("linux-dictionary-modifier", json!({"shift":shift}));
                run.record(json!({"check":"dictionary-modifier","shift":shift,
                    "at":crate::now_millis(),"action":action,"edge":member,"portalTimestamp":time}));
                continue;
            }
            if member != "Activated" {
                continue;
            }
            run.record(json!({"check":"global-shortcut-activated","action":action}));
            // It fired, so whatever key the user's config gave it works: no longer a failure.
            if forget_failure(action) {
                run.capabilities_changed();
            }
            run.dispatch(action);
        }
        Ok(())
    };
    Ok(Bound { report, available: true, listen: Some(Box::new(listen)) })
}

#[derive(Default)]
struct DictionaryModifiers {
    left: bool,
    right: bool,
}
impl DictionaryModifiers {
    fn update(&mut self, action: &str, down: bool) -> Option<bool> {
        match action {
            "dictionaryShiftLeft" => self.left = down,
            "dictionaryShiftRight" => self.right = down,
            _ => return None,
        }
        Some(self.left || self.right)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn releasing_one_shift_keeps_the_other_held() {
        let mut state = super::DictionaryModifiers::default();
        assert_eq!(state.update("dictionaryShiftLeft", true), Some(true));
        assert_eq!(state.update("dictionaryShiftRight", true), Some(true));
        assert_eq!(state.update("dictionaryShiftLeft", false), Some(true));
        assert_eq!(state.update("triggerScan", true), None);
        assert_eq!(state.update("dictionaryShiftRight", false), Some(false));
    }
    #[test]
    fn accelerator_uses_xdg_spelling() {
        assert_eq!(super::trigger("CommandOrControl+Shift+8"), "CTRL+SHIFT+8");
        assert_eq!(super::trigger("Ctrl+Shift+Space"), "CTRL+SHIFT+space");
        // Keys bound on their own (#19), in xkb keysym names.
        assert_eq!(super::trigger("Insert"), "Insert");
        assert_eq!(super::trigger("Shift+ScrollLock"), "SHIFT+Scroll_Lock");
    }
}
