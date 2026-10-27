//! Optional GNOME Shell integration for validated Kimochi Wayland surfaces.
use serde_json::{json, Value};
use std::{sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::Duration};
use tauri::{Emitter, Manager};
use zbus::blocking::{connection::Builder, Connection, Proxy};

const NAME: &str = "dev.kimochi.GnomeOverlay";
const PATH: &str = "/dev/kimochi/GnomeOverlay";
static CONNECTION: Mutex<Option<Connection>> = Mutex::new(None);
static AVAILABLE: AtomicBool = AtomicBool::new(false);
static DESKTOP_POPUP: AtomicBool = AtomicBool::new(false);
static SHARED_OVERLAY: AtomicBool = AtomicBool::new(false);
static PANEL_PINS: AtomicBool = AtomicBool::new(false);
static PIN_REVISION: Mutex<Option<String>> = Mutex::new(None);

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
    SHARED_OVERLAY.store(result.as_ref().is_ok_and(|value| value["sharedOverlay"] == true), Ordering::SeqCst);
    PANEL_PINS.store(result.as_ref().is_ok_and(|value| value["windowPolicy"] == true), Ordering::SeqCst);
    DESKTOP_POPUP.store(result.as_ref().is_ok_and(|value| value["desktopPopup"] == true), Ordering::SeqCst);
    AVAILABLE.store(result.is_ok(), Ordering::SeqCst);
    if result.is_err() { *PIN_REVISION.lock().unwrap() = None; }
    result.unwrap_or_else(|error| json!({"available":false,"reason":error}))
}

pub fn request(operation: &str, payload: Value) -> Result<Value, String> {
    // Capability probes are valid on every Linux desktop. Only actual GNOME
    // operations require eligibility; otherwise optional integration breaks lookup.
    if operation == "status" { return Ok(status()); }
    if !eligible() { return Err("GNOME integration requires GNOME Wayland without native layer-shell".into()); }
    if operation == "install" || operation == "update" { return install(); }
    if operation == "crop" || operation == "track" || operation == "shortcuts" || operation == "controller" || operation == "surface" {
        let conn = connection()?;
        let proxy = Proxy::new(&conn, NAME, PATH, NAME).map_err(|e| e.to_string())?;
        let reply: String = proxy.call(match operation { "surface" => "Surface", "crop" => "Crop", "track" => "Track", "controller" => "Controller", _ => "Shortcuts" }, &(payload.to_string(),)).map_err(|e| e.to_string())?;
        return serde_json::from_str(&reply).map_err(|e| e.to_string());
    }
    if operation == "own-window" {
        let conn = connection()?;
        let proxy = Proxy::new(&conn, NAME, PATH, NAME).map_err(|e| e.to_string())?;
        let reply: String = proxy.call("OwnWindow", &(payload.to_string(),)).map_err(|e| e.to_string())?;
        return serde_json::from_str(&reply).map_err(|e| e.to_string());
    }
    let conn = connection()?;
    let proxy = Proxy::new(&conn, NAME, PATH, NAME).map_err(|e| e.to_string())?;
    let method = match operation { "present" => "Present", "clear" => "Clear", "highlight" => "Highlight", _ => return Err("Unknown GNOME overlay operation".into()) };
    if method == "Clear" {
        proxy.call::<_, _, ()>(method, &()).map_err(|e| e.to_string())?;
    } else {
        proxy.call::<_, _, ()>(method, &(payload.to_string(),)).map_err(|e| e.to_string())?;
    }
    Ok(json!({"ok":true}))
}

