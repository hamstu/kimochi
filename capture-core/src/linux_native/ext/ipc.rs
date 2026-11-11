//! What compositor IPC adds to the ext toplevel list: pid, bounds, output, visibility, focus,
//! front-to-back order, and a way to activate. Only Hyprland and Sway have one; both are
//! feature-detected from the session's environment and never required.
//!
//! A window is matched to its IPC record by an exact identity only: Hyprland's window address
//! (from `hyprland_toplevel_mapping_manager_v1`) or Sway's `foreign_toplevel_identifier`.
use crate::Rect;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

const IO_TIMEOUT: Duration = Duration::from_millis(300);
/// No answer is bigger than this (a tree of hundreds of windows is well under it).
const MAX_REPLY: u64 = 16 << 20;

/// What IPC knows about one window.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Facts {
    pub pid: Option<u32>,
    /// Global logical coordinates of what the window's capture shows.
    pub bounds: Option<Rect>,
    pub output: Option<String>,
    pub on_screen: Option<bool>,
    pub focused: bool,
    /// Front-to-back position, 0 the frontmost.
    pub rank: Option<u32>,
    /// Hyprland's window address or Sway's container id.
    pub id: u64,
}

/// The compositor IPC this session has.
#[derive(Clone, Debug, PartialEq)]
pub enum Ipc {
    Hyprland(PathBuf),
    Sway(PathBuf),
}

impl Ipc {
    pub fn detect() -> Option<Ipc> {
        if let Some(path) = hyprland_socket() {
            return Some(Ipc::Hyprland(path));
        }
        let sway = std::env::var_os("SWAYSOCK").map(PathBuf::from)?;
        sway.exists().then_some(Ipc::Sway(sway))
    }
}

fn hyprland_socket() -> Option<PathBuf> {
    let signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE").ok()?;
    if signature.is_empty() || signature.contains('/') || signature.contains("..") {
        return None;
    }
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    // Hyprland ≥0.40 keeps it under the runtime dir; older ones under /tmp.
    runtime
        .into_iter()
        .chain([PathBuf::from("/tmp")])
        .map(|dir| dir.join("hypr").join(&signature).join(".socket.sock"))
        .find(|p| p.exists())
}

// ----- Hyprland ----------------------------------------------------------------------------

#[derive(Deserialize)]
struct HyprClient {
    address: String,
    #[serde(default)]
    pid: i64,
    at: [f64; 2],
    size: [f64; 2],
    #[serde(default = "yes")]
    mapped: bool,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    pinned: bool,
    workspace: HyprWorkspace,
    #[serde(default = "minus_one")]
    monitor: i64,
    #[serde(default, rename = "focusHistoryID")]
    focus_history: Option<i64>,
}

#[derive(Deserialize)]
struct HyprWorkspace {
    id: i64,
}

#[derive(Deserialize)]
struct HyprMonitor {
    id: i64,
    name: String,
    #[serde(rename = "activeWorkspace")]
    active: HyprWorkspace,
    #[serde(default, rename = "specialWorkspace")]
    special: Option<HyprWorkspace>,
}

#[derive(Deserialize, Default)]
struct HyprActive {
    #[serde(default)]
    address: Option<String>,
}

fn yes() -> bool {
    true
}
fn minus_one() -> i64 {
    -1
}

/// `0x55d1c2a3b4c0` → its value.
pub fn parse_address(text: &str) -> Option<u64> {
    let hex = text.trim().strip_prefix("0x").unwrap_or(text.trim());
    u64::from_str_radix(hex, 16).ok()
}

fn finite_rect(x: f64, y: f64, w: f64, h: f64) -> Option<Rect> {
    ([x, y, w, h].iter().all(|v| v.is_finite()) && w > 0.0 && h > 0.0).then_some(Rect { x, y, width: w, height: h })
}

