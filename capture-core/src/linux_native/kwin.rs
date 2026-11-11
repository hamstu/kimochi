//! The `kwin` driver (KDE Plasma 6). See the table in `mod.rs`.
//!
//! One Wayland connection, on its own thread, binds KWin's restricted globals:
//! `org_kde_plasma_window_management` (every window by uuid: title, app id, pid, geometry,
//! states, virtual desktops, stacking order) and `zkde_screencast_unstable_v1` (a PipeWire node
//! of one window or output), plus `wl_output`/`zxdg_output_manager_v1` for outputs and
//! `org_kde_plasma_virtual_desktop_management` for the current desktop. Events keep a [`Model`]
//! behind a mutex; [`Driver::inventory`] maps it (pure functions, tested below).
//!
//! **Authorization.** Up to Plasma 6.7, KWin offers both globals only to a client whose executable
//! is the `Exec` of an installed desktop file that lists them in `X-KDE-Wayland-Interfaces`: it
//! compares the first `Exec` word, canonicalized from KWin's working directory (`/`, so it must be
//! an absolute path), with the client's `/proc/<pid>/exe`. A desktop file that appears while KWin
//! runs counts at once (KWin's service cache notices new files). With
//! `KWIN_WAYLAND_NO_PERMISSION_CHECKS=1` every client gets them. From 6.8 every client that is
//! not sandboxed (Flatpak, Snap, a security context) gets them, no desktop file needed.
//!
//! **Geometry.** A window's stream is its frame geometry times the output scale, for Wayland and
//! XWayland windows alike (`WindowScreenCastSource::boundingRect` is `frameGeometry()`: the
//! server-side title bar and borders included, the shadow not). The plasma window `geometry` event
//! is that frame, so it is `bounds`, and frame pixels over bounds is the scale. (Checked on KWin
//! 6.7: a GTK window with server-side decoration streams 960x576 for a 960x540 client area, and
//! as an XWayland window 800x536 for 800x500. `client_geometry` would not match either.)
use super::{pipewire_feed, Driver, Feed, Inventory, NativeOutput, NativeWindow, Target};
use crate::{CaptureError, Rect, Result};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{wl_output, wl_registry};
use wayland_client::{Connection, Dispatch, EventQueue, Proxy, QueueHandle, WEnum};
use wayland_protocols::xdg::xdg_output::zv1::client::{zxdg_output_manager_v1, zxdg_output_v1};
use wayland_protocols_plasma::plasma_virtual_desktop::client::{
    org_kde_plasma_virtual_desktop as vdesk, org_kde_plasma_virtual_desktop_management as vdesk_mgmt,
};
use wayland_protocols_plasma::plasma_window_management::client::{
    org_kde_plasma_stacking_order as stacking, org_kde_plasma_window as pwin,
    org_kde_plasma_window_management as pwm,
};
use wayland_protocols_plasma::primary_output::v1::client::kde_primary_output_v1 as primary;
use wayland_protocols_plasma::screencast::v1::client::{
    zkde_screencast_stream_unstable_v1 as stream, zkde_screencast_unstable_v1 as screencast,
};

/// How long `open` waits for KWin to create a stream's PipeWire node.
const CREATE_WAIT: Duration = Duration::from_secs(3);
/// How long the initial inventory may take.
const CONNECT_WAIT: Duration = Duration::from_secs(5);
/// `zkde_screencast_unstable_v1.pointer.hidden`.
const POINTER_HIDDEN: u32 = 1;

// org_kde_plasma_window_management.state
const ACTIVE: u32 = 0x1;
const MINIMIZED: u32 = 0x2;
const ON_ALL_DESKTOPS: u32 = 0x40;
const SKIP_TASKBAR: u32 = 0x1000;
const SKIP_SWITCHER: u32 = 0x40000;

const AUTH_HINT: &str = "Before Plasma 6.8 KWin offers these only to an executable whose installed \
     .desktop file (Exec= its absolute path) lists them in X-KDE-Wayland-Interfaces=\
     zkde_screencast_unstable_v1,org_kde_plasma_window_management, or to every client when KWin \
     runs with KWIN_WAYLAND_NO_PERMISSION_CHECKS=1; from 6.8 to every app that is not sandboxed \
     (Flatpak, Snap)";

// ---------------------------------------------------------------------------------------------
// The model: what KWin has told us. Pure data, mapped to an Inventory by pure functions.

