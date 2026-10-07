//! Optional GNOME Shell actors, never ordinary Wayland overlay windows.
use serde_json::{json, Value};
use std::{sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::Duration};
use tauri::Emitter;
use zbus::blocking::{connection::Builder, Connection, Proxy};

const NAME: &str = "dev.kimochi.GnomeOverlay";
const PATH: &str = "/dev/kimochi/GnomeOverlay";
static CONNECTION: Mutex<Option<Connection>> = Mutex::new(None);
static AVAILABLE: AtomicBool = AtomicBool::new(false);

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
    AVAILABLE.store(result.is_ok(), Ordering::SeqCst);
    result.unwrap_or_else(|error| json!({"available":false,"reason":error}))
}

pub fn request(operation: &str, payload: Value) -> Result<Value, String> {
    if !eligible() { return Err("GNOME integration requires GNOME Wayland without native layer-shell".into()); }
    if operation == "status" { return Ok(status()); }
    if operation == "install" { return install(); }
    let conn = connection()?;
    let proxy = Proxy::new(&conn, NAME, PATH, NAME).map_err(|e| e.to_string())?;
    let method = match operation { "present" => "Present", "clear" => "Clear", "definition" => "Definition", _ => return Err("Unknown GNOME overlay operation".into()) };
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
    if dir.exists() {
        for (name, contents) in files {
            if std::fs::read_to_string(dir.join(name)).map_err(|e| e.to_string())? != contents {
                return Err("An existing Kimochi extension differs; preserve it before installing this build".into());
            }
        }
    } else {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for (name, contents) in files { std::fs::write(dir.join(name), contents).map_err(|e| e.to_string())?; }
    }
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
    Ok(json!({"installed":true,"enabled":enabled.status.success(),"message":"Save your work, log out and log back in, then launch Kimochi. Screen annotations and plain dictionary definitions are supported; crop and Quick Shot remain unavailable."}))
}

pub fn start(app: tauri::AppHandle) {
    if !eligible() { return; }
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
            if result.is_err() { AVAILABLE.store(false, Ordering::SeqCst); }
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
