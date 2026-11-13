//! Optional KWin (KDE Plasma) window geometry, pointer and activation for portal window streams.
//!
//! Wayland gives an app no window positions, and the ScreenCast portal names a shared window by
//! nothing but its PipeWire node (KDE's restore data has its app id and title, never its place).
//! KWin's scripting API knows every window's frame, so Kimochi loads a small KWin script that
//! answers its questions over the session bus:
//!
//! - At first use Kimochi serves `dev.kimochi.KWinBridge` on its own connection and loads
//!   [`SCRIPT`] through `org.kde.kwin.Scripting`, with that connection's unique name baked in.
//! - The script **pushes** a snapshot of the windows and outputs (`Push`) whenever one changes:
//!   a window added, removed, moved, resized, minimised, activated, retitled, sent to another
//!   desktop or output, or the desktop or outputs themselves. Nothing is sent while nothing
//!   changes; a snapshot older than [`REFRESH`] is asked for again, in case a change was missed.
//! - It also long-polls `Next` (KWin's `callDBus` is asynchronous, so the wait never blocks the
//!   compositor), runs the command it gets (`snapshot`, `pointer`, `activate`) and answers through
//!   `Reply`. `Next` returns empty after [`POLL`] so a call never meets D-Bus's timeout.
//! - Only KWin's own bus name may call the bridge. A command that gets no answer (KWin restarted,
//!   the script stopped) reloads the script, at most every [`RELOAD`].
//!
//! Matching follows `hyprland.rs`: a portal window stream is linked to a KWin window whose frame,
//! times its output's scale, is exactly the stream's size, when exactly one window fits; equal
//! sizes need the explicit **Link window** choice. KWin's window streams are the whole frame,
//! server-side title bar included, so the frame (not the client area) is what is compared.
//!
//! Coordinates: KWin's are global logical pixels. Kimochi's layer surfaces share one output (the
//! overlay is anchored to all its edges), and they are moved to the linked window's output
//! (`layer::follow_output`); bounds and the pointer are relative to that output.
use kimochi_capture::{Frame, Rect};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicI32, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

const PATH: &str = "/dev/kimochi/KWinBridge";
const PLUGIN: &str = "kimochi-bridge";
/// How long `Next` holds the script's call before an empty answer (well inside D-Bus's 25 s).
const POLL: Duration = Duration::from_secs(10);
/// How long a command waits for the script.
const ANSWER: Duration = Duration::from_millis(400);
const RELOAD: Duration = Duration::from_secs(5);
/// A pushed snapshot is trusted this long without a change; then it is asked for again.
const REFRESH: Duration = Duration::from_secs(2);

/// The script KWin runs. `%SERVICE%` becomes the bridge's unique bus name.
const SCRIPT: &str = r#"
const S = "%SERVICE%", P = "/dev/kimochi/KWinBridge", I = "dev.kimochi.KWinBridge";
const list = () => workspace.windowList ? workspace.windowList() : workspace.clientList();
const rect = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });
function desktopOk(w) {
  if (w.onAllDesktops) return true;
  const cur = workspace.currentDesktop;
  if (!w.desktops || !cur) return true;
  for (const d of w.desktops) if (d === cur || d.id === cur.id) return true;
  return false;
}
function outputOf(w) { return w.output ? w.output.name : null; }
function snapshot() {
  const active = workspace.activeWindow;
  const stack = workspace.stackingOrder || [];
  const windows = [];
  for (const w of list()) {
    if (w.deleted || w.desktopWindow || w.dock || w.splash || w.tooltip || w.notification
        || w.criticalNotification || w.onScreenDisplay || w.popupWindow) continue;
    windows.push({
      id: w.internalId.toString(), pid: w.pid, class: w.resourceClass || "", name: w.resourceName || "",
      desktopFile: w.desktopFileName || "", title: w.caption || "", frame: rect(w.frameGeometry),
      client: w.clientGeometry ? rect(w.clientGeometry) : null,
      output: outputOf(w), minimized: !!w.minimized, hidden: !!w.hidden, onDesktop: desktopOk(w),
      normal: !!(w.normalWindow || w.dialog), layer: w.layer === undefined ? null : w.layer,
      fullScreen: !!w.fullScreen, active: w === active, stack: stack.indexOf(w)
    });
  }
  const outputs = (workspace.screens || []).map(o => ({ name: o.name, geometry: rect(o.geometry), scale: o.devicePixelRatio || 1 }));
  return { windows, outputs };
}
function activate(id) {
  const w = list().find(w => w.internalId.toString() === id);
  if (!w) return false;
  if (w.minimized) w.minimized = false;
  if (!desktopOk(w) && w.desktops && w.desktops.length) workspace.currentDesktop = w.desktops[0];
  workspace.raiseWindow ? workspace.raiseWindow(w) : null;
  workspace.activeWindow = w;
  return true;
}
function run(command) {
  if (command.op === "snapshot") return snapshot();
  if (command.op === "pointer") return { x: workspace.cursorPos.x, y: workspace.cursorPos.y };
  if (command.op === "activate") return activate(command.id);
  return null;
}
function push() { callDBus(S, P, I, "Push", JSON.stringify(snapshot())); }
const SIGNALS = ["frameGeometryChanged", "minimizedChanged", "activeChanged", "captionChanged", "desktopsChanged",
  "outputChanged", "fullScreenChanged", "hiddenChanged"];