/// One plasma window as its events describe it.
#[derive(Clone, Debug, Default, PartialEq)]
struct Win {
    uuid: String,
    title: String,
    app_id: String,
    pid: Option<u32>,
    /// `geometry`: the frame, server-side decoration included.
    frame: Option<Rect>,
    flags: u32,
    /// Virtual desktop ids the window is on (empty: all, or KWin has not said).
    desktops: Vec<String>,
    has_parent: bool,
    /// `initial_state` has arrived.
    ready: bool,
}

/// One output as its events describe it.
#[derive(Clone, Debug, Default, PartialEq)]
struct Out {
    /// `wl_output.name` (v4) or `zxdg_output_v1.name`: the connector.
    connector: String,
    make: String,
    model: String,
    /// The current mode, physical pixels, before the transform.
    mode: (i32, i32),
    /// The transform turns the output by 90° or 270°.
    rotated: bool,
    /// `wl_output.scale` (an integer; fractional scales show only as logical vs physical size).
    int_scale: i32,
    logical_pos: Option<(i32, i32)>,
    logical_size: Option<(i32, i32)>,
}

#[derive(Default)]
struct Model {
    windows: HashMap<String, Win>,
    /// Window uuids bottom to top, as KWin last sent them.
    stacking: Vec<String>,
    /// The current virtual desktop(s).
    current_desktops: HashSet<String>,
    /// Virtual desktops are known (the management global is bound and has said `done`).
    desktops_known: bool,
    outputs: HashMap<u32, Out>,
    primary: Option<String>,
    /// The connection is gone.
    dead: bool,
}

/// What KWin's window stream shows, in global logical coordinates: the frame.
fn stream_bounds(w: &Win) -> Option<Rect> {
    w.frame.filter(|r| r.width > 0.0 && r.height > 0.0)
}

fn on_screen(w: &Win, current: &HashSet<String>, desktops_known: bool) -> bool {
    if w.flags & MINIMIZED != 0 {
        return false;
    }
    if !desktops_known || w.flags & ON_ALL_DESKTOPS != 0 || w.desktops.is_empty() {
        return true;
    }
    w.desktops.iter().any(|d| current.contains(d))
}

/// A panel, notification, dock, dialog or similar: not a capture source of its own.
fn auxiliary(w: &Win) -> bool {
    w.flags & (SKIP_TASKBAR | SKIP_SWITCHER) != 0 || w.has_parent
}

fn overlap(a: &Rect, b: &Rect) -> f64 {
    let w = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let h = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    if w > 0.0 && h > 0.0 {
        w * h
    } else {
        0.0
    }
}

/// The output a rectangle is mostly on.
fn output_for(rect: &Rect, outputs: &[NativeOutput]) -> Option<String> {
    outputs
        .iter()
        .map(|o| (overlap(rect, &o.bounds), o))
        .filter(|(area, _)| *area > 0.0)
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, o)| o.handle.clone())
}

fn native_output(o: &Out, primary: Option<&str>) -> Option<NativeOutput> {
    if o.connector.is_empty() {
        return None;
    }
    let (pw, ph) = if o.rotated { (o.mode.1, o.mode.0) } else { o.mode };
    let int_scale = o.int_scale.max(1);
    let (lx, ly) = o.logical_pos.unwrap_or((0, 0));
    let (lw, lh) = o.logical_size.unwrap_or((pw / int_scale, ph / int_scale));
    if lw <= 0 || lh <= 0 {
        return None;
    }
    let scale = if pw > 0 { f64::from(pw) / f64::from(lw) } else { f64::from(int_scale) };
    let name = match (o.make.trim(), o.model.trim()) {
        ("", "") => o.connector.clone(),
        (make, "") => make.to_string(),
        ("", model) => model.to_string(),
        (make, model) => format!("{make} {model}"),
    };
    Some(NativeOutput {
        handle: o.connector.clone(),
        name,
        bounds: Rect { x: f64::from(lx), y: f64::from(ly), width: f64::from(lw), height: f64::from(lh) },
        scale,
        primary: primary == Some(o.connector.as_str()),
    })
}

