//! Gaming Mode capture: Gamescope's own PipeWire stream, one app at a time.
//!
//! **Why not the portal.** In Gaming Mode the ScreenCast portal shares one thing, the
//! composed screen, and Kimochi's controls are part of it: a preview of it is a picture
//! of Kimochi. Gamescope itself publishes a PipeWire node (`node.name = gamescope`)
//! whose format carries a private property, `focus_appid` (`0x70001`, the one Steam's
//! game recording uses). A consumer that asks for an app ID gets that app composed on
//! its own, whether or not it is in front ("Exposing appid … focus-wise on pipewire
//! stream", Gamescope 3.16 on SteamOS 3.8). App ID 0 is the composed screen.
//!
//! **Catalog.** `GAMESCOPE_FOCUSABLE_APPS` and `GAMESCOPE_FOCUSABLE_WINDOWS` (triples
//! of window, app ID, pid) on the root of Gamescope's first XWayland server list what
//! is running. Steam's own client (app 769) and this process are left out. Names here
//! are window titles; the app replaces them with Steam's names for the apps.
//!
//! **Ids.** `gamescope:display:0` for the screen, `gamescope:window:{appid}:{pid}` for
//! an app. Session-scoped like every id; the saved descriptor (kind, name, app) is
//! what survives a relaunch.
//!
//! **One stream.** The node has one output, so the backend keeps one PipeWire stream
//! and reconnects it with another app ID to switch. The newest frame of every app seen
//! is kept, so a thumbnail of an app that was streamed a moment ago needs no switch.
//! Gamescope only sends a frame when the app draws; an app that is idle produces
//! nothing until it does.
//!
//! **Steam's recording.** If another client (Steam's game recording) is reading the
//! node, the backend never switches its app ID: that would change what Steam records.
//! The screen stays available; apps report `busy` until the other reader goes away.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use crate::{Platform, Rect, Source, SourceId};

/// Steam's client UI, which Gamescope lists as an app.
pub const STEAM_CLIENT_APP: u32 = 769;
/// Gamescope's private format property: compose only this app ID.
const FOCUS_APPID: u32 = 0x70001;
/// `node.name` of Gamescope's video source.
const NODE_NAME: &str = "gamescope";
/// Our stream's node name, so the registry can tell our link from other readers'.
const OWN_NODE_NAME: &str = "kimochi-gamescope-capture";

/// One running app, as Gamescope lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct App {
    pub app_id: u32,
    pub pid: Option<u32>,
    /// The first listed window's title; may be empty.
    pub title: String,
    pub window: Option<u32>,
}

/// `GAMESCOPE_FOCUSABLE_WINDOWS` is a flat list of (window, app ID, pid) triples.
pub(crate) fn window_triples(values: &[u32]) -> Vec<(u32, u32, u32)> {
    values.chunks_exact(3).map(|c| (c[0], c[1], c[2])).collect()
}

/// Apps in Gamescope's order, without Steam's client, app 0 and anything of `own_pid`
/// or `own_app`. Each takes the first window listed for it.
pub(crate) fn running_apps(
    apps: &[u32],
    windows: &[(u32, u32, u32)],
    own_pid: u32,
    own_app: Option<u32>,
    title: impl Fn(u32) -> String,
) -> Vec<App> {
    let mut out: Vec<App> = Vec::new();
    for &app_id in apps {
        if app_id == 0 || app_id == STEAM_CLIENT_APP || Some(app_id) == own_app {
            continue;
        }
        if out.iter().any(|a| a.app_id == app_id) {
            continue;
        }
        let window = windows.iter().find(|(_, app, _)| *app == app_id);
        if window.is_some_and(|(_, _, pid)| *pid == own_pid) {
            continue;
        }
        out.push(App {
            app_id,
            pid: window.map(|w| w.2).filter(|pid| *pid != 0),
            title: window.map(|w| title(w.0)).unwrap_or_default(),
            window: window.map(|w| w.0),
        });
    }
    out
}

pub fn display_source_id() -> String {
    SourceId::display(Platform::Gamescope, 0).to_string()
}

