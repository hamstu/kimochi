//! Wayland action shortcuts through the desktop portal, never X11 grabs.
use crate::{
    actions,
    settings::{merged_hotkeys, Settings},
    state::Shared,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use zbus::{
    blocking::{Connection, MessageIterator, Proxy},
    zvariant::{OwnedObjectPath, OwnedValue, Value as BusValue},
    MatchRule,
};

static GENERATION: AtomicU64 = AtomicU64::new(0);
static AVAILABLE: AtomicBool = AtomicBool::new(false);
static CONNECTION: Mutex<Option<Connection>> = Mutex::new(None);
static REPORT: Mutex<Option<Value>> = Mutex::new(None);
type Dict = HashMap<String, OwnedValue>;

pub fn available() -> bool {
    AVAILABLE.load(Ordering::SeqCst)
}
pub fn report() -> Value {
    REPORT
        .lock()
        .unwrap()
        .clone()
        .unwrap_or(json!({"backend":"portal","pending":true}))
}
pub fn dispatch_gnome(app:&tauri::AppHandle,name:&str) {
    let allowed=report();
    if available() && allowed["backend"]=="gnome-shell" && allowed["registered"].as_array().is_some_and(|keys|keys.iter().any(|key|key==name)) && actions::ACTIONS.contains(&name) {
        crate::record(app,&app.state::<Shared>(),json!({"check":"global-shortcut-activated","backend":"gnome-shell","action":name}));
        actions::dispatch(app,&app.state::<Shared>(),name);
    }
}

pub fn stop() {
    if report()["backend"]=="gnome-shell" {let _=super::gnome::request("shortcuts",json!({"bindings":[]}));}
    GENERATION.fetch_add(1, Ordering::SeqCst);
    AVAILABLE.store(false, Ordering::SeqCst);
    if let Some(connection) = CONNECTION.lock().unwrap().take() {
        let _ = connection.close();
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
    let sender = conn
        .unique_name()
        .ok_or("missing bus name")?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let path = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
    let request = Proxy::new(
        conn,
        "org.freedesktop.portal.Desktop",
        path.as_str(),
        "org.freedesktop.portal.Request",
    )
    .map_err(|e| e.to_string())?;
    let mut responses = request
        .receive_signal("Response")
        .map_err(|e| e.to_string())?;
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

pub fn apply(app: &tauri::AppHandle, settings: &Arc<Settings>, suspended: bool) -> Value {
    stop();
    let _ = app.emit("linux-dictionary-modifier", json!({"shift":false}));
    if suspended {
        return json!({"registered":[],"failed":[],"suspended":true,"backend":"portal"});
    }
    let generation = GENERATION.load(Ordering::SeqCst);
    let definitions = merged_hotkeys(settings);
    let app = app.clone();
    let pending = json!({"registered":[],"failed":[],"backend":"portal","pending":true});
    *REPORT.lock().unwrap() = Some(pending.clone());
    std::thread::spawn(move || {
        let result = if super::gnome::status()["nativeShortcuts"]==true {bind_gnome(&app,definitions,generation)}else{bind(&app,definitions,generation)};
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Err(error) = result {
            AVAILABLE.store(false, Ordering::SeqCst);
            let _ = app.emit("linux-dictionary-modifier", json!({"shift":false}));
            let report = json!({"registered":[],"failed":[{"name":"Wayland shortcuts","error":error}],"backend":"portal","pending":false});
            *REPORT.lock().unwrap() = Some(report.clone());
            crate::record(
                &app,
                &app.state::<Shared>(),
                json!({"check":"global-shortcuts","report":report}),
            );
            let _ = app.emit(
                "platform-capabilities",
                crate::capabilities_value(&app, &app.state::<Shared>()),
            );
        }
    });
    pending
}

fn gtk_trigger(accelerator:&str)->String {
    let mut result=String::new();
    for part in accelerator.split('+') {
        result.push_str(match part {"CommandOrControl"|"Control"|"Ctrl"=>"<Control>","Shift"=>"<Shift>","Alt"=>"<Alt>","Super"|"Meta"=>"<Super>","Space"=>"space","Enter"=>"Return",other=>other});
    }result
}

fn bind_gnome(app:&tauri::AppHandle,definitions:serde_json::Map<String,Value>,generation:u64)->Result<(),String>{
    let bindings:Vec<Value>=definitions.into_iter().filter(|(name,d)|actions::ACTIONS.contains(&name.as_str())&&d["enabled"]!=false).filter_map(|(name,d)|d["accelerator"].as_str().filter(|s|!s.is_empty()).map(|s|json!({"name":name,"accelerator":gtk_trigger(s)}))).collect();
    let result=super::gnome::request("shortcuts",json!({"bindings":bindings}))?;
    if GENERATION.load(Ordering::SeqCst)!=generation{return Ok(());}
    AVAILABLE.store(result["registered"].as_array().is_some_and(|v|!v.is_empty()),Ordering::SeqCst);
    *REPORT.lock().unwrap()=Some(result.clone());
    crate::record(app,&app.state::<Shared>(),json!({"check":"global-shortcuts","report":result}));
    let _=app.emit("platform-capabilities",crate::capabilities_value(app,&app.state::<Shared>()));Ok(())
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
    let generated = existing
        .as_deref()
        .is_some_and(|s| s.contains("X-Kimochi-Generated=true"));
    if existing.is_some() && !generated {
        return Ok(());
    }
    let dirs =
        std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
    // AppImage adds its private usr/share to XDG_DATA_DIRS. The host portal
    // cannot see that mount, so it still needs the generated user entry.
    let appdir = std::env::var_os("APPDIR").map(std::path::PathBuf::from);
    if dirs.split(':').any(|d| {
        let directory = std::path::Path::new(d);
        !appdir
            .as_ref()
            .is_some_and(|root| directory.starts_with(root))
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
    let escaped = executable
        .to_string_lossy()
        .replace('\\', r"\\")
        .replace('"', r#"\""#)
        .replace('%', "%%");
    std::fs::create_dir_all(&applications).map_err(|e| e.to_string())?;
    std::fs::write(entry, format!("[Desktop Entry]\nType=Application\nName=Kimochi\nExec=\"{escaped}\"\nIcon=kimochi\nTerminal=false\nStartupWMClass=kimochi\nCategories=Education;\nX-Kimochi-Generated=true\n")).map_err(|e| e.to_string())
}

fn bind(
    app: &tauri::AppHandle,
    definitions: serde_json::Map<String, Value>,
    generation: u64,
) -> Result<(), String> {
    desktop_identity()?;
    let conn = zbus::blocking::connection::Builder::session()
        .map_err(|e| e.to_string())?
        .method_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    {
        let mut connection = CONNECTION.lock().unwrap();
        if GENERATION.load(Ordering::SeqCst) != generation {
            return Ok(());
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
    let _: () = registry
        .call("Register", &("Kimochi", Dict::new()))
        .map_err(|e| format!("Could not identify Kimochi to the shortcut portal: {e}"))?;
    let portal = Proxy::new(
        &conn,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.GlobalShortcuts",
    )
    .map_err(|e| e.to_string())?;
    let token = format!("kimochi_shortcuts_{generation}");
    let mut options = Dict::new();
    options.insert("handle_token".into(), text(&token));
    options.insert("session_handle_token".into(), text(&token));
    let mut result = request(&conn, &portal, &token, "CreateSession", &(options,))?;
    let session = String::try_from(
        result
            .remove("session_handle")
            .ok_or("Portal omitted shortcut session")?,
    )
    .map_err(|e| e.to_string())?;
    let session = OwnedObjectPath::try_from(session).map_err(|e| e.to_string())?;
    let mut bindings = Vec::new();
    for (name, definition) in definitions {
        if definition["enabled"] == json!(false) {
            continue;
        }
        let Some(accelerator) = definition["accelerator"].as_str() else {
            continue;
        };
        let mut data = Dict::new();
        data.insert(
            "description".into(),
            text(match name.as_str() {
                "triggerScan" => "Scan Japanese text",
                "openControllerMenu" => "Open Kimochi controls",
                _ => &name,
            }),
        );
        data.insert("preferred_trigger".into(), text(&trigger(accelerator)));
        bindings.push((format!("dev.kimochi.app.{name}"), data));
    }
    // Hyprland supports non-consuming modifier-only desktop bindings. Other
    // portal backends may reject modifier-only accelerators, so do not add them
    // there or advertise a raw/global keyboard watcher.
    if super::session()
        .compositor
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase()
        .contains("hypr")
    {
        for (name, key) in [
            ("dictionaryShiftLeft", "Shift_L"),
            ("dictionaryShiftRight", "Shift_R"),
        ] {
            let mut data = Dict::new();
            data.insert(
                "description".into(),
                text("Hold Shift for dictionary lookup"),
            );
            data.insert("preferred_trigger".into(), text(key));
            bindings.push((format!("dev.kimochi.app.{name}"), data));
        }
    }
    let bind_token = format!("{token}_bind");
    let mut options = Dict::new();
    options.insert("handle_token".into(), text(&bind_token));
    let mut result = request(
        &conn,
        &portal,
        &bind_token,
        "BindShortcuts",
        &(&session, bindings, "", options),
    )?;
    let rule = MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender("org.freedesktop.portal.Desktop")
        .map_err(|e| e.to_string())?
        .path("/org/freedesktop/portal/desktop")
        .map_err(|e| e.to_string())?
        .interface("org.freedesktop.portal.GlobalShortcuts")
        .map_err(|e| e.to_string())?
        .build();
    let signals =
        MessageIterator::for_match_rule(rule, &conn, Some(32)).map_err(|e| e.to_string())?;
    if GENERATION.load(Ordering::SeqCst) != generation {
        return Ok(());
    }
    AVAILABLE.store(true, Ordering::SeqCst);
    let bound: Vec<(String, Dict)> = Vec::try_from(
        result
            .remove("shortcuts")
            .ok_or("Portal omitted bound shortcuts")?,
    )
    .map_err(|e| e.to_string())?;
    let registered: Vec<String> = bound
        .iter()
        .map(|(id, _)| {
            id.strip_prefix("dev.kimochi.app.")
                .unwrap_or(id)
                .to_string()
        })
        .collect();
    let report = json!({"backend":"portal","pending":false,"registered":registered,"failed":[]});
    *REPORT.lock().unwrap() = Some(report.clone());
    crate::record(
        app,
        &app.state::<Shared>(),
        json!({"check":"global-shortcuts","report":report}),
    );
    let _ = app.emit(
        "platform-capabilities",
        crate::capabilities_value(app, &app.state::<Shared>()),
    );
    let mut modifiers = DictionaryModifiers::default();
    for signal in signals {
        if GENERATION.load(Ordering::SeqCst) != generation {
            break;
        }
        let signal = signal.map_err(|e| e.to_string())?;
        let member = signal
            .header()
            .member()
            .map(|m| m.as_str().to_owned())
            .unwrap_or_default();
        if member != "Activated" && member != "Deactivated" {
            continue;
        }
        let (source, id, _time, _options): (OwnedObjectPath, String, u64, Dict) =
            signal.body().deserialize().map_err(|e| e.to_string())?;
        if source != session {
            continue;
        }
        if let Some(action) = id.strip_prefix("dev.kimochi.app.") {
            if let Some(shift) = modifiers.update(action, member == "Activated") {
                let _ = app.emit("linux-dictionary-modifier", json!({"shift":shift}));
                crate::record(
                    app,
                    &app.state::<Shared>(),
                    json!({"check":"dictionary-modifier","shift":shift,
                        "at":crate::now_millis(),"action":action,"edge":member,"portalTimestamp":_time}),
                );
                continue;
            }
            if member != "Activated" {
                continue;
            }
            crate::record(
                app,
                &app.state::<Shared>(),
                json!({"check":"global-shortcut-activated","action":action}),
            );
            actions::dispatch(app, &app.state::<Shared>(), action);
        }
    }
    Ok(())
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
    }
}
