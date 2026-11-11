//! The ext driver's inventory connection: one thread keeping the compositor's toplevel list
//! (`ext_foreign_toplevel_list_v1`), its outputs (`wl_output` + `zxdg_output_manager_v1`), and,
//! where offered, Hyprland's toplevel → window address mapping and the wlr foreign-toplevel
//! list (state and activation where no IPC says more).
//!
//! The thread publishes a [`Snap`] after every batch of events. [`Lister::snapshot`] first sends a
//! `wl_display.sync` through the thread's queue and waits for it, so a snapshot includes every
//! event the compositor sent before the call (a window that just opened is in it).
use super::protocols::hyprland_toplevel_mapping::{
    hyprland_toplevel_mapping_manager_v1::HyprlandToplevelMappingManagerV1,
    hyprland_toplevel_window_mapping_handle_v1::{self, HyprlandToplevelWindowMappingHandleV1},
};
use crate::linux_native::NativeOutput;
use crate::Rect;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{wl_callback, wl_output, wl_registry, wl_seat};
use wayland_client::{delegate_noop, event_created_child, Connection, Dispatch, Proxy, QueueHandle, WEnum};
use wayland_protocols::ext::foreign_toplevel_list::v1::client::{
    ext_foreign_toplevel_handle_v1::{self, ExtForeignToplevelHandleV1},
    ext_foreign_toplevel_list_v1::{self, ExtForeignToplevelListV1},
};
use wayland_protocols::xdg::xdg_output::zv1::client::{
    zxdg_output_manager_v1::ZxdgOutputManagerV1,
    zxdg_output_v1::{self, ZxdgOutputV1},
};
use wayland_protocols_wlr::foreign_toplevel::v1::client::{
    zwlr_foreign_toplevel_handle_v1::{self, ZwlrForeignToplevelHandleV1},
    zwlr_foreign_toplevel_manager_v1::{self, ZwlrForeignToplevelManagerV1},
};

/// How long a snapshot waits for the compositor to answer its sync.
const SYNC_WAIT: Duration = Duration::from_millis(250);

pub const TOPLEVEL_LIST: &str = "ext_foreign_toplevel_list_v1";
pub const COPY_CAPTURE: &str = "ext_image_copy_capture_manager_v1";
pub const TOPLEVEL_SOURCE: &str = "ext_foreign_toplevel_image_capture_source_manager_v1";
pub const OUTPUT_SOURCE: &str = "ext_output_image_capture_source_manager_v1";
pub const HYPRLAND_MAPPING: &str = "hyprland_toplevel_mapping_manager_v1";
const WLR_TOPLEVELS: &str = "zwlr_foreign_toplevel_manager_v1";

/// One ext toplevel.
#[derive(Clone, Debug)]
pub struct TopInfo {
    pub identifier: String,
    pub title: String,
    pub app_id: Option<String>,
    /// Hyprland's window address, from the mapping protocol.
    pub address: Option<u64>,
}

/// One wlr foreign toplevel.
#[derive(Clone, Debug)]
pub struct WlrInfo {
    pub proxy: ZwlrForeignToplevelHandleV1,
    pub title: String,
    pub app_id: Option<String>,
    pub minimized: bool,
    pub activated: bool,
    pub has_parent: bool,
    /// Connector names of the outputs it is on.
    pub outputs: Vec<String>,
}

/// The lists as of the last batch of events.
#[derive(Clone, Default)]
pub struct Snap {
    pub toplevels: Vec<TopInfo>,
    pub wlr: Vec<WlrInfo>,
    pub outputs: Vec<NativeOutput>,
    /// The newest sync token answered.
    synced: u64,
    /// The connection failed: nothing changes any more.
    pub dead: Option<String>,
}

struct Shared {
    snap: Mutex<Snap>,
    changed: Condvar,
    token: AtomicU64,
}

/// The inventory connection. See the module docs.
pub struct Lister {
    conn: Connection,
    qh: QueueHandle<State>,
    seat: Option<wl_seat::WlSeat>,
    shared: Arc<Shared>,
    pub output_capture: bool,
    pub mapping: bool,
}

