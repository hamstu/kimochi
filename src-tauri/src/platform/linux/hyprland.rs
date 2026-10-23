//! Optional read-only Hyprland geometry for portal window streams.
//! A unique full-buffer size match establishes an in-memory association. Never
//! select by title/focus, retarget a closed window, or guess between equal sizes.
//! Initially single-output and native Wayland clients only; other cases fall back.
use kimochi_capture::{Frame, Rect};
use serde::Deserialize;
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Clone, Deserialize)]
struct Client {
    address: String,
    #[serde(default, rename = "stableId")]
    stable_id: String,
    #[serde(default, rename = "focusHistoryID")]
    focus_history: Option<u32>,
    pid: u32,
    #[serde(rename = "class")]
    app: String,
    #[serde(default)]
    title: String,
    at: [f64; 2],
    size: [f64; 2],
    mapped: bool,
    hidden: bool,
    #[serde(default)]
    xwayland: bool,
    monitor: i64,
    workspace: Workspace,
}
#[derive(Clone, Deserialize)]
struct Workspace {
    id: i64,
}
#[derive(Clone, Deserialize)]
struct Monitor {
    id: i64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
    #[serde(rename = "activeWorkspace")]
    workspace: Workspace,
    #[serde(default)]
    transform: u32,
}
#[derive(Clone)]
struct Snapshot {
    clients: Vec<Client>,
    monitor: Monitor,
}
#[derive(Clone)]
struct Binding {
    source: String,
    stable_id: String,
    address: String,
    pid: u32,
    app: String,
    bounds: Rect,
}
static CACHE: Mutex<Option<(Instant, Option<Snapshot>)>> = Mutex::new(None);
static BINDING: Mutex<Option<Binding>> = Mutex::new(None);