/// Hyprland's `j/clients`, `j/monitors` and `j/activewindow`, by window address.
pub fn hyprland_facts(clients: &[u8], monitors: &[u8], active: &[u8]) -> Option<HashMap<u64, Facts>> {
    let clients: Vec<HyprClient> = serde_json::from_slice(clients).ok()?;
    let monitors: Vec<HyprMonitor> = serde_json::from_slice(monitors).unwrap_or_default();
    // `{}` when nothing is focused.
    let active = serde_json::from_slice::<HyprActive>(active).ok().and_then(|a| a.address).and_then(|a| parse_address(&a));
    let mut out = HashMap::new();
    for c in &clients {
        let Some(address) = parse_address(&c.address) else { continue };
        let monitor = monitors.iter().find(|m| m.id == c.monitor);
        let shown_workspace = monitor.is_some_and(|m| {
            m.active.id == c.workspace.id || m.special.as_ref().is_some_and(|s| s.id != 0 && s.id == c.workspace.id)
        });
        let focused = match active {
            Some(a) => a == address,
            None => c.focus_history == Some(0),
        };
        out.insert(
            address,
            Facts {
                pid: u32::try_from(c.pid).ok().filter(|p| *p > 0),
                bounds: finite_rect(c.at[0], c.at[1], c.size[0], c.size[1]),
                output: monitor.map(|m| m.name.clone()),
                on_screen: Some(c.mapped && !c.hidden && (shown_workspace || c.pinned)),
                focused,
                rank: c.focus_history.and_then(|f| u32::try_from(f).ok()),
                id: address,
            },
        );
    }
    Some(out)
}

fn hyprland_request(path: &PathBuf, command: &str) -> Option<Vec<u8>> {
    let mut stream = UnixStream::connect(path).ok()?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok()?;
    stream.write_all(command.as_bytes()).ok()?;
    let mut data = Vec::new();
    stream.take(MAX_REPLY).read_to_end(&mut data).ok()?;
    Some(data)
}

// ----- Sway ----------------------------------------------------------------------------------

const SWAY_MAGIC: &[u8; 6] = b"i3-ipc";
const SWAY_RUN_COMMAND: u32 = 0;
const SWAY_GET_TREE: u32 = 4;

#[derive(Deserialize)]
struct SwayNode {
    id: i64,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    name: Option<String>,
    rect: SwayRect,
    #[serde(default)]
    window_rect: Option<SwayRect>,
    #[serde(default)]
    pid: Option<i64>,
    #[serde(default)]
    visible: Option<bool>,
    #[serde(default)]
    focused: bool,
    /// Sway ≥1.11.
    #[serde(default)]
    foreign_toplevel_identifier: Option<String>,
    #[serde(default)]
    nodes: Vec<SwayNode>,
    #[serde(default)]
    floating_nodes: Vec<SwayNode>,
    /// Child ids, most recently focused first.
    #[serde(default)]
    focus: Vec<i64>,
}

#[derive(Deserialize, Clone, Copy)]
struct SwayRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Sway's `get_tree`, by `foreign_toplevel_identifier`. Windows without one (Sway <1.11) are
/// left out: nothing else identifies them exactly.
pub fn sway_facts(tree: &[u8]) -> Option<HashMap<String, Facts>> {
    let root: SwayNode = serde_json::from_slice(tree).ok()?;
    let mut out = HashMap::new();
    let mut rank = 0;
    walk_sway(&root, None, &mut rank, &mut out);
    Some(out)
}