fn inventory_of(model: &Model) -> Inventory {
    let mut outputs: Vec<NativeOutput> =
        model.outputs.values().filter_map(|o| native_output(o, model.primary.as_deref())).collect();
    outputs.sort_by(|a, b| (a.bounds.x, a.bounds.y).partial_cmp(&(b.bounds.x, b.bounds.y)).unwrap());
    if model.primary.is_none() {
        if let Some(first) = outputs.first_mut() {
            first.primary = true;
        }
    }
    // Front to back: the stacking order reversed, then anything it does not list yet.
    let rank: HashMap<&str, usize> =
        model.stacking.iter().rev().enumerate().map(|(i, u)| (u.as_str(), i)).collect();
    let mut windows: Vec<&Win> = model.windows.values().filter(|w| w.ready).collect();
    windows.sort_by_key(|w| (rank.get(w.uuid.as_str()).copied().unwrap_or(usize::MAX), w.uuid.clone()));
    let windows = windows
        .into_iter()
        .map(|w| {
            let bounds = stream_bounds(w);
            NativeWindow {
                handle: w.uuid.clone(),
                title: w.title.clone(),
                app_id: (!w.app_id.is_empty()).then(|| w.app_id.clone()),
                app_name: None,
                pid: w.pid,
                output: bounds.as_ref().and_then(|b| output_for(b, &outputs)),
                bounds,
                minimized: w.flags & MINIMIZED != 0,
                on_screen: Some(on_screen(w, &model.current_desktops, model.desktops_known)),
                focused: w.flags & ACTIVE != 0,
                auxiliary: auxiliary(w),
            }
        })
        .collect();
    Inventory { windows, outputs }
}

// ---------------------------------------------------------------------------------------------
// The connection thread.

type Shared = Arc<Mutex<Model>>;
type Proxies<T> = Arc<Mutex<HashMap<String, T>>>;

struct State {
    model: Shared,
    pwm: Option<pwm::OrgKdePlasmaWindowManagement>,
    _vdesk_mgmt: Option<vdesk_mgmt::OrgKdePlasmaVirtualDesktopManagement>,
    xdg_outputs: Option<zxdg_output_manager_v1::ZxdgOutputManagerV1>,
    /// Plasma window proxies by uuid, and output proxies by connector (shared with the driver).
    windows: Proxies<pwin::OrgKdePlasmaWindow>,
    outputs: Proxies<wl_output::WlOutput>,
    /// Virtual desktop proxies by id.
    desktops: HashMap<String, vdesk::OrgKdePlasmaVirtualDesktop>,
    /// The stacking order being received (v17's `org_kde_plasma_stacking_order`).
    stacking: Vec<String>,
}