fn socket() -> Option<PathBuf> {
    if std::env::var("KIMOCHI_HYPRLAND_WINDOW_TRACKING").as_deref() == Ok("0")
        || super::session().backend != super::Backend::Wayland
        || super::session().compositor.as_deref() != Some("Hyprland")
        || !super::layer::available()
    {
        return None;
    }
    let signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE").ok()?;
    if signature.is_empty() || signature.contains('/') || signature.contains("..") {
        return None;
    }
    Some(
        PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR")?)
            .join("hypr")
            .join(signature)
            .join(".socket.sock"),
    )
}
pub fn available() -> bool {
    socket().is_some_and(|path| path.exists())
}
/// Read-only compositor coordinates; never infer button/modifier state from them.
pub fn pointer() -> Option<serde_json::Value> {
    snapshot()?;
    let point: serde_json::Value = query(b"j/cursorpos")?;
    point["x"].as_f64().filter(|v| v.is_finite())?;
    point["y"].as_f64().filter(|v| v.is_finite())?;
    Some(point)
}
fn query<T: serde::de::DeserializeOwned>(command: &[u8]) -> Option<T> {
    let mut stream = UnixStream::connect(socket()?).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .ok()?;
    stream
        .set_write_timeout(Some(Duration::from_millis(100)))
        .ok()?;
    stream.write_all(command).ok()?;
    let mut data = Vec::new();
    stream.take(2_000_001).read_to_end(&mut data).ok()?;
    if data.len() > 2_000_000 {
        return None;
    }
    serde_json::from_slice(&data).ok()
}
fn snapshot() -> Option<Snapshot> {
    if !available() {
        return None;
    }
    let mut cache = CACHE.lock().ok()?;
    if let Some((at, snapshot)) = cache.as_ref() {
        if at.elapsed() < Duration::from_millis(100) {
            return snapshot.clone();
        }
    }
    let value = (|| {
        let mut monitors: Vec<Monitor> = query(b"j/monitors")?;
        if monitors.len() != 1 {
            return None;
        }
        let monitor = monitors.pop()?;
        if monitor.x != 0.
            || monitor.y != 0.
            || monitor.transform != 0
            || !monitor.scale.is_finite()
            || monitor.scale <= 0.
            || monitor.width <= 0.
            || monitor.height <= 0.
        {
            return None;
        }
        Some(Snapshot {
            clients: query(b"j/clients")?,
            monitor,
        })
    })();
    *cache = Some((Instant::now(), value.clone()));
    value
}
fn matches_frame(client: &Client, monitor: &Monitor, width: u32, height: u32) -> bool {
    // Wayland fractional buffer scaling uses 120ths; Hyprland's JSON rounds
    // 1.3333 to 1.33. Accept neither arbitrary aspect ratios nor stale buffers.
    let scale = (monitor.scale * 120.).round() / 120.;
    let size_matches = |scale: f64| {
        (client.size[0] * scale - f64::from(width)).abs() <= 1.
            && (client.size[1] * scale - f64::from(height)).abs() <= 1.
    };
    client.monitor == monitor.id
        && client.size.iter().all(|v| v.is_finite() && *v > 0.)
        && (size_matches(scale) || (client.xwayland && size_matches(1.)))
}
fn unique_match(snapshot: &Snapshot, width: u32, height: u32) -> Option<&Client> {
    let mut matches = snapshot
        .clients
        .iter()
        .filter(|c| matches_frame(c, &snapshot.monitor, width, height));
    let candidate = matches.next()?;
    (matches.next().is_none()
        && candidate.pid != std::process::id()
        && !candidate.xwayland
        && candidate.mapped
        && !candidate.hidden)
        .then_some(candidate)
}
fn rect(client: &Client) -> Option<Rect> {
    client
        .at
        .iter()
        .chain(&client.size)
        .all(|v| v.is_finite())
        .then_some(Rect {
            x: client.at[0],
            y: client.at[1],
            width: client.size[0],
            height: client.size[1],
        })
}
fn resolve<'a>(snapshot: &'a Snapshot, binding: &Binding) -> Option<&'a Client> {
    snapshot.clients.iter().find(|c| {
        c.address == binding.address
            && c.stable_id == binding.stable_id
            && c.pid == binding.pid
            && c.app == binding.app
    })
}
pub fn clear() {
    if let Ok(mut binding) = BINDING.lock() {
        *binding = None;
    }
}
pub fn tracked(source: &str) -> Option<(Rect, bool)> {
    let binding = BINDING.lock().ok()?.clone()?;
    if binding.source != source {
        return None;
    }
    let Some(snapshot) = snapshot() else {
        return Some((binding.bounds, false));
    };
    let Some(client) = resolve(&snapshot, &binding) else {
        return Some((binding.bounds, false));
    };
    let rect = rect(client)?;
    let monitor = &snapshot.monitor;
    let foreground_ok = snapshot
        .clients
        .iter()
        .find(|c| c.focus_history == Some(0))
        .is_none_or(|active| active.pid == client.pid || active.pid == std::process::id());
    let visible = foreground_ok
        && client.mapped
        && !client.hidden
        && client.workspace.id == monitor.workspace.id
        && rect.x < monitor.x + monitor.width / monitor.scale
        && rect.x + rect.width > monitor.x
        && rect.y < monitor.y + monitor.height / monitor.scale
        && rect.y + rect.height > monitor.y;
    Some((rect, visible))
}
pub fn frame_bounds(source: &str, width: u32, height: u32) -> Option<Rect> {
    if !source.starts_with("portal:window:") {
        return None;
    }
    let snapshot = snapshot()?;
    let mut binding = BINDING.lock().ok()?;
    if binding.as_ref().is_none_or(|b| b.source != source) {
        let client = unique_match(&snapshot, width, height)?;
        *binding = Some(Binding {
            source: source.to_owned(),
            stable_id: client.stable_id.clone(),
            address: client.address.clone(),
            pid: client.pid,
            app: client.app.clone(),
            bounds: rect(client)?,
        });
        eprintln!(
            "Hyprland portal window linked: source={source} pid={} frame={width}x{height}",
            client.pid
        );
    }
    let client = resolve(&snapshot, binding.as_ref()?)?;
    (client.mapped
        && !client.hidden
        && !client.xwayland
        && matches_frame(client, &snapshot.monitor, width, height))
    .then(|| rect(client))
    .flatten()
}
pub fn enrich(frame: &mut Frame) {
    if let Some(bounds) = frame_bounds(
        &frame.info.source_id,
        frame.info.full_width,
        frame.info.full_height,
    ) {
        frame.info.scale_factor = f64::from(frame.info.full_width) / bounds.width;
        frame.info.source_bounds = Some(bounds);
    }
}