impl Lister {
    /// Connect, check the compositor offers what the driver needs, read the lists once, and
    /// start the thread that keeps them.
    pub fn start() -> std::result::Result<Lister, String> {
        let conn = Connection::connect_to_env().map_err(|e| format!("no Wayland display ({e})"))?;
        let (globals, mut queue) =
            registry_queue_init::<State>(&conn).map_err(|e| format!("Wayland registry: {e}"))?;
        let qh = queue.handle();
        let offered = |name: &str| globals.contents().with_list(|l| l.iter().any(|g| g.interface == name));
        let missing: Vec<&str> =
            [TOPLEVEL_LIST, COPY_CAPTURE, TOPLEVEL_SOURCE, "wl_shm"].into_iter().filter(|n| !offered(n)).collect();
        if !missing.is_empty() {
            return Err(format!("the compositor does not offer {}", missing.join(", ")));
        }
        let mut state = State::default();
        let _list: ExtForeignToplevelListV1 = globals.bind(&qh, 1..=1, ()).map_err(|e| e.to_string())?;
        state.xdg = globals.bind(&qh, 1..=3, ()).ok();
        state.mapping = globals.bind(&qh, 1..=1, ()).ok();
        if offered(WLR_TOPLEVELS) {
            let _wlr: Option<ZwlrForeignToplevelManagerV1> = globals.bind(&qh, 1..=3, ()).ok();
        }
        let seat: Option<wl_seat::WlSeat> = globals.bind(&qh, 1..=1, ()).ok();
        let registry = globals.registry().clone();
        globals.contents().with_list(|list| {
            for g in list.iter().filter(|g| g.interface == "wl_output") {
                state.add_output(&registry, &qh, g.name, g.version);
            }
        });
        // Toplevels and outputs; then their identifiers, xdg outputs and mapping requests; then
        // the mapping answers.
        for _ in 0..3 {
            queue.roundtrip(&mut state).map_err(|e| format!("Wayland: {e}"))?;
        }
        let shared = Arc::new(Shared { snap: Mutex::new(state.snap()), changed: Condvar::new(), token: AtomicU64::new(0) });
        let lister = Lister {
            conn: conn.clone(),
            qh,
            seat,
            shared: shared.clone(),
            output_capture: offered(OUTPUT_SOURCE),
            mapping: state.mapping.is_some(),
        };
        std::thread::Builder::new()
            .name("kimochi-ext-list".into())
            .spawn(move || {
                let error = loop {
                    if let Err(e) = queue.blocking_dispatch(&mut state) {
                        break e.to_string();
                    }
                    let snap = state.snap();
                    *shared.snap.lock().unwrap() = snap;
                    shared.changed.notify_all();
                };
                eprintln!("Wayland capture: ext inventory connection ended: {error}");
                shared.snap.lock().unwrap().dead = Some(error);
                shared.changed.notify_all();
            })
            .map_err(|e| e.to_string())?;
        Ok(lister)
    }

    /// The lists, including everything the compositor sent before this call.
    pub fn snapshot(&self) -> Snap {
        let token = self.shared.token.fetch_add(1, Ordering::SeqCst) + 1;
        self.conn.display().sync(&self.qh, token);
        let _ = self.conn.flush();
        let deadline = Instant::now() + SYNC_WAIT;
        let mut snap = self.shared.snap.lock().unwrap();
        while snap.synced < token && snap.dead.is_none() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            snap = self.shared.changed.wait_timeout(snap, left).unwrap().0;
        }
        snap.clone()
    }

    /// Unminimize and activate a wlr toplevel.
    pub fn activate_wlr(&self, toplevel: &ZwlrForeignToplevelHandleV1, minimized: bool) -> std::result::Result<(), String> {
        let seat = self.seat.as_ref().ok_or("the compositor has no seat")?;
        if minimized {
            toplevel.unset_minimized();
        }
        toplevel.activate(seat);
        self.conn.flush().map_err(|e| e.to_string())
    }
}

// ----- The thread's state ------------------------------------------------------------------

