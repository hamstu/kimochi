//! The `mutter` driver: GNOME Shell. See the table in `mod.rs`.
//!
//! - **Inventory**: Kimochi's GNOME Shell extension (`dev.kimochi.GnomeOverlay`, method
//!   `Windows`) lists every window with Mutter's own id (`MetaWindow.get_id()`), its app, pid,
//!   focus, workspace and the rectangle Mutter streams for it. Monitors come from Mutter's
//!   `org.gnome.Mutter.DisplayConfig` (`GetCurrentState`: connectors, logical layout, scale),
//!   which any client of the session may read. Without the extension (or with one too old to
//!   have `Windows`) the driver is unavailable and the app keeps the portal.
//! - **Capture**: `org.gnome.Mutter.ScreenCast`, the API GNOME's own portal backend is built on:
//!   `CreateSession` → `RecordWindow({window-id, cursor-mode: hidden})` or
//!   `RecordMonitor(connector, …)` → `Start` → `PipeWireStreamAdded(node)`; the node is on the
//!   session's PipeWire daemon ([`pipewire_feed`]). GNOME shows its screen-sharing indicator while
//!   a session runs, as for any screencast. A window stream renders that window alone, and its
//!   `VideoCrop` region is the window's buffer rectangle, which is what `bounds` reports.
//! - The ScreenCast session belongs to the D-Bus connection that created it, so the driver keeps
//!   one connection for its lifetime; dropping a feed stops its session.
use super::backend::{pipewire_feed, Driver, Feed, Target};
use super::{Inventory, NativeOutput, NativeWindow};
use crate::{CaptureError, Rect, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

const EXTENSION: &str = "dev.kimochi.GnomeOverlay";
const EXTENSION_PATH: &str = "/dev/kimochi/GnomeOverlay";
const SCREENCAST: &str = "org.gnome.Mutter.ScreenCast";
const SCREENCAST_PATH: &str = "/org/gnome/Mutter/ScreenCast";
const DISPLAY_CONFIG: &str = "org.gnome.Mutter.DisplayConfig";
const DISPLAY_CONFIG_PATH: &str = "/org/gnome/Mutter/DisplayConfig";
/// Mutter answers a stream's node within a frame or two of `Start`.
const STREAM_WAIT: Duration = Duration::from_secs(3);
/// `cursor-mode`: the pointer is not drawn into the stream (OCR reads text under it).
const CURSOR_HIDDEN: u32 = 0;

fn native(e: impl ToString) -> CaptureError {
    CaptureError::new("native", e)
}

#[derive(Debug, Deserialize)]
struct ShellRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl From<&ShellRect> for Rect {
    fn from(r: &ShellRect) -> Self {
        Rect { x: r.x, y: r.y, width: r.width, height: r.height }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellWindow {
    id: String,
    #[serde(default)]
    title: String,
    app_id: Option<String>,
    app_name: Option<String>,
    pid: i64,
    bounds: ShellRect,
    monitor: i64,
    #[serde(default)]
    minimized: bool,
    #[serde(default)]
    on_screen: bool,
    #[serde(default)]
    focused: bool,
    #[serde(default)]
    auxiliary: bool,
}

#[derive(Debug, Deserialize)]
struct ShellMonitor {
    index: i64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
    #[serde(default)]
    primary: bool,
}

#[derive(Debug, Deserialize)]
struct ShellWindows {
    windows: Vec<ShellWindow>,
    monitors: Vec<ShellMonitor>,
}

/// One logical monitor from `DisplayConfig.GetCurrentState`: where it is and its connectors
/// (with vendor and product), for `RecordMonitor` and a readable name.
#[derive(Clone, Debug, PartialEq)]
struct LogicalMonitor {
    x: i32,
    y: i32,
    scale: f64,
    primary: bool,
    /// (connector, vendor, product)
    monitors: Vec<(String, String, String)>,
}

/// `.desktop` suffix off a desktop file id: `org.gnome.Nautilus.desktop` → `org.gnome.Nautilus`.
fn app_id(raw: Option<String>) -> Option<String> {
    raw.filter(|s| !s.is_empty()).map(|s| s.strip_suffix(".desktop").map(str::to_string).unwrap_or(s))
}

fn output_name(vendor: &str, product: &str, connector: &str) -> String {
    let known = |s: &str| !s.is_empty() && s != "unknown";
    match (known(vendor), known(product)) {
        (true, true) => format!("{vendor} {product}"),
        (false, true) => product.to_string(),
        _ if connector.starts_with("eDP") || connector.starts_with("LVDS") => "Built-in display".into(),
        _ => connector.to_string(),
    }
}

/// The inventory from the extension's answer and Mutter's monitors. A Shell monitor and a
/// DisplayConfig logical monitor are the same one when they start at the same point.
fn assemble(shell: ShellWindows, logical: &[LogicalMonitor]) -> Inventory {
    let outputs: Vec<(i64, NativeOutput)> = shell
        .monitors
        .iter()
        .filter_map(|m| {
            let lm = logical.iter().find(|l| f64::from(l.x) == m.x && f64::from(l.y) == m.y)?;
            let (connector, vendor, product) = lm.monitors.first()?.clone();
            Some((
                m.index,
                NativeOutput {
                    name: output_name(&vendor, &product, &connector),
                    handle: connector,
                    bounds: Rect { x: m.x, y: m.y, width: m.width, height: m.height },
                    scale: if lm.scale > 0.0 { lm.scale } else { m.scale.max(1.0) },
                    primary: m.primary || lm.primary,
                },
            ))
        })
        .collect();
    let windows = shell
        .windows
        .into_iter()
        .filter(|w| w.id.bytes().all(|b| b.is_ascii_digit()) && !w.id.is_empty())
        .map(|w| NativeWindow {
            output: outputs.iter().find(|(i, _)| *i == w.monitor).map(|(_, o)| o.handle.clone()),
            handle: w.id,
            title: w.title,
            app_id: app_id(w.app_id),
            // Shell calls an app it cannot place "Unknown".
            app_name: w.app_name.filter(|s| !s.is_empty() && s != "Unknown"),
            pid: u32::try_from(w.pid).ok().filter(|p| *p > 0),
            bounds: Some(Rect::from(&w.bounds)).filter(|b| b.width > 0.0 && b.height > 0.0),
            minimized: w.minimized,
            on_screen: Some(w.on_screen),
            focused: w.focused,
            auxiliary: w.auxiliary,
        })
        .collect();
    Inventory { windows, outputs: outputs.into_iter().map(|(_, o)| o).collect() }
}

/// A mode: id, width, height, refresh, preferred scale, supported scales, properties.
type StateMode = (String, i32, i32, f64, f64, Vec<f64>, HashMap<String, OwnedValue>);
type StateMonitor = ((String, String, String, String), Vec<StateMode>, HashMap<String, OwnedValue>);
type StateLogical = (i32, i32, f64, u32, bool, Vec<(String, String, String, String)>, HashMap<String, OwnedValue>);

struct Mutter {
    connection: Connection,
}

impl Mutter {
    fn extension(&self, payload: &str) -> Result<String> {
        let proxy = Proxy::new(&self.connection, EXTENSION, EXTENSION_PATH, EXTENSION).map_err(native)?;
        proxy.call("Windows", &(payload,)).map_err(|e| native(format!("GNOME Shell extension: {e}")))
    }

    fn logical_monitors(&self) -> Vec<LogicalMonitor> {
        let read = || -> zbus::Result<Vec<LogicalMonitor>> {
            let proxy = Proxy::new(&self.connection, DISPLAY_CONFIG, DISPLAY_CONFIG_PATH, DISPLAY_CONFIG)?;
            let (_serial, _monitors, logical, _props): (
                u32,
                Vec<StateMonitor>,
                Vec<StateLogical>,
                HashMap<String, OwnedValue>,
            ) = proxy.call("GetCurrentState", &())?;
            Ok(logical
                .into_iter()
                .map(|(x, y, scale, _transform, primary, monitors, _)| LogicalMonitor {
                    x,
                    y,
                    scale,
                    primary,
                    monitors: monitors.into_iter().map(|(c, v, p, _)| (c, v, p)).collect(),
                })
                .collect())
        };
        read().unwrap_or_else(|e| {
            eprintln!("Mutter DisplayConfig: {e}");
            Vec::new()
        })
    }

    /// Start a ScreenCast session recording one window or monitor, and its PipeWire node.
    fn record(&self, target: Target<'_>) -> Result<(u32, Session)> {
        let screencast = Proxy::new(&self.connection, SCREENCAST, SCREENCAST_PATH, SCREENCAST).map_err(native)?;
        let path: OwnedObjectPath = screencast
            .call("CreateSession", &(HashMap::<&str, Value>::new(),))
            .map_err(|e| native(format!("Mutter ScreenCast: {e}")))?;
        // From here the session is ours to stop, also on failure.
        let session = Session { connection: self.connection.clone(), path };
        let session_path = session.path.to_string();
        let proxy = Proxy::new(&self.connection, SCREENCAST, session_path, "org.gnome.Mutter.ScreenCast.Session")
            .map_err(native)?;
        let stream: OwnedObjectPath = match target {
            Target::Window(w) => {
                let id: u64 =
                    w.handle.parse().map_err(|_| CaptureError::new("stale_source", "Not a GNOME window id"))?;
                let mut props: HashMap<&str, Value> = HashMap::new();
                props.insert("window-id", Value::U64(id));
                props.insert("cursor-mode", Value::U32(CURSOR_HIDDEN));
                proxy.call("RecordWindow", &(props,))
            }
            Target::Output(o) => {
                let mut props: HashMap<&str, Value> = HashMap::new();
                props.insert("cursor-mode", Value::U32(CURSOR_HIDDEN));
                proxy.call("RecordMonitor", &(o.handle.as_str(), props))
            }
        }
        .map_err(|e| match target {
            Target::Window(_) => CaptureError::new("stale_source", format!("Mutter could not record that window: {e}")),
            Target::Output(_) => native(format!("Mutter could not record that monitor: {e}")),
        })?;
        drop(proxy);
        let node = async_io::block_on(started_node(self.connection.inner(), &session.path, &stream))?;
        Ok((node, session))
    }
}

/// Subscribe to the stream's node announcement, start the session, and wait for the node.
async fn started_node(
    connection: &zbus::Connection,
    session: &OwnedObjectPath,
    stream: &OwnedObjectPath,
) -> Result<u32> {
    use futures_util::future::{select, Either};
    use futures_util::StreamExt;
    let stream_proxy = zbus::Proxy::new(connection, SCREENCAST, stream.as_str(), "org.gnome.Mutter.ScreenCast.Stream")
        .await
        .map_err(native)?;
    let mut added = stream_proxy.receive_signal("PipeWireStreamAdded").await.map_err(native)?;
    let session_proxy =
        zbus::Proxy::new(connection, SCREENCAST, session.as_str(), "org.gnome.Mutter.ScreenCast.Session")
            .await
            .map_err(native)?;
    session_proxy.call_method("Start", &()).await.map_err(|e| native(format!("Mutter ScreenCast Start: {e}")))?;
    let timeout = async_io::Timer::after(STREAM_WAIT);
    match select(added.next(), timeout).await {
        Either::Left((Some(message), _)) => message.body().deserialize::<u32>().map_err(native),
        Either::Left((None, _)) => Err(native("Mutter ended the stream before it started")),
        Either::Right(_) => Err(native("Mutter did not start the stream in time")),
    }
}

/// A running ScreenCast session; dropping it stops the session.
struct Session {
    connection: Connection,
    path: OwnedObjectPath,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(proxy) =
            Proxy::new(&self.connection, SCREENCAST, self.path.as_str(), "org.gnome.Mutter.ScreenCast.Session")
        {
            // Already gone when the window closed or Mutter ended it: nothing to do.
            let _ = proxy.call_method("Stop", &());
        }
    }
}

impl Driver for Mutter {
    fn name(&self) -> &'static str {
        "mutter"
    }
    fn inventory(&self) -> Result<Inventory> {
        let text = self.extension(r#"{"operation":"list"}"#)?;
        let shell: ShellWindows = serde_json::from_str(&text).map_err(native)?;
        Ok(assemble(shell, &self.logical_monitors()))
    }
    fn open(&self, target: Target<'_>) -> Result<Feed> {
        let (node, session) = self.record(target)?;
        pipewire_feed(node, Box::new(session))
    }
    fn activate(&self, window: &NativeWindow) -> Result<()> {
        let payload = serde_json::json!({"operation": "activate", "id": window.handle}).to_string();
        self.extension(&payload).map(|_| ())
    }
}

pub fn probe() -> std::result::Result<Box<dyn Driver>, String> {
    let connection = Connection::session().map_err(|e| format!("no session bus: {e}"))?;
    let screencast = Proxy::new(&connection, SCREENCAST, SCREENCAST_PATH, SCREENCAST).map_err(|e| e.to_string())?;
    let version: i32 =
        screencast.get_property("Version").map_err(|e| format!("org.gnome.Mutter.ScreenCast is not available: {e}"))?;
    // RecordWindow takes `window-id` from version 3 (GNOME 3.38) on.
    if version < 3 {
        return Err(format!("Mutter's ScreenCast API is version {version}; window capture needs 3"));
    }
    let mutter = Mutter { connection };
    let text = mutter.extension(r#"{"operation":"list"}"#).map_err(|e| {
        format!(
            "Kimochi's GNOME Shell extension has no window list (install or update it, then log out and in): {}",
            e.message
        )
    })?;
    serde_json::from_str::<ShellWindows>(&text).map_err(|e| format!("GNOME Shell extension answered: {e}"))?;
    Ok(Box::new(mutter))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANSWER: &str = r#"{"windows":[
        {"id":"2849571","title":"CLANNAD","appId":"steam_app_1.desktop","appName":"CLANNAD","iconName":"steam_icon_1","wmClass":"steam_app_1","pid":4242,
         "bounds":{"x":100,"y":50,"width":1280,"height":720},"frame":{"x":100,"y":50,"width":1280,"height":720},"monitor":1,"scale":2,
         "minimized":false,"onScreen":true,"focused":true,"auxiliary":false,"xwayland":true},
        {"id":"17","title":"","appId":null,"appName":null,"pid":0,"bounds":{"x":0,"y":0,"width":0,"height":0},"monitor":0,"scale":1,
         "minimized":true,"onScreen":false,"focused":false,"auxiliary":true},
        {"id":"bad:id","title":"x","pid":1,"bounds":{"x":0,"y":0,"width":1,"height":1},"monitor":0,"scale":1}
    ],"monitors":[
        {"index":0,"x":0,"y":0,"width":1920,"height":1080,"scale":1,"primary":true},
        {"index":1,"x":1920,"y":0,"width":1280,"height":800,"scale":2,"primary":false}
    ]}"#;

    fn logical() -> Vec<LogicalMonitor> {
        vec![
            LogicalMonitor {
                x: 1920,
                y: 0,
                scale: 2.0,
                primary: false,
                monitors: vec![("eDP-1".into(), "unknown".into(), "unknown".into())],
            },
            LogicalMonitor {
                x: 0,
                y: 0,
                scale: 1.0,
                primary: true,
                monitors: vec![("DP-1".into(), "DEL".into(), "DELL U2720Q".into())],
            },
        ]
    }

    #[test]
    fn windows_and_monitors_become_an_inventory() {
        let inv = assemble(serde_json::from_str(ANSWER).unwrap(), &logical());
        assert_eq!(inv.outputs.len(), 2);
        assert_eq!(inv.outputs[0].handle, "DP-1");
        assert_eq!(inv.outputs[0].name, "DEL DELL U2720Q");
        assert!(inv.outputs[0].primary);
        assert_eq!(inv.outputs[1].handle, "eDP-1");
        assert_eq!(inv.outputs[1].name, "Built-in display");
        assert_eq!(inv.outputs[1].scale, 2.0);
        // The malformed id is dropped; a handle never carries `:`.
        assert_eq!(inv.windows.len(), 2);
        let game = &inv.windows[0];
        assert_eq!(game.handle, "2849571");
        assert_eq!(game.app_id.as_deref(), Some("steam_app_1"));
        assert_eq!(game.pid, Some(4242));
        assert_eq!(game.output.as_deref(), Some("eDP-1"));
        assert_eq!(game.bounds, Some(Rect { x: 100.0, y: 50.0, width: 1280.0, height: 720.0 }));
        assert!(game.focused && game.on_screen == Some(true));
        let other = &inv.windows[1];
        assert_eq!(other.pid, None);
        assert_eq!(other.bounds, None);
        assert!(other.minimized && other.auxiliary);
    }

    #[test]
    fn monitors_without_a_display_config_match_are_left_out() {
        let inv = assemble(serde_json::from_str(ANSWER).unwrap(), &[]);
        assert!(inv.outputs.is_empty());
        assert_eq!(inv.windows[0].output, None);
    }
}