function watch(w) { for (const name of SIGNALS) if (w[name] && w[name].connect) w[name].connect(push); }
for (const w of list()) watch(w);
workspace.windowAdded.connect(w => { watch(w); push(); });
workspace.windowRemoved.connect(push);
workspace.windowActivated.connect(push);
workspace.currentDesktopChanged.connect(push);
if (workspace.screensChanged) workspace.screensChanged.connect(push);
if (workspace.stackingOrderChanged) workspace.stackingOrderChanged.connect(push);
push();
function poll() {
  callDBus(S, P, I, "Next", function (text) {
    if (text) {
      let command = null, result = null;
      try { command = JSON.parse(text); result = run(command); } catch (e) { result = { error: String(e) }; }
      if (command) callDBus(S, P, I, "Reply", command.seq, JSON.stringify(result === undefined ? null : result));
    }
    poll();
  });
}
poll();
"#;

#[derive(Clone, Debug, Deserialize)]
struct Window {
    id: String,
    pid: u32,
    #[serde(default)]
    class: String,
    #[serde(default, rename = "desktopFile")]
    desktop_file: String,
    #[serde(default)]
    title: String,
    frame: Rect,
    /// The window's own area, without KWin's title bar and borders: what KWin streams for an
    /// XWayland window (a Proton game in a window), where a Wayland window's stream is its frame.
    #[serde(default)]
    client: Option<Rect>,
    output: Option<String>,
    minimized: bool,
    hidden: bool,
    #[serde(rename = "onDesktop")]
    on_desktop: bool,
    normal: bool,
    /// KWin's stacking layer; Kimochi's overlay is a layer-shell surface above the normal (2).
    #[serde(default)]
    layer: Option<i32>,
    #[serde(default)]
    active: bool,
    /// Position in KWin's stacking order, bottom first; `None` from a script without it (or -1).
    #[serde(default)]
    stack: Option<i64>,
}
#[derive(Clone, Debug, Deserialize)]
struct Output {
    name: String,
    geometry: Rect,
    scale: f64,
}
#[derive(Clone, Debug, Deserialize)]
struct Point {
    x: f64,
    y: f64,
}
#[derive(Clone, Debug, Deserialize)]
struct Snapshot {
    windows: Vec<Window>,
    outputs: Vec<Output>,
}
#[derive(Clone)]
struct Binding {
    source: String,
    id: String,
    pid: u32,
    bounds: Rect,
    /// The stream is the window's client area (see `Window::client`), not its frame.
    client: bool,
}

struct Bridge {
    connection: zbus::blocking::Connection,
    commands: async_channel::Sender<String>,
    loaded: Mutex<Option<Instant>>,
}
static BRIDGE: OnceLock<Option<Bridge>> = OnceLock::new();
/// KWin's unique name: the only caller the bridge answers. Apart from `BRIDGE`, which is still
/// being initialised when the freshly loaded script first polls.
static KWIN: Mutex<String> = Mutex::new(String::new());
static SEQ: AtomicI32 = AtomicI32::new(0);
type Waiters = HashMap<i32, std::sync::mpsc::Sender<String>>;
static WAITING: Mutex<Option<Waiters>> = Mutex::new(None);
static CACHE: Mutex<Option<(Instant, Option<Snapshot>)>> = Mutex::new(None);
static BINDING: Mutex<Option<Binding>> = Mutex::new(None);

