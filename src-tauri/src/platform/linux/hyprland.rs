//! Optional read-only Hyprland geometry for portal window streams.
//! A unique full-buffer size match establishes an in-memory association. Never
//! select by title/focus, retarget a closed window, or guess between equal sizes.
//! Single-output only; other layouts fall back. XWayland clients (Wine and Proton games) match
//! at either their logical size or the output's scale (`xwayland:force_zero_scaling`).
use kimochi_capture::{Frame, Rect};
use serde::Deserialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::{LazyLock, Mutex},
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
    serde_json::from_slice(&request(command)?).ok()
}
/// Hyprland's event socket (`.socket2.sock`): one `event>>data` line per event.
pub(super) fn events() -> Option<UnixStream> {
    UnixStream::connect(socket()?.with_file_name(".socket2.sock")).ok()
}
/// One request on Hyprland's command socket and its raw reply (`hyprland_binds` sends commands).
pub(super) fn request(command: &[u8]) -> Option<Vec<u8>> {
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
    Some(data)
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

/// The process of the window `source` is linked to (see `kwin::linked_pid`).
pub fn linked_pid(source: &str) -> Option<u32> {
    BINDING.lock().ok()?.as_ref().filter(|b| b.source == source).map(|b| b.pid)
}

/// The linked window's title and app (its class), as GNOME's Shell integration reports them,
/// so the anonymous portal source is named after the game and its crop is the game's own.
pub fn identity(source: &str) -> Option<serde_json::Value> {
    let binding = BINDING.lock().ok()?.clone()?;
    if binding.source != source {
        return None;
    }
    let snapshot = snapshot()?;
    let client = resolve(&snapshot, &binding)?;
    let class = client.app.trim();
    if class.is_empty() {
        return Some(serde_json::json!({"title": client.title, "appName": null, "appId": null, "iconName": null}));
    }
    let (name, icon) = desktop_entry(class).unwrap_or_else(|| (class.to_owned(), class.to_owned()));
    Some(serde_json::json!({"title": client.title, "appName": name, "appId": class, "iconName": icon}))
}

/// The `Name` and `Icon` of the application whose desktop entry claims windows of `class`
/// (`StartupWMClass`, or an entry named after the class), as GNOME's app system would name it.
/// Looked up once per class.
pub(super) fn desktop_entry(class: &str) -> Option<(String, String)> {
    /// `(Name, Icon)` by window class; `None` where no entry claims the class.
    type Entries = HashMap<String, Option<(String, String)>>;
    static FOUND: LazyLock<Mutex<Entries>> = LazyLock::new(Default::default);
    if let Some(found) = FOUND.lock().ok()?.get(class) {
        return found.clone();
    }
    let home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    let system = std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
    let dirs = home.into_iter().chain(system.split(':').filter(|d| !d.is_empty()).map(PathBuf::from));
    let found = dirs
        .filter_map(|dir| std::fs::read_dir(dir.join("applications")).ok())
        .flatten()
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|e| e == "desktop"))
        .find_map(|entry| {
            let stem = entry.path().file_stem()?.to_string_lossy().into_owned();
            entry_for(class, &stem, &std::fs::read_to_string(entry.path()).ok()?)
        });
    if let Ok(mut cache) = FOUND.lock() {
        cache.insert(class.to_owned(), found.clone());
    }
    found
}

