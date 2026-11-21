//! Niri inventory over its JSON IPC socket, capture through its Mutter-compatible D-Bus API.
//! Niri currently leaves tiled positions unset; never invent coordinates for those windows.
//! XWayland windows belong to xwayland-satellite at the Wayland boundary. Resolve their real
//! process from a unique title + WM_CLASS match on X11, never use the satellite PID for hooks.
use super::backend::{pipewire_feed, Driver, Feed, Target};
use super::{Inventory, NativeOutput, NativeWindow};
use crate::{CaptureError, Rect, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    time::Duration,
};
use zbus::blocking::{Connection, Proxy};

fn native(e: impl ToString) -> CaptureError {
    CaptureError::new("native", e)
}

#[derive(Clone, Debug, Deserialize)]
struct Window {
    id: u64,
    title: Option<String>,
    app_id: Option<String>,
    pid: Option<i32>,
    workspace_id: Option<u64>,
    is_focused: bool,
    layout: Layout,
}
#[derive(Clone, Debug, Deserialize)]
struct Layout {
    window_size: (i32, i32),
    tile_pos_in_workspace_view: Option<(f64, f64)>,
    window_offset_in_tile: (f64, f64),
}
#[derive(Debug, Deserialize)]
struct Workspace {
    id: u64,
    output: Option<String>,
    is_active: bool,
}
#[derive(Debug, Deserialize)]
struct Output {
    name: String,
    make: String,
    model: String,
    logical: Option<LogicalOutput>,
}
#[derive(Debug, Deserialize)]
struct LogicalOutput {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}

struct Niri {
    socket: PathBuf,
    connection: Connection,
}
impl Niri {
    fn request(&self, request: Value, response: &str) -> Result<Value> {
        let mut stream = UnixStream::connect(&self.socket).map_err(native)?;
        stream.set_read_timeout(Some(Duration::from_millis(700))).map_err(native)?;
        stream.set_write_timeout(Some(Duration::from_millis(700))).map_err(native)?;
        writeln!(stream, "{request}").map_err(native)?;
        let mut line = String::new();
        // Bound allocation even if a broken socket sends no newline.
        BufReader::new(stream).take(4 * 1024 * 1024).read_line(&mut line).map_err(native)?;
        let reply: Value = serde_json::from_str(&line).map_err(native)?;
        if let Some(error) = reply.get("Err") {
            return Err(native(format!("Niri IPC: {error}")));
        }
        let ok = reply.get("Ok").ok_or_else(|| native("Niri IPC returned no result"))?;
        if response == "Handled" && ok == "Handled" {
            return Ok(Value::Null);
        }
        ok.get(response).cloned().ok_or_else(|| native(format!("Niri IPC returned no {response}")))
    }
}

fn assemble(
    windows: Vec<Window>,
    workspaces: Vec<Workspace>,
    outputs: HashMap<String, Output>,
    overview: bool,
) -> Inventory {
    let mut outputs: Vec<_> = outputs
        .into_values()
        .filter_map(|o| {
            let l = o.logical?;
            if l.width == 0 || l.height == 0 || !l.scale.is_finite() || l.scale <= 0.0 {
                return None;
            }
            Some(NativeOutput {
                handle: o.name.clone(),
                name: if o.model.is_empty() { o.name } else { format!("{} {}", o.make, o.model).trim().to_owned() },
                bounds: Rect { x: l.x as f64, y: l.y as f64, width: l.width as f64, height: l.height as f64 },
                scale: l.scale,
                primary: false,
            })
        })
        .collect();
    outputs.sort_by(|a, b| a.handle.cmp(&b.handle));
    let windows = windows
        .into_iter()
        .map(|w| {
            let ws = w.workspace_id.and_then(|id| workspaces.iter().find(|ws| ws.id == id));
            let output =
                ws.and_then(|ws| ws.output.as_deref()).and_then(|name| outputs.iter().find(|o| o.handle == name));
            let bounds = w.layout.tile_pos_in_workspace_view.zip(output).and_then(|((x, y), o)| {
                let (dx, dy) = w.layout.window_offset_in_tile;
                let (width, height) = w.layout.window_size;
                (width > 0 && height > 0 && [x, y, dx, dy].iter().all(|n| n.is_finite())).then_some(Rect {
                    x: o.bounds.x + x + dx,
                    y: o.bounds.y + y + dy,
                    width: width as f64,
                    height: height as f64,
                })
            });
            let visible = !overview
                && ws.is_some_and(|ws| ws.is_active)
                && output.is_some()
                && bounds.is_none_or(|b| {
                    output.is_some_and(|o| {
                        b.x < o.bounds.x + o.bounds.width
                            && b.x + b.width > o.bounds.x
                            && b.y < o.bounds.y + o.bounds.height
                            && b.y + b.height > o.bounds.y
                    })
                });
            NativeWindow {
                handle: w.id.to_string(),
                title: w.title.unwrap_or_default(),
                app_id: w.app_id,
                app_name: None,
                pid: w.pid.and_then(|p| u32::try_from(p).ok()).filter(|p| *p > 0),
                bounds,
                output: output.map(|o| o.handle.clone()),
                minimized: false,
                on_screen: Some(visible),
                focused: w.is_focused,
                auxiliary: false,
            }
        })
        .collect();
    Inventory { windows, outputs }
}

