//! The desktop integration layer: everything that talks to the operating system's
//! window server, input state, workspace and system settings.
//!
//! One module per OS implements the same set of free functions (the contract below);
//! this module re-exports the one for the build target, so call sites read
//! `platform::cursor()` on every OS. Types and policy shared by every implementation
//! (display descriptions, pointer samples, `clamp_to_visible`, the app origin) live here
//! and are never duplicated per OS.
//!
//! Per-OS contract (every implementation exports exactly these):
//!
//! ```text
//! cursor() -> Option<PointerSample>
//! displays() -> Vec<Rect>
//! display_infos() -> Vec<DisplayInfo>                 // fills `source_id` via display_source_id
//! display_source_id(display_id: u32) -> String
//! with_pool<R>(f: impl FnOnce() -> R) -> R
//! place(&WebviewWindow, Rect) -> Result<(), String>
//! bounds(&WebviewWindow) -> Result<Rect, String>
//! panel_pointer(&WebviewWindow) -> Result<Option<(f64, f64)>, String>
//! panel_cursor(&WebviewWindow, kind: &str) -> Result<(), String>
//! inspect(&WebviewWindow) -> Result<Value, String>
//! order_front(&WebviewWindow) -> Result<(), String>
//! promote_to_key(&WebviewWindow) -> Result<bool, String>
//! set_input_regions(&WebviewWindow, Option<&[Rect]>) -> Result<bool, String>  // optional, see below
//! make_panel(&WebviewWindow) -> Result<bool, String>
//! picker_sources() -> Result<Vec<Source>, String>
//! source_spaces(&[Source]) -> HashMap<String, String>  // off-screen windows' Space/desktop name
//! window_bounds(&SourceId) -> Option<(Rect, bool)>
//! front_window() -> Option<FrontWindow>
//! frontmost_app() -> Option<String>
//! frontmost_pid() -> Option<u32>
//! app_icon_png(&AppIdentity, target: isize) -> Option<Vec<u8>>
//! observe_workspace(on_sleep, on_wake, on_activate)
//! activate_self(prefer: Option<&WebviewWindow>) -> Result<(), String>
//! activate_process(pid: u32) -> Result<(), String>
//! activate_window(&SourceId) -> Result<Value, String> // that window, on its Space/desktop; a report of how
//! window_fullscreen(&SourceId) -> Option<bool>       // the OS's own answer; None: cannot say
//! accessibility_status() -> Option<bool>             // None: no such permission here
//! request_accessibility() -> Result<bool, String>
//! open_capture_settings() -> Result<(), String>
//! run_cli(program, args, stdin, cwd) -> Result<Child, String>
//! capabilities() -> Value
//! ```
//!
//! `set_input_regions` is an optional capability: native per-region click-through.
//! `Some(rects)` (window-local CSS pixels) makes the window take the pointer only inside
//! their union, `None` restores whole-window input, and the result says whether the OS
//! applied a native region. `Ok(true)` (X11 with SHAPE) hands hit-testing to the
//! window server: the cursor poll then stops toggling `set_ignore_cursor_events` for
//! that window. `Ok(false)` (macOS, Windows, Wayland, unsupported) changes nothing and
//! the poll keeps toggling click-through, as before.
//!
//! Geometry in that contract is in the OS's *raw* desktop units (points on macOS,
//! physical pixels on Windows). The rest of the app calls the `desktop_*` wrappers
//! defined here instead (`desktop_cursor`, `desktop_displays`, `desktop_display_infos`,
//! `desktop_bounds`, `desktop_place`, `desktop_window_bounds`, `desktop_picker_sources`,
//! `desktop_frame_info`), which speak *desktop points* — see "desktop geometry" below.
//! On macOS they are the raw calls, unchanged.
use kimochi_capture::Rect;
use serde::Serialize;
use serde_json::{json, Value};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod unsupported;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub use unsupported::*;

/// Keep the WebViews' website data (the dictionary engines' IndexedDB, OPFS and localStorage)
/// from being deleted by the WebView itself. Call once at startup, on the main thread, before any
/// window loads. Answers the evidence record.
///
/// macOS: WebKit's tracking prevention deletes the storage of origins nobody interacts with,
/// which is exactly what the hidden extension windows are (`disable_tracking_prevention`).
/// Windows (WebView2) and Linux (WebKitGTK, where ITP is off unless enabled) have no such expiry.
pub fn keep_website_data() -> Value {
    #[cfg(target_os = "macos")]
    let outcome: Result<bool, String> = macos::disable_tracking_prevention();
    #[cfg(not(target_os = "macos"))]
    let outcome: Result<bool, String> = Ok(true);
    match outcome {
        Ok(off) => json!({ "check": "website-data-retention", "trackingPreventionOff": off }),
        Err(error) => json!({ "check": "website-data-retention", "trackingPreventionOff": false, "error": error }),
    }
}

/// One display, in desktop coordinates (top-left origin).
#[derive(Serialize, Clone, Debug)]
pub struct DisplayInfo {
    pub id: u32,
    /// The complete source id for capturing this display. The UI uses it as is and
    /// never builds one from `id`.
    pub source_id: String,
    pub bounds: Rect,
    /// Excludes the menu bar and Dock, like Electron's `workArea`.
    pub work_area: Rect,
    pub scale_factor: f64,
}

/// The modifier keys held while a cursor sample was taken.
///
/// Yomitan's scan trigger is a modifier, and a modifier is only ever reported to the
/// window that has the keyboard — which, while somebody is reading their game, is
/// their game. Carrying the modifiers alongside the pointer is what lets the scanner
/// behave exactly as it does in a browser without any window having to take focus
/// first. Named as the DOM names them, because that is where they are going.
#[derive(Serialize, Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Modifiers {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

/// Where the pointer is (desktop coordinates), whether the primary button is down,
/// and which modifiers are held, all from one sample.
#[derive(Clone, Copy, Debug)]
pub struct PointerSample {
    pub x: f64,
    pub y: f64,
    pub down: bool,
    pub modifiers: Modifiers,
}

/// The frontmost window of the frontmost application.
///
/// `window` is `None` when that application has no ordinary window on screen (a
/// menu-bar agent, or every window minimised): still an answer about who has focus,
/// matching no real window.
#[derive(Clone, Debug)]
pub struct FrontWindow {
    pub window: Option<kimochi_capture::SourceId>,
    pub pid: u32,
}

/// How a source's application is identified when looking up its icon.
#[derive(Clone, Debug, Default)]
#[allow(dead_code)] // Each OS reads the half it resolves icons by.
pub struct AppIdentity {
    pub name: String,
    /// The owning process, for OSes that resolve icons by executable. macOS matches by
    /// `name` and ignores it.
    pub pid: Option<u32>,
}

/// Keep a rectangle inside a live display's work area, shrinking it first if the
/// display is smaller. Mirrors Electron's `clampBounds`, so an unplugged monitor can
/// never strand a saved window offscreen.
///
/// In desktop points, like every rectangle above the platform boundary (see
/// [`DesktopGeometry`]); on macOS that is the OS's own space, unchanged.
pub fn clamp_to_visible(rect: Rect) -> Rect {
    clamp_within(rect, &desktop_display_infos())
}