pub fn app_source_id(app_id: u32, pid: Option<u32>) -> String {
    SourceId::window(Platform::Gamescope, app_id, pid.unwrap_or(0)).to_string()
}

/// The app ID a Gamescope source id names: 0 for the screen.
pub fn app_of(source_id: &str) -> Option<u32> {
    let id = SourceId::parse(source_id).filter(|id| id.platform() == Platform::Gamescope)?;
    if id.is_display() {
        Some(0)
    } else {
        id.handle_u32().filter(|app| *app != 0)
    }
}

fn source(id: String, kind: &'static str, name: String, bounds: Option<Rect>) -> Source {
    Source {
        id,
        kind,
        name,
        app: None,
        bounds,
        on_screen: Some(true),
    }
}

/// The app the user last ran, if this is one we were started from (`KIMOCHI_STEAM_APP_ID`).
fn own_app() -> Option<u32> {
    std::env::var("KIMOCHI_STEAM_APP_ID")
        .ok()?
        .parse()
        .ok()
        .filter(|v| *v != 0)
}

#[cfg(target_os = "linux")]
pub use backend::{available, running, sources, GamescopeCapture};

#[cfg(target_os = "linux")]
mod backend {
    use super::*;
    use crate::linux_portal::backend::{buffers_param, enum_format_with, pixel_order};
    use crate::linux_portal::{crop_region, plane_to_rgba, PixelOrder};
    use crate::linux_x11::desktop::Desktop;
    use crate::pixels::{box_downscale, crop_pixels, fit_within, unpremultiply};
    use crate::{
        crop_rect, elapsed_ms, Capabilities, CaptureBackend, CaptureError, CaptureRequest, Crop,
        Frame, FrameInfo, Result,
    };
    use pipewire as pw;
    use pw::spa;
    use spa::pod::{Pod, Property, PropertyFlags, Value};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _};

    /// The newest frame of the app being streamed.
    const FRAME_WAIT: Duration = Duration::from_millis(500);
    /// Switching apps reconnects the stream; Gamescope then needs one draw of the app.
    const SWITCH_WAIT: Duration = Duration::from_millis(1500);
    /// A kept frame of another app is good enough for a picker thumbnail.
    const THUMBNAIL_AGE: Duration = Duration::from_secs(5);
    const START_WAIT: Duration = Duration::from_secs(3);
    const MAX_PIXELS: u64 = 64_000_000;
    const PIXEL_FORMAT: &str = "RGBA8 straight alpha, top-left rows";
    const COLOR_SPACE: &str = "Display native (SDR; no embedded ICC profile)";

    fn native(e: impl ToString) -> CaptureError {
        CaptureError::new("native", e)
    }

    // ----- Catalog ---------------------------------------------------------------

    fn desktop() -> Option<&'static Desktop> {
        static DESKTOP: OnceLock<Option<Desktop>> = OnceLock::new();
        DESKTOP.get_or_init(|| Desktop::connect().ok()).as_ref()
    }

    fn root_values(d: &Desktop, name: &[u8]) -> Vec<u32> {
        let Some(atom) = d
            .conn
            .intern_atom(true, name)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| r.atom)
            .filter(|a| *a != 0)
        else {
            return Vec::new();
        };
        d.property32(d.root, atom, AtomEnum::CARDINAL).unwrap_or_default()
    }

    /// What Gamescope says is running, without Steam's client and this app.
    pub fn running() -> Vec<App> {
        let Some(d) = desktop() else { return Vec::new() };
        let apps = root_values(d, b"GAMESCOPE_FOCUSABLE_APPS");
        let windows = window_triples(&root_values(d, b"GAMESCOPE_FOCUSABLE_WINDOWS"));
        running_apps(&apps, &windows, std::process::id(), own_app(), |w| d.title(w))
    }

    /// The output, in root pixels: every Gamescope frame is composed at this size.
    fn output() -> Option<Rect> {
        let r = desktop()?.root_rect();
        Some(Rect {
            x: 0.,
            y: 0.,
            width: f64::from(r.width),
            height: f64::from(r.height),
        })
    }

    /// The screen, then each running app. Names are window titles (or empty).
    pub fn sources() -> Vec<Source> {
        let bounds = output();
        let mut out = vec![super::source(display_source_id(), "display", "Screen".into(), bounds)];
        for app in running() {
            let mut s = super::source(
                app_source_id(app.app_id, app.pid),
                "window",
                app.title.clone(),
                bounds,
            );
            s.app = Some(app.app_id.to_string());
            out.push(s);
        }
        out
    }

    /// Whether Gamescope's PipeWire node is there to read. Asked once per process.
    pub fn available() -> bool {
        static AVAILABLE: OnceLock<bool> = OnceLock::new();
        *AVAILABLE.get_or_init(|| {
            let (tx, rx) = mpsc::channel();
            let _ = std::thread::Builder::new()
                .name("kimochi-gamescope-probe".into())
                .spawn(move || {
                    let _ = tx.send(probe().unwrap_or(false));
                });
            rx.recv_timeout(START_WAIT).unwrap_or(false)
        })
    }

    fn is_gamescope_node(props: Option<&spa::utils::dict::DictRef>) -> bool {
        props.is_some_and(|p| {
            p.get("node.name") == Some(NODE_NAME)
                && p.get("media.class").is_some_and(|c| c.starts_with("Video/Source"))
        })
    }

    fn probe() -> std::result::Result<bool, String> {
        let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(|e| e.to_string())?;
        let context = pw::context::ContextRc::new(&mainloop, None).map_err(|e| e.to_string())?;
        let core = context.connect_rc(None).map_err(|e| e.to_string())?;
        let registry = core.get_registry_rc().map_err(|e| e.to_string())?;
        let found = Rc::new(RefCell::new(false));
        let _registry = registry
            .add_listener_local()
            .global({
                let found = found.clone();
                move |g| {
                    if g.type_ == pw::types::ObjectType::Node && is_gamescope_node(g.props) {
                        *found.borrow_mut() = true;
                    }
                }
            })
            .global_remove(|_| {})
            .register();
        let pending = core.sync(0).map_err(|e| e.to_string())?;
        let _core = core
            .add_listener_local()
            .done({
                let weak = mainloop.downgrade();
                move |id, seq| {
                    if id == pw::core::PW_ID_CORE && seq == pending {
                        if let Some(l) = weak.upgrade() {
                            l.quit();
                        }
                    }
                }
            })
            .register();
        mainloop.run();
        let found = *found.borrow();
        Ok(found)
    }

    // ----- Stream ----------------------------------------------------------------

    struct Latest {
        app: u32,
        received: Instant,
        pixels: Vec<u8>,
        width: u32,
        height: u32,
    }

    #[derive(Default)]
    struct Shared {
        /// The app the stream is connected for (what the next frames show).
        streaming: AtomicU32,
        /// The format for `streaming` is negotiated: frames from now on are that app.
        negotiated: AtomicBool,
        /// Other clients linked to Gamescope's node (Steam's recording).
        others: AtomicU32,
        ended: AtomicBool,
        frames: Mutex<HashMap<u32, Arc<Latest>>>,
        arrived: Condvar,
    }

    impl Shared {
        fn publish(&self, frame: Latest) {
            let mut frames = self.frames.lock().unwrap();
            frames.insert(frame.app, Arc::new(frame));
            self.arrived.notify_all();
        }
        fn end(&self) {
            self.ended.store(true, Ordering::SeqCst);
            self.arrived.notify_all();
        }
        /// The newest frame of `app` received at or after `since`, waiting up to `limit`.
        fn frame(&self, app: u32, since: Option<Instant>, limit: Duration) -> Option<Arc<Latest>> {
            let fresh = |f: &Option<&Arc<Latest>>| f.is_some_and(|f| since.is_none_or(|s| f.received >= s));
            let frames = self.frames.lock().unwrap();
            let (frames, _) = self
                .arrived
                .wait_timeout_while(frames, limit, |frames| {
                    !fresh(&frames.get(&app)) && !self.ended.load(Ordering::SeqCst)
                })
                .unwrap();
            frames.get(&app).filter(|f| since.is_none_or(|s| f.received >= s)).cloned()
        }
        fn kept(&self, app: u32) -> Option<Arc<Latest>> {
            self.frames.lock().unwrap().get(&app).cloned()
        }
    }

    #[derive(Clone, Copy)]
    struct Negotiated {
        order: PixelOrder,
        width: u32,
        height: u32,
    }

    struct StreamData {
        shared: Arc<Shared>,
        format: Option<Negotiated>,
    }

    fn format_for(app: u32) -> Option<Vec<u8>> {
        enum_format_with(vec![Property {
            key: FOCUS_APPID,
            flags: PropertyFlags::empty(),
            value: Value::Long(i64::from(app)),
        }])
    }

    type Ready = mpsc::Sender<std::result::Result<pw::channel::Sender<Command>, String>>;

    enum Command {
        Stream(u32),
        Stop,
    }

    fn pipewire_main(app: u32, shared: &Arc<Shared>, ready: &Ready) -> std::result::Result<(), String> {
        let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(|e| e.to_string())?;
        let context = pw::context::ContextRc::new(&mainloop, None).map_err(|e| e.to_string())?;
        let core = context.connect_rc(None).map_err(|e| format!("PipeWire is not running: {e}"))?;
        let _core_listener = core
            .add_listener_local()
            .error({
                let shared = shared.clone();
                let weak = mainloop.downgrade();
                move |id, _, _, _| {
                    if id == pw::core::PW_ID_CORE {
                        shared.end();
                        if let Some(l) = weak.upgrade() {
                            l.quit();
                        }
                    }
                }
            })
            .register();

        // Who else reads Gamescope's node: links from it into any node but ours.
        #[derive(Default)]
        struct Graph {
            gamescope: Option<u32>,
            ours: Vec<u32>,
            links: HashMap<u32, (u32, u32)>,
        }
        let graph = Rc::new(RefCell::new(Graph::default()));
        let recount = {
            let shared = shared.clone();
            move |g: &Graph| {
                let others = g
                    .links
                    .values()
                    .filter(|(out, input)| Some(*out) == g.gamescope && !g.ours.contains(input))
                    .count();
                shared.others.store(others as u32, Ordering::SeqCst);
            }
        };
        let registry = core.get_registry_rc().map_err(|e| e.to_string())?;
        let _registry = registry
            .add_listener_local()
            .global({
                let (graph, recount) = (graph.clone(), recount.clone());
                move |g| {
                    let mut graph = graph.borrow_mut();
                    match g.type_ {
                        pw::types::ObjectType::Node if is_gamescope_node(g.props) => graph.gamescope = Some(g.id),
                        pw::types::ObjectType::Node
                            if g.props.and_then(|p| p.get("node.name")) == Some(OWN_NODE_NAME) =>
                        {
                            graph.ours.push(g.id)
                        }
                        pw::types::ObjectType::Link => {
                            let node = |key| g.props.and_then(|p| p.get(key)).and_then(|v| v.parse().ok());
                            if let (Some(out), Some(input)) = (node("link.output.node"), node("link.input.node")) {
                                graph.links.insert(g.id, (out, input));
                            }
                        }
                        _ => return,
                    }
                    recount(&graph);
                }
            })
            .global_remove({
                let graph = graph.clone();
                move |id| {
                    let mut graph = graph.borrow_mut();
                    graph.links.remove(&id);
                    graph.ours.retain(|n| *n != id);
                    if graph.gamescope == Some(id) {
                        graph.gamescope = None;
                    }
                    recount(&graph);
                }
            })
            .register();

        let stream = pw::stream::StreamRc::new(
            core.clone(),
            "kimochi-capture",
            pw::properties::properties! {
                *pw::keys::MEDIA_TYPE => "Video",
                *pw::keys::MEDIA_CATEGORY => "Capture",
                *pw::keys::MEDIA_ROLE => "Screen",
                *pw::keys::NODE_NAME => OWN_NODE_NAME,
                "target.object" => NODE_NAME,
            },
        )
        .map_err(|e| e.to_string())?;
        let _listener = stream
            .add_local_listener_with_user_data(StreamData { shared: shared.clone(), format: None })
            .state_changed(|_, data, _old, new| {
                use pw::stream::StreamState as S;
                match new {
                    S::Error(_) => data.shared.end(),
                    S::Unconnected | S::Connecting => {
                        data.format = None;
                        data.shared.negotiated.store(false, Ordering::SeqCst);
                    }
                    _ => {}
                }
            })
            .param_changed(|stream, data, id, param| {
                let Some(param) = param else { return };
                if id != spa::param::ParamType::Format.as_raw() {
                    return;
                }
                let mut info = spa::param::video::VideoInfoRaw::default();
                data.format = info.parse(param).ok().and_then(|_| {
                    let size = info.size();
                    pixel_order(info.format()).map(|order| Negotiated { order, width: size.width, height: size.height })
                });
                data.shared.negotiated.store(data.format.is_some(), Ordering::SeqCst);
                if let Some(buffers) = buffers_param() {
                    let mut params: Vec<&Pod> = Pod::from_bytes(&buffers).into_iter().collect();
                    let _ = stream.update_params(&mut params);
                }
            })
            .process(|stream, data| {
                let Some(mut buffer) = stream.dequeue_buffer() else { return };
                while let Some(newer) = stream.dequeue_buffer() {
                    buffer = newer;
                }
                let Some(format) = data.format else { return };
                if !data.shared.negotiated.load(Ordering::SeqCst) {
                    return;
                }
                let app = data.shared.streaming.load(Ordering::SeqCst);
                let datas = buffer.datas_mut();
                let Some(plane) = datas.first_mut() else { return };
                let kind = plane.type_();
                if kind != spa::buffer::DataType::MemPtr && kind != spa::buffer::DataType::MemFd {
                    return;
                }
                let chunk = plane.chunk();
                let (offset, size, stride) = (chunk.offset() as usize, chunk.size() as usize, chunk.stride());
                if size == 0 || chunk.flags().contains(spa::buffer::ChunkFlags::CORRUPTED) {
                    return;
                }
                let Some(bytes) = plane.data() else { return };
                let valid = &bytes[..bytes.len().min(offset.saturating_add(size))];
                let (w, h) = (format.width, format.height);
                if w == 0 || h == 0 || u64::from(w) * u64::from(h) > MAX_PIXELS {
                    return;
                }
                let region = crop_region(w, h, None);
                if let Some(pixels) = plane_to_rgba(valid, offset, stride, w, h, region, format.order) {
                    data.shared.publish(Latest { app, received: Instant::now(), pixels, width: w, height: h });
                }
            })
            .register()
            .map_err(|e| e.to_string())?;

        let connect = {
            let (stream, shared) = (stream.clone(), shared.clone());
            move |app: u32| -> std::result::Result<(), String> {
                shared.streaming.store(app, Ordering::SeqCst);
                shared.negotiated.store(false, Ordering::SeqCst);
                let format = format_for(app).ok_or("could not build the format request")?;
                let pod = Pod::from_bytes(&format).ok_or("invalid format pod")?;
                stream
                    .connect(
                        spa::utils::Direction::Input,
                        None,
                        pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
                        &mut [pod],
                    )
                    .map_err(|e| e.to_string())
            }
        };
        connect(app)?;

        let (tx, rx) = pw::channel::channel::<Command>();
        let weak = mainloop.downgrade();
        let _commands = rx.attach(mainloop.loop_(), {
            let (stream, shared) = (stream.clone(), shared.clone());
            move |command| match command {
                Command::Stream(app) => {
                    if shared.streaming.load(Ordering::SeqCst) == app {
                        return;
                    }
                    let _ = stream.disconnect();
                    if let Err(e) = connect(app) {
                        eprintln!("Gamescope capture: {e}");
                        shared.end();
                    }
                }
                Command::Stop => {
                    if let Some(l) = weak.upgrade() {
                        l.quit();
                    }
                }
            }
        });
        ready.send(Ok(tx)).map_err(|_| "capture backend went away".to_string())?;
        mainloop.run();
        let _ = stream.disconnect();
        Ok(())
    }

    struct Cast {
        shared: Arc<Shared>,
        commands: pw::channel::Sender<Command>,
        thread: Option<JoinHandle<()>>,
    }

    impl Cast {
        fn start(app: u32) -> Result<Self> {
            let shared = Arc::new(Shared::default());
            let (tx, rx) = mpsc::channel();
            let thread = {
                let shared = shared.clone();
                std::thread::Builder::new()
                    .name("kimochi-gamescope".into())
                    .spawn(move || {
                        if let Err(e) = pipewire_main(app, &shared, &tx) {
                            let _ = tx.send(Err(e));
                        }
                        shared.end();
                    })
                    .map_err(native)?
            };
            match rx.recv_timeout(START_WAIT) {
                Ok(Ok(commands)) => Ok(Self { shared, commands, thread: Some(thread) }),
                Ok(Err(e)) => Err(native(e)),
                Err(_) => Err(native("Gamescope's PipeWire stream did not start in time")),
            }
        }
        fn alive(&self) -> bool {
            !self.shared.ended.load(Ordering::SeqCst)
        }
    }

    impl Drop for Cast {
        fn drop(&mut self) {
            let _ = self.commands.send(Command::Stop);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// Gamescope's PipeWire node, one app at a time. See the module docs.
    #[derive(Default)]
    pub struct GamescopeCapture {
        cast: Mutex<Option<Cast>>,
    }

    impl GamescopeCapture {
        pub fn new() -> Self {
            Self::default()
        }

        fn cast(&self, app: u32) -> Result<Arc<Shared>> {
            let mut guard = self.cast.lock().unwrap();
            if !guard.as_ref().is_some_and(Cast::alive) {
                *guard = None;
                *guard = Some(Cast::start(app)?);
            }
            Ok(guard.as_ref().unwrap().shared.clone())
        }

        /// The newest frame of `app`, switching the stream to it when needed.
        fn latest(&self, app: u32, thumbnail: bool) -> Result<Arc<Latest>> {
            let shared = self.cast(app)?;
            if thumbnail {
                if let Some(kept) = shared.kept(app).filter(|f| f.received.elapsed() < THUMBNAIL_AGE) {
                    return Ok(kept);
                }
            }
            let streaming = shared.streaming.load(Ordering::SeqCst);
            if streaming == app {
                return shared.frame(app, None, FRAME_WAIT).ok_or_else(|| idle(app));
            }
            if shared.others.load(Ordering::SeqCst) > 0 {
                return Err(CaptureError::new(
                    "busy",
                    "Steam is recording from Gamescope, so Kimochi can't switch what it reads. Choose Screen, or stop the recording.",
                ));
            }
            let since = Instant::now();
            let guard = self.cast.lock().unwrap();
            let cast = guard.as_ref().ok_or_else(|| native("Gamescope capture stopped"))?;
            cast.commands.send(Command::Stream(app)).map_err(|_| native("Gamescope capture stopped"))?;
            drop(guard);
            shared.frame(app, Some(since), SWITCH_WAIT).ok_or_else(|| idle(app))
        }

        fn grab(&self, source_id: &str, crop: Option<Crop>, edge: Option<u32>) -> Result<Frame> {
            let start = Instant::now();
            let app = app_of(source_id).ok_or_else(|| {
                CaptureError::new("stale_source", "That source is not a Gaming Mode app. Choose a source again.")
            })?;
            if app != 0 && !running().iter().any(|a| a.app_id == app) {
                return Err(CaptureError::new("stale_source", "That app is no longer running. Choose a source."));
            }
            let resolve_ms = elapsed_ms(start);
            let acquisition = Instant::now();
            let frame = self.latest(app, edge.is_some())?;
            let acquisition_ms = elapsed_ms(acquisition);
            let (fw, fh) = (frame.width, frame.height);
            let copying = Instant::now();
            let rect = crop_rect(crop, fw, fh)?;
            let mut pixels = if rect == [0, 0, fw, fh] { frame.pixels.clone() } else { crop_pixels(&frame.pixels, fw, rect) };
            let bounds = output();
            let base = bounds.map_or(1., |b| f64::from(fw) / b.width.max(1.));
            let (mut info_crop, mut full, mut scale) = (rect, (fw, fh), base);
            if let Some(edge) = edge {
                let (w, h) = fit_within(rect[2], rect[3], edge.max(1));
                if (w, h) != (rect[2], rect[3]) {
                    pixels = box_downscale(&pixels, rect[2], rect[3], w, h);
                }
                scale = base * f64::from(w) / f64::from(fw);
                info_crop = [0, 0, w, h];
                full = (w, h);
            }
            unpremultiply(&mut pixels);
            let [_, _, w, h] = info_crop;
            Ok(Frame {
                info: FrameInfo {
                    source_id: source_id.to_string(),
                    width: w,
                    height: h,
                    stride: w as usize * 4,
                    full_width: full.0,
                    full_height: full.1,
                    crop_pixels: info_crop,
                    scale_factor: scale,
                    source_bounds: bounds,
                    pixel_format: PIXEL_FORMAT,
                    color_space: COLOR_SPACE,
                    resolve_ms,
                    acquisition_ms,
                    pixels_ms: elapsed_ms(copying),
                    total_ms: elapsed_ms(start),
                },
                pixels,
            })
        }
    }

    fn idle(app: u32) -> CaptureError {
        let what = if app == 0 { "The screen" } else { "That app" };
        CaptureError::new("native", format!("{what} has not drawn anything yet. Try again once it is on screen."))
    }

    impl CaptureBackend for GamescopeCapture {
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                backend: "gamescope-pipewire",
                enumeration: true,
                system_picker_required: false,
                retained_session: true,
            }
        }
        fn permission(&self) -> &'static str {
            "granted"
        }
        fn request_permission(&self) -> bool {
            true
        }
        fn enumerate(&mut self) -> Result<Vec<Source>> {
            Ok(sources())
        }
        fn capture(&mut self, request: &CaptureRequest) -> Result<Frame> {
            self.grab(&request.source_id, request.crop, None)
        }
        fn thumbnail(&mut self, source_id: &str, edge: u32) -> Result<Frame> {
            self.grab(source_id, None, Some(edge))
        }
        fn close(&mut self) {
            *self.cast.lock().unwrap() = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_apps_skip_steam_and_ourselves_and_keep_gamescope_order() {
        // Measured on SteamOS 3.8: Sea of Stars, Steam's client, Undertale; Kimochi is pid 500.
        let windows = window_triples(&[77594625, 391540, 88238, 39845941, 769, 76043, 33554433, 1244090, 87749, 9, 3148519714, 500]);
        let apps = running_apps(&[391540, 769, 1244090, 3148519714, 391540], &windows, 500, None, |w| format!("w{w}"));
        assert_eq!(
            apps,
            vec![
                App { app_id: 391540, pid: Some(88238), title: "w77594625".into(), window: Some(77594625) },
                App { app_id: 1244090, pid: Some(87749), title: "w33554433".into(), window: Some(33554433) },
            ]
        );
        let none = running_apps(&[391540], &[], 1, Some(391540), |_| String::new());
        assert!(none.is_empty());
    }

    #[test]
    fn an_app_without_a_listed_window_is_still_a_source() {
        let apps = running_apps(&[42], &[], 1, None, |_| unreachable!());
        assert_eq!(apps, vec![App { app_id: 42, pid: None, title: String::new(), window: None }]);
    }

    #[test]
    fn ids_round_trip_to_app_ids() {
        assert_eq!(display_source_id(), "gamescope:display:0");
        assert_eq!(app_source_id(1244090, Some(87749)), "gamescope:window:1244090:87749");
        assert_eq!(app_of("gamescope:display:0"), Some(0));
        assert_eq!(app_of("gamescope:window:1244090:87749"), Some(1244090));
        assert_eq!(app_of("gamescope:window:0:1"), None);
        assert_eq!(app_of("portal:window:12"), None);
    }
}