struct Service {
    commands: async_channel::Receiver<String>,
}
#[zbus::interface(name = "dev.kimochi.KWinBridge")]
impl Service {
    /// The script's long poll: the next command, or empty after `POLL`.
    async fn next(&self, #[zbus(header)] header: zbus::message::Header<'_>) -> zbus::fdo::Result<String> {
        authorize(&header)?;
        let next = async { self.commands.recv().await.unwrap_or_default() };
        let idle = async {
            async_io::Timer::after(POLL).await;
            String::new()
        };
        Ok(futures_lite::future::or(next, idle).await)
    }
    /// The script's snapshot after a change.
    fn push(&self, #[zbus(header)] header: zbus::message::Header<'_>, json: String) -> zbus::fdo::Result<()> {
        authorize(&header)?;
        if let Ok(snapshot) = serde_json::from_str::<Snapshot>(&json) {
            if let Ok(mut cache) = CACHE.lock() {
                *cache = Some((Instant::now(), Some(snapshot)));
            }
        }
        Ok(())
    }
    /// A command's answer, as JSON. (KWin passes a script's numbers as `int32`.)
    fn reply(
        &self,
        #[zbus(header)] header: zbus::message::Header<'_>,
        seq: i32,
        json: String,
    ) -> zbus::fdo::Result<()> {
        authorize(&header)?;
        if let Some(waiter) = WAITING.lock().ok().and_then(|mut w| w.as_mut()?.remove(&seq)) {
            let _ = waiter.send(json);
        }
        Ok(())
    }
}

fn authorize(header: &zbus::message::Header<'_>) -> zbus::fdo::Result<()> {
    let kwin = KWIN.lock().map(|k| k.clone()).unwrap_or_default();
    match header.sender() {
        Some(sender) if !kwin.is_empty() && sender.as_str() == kwin => Ok(()),
        _ => Err(zbus::fdo::Error::AccessDenied("only KWin may call Kimochi's bridge".into())),
    }
}

fn eligible() -> bool {
    std::env::var("KIMOCHI_KWIN_WINDOW_TRACKING").as_deref() != Ok("0")
        && super::session().backend == super::Backend::Wayland
        && super::session().compositor.as_deref() == Some("KDE")
        && super::layer::available()
}

fn bridge() -> Option<&'static Bridge> {
    BRIDGE
        .get_or_init(|| {
            if !eligible() {
                return None;
            }
            match start() {
                Ok(bridge) => Some(bridge),
                Err(error) => {
                    eprintln!("KWin window tracking unavailable: {error}");
                    None
                }
            }
        })
        .as_ref()
}

fn start() -> Result<Bridge, String> {
    let (commands, queue) = async_channel::bounded(16);
    let connection = zbus::blocking::connection::Builder::session()
        .map_err(|e| e.to_string())?
        .serve_at(PATH, Service { commands: queue })
        .map_err(|e| e.to_string())?
        .method_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    *WAITING.lock().map_err(|e| e.to_string())? = Some(HashMap::new());
    let bridge = Bridge { connection, commands, loaded: Mutex::new(None) };
    load(&bridge)?;
    eprintln!("KWin window tracking: bridge script loaded");
    Ok(bridge)
}

/// (Re)load the script: unload any copy left by an earlier run, write it with this connection's
/// name, load and run it.
fn load(bridge: &Bridge) -> Result<(), String> {
    let conn = &bridge.connection;
    let dbus = zbus::blocking::fdo::DBusProxy::new(conn).map_err(|e| e.to_string())?;
    let kwin = dbus
        .get_name_owner("org.kde.KWin".try_into().map_err(|e: zbus::names::Error| e.to_string())?)
        .map_err(|e| format!("KWin is not on the session bus: {e}"))?;
    *KWIN.lock().map_err(|e| e.to_string())? = kwin.to_string();
    let me = conn.unique_name().ok_or("no unique bus name")?.to_string();
    let scripting = zbus::blocking::Proxy::new(conn, "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting")
        .map_err(|e| e.to_string())?;
    let _: Result<bool, _> = scripting.call("unloadScript", &(PLUGIN,));
    let dir = std::env::var_os("XDG_RUNTIME_DIR").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let path = dir.join(format!("kimochi-kwin-bridge-{}.js", std::process::id()));
    std::fs::write(&path, SCRIPT.replace("%SERVICE%", &me)).map_err(|e| e.to_string())?;
    let id: i32 = scripting
        .call("loadScript", &(path.to_string_lossy().as_ref(), PLUGIN))
        .map_err(|e| format!("KWin refused the bridge script: {e}"))?;
    if id < 0 {
        return Err("KWin refused the bridge script".into());
    }
    // Plasma 6 publishes scripts at /Scripting/Script<id>; Plasma 5 at /<id>.
    let ran = [format!("/Scripting/Script{id}"), format!("/{id}")].iter().any(|object| {
        zbus::blocking::Proxy::new(conn, "org.kde.KWin", object.as_str(), "org.kde.kwin.Script")
            .and_then(|script| script.call::<_, _, ()>("run", &()))
            .is_ok()
    });
    let _ = std::fs::remove_file(&path);
    if !ran {
        return Err("KWin did not run the bridge script".into());
    }
    *bridge.loaded.lock().map_err(|e| e.to_string())? = Some(Instant::now());
    Ok(())
}