fn walk_sway(node: &SwayNode, output: Option<&str>, rank: &mut u32, out: &mut HashMap<String, Facts>) {
    let output = if node.kind == "output" { node.name.as_deref().filter(|n| *n != "__i3") } else { output };
    if let (Some(identifier), true) = (&node.foreign_toplevel_identifier, node.nodes.is_empty()) {
        // `rect` is the container (border included); `window_rect` is the window inside it.
        let bounds = match node.window_rect {
            Some(w) => finite_rect(node.rect.x + w.x, node.rect.y + w.y, w.width, w.height),
            None => finite_rect(node.rect.x, node.rect.y, node.rect.width, node.rect.height),
        };
        out.insert(
            identifier.clone(),
            Facts {
                pid: node.pid.and_then(|p| u32::try_from(p).ok()).filter(|p| *p > 0),
                bounds,
                output: output.map(str::to_string),
                on_screen: node.visible,
                focused: node.focused,
                rank: Some(*rank),
                id: node.id as u64,
            },
        );
        *rank += 1;
    }
    // Most recently focused child first, so the walk visits windows front to back.
    let mut children: Vec<&SwayNode> = node.floating_nodes.iter().chain(&node.nodes).collect();
    children.sort_by_key(|c| node.focus.iter().position(|id| *id == c.id).unwrap_or(usize::MAX));
    for child in children {
        walk_sway(child, output, rank, out);
    }
}

fn sway_request(path: &PathBuf, kind: u32, payload: &str) -> Option<Vec<u8>> {
    let mut stream = UnixStream::connect(path).ok()?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok()?;
    let mut message = Vec::with_capacity(14 + payload.len());
    message.extend_from_slice(SWAY_MAGIC);
    message.extend_from_slice(&(payload.len() as u32).to_ne_bytes());
    message.extend_from_slice(&kind.to_ne_bytes());
    message.extend_from_slice(payload.as_bytes());
    stream.write_all(&message).ok()?;
    let mut header = [0u8; 14];
    stream.read_exact(&mut header).ok()?;
    if &header[..6] != SWAY_MAGIC {
        return None;
    }
    let len = u32::from_ne_bytes(header[6..10].try_into().ok()?) as u64;
    if len > MAX_REPLY {
        return None;
    }
    let mut body = vec![0u8; len as usize];
    stream.read_exact(&mut body).ok()?;
    Some(body)
}

/// Whether every command in a Sway `run_command` reply succeeded.
fn sway_success(reply: &[u8]) -> bool {
    #[derive(Deserialize)]
    struct Outcome {
        success: bool,
    }
    serde_json::from_slice::<Vec<Outcome>>(reply).is_ok_and(|r| !r.is_empty() && r.iter().all(|o| o.success))
}

// ----- Queries -------------------------------------------------------------------------------

/// Facts by key: the Hyprland window address (hex, as [`parse_address`] reads it) or the Sway
/// identifier.
pub enum Snapshot {
    Hyprland(HashMap<u64, Facts>),
    Sway(HashMap<String, Facts>),
}

impl Ipc {
    pub fn snapshot(&self) -> Option<Snapshot> {
        match self {
            Ipc::Hyprland(path) => {
                let clients = hyprland_request(path, "j/clients")?;
                let monitors = hyprland_request(path, "j/monitors").unwrap_or_default();
                let active = hyprland_request(path, "j/activewindow").unwrap_or_default();
                hyprland_facts(&clients, &monitors, &active).map(Snapshot::Hyprland)
            }
            Ipc::Sway(path) => sway_facts(&sway_request(path, SWAY_GET_TREE, "")?).map(Snapshot::Sway),
        }
    }