/// A desktop entry's `(Name, Icon)` when it claims windows of `class`: its `StartupWMClass` is
/// the class, or the file is named after it, and it is an application someone could see.
fn entry_for(class: &str, stem: &str, text: &str) -> Option<(String, String)> {
    let mut section = false;
    let (mut name, mut icon, mut wm_class, mut hidden) = (None, None, None, false);
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            section = line == "[Desktop Entry]";
            continue;
        }
        let Some((key, value)) = line.split_once('=').filter(|_| section) else { continue };
        match key.trim() {
            "Name" => name = Some(value.trim().to_owned()),
            "Icon" => icon = Some(value.trim().to_owned()),
            "StartupWMClass" => wm_class = Some(value.trim().to_owned()),
            "NoDisplay" | "Hidden" => hidden |= value.trim() == "true",
            _ => {}
        }
    }
    let claims = wm_class.is_some_and(|c| c.eq_ignore_ascii_case(class))
        || stem.eq_ignore_ascii_case(class)
        || stem.rsplit('.').next().is_some_and(|tail| tail.eq_ignore_ascii_case(class));
    (claims && !hidden).then_some(())?;
    let name = name.filter(|n| !n.is_empty())?;
    Some((name, icon.unwrap_or_else(|| class.to_owned())))
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
/// Windows the shared frame could be: mapped, not Kimochi's, and the frame's size.
fn candidates_in(snapshot: &Snapshot, width: u32, height: u32) -> Vec<&Client> {
    snapshot
        .clients
        .iter()
        .filter(|c| {
            c.mapped
                && !c.hidden
                && c.pid != std::process::id()
                && matches_frame(c, &snapshot.monitor, width, height)
        })
        .collect()
}
fn explicit_match<'a>(
    snapshot: &'a Snapshot,
    address: &str,
    width: u32,
    height: u32,
) -> Option<&'a Client> {
    candidates_in(snapshot, width, height)
        .into_iter()
        .find(|c| c.address == address)
}
pub fn candidates(width: u32, height: u32) -> Result<serde_json::Value, String> {
    let snapshot = snapshot().ok_or("Native window linking currently needs Hyprland with one unrotated output at the desktop origin")?;
    Ok(candidates_in(&snapshot, width, height)
        .into_iter()
        .map(|c| serde_json::json!({"address":c.address,"title":c.title,"app":c.app}))
        .collect())
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
    #[test]
    fn a_desktop_entry_names_the_windows_it_claims() {
        let entry = "[Desktop Entry]\nName=Firefox\nIcon=firefox\nStartupWMClass=firefox\n[Desktop Action new]\nName=New Window\n";
        assert_eq!(entry_for("firefox", "org.mozilla.firefox", entry), Some(("Firefox".into(), "firefox".into())));
        assert_eq!(entry_for("Steam", "steam", "[Desktop Entry]\nName=Steam\n"), Some(("Steam".into(), "Steam".into())));
        assert_eq!(entry_for("org.gnome.Nautilus", "org.gnome.Nautilus", "[Desktop Entry]\nName=Files\nIcon=nautilus\n"), Some(("Files".into(), "nautilus".into())));
        assert_eq!(entry_for("mpv", "other", "[Desktop Entry]\nName=Other\n"), None);
        assert_eq!(entry_for("mpv", "mpv", "[Desktop Entry]\nName=mpv\nNoDisplay=true\n"), None);
    }
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
    fn hidden_clients_never_match() {
        let mut s = sample();
        s.clients[0].hidden = true;
        assert!(unique_match(&s, 1660, 1373).is_none());
        assert!(explicit_match(&s, "0x1", 1660, 1373).is_none());
    }
    #[test]
    fn an_xwayland_game_links_at_its_logical_or_scaled_size() {
        // A Proton game on XWayland: unscaled, its buffer is its logical size; with
        // `xwayland:force_zero_scaling` it is the output's scale, as for a native client.
        let mut s = sample();
        s.clients[0].xwayland = true;
        s.clients[0].size = [640., 480.];
        assert_eq!(unique_match(&s, 640, 480).unwrap().address, "0x1");
        assert_eq!(unique_match(&s, 853, 640).unwrap().address, "0x1");
        assert!(unique_match(&s, 800, 600).is_none());
        assert_eq!(explicit_match(&s, "0x1", 640, 480).unwrap().address, "0x1");
        assert_eq!(candidates_in(&s, 640, 480).len(), 1);
    }
}