/// Ask the script; `None` when it does not answer in time (and then reload it, rate-limited).
fn ask(op: &str, extra: Value) -> Option<Value> {
    let bridge = bridge()?;
    let seq = SEQ.fetch_add(1, Ordering::SeqCst) & i32::MAX;
    let (tx, rx) = std::sync::mpsc::channel();
    WAITING.lock().ok()?.as_mut()?.insert(seq, tx);
    let mut command = json!({"seq": seq, "op": op});
    if let (Some(command), Some(extra)) = (command.as_object_mut(), extra.as_object()) {
        command.extend(extra.clone());
    }
    let sent = bridge.commands.try_send(command.to_string()).is_ok();
    let answer = sent.then(|| rx.recv_timeout(ANSWER).ok()).flatten();
    if let Ok(mut waiting) = WAITING.lock() {
        waiting.as_mut().map(|w| w.remove(&seq));
    }
    match answer {
        Some(text) => serde_json::from_str(&text).ok(),
        None => {
            // Commands the dead script never collected stay queued; the fresh script answers them
            // into the void (their waiters are gone).
            let stale = bridge.loaded.lock().ok().and_then(|l| *l).is_none_or(|at| at.elapsed() > RELOAD);
            if stale {
                match load(bridge) {
                    Ok(()) => eprintln!("KWin window tracking: bridge script reloaded"),
                    Err(error) => {
                        eprintln!("KWin window tracking: reload failed: {error}");
                        if let Ok(mut loaded) = bridge.loaded.lock() {
                            *loaded = Some(Instant::now());
                        }
                    }
                }
            }
            None
        }
    }
}

fn snapshot() -> Option<Snapshot> {
    bridge()?;
    if let Some((at, snapshot)) = CACHE.lock().ok()?.clone() {
        // A script that did not answer is not asked again for a while: the overlay polls often.
        if at.elapsed() < if snapshot.is_some() { REFRESH } else { Duration::from_secs(1) } {
            return snapshot;
        }
    }
    // Not under the lock: a `Push` may arrive meanwhile, on the thread that delivers the answer.
    let value = ask("snapshot", json!({})).and_then(|v| serde_json::from_value::<Snapshot>(v).ok());
    *CACHE.lock().ok()? = Some((Instant::now(), value.clone()));
    value
}

pub fn available() -> bool {
    bridge().is_some()
}

/// The output Kimochi's overlay is on: the one it was last moved to (`layer::follow_output`), else
/// the output its own layer surface's frame matches (a normal window that fills an output is not
/// it), else the only output there is.
fn overlay_output(snapshot: &Snapshot) -> Option<&Output> {
    if let Some(moved) = super::layer::current_output() {
        if let Some(output) = snapshot.outputs.iter().find(|o| same_rect(&o.geometry, &moved)) {
            return Some(output);
        }
    }
    let own = std::process::id();
    let frames: Vec<&Rect> = snapshot
        .windows
        .iter()
        .filter(|w| w.pid == own && w.layer.is_some_and(|layer| layer > 2))
        .map(|w| &w.frame)
        .collect();
    snapshot
        .outputs
        .iter()
        .find(|o| frames.iter().any(|f| same_rect(f, &o.geometry)))
        .or_else(|| (snapshot.outputs.len() == 1).then(|| &snapshot.outputs[0]))
}

fn same_rect(a: &Rect, b: &Rect) -> bool {
    (a.x - b.x).abs() < 0.5
        && (a.y - b.y).abs() < 0.5
        && (a.width - b.width).abs() < 0.5
        && (a.height - b.height).abs() < 0.5
}

fn output_of<'a>(snapshot: &'a Snapshot, window: &Window) -> Option<&'a Output> {
    snapshot.outputs.iter().find(|o| Some(&o.name) == window.output.as_ref())
}