#[cfg(test)]
mod status_tests {
    #[test]
    fn optional_integration_status_is_queryable_on_any_desktop() {
        let status = super::request("status", serde_json::Value::Null)
            .expect("an unsupported desktop reports unavailable, not an IPC error");
        assert!(status["available"].is_boolean());
    }
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
        // Accept only exact known Kimochi entry points, never arbitrary user edits.
        let installed = std::fs::read_to_string(dir.join("extension.js")).map_err(|e| e.to_string())?;
        let installed_hash = digest(&installed)?;
        if !["b9feb3db6467f2378e34287b70cee76b87117153eafdc9cf8941863fc8561941",
            "f5bd97906b2e33b5d684b5ddaab6c73dad6deba51cc49d9c0e80f084fd3268d5"].contains(&installed_hash.as_str()) {
            return Err("Existing Kimochi extension has unrecognized edits; it was not overwritten".into());
        }
        let backup = dir.join(format!("extension.js.before-{installed_hash}"));
        if backup.exists() && std::fs::read_to_string(&backup).map_err(|e|e.to_string())? != installed {
            return Err("Existing Kimochi loader backup differs; it was not overwritten".into());
        }
        if !backup.exists() { std::fs::copy(dir.join("extension.js"), backup).map_err(|e| e.to_string())?; }
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
    Ok(json!({"installed":true,"enabled":enabled.status.success(),"revision":revision,"live":live,"needsLogin":bootstrapping || !live && !status()["desktopPopup"].as_bool().unwrap_or(false),
        "message":if bootstrapping { "The updated extension loader needs a new login. Save your work and log out/in once; implementation-only updates can still reload in place afterward." } else if live { "GNOME extension updated in place; no logout required." } else if status()["desktopPopup"] == true { "Update could not be verified; the previous implementation was restored. See GNOME extension errors." } else { "The versioned loader is installed. GNOME has cached the old entry point; save your work and log out/in once. Future implementation updates reload in place." }}))
}