#[derive(Default)]
struct State {
    toplevels: Vec<Top>,
    wlr: Vec<Wlr>,
    outputs: Vec<Out>,
    xdg: Option<ZxdgOutputManagerV1>,
    mapping: Option<HyprlandToplevelMappingManagerV1>,
    synced: u64,
}

struct Top {
    proxy: ExtForeignToplevelHandleV1,
    identifier: Option<String>,
    title: String,
    app_id: Option<String>,
    done: bool,
    address: Option<u64>,
    asked: bool,
}

struct Wlr {
    proxy: ZwlrForeignToplevelHandleV1,
    title: String,
    app_id: Option<String>,
    states: Vec<u32>,
    outputs: Vec<wl_output::WlOutput>,
    parent: bool,
    done: bool,
}

#[derive(Default)]
struct Out {
    global: u32,
    proxy: Option<wl_output::WlOutput>,
    xdg: Option<ZxdgOutputV1>,
    name: Option<String>,
    description: Option<String>,
    make: String,
    model: String,
    position: (i32, i32),
    mode: Option<(i32, i32)>,
    transform: Option<wl_output::Transform>,
    scale: i32,
    logical_position: Option<(i32, i32)>,
    logical_size: Option<(i32, i32)>,
}

impl Out {
    fn native(&self) -> Option<NativeOutput> {
        let handle = self.name.clone().filter(|n| !n.is_empty() && !n.contains(':'))?;
        let (mw, mh) = self.mode?;
        let rotated = matches!(
            self.transform,
            Some(wl_output::Transform::_90 | wl_output::Transform::_270 | wl_output::Transform::Flipped90 | wl_output::Transform::Flipped270)
        );
        let (pw, ph) = if rotated { (mh, mw) } else { (mw, mh) };
        let int_scale = self.scale.max(1);
        let (lw, lh) = self.logical_size.unwrap_or((pw / int_scale, ph / int_scale));
        let (x, y) = self.logical_position.unwrap_or(self.position);
        if lw <= 0 || lh <= 0 {
            return None;
        }
        let known = |s: &str| !s.is_empty() && !s.eq_ignore_ascii_case("unknown");
        let name = if known(&self.make) || known(&self.model) {
            [self.make.as_str(), self.model.as_str()].into_iter().filter(|s| known(s)).collect::<Vec<_>>().join(" ")
        } else {
            // Compositors describe an output as "<make> <model> (<connector>)"; with neither
            // known (a VM's virtual output) that is only padding around the connector.
            let described = self.description.as_deref().map(str::trim).unwrap_or("");
            let described = described.strip_suffix(&format!("({handle})")).unwrap_or(described).trim();
            if described.is_empty() { handle.clone() } else { described.to_string() }
        };
        Some(NativeOutput {
            handle,
            name,
            bounds: Rect { x: x.into(), y: y.into(), width: lw.into(), height: lh.into() },
            scale: f64::from(pw) / f64::from(lw),
            primary: false,
        })
    }
}

impl State {
    fn add_output(&mut self, registry: &wl_registry::WlRegistry, qh: &QueueHandle<State>, global: u32, version: u32) {
        let proxy: wl_output::WlOutput = registry.bind(global, version.min(4), qh, global);
        let xdg = self.xdg.as_ref().map(|m| m.get_xdg_output(&proxy, qh, global));
        self.outputs.push(Out { global, proxy: Some(proxy), xdg, scale: 1, ..Default::default() });
    }

    fn output_name(&self, proxy: &wl_output::WlOutput) -> Option<String> {
        self.outputs.iter().find(|o| o.proxy.as_ref() == Some(proxy)).and_then(|o| o.name.clone())
    }