/// Which of the window's areas a stream of this size shows: `Some(false)` its frame, `Some(true)`
/// its client area (an XWayland window's stream has no title bar), `None` neither. A stream's
/// buffer is that area at its output's scale (fractional scales round to whole pixels, so one
/// pixel of slack).
fn streamed_area(snapshot: &Snapshot, window: &Window, width: u32, height: u32) -> Option<bool> {
    let scale = output_of(snapshot, window).map_or(1., |o| o.scale);
    let fits = |r: &Rect| {
        let at = |scale: f64| {
            (r.width * scale - f64::from(width)).abs() <= 1. && (r.height * scale - f64::from(height)).abs() <= 1.
        };
        r.width > 0. && r.height > 0. && (at(scale) || at(1.))
    };
    if fits(&window.frame) {
        Some(false)
    } else {
        window.client.as_ref().is_some_and(fits).then_some(true)
    }
}

fn matches_frame(snapshot: &Snapshot, window: &Window, width: u32, height: u32) -> bool {
    streamed_area(snapshot, window, width, height).is_some()
}

fn shareable(window: &Window) -> bool {
    window.normal && window.pid != std::process::id()
}

fn unique_match(snapshot: &Snapshot, width: u32, height: u32) -> Option<&Window> {
    // Frames first: a client area counts only when no window's frame is the stream's size, so a
    // stream that matched one frame before still does.
    let unique = |client: bool| {
        let mut matches = snapshot
            .windows
            .iter()
            .filter(|w| shareable(w) && streamed_area(snapshot, w, width, height) == Some(client));
        let candidate = matches.next()?;
        Some((matches.next().is_none() && !candidate.minimized && !candidate.hidden).then_some(candidate))
    };
    unique(false).unwrap_or_else(|| unique(true).flatten())
}

fn resolve<'a>(snapshot: &'a Snapshot, binding: &Binding) -> Option<&'a Window> {
    snapshot.windows.iter().find(|w| w.id == binding.id && w.pid == binding.pid)
}

/// The window's frame (or with `client` its client area, what its stream shows) relative to its
/// output, which is where Kimochi's layer surfaces go (they are moved there, once, when they are
/// elsewhere). With several outputs, a window KWin cannot place on one has no bounds.
fn local(snapshot: &Snapshot, window: &Window, client: bool) -> Option<Rect> {
    let output = output_of(snapshot, window).or_else(|| (snapshot.outputs.len() == 1).then(|| &snapshot.outputs[0]))?;
    if snapshot.outputs.len() > 1 && overlay_output(snapshot).is_none_or(|o| o.name != output.name) {
        super::layer::follow_output(output.geometry);
    }
    let origin = output.geometry;
    let f = if client { window.client.unwrap_or(window.frame) } else { window.frame };
    [f.x, f.y, f.width, f.height].iter().all(|v| v.is_finite()).then_some(Rect {
        x: f.x - origin.x,
        y: f.y - origin.y,
        width: f.width,
        height: f.height,
    })
}

pub fn clear() {
    if let Ok(mut binding) = BINDING.lock() {
        *binding = None;
    }
}

/// The linked window's bounds (overlay-output local) and whether it can be drawn over now: shown,
/// on this desktop, on the overlay's output, and in front (Kimochi's own windows aside).
pub fn tracked(source: &str) -> Option<(Rect, bool)> {
    let binding = BINDING.lock().ok()?.clone()?;
    if binding.source != source {
        return None;
    }
    let Some(snapshot) = snapshot() else {
        return Some((binding.bounds, false));
    };
    let Some(window) = resolve(&snapshot, &binding) else {
        return Some((binding.bounds, false));
    };
    let rect = local(&snapshot, window, binding.client)?;
    let output = overlay_output(&snapshot);
    let foreground = snapshot
        .windows
        .iter()
        .find(|w| w.active)
        .is_none_or(|active| active.pid == window.pid || active.pid == std::process::id());
    let visible = foreground
        && !covered_by_own_window(&snapshot, window)
        && !window.minimized
        && !window.hidden
        && window.on_desktop
        && output.is_some_and(|o| window.output.as_ref() == Some(&o.name))
        && output.is_some_and(|o| {
            rect.x < o.geometry.width
                && rect.y < o.geometry.height
                && rect.x + rect.width > 0.
                && rect.y + rect.height > 0.
        });
    Some((rect, visible))
}