pub fn start(app: tauri::AppHandle) {
    if !eligible() { return; }
    let pointer_app = app.clone();
    let _ = std::thread::Builder::new().name("gnome-shared-pointer".into()).spawn(move || loop {
        let _ = (|| -> Result<(), String> {
            let conn = connection()?;
            let proxy = Proxy::new(&conn, NAME, PATH, NAME).map_err(|e| e.to_string())?;
            for event in proxy.receive_signal("Pointer").map_err(|e| e.to_string())? {
                let (text,): (String,) = event.body().deserialize().map_err(|e| e.to_string())?;
                if text.len() <= 4096 {
                    if let Ok(payload) = serde_json::from_str::<Value>(&text) {
                        let _ = pointer_app.emit_to("overlay", "pointer", payload);
                    }
                }
            }
            Ok(())
        })();
        std::thread::sleep(Duration::from_secs(2));
    });
    let action_app=app.clone();
    let _=std::thread::Builder::new().name("gnome-action-events".into()).spawn(move || loop {
        let _=(|| -> Result<(),String> {
            let conn=connection()?;let proxy=Proxy::new(&conn,NAME,PATH,NAME).map_err(|e|e.to_string())?;
            for event in proxy.receive_signal("Action").map_err(|e|e.to_string())? {
                let (name,):(String,)=event.body().deserialize().map_err(|e|e.to_string())?;
                if name=="controllerClosed" {let _=action_app.emit("gnome-controller-closed",());} else {super::shortcuts::dispatch_gnome(&action_app,&name);}
            } Ok(())
        })();std::thread::sleep(Duration::from_secs(2));
    });
    let track_app = app.clone();
    let _ = std::thread::Builder::new().name("gnome-track-events".into()).spawn(move || loop {
        let _ = (|| -> Result<(), String> {
            let conn = connection()?;
            let proxy = Proxy::new(&conn, NAME, PATH, NAME).map_err(|e| e.to_string())?;
            for event in proxy.receive_signal("TrackResult").map_err(|e| e.to_string())? {
                let (text,): (String,) = event.body().deserialize().map_err(|e| e.to_string())?;
                if text.len() <= 4096 {
                    if let Ok(payload) = serde_json::from_str::<Value>(&text) {
                        if payload["linked"]==true {if let Some(id)=payload["sourceId"].as_str(){refresh_identity(&track_app.state::<crate::state::Shared>(),id);}}
                        let _ = track_app.emit("gnome-track-result", payload);
                    }
                }
            }
            Ok(())
        })();
        std::thread::sleep(Duration::from_secs(2));
    });
    let crop_app = app.clone();
    let _ = std::thread::Builder::new().name("gnome-crop-events".into()).spawn(move || loop {
        let _ = (|| -> Result<(), String> {
            let conn = connection()?;
            let proxy = Proxy::new(&conn, NAME, PATH, NAME).map_err(|e| e.to_string())?;
            for event in proxy.receive_signal("CropResult").map_err(|e| e.to_string())? {
                let (text,): (String,) = event.body().deserialize().map_err(|e| e.to_string())?;
                if text.len() <= 4096 {
                    if let Ok(payload) = serde_json::from_str::<Value>(&text) {
                        super::capture::mark_hidden();
                        let _ = crop_app.emit("gnome-crop-result", payload);
                    }
                }
            }
            Ok(())
        })();
        std::thread::sleep(Duration::from_secs(2));
    });
    let modifier_app = app.clone();
    let _ = std::thread::Builder::new().name("gnome-modifier".into()).spawn(move || loop {
        let _ = (|| -> Result<(), String> {
            let conn = connection()?;
            let proxy = Proxy::new(&conn, NAME, PATH, NAME).map_err(|e| e.to_string())?;
            for event in proxy.receive_signal("Modifier").map_err(|e| e.to_string())? {
                let (shift,): (bool,) = event.body().deserialize().map_err(|e| e.to_string())?;
                let _ = modifier_app.emit("linux-dictionary-modifier", json!({"shift":shift}));
            }
            Ok(())
        })();
        std::thread::sleep(Duration::from_secs(2));
    });
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
pub fn shared_overlay() -> bool { eligible() && SHARED_OVERLAY.load(Ordering::SeqCst) }
pub fn pin_supported(label: &str) -> bool { matches!(label,"log"|"settings"|"diagnostics"|"dictionary"|"welcome"|"sync-log") }
pub fn panel_pins() -> bool { eligible() && PANEL_PINS.load(Ordering::SeqCst) }

pub fn pin(w: &tauri::WebviewWindow, pinned: bool) -> Result<(), String> {
    if !panel_pins() { return Err("GNOME panel pinning requires the updated Kimochi extension".into()); }
    w.set_title(&format!("Kimochi · {}", w.label())).map_err(|e|e.to_string())?;
    request("own-window", json!({"label":w.label(),"pinned":pinned}))?;
    Ok(())
}

pub fn pinned(w: &tauri::WebviewWindow) -> Option<bool> {
    if !panel_pins() || !pin_supported(w.label()) { return None; }
    request("own-window", json!({"label":w.label()})).ok()?.get("pinned")?.as_bool()
}

pub fn restore_pins(app: &tauri::AppHandle, settings: &crate::settings::Settings, revision: &str) -> Result<(), String> {
    let mut previous = PIN_REVISION.lock().map_err(|e|e.to_string())?;
    if previous.as_deref() == Some(revision) { return Ok(()); }
    for window in app.webview_windows().values().filter(|w|pin_supported(w.label())) {
        let pinned = settings.get_or(&format!("nativeWindowPinned.{}",window.label()), false);
        pin(window, pinned || window.label() == "log" && crate::compact::active())?;
    }
    *previous = Some(revision.to_owned());
    Ok(())
}

pub fn invalidate_pins() { *PIN_REVISION.lock().unwrap() = None; }

fn digest(contents: &str) -> Result<String, String> {
    let mut checksum = glib::Checksum::new(glib::ChecksumType::Sha256).ok_or("SHA256 unavailable")?;
    checksum.update(contents.as_bytes());
    checksum.string().ok_or_else(|| "Missing SHA digest".into())
}

/// A live GNOME pairing is explicit and scoped to this portal node/session.
pub fn tracked_bounds(source_id: &str) -> Option<kimochi_capture::Rect> {
    if !eligible() || !source_id.starts_with("portal:window:") { return None; }
    let value = request("track", json!({"operation":"status","sourceId":source_id})).ok()?;
    serde_json::from_value(value["bounds"].clone()).ok()
}

pub fn match_window(source_id: &str, width: u32, height: u32) -> Option<kimochi_capture::Rect> {
    if !eligible() || !source_id.starts_with("portal:window:") { return None; }
    let value = request("track", json!({"operation":"match","sourceId":source_id,"width":width,"height":height})).ok()?;
    serde_json::from_value(value["bounds"].clone()).ok()
}

/// Refuse to stretch a partial or stale-sized portal buffer over a linked window.
pub fn tracked_frame_bounds(source_id: &str, width: u32, height: u32) -> Option<kimochi_capture::Rect> {
    if !eligible() || !source_id.starts_with("portal:window:") { return None; }
    let value = request("track", json!({"operation":"status","sourceId":source_id})).ok()?;
    let rect: kimochi_capture::Rect = serde_json::from_value(value["bounds"].clone()).ok()?;
    let scale = value["scale"].as_f64()?;
    (scale > 0. && (rect.width * scale - f64::from(width)).abs() <= 2.
        && (rect.height * scale - f64::from(height)).abs() <= 2.).then_some(rect)
}

/// Enrich only the active paired portal source; keep its current crop when naming
/// the formerly anonymous descriptor. Native live identity never survives closure.
pub fn refresh_identity(service: &crate::state::Shared, source_id: &str) {
    if !eligible() || !source_id.starts_with("portal:window:") { return; }
    let Ok(mut descriptor)=service.settings.get("lastSelectedSource").map(|v|v.unwrap_or(Value::Null)) else{return;};
    if descriptor["sourceId"]!=source_id{return;}
    let Ok(identity)=request("track",json!({"operation":"status","sourceId":source_id})) else{return;};
    let Some(title)=identity["title"].as_str().filter(|s|!s.trim().is_empty()) else{return;};
    let old=descriptor.clone();
    let old_key=crate::state::descriptor_key("window",old["name"].as_str().unwrap_or(""),old["appName"].as_str());
    descriptor["name"]=json!(title);
    descriptor["appName"]=identity["appName"].clone();
    descriptor["appId"]=identity["appId"].clone();
    if descriptor["iconName"]!=identity["iconName"] || descriptor.get("icon").is_none() {
        descriptor["iconName"]=identity["iconName"].clone();
        descriptor["icon"]=identity["iconName"].as_str().and_then(|name|icon_png(name,64)).map(|png|{
            use base64::Engine;
            json!(format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(png)))
        }).unwrap_or(Value::Null);
    }
    if descriptor==old{return;}
    let new_key=crate::state::descriptor_key("window",title,descriptor["appName"].as_str());
    let crops=service.settings.get("cropRegions").ok().flatten().unwrap_or(Value::Null);
    let active=service.settings.get("cropScanEnabled").ok().flatten().unwrap_or(Value::Null);
    let anki=service.settings.get("ankiCropRegions").ok().flatten().unwrap_or(Value::Null);
    let mut changes=vec![(vec!["lastSelectedSource"],descriptor)];
    if new_key!=old_key && crops.get(&new_key).is_none() {
        if let Some(crop)=crops.get(&old_key){changes.push((vec!["cropRegions",&new_key],crop.clone()));changes.push((vec!["cropScanEnabled",&new_key],active[&old_key].clone()));}
    }
    if new_key!=old_key && anki.get(&new_key).is_none() {
        if let Some(crop)=anki.get(&old_key).filter(|v|!v.is_null()){changes.push((vec!["ankiCropRegions",&new_key],crop.clone()));}
    }
    let borrowed:Vec<(&[&str],Value)>=changes.iter().map(|(path,v)|(path.as_slice(),v.clone())).collect();
    if service.settings.set_many(&borrowed).is_ok(){service.view.lock().unwrap().revision+=1;}
}