fn satellite(pid: u32) -> bool {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .is_some_and(|p| p.to_string_lossy().contains("xwayland-satellite"))
}

#[derive(Debug)]
struct XClient {
    title: String,
    classes: Vec<String>,
    pid: Option<u32>,
}
fn matching_pid(window: &NativeWindow, windows: &[NativeWindow], clients: &[XClient]) -> Option<u32> {
    let app = window.app_id.as_deref()?;
    if window.title.is_empty()
        || windows.iter().filter(|w| w.title == window.title && w.app_id == window.app_id).count() != 1
    {
        return None;
    }
    let mut matches = clients.iter().filter(|c| c.title == window.title && c.classes.iter().any(|s| s == app));
    let first = matches.next()?;
    matches.next().is_none().then_some(first.pid).flatten()
}
fn resolve_satellite_pids(inventory: &mut Inventory) {
    let bridged: Vec<_> = inventory.windows.iter().filter_map(|w| w.pid).filter(|p| satellite(*p)).collect();
    if bridged.is_empty() {
        return;
    }
    let clients = xclients().unwrap_or_default();
    let pids: Vec<_> = inventory
        .windows
        .iter()
        .map(|w| {
            if w.pid.is_some_and(|p| bridged.contains(&p)) {
                matching_pid(w, &inventory.windows, &clients)
            } else {
                w.pid
            }
        })
        .collect();
    for (window, pid) in inventory.windows.iter_mut().zip(pids) {
        window.pid = pid;
    }
}
fn xclients() -> Option<Vec<XClient>> {
    use crate::linux_x11::desktop::Desktop;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};
    let desktop = Desktop::connect().ok()?;
    // Satellite need not advertise EWMH client lists. Inspect root children and reparent frames.
    let mut pending = vec![(desktop.root, 0)];
    let mut clients = Vec::new();
    let mut visited = 0;
    while let Some((parent, depth)) = pending.pop() {
        if visited > 4096 {
            break;
        }
        let Ok(cookie) = desktop.conn.query_tree(parent) else { continue };
        let Ok(tree) = cookie.reply() else { continue };
        for window in tree.children {
            visited += 1;
            let classes = desktop.property(window, desktop.atoms.WM_CLASS, AtomEnum::STRING, 1024);
            if let Some(classes) = classes {
                clients.push(XClient {
                    title: desktop.title(window),
                    classes: classes
                        .value
                        .split(|b| *b == 0)
                        .filter(|s| !s.is_empty())
                        .map(|s| String::from_utf8_lossy(s).into_owned())
                        .collect(),
                    pid: desktop.pid(window),
                });
            } else if depth < 2 {
                pending.push((window, depth + 1));
            }
        }
    }
    Some(clients)
}
impl Driver for Niri {
    fn name(&self) -> &'static str {
        "niri"
    }
    fn inventory(&self) -> Result<Inventory> {
        let windows = serde_json::from_value(self.request(json!("Windows"), "Windows")?).map_err(native)?;
        let workspaces = serde_json::from_value(self.request(json!("Workspaces"), "Workspaces")?).map_err(native)?;
        let outputs = serde_json::from_value(self.request(json!("Outputs"), "Outputs")?).map_err(native)?;
        let overview = self
            .request(json!("OverviewState"), "OverviewState")?
            .get("is_open")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let mut inventory = assemble(windows, workspaces, outputs, overview);
        resolve_satellite_pids(&mut inventory);
        Ok(inventory)
    }
    fn open(&self, target: Target<'_>) -> Result<Feed> {
        let (node, session) = super::screencast::record(&self.connection, target)?;
        // Niri 26.04 screencasts only in DMA-BUF (shared memory came in September 2026).
        pipewire_feed(node, Box::new(session), true)
    }
    fn activate(&self, window: &NativeWindow) -> Result<()> {
        let id: u64 = window.handle.parse().map_err(native)?;
        self.request(json!({"Action":{"FocusWindow":{"id":id}}}), "Handled").map(|_| ())
    }
}
pub fn probe() -> std::result::Result<Box<dyn Driver>, String> {
    let socket = std::env::var_os("NIRI_SOCKET").filter(|s| !s.is_empty()).ok_or("NIRI_SOCKET is not set")?;
    let connection = Connection::session().map_err(|e| e.to_string())?;
    let proxy = Proxy::new(
        &connection,
        super::screencast::SCREENCAST,
        super::screencast::SCREENCAST_PATH,
        super::screencast::SCREENCAST,
    )
    .map_err(|e| e.to_string())?;
    let version: i32 = proxy.get_property("Version").map_err(|e| e.to_string())?;
    if version < 3 {
        return Err(format!("ScreenCast API {version} lacks window capture"));
    }
    drop(proxy);
    let niri = Niri { socket: socket.into(), connection };
    niri.inventory().map_err(|e| e.message)?;
    Ok(Box::new(niri))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn inventory(position: Value) -> Inventory {
        assemble(serde_json::from_value(json!([{"id":38,"title":"Game","app_id":"steam_app_1","pid":100,"workspace_id":2,"is_focused":true,
            "layout":{"window_size":[800,600],"tile_pos_in_workspace_view":position,"window_offset_in_tile":[2.0,3.0]}}])).unwrap(),
            serde_json::from_value(json!([{"id":2,"output":"DP-2","is_active":true}])).unwrap(),
            serde_json::from_value(json!({"DP-2":{"name":"DP-2","make":"Test","model":"Display","logical":{"x":1920,"y":0,"width":1280,"height":720,"scale":1.5}}})).unwrap(), false)
    }
    #[test]
    fn logical_geometry_includes_output_and_window_offset() {
        let inv = inventory(json!([10.0, 20.0]));
        assert_eq!(inv.windows[0].bounds, Some(Rect { x: 1932.0, y: 23.0, width: 800.0, height: 600.0 }));
        assert_eq!(inv.outputs[0].scale, 1.5);
        assert_eq!(inv.windows[0].on_screen, Some(true));
    }
    #[test]
    fn missing_geometry_stays_unknown() {
        assert_eq!(inventory(Value::Null).windows[0].bounds, None);
    }
    #[test]
    fn offscreen_windows_are_not_drawable() {
        assert_eq!(inventory(json!([-900.0, 0.0])).windows[0].on_screen, Some(false));
    }
    #[test]
    fn bridge_resolution_requires_unique_class_and_title_on_both_sides() {
        let inv = inventory(Value::Null);
        let w = &inv.windows[0];
        let client = || XClient { title: "Game".into(), classes: vec!["steam_app_1".into()], pid: Some(42) };
        assert_eq!(matching_pid(w, &inv.windows, &[client()]), Some(42));
        assert_eq!(matching_pid(w, &inv.windows, &[client(), client()]), None);
        assert_eq!(matching_pid(w, &[w.clone(), w.clone()], &[client()]), None);
        let mut wrong = client();
        wrong.classes = vec!["other".into()];
        assert_eq!(matching_pid(w, &inv.windows, &[wrong]), None);
    }
}