    fn snap(&self) -> Snap {
        let toplevels = self
            .toplevels
            .iter()
            .filter(|t| t.done)
            .filter_map(|t| {
                Some(TopInfo {
                    identifier: t.identifier.clone()?,
                    title: t.title.clone(),
                    app_id: t.app_id.clone(),
                    address: t.address,
                })
            })
            .collect();
        let wlr = self
            .wlr
            .iter()
            .filter(|w| w.done)
            .map(|w| WlrInfo {
                proxy: w.proxy.clone(),
                title: w.title.clone(),
                app_id: w.app_id.clone(),
                minimized: w.states.contains(&(zwlr_foreign_toplevel_handle_v1::State::Minimized as u32)),
                activated: w.states.contains(&(zwlr_foreign_toplevel_handle_v1::State::Activated as u32)),
                has_parent: w.parent,
                outputs: w.outputs.iter().filter_map(|o| self.output_name(o)).collect(),
            })
            .collect();
        let mut outputs: Vec<NativeOutput> = self.outputs.iter().filter_map(Out::native).collect();
        // No "primary" on these compositors: call the one at the origin primary, else the first.
        let primary = outputs.iter().position(|o| o.bounds.x == 0.0 && o.bounds.y == 0.0).unwrap_or(0);
        if let Some(o) = outputs.get_mut(primary) {
            o.primary = true;
        }
        Snap { toplevels, wlr, outputs, synced: self.synced, dead: None }
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
                state.add_output(registry, qh, name, version);
            }
            wl_registry::Event::GlobalRemove { name } => {
                if let Some(i) = state.outputs.iter().position(|o| o.global == name) {
                    let out = state.outputs.remove(i);
                    if let Some(xdg) = out.xdg {
                        xdg.destroy();
                    }
                    if let Some(p) = out.proxy.filter(|p| p.version() >= 3) {
                        p.release();
                    }
                }
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_callback::WlCallback, u64> for State {
    fn event(state: &mut Self, _: &wl_callback::WlCallback, event: wl_callback::Event, token: &u64, _: &Connection, _: &QueueHandle<Self>) {
        if let wl_callback::Event::Done { .. } = event {
            state.synced = state.synced.max(*token);
        }
    }
}

impl Dispatch<ExtForeignToplevelListV1, ()> for State {
    fn event(state: &mut Self, _: &ExtForeignToplevelListV1, event: ext_foreign_toplevel_list_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        if let ext_foreign_toplevel_list_v1::Event::Toplevel { toplevel } = event {
            state.toplevels.push(Top {
                proxy: toplevel,
                identifier: None,
                title: String::new(),
                app_id: None,
                done: false,
                address: None,
                asked: false,
            });
        }
    }
    event_created_child!(State, ExtForeignToplevelListV1, [
        ext_foreign_toplevel_list_v1::EVT_TOPLEVEL_OPCODE => (ExtForeignToplevelHandleV1, ()),
    ]);
}

impl Dispatch<ExtForeignToplevelHandleV1, ()> for State {
    fn event(state: &mut Self, proxy: &ExtForeignToplevelHandleV1, event: ext_foreign_toplevel_handle_v1::Event, _: &(), _: &Connection, qh: &QueueHandle<Self>) {
        use ext_foreign_toplevel_handle_v1::Event;
        let Some(i) = state.toplevels.iter().position(|t| &t.proxy == proxy) else { return };
        let top = &mut state.toplevels[i];
        match event {
            Event::Title { title } => top.title = title,
            Event::AppId { app_id } => top.app_id = Some(app_id).filter(|a| !a.is_empty()),
            Event::Identifier { identifier } => top.identifier = Some(identifier),
            Event::Done => {
                top.done = true;
                if !top.asked {
                    top.asked = true;
                    if let Some(mapping) = &state.mapping {
                        mapping.get_window_for_toplevel(proxy, qh, proxy.clone());
                    }
                }
            }
            Event::Closed => {
                state.toplevels.remove(i).proxy.destroy();
            }
            _ => {}
        }
    }
}

impl Dispatch<HyprlandToplevelWindowMappingHandleV1, ExtForeignToplevelHandleV1> for State {
    fn event(
        state: &mut Self,
        handle: &HyprlandToplevelWindowMappingHandleV1,
        event: hyprland_toplevel_window_mapping_handle_v1::Event,
        toplevel: &ExtForeignToplevelHandleV1,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let hyprland_toplevel_window_mapping_handle_v1::Event::WindowAddress { address_hi, address } = event {
            if let Some(top) = state.toplevels.iter_mut().find(|t| &t.proxy == toplevel) {
                top.address = Some((u64::from(address_hi) << 32) | u64::from(address));
            }
        }
        // Either answer is the last one.
        handle.destroy();
    }
}

impl Dispatch<ZwlrForeignToplevelManagerV1, ()> for State {
    fn event(state: &mut Self, _: &ZwlrForeignToplevelManagerV1, event: zwlr_foreign_toplevel_manager_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        if let zwlr_foreign_toplevel_manager_v1::Event::Toplevel { toplevel } = event {
            state.wlr.push(Wlr {
                proxy: toplevel,
                title: String::new(),
                app_id: None,
                states: Vec::new(),
                outputs: Vec::new(),
                parent: false,
                done: false,
            });
        }
    }
    event_created_child!(State, ZwlrForeignToplevelManagerV1, [
        zwlr_foreign_toplevel_manager_v1::EVT_TOPLEVEL_OPCODE => (ZwlrForeignToplevelHandleV1, ()),
    ]);
}

impl Dispatch<ZwlrForeignToplevelHandleV1, ()> for State {
    fn event(state: &mut Self, proxy: &ZwlrForeignToplevelHandleV1, event: zwlr_foreign_toplevel_handle_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        use zwlr_foreign_toplevel_handle_v1::Event;
        let Some(i) = state.wlr.iter().position(|t| &t.proxy == proxy) else { return };
        let top = &mut state.wlr[i];
        match event {
            Event::Title { title } => top.title = title,
            Event::AppId { app_id } => top.app_id = Some(app_id).filter(|a| !a.is_empty()),
            Event::OutputEnter { output } => top.outputs.push(output),
            Event::OutputLeave { output } => top.outputs.retain(|o| o != &output),
            Event::State { state: bytes } => {
                top.states = bytes.as_chunks::<4>().0.iter().map(|c| u32::from_ne_bytes(*c)).collect();
            }
            Event::Parent { parent } => top.parent = parent.is_some(),
            Event::Done => top.done = true,
            Event::Closed => {
                state.wlr.remove(i).proxy.destroy();
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_output::WlOutput, u32> for State {
    fn event(state: &mut Self, _: &wl_output::WlOutput, event: wl_output::Event, global: &u32, _: &Connection, _: &QueueHandle<Self>) {
        let Some(out) = state.outputs.iter_mut().find(|o| o.global == *global) else { return };
        match event {
            wl_output::Event::Geometry { x, y, make, model, transform, .. } => {
                out.position = (x, y);
                out.make = make;
                out.model = model;
                out.transform = match transform {
                    WEnum::Value(t) => Some(t),
                    WEnum::Unknown(_) => None,
                };
            }
            wl_output::Event::Mode { flags: WEnum::Value(flags), width, height, .. }
                if flags.contains(wl_output::Mode::Current) =>
            {
                out.mode = Some((width, height));
            }
            wl_output::Event::Scale { factor } => out.scale = factor,
            wl_output::Event::Name { name } => out.name = Some(name),
            wl_output::Event::Description { description } => out.description = Some(description),
            _ => {}
        }
    }
}

impl Dispatch<ZxdgOutputV1, u32> for State {
    fn event(state: &mut Self, _: &ZxdgOutputV1, event: zxdg_output_v1::Event, global: &u32, _: &Connection, _: &QueueHandle<Self>) {
        let Some(out) = state.outputs.iter_mut().find(|o| o.global == *global) else { return };
        match event {
            zxdg_output_v1::Event::LogicalPosition { x, y } => out.logical_position = Some((x, y)),
            zxdg_output_v1::Event::LogicalSize { width, height } => out.logical_size = Some((width, height)),
            // wl_output v4 says the same; older compositors only say it here.
            zxdg_output_v1::Event::Name { name } => {
                out.name.get_or_insert(name);
            }
            zxdg_output_v1::Event::Description { description } => {
                out.description.get_or_insert(description);
            }
            _ => {}
        }
    }
}

delegate_noop!(State: ignore wl_seat::WlSeat);
delegate_noop!(State: ZxdgOutputManagerV1);
delegate_noop!(State: HyprlandToplevelMappingManagerV1);