impl State {
    fn bind_output(&mut self, registry: &wl_registry::WlRegistry, name: u32, version: u32, qh: &QueueHandle<Self>) {
        let output: wl_output::WlOutput = registry.bind(name, version.min(4), qh, name);
        if let Some(manager) = &self.xdg_outputs {
            manager.get_xdg_output(&output, qh, (name, output.clone()));
        }
        self.model.lock().unwrap().outputs.insert(name, Out::default());
    }
    fn request_stacking(&mut self, qh: &QueueHandle<Self>) {
        if let Some(pwm) = &self.pwm {
            if pwm.version() >= 17 {
                self.stacking.clear();
                pwm.get_stacking_order(qh, ());
            }
        }
    }
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            wl_registry::Event::Global { name, interface, version } if interface == "wl_output" => {
                state.bind_output(registry, name, version, qh);
            }
            wl_registry::Event::GlobalRemove { name } => {
                if let Some(out) = state.model.lock().unwrap().outputs.remove(&name) {
                    state.outputs.lock().unwrap().remove(&out.connector);
                }
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_output::WlOutput, u32> for State {
    fn event(state: &mut Self, proxy: &wl_output::WlOutput, event: wl_output::Event, name: &u32, _: &Connection, _: &QueueHandle<Self>) {
        let mut model = state.model.lock().unwrap();
        let Some(out) = model.outputs.get_mut(name) else { return };
        match event {
            wl_output::Event::Geometry { make, model, transform, .. } => {
                out.make = make;
                out.model = model;
                out.rotated = matches!(
                    transform,
                    WEnum::Value(
                        wl_output::Transform::_90
                            | wl_output::Transform::_270
                            | wl_output::Transform::Flipped90
                            | wl_output::Transform::Flipped270
                    )
                );
            }
            wl_output::Event::Mode { flags: WEnum::Value(flags), width, height, .. }
                if flags.contains(wl_output::Mode::Current) =>
            {
                out.mode = (width, height);
            }
            wl_output::Event::Scale { factor } => out.int_scale = factor,
            wl_output::Event::Name { name } => {
                out.connector = name.clone();
                state.outputs.lock().unwrap().insert(name, proxy.clone());
            }
            _ => {}
        }
    }
}

impl Dispatch<zxdg_output_manager_v1::ZxdgOutputManagerV1, ()> for State {
    fn event(_: &mut Self, _: &zxdg_output_manager_v1::ZxdgOutputManagerV1, _: zxdg_output_manager_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
}

/// User data of an xdg output: its wl_output's global name and proxy.
type XdgOf = (u32, wl_output::WlOutput);

impl Dispatch<zxdg_output_v1::ZxdgOutputV1, XdgOf> for State {
    fn event(state: &mut Self, _: &zxdg_output_v1::ZxdgOutputV1, event: zxdg_output_v1::Event, (name, output): &XdgOf, _: &Connection, _: &QueueHandle<Self>) {
        let mut model = state.model.lock().unwrap();
        let Some(out) = model.outputs.get_mut(name) else { return };
        match event {
            zxdg_output_v1::Event::LogicalPosition { x, y } => out.logical_pos = Some((x, y)),
            zxdg_output_v1::Event::LogicalSize { width, height } => out.logical_size = Some((width, height)),
            zxdg_output_v1::Event::Name { name } if out.connector.is_empty() => {
                out.connector = name.clone();
                state.outputs.lock().unwrap().insert(name, output.clone());
            }
            _ => {}
        }
    }
}

impl Dispatch<primary::KdePrimaryOutputV1, ()> for State {
    fn event(state: &mut Self, _: &primary::KdePrimaryOutputV1, event: primary::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        if let primary::Event::PrimaryOutput { output_name } = event {
            state.model.lock().unwrap().primary = Some(output_name);
        }
    }
}

impl Dispatch<pwm::OrgKdePlasmaWindowManagement, ()> for State {
    fn event(state: &mut Self, pwm: &pwm::OrgKdePlasmaWindowManagement, event: pwm::Event, _: &(), _: &Connection, qh: &QueueHandle<Self>) {
        match event {
            pwm::Event::WindowWithUuid { uuid, .. } => {
                if let std::collections::hash_map::Entry::Vacant(slot) =
                    state.windows.lock().unwrap().entry(uuid.clone())
                {
                    slot.insert(pwm.get_window_by_uuid(uuid.clone(), qh, uuid.clone()));
                    state.model.lock().unwrap().windows.insert(uuid.clone(), Win { uuid, ..Win::default() });
                }
            }
            pwm::Event::StackingOrderUuidChanged { uuids } => {
                state.model.lock().unwrap().stacking =
                    uuids.split(';').filter(|s| !s.is_empty()).map(String::from).collect();
            }
            pwm::Event::StackingOrderChanged2 => state.request_stacking(qh),
            _ => {}
        }
    }
}

impl Dispatch<stacking::OrgKdePlasmaStackingOrder, ()> for State {
    fn event(state: &mut Self, _: &stacking::OrgKdePlasmaStackingOrder, event: stacking::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        match event {
            stacking::Event::Window { uuid } => state.stacking.push(uuid),
            stacking::Event::Done => {
                state.model.lock().unwrap().stacking = std::mem::take(&mut state.stacking);
            }
            _ => {}
        }
    }
}

fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
    Rect { x: f64::from(x), y: f64::from(y), width: f64::from(width), height: f64::from(height) }
}

impl Dispatch<pwin::OrgKdePlasmaWindow, String> for State {
    fn event(state: &mut Self, proxy: &pwin::OrgKdePlasmaWindow, event: pwin::Event, uuid: &String, _: &Connection, _: &QueueHandle<Self>) {
        let mut model = state.model.lock().unwrap();
        if let pwin::Event::Unmapped = event {
            model.windows.remove(uuid);
            drop(model);
            if state.windows.lock().unwrap().remove(uuid).is_some() && proxy.version() >= 4 {
                proxy.destroy();
            }
            return;
        }
        let Some(w) = model.windows.get_mut(uuid) else { return };
        match event {
            pwin::Event::TitleChanged { title } => w.title = title,
            pwin::Event::AppIdChanged { app_id } => w.app_id = app_id,
            pwin::Event::PidChanged { pid } => w.pid = (pid > 0).then_some(pid),
            pwin::Event::StateChanged { flags } => w.flags = flags,
            pwin::Event::Geometry { x, y, width, height } => w.frame = Some(rect(x, y, width, height)),
            pwin::Event::ParentWindow { parent } => w.has_parent = parent.is_some(),
            pwin::Event::VirtualDesktopEntered { id } => {
                if !w.desktops.contains(&id) {
                    w.desktops.push(id);
                }
            }
            pwin::Event::VirtualDesktopLeft { is } => w.desktops.retain(|d| *d != is),
            pwin::Event::InitialState => w.ready = true,
            _ => {}
        }
    }
}

impl Dispatch<vdesk_mgmt::OrgKdePlasmaVirtualDesktopManagement, ()> for State {
    fn event(state: &mut Self, mgmt: &vdesk_mgmt::OrgKdePlasmaVirtualDesktopManagement, event: vdesk_mgmt::Event, _: &(), _: &Connection, qh: &QueueHandle<Self>) {
        match event {
            vdesk_mgmt::Event::DesktopCreated { desktop_id, .. } => {
                if let std::collections::hash_map::Entry::Vacant(slot) = state.desktops.entry(desktop_id.clone()) {
                    slot.insert(mgmt.get_virtual_desktop(desktop_id.clone(), qh, desktop_id));
                }
            }
            vdesk_mgmt::Event::DesktopRemoved { desktop_id } => {
                state.desktops.remove(&desktop_id);
                state.model.lock().unwrap().current_desktops.remove(&desktop_id);
            }
            vdesk_mgmt::Event::Done => state.model.lock().unwrap().desktops_known = true,
            _ => {}
        }
    }
}

impl Dispatch<vdesk::OrgKdePlasmaVirtualDesktop, String> for State {
    fn event(state: &mut Self, _: &vdesk::OrgKdePlasmaVirtualDesktop, event: vdesk::Event, id: &String, _: &Connection, _: &QueueHandle<Self>) {
        let mut model = state.model.lock().unwrap();
        match event {
            vdesk::Event::Activated => {
                model.current_desktops.insert(id.clone());
            }
            vdesk::Event::Deactivated | vdesk::Event::Removed => {
                model.current_desktops.remove(id);
            }
            _ => {}
        }
    }
}

impl Dispatch<screencast::ZkdeScreencastUnstableV1, ()> for State {
    fn event(_: &mut Self, _: &screencast::ZkdeScreencastUnstableV1, _: screencast::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
}

/// One stream's answer from KWin.
#[derive(Default)]
struct StreamState {
    created: Mutex<Option<std::result::Result<u32, String>>>,
    cond: Condvar,
    closed: AtomicBool,
}

impl Dispatch<stream::ZkdeScreencastStreamUnstableV1, Arc<StreamState>> for State {
    fn event(_: &mut Self, _: &stream::ZkdeScreencastStreamUnstableV1, event: stream::Event, s: &Arc<StreamState>, _: &Connection, _: &QueueHandle<Self>) {
        let answer = match event {
            stream::Event::Created { node } => Ok(node),
            stream::Event::Failed { error } => Err(error),
            stream::Event::Closed => {
                s.closed.store(true, Ordering::SeqCst);
                Err("KWin closed the stream".into())
            }
            _ => return,
        };
        let mut created = s.created.lock().unwrap();
        if created.is_none() {
            *created = Some(answer);
        }
        s.cond.notify_all();
    }
}

/// Closes the KWin stream when the feed ends.
struct StreamGuard {
    stream: stream::ZkdeScreencastStreamUnstableV1,
    conn: Connection,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.stream.close();
        let _ = self.conn.flush();
    }
}

pub struct Kwin {
    conn: Connection,
    qh: QueueHandle<State>,
    model: Shared,
    screencast: screencast::ZkdeScreencastUnstableV1,
    /// Proxies the requests need, kept current by the thread.
    outputs: Proxies<wl_output::WlOutput>,
    windows: Proxies<pwin::OrgKdePlasmaWindow>,
}

/// Everything `probe` learns before the thread takes over the queue.
struct Setup {
    conn: Connection,
    qh: QueueHandle<State>,
    screencast: screencast::ZkdeScreencastUnstableV1,
}

/// When the app last (re)wrote a desktop file authorizing its executable for KWin's restricted
/// interfaces (KWin ≤ 6.7 matches a client's executable to an installed desktop file). KWin reads
/// new desktop files only when its cache is older than about 1.5 s, so a probe right after the
/// write is refused once and then tried again.
static AUTHORIZED_AT: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
const AUTHORIZATION_SETTLE: Duration = Duration::from_millis(1800);

/// Say that an authorizing desktop file was just written (see [`AUTHORIZED_AT`]).
pub fn note_authorization_written() {
    *AUTHORIZED_AT.lock().unwrap() = Some(std::time::Instant::now());
}

pub fn probe() -> std::result::Result<Box<dyn Driver>, String> {
    match probe_once() {
        Err(e) if e.contains("does not offer") => {
            let Some(written) = *AUTHORIZED_AT.lock().unwrap() else { return Err(e) };
            if written.elapsed() > Duration::from_secs(30) {
                return Err(e);
            }
            if let Some(wait) = AUTHORIZATION_SETTLE.checked_sub(written.elapsed()) {
                std::thread::sleep(wait);
            }
            probe_once()
        }
        other => other,
    }
}

fn probe_once() -> std::result::Result<Box<dyn Driver>, String> {
    let model: Shared = Arc::default();
    let outputs: Proxies<wl_output::WlOutput> = Arc::default();
    let windows: Proxies<pwin::OrgKdePlasmaWindow> = Arc::default();
    let (tx, rx) = std::sync::mpsc::channel::<std::result::Result<Setup, String>>();
    {
        let (model, outputs, windows) = (model.clone(), outputs.clone(), windows.clone());
        std::thread::Builder::new()
            .name("kimochi-kwin".into())
            .spawn(move || {
                let (mut queue, mut state, setup) = match connect(model.clone(), outputs, windows) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = tx.send(Err(e));
                        return;
                    }
                };
                let _ = tx.send(Ok(setup));
                while queue.blocking_dispatch(&mut state).is_ok() {}
                model.lock().unwrap().dead = true;
            })
            .map_err(|e| e.to_string())?;
    }
    let setup = rx
        .recv_timeout(CONNECT_WAIT)
        .map_err(|_| "KWin did not answer in time".to_string())??;
    Ok(Box::new(Kwin { conn: setup.conn, qh: setup.qh, model, screencast: setup.screencast, outputs, windows }))
}