/// Whether the reader is using one of Kimochi's ordinary windows (the main window with Settings,
/// the dictionary) that is stacked above the game and over part of it. Kimochi in front counts as
/// the game in front, so the reader can use its windows beside the game; but one over the game must
/// not have the overlay's text drawn on top of it (as on X11, `state::source_focus` `covered`).
/// Never in Mini mode: its small window sits over the game on purpose.
fn covered_by_own_window(snapshot: &Snapshot, game: &Window) -> bool {
    if crate::compact::active() {
        return false;
    }
    let Some(game_stack) = game.stack.filter(|s| *s >= 0) else { return false };
    let overlaps =
        |a: &Rect, b: &Rect| a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    snapshot.windows.iter().any(|w| {
        w.pid == std::process::id()
            && w.active
            && w.normal
            // Normal or kept on top (KWin's NormalLayer 2, AboveLayer 3); the overlay and the
            // pop-ups are layer-shell surfaces far above.
            && w.layer.is_some_and(|layer| layer <= 3)
            && !w.minimized
            && !w.hidden
            && w.on_desktop
            && w.output == game.output
            && w.stack.is_some_and(|s| s > game_stack)
            && overlaps(&w.frame, &game.frame)
    })
}

pub fn linked(source: &str) -> bool {
    BINDING.lock().ok().and_then(|b| b.clone()).is_some_and(|b| b.source == source)
}

/// The process of the window `source` is linked to: what Text hooking hooks, since a portal
/// stream names no process of its own.
pub fn linked_pid(source: &str) -> Option<u32> {
    BINDING.lock().ok()?.as_ref().filter(|b| b.source == source).map(|b| b.pid)
}

pub fn frame_bounds(source: &str, width: u32, height: u32) -> Option<Rect> {
    if !source.starts_with("portal:window:") {
        return None;
    }
    let snapshot = snapshot()?;
    let mut binding = BINDING.lock().ok()?;
    if binding.as_ref().is_none_or(|b| b.source != source) {
        let window = unique_match(&snapshot, width, height)?;
        let client = streamed_area(&snapshot, window, width, height)?;
        *binding = Some(Binding {
            source: source.to_owned(),
            id: window.id.clone(),
            pid: window.pid,
            bounds: local(&snapshot, window, client)?,
            client,
        });
        eprintln!("KWin portal window linked: source={source} pid={} frame={width}x{height}", window.pid);
    }
    let window = resolve(&snapshot, binding.as_ref()?)?;
    if window.minimized || window.hidden {
        return None;
    }
    let client = streamed_area(&snapshot, window, width, height)?;
    local(&snapshot, window, client)
}

pub fn enrich(frame: &mut Frame) {
    if let Some(bounds) = frame_bounds(&frame.info.source_id, frame.info.full_width, frame.info.full_height) {
        frame.info.scale_factor = f64::from(frame.info.full_width) / bounds.width;
        frame.info.source_bounds = Some(bounds);
    }
}

/// Global pointer position, relative to the overlay's output; never button state. Asked for on
/// its own (snapshots are pushed on window changes, not pointer motion).
/// The cursor in KWin's global logical coordinates (the space of its outputs' geometry).
pub fn pointer_global() -> Option<(f64, f64)> {
    bridge()?;
    let cursor: Point = serde_json::from_value(ask("pointer", json!({}))?).ok()?;
    (cursor.x.is_finite() && cursor.y.is_finite()).then_some((cursor.x, cursor.y))
}

pub fn pointer() -> Option<Value> {
    let snapshot = snapshot()?;
    let origin = overlay_output(&snapshot)?.geometry;
    let cursor: Point = serde_json::from_value(ask("pointer", json!({}))?).ok()?;
    let (x, y) = (cursor.x - origin.x, cursor.y - origin.y);
    (x.is_finite() && y.is_finite()).then(|| json!({"x": x, "y": y}))
}

/// Kimochi's own ordinary windows (main window, Settings, Welcome…) where KWin has them, relative
/// to the overlay's output like every other bound here: a Wayland client is never told where its
/// own windows are. `None` when the bridge cannot answer.
pub fn own_frames() -> Option<Vec<Rect>> {
    let snapshot = snapshot()?;
    let origin = overlay_output(&snapshot)?.geometry;
    let own = std::process::id();
    Some(
        snapshot
            .windows
            .iter()
            .filter(|w| {
                w.pid == own && w.normal && !w.minimized && !w.hidden && w.on_desktop && w.layer.is_none_or(|l| l <= 2)
            })
            .map(|w| Rect { x: w.frame.x - origin.x, y: w.frame.y - origin.y, ..w.frame })
            .collect(),
    )
}

