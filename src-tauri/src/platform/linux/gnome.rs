//! Optional GNOME Shell actors, never ordinary Wayland overlay windows.
use serde_json::{json, Value};
use std::{sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::Duration};
use tauri::Emitter;
use zbus::blocking::{connection::Builder, Connection, Proxy};

const NAME: &str = "dev.kimochi.GnomeOverlay";
const PATH: &str = "/dev/kimochi/GnomeOverlay";
static CONNECTION: Mutex<Option<Connection>> = Mutex::new(None);
static AVAILABLE: AtomicBool = AtomicBool::new(false);
static DESKTOP_POPUP: AtomicBool = AtomicBool::new(false);

fn eligible() -> bool {
    super::session().backend == super::Backend::Wayland
        && !super::layer::available()
        && super::session().compositor.as_deref() == Some("GNOME")
}

fn connection() -> Result<Connection, String> {
    let mut cached = CONNECTION.lock().map_err(|e| e.to_string())?;
    if cached.is_none() {
        *cached = Some(Builder::session().map_err(|e| e.to_string())?
            .method_timeout(Duration::from_secs(2)).build().map_err(|e| e.to_string())?);
    }
    Ok(cached.as_ref().unwrap().clone())
}

pub fn status() -> Value {
    if !eligible() { return json!({"available":false}); }
    let result = (|| -> Result<Value, String> {
        let conn = connection()?;
        let proxy = Proxy::new(&conn, NAME, PATH, NAME).map_err(|e| e.to_string())?;
        let text: String = proxy.call("Status", &()).map_err(|e| e.to_string())?;
        let mut value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        if value["protocol"] != 1 { return Err("Unsupported GNOME overlay protocol".into()); }
        if value.get("hideButton").is_none() { return Err("GNOME cached an older extension; log out and back in to load the safety update".into()); }
        value["available"] = json!(true);
        Ok(value)
    })();
    DESKTOP_POPUP.store(result.as_ref().is_ok_and(|value| value["desktopPopup"] == true), Ordering::SeqCst);
    AVAILABLE.store(result.is_ok(), Ordering::SeqCst);
    result.unwrap_or_else(|error| json!({"available":false,"reason":error}))
}

pub fn request(operation: &str, payload: Value) -> Result<Value, String> {
    if !eligible() { return Err("GNOME integration requires GNOME Wayland without native layer-shell".into()); }
    if operation == "status" { return Ok(status()); }
    if operation == "install" || operation == "update" { return install(); }
    if operation == "own-window" {
        let conn = connection()?;
        let proxy = Proxy::new(&conn, NAME, PATH, NAME).map_err(|e| e.to_string())?;
        let reply: String = proxy.call("OwnWindow", &(payload.to_string(),)).map_err(|e| e.to_string())?;
        return serde_json::from_str(&reply).map_err(|e| e.to_string());
    }
    let conn = connection()?;
    let proxy = Proxy::new(&conn, NAME, PATH, NAME).map_err(|e| e.to_string())?;
    let method = match operation { "present" => "Present", "clear" => "Clear", _ => return Err("Unknown GNOME overlay operation".into()) };
    if method == "Clear" {
        proxy.call::<_, _, ()>(method, &()).map_err(|e| e.to_string())?;
    } else {
        proxy.call::<_, _, ()>(method, &(payload.to_string(),)).map_err(|e| e.to_string())?;
    }
    Ok(json!({"ok":true}))
}