// ---------------------------------------------------------------- desktop geometry
//
// The geometry contract (CROSS_PLATFORM_PLAN.md §3.2).
//
// Two coordinate spaces meet at this boundary:
//
//  - **raw desktop units**: what the OS module (`cursor`, `displays`, `display_infos`,
//    `bounds`, `place`, `window_bounds`, `picker_sources`) and capture-core report.
//    macOS: points. Windows: physical virtual-screen pixels (Per-Monitor-V2).
//  - **desktop points**: what the rest of the app — every Rust caller outside
//    `platform`, every event payload, every command argument and result, every page —
//    speaks. One desktop point is one CSS pixel of a page on that display.
//
// On macOS (and the unsupported adapter, whose bounds are already Tauri-logical) the
// two are the same space and every conversion here is the identity: no display is
// queried, no arithmetic happens, payloads are byte-identical.
//
// On Windows each monitor (raw origin `o`, scale `s` = DPI / 96) is given a desktop-point
// origin `O`, and a raw point on it maps to `O + (p - o) / s`. The origins are laid out
// the way Chromium lays out its DIP screen (what `event.screenX` reports in WebView2):
// the monitor at the raw origin (the primary) keeps `(0, 0)`, and a monitor that touches
// one already placed is put against that one's desktop edge, its offset along the shared
// edge divided by the placed monitor's scale. With one scale everywhere this is exactly
// `p / s`, one seamless plane. A monitor touching none falls back to `o / s`.
//
// Mixed DPI caveat: a Windows desktop with monitors at different scales is not one
// uniform CSS plane, and no single mapping can make it one. This one is exact *within* a
// monitor (a page's CSS pixels and desktop points differ only by a translation there),
// keeps touching monitors touching, and is invertible for ordinary layouts, but it is
// discontinuous across monitor edges: moving one physical pixel over a 100 % / 150 %
// boundary moves a different distance in points on either side, and the offset along an
// edge is only exact for the monitor it was measured from. Every conversion picks one
// monitor — the one containing a point (nearest if none), or the one a rectangle
// overlaps most, which is the one Windows assigns a window's DPI from — and converts the
// whole value with it.

/// What one raw desktop unit is.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DesktopUnit {
    /// One raw unit is one CSS pixel on every display (macOS points; the unsupported
    /// adapter's Tauri-logical coordinates). `DisplayInfo::scale_factor` is then a
    /// backing scale (pixels per point) and is never applied to coordinates.
    Points,
    /// One raw unit is one physical pixel (Windows): a CSS pixel on a display is
    /// `scale_factor` raw units. Linux X11 reports root pixels already divided by the
    /// GDK scale, so it is `Points`.
    PhysicalPixels,
}

/// The raw desktop unit of this build's OS module.
pub const fn desktop_unit() -> DesktopUnit {
    if cfg!(target_os = "windows") {
        DesktopUnit::PhysicalPixels
    } else {
        DesktopUnit::Points
    }
}

/// A raw desktop point inside a window, in that window's CSS pixels. `window` is the
/// window's raw bounds and `scale` its raw units per CSS pixel (1 under `Points`).
#[allow(dead_code)] // The pure half of the contract; the app goes through DesktopGeometry.
pub fn desktop_to_window_css(point: (f64, f64), window: Rect, scale: f64) -> (f64, f64) {
    let scale = positive(scale);
    ((point.0 - window.x) / scale, (point.1 - window.y) / scale)
}

/// The inverse of [`desktop_to_window_css`].
#[allow(dead_code)]
pub fn window_css_to_desktop(point: (f64, f64), window: Rect, scale: f64) -> (f64, f64) {
    let scale = positive(scale);
    (window.x + point.0 * scale, window.y + point.1 * scale)
}

/// The scale of the display containing a raw point, or of the nearest display when the
/// point is in no display; 1 with no displays. This is the display's own factor:
/// whether it applies to coordinates is the unit's business ([`DesktopGeometry`]).
#[allow(dead_code)] // Pure contract helper; the app converts through DesktopGeometry.
pub fn scale_for_point(point: (f64, f64), displays: &[DisplayInfo]) -> f64 {
    display_near(point, displays, |d| d.bounds).map_or(1., |d| positive(d.scale_factor))
}

/// The scale of the display a raw rectangle overlaps most (the nearest to its centre
/// when it overlaps none); 1 with no displays.
#[allow(dead_code)] // Pure contract helper; the app converts through DesktopGeometry.
pub fn scale_for_rect(rect: Rect, displays: &[DisplayInfo]) -> f64 {
    display_under(rect, displays, |d| d.bounds).map_or(1., |d| positive(d.scale_factor))
}

fn positive(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0. {
        scale
    } else {
        1.
    }
}

fn contains(r: &Rect, (x, y): (f64, f64)) -> bool {
    x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height
}

fn overlap_area(a: &Rect, b: &Rect) -> f64 {
    let w = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let h = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    w.max(0.) * h.max(0.)
}

fn distance_sq(r: &Rect, (x, y): (f64, f64)) -> f64 {
    let dx = (r.x - x).max(0.).max(x - (r.x + r.width));
    let dy = (r.y - y).max(0.).max(y - (r.y + r.height));
    dx * dx + dy * dy
}