    /// Focus the window with this id ([`Facts::id`]): switches workspace, raises it.
    pub fn activate(&self, id: u64) -> std::result::Result<(), String> {
        match self {
            Ipc::Hyprland(path) => {
                let ask = |command: &str| {
                    hyprland_request(path, command)
                        .map(|reply| String::from_utf8_lossy(&reply).trim().to_owned())
                        .ok_or_else(|| "Hyprland did not answer".to_string())
                };
                let reply = ask(&format!("dispatch focuswindow address:0x{id:x}"))?;
                if reply == "ok" {
                    return Ok(());
                }
                // A Lua configuration (Hyprland 0.55+) takes dispatchers as Lua calls only.
                let lua = ask(&format!(r#"eval hl.dispatch(hl.dsp.focus({{ window = "address:0x{id:x}" }}))"#))?;
                if lua == "ok" {
                    Ok(())
                } else {
                    Err(format!("Hyprland: {reply} / {lua}"))
                }
            }
            Ipc::Sway(path) => {
                let reply = sway_request(path, SWAY_RUN_COMMAND, &format!("[con_id={id}] focus"))
                    .ok_or("Sway did not answer")?;
                if sway_success(&reply) {
                    Ok(())
                } else {
                    Err(format!("Sway: {}", String::from_utf8_lossy(&reply)))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLIENTS: &str = r#"[
      {"address":"0x55d1c2a3b4c0","mapped":true,"hidden":false,"at":[10,40],"size":[1280,720],
       "workspace":{"id":1,"name":"1"},"floating":false,"pseudo":false,"monitor":0,"class":"foot",
       "title":"a","initialClass":"foot","initialTitle":"a","pid":4242,"xwayland":false,"pinned":false,
       "fullscreen":0,"fullscreenClient":0,"grouped":[],"tags":[],"swallowing":"0x0",
       "focusHistoryID":1,"inhibitingIdle":false,"stableId":"18"},
      {"address":"0x55d1c2a3b000","mapped":true,"hidden":false,"at":[1930,10],"size":[800,600],
       "workspace":{"id":2,"name":"2"},"monitor":1,"class":"game","title":"b","pid":77,
       "focusHistoryID":0},
      {"address":"0x55d1c2a3c000","mapped":true,"hidden":false,"at":[50,50],"size":[300,200],
       "workspace":{"id":3,"name":"3"},"monitor":0,"class":"x","title":"c","pid":78,
       "focusHistoryID":2},
      {"address":"0x55d1c2a3d000","mapped":true,"hidden":false,"at":[0,0],"size":[100,100],
       "workspace":{"id":-98,"name":"special:magic"},"monitor":0,"class":"y","title":"d","pid":79,
       "focusHistoryID":3}
    ]"#;
    const MONITORS: &str = r#"[
      {"id":0,"name":"DP-1","x":0,"y":0,"width":2560,"height":1440,"scale":1.33,
       "activeWorkspace":{"id":1,"name":"1"},"specialWorkspace":{"id":-98,"name":"special:magic"},"focused":false},
      {"id":1,"name":"HDMI-A-1","x":1920,"y":0,"width":1920,"height":1080,"scale":1,
       "activeWorkspace":{"id":2,"name":"2"},"specialWorkspace":{"id":0,"name":""},"focused":true}
    ]"#;

    #[test]
    fn hyprland_clients_become_facts_by_address() {
        let active = br#"{"address":"0x55d1c2a3b000","title":"b"}"#;
        let facts = hyprland_facts(CLIENTS.as_bytes(), MONITORS.as_bytes(), active).unwrap();
        let a = &facts[&0x55d1c2a3b4c0];
        assert_eq!(a.pid, Some(4242));
        assert_eq!(a.bounds, Some(Rect { x: 10.0, y: 40.0, width: 1280.0, height: 720.0 }));
        assert_eq!(a.output.as_deref(), Some("DP-1"));
        assert_eq!(a.on_screen, Some(true));
        assert!(!a.focused);
        assert_eq!(a.rank, Some(1));
        assert_eq!(a.id, 0x55d1c2a3b4c0);
        let b = &facts[&0x55d1c2a3b000];
        assert!(b.focused);
        assert_eq!(b.on_screen, Some(true));
        assert_eq!(b.output.as_deref(), Some("HDMI-A-1"));
        // Another workspace on DP-1: not on screen.
        assert_eq!(facts[&0x55d1c2a3c000].on_screen, Some(false));
        // The special workspace open on DP-1: on screen.
        assert_eq!(facts[&0x55d1c2a3d000].on_screen, Some(true));
    }

    #[test]
    fn hyprland_focus_falls_back_to_focus_history() {
        let facts = hyprland_facts(CLIENTS.as_bytes(), MONITORS.as_bytes(), b"{}").unwrap();
        assert!(facts[&0x55d1c2a3b000].focused);
        assert!(!facts[&0x55d1c2a3b4c0].focused);
        assert!(hyprland_facts(b"not json", MONITORS.as_bytes(), b"{}").is_none());
    }

    #[test]
    fn addresses_parse_with_and_without_prefix() {
        assert_eq!(parse_address("0x55d1c2a3b4c0"), Some(0x55d1c2a3b4c0));
        assert_eq!(parse_address("55d1c2a3b4c0"), Some(0x55d1c2a3b4c0));
        assert_eq!(parse_address("0xzz"), None);
        assert_eq!(format!("0x{:x}", 0x55d1c2a3b4c0u64), "0x55d1c2a3b4c0");
    }

    const TREE: &str = r#"{"id":1,"type":"root","name":"root","rect":{"x":0,"y":0,"width":3200,"height":1080},
      "focus":[3,2],"nodes":[
        {"id":2,"type":"output","name":"__i3","rect":{"x":0,"y":0,"width":1920,"height":1080},"nodes":[
          {"id":9,"type":"workspace","name":"__i3_scratch","rect":{"x":0,"y":0,"width":1920,"height":1080},
           "nodes":[],"floating_nodes":[
             {"id":10,"type":"floating_con","name":"hidden","rect":{"x":0,"y":0,"width":400,"height":300},
              "window_rect":{"x":2,"y":2,"width":396,"height":296},"pid":12,"visible":false,"focused":false,
              "foreign_toplevel_identifier":"aaa","nodes":[]}]}]},
        {"id":3,"type":"output","name":"HEADLESS-1","rect":{"x":0,"y":0,"width":1920,"height":1080},
         "focus":[4],"nodes":[
          {"id":4,"type":"workspace","name":"1","rect":{"x":0,"y":0,"width":1920,"height":1080},
           "focus":[8,7],"nodes":[
             {"id":7,"type":"con","name":"tiled","rect":{"x":0,"y":0,"width":1920,"height":1080},
              "window_rect":{"x":2,"y":2,"width":1916,"height":1076},"pid":30,"visible":true,"focused":false,
              "foreign_toplevel_identifier":"bbb","nodes":[],"floating_nodes":[]}],
           "floating_nodes":[
             {"id":8,"type":"floating_con","name":"front","rect":{"x":500,"y":300,"width":804,"height":504},
              "window_rect":{"x":2,"y":2,"width":800,"height":500},"pid":31,"visible":true,"focused":true,
              "foreign_toplevel_identifier":"ccc","nodes":[]},
             {"id":11,"type":"floating_con","name":"old","rect":{"x":0,"y":0,"width":10,"height":10},
              "pid":32,"visible":true,"focused":false,"nodes":[]}]}]}]}"#;

    #[test]
    fn sway_tree_becomes_facts_by_identifier() {
        let facts = sway_facts(TREE.as_bytes()).unwrap();
        assert_eq!(facts.len(), 3, "the window without an identifier is left out");
        let front = &facts["ccc"];
        assert_eq!(front.bounds, Some(Rect { x: 502.0, y: 302.0, width: 800.0, height: 500.0 }));
        assert_eq!(front.pid, Some(31));
        assert!(front.focused);
        assert_eq!(front.on_screen, Some(true));
        assert_eq!(front.output.as_deref(), Some("HEADLESS-1"));
        assert_eq!(front.id, 8);
        assert_eq!(front.rank, Some(0));
        assert_eq!(facts["bbb"].rank, Some(1));
        assert_eq!(facts["bbb"].bounds, Some(Rect { x: 2.0, y: 2.0, width: 1916.0, height: 1076.0 }));
        let hidden = &facts["aaa"];
        assert_eq!(hidden.on_screen, Some(false));
        assert_eq!(hidden.output, None, "the scratchpad is no output");
        assert_eq!(hidden.rank, Some(2));
    }

    #[test]
    fn sway_command_replies() {
        assert!(sway_success(br#"[{"success":true}]"#));
        assert!(!sway_success(br#"[{"success":false,"error":"No matching node"}]"#));
        assert!(!sway_success(b"[]"));
    }
}
