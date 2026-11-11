//! The driver registry and the [`NativeCapture`] backend. See the module docs in `mod.rs`.
use super::{
    output_handle, sources, window_handle, Inventory, NativeOutput, NativeWindow, KEEP_CAPTURE,
    KEEP_THUMBNAIL,
};
use crate::linux_portal::backend::{LatestFrame, Slot, COLOR_SPACE, MAX_PIXELS, PIXEL_FORMAT};
use crate::pixels::{box_downscale, crop_pixels, fit_within, unpremultiply};
use crate::{
    crop_rect, elapsed_ms, Capabilities, CaptureBackend, CaptureError, CaptureRequest, Crop, Frame,
    FrameInfo, Rect, Result, Source,
};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long a capture waits for a stream that has just opened to deliver its first frame.
const FIRST_FRAME_OPEN: Duration = Duration::from_millis(1500);
/// How long a capture waits on a stream that is already running.
const FIRST_FRAME_RUNNING: Duration = Duration::from_millis(500);
/// A `capture_after` waits at most this long for a frame newer than the fence.
const AFTER_WAIT: Duration = Duration::from_millis(700);
/// The inventory is asked for again after this long.
const INVENTORY_TTL: Duration = Duration::from_millis(250);

/// What a driver streams.
#[derive(Clone, Copy, Debug)]
pub enum Target<'a> {
    Window(&'a NativeWindow),
    Output(&'a NativeOutput),
}

/// One live stream of a source. Dropping it ends the stream (the guard tears down whatever the
/// driver opened: a Mutter session, a KWin stream, a capture session thread).
pub struct Feed {
    pub(crate) slot: Arc<Slot>,
    gone: Box<dyn Fn() -> bool + Send + Sync>,
    _guard: Box<dyn Send>,
}

impl Feed {
    /// `gone` says whether the driver's side has ended (checked on each use; keep it cheap).
    pub(crate) fn new(
        slot: Arc<Slot>,
        gone: impl Fn() -> bool + Send + Sync + 'static,
        guard: Box<dyn Send>,
    ) -> Self {
        Self { slot, gone: Box::new(gone), _guard: guard }
    }
    pub fn alive(&self) -> bool {
        !(self.gone)() && !self.slot.ended.load(Ordering::SeqCst)
    }
    fn frame(&self, limit: Duration, after: Option<Instant>) -> Option<Arc<LatestFrame>> {
        self.slot.frame(limit, after)
    }
}

/// One compositor family's capture API. See the table in `mod.rs`.
pub trait Driver: Send + Sync {
    /// `mutter`, `kwin` or `ext`.
    fn name(&self) -> &'static str;
    /// Windows and outputs now.
    fn inventory(&self) -> Result<Inventory>;
    /// Start streaming a window or an output.
    fn open(&self, target: Target<'_>) -> Result<Feed>;
    /// Bring a window to the front (unminimize, switch workspace, focus).
    fn activate(&self, window: &NativeWindow) -> Result<()>;
    /// Whether a window's stream shows that window alone, so Kimochi's overlay and pop-ups can
    /// never appear in it and need not be hidden for its captures.
    fn isolated_windows(&self) -> bool {
        true
    }
    /// Whether a window's stream is the window's frame bounds exactly (what `bounds` says), so
    /// frame pixels over bounds is the scale.
    fn bounds_match_stream(&self) -> bool {
        true
    }
}

type Probe = fn() -> std::result::Result<Box<dyn Driver>, String>;

struct Registry {
    driver: Option<Box<dyn Driver>>,
    /// Each driver tried, and why it did not work.
    report: Vec<(&'static str, std::result::Result<(), String>)>,
}

static REGISTRY: OnceLock<Registry> = OnceLock::new();
static INVENTORY: Mutex<Option<(Instant, Inventory)>> = Mutex::new(None);
/// Per window (by handle): what its frame has around the area its stream shows, in logical
/// pixels (left, top, right, bottom), learnt from its frames. See [`stream_insets`].
static INSETS: Mutex<Option<HashMap<String, [f64; 4]>>> = Mutex::new(None);

/// What a window's frame has around the area its stream shows: `None` when the stream is the
/// whole frame. KWin streams the frame from Plasma 6.7 (see `kwin.rs`), but up to 6.6 (SteamOS's
/// 6.4 among them) only the client area: 960x559 for a 962x588 XWayland frame (a 1 px border
/// each side and below, a 28 px title bar). Sides and bottom are taken to be equal, as server-side
/// decorations draw them; the title bar is the rest. `scale` is the window's output's.
fn stream_insets(frame: Rect, width: u32, height: u32, scale: f64) -> Option<[f64; 4]> {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let (fw, fh) = (frame.width * scale, frame.height * scale);
    let (w, h) = (f64::from(width), f64::from(height));
    if (fw - w).abs() <= 2.0 && (fh - h).abs() <= 2.0 {
        return None;
    }
    if w > fw + 2.0 || h > fh + 2.0 {
        return None;
    }
    let side = ((fw - w) / 2.0 / scale).max(0.0);
    let top = frame.height - h / scale - side;
    (top >= 0.0 && top < frame.height / 2.0 && side < frame.width / 4.0).then_some([side, top, side, side])
}

fn inset(bounds: Rect, [left, top, right, bottom]: [f64; 4]) -> Rect {
    Rect {
        x: bounds.x + left,
        y: bounds.y + top,
        width: (bounds.width - left - right).max(1.0),
        height: (bounds.height - top - bottom).max(1.0),
    }
}

/// The inventory with each window's bounds narrowed to what its stream shows, where learnt.
fn with_insets(mut inv: Inventory) -> Inventory {
    let insets = INSETS.lock().unwrap();
    if let Some(insets) = insets.as_ref().filter(|m| !m.is_empty()) {
        for window in &mut inv.windows {
            if let (Some(bounds), Some(edges)) = (window.bounds, insets.get(&window.handle)) {
                window.bounds = Some(inset(bounds, *edges));
            }
        }
    }
    inv
}

/// The order to try drivers in: the session's own first, then the rest (niri, for one, answers
/// Mutter's API; a GNOME session never has the ext protocols).
fn order(desktop: &str) -> Vec<(&'static str, Probe)> {
    let all: [(&'static str, Probe); 3] =
        [("mutter", super::mutter::probe), ("kwin", super::kwin::probe), ("ext", super::ext::probe)];
    let desktop = desktop.to_ascii_lowercase();
    let first = if desktop.contains("gnome") || desktop.contains("unity") {
        "mutter"
    } else if desktop.contains("kde") {
        "kwin"
    } else {
        "ext"
    };
    let mut list: Vec<_> = all.into_iter().collect();
    list.sort_by_key(|(name, _)| *name != first);
    list
}

/// Choose the driver for this session, once. `KIMOCHI_WAYLAND_CAPTURE` forces one (`mutter`,
/// `kwin`, `ext`) or turns native capture off (`portal`). Returns the driver's name.
pub fn init() -> Option<&'static str> {
    REGISTRY
        .get_or_init(|| {
            let forced = std::env::var("KIMOCHI_WAYLAND_CAPTURE").ok().filter(|v| !v.is_empty());
            let mut report = Vec::new();
            if forced.as_deref() == Some("portal") || !crate::wayland_session_now() {
                return Registry { driver: None, report };
            }
            let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
            for (name, probe) in order(&desktop) {
                if forced.as_deref().is_some_and(|f| f != name) {
                    continue;
                }
                match probe() {
                    Ok(driver) => {
                        report.push((name, Ok(())));
                        eprintln!("Wayland capture: native driver {name}");
                        return Registry { driver: Some(driver), report };
                    }
                    Err(e) => {
                        eprintln!("Wayland capture: {name} unavailable: {e}");
                        report.push((name, Err(e)));
                    }
                }
            }
            Registry { driver: None, report }
        })
        .driver
        .as_ref()
        .map(|d| d.name())
}

pub fn driver() -> Option<&'static dyn Driver> {
    REGISTRY.get()?.driver.as_deref()
}

pub fn driver_name() -> Option<&'static str> {
    driver().map(|d| d.name())
}

/// Why each driver was or was not chosen, for diagnostics.
pub fn report() -> Vec<(&'static str, std::result::Result<(), String>)> {
    REGISTRY.get().map(|r| r.report.clone()).unwrap_or_default()
}

/// The desktop now, cached for [`INVENTORY_TTL`]. `None` without a driver or when it fails.
pub fn inventory() -> Option<Inventory> {
    inventory_fresh(false).ok().map(with_insets)
}

fn inventory_fresh(force: bool) -> Result<Inventory> {
    let driver = driver().ok_or_else(|| CaptureError::new("unsupported", "No native Wayland capture"))?;
    let mut cached = INVENTORY.lock().unwrap();
    if let Some((at, inv)) = cached.as_ref() {
        if !force && at.elapsed() < INVENTORY_TTL {
            return Ok(inv.clone());
        }
    }
    let inv = driver.inventory()?;
    *cached = Some((Instant::now(), inv.clone()));
    Ok(inv)
}

/// Bring a window source forward.
pub fn activate(handle: &str) -> Result<()> {
    let driver = driver().ok_or_else(|| CaptureError::new("unsupported", "No native Wayland capture"))?;
    let inv = inventory_fresh(true)?;
    let window = inv.window(handle).ok_or_else(closed)?;
    driver.activate(window)?;
    *INVENTORY.lock().unwrap() = None;
    Ok(())
}

/// The PipeWire thread of a node feed; dropping it disconnects the stream and joins the thread.
struct PipeWireThread {
    stop: Option<pipewire::channel::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for PipeWireThread {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// A feed of one PipeWire node on the session's daemon (Mutter's and KWin's screencasts publish
/// there). `session` keeps the compositor's side alive and is dropped after the stream
/// disconnects, so ending the screencast never races a live consumer.
pub(crate) fn pipewire_feed(node: u32, session: Box<dyn Send>) -> Result<Feed> {
    use crate::linux_portal::backend::{pipewire_thread, Shared, PIPEWIRE_START_WAIT};
    let slot = Arc::new(Slot::default());
    let shared = Arc::new(Shared::default());
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let thread = {
        let (nodes, shared) = (vec![(node, slot.clone())], shared.clone());
        std::thread::Builder::new()
            .name("kimochi-pw-native".into())
            .spawn(move || pipewire_thread(None, nodes, shared, ready_tx))
            .map_err(|e| CaptureError::new("native", e))?
    };
    let mut pw = PipeWireThread { stop: None, thread: Some(thread) };
    match ready_rx.recv_timeout(PIPEWIRE_START_WAIT) {
        Ok(Ok(stop)) => pw.stop = Some(stop),
        Ok(Err(message)) => return Err(CaptureError::new("native", message)),
        Err(_) => return Err(CaptureError::new("native", "PipeWire did not start in time")),
    }
    // The core connection or the stream went away.
    let gone = move || shared.closed.load(Ordering::SeqCst);
    Ok(Feed::new(slot, gone, Box::new((pw, session))))
}

fn closed() -> CaptureError {
    CaptureError::new("stale_source", "That window has closed")
}

fn out_of_view() -> CaptureError {
    CaptureError::new("unavailable", "The window is minimized or on another workspace")
}

/// What a source id resolves to now.
enum Resolved {
    Window(NativeWindow),
    Output(NativeOutput),
}

impl Resolved {
    fn target(&self) -> Target<'_> {
        match self {
            Resolved::Window(w) => Target::Window(w),
            Resolved::Output(o) => Target::Output(o),
        }
    }
    fn bounds(&self) -> Option<Rect> {
        match self {
            Resolved::Window(w) => w.bounds,
            Resolved::Output(o) => Some(o.bounds),
        }
    }
}

struct Open {
    feed: Feed,
    used: Instant,
    keep: Duration,
}

/// The compositor's own screencast API, by window identity. See the module docs.
#[derive(Default)]
pub struct NativeCapture {
    feeds: Mutex<HashMap<String, Open>>,
}

impl NativeCapture {
    /// `None` when [`init`] found no driver.
    pub fn new() -> Option<Self> {
        init().map(|_| Self::default())
    }

    fn resolve(&self, source_id: &str) -> Result<Resolved> {
        let lookup = |inv: &Inventory| {
            if let Some(h) = window_handle(source_id) {
                inv.window(&h).cloned().map(Resolved::Window)
            } else if let Some(h) = output_handle(source_id) {
                inv.output(&h).cloned().map(Resolved::Output)
            } else {
                None
            }
        };
        if window_handle(source_id).is_none() && output_handle(source_id).is_none() {
            return Err(CaptureError::new("stale_source", "Not a source of this desktop"));
        }
        if let Some(found) = lookup(&inventory_fresh(false)?) {
            return Ok(found);
        }
        // Something just appeared (or the cache is from before it): ask once more.
        lookup(&inventory_fresh(true)?).ok_or_else(closed)
    }

    /// Close streams nobody has used for their keep time.
    fn reap(feeds: &mut HashMap<String, Open>) {
        feeds.retain(|_, open| open.feed.alive() && open.used.elapsed() < open.keep);
    }

    fn grab(
        &self,
        source_id: &str,
        crop: Option<Crop>,
        edge: Option<u32>,
        after: Option<Instant>,
        thumbnail: bool,
    ) -> Result<Frame> {
        let start = Instant::now();
        let driver = driver().ok_or_else(|| CaptureError::new("unsupported", "No native Wayland capture"))?;
        let resolved = self.resolve(source_id)?;
        if let Resolved::Window(w) = &resolved {
            // A window on another workspace may still stream its last picture: a scan would read
            // what is no longer there, so it waits, as on X11 and Windows. A picker thumbnail may
            // show it (macOS lists other Spaces' windows the same way).
            if w.minimized || (!thumbnail && w.on_screen == Some(false)) {
                return Err(out_of_view());
            }
        }
        let resolve_ms = elapsed_ms(start);
        let acquisition = Instant::now();
        let mut feeds = self.feeds.lock().unwrap();
        Self::reap(&mut feeds);
        let fresh = !feeds.contains_key(source_id);
        if fresh {
            let feed = driver.open(resolved.target())?;
            feeds.insert(
                source_id.to_string(),
                Open { feed, used: Instant::now(), keep: KEEP_THUMBNAIL },
            );
        }
        let open = feeds.get_mut(source_id).unwrap();
        open.used = Instant::now();
        if !thumbnail {
            open.keep = KEEP_CAPTURE;
        }
        // A window's own stream never contains our surfaces, so it needs no newer frame.
        let isolated = matches!(resolved, Resolved::Window(_)) && driver.isolated_windows();
        let after = if isolated { None } else { after };
        let wait = if after.is_some() {
            AFTER_WAIT
        } else if fresh {
            FIRST_FRAME_OPEN
        } else {
            FIRST_FRAME_RUNNING
        };
        let frame = open.feed.frame(wait, after);
        let alive = open.feed.alive();
        if frame.is_none() && !alive {
            feeds.remove(source_id);
        }
        drop(feeds);
        let frame = frame.ok_or_else(|| match &resolved {
            Resolved::Window(w) if w.on_screen == Some(false) => out_of_view(),
            _ if !alive => closed(),
            _ => CaptureError::new("native", "The source produced no image in time; retry"),
        })?;
        let acquisition_ms = elapsed_ms(acquisition);

        let (fw, fh) = (frame.width, frame.height);
        if fw == 0 || fh == 0 || u64::from(fw) * u64::from(fh) > MAX_PIXELS {
            return Err(CaptureError::new("dimensions", "Invalid or larger than 64 megapixel source"));
        }
        let copying = Instant::now();
        let crop = crop_rect(crop, fw, fh)?;
        let mut pixels =
            if crop == [0, 0, fw, fh] { frame.pixels.clone() } else { crop_pixels(&frame.pixels, fw, crop) };
        let mut bounds = resolved.bounds().filter(|b| b.width > 0.0 && b.height > 0.0);
        // KWin before Plasma 6.7 streams a window's client area, not its frame: the bounds are
        // narrowed to it, here and in the inventory from now on (`with_insets`).
        if let (Resolved::Window(w), Some(frame_bounds), "kwin") = (&resolved, bounds, driver.name()) {
            let scale = inventory_fresh(false)
                .ok()
                .and_then(|inv| w.output.as_deref().and_then(|o| inv.output(o)).map(|o| o.scale))
                .unwrap_or(1.0);
            let edges = stream_insets(frame_bounds, fw, fh, scale);
            let mut insets = INSETS.lock().unwrap();
            let map = insets.get_or_insert_with(HashMap::new);
            match edges {
                Some(edges) => {
                    map.insert(w.handle.clone(), edges);
                    bounds = Some(inset(frame_bounds, edges));
                }
                None => {
                    map.remove(&w.handle);
                }
            }
        }
        let base_scale = match (&resolved, bounds) {
            (Resolved::Output(o), _) if o.scale > 0.0 => f64::from(fw) / o.bounds.width.max(1.0),
            (Resolved::Window(_), Some(b)) if driver.bounds_match_stream() => f64::from(fw) / b.width,
            _ => 1.0,
        };
        let (mut info_crop, mut full, mut scale) = (crop, (fw, fh), base_scale);
        if let Some(edge) = edge {
            let (w, h) = fit_within(crop[2], crop[3], edge.max(1));
            if (w, h) != (crop[2], crop[3]) {
                pixels = box_downscale(&pixels, crop[2], crop[3], w, h);
            }
            scale = base_scale * f64::from(w) / f64::from(fw);
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

impl CaptureBackend for NativeCapture {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            backend: match driver_name() {
                Some("mutter") => "native-mutter",
                Some("kwin") => "native-kwin",
                Some("ext") => "native-ext",
                _ => "native",
            },
            enumeration: true,
            system_picker_required: false,
            retained_session: false,
        }
    }
    fn permission(&self) -> &'static str {
        "granted"
    }
    fn request_permission(&self) -> bool {
        true
    }
    fn enumerate(&mut self) -> Result<Vec<Source>> {
        Ok(sources(&inventory_fresh(true)?, std::process::id()))
    }
    fn capture(&mut self, request: &CaptureRequest) -> Result<Frame> {
        self.grab(&request.source_id, request.crop, None, None, false)
    }
    fn capture_after(&mut self, request: &CaptureRequest, after: Instant) -> Result<Frame> {
        self.grab(&request.source_id, request.crop, None, Some(after), false)
    }
    fn thumbnail(&mut self, source_id: &str, edge: u32) -> Result<Frame> {
        self.grab(source_id, None, Some(edge), None, true)
    }
    fn preview(&mut self, request: &CaptureRequest) -> Result<Frame> {
        self.grab(&request.source_id, request.crop, None, None, true)
    }
    fn close(&mut self) {
        self.feeds.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stream_of_the_client_area_narrows_the_frame_to_it() {
        let frame = Rect { x: 3.0, y: 0.0, width: 962.0, height: 588.0 };
        // KWin 6.4 (SteamOS), an XWayland game: 1 px borders and a 28 px title bar.
        let edges = stream_insets(frame, 960, 559, 1.0).expect("client area");
        assert_eq!(edges, [1.0, 28.0, 1.0, 1.0]);
        assert_eq!(inset(frame, edges), Rect { x: 4.0, y: 28.0, width: 960.0, height: 559.0 });
        // The same at scale 2.
        let edges = stream_insets(frame, 1920, 1118, 2.0).expect("client area");
        assert_eq!(edges, [1.0, 28.0, 1.0, 1.0]);
        // KWin 6.7 streams the frame: nothing to narrow.
        assert_eq!(stream_insets(frame, 962, 588, 1.0), None);
        assert_eq!(stream_insets(frame, 1924, 1176, 2.0), None);
        // A stream bigger than the frame, or one that cannot be a client area, is left alone.
        assert_eq!(stream_insets(frame, 1280, 800, 1.0), None);
        assert_eq!(stream_insets(frame, 960, 100, 1.0), None);
    }

    #[test]
    fn the_session_driver_is_tried_first() {
        let names = |d: &str| order(d).into_iter().map(|(n, _)| n).collect::<Vec<_>>();
        assert_eq!(names("GNOME"), ["mutter", "kwin", "ext"]);
        assert_eq!(names("ubuntu:GNOME"), ["mutter", "kwin", "ext"]);
        assert_eq!(names("KDE"), ["kwin", "mutter", "ext"]);
        assert_eq!(names("Hyprland"), ["ext", "mutter", "kwin"]);
        assert_eq!(names(""), ["ext", "mutter", "kwin"]);
    }
}