fn connect(
    model: Shared,
    outputs: Proxies<wl_output::WlOutput>,
    windows: Proxies<pwin::OrgKdePlasmaWindow>,
) -> std::result::Result<(EventQueue<State>, State, Setup), String> {
    let conn = Connection::connect_to_env().map_err(|e| format!("no Wayland compositor: {e}"))?;
    let (globals, mut queue) =
        registry_queue_init::<State>(&conn).map_err(|e| format!("Wayland registry: {e}"))?;
    let qh = queue.handle();
    let has = |name: &str| globals.contents().with_list(|l| l.iter().any(|g| g.interface == name));
    let missing: Vec<&str> = ["zkde_screencast_unstable_v1", "org_kde_plasma_window_management"]
        .into_iter()
        .filter(|i| !has(i))
        .collect();
    if !missing.is_empty() {
        let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
        return Err(format!(
            "KWin does not offer {} to this process ({exe}). {AUTH_HINT}",
            missing.join(" or ")
        ));
    }
    let screencast: screencast::ZkdeScreencastUnstableV1 =
        globals.bind(&qh, 1..=4, ()).map_err(|e| format!("zkde_screencast_unstable_v1: {e}"))?;
    let pwm: pwm::OrgKdePlasmaWindowManagement =
        globals.bind(&qh, 1..=18, ()).map_err(|e| format!("org_kde_plasma_window_management: {e}"))?;
    if pwm.version() < 13 {
        return Err(format!("org_kde_plasma_window_management version {} is too old (13+: Plasma 5.20)", pwm.version()));
    }
    let mut state = State {
        model,
        pwm: Some(pwm),
        _vdesk_mgmt: globals.bind(&qh, 1..=2, ()).ok(),
        xdg_outputs: globals.bind(&qh, 1..=3, ()).ok(),
        windows,
        outputs,
        desktops: HashMap::new(),
        stacking: Vec::new(),
    };
    let _primary: Option<primary::KdePrimaryOutputV1> = globals.bind(&qh, 1..=2, ()).ok();
    let registry = globals.registry().clone();
    let outputs: Vec<(u32, u32)> = globals.contents().with_list(|l| {
        l.iter().filter(|g| g.interface == "wl_output").map(|g| (g.name, g.version)).collect()
    });
    for (name, version) in outputs {
        state.bind_output(&registry, name, version, &qh);
    }
    state.request_stacking(&qh);
    // Globals' first events, then the windows' and desktops' (their objects were made by the first).
    for _ in 0..3 {
        queue.roundtrip(&mut state).map_err(|e| format!("KWin: {e}"))?;
    }
    Ok((queue, state, Setup { conn, qh, screencast }))
}