fn install() -> Result<Value, String> {
    let version = std::process::Command::new("gnome-shell").arg("--version").output().map_err(|e| e.to_string())?;
    if !String::from_utf8_lossy(&version.stdout).starts_with("GNOME Shell 46.") {
        return Err("This integration has been validated only for GNOME 46".into());
    }
    let home = std::env::var_os("XDG_DATA_HOME").map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share")))
        .ok_or("User data directory unavailable")?;
    let dir = home.join("gnome-shell/extensions/kimochi-overlay@hamstu.github.io");
    let files = [("metadata.json", include_str!("../../../gnome-extension/metadata.json")),
        ("extension.js", include_str!("../../../gnome-extension/extension.js"))];
    const IMPLEMENTATION: &str = include_str!("../../../gnome-extension/implementation.js");
    let revision = digest(IMPLEMENTATION)?;
    let running = status();
    let previous_revision = running["revision"].as_str().map(str::to_owned)
        .or_else(|| std::fs::read_to_string(dir.join("revision")).ok());
    let bootstrapping = dir.exists() && std::fs::read_to_string(dir.join("extension.js")).map_err(|e| e.to_string())? != files[1].1;
    if bootstrapping {
        // Accept only the exact previous Kimochi implementation, never arbitrary user edits.
        if digest(&std::fs::read_to_string(dir.join("extension.js")).map_err(|e| e.to_string())?)? != "b9feb3db6467f2378e34287b70cee76b87117153eafdc9cf8941863fc8561941" {
            return Err("Existing Kimochi extension has unrecognized edits; it was not overwritten".into());
        }
        std::fs::copy(dir.join("extension.js"), dir.join("extension.js.pre-loader" )).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(dir.join("revisions")).map_err(|e| e.to_string())?;
    for (name, contents) in files {
        let path = dir.join(name);
        if path.exists() && name == "metadata.json" && std::fs::read_to_string(&path).map_err(|e| e.to_string())? != contents {
            return Err("Existing Kimochi metadata differs; it was not overwritten".into());
        }
        std::fs::write(path, contents).map_err(|e| e.to_string())?;
    }
    let implementation_path = dir.join("revisions").join(format!("{revision}.js"));
    if implementation_path.exists() && std::fs::read_to_string(&implementation_path).map_err(|e| e.to_string())? != IMPLEMENTATION {
        return Err("Immutable GNOME implementation differs".into());
    }
    std::fs::write(implementation_path, IMPLEMENTATION).map_err(|e| e.to_string())?;
    if let Some(previous) = &previous_revision {
        std::fs::write(dir.join("previous-revision"), previous).map_err(|e| e.to_string())?;
    }
    std::fs::write(dir.join("revision.next"), &revision).map_err(|e| e.to_string())?;
    std::fs::rename(dir.join("revision.next"), dir.join("revision")).map_err(|e| e.to_string())?;
    // Register only our UUID, preserving the user's other enabled extensions.
    // GNOME discovers a new local extension at the next login.
    use glib::variant::ToVariant;
    let current = std::process::Command::new("gsettings").args(["get", "org.gnome.shell", "enabled-extensions"]).output().map_err(|e| e.to_string())?;
    if !current.status.success() { return Err(String::from_utf8_lossy(&current.stderr).into_owned()); }
    let text = String::from_utf8_lossy(&current.stdout);
    let variant = glib::Variant::parse(None, text.trim()).map_err(|e| e.to_string())?;
    let mut names = variant.get::<Vec<String>>().ok_or("Unexpected enabled-extensions setting")?;
    let uuid = "kimochi-overlay@hamstu.github.io";
    if !names.iter().any(|name| name == uuid) {
        names.push(uuid.into());
        let result = std::process::Command::new("gsettings").args(["set", "org.gnome.shell", "enabled-extensions", names.to_variant().print(true).as_str()]).output().map_err(|e| e.to_string())?;
        if !result.status.success() { return Err(String::from_utf8_lossy(&result.stderr).into_owned()); }
    }
    let enabled = std::process::Command::new("gnome-extensions").args(["enable", "kimochi-overlay@hamstu.github.io"]).output().map_err(|e| e.to_string())?;
    let restart = || -> Result<(), String> {
        let conn = connection()?;
        let proxy = Proxy::new(&conn, "org.gnome.Shell.Extensions", "/org/gnome/Shell/Extensions", "org.gnome.Shell.Extensions").map_err(|e| e.to_string())?;
        let disabled: bool = proxy.call("DisableExtension", &(uuid,)).map_err(|e| e.to_string())?;
        if !disabled { return Err("GNOME did not disable Kimochi for reload".into()); }
        let enabled: bool = proxy.call("EnableExtension", &(uuid,)).map_err(|e| e.to_string())?;
        if !enabled { return Err("GNOME did not enable Kimochi after reload".into()); }
        Ok(())
    };
    let mut live = false;
    if !bootstrapping {
        let restarted = restart();
        for _ in 0..40 {
            if restarted.is_ok() && status()["revision"] == revision { live = true; break; }
            std::thread::sleep(Duration::from_millis(50));
        }
        if !live {
            if let Some(previous) = previous_revision {
                // Restore the last revision if a hot implementation fails startup.
                std::fs::write(dir.join("revision.next"), previous).map_err(|e| e.to_string())?;
                std::fs::rename(dir.join("revision.next"), dir.join("revision")).map_err(|e| e.to_string())?;
                restart()?;
            }
        }
    }
    Ok(json!({"installed":true,"enabled":enabled.status.success(),"revision":revision,"live":live,"needsLogin":!live && !status()["desktopPopup"].as_bool().unwrap_or(false),
        "message":if live { "GNOME extension updated in place; no logout required." } else if status()["desktopPopup"] == true { "Update could not be verified; the previous implementation was restored. See GNOME extension errors." } else { "The versioned loader is installed. GNOME has cached the old entry point; save your work and log out/in once. Future implementation updates reload in place." }}))
}

pub fn start(app: tauri::AppHandle) {
    if !eligible() { return; }
    let dismiss_app = app.clone();
    let _ = std::thread::Builder::new().name("gnome-popup-dismiss".into()).spawn(move || loop {
        let _ = (|| -> Result<(), String> {
            let conn = connection()?;
            let proxy = Proxy::new(&conn, NAME, PATH, NAME).map_err(|e| e.to_string())?;
            for _ in proxy.receive_signal("Dismiss").map_err(|e| e.to_string())? {
                let _ = dismiss_app.emit("gnome-popup-dismiss", ());
            }
            Ok(())
        })();
        std::thread::sleep(Duration::from_secs(2));
    });
    let _ = std::thread::Builder::new().name("gnome-overlay-events".into()).spawn(move || {
        loop {
            let result = (|| -> Result<(), String> {
                let conn = connection()?;
                let proxy = Proxy::new(&conn, NAME, PATH, NAME).map_err(|e| e.to_string())?;
                let events = proxy.receive_signal("Lookup").map_err(|e| e.to_string())?;
                for event in events {
                    let (text,): (String,) = event.body().deserialize().map_err(|e| e.to_string())?;
                    if text.len() > 4096 { continue; }
                    if let Ok(payload) = serde_json::from_str::<Value>(&text) {
                        let _ = app.emit("gnome-overlay-lookup", payload);
                    }
                }
                Ok(())
            })();
            if result.is_err() { AVAILABLE.store(false, Ordering::SeqCst); DESKTOP_POPUP.store(false, Ordering::SeqCst); }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

pub struct Suppressed(bool);
impl Drop for Suppressed {
    fn drop(&mut self) {
        if self.0 { let _ = suspend(false); }
    }
}
fn suspend(on: bool) -> Result<bool, String> {
    let conn = connection()?;
    Proxy::new(&conn, NAME, PATH, NAME).map_err(|e| e.to_string())?
        .call("Suspend", &(on,)).map_err(|e| e.to_string())
}
pub fn suppress() -> Result<Suppressed, String> {
    if !eligible() || !AVAILABLE.load(Ordering::SeqCst) { return Ok(Suppressed(false)); }
    if suspend(true)? { super::capture::mark_hidden(); }
    Ok(Suppressed(true))
}

/// Only a supported GNOME own-window bridge may supply otherwise unavailable origins.
pub fn desktop_popup() -> bool { eligible() && DESKTOP_POPUP.load(Ordering::SeqCst) }
pub fn own_bounds(w: &tauri::WebviewWindow) -> Result<kimochi_capture::Rect, String> {
    let value = request("own-window", json!({"label":w.label()}))?;
    serde_json::from_value(value).map_err(|e| e.to_string())
}

pub fn eligible_popup_session() -> bool { eligible() }

fn digest(contents: &str) -> Result<String, String> {
    let mut checksum = glib::Checksum::new(glib::ChecksumType::Sha256).ok_or("SHA256 unavailable")?;
    checksum.update(contents.as_bytes());
    checksum.string().ok_or_else(|| "Missing SHA digest".into())
}