/// The item whose `area` contains `point`, else the nearest one. First wins ties, and
/// displays are listed primary first.
fn display_near<T>(point: (f64, f64), items: &[T], area: impl Fn(&T) -> Rect) -> Option<&T> {
    items
        .iter()
        .find(|d| contains(&area(d), point))
        .or_else(|| {
            items.iter().min_by(|a, b| {
                distance_sq(&area(a), point)
                    .partial_cmp(&distance_sq(&area(b), point))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        })
}

/// The item whose `area` a rectangle overlaps most, else the nearest to its centre.
fn display_under<T>(rect: Rect, items: &[T], area: impl Fn(&T) -> Rect) -> Option<&T> {
    let mut best: Option<(&T, f64)> = None;
    for d in items {
        let shared = overlap_area(&rect, &area(d));
        if shared > 0. && best.is_none_or(|(_, most)| shared > most) {
            best = Some((d, shared));
        }
    }
    best.map(|(d, _)| d).or_else(|| {
        display_near(
            (rect.x + rect.width / 2., rect.y + rect.height / 2.),
            items,
            area,
        )
    })
}

/// Desktop-point origins for raw displays, laid out as described in the section comment.
fn layout_origins(displays: &[DisplayInfo]) -> Vec<(f64, f64)> {
    const EDGE: f64 = 1.; // Raw pixels of slack when deciding two monitors touch.
    let scale = |d: &DisplayInfo| positive(d.scale_factor);
    let mut origins: Vec<Option<(f64, f64)>> = vec![None; displays.len()];
    let root = displays
        .iter()
        .position(|d| contains(&d.bounds, (0., 0.)))
        .unwrap_or(0);
    if let Some(d) = displays.get(root) {
        origins[root] = Some((d.bounds.x / scale(d), d.bounds.y / scale(d)));
    }
    let spans = |a0: f64, a1: f64, b0: f64, b1: f64| a0 < b1 && b0 < a1;
    loop {
        let mut placed_any = false;
        for i in 0..displays.len() {
            if origins[i].is_some() {
                continue;
            }
            let d = &displays[i];
            let b = d.bounds;
            let found = displays.iter().zip(&origins).find_map(|(p, origin)| {
                let (px, py) = (*origin)?;
                let (pb, ps) = (p.bounds, scale(p));
                let vertical = spans(b.y, b.y + b.height, pb.y, pb.y + pb.height);
                let horizontal = spans(b.x, b.x + b.width, pb.x, pb.x + pb.width);
                let along_y = py + (b.y - pb.y) / ps;
                let along_x = px + (b.x - pb.x) / ps;
                if vertical && (b.x - (pb.x + pb.width)).abs() <= EDGE {
                    Some((px + pb.width / ps, along_y))
                } else if vertical && ((b.x + b.width) - pb.x).abs() <= EDGE {
                    Some((px - b.width / scale(d), along_y))
                } else if horizontal && (b.y - (pb.y + pb.height)).abs() <= EDGE {
                    Some((along_x, py + pb.height / ps))
                } else if horizontal && ((b.y + b.height) - pb.y).abs() <= EDGE {
                    Some((along_x, py - b.height / scale(d)))
                } else {
                    None
                }
            });
            if found.is_some() {
                origins[i] = found;
                placed_any = true;
            }
        }
        if !placed_any {
            break;
        }
    }
    displays
        .iter()
        .zip(origins)
        .map(|(d, origin)| origin.unwrap_or((d.bounds.x / scale(d), d.bounds.y / scale(d))))
        .collect()
}

/// One raw display and where it sits in desktop points.
#[derive(Clone, Debug)]
struct Placed {
    info: DisplayInfo,
    /// Desktop-point origin of `info.bounds`.
    origin: (f64, f64),
}

impl Placed {
    fn scale(&self) -> f64 {
        positive(self.info.scale_factor)
    }

    fn raw(&self) -> Rect {
        self.info.bounds
    }

    /// The display's bounds in desktop points.
    fn points(&self) -> Rect {
        self.rect_to_points(self.info.bounds)
    }

    fn to_points(&self, (x, y): (f64, f64)) -> (f64, f64) {
        let (s, b) = (self.scale(), self.info.bounds);
        (self.origin.0 + (x - b.x) / s, self.origin.1 + (y - b.y) / s)
    }

    fn to_raw(&self, (x, y): (f64, f64)) -> (f64, f64) {
        let (s, b) = (self.scale(), self.info.bounds);
        (b.x + (x - self.origin.0) * s, b.y + (y - self.origin.1) * s)
    }

    fn rect_to_points(&self, r: Rect) -> Rect {
        let (x, y) = self.to_points((r.x, r.y));
        Rect {
            x,
            y,
            width: r.width / self.scale(),
            height: r.height / self.scale(),
        }
    }

    fn rect_to_raw(&self, r: Rect) -> Rect {
        let (x, y) = self.to_raw((r.x, r.y));
        Rect {
            x,
            y,
            width: r.width * self.scale(),
            height: r.height * self.scale(),
        }
    }
}

/// Converts between raw desktop units and desktop points for one snapshot of the
/// display layout. See the section comment above for the contract.
#[derive(Clone, Debug)]
pub struct DesktopGeometry {
    unit: DesktopUnit,
    /// Raw display descriptions, as the OS module reports them, with their layout.
    displays: Vec<Placed>,
}

impl DesktopGeometry {
    pub fn new(unit: DesktopUnit, displays: Vec<DisplayInfo>) -> Self {
        let displays = match unit {
            DesktopUnit::Points => displays
                .into_iter()
                .map(|info| Placed {
                    origin: (info.bounds.x, info.bounds.y),
                    info,
                })
                .collect(),
            DesktopUnit::PhysicalPixels => {
                let origins = layout_origins(&displays);
                displays
                    .into_iter()
                    .zip(origins)
                    .map(|(info, origin)| Placed { info, origin })
                    .collect()
            }
        };
        Self { unit, displays }
    }

    /// This OS's unit and live layout. Under `Points` no display is queried.
    pub fn current() -> Self {
        let unit = desktop_unit();
        let displays = match unit {
            DesktopUnit::Points => Vec::new(),
            DesktopUnit::PhysicalPixels => display_infos(),
        };
        Self::new(unit, displays)
    }

    /// Whether every conversion is the identity.
    pub fn is_identity(&self) -> bool {
        self.unit == DesktopUnit::Points || self.displays.is_empty()
    }

    fn at_raw_point(&self, raw: (f64, f64)) -> Option<&Placed> {
        display_near(raw, &self.displays, Placed::raw)
    }

    fn under_raw_rect(&self, raw: Rect) -> Option<&Placed> {
        display_under(raw, &self.displays, Placed::raw)
    }

    /// Raw units per desktop point at a raw point (1 under `Points`).
    #[allow(dead_code)]
    pub fn scale_for_point(&self, raw: (f64, f64)) -> f64 {
        if self.is_identity() {
            return 1.;
        }
        self.at_raw_point(raw).map_or(1., Placed::scale)
    }

    /// Raw units per desktop point for a raw rectangle (1 under `Points`).
    #[allow(dead_code)]
    pub fn scale_for_rect(&self, raw: Rect) -> f64 {
        if self.is_identity() {
            return 1.;
        }
        self.under_raw_rect(raw).map_or(1., Placed::scale)
    }

    pub fn point_to_desktop(&self, raw: (f64, f64)) -> (f64, f64) {
        if self.is_identity() {
            return raw;
        }
        self.at_raw_point(raw).map_or(raw, |d| d.to_points(raw))
    }

    #[allow(dead_code)]
    pub fn point_from_desktop(&self, point: (f64, f64)) -> (f64, f64) {
        if self.is_identity() {
            return point;
        }
        display_near(point, &self.displays, Placed::points).map_or(point, |d| d.to_raw(point))
    }

    pub fn rect_to_desktop(&self, raw: Rect) -> Rect {
        if self.is_identity() {
            return raw;
        }
        self.under_raw_rect(raw)
            .map_or(raw, |d| d.rect_to_points(raw))
    }

    pub fn rect_from_desktop(&self, rect: Rect) -> Rect {
        if self.is_identity() {
            return rect;
        }
        display_under(rect, &self.displays, Placed::points).map_or(rect, |d| d.rect_to_raw(rect))
    }

    /// Every display in desktop points (see [`Self::display_to_desktop`]).
    pub fn desktop_displays(&self) -> Vec<DisplayInfo> {
        self.displays
            .iter()
            .map(|d| self.display_to_desktop(&d.info))
            .collect()
    }

    /// A display in desktop points. `scale_factor` stays the display's own (physical
    /// pixels per desktop point), which is what the UI multiplies points by to get
    /// capture pixels — on macOS the Retina backing scale, on Windows the DPI scale.
    pub fn display_to_desktop(&self, d: &DisplayInfo) -> DisplayInfo {
        if self.is_identity() {
            return d.clone();
        }
        // Its own transform, found by id; an unknown display converts as a rectangle.
        match self.displays.iter().find(|p| p.info.id == d.id) {
            Some(placed) => DisplayInfo {
                bounds: placed.rect_to_points(d.bounds),
                work_area: placed.rect_to_points(d.work_area),
                ..d.clone()
            },
            None => DisplayInfo {
                bounds: self.rect_to_desktop(d.bounds),
                work_area: self.rect_to_desktop(d.work_area),
                ..d.clone()
            },
        }
    }

    /// A frame's description for the UI: `source_bounds` in desktop points and
    /// `scale_factor` in frame pixels per desktop point, so "frame pixel → desktop
    /// point" is `source_bounds.width / full_width` on every OS. Pixel fields (`width`,
    /// `full_*`, `crop_pixels`) are untouched: they describe the frame, not the desktop.
    pub fn frame_info_to_desktop(
        &self,
        info: &kimochi_capture::FrameInfo,
    ) -> kimochi_capture::FrameInfo {
        let mut out = info.clone();
        if self.is_identity() {
            return out;
        }
        if let Some(raw) = info.source_bounds {
            if let Some(d) = self.under_raw_rect(raw) {
                out.source_bounds = Some(d.rect_to_points(raw));
                out.scale_factor = info.scale_factor * d.scale();
            }
        }
        out
    }

    /// A capture source with its bounds in desktop points.
    pub fn source_to_desktop(&self, source: kimochi_capture::Source) -> kimochi_capture::Source {
        kimochi_capture::Source {
            bounds: source.bounds.map(|b| self.rect_to_desktop(b)),
            ..source
        }
    }
}

// Thin wrappers: the OS module's geometry, in desktop points. On macOS each is exactly
// the raw call. Callers outside `platform` use these, never the raw ones.

/// `cursor()` in desktop points.
pub fn desktop_cursor() -> Option<PointerSample> {
    let sample = cursor()?;
    if desktop_unit() == DesktopUnit::Points {
        return Some(sample);
    }
    let (x, y) = DesktopGeometry::current().point_to_desktop((sample.x, sample.y));
    Some(PointerSample { x, y, ..sample })
}

/// `displays()` (display bounds) in desktop points.
pub fn desktop_displays() -> Vec<Rect> {
    if desktop_unit() == DesktopUnit::Points {
        return displays();
    }
    desktop_display_infos()
        .into_iter()
        .map(|d| d.bounds)
        .collect()
}

/// `display_infos()` with bounds and work areas in desktop points.
pub fn desktop_display_infos() -> Vec<DisplayInfo> {
    if desktop_unit() == DesktopUnit::Points {
        return display_infos();
    }
    DesktopGeometry::current().desktop_displays()
}

/// `bounds(window)` in desktop points.
pub fn desktop_bounds(w: &tauri::WebviewWindow) -> Result<Rect, String> {
    let raw = bounds(w)?;
    Ok(DesktopGeometry::current().rect_to_desktop(raw))
}

/// `place(window, rect)` with `rect` in desktop points. Main thread, as `place`.
pub fn desktop_place(w: &tauri::WebviewWindow, rect: Rect) -> Result<(), String> {
    place(w, DesktopGeometry::current().rect_from_desktop(rect))
}

/// `window_bounds(id)` in desktop points.
pub fn desktop_window_bounds(id: &kimochi_capture::SourceId) -> Option<(Rect, bool)> {
    let (raw, on_screen) = window_bounds(id)?;
    Some((DesktopGeometry::current().rect_to_desktop(raw), on_screen))
}

/// `picker_sources()` with bounds in desktop points.
pub fn desktop_picker_sources() -> Result<Vec<kimochi_capture::Source>, String> {
    let sources = picker_sources()?;
    let geometry = DesktopGeometry::current();
    Ok(sources
        .into_iter()
        .map(|s| geometry.source_to_desktop(s))
        .collect())
}

/// A capture frame's description for the UI (see
/// [`DesktopGeometry::frame_info_to_desktop`]).
pub fn desktop_frame_info(info: &kimochi_capture::FrameInfo) -> kimochi_capture::FrameInfo {
    DesktopGeometry::current().frame_info_to_desktop(info)
}

// ---------------------------------------------------------------- full screen
//
// A window that fills its display is read like a display: nothing to outline on hover (the
// outline would be the whole screen), a crop of its own (see `state::shaped_crop_key`), and
// on macOS a Space of its own that the window server animates it into and out of.

/// What the source watch knows about the tracked window, in desktop points.
#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    /// Where the window is; while `settling`, where it was last at rest.
    pub bounds: Rect,
    pub on_screen: bool,
    /// The window fills its display: a full-screen app, or a borderless full-screen window.
    pub fullscreen: bool,
    /// A full-screen window that is not where full screen puts it. macOS slides a full-screen
    /// app's Space in and out when the reader switches Spaces, and the window server reports
    /// every step of the slide as the window's bounds: followed at the watch's rate, text
    /// crawled across the screen behind the picture, and the overlay hopped displays when the
    /// window's centre crossed one. Text is hidden until the window is at rest again.
    pub settling: bool,
    /// The display the window fills, when it fills one.
    pub display: Option<Rect>,
}

impl WindowState {
    /// Whether the overlay and its text would draw differently: what the watch announces.
    pub fn differs(&self, other: &WindowState) -> bool {
        let moved = |a: &Rect, b: &Rect| {
            (a.x - b.x).abs() > 0.5
                || (a.y - b.y).abs() > 0.5
                || (a.width - b.width).abs() > 0.5
                || (a.height - b.height).abs() > 0.5
        };
        moved(&self.bounds, &other.bounds)
            || self.on_screen != other.on_screen
            || self.fullscreen != other.fullscreen
            || self.settling != other.settling
    }
}

/// The window covers the whole display (a borderless full-screen window), and is on it.
pub fn covers_display(window: Rect, display: Rect) -> bool {
    const SLACK: f64 = 1.;
    window.width > 0.
        && window.height > 0.
        && display.width > 0.
        && display.height > 0.
        && window.x <= display.x + SLACK
        && window.y <= display.y + SLACK
        && window.x + window.width >= display.x + display.width - SLACK
        && window.y + window.height >= display.y + display.height - SLACK
        && centred_on(window, display)
}

/// Where a full-screen app's window is at rest: the whole display, or on a MacBook with a
/// notch, the display below the camera housing (the menu bar's height). Only asked of windows
/// the OS says are full screen: a zoomed window under the menu bar would also pass it.
fn rests_full_screen(window: Rect, display: Rect) -> bool {
    const SLACK: f64 = 1.;
    const TOP_INSET: f64 = 48.;
    window.width > 0.
        && display.width > 0.
        && (window.x - display.x).abs() <= SLACK
        && (window.width - display.width).abs() <= SLACK
        && (window.y + window.height - display.y - display.height).abs() <= SLACK
        && window.y >= display.y - SLACK
        && window.y <= display.y + TOP_INSET
}

fn centred_on(window: Rect, display: Rect) -> bool {
    let (cx, cy) = (window.x + window.width / 2., window.y + window.height / 2.);
    cx >= display.x && cx < display.x + display.width && cy >= display.y && cy < display.y + display.height
}

/// One sample of the tracked window, from its bounds, whether it is on screen, the OS's own
/// answer to "is it full screen" (`None`: the OS cannot say), the displays, and the previous
/// sample (whose bounds a settling window keeps).
pub fn window_state(
    bounds: Rect,
    on_screen: bool,
    native_fullscreen: Option<bool>,
    displays: &[Rect],
    previous: Option<&WindowState>,
) -> WindowState {
    let covered = displays.iter().copied().find(|d| covers_display(bounds, *d));
    let resting = displays.iter().copied().find(|d| rests_full_screen(bounds, *d));
    let native = native_fullscreen == Some(true);
    // Away from where full screen puts it: in an animation, or slid off with its Space. Either
    // way its place is the one it last rested at; it is only settling while it is on screen.
    // Only an exact fit counts for it: mid-slide, an ultrawide window can cover a smaller
    // display beside its own.
    if native && resting.is_none() {
        return WindowState {
            bounds: previous.map_or(bounds, |p| p.bounds),
            on_screen,
            fullscreen: true,
            settling: on_screen,
            display: previous.and_then(|p| p.display),
        };
    }
    WindowState {
        bounds,
        on_screen,
        fullscreen: native || covered.is_some(),
        settling: false,
        display: if native { resting } else { covered },
    }
}

/// `window_state` for a source, in desktop points; `None` when the window is gone.
pub fn desktop_window_state(
    id: &kimochi_capture::SourceId,
    previous: Option<&WindowState>,
) -> Option<WindowState> {
    let (bounds, on_screen) = desktop_window_bounds(id)?;
    let native = window_fullscreen(id);
    let displays = desktop_displays();
    let state = window_state(bounds, on_screen, native, &displays, previous);
    #[cfg(target_os = "windows")]
    let state = windows_native_state(state, bounds, native, &displays);
    Some(state)
}

// The Windows caption check explicitly rejects maximized normal windows. Do not
// override that answer with geometry, or mistake an oversized capture for a Space animation.
#[cfg(target_os = "windows")]
fn windows_native_state(mut state: WindowState, bounds: Rect, native: Option<bool>, displays: &[Rect]) -> WindowState {
    state.bounds = bounds;
    state.fullscreen = native.unwrap_or(state.fullscreen);
    state.settling = false;
    state.display = state.fullscreen.then(|| displays.iter().copied().find(|display| covers_display(bounds, *display))).flatten();
    state
}

fn clamp_within(rect: Rect, screens: &[DisplayInfo]) -> Rect {
    if screens.is_empty() {
        return rect;
    }
    let overlap = |a: &Rect, b: &Rect| {
        let w = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
        let h = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
        w.max(0.0) * h.max(0.0)
    };
    let area = screens
        .iter()
        .max_by(|a, b| {
            overlap(&rect, &a.work_area)
                .partial_cmp(&overlap(&rect, &b.work_area))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|s| s.work_area)
        .unwrap();
    let width = rect.width.min(area.width);
    let height = rect.height.min(area.height);
    Rect {
        width,
        height,
        x: rect.x.max(area.x).min(area.x + area.width - width),
        y: rect.y.max(area.y).min(area.y + area.height - height),
    }
}

/// The frontmost process id, but only if `name` is still the frontmost application.
///
/// A foreground event names an application; the pid is read separately and later. When
/// the two disagree the event is stale (the reader has already switched again), and
/// pairing the old name with the new pid would tell the UI's own-window check that the
/// game is Kimochi or Kimochi is the game. No pid is the honest answer then: the UI
/// falls back to the name, as it always did.
pub fn frontmost_pid_for(name: &str) -> Option<u32> {
    let current = frontmost_app()?;
    (current == name).then(frontmost_pid).flatten()
}

/// Whether Kimochi's own window frames (`desktop_bounds`) say where those windows really
/// are on screen, so `cover` can tell one that is off the scanned text from one over it.
///
/// True on macOS and Windows. On Linux only on a plain X11 desktop: Wayland never says
/// where a window is (a frame there is always at the origin), and gamescope — Steam Deck's
/// Gaming Mode — composites the focused application over the game whatever its X11 frame
/// says. Where this is false any visible Kimochi window counts as covering the text, which
/// is the behaviour from before the rule existed.
#[cfg(target_os = "linux")]
pub fn own_frames_reliable() -> bool {
    use std::sync::OnceLock;
    static GAMESCOPE_SESSION: OnceLock<bool> = OnceLock::new();
    let gamescope_session = *GAMESCOPE_SESSION.get_or_init(|| {
        std::env::var("XDG_CURRENT_DESKTOP")
            .is_ok_and(|d| d.split(':').any(|name| name.eq_ignore_ascii_case("gamescope")))
            || std::env::var_os("GAMESCOPE_WAYLAND_DISPLAY").is_some()
    });
    linux::x11_session() && !gamescope_session && !gamescope::active()
}

/// See the Linux version: macOS and Windows always report real window frames.
#[cfg(not(target_os = "linux"))]
pub fn own_frames_reliable() -> bool {
    true
}

/// Whether the pointer arriving on the dictionary may take the keyboard. True only
/// where a window can become key without activating the application (an AppKit
/// non-activating panel). Elsewhere `promote_to_key` activates Kimochi, so it is
/// reserved for the explicit editing action the reader asks for.
pub const HOVER_PROMOTES_KEY: bool = cfg!(target_os = "macos");

/// Whether this OS's webview serves custom schemes as `http://<scheme>.localhost`.
/// Tauri does that only on Windows (WebView2) and Android; WKWebView and WebKitGTK
/// serve the custom scheme as is (`tauri-2.11.5/src/pattern.rs::format_real_schema`).
const HTTP_SCHEME_BRIDGE: bool = cfg!(any(target_os = "windows", target_os = "android"));

/// Whether a custom-scheme document may ask for cross-origin isolation (COOP/COEP), which
/// Hachidori needs for its threaded engine. No webview gives a scheme page what that engine needs:
///
/// - WebKit (WKWebView, WebKitGTK) keeps every load made by a URL scheme handler out of an
///   isolated browsing context group (`WebPageProxy::browsingContextGroupForNavigation`: "These
///   loads skip COOP enforcement, so they cannot stay cross-origin isolated") and refuses to post
///   shared memory to a worker (DataCloneError).
/// - WebView2 does isolate `http://<scheme>.localhost`, but a worker started from a worker gets
///   no response from it (`WebResourceRequested` never sees that request): Hachidori's pthreads
///   are such workers, so its engine never finished starting (the Windows 11 VM, 2026-10-23).
///
/// So the scheme sends no isolation headers anywhere, and Hachidori is served from a loopback
/// HTTP origin instead (`loopback.rs`), which every one of them isolates.
pub const CROSS_ORIGIN_ISOLATION: bool = false;

/// `KIMOCHI_HACHIDORI_THREADS=0`: Hachidori imports on one thread, as before: its storage is not
/// moved to the loopback origin (`loopback.rs`; no effect once it has been).
pub fn hachidori_threads_allowed() -> bool {
    static ALLOWED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ALLOWED.get_or_init(|| std::env::var("KIMOCHI_HACHIDORI_THREADS").as_deref() != Ok("0"))
}

/// The origin Kimochi's own pages are served from.
pub fn app_origin() -> &'static str {
    if HTTP_SCHEME_BRIDGE {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
}

/// Whether a navigation target is one of Kimochi's own pages (bundled build origin).
pub fn is_app_url(url: &tauri::Url) -> bool {
    has_origin(url, app_origin())
}

/// The origin a dictionary extension (`hachidori`, `tenten`) is served from this session: its
/// custom scheme ([`scheme_origin`]), except Hachidori on macOS and Linux once its storage lives
/// on the loopback origin (`loopback.rs`, `http://127.0.0.1:<port>`), where WebKit can
/// cross-origin isolate it.
pub fn extension_origin(id: &str) -> String {
    crate::loopback::origin(id).unwrap_or_else(|| scheme_origin(id))
}

/// The custom-scheme origin of a dictionary extension, registered in `main.rs`
/// (DICTIONARY_ENGINES.md §4). Like the app origin, WebView2 reaches it through Tauri's HTTP
/// bridge as `http://<id>.localhost`.
pub fn scheme_origin(id: &str) -> String {
    if HTTP_SCHEME_BRIDGE {
        format!("http://{id}.localhost")
    } else {
        format!("{id}://localhost")
    }
}

/// Whether a navigation target is on one of the dictionary extensions' origins.
pub fn is_extension_url(url: &tauri::Url) -> bool {
    crate::extensions::IDS
        .iter()
        .any(|id| is_extension_url_of(url, id))
}

/// Whether a navigation target is on the origin of the extension `id` exactly: the
/// allowlist of that engine's hidden extension window (`ext-<id>`).
pub fn is_extension_url_of(url: &tauri::Url, id: &str) -> bool {
    match crate::loopback::origin(id) {
        Some(_) => crate::loopback::is_loopback_url(url),
        None => has_origin(url, &scheme_origin(id)),
    }
}

fn has_origin(url: &tauri::Url, origin: &str) -> bool {
    let (scheme, host) = origin.split_once("://").unwrap_or((origin, ""));
    url.scheme() == scheme && url.host_str() == Some(host) && url.port().is_none()
}

/// An initialization script defining `window.__KIMOCHI_PLATFORM__ = {os, arch, debug}`.
/// Registered first on every webview, before the Yomitan shims (`dist/spike/shim.js`, `panel-shim.js`), which
/// read it for Yomitan's `getPlatformInfo` instead of sniffing the user agent. `debug` is
/// true in a debug build (`tauri dev` or `npm run bundle`): a debug bundle loads a `vite build`,
/// so this, not `import.meta.env.DEV`, is how its pages tell a local build from a release.
pub fn platform_prelude() -> String {
    let info = json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "debug": cfg!(debug_assertions)
    });
    format!(";(function(){{try{{window.__KIMOCHI_PLATFORM__={info};}}catch(e){{}}}})();\n")
}