impl Kwin {
    /// Ask KWin for a stream, wait for its PipeWire node and consume it. `window`: the uuid
    /// streamed, so a failure for a window that has just closed says so.
    fn start(
        &self,
        window: Option<&str>,
        make: impl FnOnce(&Arc<StreamState>) -> stream::ZkdeScreencastStreamUnstableV1,
    ) -> Result<Feed> {
        let s = Arc::new(StreamState::default());
        let proxy = make(&s);
        let guard = StreamGuard { stream: proxy, conn: self.conn.clone() };
        self.conn.flush().map_err(|e| CaptureError::new("native", format!("KWin: {e}")))?;
        let deadline = Instant::now() + CREATE_WAIT;
        let mut created = s.created.lock().unwrap();
        while created.is_none() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(CaptureError::new("native", "KWin did not start the stream in time"));
            }
            created = s.cond.wait_timeout(created, left).unwrap().0;
        }
        let node = match created.take().unwrap() {
            Ok(node) => node,
            // KWin sends `unmapped` before it fails a request for that window.
            Err(_) if window.is_some_and(|uuid| !self.model.lock().unwrap().windows.contains_key(uuid)) => {
                return Err(CaptureError::new("stale_source", "That window has closed"));
            }
            Err(e) => return Err(CaptureError::new("native", format!("KWin could not stream it: {e}"))),
        };
        drop(created);
        let feed = pipewire_feed(node, Box::new(guard))?;
        let slot = feed.slot.clone();
        let feed = Arc::new(Mutex::new(feed));
        let (inner, closed, model) = (feed.clone(), s.clone(), self.model.clone());
        let gone = move || {
            closed.closed.load(Ordering::SeqCst) || model.lock().unwrap().dead || !inner.lock().unwrap().alive()
        };
        Ok(Feed::new(slot, gone, Box::new(feed)))
    }
}