// GTK/GdkPixbuf already ship through Tauri; no extra crate/version or icon binaries.
#[link(name="gtk-3")]
extern "C" {
    fn gtk_icon_theme_get_default()->*mut std::ffi::c_void;
    fn gtk_icon_theme_lookup_by_gicon(theme:*mut std::ffi::c_void,icon:*mut std::ffi::c_void,size:i32,flags:i32)->*mut std::ffi::c_void;
    fn gtk_icon_info_load_icon(info:*mut std::ffi::c_void,error:*mut *mut glib::ffi::GError)->*mut std::ffi::c_void;
}
#[link(name="gio-2.0")]
extern "C" { fn g_icon_new_for_string(value:*const std::ffi::c_char,error:*mut *mut glib::ffi::GError)->*mut std::ffi::c_void; }
#[link(name="gdk_pixbuf-2.0")]
extern "C" {
    fn gdk_pixbuf_save_to_bufferv(pixbuf:*mut std::ffi::c_void,buffer:*mut *mut std::ffi::c_char,size:*mut usize,kind:*const std::ffi::c_char,keys:*mut *mut std::ffi::c_char,values:*mut *mut std::ffi::c_char,error:*mut *mut glib::ffi::GError)->i32;
}
fn icon_png(name:&str,size:i32)->Option<Vec<u8>>{
    let name=name.to_owned();
    let load=move || unsafe {
        let name=std::ffi::CString::new(name).ok()?;
        let icon=g_icon_new_for_string(name.as_ptr(),std::ptr::null_mut());if icon.is_null(){return None;}
        let theme=gtk_icon_theme_get_default();
        let info=if theme.is_null(){std::ptr::null_mut()}else{gtk_icon_theme_lookup_by_gicon(theme,icon,size,16)};
        glib::gobject_ffi::g_object_unref(icon.cast());if info.is_null(){return None;}
        let pixbuf=gtk_icon_info_load_icon(info,std::ptr::null_mut());glib::gobject_ffi::g_object_unref(info.cast());
        if pixbuf.is_null(){return None;}
        let mut bytes=std::ptr::null_mut();let mut length=0;
        let ok=gdk_pixbuf_save_to_bufferv(pixbuf,&mut bytes,&mut length,c"png".as_ptr(),std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut());
        glib::gobject_ffi::g_object_unref(pixbuf.cast());
        if ok==0||bytes.is_null(){return None;}
        let result=std::slice::from_raw_parts(bytes.cast::<u8>(),length).to_vec();glib::ffi::g_free(bytes.cast());Some(result)
    };
    let context=glib::MainContext::default();if context.is_owner(){return load();}
    let (tx,rx)=std::sync::mpsc::channel();context.invoke(move ||{let _=tx.send(load());});rx.recv_timeout(Duration::from_secs(2)).ok().flatten()
}

/// The paired native window is authoritative for a portal window's identity.
pub fn decorate_source(source: &mut kimochi_capture::Source) {
    if !source.id.starts_with("portal:window:") {return;}
    if let Ok(value)=request("track",json!({"operation":"status","sourceId":source.id})) {
        if let Some(title)=value["title"].as_str().filter(|title|!title.trim().is_empty()) {source.name=title.to_owned();}
        if let Some(name)=value["appName"].as_str() {source.app=Some(name.to_owned());}
    }
}

/// Resolve only the matched native app, never a guessed title-to-app association.
pub fn paired_app_icon_png(name:&str,target:isize)->Option<Vec<u8>> {
    let identity=status()["tracked"].clone();
    if identity["appName"].as_str()!=Some(name)&&identity["title"].as_str()!=Some(name){return None;}
    icon_png(identity["iconName"].as_str()?,target.clamp(16,256) as i32)
}