/// The linked window's title and application, for naming the anonymous portal source.
pub fn identity(source: &str) -> Option<Value> {
    let binding = BINDING.lock().ok()?.clone()?;
    if binding.source != source {
        return None;
    }
    let snapshot = snapshot()?;
    let window = resolve(&snapshot, &binding)?;
    let app_id = [window.desktop_file.trim(), window.class.trim()].into_iter().find(|s| !s.is_empty());
    let Some(app_id) = app_id else {
        return Some(json!({"title": window.title, "appName": null, "appId": null, "iconName": null}));
    };
    let (name, icon) = super::hyprland::desktop_entry(app_id)
        .or_else(|| super::hyprland::desktop_entry(window.class.trim()))
        .unwrap_or_else(|| (app_id.to_owned(), app_id.to_owned()));
    Some(json!({"title": window.title, "appName": name, "appId": app_id, "iconName": icon}))
}

/// Bring the linked window forward (restoring it and switching to its desktop when needed).
pub fn activate(source: &str) -> Result<(), String> {
    let binding = BINDING
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .filter(|b| b.source == source)
        .ok_or("The shared window isn't linked yet. Scan it once, or use Link window in the source menu.")?;
    match ask("activate", json!({"id": binding.id})) {
        Some(Value::Bool(true)) => Ok(()),
        Some(_) => Err("The shared window has closed.".into()),
        None => Err("KWin did not answer.".into()),
    }
}

pub fn status(source: &str) -> Value {
    let snapshot = snapshot();
    let binding = BINDING.lock().ok().and_then(|b| b.clone());
    let linked =
        binding.is_some_and(|b| b.source == source && snapshot.as_ref().is_some_and(|s| resolve(s, &b).is_some()));
    let tracked = tracked(source);
    json!({"available": snapshot.is_some(), "linked": linked,
        "bounds": tracked.map(|(bounds, _)| bounds), "visible": tracked.is_some_and(|(_, visible)| visible)})
}

fn explicit_match<'a>(snapshot: &'a Snapshot, id: &str, width: u32, height: u32) -> Option<&'a Window> {
    snapshot
        .windows
        .iter()
        .find(|w| w.id == id && shareable(w) && !w.minimized && !w.hidden && matches_frame(snapshot, w, width, height))
}

pub fn candidates(width: u32, height: u32) -> Result<Value, String> {
    let snapshot = snapshot().ok_or("KWin window geometry is unavailable")?;
    Ok(Value::Array(
        snapshot
            .windows
            .iter()
            .filter(|w| shareable(w) && !w.minimized && !w.hidden && matches_frame(&snapshot, w, width, height))
            .map(|w| json!({"address": w.id, "title": w.title, "app": if w.class.is_empty() { &w.desktop_file } else { &w.class }}))
            .collect(),
    ))
}