impl Driver for Kwin {
    fn name(&self) -> &'static str {
        "kwin"
    }

    fn inventory(&self) -> Result<Inventory> {
        let model = self.model.lock().unwrap();
        if model.dead {
            return Err(CaptureError::new("native", "Lost the connection to KWin"));
        }
        Ok(inventory_of(&model))
    }

    fn open(&self, target: Target<'_>) -> Result<Feed> {
        match target {
            Target::Window(w) => self.start(Some(&w.handle), |s| {
                self.screencast.stream_window(w.handle.clone(), POINTER_HIDDEN, &self.qh, s.clone())
            }),
            Target::Output(o) => {
                let output = self
                    .outputs
                    .lock()
                    .unwrap()
                    .get(&o.handle)
                    .cloned()
                    .ok_or_else(|| CaptureError::new("stale_source", "That display is gone"))?;
                self.start(None, |s| self.screencast.stream_output(&output, POINTER_HIDDEN, &self.qh, s.clone()))
            }
        }
    }

    fn activate(&self, window: &NativeWindow) -> Result<()> {
        let proxy = self
            .windows
            .lock()
            .unwrap()
            .get(&window.handle)
            .cloned()
            .ok_or_else(|| CaptureError::new("stale_source", "That window has closed"))?;
        proxy.set_state(ACTIVE | MINIMIZED, ACTIVE);
        self.conn.flush().map_err(|e| CaptureError::new("native", format!("KWin: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, width: w, height: h }
    }

    fn win(uuid: &str) -> Win {
        Win {
            uuid: uuid.into(),
            title: "Game".into(),
            app_id: "org.example.game".into(),
            pid: Some(42),
            frame: Some(r(100., 40., 960., 574.)),
            ready: true,
            ..Win::default()
        }
    }

    #[test]
    fn a_window_streams_its_frame() {
        assert_eq!(stream_bounds(&win("{a}")), Some(r(100., 40., 960., 574.)));
        let empty = Win { frame: Some(r(0., 0., 0., 0.)), ..win("{c}") };
        assert_eq!(stream_bounds(&empty), None);
        assert_eq!(stream_bounds(&Win { frame: None, ..win("{d}") }), None);
    }

    #[test]
    fn states_map_to_on_screen_and_auxiliary() {
        let current: HashSet<String> = ["d1".to_string()].into();
        let mut w = win("{a}");
        w.desktops = vec!["d2".into()];
        assert!(!on_screen(&w, &current, true), "on another desktop");
        assert!(on_screen(&w, &current, false), "desktops unknown: assume visible");
        w.flags = ON_ALL_DESKTOPS;
        assert!(on_screen(&w, &current, true));
        w.flags |= MINIMIZED;
        assert!(!on_screen(&w, &current, true));
        w.flags = 0;
        w.desktops = vec!["d2".into(), "d1".into()];
        assert!(on_screen(&w, &current, true));
        assert!(!auxiliary(&w));
        assert!(auxiliary(&Win { flags: SKIP_TASKBAR, ..win("{p}") }), "panels skip the taskbar");
        assert!(auxiliary(&Win { flags: SKIP_SWITCHER, ..win("{n}") }));
        assert!(auxiliary(&Win { has_parent: true, ..win("{d}") }), "a dialog");
    }

    fn out(connector: &str, pos: (i32, i32), logical: (i32, i32), mode: (i32, i32)) -> Out {
        Out {
            connector: connector.into(),
            make: "Dell".into(),
            model: "U2720Q".into(),
            mode,
            int_scale: 2,
            logical_pos: Some(pos),
            logical_size: Some(logical),
            ..Out::default()
        }
    }

    #[test]
    fn outputs_have_logical_bounds_and_fractional_scale() {
        let o = native_output(&out("DP-1", (1920, 0), (2560, 1440), (3840, 2160)), Some("DP-1")).unwrap();
        assert_eq!(o.bounds, r(1920., 0., 2560., 1440.));
        assert_eq!(o.scale, 1.5);
        assert_eq!(o.name, "Dell U2720Q");
        assert!(o.primary);
        let mut turned = out("HDMI-A-1", (0, 0), (1080, 1920), (1920, 1080));
        turned.rotated = true;
        turned.make.clear();
        turned.model.clear();
        let t = native_output(&turned, None).unwrap();
        assert_eq!((t.scale, t.name.as_str(), t.primary), (1.0, "HDMI-A-1", false));
        // No xdg_output: the mode over the integer scale.
        let plain = Out { logical_pos: None, logical_size: None, ..out("eDP-1", (0, 0), (0, 0), (2880, 1800)) };
        let p = native_output(&plain, None).unwrap();
        assert_eq!((p.bounds, p.scale), (r(0., 0., 1440., 900.), 2.0));
        assert!(native_output(&Out::default(), None).is_none(), "no connector name yet");
    }

    #[test]
    fn inventory_is_front_to_back_with_outputs() {
        let mut model = Model::default();
        model.outputs.insert(1, out("DP-1", (0, 0), (1920, 1080), (1920, 1080)));
        model.outputs.insert(2, out("DP-2", (1920, 0), (1920, 1080), (1920, 1080)));
        let mut right = win("{right}");
        right.frame = Some(r(1800., 100., 800., 600.));
        right.flags = ACTIVE;
        let mut pending = win("{pending}");
        pending.ready = false;
        for w in [win("{left}"), right, pending, win("{new}")] {
            model.windows.insert(w.uuid.clone(), w);
        }
        model.stacking = vec!["{left}".into(), "{right}".into()];
        let inv = inventory_of(&model);
        let handles: Vec<_> = inv.windows.iter().map(|w| w.handle.as_str()).collect();
        assert_eq!(handles, ["{right}", "{left}", "{new}"], "front first; unlisted last; not-ready hidden");
        assert_eq!(inv.windows[0].output.as_deref(), Some("DP-2"), "mostly on the right output");
        assert!(inv.windows[0].focused);
        assert_eq!(inv.windows[1].output.as_deref(), Some("DP-1"));
        assert_eq!(inv.outputs.iter().map(|o| o.handle.as_str()).collect::<Vec<_>>(), ["DP-1", "DP-2"]);
        assert!(inv.outputs[0].primary && !inv.outputs[1].primary, "the leftmost when KWin names none");
    }
}