/// A URL on the `capture:` protocol, as a page loads it on this OS.
pub fn capture_url(path: &str) -> String {
    let path = path.trim_start_matches('/');
    if HTTP_SCHEME_BRIDGE {
        format!("http://capture.localhost/{path}")
    } else {
        format!("capture://localhost/{path}")
    }
}

/// The single-instance startup report, for the app log. Only macOS coordinates
/// instances itself (`macos::instance`); elsewhere `tauri-plugin-single-instance` does.
pub fn instance_report() -> Option<Value> {
    #[cfg(target_os = "macos")]
    {
        macos::instance::report()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Spawn a prepared command with stdout/stderr piped and `stdin` (if any) written on a
/// helper thread and then closed, so a large prompt cannot deadlock against a full pipe.
#[allow(dead_code)] // Not every OS module uses it.
pub(crate) fn spawn_cli(
    mut command: std::process::Command,
    stdin: Option<&str>,
) -> Result<std::process::Child, String> {
    use std::io::Write;
    use std::process::Stdio;
    command
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let text = text.to_string();
        std::thread::spawn(move || {
            let _ = pipe.write_all(text.as_bytes());
        });
    }
    Ok(child)
}

/// Deep-merge `overlay` into `base`: objects merge key by key, anything else replaces.
fn merge(base: &mut Value, overlay: Value) {
    match (base, overlay) {
        (Value::Object(base), Value::Object(overlay)) => {
            for (key, value) in overlay {
                merge(base.entry(key).or_insert(Value::Null), value);
            }
        }
        (base, overlay) => *base = overlay,
    }
}

/// Everything `platform_capabilities` reports that is not owned by the OS module.
pub struct DynamicCapabilities {
    /// The capture backend's `permission()`.
    pub capture_permission: String,
    /// The capture backend's `capabilities()`.
    pub capture: kimochi_capture::Capabilities,
    /// Why capture is unavailable, when the backend could not be created.
    pub capture_reason: Option<String>,
    pub observer: Value,
    /// `(available, reason)` for the bundled MeikiOCR runtime and models.
    pub meikiocr: (bool, Option<String>),
    /// `(available, reason)` for the bundled Manga OCR models.
    pub mangaocr: (bool, Option<String>),
    pub ppocr: (bool, Option<String>),
}

/// The full `platform_capabilities` payload (see CROSS_PLATFORM_PLAN.md §3.3).
///
/// Conservative defaults first, then the OS module's `capabilities()` merged over them,
/// then the live values only the app knows (capture permission, OCR assets,
/// the observer, our own pid). An OS module only has to report what it supports.
pub fn capabilities_payload(dynamic: DynamicCapabilities) -> Value {
    let mut payload = json!({
        "os": std::env::consts::OS,
        "osVersion": "",
        "arch": std::env::consts::ARCH,
        "keys": {"primaryModifier": "ctrl", "labels": "words", "superName": "Super"},
        "capture": {
            "authorization": "unsupported",
            "canOpenSettings": false,
            "restartAfterGrant": false,
            "pickerRequired": false,
            "windowCapture": false,
            "excludesOwnWindows": false,
        },
        "sources": {
            "catalog": false,
            "thumbnails": false,
            "icons": false,
            "followWindowBounds": false,
            "foregroundTracking": false,
        },
        "overlay": {
            "passive": false,
            "inputRegions": "wholeWindowOnly",
            "nonActivating": false,
            "nativeHoverWorkaround": false,
        },
        "input": {"globalShortcuts": false},
        "ownAppNames": ["Kimochi", "kimochi"],
        "tray": false,
        "gamepad": false,
    });
    merge(&mut payload, capabilities());
    let accelerators = payload
        .as_object_mut()
        .and_then(|o| o.remove("ocrAccelerators"))
        .unwrap_or(Value::Null);
    if dynamic.capture.backend == "none" {
        payload["capture"]["authorization"] = json!("unsupported");
        payload["capture"]["windowCapture"] = json!(false);
        payload["capture"]["canOpenSettings"] = json!(false);
        payload["capture"]["restartAfterGrant"] = json!(false);
    } else {
        payload["capture"]["authorization"] = json!(match dynamic.capture_permission.as_str() {
            "granted" => "granted",
            "notRequired" | "not-required" => "notRequired",
            "promptOnSelect" | "prompt-on-select" => "promptOnSelect",
            "unsupported" => "unsupported",
            _ => "denied",
        });
        payload["capture"]["pickerRequired"] = json!(dynamic.capture.system_picker_required);
    }
    payload["capture"]["reason"] = json!(dynamic.capture_reason);
    let engine = |(available, reason): (bool, Option<String>), accelerator: &Value| {
        let mut entry = json!({ "available": available });
        if available && accelerator.is_string() {
            entry["accelerator"] = accelerator.clone();
        }
        if let Some(reason) = reason {
            entry["reason"] = json!(reason);
        }
        entry
    };
    payload["ocrEngines"] = json!({
        "googlelens": {"available": true},
        "cloud": {"available": true},
        "meikiocr": engine(dynamic.meikiocr, &accelerators["meikiocr"]),
        "mangaocr": engine(dynamic.mangaocr, &accelerators["mangaocr"]),
        "ppocr": engine(dynamic.ppocr, &accelerators["ppocr"]),
    });
    payload["observer"] = dynamic.observer;
    payload["ownPids"] = json!([std::process::id()]);
    payload
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_caption_rejection_and_oversized_fullscreen_are_not_space_transitions() {
        let bounds = super::Rect { x: 0., y: 0., width: 1920., height: 1080. };
        let initial = super::window_state(bounds, true, Some(false), &[bounds], None);
        assert!(initial.fullscreen);
        let corrected = super::windows_native_state(initial, bounds, Some(false), &[bounds]);
        assert!(!corrected.fullscreen);
        let oversized = super::Rect { height: 1120., ..bounds };
        let initial = super::window_state(oversized, true, Some(true), &[bounds], None);
        let corrected = super::windows_native_state(initial, oversized, Some(true), &[bounds]);
        assert!(corrected.fullscreen);
        assert!(!corrected.settling);
        assert_eq!((corrected.bounds.x, corrected.bounds.y, corrected.bounds.width, corrected.bounds.height),
            (oversized.x, oversized.y, oversized.width, oversized.height));
    }
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    const ULTRAWIDE: Rect = Rect { x: 1728., y: 0., width: 3440., height: 1440. };
    const LAPTOP: Rect = Rect { x: 0., y: 0., width: 1728., height: 1117. };

    #[test]
    fn a_window_filling_its_display_is_full_screen_without_the_os_saying_so() {
        let state = window_state(ULTRAWIDE, true, None, &[LAPTOP, ULTRAWIDE], None);
        assert!(state.fullscreen && !state.settling);
        assert_eq!(state.display.unwrap().x, 1728.);
        let window = window_state(rect(1900., 100., 1200., 900.), true, None, &[LAPTOP, ULTRAWIDE], None);
        assert!(!window.fullscreen && window.display.is_none());
        // A zoomed window under the menu bar is not full screen unless the OS says it is.
        let zoomed = window_state(rect(0., 38., 1728., 1079.), true, None, &[LAPTOP], None);
        assert!(!zoomed.fullscreen);
        let notch = window_state(rect(0., 38., 1728., 1079.), true, Some(true), &[LAPTOP], None);
        assert!(notch.fullscreen && !notch.settling, "a full-screen app below the notch is at rest");
    }

    #[test]
    fn a_full_screen_window_sliding_between_spaces_keeps_its_place() {
        // Recorded on macOS: switching Spaces reports the window at each step of the slide.
        let rest = window_state(ULTRAWIDE, true, Some(true), &[LAPTOP, ULTRAWIDE], None);
        for x in [1808., 4910., 5227., -1258., 478.] {
            let step = window_state(rect(x, 0., 3440., 1440.), true, Some(true), &[LAPTOP, ULTRAWIDE], Some(&rest));
            assert!(step.settling && step.fullscreen, "x = {x}");
            assert_eq!(step.bounds.x, 1728., "the text stays put while x = {x}");
            assert!(step.differs(&rest), "settling is announced");
        }
        // Off its Space it is not shown at all, which is not settling.
        let away = window_state(rect(5227., 0., 3440., 1440.), false, Some(true), &[LAPTOP, ULTRAWIDE], Some(&rest));
        assert!(!away.settling);
        assert_eq!(away.bounds.x, 1728., "nor does it move once off screen");
        let back = window_state(ULTRAWIDE, true, Some(true), &[LAPTOP, ULTRAWIDE], Some(&rest));
        assert!(!back.settling && !back.differs(&rest));
    }

    #[test]
    fn clamp_is_identity_without_displays() {
        let r = rect(10., 20., 30., 40.);
        let clamped = clamp_within(r, &[]);
        assert_eq!((clamped.width, clamped.height), (30., 40.));
        assert_eq!((clamped.x, clamped.y), (10., 20.));
    }

    #[test]
    fn clamp_pulls_a_stranded_window_onto_the_display_it_overlaps_most() {
        let screen = |x: f64| DisplayInfo {
            id: 1,
            source_id: String::new(),
            bounds: rect(x, 0., 1000., 800.),
            work_area: rect(x, 25., 1000., 775.),
            scale_factor: 2.,
        };
        let clamped = clamp_within(rect(1900., -50., 300., 200.), &[screen(0.), screen(1000.)]);
        assert_eq!((clamped.x, clamped.y), (1700., 25.));
        let shrunk = clamp_within(rect(0., 0., 5000., 5000.), &[screen(0.)]);
        assert_eq!((shrunk.width, shrunk.height), (1000., 775.));
    }

    #[test]
    fn app_origin_and_capture_urls_match_the_webview() {
        if cfg!(target_os = "windows") {
            assert_eq!(app_origin(), "http://tauri.localhost");
            assert_eq!(capture_url("live/7"), "http://capture.localhost/live/7");
            assert!(is_app_url(&"http://tauri.localhost/ui/overlay.html".parse().unwrap()));
        } else {
            // macOS and Linux (WKWebView, WebKitGTK) keep the custom scheme.
            assert_eq!(app_origin(), "tauri://localhost");
            assert_eq!(capture_url("preview/3"), "capture://localhost/preview/3");
            assert!(is_app_url(&"tauri://localhost/ui/overlay.html".parse().unwrap()));
            assert!(!is_app_url(&"https://localhost/".parse().unwrap()));
        }
    }

    #[test]
    fn extension_origins_match_the_webview() {
        let url = |s: &str| -> tauri::Url { s.parse().unwrap() };
        if cfg!(target_os = "windows") {
            assert_eq!(extension_origin("hachidori"), "http://hachidori.localhost");
            assert_eq!(extension_origin("tenten"), "http://tenten.localhost");
            assert!(is_extension_url(&url("http://hachidori.localhost/settings.html")));
            assert!(is_extension_url(&url("http://tenten.localhost/__kimochi/ext-background.html?engine=tenten")));
            assert!(!is_extension_url(&url("hachidori://localhost/settings.html")));
        } else {
            assert_eq!(extension_origin("hachidori"), "hachidori://localhost");
            assert_eq!(extension_origin("tenten"), "tenten://localhost");
            assert!(is_extension_url(&url("hachidori://localhost/settings.html")));
            assert!(is_extension_url(&url("tenten://localhost/options.html#general")));
            assert!(!is_extension_url(&url("http://hachidori.localhost/settings.html")));
        }
        // The app origin, other schemes and look-alike hosts are not extension origins,
        // and an extension origin is not the app origin.
        assert!(!is_extension_url(&url(&format!("{}/ui/overlay.html", app_origin()))));
        assert!(!is_app_url(&url(&format!("{}/settings.html", extension_origin("hachidori")))));
        assert!(!is_extension_url(&url("capture://localhost/live/1")));
        assert!(!is_extension_url(&url("yomitan://localhost/settings.html")));
        assert!(!is_extension_url(&url("hachidori://evil.example/settings.html")));
        assert!(!is_extension_url(&url("http://hachidori.localhost:1440/settings.html")));
        assert!(!is_extension_url(&url("https://hachidori.localhost/settings.html")));
        // One engine's window allows its own origin only.
        let hachidori = url(&format!("{}/offscreen.html", extension_origin("hachidori")));
        assert!(is_extension_url_of(&hachidori, "hachidori"));
        assert!(!is_extension_url_of(&hachidori, "tenten"));
        assert!(!is_extension_url_of(&url(&format!("{}/ui/overlay.html", app_origin())), "hachidori"));
    }

    fn display(id: u32, bounds: Rect, scale: f64) -> DisplayInfo {
        DisplayInfo {
            id,
            source_id: format!("test:display:{id}"),
            bounds,
            work_area: Rect {
                height: bounds.height - 48. * scale,
                ..bounds
            },
            scale_factor: scale,
        }
    }

    fn windows(displays: Vec<DisplayInfo>) -> DesktopGeometry {
        DesktopGeometry::new(DesktopUnit::PhysicalPixels, displays)
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn assert_rect(actual: Rect, expected: (f64, f64, f64, f64)) {
        let (x, y, w, h) = expected;
        assert!(
            close(actual.x, x) && close(actual.y, y) && close(actual.width, w) && close(actual.height, h),
            "{actual:?} != {expected:?}"
        );
    }

    fn frame_info(source_bounds: Option<Rect>, full: (u32, u32), scale: f64) -> kimochi_capture::FrameInfo {
        kimochi_capture::FrameInfo {
            source_id: "test:window:1".into(),
            width: full.0,
            height: full.1,
            stride: full.0 as usize * 4,
            full_width: full.0,
            full_height: full.1,
            crop_pixels: [0, 0, full.0, full.1],
            scale_factor: scale,
            source_bounds,
            pixel_format: "rgba8",
            color_space: "srgb",
            resolve_ms: 0.,
            acquisition_ms: 0.,
            pixels_ms: 0.,
            total_ms: 0.,
        }
    }

    #[test]
    fn the_build_reports_its_desktop_unit() {
        let expected = if cfg!(target_os = "windows") {
            DesktopUnit::PhysicalPixels
        } else {
            DesktopUnit::Points
        };
        assert_eq!(desktop_unit(), expected);
    }

    #[test]
    fn mac_points_pass_through_unchanged_whatever_the_backing_scale() {
        // Two Retina displays, one left of the primary. Points are already CSS pixels,
        // so the backing scale must never touch a coordinate.
        let mac = DesktopGeometry::new(
            DesktopUnit::Points,
            vec![
                display(1, rect(0., 0., 1512., 982.), 2.),
                display(2, rect(-1920., -200., 1920., 1080.), 1.),
            ],
        );
        assert!(mac.is_identity());
        for p in [(10.5, 20.25), (-1000., -150.), (5000., 5000.)] {
            assert_eq!(mac.point_to_desktop(p), p);
            assert_eq!(mac.point_from_desktop(p), p);
            assert_eq!(mac.scale_for_point(p), 1.);
        }
        let r = rect(-50., 30., 800.5, 600.);
        assert_rect(mac.rect_to_desktop(r), (-50., 30., 800.5, 600.));
        assert_rect(mac.rect_from_desktop(r), (-50., 30., 800.5, 600.));
        assert_eq!(mac.scale_for_rect(r), 1.);
        let d = display(1, rect(0., 0., 1512., 982.), 2.);
        let same = mac.display_to_desktop(&d);
        assert_rect(same.bounds, (0., 0., 1512., 982.));
        assert_eq!(same.scale_factor, 2.);
        let info = frame_info(Some(rect(100., 50., 640., 400.)), (1280, 800), 2.);
        let out = mac.frame_info_to_desktop(&info);
        assert_rect(out.source_bounds.unwrap(), (100., 50., 640., 400.));
        assert_eq!(out.scale_factor, 2.);
        assert_eq!(
            serde_json::to_value(&out).unwrap(),
            serde_json::to_value(&info).unwrap()
        );
    }

    #[test]
    fn windows_single_monitor_converts_at_each_common_scale() {
        for scale in [1., 1.25, 1.5, 2.] {
            let (w, h) = (1920. * scale, 1080. * scale);
            let g = windows(vec![display(1, rect(0., 0., w, h), scale)]);
            assert_eq!(g.scale_for_point((10., 10.)), scale);
            let p = g.point_to_desktop((300. * scale, 150. * scale));
            assert!(close(p.0, 300.) && close(p.1, 150.), "{scale}: {p:?}");
            let back = g.point_from_desktop(p);
            assert!(close(back.0, 300. * scale) && close(back.1, 150. * scale));
            let r = g.rect_to_desktop(rect(100. * scale, 40. * scale, 640. * scale, 480. * scale));
            assert_rect(r, (100., 40., 640., 480.));
            assert_rect(
                g.rect_from_desktop(r),
                (100. * scale, 40. * scale, 640. * scale, 480. * scale),
            );
            let d = g.display_to_desktop(&g.displays[0].info);
            assert_rect(d.bounds, (0., 0., 1920., 1080.));
            assert_rect(d.work_area, (0., 0., 1920., 1032.));
            assert_eq!(d.scale_factor, scale);
        }
    }

    #[test]
    fn windows_negative_origins_stay_against_the_primary() {
        // A 150 % monitor left of a 100 % primary, starting 200 px above it.
        let g = windows(vec![
            display(1, rect(0., 0., 1920., 1080.), 1.),
            display(2, rect(-2880., -200., 2880., 1620.), 1.5),
        ]);
        let d = g.display_to_desktop(&g.displays[1].info);
        // Its right edge still meets the primary's left edge, in points too.
        assert_rect(d.bounds, (-1920., -200., 1920., 1080.));
        let p = g.point_to_desktop((-1440., 610.));
        assert!(close(p.0, -960.) && close(p.1, 340.), "{p:?}");
        let back = g.point_from_desktop(p);
        assert!(close(back.0, -1440.) && close(back.1, 610.));
        // A monitor above the primary.
        let g = windows(vec![
            display(1, rect(0., 0., 1920., 1080.), 1.),
            display(2, rect(-500., -2160., 3840., 2160.), 2.),
        ]);
        let d = g.display_to_desktop(&g.displays[1].info);
        assert_rect(d.bounds, (-500., -1080., 1920., 1080.));
        // The primary is untouched.
        assert_eq!(g.point_to_desktop((500., 500.)), (500., 500.));
        assert_eq!(g.point_from_desktop((500., 500.)), (500., 500.));
    }

    #[test]
    fn windows_uniform_scale_is_one_seamless_plane() {
        // Two 150 % monitors side by side, and a 125 % one left of the primary: with a
        // single scale per side, desktop points are physical / scale, as Chromium's
        // `screenX` reports them.
        let g = windows(vec![
            display(1, rect(0., 0., 2880., 1620.), 1.5),
            display(2, rect(2880., 0., 2880., 1620.), 1.5),
        ]);
        let screens = g.desktop_displays();
        assert_rect(screens[0].bounds, (0., 0., 1920., 1080.));
        assert_rect(screens[1].bounds, (1920., 0., 1920., 1080.));
        let p = g.point_to_desktop((3000., 300.));
        assert!(close(p.0, 2000.) && close(p.1, 200.), "{p:?}");
        // 150 % primary, 100 % monitor to its right.
        let g = windows(vec![
            display(1, rect(0., 0., 2880., 1620.), 1.5),
            display(2, rect(2880., 300., 1920., 1080.), 1.),
        ]);
        let screens = g.desktop_displays();
        assert_rect(screens[1].bounds, (1920., 200., 1920., 1080.));
        let p = g.point_to_desktop((2980., 400.));
        assert!(close(p.0, 2020.) && close(p.1, 300.), "{p:?}");
        assert_eq!(g.point_from_desktop(p), (2980., 400.));
        // A monitor touching nothing falls back to physical / scale.
        let g = windows(vec![
            display(1, rect(0., 0., 1920., 1080.), 1.),
            display(2, rect(5000., 0., 2500., 1000.), 1.25),
        ]);
        assert_rect(g.desktop_displays()[1].bounds, (4000., 0., 2000., 800.));
    }

    #[test]
    fn windows_straddling_rect_uses_the_monitor_it_overlaps_most() {
        let g = windows(vec![
            display(1, rect(0., 0., 1920., 1080.), 1.),
            display(2, rect(1920., 0., 2880., 1620.), 1.5),
        ]);
        // 120 px on the primary, 280 px on the 150 % monitor.
        let raw = rect(1800., 90., 400., 300.);
        assert_eq!(g.scale_for_rect(raw), 1.5);
        let r = g.rect_to_desktop(raw);
        assert_rect(r, (1840., 60., 400. / 1.5, 200.));
        assert_rect(g.rect_from_desktop(r), (1800., 90., 400., 300.));
        // Mostly on the primary: the primary's (identity) transform.
        assert_eq!(g.scale_for_rect(rect(1600., 0., 400., 300.)), 1.);
        assert_rect(g.rect_to_desktop(rect(1600., 0., 400., 300.)), (1600., 0., 400., 300.));
        // A point in no monitor takes the nearest one's scale.
        let raw: Vec<DisplayInfo> = g.displays.iter().map(|d| d.info.clone()).collect();
        assert_eq!(scale_for_point((6000., 10.), &raw), 1.5);
        assert_eq!(scale_for_point((-50., 10.), &raw), 1.);
        assert_eq!(scale_for_rect(raw[1].bounds, &raw), 1.5);
        assert_eq!(scale_for_point((0., 0.), &[]), 1.);
    }

    #[test]
    fn window_css_round_trips_through_the_window_scale() {
        let window = rect(-1000., 200., 900., 600.);
        let css = desktop_to_window_css((-850., 350.), window, 1.5);
        assert!(close(css.0, 100.) && close(css.1, 100.));
        let back = window_css_to_desktop(css, window, 1.5);
        assert!(close(back.0, -850.) && close(back.1, 350.));
        assert_eq!(desktop_to_window_css((5., 5.), rect(0., 0., 9., 9.), 0.), (5., 5.));
    }

    #[test]
    fn a_pointer_over_the_overlay_lands_on_its_css_pixels() {
        // The overlay is placed from a desktop-point rect; the pointer is sampled raw.
        // Their difference must equal the page's own CSS coordinates (raw offset / DPI).
        let g = windows(vec![
            display(1, rect(0., 0., 1920., 1080.), 1.),
            display(2, rect(1920., -300., 3840., 2160.), 2.),
        ]);
        let overlay_points = g.display_to_desktop(&g.displays[1].info).bounds;
        let overlay_raw = g.rect_from_desktop(overlay_points);
        assert_rect(overlay_raw, (1920., -300., 3840., 2160.));
        let raw_pointer = (2920., 700.);
        let pointer = g.point_to_desktop(raw_pointer);
        let local = (pointer.0 - overlay_points.x, pointer.1 - overlay_points.y);
        let css = desktop_to_window_css(raw_pointer, overlay_raw, 2.);
        assert!(close(local.0, css.0) && close(local.1, css.1), "{local:?} {css:?}");
        assert!(close(css.0, 500.) && close(css.1, 500.));
    }

    #[test]
    fn windows_frame_info_maps_frame_pixels_onto_desktop_points() {
        // A window of 900×600 physical pixels on a 150 % monitor right of the primary;
        // capture-core reports a full frame at 1 frame pixel per physical pixel.
        let g = windows(vec![
            display(1, rect(0., 0., 1920., 1080.), 1.),
            display(2, rect(1920., 0., 2880., 1620.), 1.5),
        ]);
        let raw = rect(2400., 300., 900., 600.);
        let info = frame_info(Some(raw), (900, 600), 1.);
        let out = g.frame_info_to_desktop(&info);
        let b = out.source_bounds.unwrap();
        assert_rect(b, (2240., 200., 600., 400.));
        // Frame pixels per desktop point.
        assert_eq!(out.scale_factor, 1.5);
        assert_eq!((out.full_width, out.full_height), (900, 600));
        assert_eq!(out.crop_pixels, info.crop_pixels);
        // The UI's mapping (ui/geometry.ts mapRect): frame pixel → desktop point.
        let (fx, fy) = (90., 60.);
        let desktop = (
            b.x + fx * b.width / f64::from(out.full_width),
            b.y + fy * b.height / f64::from(out.full_height),
        );
        assert!(close(desktop.0, 2300.) && close(desktop.1, 240.));
        // …which is exactly the physical pixel the frame pixel came from.
        let physical = g.point_from_desktop(desktop);
        assert!(close(physical.0, raw.x + fx) && close(physical.1, raw.y + fy), "{physical:?}");
        // A downscaled frame (thumbnail) keeps its own pixels-per-unit factor.
        let small = g.frame_info_to_desktop(&frame_info(Some(raw), (450, 300), 0.5));
        assert_eq!(small.scale_factor, 0.75);
        // No bounds, nothing to convert.
        let none = g.frame_info_to_desktop(&frame_info(None, (10, 10), 1.));
        assert!(none.source_bounds.is_none());
        assert_eq!(none.scale_factor, 1.);
    }

    #[test]
    fn clamping_happens_in_desktop_points() {
        let g = windows(vec![
            display(1, rect(0., 0., 1920., 1080.), 1.),
            display(2, rect(1920., 0., 3840., 2160.), 2.),
        ]);
        let screens = g.desktop_displays();
        // The 200 % monitor is 1920×1080 points wide starting at 1920.
        let clamped = clamp_within(rect(3700., 900., 400., 300.), &screens);
        assert_eq!((clamped.x, clamped.y), (3440., 732.));
    }

    #[test]
    fn merge_replaces_leaves_and_keeps_siblings() {
        let mut base = json!({"a": {"x": 1, "y": 2}, "b": false});
        merge(&mut base, json!({"a": {"y": 3}, "b": true, "c": []}));
        assert_eq!(base, json!({"a": {"x": 1, "y": 3}, "b": true, "c": []}));
    }
}