pub fn link(source: &str, id: &str, width: u32, height: u32) -> Result<(), String> {
    let snapshot = snapshot().ok_or("KWin window geometry is unavailable")?;
    let window = explicit_match(&snapshot, id, width, height)
        .ok_or("The chosen window no longer matches this shared frame. Try again.")?;
    let client = streamed_area(&snapshot, window, width, height) == Some(true);
    *BINDING.lock().map_err(|e| e.to_string())? = Some(Binding {
        source: source.to_owned(),
        id: window.id.clone(),
        pid: window.pid,
        bounds: local(&snapshot, window, client).ok_or("Invalid window bounds")?,
        client,
    });
    eprintln!("KWin portal window explicitly linked: source={source} pid={}", window.pid);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Snapshot {
        serde_json::from_value(json!({
            "windows": [
                {"id": "{a}", "pid": 42, "class": "game", "title": "Game", "frame": {"x": 100, "y": 40, "width": 960, "height": 576},
                 "output": "DP-1", "minimized": false, "hidden": false, "onDesktop": true, "normal": true, "active": true}
            ],
            "outputs": [{"name": "DP-1", "geometry": {"x": 0, "y": 0, "width": 1920, "height": 1080}, "scale": 1.5}]
        }))
        .unwrap()
    }
    #[test]
    fn a_frame_at_its_output_scale_matches_and_other_sizes_do_not() {
        let s = sample();
        assert!(unique_match(&s, 1440, 864).is_some());
        assert!(unique_match(&s, 1441, 864).is_some());
        assert!(unique_match(&s, 1444, 864).is_none());
        assert!(unique_match(&s, 1440, 810).is_none(), "the client area alone is not the stream");
    }
    /// KWin streams an XWayland window (a Proton game in a window) without its title bar.
    #[test]
    fn an_xwayland_stream_matches_the_client_area_and_bounds_follow_it() {
        let mut s = sample();
        s.windows[0].client = Some(Rect { x: 102., y: 70., width: 956., height: 544. });
        let window = unique_match(&s, 1434, 816).expect("the client area at scale 1.5");
        assert_eq!(streamed_area(&s, window, 1434, 816), Some(true));
        assert_eq!(local(&s, window, true).map(|r| (r.x, r.y, r.width)), Some((102., 70., 956.)));
        assert_eq!(streamed_area(&s, window, 1440, 864), Some(false));
        // Another window's frame of that size wins over this client area.
        let mut other = s.windows[0].clone();
        other.id = "{b}".into();
        other.client = None;
        other.frame = Rect { x: 0., y: 0., width: 956., height: 544. };
        s.windows.push(other);
        assert_eq!(unique_match(&s, 1434, 816).unwrap().id, "{b}");
    }
    #[test]
    fn equal_frames_are_ambiguous_even_when_one_is_minimized() {
        let mut s = sample();
        let mut other = s.windows[0].clone();
        other.id = "{b}".into();
        other.minimized = true;
        s.windows.push(other);
        assert!(unique_match(&s, 1440, 864).is_none());
        assert_eq!(explicit_match(&s, "{a}", 1440, 864).unwrap().id, "{a}");
        assert!(explicit_match(&s, "{b}", 1440, 864).is_none(), "a minimized window cannot be linked");
    }
    #[test]
    fn own_and_special_windows_never_match() {
        let mut s = sample();
        s.windows[0].pid = std::process::id();
        assert!(unique_match(&s, 1440, 864).is_none());
        s.windows[0].pid = 42;
        s.windows[0].normal = false;
        assert!(unique_match(&s, 1440, 864).is_none());
    }
    #[test]
    fn bounds_are_relative_to_the_windows_output() {
        let mut s = sample();
        s.outputs.push(Output {
            name: "HDMI-1".into(),
            geometry: Rect { x: 1920., y: 0., width: 2560., height: 1440. },
            scale: 1.,
        });
        let r = local(&s, &s.windows[0], false).unwrap();
        assert_eq!((r.x, r.y), (100., 40.));
        s.windows[0].output = Some("HDMI-1".into());
        s.windows[0].frame.x = 2020.;
        let r = local(&s, &s.windows[0], false).unwrap();
        assert_eq!((r.x, r.y, r.width), (100., 40., 960.));
        // Several outputs and none named: no origin to guess.
        s.windows[0].output = None;
        assert!(local(&s, &s.windows[0], false).is_none());
    }
    #[test]
    fn a_binding_follows_the_window_id_not_its_size() {
        let mut s = sample();
        let binding = Binding {
            source: "portal:window:7".into(),
            id: "{a}".into(),
            pid: 42,
            bounds: s.windows[0].frame,
            client: false,
        };
        s.windows[0].frame.x = -50.;
        assert_eq!(resolve(&s, &binding).unwrap().frame.x, -50.);
        s.windows[0].pid = 7;
        assert!(resolve(&s, &binding).is_none());
    }
    #[test]
    fn kimochis_own_window_over_the_game_hides_what_is_drawn_over_it() {
        let mut s = sample();
        s.windows[0].stack = Some(3);
        let mut own = s.windows[0].clone();
        own.id = "{kimochi}".into();
        own.pid = std::process::id();
        own.layer = Some(2);
        own.stack = Some(5);
        own.frame = Rect { x: 600., y: 0., width: 800., height: 800. };
        own.active = true;
        s.windows[0].active = false;
        s.windows.push(own);
        assert!(covered_by_own_window(&s, &s.windows[0]));
        // Kept on top over the game but not in use: the game is still what is being read.
        s.windows[1].active = false;
        assert!(!covered_by_own_window(&s, &s.windows[0]));
        s.windows[1].active = true;
        // Beside the game, or behind it: not covered.
        s.windows[1].frame.x = 1100.;
        assert!(!covered_by_own_window(&s, &s.windows[0]));
        s.windows[1].frame.x = 600.;
        s.windows[1].stack = Some(1);
        assert!(!covered_by_own_window(&s, &s.windows[0]));
        // The overlay (a layer-shell surface over everything) never counts.
        s.windows[1].stack = Some(5);
        s.windows[1].layer = Some(9);
        assert!(!covered_by_own_window(&s, &s.windows[0]));
        // A script without stacking order says nothing.
        s.windows[1].layer = Some(2);
        s.windows[0].stack = None;
        assert!(!covered_by_own_window(&s, &s.windows[0]));
    }

    #[test]
    fn the_script_names_the_bridge_service_once() {
        assert_eq!(SCRIPT.matches("%SERVICE%").count(), 1);
        assert!(SCRIPT.contains(PATH) && SCRIPT.contains("\"dev.kimochi.KWinBridge\""));
    }
}