/// User-visible association status; no capture permissions or compositor state change.
pub fn status(source: &str) -> serde_json::Value {
    let snapshot = snapshot();
    let binding = BINDING.lock().ok().and_then(|b| b.clone());
    let linked = binding.is_some_and(|b| {
        b.source == source && snapshot.as_ref().is_some_and(|s| resolve(s, &b).is_some())
    });
    let tracked = tracked(source);
    serde_json::json!({"available":snapshot.is_some(),"linked":linked,
        "bounds":tracked.map(|(bounds,_)|bounds),"visible":tracked.is_some_and(|(_,visible)|visible)})
}
fn explicit_match<'a>(
    snapshot: &'a Snapshot,
    address: &str,
    width: u32,
    height: u32,
) -> Option<&'a Client> {
    snapshot.clients.iter().find(|c| {
        c.address == address
            && c.mapped
            && !c.hidden
            && !c.xwayland
            && c.pid != std::process::id()
            && matches_frame(c, &snapshot.monitor, width, height)
    })
}
pub fn candidates(width: u32, height: u32) -> Result<serde_json::Value, String> {
    let snapshot = snapshot().ok_or("Native window linking currently needs Hyprland with one unrotated output at the desktop origin")?;
    Ok(serde_json::Value::Array(
        snapshot
            .clients
            .iter()
            .filter(|c| {
                c.mapped
                    && !c.hidden
                    && !c.xwayland
                    && c.pid != std::process::id()
                    && matches_frame(c, &snapshot.monitor, width, height)
            })
            .map(|c| serde_json::json!({"address":c.address,"title":c.title,"app":c.app}))
            .collect(),
    ))
}
pub fn link(source: &str, address: &str, width: u32, height: u32) -> Result<(), String> {
    let snapshot = snapshot().ok_or("Hyprland window geometry is unavailable")?;
    let client = explicit_match(&snapshot, address, width, height)
        .ok_or("The chosen window no longer matches this shared frame. Try again.")?;
    *BINDING.lock().map_err(|e| e.to_string())? = Some(Binding {
        source: source.to_owned(),
        stable_id: client.stable_id.clone(),
        address: client.address.clone(),
        pid: client.pid,
        app: client.app.clone(),
        bounds: rect(client).ok_or("Invalid window bounds")?,
    });
    eprintln!(
        "Hyprland portal window explicitly linked: source={source} pid={}",
        client.pid
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Snapshot {
        let monitor = serde_json::from_value(serde_json::json!({"id":0,"x":0,"y":0,"width":3440,"height":1440,"scale":1.33,"activeWorkspace":{"id":1}})).unwrap();
        let client = serde_json::from_value(serde_json::json!({"address":"0x1","pid":42,"class":"game","at":[100,40],"size":[1245,1030],"mapped":true,"hidden":false,"monitor":0,"workspace":{"id":1}})).unwrap();
        Snapshot {
            clients: vec![client],
            monitor,
        }
    }
    #[test]
    fn fractional_buffer_matches_but_different_or_stale_shapes_do_not() {
        let s = sample();
        assert!(unique_match(&s, 1660, 1373).is_some());
        assert!(unique_match(&s, 1655, 1373).is_none());
        assert!(unique_match(&s, 1660, 800).is_none());
    }
    #[test]
    fn equal_sized_windows_are_ambiguous_even_on_different_workspaces() {
        let mut s = sample();
        let mut other = s.clients[0].clone();
        other.address = "0x2".into();
        other.workspace.id = 2;
        s.clients.push(other);
        assert!(unique_match(&s, 1660, 1373).is_none());
    }
    #[test]
    fn existing_binding_follows_identity_not_size_or_title() {
        let mut s = sample();
        let binding = Binding {
            source: "portal:window:7".into(),
            stable_id: String::new(),
            address: "0x1".into(),
            pid: 42,
            app: "game".into(),
            bounds: rect(&s.clients[0]).unwrap(),
        };
        s.clients[0].at = [-50., 80.];
        assert_eq!(rect(resolve(&s, &binding).unwrap()).unwrap().x, -50.);
        s.clients[0].pid = 99;
        assert!(resolve(&s, &binding).is_none());
    }
    #[test]
    fn hidden_and_xwayland_windows_still_block_ambiguous_associations() {
        let mut s = sample();
        let mut other = s.clients[0].clone();
        other.address = "0x2".into();
        other.hidden = true;
        s.clients.push(other);
        assert!(unique_match(&s, 1660, 1373).is_none());
        s.clients[1].hidden = false;
        s.clients[1].xwayland = true;
        assert!(unique_match(&s, 1660, 1373).is_none());
    }
    #[test]
    fn explicit_choice_resolves_ambiguity_but_rejects_stale_or_invalid_choices() {
        let mut s = sample();
        let mut second = s.clients[0].clone();
        second.address = "0x2".into();
        s.clients.push(second);
        assert!(unique_match(&s, 1660, 1373).is_none());
        assert_eq!(
            explicit_match(&s, "0x2", 1660, 1373).unwrap().address,
            "0x2"
        );
        assert!(explicit_match(&s, "0x3", 1660, 1373).is_none());
        assert!(explicit_match(&s, "0x2", 1000, 800).is_none());
        s.clients[1].hidden = true;
        assert!(explicit_match(&s, "0x2", 1660, 1373).is_none());
    }
    #[test]
    fn unsupported_or_unmapped_clients_never_match() {
        let mut s = sample();
        s.clients[0].xwayland = true;
        assert!(unique_match(&s, 1660, 1373).is_none());
        s.clients[0].xwayland = false;
        s.clients[0].hidden = true;
        assert!(unique_match(&s, 1660, 1373).is_none());
    }
}
