//! Shared application state: the capture backend, the in-memory image store that backs
//! the `capture:` protocol, and the view snapshot panels read.
use crate::platform::FrontWindow;
use crate::settings::Settings;
use kimochi_capture::{CaptureBackend, Rect, SourceId, TextObserver};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{atomic::AtomicBool, Arc, Mutex, OnceLock},
    time::Instant,
};

#[derive(Clone)]
pub struct Image {
    png: Arc<OnceLock<kimochi_capture::Result<Vec<u8>>>>,
    raw: Option<Arc<kimochi_capture::Frame>>,
    /// The `FrameInfo` this image was captured with. OCR must be run against the
    /// frame's own geometry, never against a later recapture whose dimensions or
    /// crop may differ.
    pub info: Value,
}

impl Image {
    pub fn encoded(png: Vec<u8>, info: Value) -> Self {
        Self {
            png: Arc::new(OnceLock::from(Ok(png))),
            raw: None,
            info,
        }
    }

    /// Observations keep pixels; encode only if OCR or a preview consumes them.
    pub fn captured(frame: kimochi_capture::Frame, info: Value) -> Self {
        Self {
            png: Arc::new(OnceLock::new()),
            raw: Some(Arc::new(frame)),
            info,
        }
    }

    /// The captured pixels, when this image still has them (an engine that reads
    /// RGBA directly skips the PNG round trip).
    #[cfg(target_os = "macos")]
    pub fn frame(&self) -> Option<Arc<kimochi_capture::Frame>> {
        self.raw.clone()
    }

    pub fn png(&self) -> Result<Vec<u8>, String> {
        self.png
            .get_or_init(|| self.raw.as_ref().expect("raw image").png())
            .clone()
            .map_err(|error| format!("{}: {}", error.code, error.message))
    }
}

/// Pixels never touch disk and never leave the process except through an explicit
/// OCR request. The `capture:` protocol serves them by id, so no image is ever
/// base64-encoded through the IPC bridge.
#[derive(Default)]
pub struct Images {
    pub capture_error: Option<String>,
    /// The newest captured frame, published or not.
    latest: Option<(u64, Arc<Image>)>,
    /// The frame whose result is currently on screen, pinned so the Capture Preview
    /// keeps resolving. Without this, a change-detection probe that is discarded by
    /// the hash would still evict the image the published `snapshot().scan.id` points
    /// at, and the preview would 404 while the snapshot still named it.
    published: Option<(u64, Arc<Image>)>,
    /// Independent candidate/in-flight owners, bounded by MAX_RETAINED_FRAMES.
    /// A newer probe cannot revoke a frame another operation still owns.
    retained: HashMap<u64, (Arc<Image>, usize)>,
    /// Source-picker previews, served at `capture://localhost/preview/{id}`. Bounded
    /// so browsing a long source list cannot grow memory without limit.
    previews: Vec<(u64, Arc<Image>)>,
    live_previews: Vec<(u64, Arc<Image>)>,
    /// The overlay's hover preview of the selected window, served at
    /// `capture://localhost/hover/{id}`. One slot of its own, so a hover can never
    /// evict a picker preview, the latest frame, the published frame or a frame a
    /// settling candidate holds — and never becomes an auto-OCR observation.
    hover: Option<(u64, Arc<Image>)>,
    next_token: u64,
    /// One monotonic id space shared by `scan` and `capture_frame`, so a frame can be
    /// captured by one and OCR'd by the other without ambiguity.
    next_frame: u64,
}

const MAX_PREVIEWS: usize = 4;
const MAX_RETAINED_FRAMES: usize = 8;

impl Images {
    pub fn put_latest(&mut self, mut image: Image) -> u64 {
        image.info["capturedAt"] = serde_json::json!(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64);
        self.capture_error = None;
        self.next_frame += 1;
        let id = self.next_frame;
        self.latest = Some((id, Arc::new(image)));
        id
    }

    pub fn put_preview(&mut self, image: Image) -> u64 {
        self.next_token += 1;
        let token = self.next_token;
        self.previews.push((token, Arc::new(image)));
        if self.previews.len() > MAX_PREVIEWS {
            self.previews.remove(0);
        }
        token
    }

    /// Replace the hover preview. Shares the preview token space, so a stale URL
    /// for a replaced hover image 404s instead of resolving to the new one.
    pub fn put_hover(&mut self, image: Image) -> u64 {
        self.next_token += 1;
        let token = self.next_token;
        self.hover = Some((token, Arc::new(image)));
        token
    }

    pub fn hover_image(&self, token: u64) -> Option<&Arc<Image>> {
        self.hover
            .as_ref()
            .filter(|(known, _)| *known == token)
            .map(|(_, image)| image)
    }

    /// Pin a frame against eviction because its result is now on screen. Shares the
    /// existing allocation rather than copying the pixels.
    pub fn pin_published(&mut self, id: u64) -> bool {
        if self
            .published
            .as_ref()
            .is_some_and(|(known, _)| *known == id)
        {
            return true;
        }
        match self.frame(id) {
            Some(image) => {
                let image = image.clone();
                self.published = Some((id, image));
                true
            }
            None => false,
        }
    }

    pub fn pin_candidate(&mut self, id: u64) -> bool {
        if let Some((_, owners)) = self.retained.get_mut(&id) {
            *owners += 1;
            return true;
        }
        if self.retained.len() >= MAX_RETAINED_FRAMES {
            return false;
        }
        let Some(image) = self.frame(id).cloned() else {
            return false;
        };
        self.retained.insert(id, (image, 1));
        true
    }

    pub fn release_candidate(&mut self, id: u64) -> bool {
        let Some((_, owners)) = self.retained.get_mut(&id) else {
            return false;
        };
        *owners -= 1;
        if *owners == 0 {
            self.retained.remove(&id);
        }
        true
    }

    pub fn frame(&self, id: u64) -> Option<&Arc<Image>> {
        self.retained.get(&id).map(|(image, _)| image).or_else(|| {
            [self.published.as_ref(), self.latest.as_ref()]
                .into_iter()
                .flatten()
                .find(|(known, _)| *known == id)
                .map(|(_, image)| image)
        })
    }

    /// The frame a mining screenshot shows (a dictionary extension's
    /// `tabs.captureVisibleTab`): `wanted` when that frame is still held, otherwise the
    /// frame whose text is on screen, otherwise the newest capture. The flag says whether
    /// `wanted` was the one found.
    pub fn mining_frame(&self, wanted: Option<u64>) -> Option<(u64, bool)> {
        if let Some(id) = wanted.filter(|id| self.frame(*id).is_some()) {
            return Some((id, true));
        }
        self.published
            .as_ref()
            .or(self.latest.as_ref())
            .map(|(id, _)| (*id, false))
    }

    /// Preview ownership is separate from OCR and source-picker ownership. Two slots
    /// let the browser finish loading the previous image while its successor arrives.
    pub fn live_preview(&mut self) -> Option<(u64, Arc<Image>)> {
        let (id, image) = self.latest.as_ref()?;
        let result = (*id, image.clone());
        if !self.live_previews.iter().any(|(known, _)| known == id) {
            self.live_previews.push(result.clone());
            if self.live_previews.len() > 2 {
                self.live_previews.remove(0);
            }
        }
        Some(result)
    }

    pub fn live_image(&self, id: u64) -> Option<&Arc<Image>> {
        self.live_previews
            .iter()
            .find(|(known, _)| *known == id)
            .map(|(_, image)| image)
    }

    pub fn preview(&self, token: u64) -> Option<&Arc<Image>> {
        self.previews
            .iter()
            .find(|(known, _)| *known == token)
            .map(|(_, image)| image)
    }

    pub fn clear(&mut self) {
        self.latest = None;
        self.published = None;
        self.retained.clear();
        self.previews.clear();
        self.live_previews.clear();
        self.hover = None;
    }
}

/// A cached thumbnail data URI. Thumbnails are expensive — one real ScreenCaptureKit
/// capture each — so a short TTL keeps scrolling a source list from re-capturing.
pub struct Thumbnail {
    pub taken: Instant,
    pub data_uri: Arc<str>,
}

/// One rectangle in which the overlay window takes the mouse, in desktop points.
///
/// The overlay is click-through everywhere else, so this list is the whole of its
/// interactive surface: a rectangle that is missing is a rectangle whose clicks go
/// to the application underneath *and* count as a click away from the dictionary.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Entering this rectangle takes the keyboard for the window that published it.
    ///
    /// Scanned words deliberately do not: a word is something to point at, the keyboard
    /// belongs to whatever is being read, and a lookup needs no focus — the modifier
    /// arrives with the pointer instead. The dictionary's own window does, because a
    /// reader whose pointer has reached it has reached for it. Absent in older
    /// payloads, where nothing was focusable, hence the default.
    #[serde(default)]
    pub focus: bool,
}

impl Region {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }

    pub fn usable(&self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.width > 0. && self.height > 0.
    }
}

/// Every window's interactive rectangles, keyed by window label.
///
/// More than one window can own part of the desktop: the overlay owns the words it
/// drew, and the dictionary popup's host owns the popup. A press belongs to whichever
/// window claims the point, and to nobody at all only when no window does.
pub type Regions = HashMap<String, Vec<Region>>;

/// What the previous cursor sample saw, so a sample can be read as a transition.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PointerHistory {
    pub interactive: bool,
    pub down: bool,
    pub over_target: bool,
}

/// What one cursor sample means for one window.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointerVerdict {
    /// Take the mouse rather than letting it through to whatever is underneath.
    pub interactive: bool,
    /// The pointer is on a lookup target.
    pub over_target: bool,
    /// The pointer has just *arrived* on a lookup target.
    pub take_focus: bool,
}

/// Read one cursor sample against one window's published regions.
///
/// Separated from the poll so the rules are testable, because each of them is a
/// rule about something invisible:
///
///  - a drag that began on a region stays interactive while the button is held, so
///    sliding off the edge mid-drag does not drop the rest of the gesture;
///  - focus is taken on the *rising edge* onto a target, and only when the pointer
///    moved onto it. Resting on one never re-takes focus, and neither does a window
///    that opens under a stationary pointer — the dictionary popup appears next to
///    the word being read, and it must not grab the keyboard from underneath a reader
///    who has not reached for it yet.
pub fn classify_pointer(
    regions: &[Region],
    visible: bool,
    x: f64,
    y: f64,
    down: bool,
    moved: bool,
    was: PointerHistory,
) -> PointerVerdict {
    let hit = visible && regions.iter().any(|r| r.contains(x, y));
    let over_target = visible && regions.iter().any(|r| r.focus && r.contains(x, y));
    PointerVerdict {
        interactive: hit || (was.interactive && down),
        over_target,
        take_focus: over_target && !was.over_target && moved,
    }
}

/// Moved to `platform` with the per-OS samplers; re-exported for existing callers.
pub use crate::platform::Modifiers;

/// Whether a press at this point is a click *away* from everything the app owns.
///
/// The union matters, and it is the whole of the rule. A press inside the dictionary
/// popup, or on a different word, is interaction — even though the popup and the word
/// may be published by two different windows. Only a press that no window claims
/// closes the dictionary, and only on the edge: holding the button down is one press,
/// not one per frame.
pub fn dismissed(
    regions: &Regions,
    hidden: &[&str],
    x: f64,
    y: f64,
    down: bool,
    was_down: bool,
) -> bool {
    if !down || was_down {
        return false;
    }
    !regions
        .iter()
        .filter(|(label, _)| !hidden.contains(&label.as_str()))
        .any(|(_, rects)| rects.iter().any(|r| r.contains(x, y)))
}

/// Whether the captured window is still the one the reader is looking at.
///
/// Scanned text is a copy of what is on another window. When that window goes behind
/// something else, is minimised or closed, the copy is no longer over anything and
/// has to go — visually *and* as a click target, because an invisible rectangle that
/// still takes the mouse is worse than a visible one.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct SourceFocus {
    /// The captured window is the frontmost window of the frontmost application.
    pub focused: bool,
    /// It still exists and is on screen — not closed, not minimised, not on another
    /// Space.
    pub present: bool,
    /// One of Kimochi's own windows is in front, so `focused` is being held at what it
    /// was rather than recomputed.
    pub held: bool,
    /// The window the comparison was made against, and the captured window it was
    /// compared with. Ids only — never a title. An application can order an auxiliary
    /// window in front of the one being read, and "the popup thinks I left" is only
    /// ever explained by which two windows were compared.
    pub front_window: u32,
    pub source_window: u32,
}

impl Default for SourceFocus {
    /// Unknown shows text. Focus is established at startup, but until it is, hiding
    /// everything would be a worse guess than showing it: the reader chose the source.
    fn default() -> Self {
        Self {
            focused: true,
            present: true,
            held: false,
            front_window: 0,
            source_window: 0,
        }
    }
}

/// The window-server id inside a source id, when the source is a window of this
/// platform with a numeric handle at all.
#[allow(dead_code)] // Callers now parse with `SourceId`; kept as the documented helper.
pub fn window_id_of(source_id: &str) -> Option<u32> {
    kimochi_capture::ids::local_window_number(source_id)
}

/// Decide whether the captured window is in front, from one window-server sample.
///
/// Four rules, and each exists because of a way the naive version is wrong:
///
///  - **a display capture is always in front.** A screen capture is of whatever is on
///    that screen, so there is no window whose focus could be lost, and applying
///    window rules to it would blank text for no reason;
///  - **an id this build cannot resolve is unknown, not a display.** A malformed id, or
///    one minted by another platform's backend, points at nothing here: it is neither
///    focused nor present, rather than being waved through as "a screen";
///  - **our own windows hold the answer.** Hovering the scanned text focuses the
///    overlay, and clicking the dictionary focuses the popup — both make Kimochi
///    frontmost. Recomputing then would decide the source had lost focus and hide the
///    very text being read, which would also close the popup that took the focus: a
///    self-dismissal loop. So while one of our windows is in front, the previous
///    answer stands. Any *other* application takes precedence immediately;
///  - **no answer is not an answer.** With no frontmost application at all, the
///    window server has nothing to say, and the last answer is better than a guess.
///
/// `front` is the frontmost window *of the frontmost application*, not the topmost
/// window on the desktop — see `platform::front_window`. Kimochi's own windows are
/// ordinary layer-0 windows that float above everything, so by z-order alone the
/// captured window would never be in front once the overlay was up, and its text would
/// never come back.
pub fn source_focus(
    source_id: Option<&str>,
    front: Option<FrontWindow>,
    own_pid: u32,
    bounds: Option<(Rect, bool)>,
    previous: SourceFocus,
) -> SourceFocus {
    let front_window = front
        .as_ref()
        .and_then(|f| f.window.as_ref())
        .and_then(SourceId::handle_u32)
        .unwrap_or(0);
    let shown = SourceFocus {
        focused: true,
        present: true,
        held: false,
        front_window,
        source_window: 0,
    };
    // No source chosen: nothing to hide.
    let Some(source_id) = source_id else {
        return shown;
    };
    let window = match SourceId::parse(source_id).filter(SourceId::is_local) {
        Some(id) if id.is_display() => return shown,
        Some(id) => id,
        None => {
            return SourceFocus {
                focused: false,
                present: false,
                ..shown
            }
        }
    };
    let present = bounds.is_some_and(|(_, on_screen)| on_screen);
    let seen = SourceFocus {
        focused: previous.focused,
        present,
        held: false,
        front_window,
        source_window: window.handle_u32().unwrap_or(0),
    };
    match front {
        None => seen,
        // An explicitly selected own window is OCR fixture content, not a reader panel.
        Some(front) if front.pid == own_pid && window.pid() == Some(own_pid)
            && front.window.as_ref().is_some_and(|w| w.platform() == window.platform() && w.handle() == window.handle()) => SourceFocus { focused: true, ..seen },
        Some(front) if front.pid == own_pid => SourceFocus { held: true, ..seen },
        Some(front) => SourceFocus {
            focused: front
                .window
                .as_ref()
                .is_some_and(|w| w.platform() == window.platform() && w.handle() == window.handle()),
            ..seen
        },
    }
}

#[derive(Default)]
pub struct View {
    pub revision: u64,
    pub scan: Option<Value>,
    pub status: String,
    pub logs: Vec<Value>,
    pub regions: Regions,
    pub source_focus: SourceFocus,
    pub origin: Option<Rect>,
    pub interactive: bool,
    pub dictionary: bool,
    pub dismiss: u64,
    // Panel-facing state, so panels can render without polling an expensive
    // enumeration every tick.
    pub scanning: bool,
    pub auto_ocr: bool,
    pub overlay_visible: bool,
    pub text_overlay_visible: bool,
    pub debug_overlay_visible: bool,
    /// Raw frontmost application name, unfiltered. Consumers apply their own rules
    /// (Kimochi's own windows are neutral; unknown focus must not hide text).
    pub frontmost_app: Option<String>,
    pub accessibility: bool,
    pub action_seq: u64,
    pub last_action: Option<String>,
    /// The frame id whose result is currently published. Lets a repeated publish for
    /// the same frame be ignored instead of bumping the revision and re-rendering.
    pub published_frame: Option<u64>,
}

pub struct Service {
    pub backend: Mutex<Box<dyn CaptureBackend>>,
    /// The local first-pass text observer, behind its own lock.
    ///
    /// Separate from `backend` so an observation cannot be held up by a capture
    /// or a source enumeration, and vice versa. On a platform with no observer
    /// this is the honest stub, which reports unsupported and reads nothing.
    pub observer: Mutex<Box<dyn TextObserver>>,
    pub images: Mutex<Images>,
    pub settings: Arc<Settings>,
    pub view: Mutex<View>,
    /// The committed source id. Session-scoped and never persisted directly; a
    /// descriptive record is persisted instead and resolved on restart.
    pub selection: Mutex<Option<String>>,
    /// The source id whose geometry is currently being tracked, if any.
    pub watching: Mutex<Option<String>>,
    /// Per-sender relay sequence, so a receiver can drop a redelivered message.
    pub relay_seq: Mutex<HashMap<String, u64>>,
    pub scanning: AtomicBool,
    pub thumbnails: Mutex<HashMap<String, Thumbnail>>,
    /// Application icons keyed by localized name. `None` records a miss so a window
    /// with no owning running application is not re-resolved on every catalog call.
    pub icons: Mutex<HashMap<String, Option<Arc<str>>>>,
}

pub type Shared = Arc<Service>;

impl Service {
    pub fn set_status(&self, status: impl Into<String>) {
        self.view.lock().unwrap().status = status.into();
    }

    pub fn log(&self, value: Value) {
        let mut view = self.view.lock().unwrap();
        view.logs.push(value);
        if view.logs.len() > 60 {
            view.logs.remove(0);
        }
    }
}

/// capture-core calls a screen a "display"; the renderer's `CaptureSource` and its
/// `isScreenSource` check call it a "screen". The native catalog keeps the native
/// word, and everything persisted or handed to the frontend uses the frontend's.
pub fn descriptor_type(kind: &str) -> &str {
    match kind {
        "display" => "screen",
        other => other,
    }
}

/// A stable key for per-source settings, matching Electron's per-application crop
/// storage: application name first, then window title, then the source kind.
///
/// The kind is normalised first, so a key minted at commit time and one derived from
/// a restored descriptor agree even in the no-name fallback.
pub fn descriptor_key(kind: &str, name: &str, app: Option<&str>) -> String {
    match app {
        Some(app) if !app.trim().is_empty() => app.trim().to_string(),
        _ if !name.trim().is_empty() => name.trim().to_string(),
        _ => format!("{}:unknown", descriptor_type(kind)),
    }
}

#[cfg(test)]
mod focus_tests {
    use super::*;
    use kimochi_capture::Platform;

    const SOURCE_WINDOW: u32 = 15970;
    const SOURCE_PID: u32 = 56963;
    const OWN_PID: u32 = 4242;

    /// A window id as this build's backend mints it (`macos:window:15970:56963` on
    /// macOS), so the focus rules are exercised on every OS.
    fn source() -> String {
        SourceId::window(Platform::current(), SOURCE_WINDOW, SOURCE_PID).to_string()
    }

    fn display() -> String {
        SourceId::display(Platform::current(), 1).to_string()
    }

    /// The front window of the frontmost application; window `0` is "no ordinary
    /// window on screen".
    fn front(window: u32, pid: u32) -> Option<FrontWindow> {
        Some(FrontWindow {
            window: (window != 0).then(|| SourceId::window(Platform::current(), window, pid)),
            pid,
        })
    }

    fn on_screen() -> Option<(Rect, bool)> {
        Some((
            Rect {
                x: 100.,
                y: 200.,
                width: 512.,
                height: 796.,
            },
            true,
        ))
    }

    fn shown() -> SourceFocus {
        SourceFocus {
            focused: true,
            present: true,
            ..SourceFocus::default()
        }
    }

    #[test]
    fn a_window_id_is_read_out_of_the_source_id() {
        assert_eq!(window_id_of(&source()), Some(SOURCE_WINDOW));
        assert_eq!(window_id_of(&display()), None);
        assert_eq!(window_id_of("macos:window:"), None);
        assert_eq!(window_id_of("macos:window:not-a-number:1"), None);
    }

    #[test]
    fn the_captured_window_in_front_is_focused() {
        let focus = source_focus(
            Some(source().as_str()),
            front(SOURCE_WINDOW, 9001),
            OWN_PID,
            on_screen(),
            SourceFocus::default(),
        );
        assert!(focus.focused);
        assert!(focus.present);
        assert!(!focus.held);
    }

    #[test]
    fn another_window_of_the_same_application_is_not_the_source() {
        // The reason this asks the window server rather than comparing application
        // names: the owner is identical and the text still has to go.
        let focus = source_focus(
            Some(source().as_str()),
            front(SOURCE_WINDOW + 1, 9001),
            OWN_PID,
            on_screen(),
            shown(),
        );
        assert!(!focus.focused);
    }

    #[test]
    fn a_minimised_or_offscreen_window_is_not_present() {
        let minimised = Some((
            Rect {
                x: 0.,
                y: 0.,
                width: 512.,
                height: 796.,
            },
            false,
        ));
        let focus = source_focus(
            Some(source().as_str()),
            front(SOURCE_WINDOW, 9001),
            OWN_PID,
            minimised,
            shown(),
        );
        assert!(!focus.present);
    }

    #[test]
    fn a_window_that_has_gone_is_not_present() {
        let focus = source_focus(Some(source().as_str()), front(7777, 9001), OWN_PID, None, shown());
        assert!(!focus.present);
        assert!(!focus.focused);
    }

    #[test]
    fn a_selected_own_fixture_establishes_focus_and_panels_then_hold_it() {
        let source = SourceId::window(Platform::current(), SOURCE_WINDOW, OWN_PID).to_string();
        // From a false answer: before the fix an own window in front only held the previous
        // value, so starting from the default (`focused: true`) would pass without the fix.
        let previous = SourceFocus { focused: false, ..SourceFocus::default() };
        let focus = source_focus(Some(&source), front(SOURCE_WINDOW, OWN_PID), OWN_PID, on_screen(), previous);
        assert!(focus.focused);
        assert!(!focus.held);
        let panel = source_focus(Some(&source), front(SOURCE_WINDOW + 1, OWN_PID), OWN_PID, on_screen(), focus);
        assert!(panel.focused);
        assert!(panel.held);
    }

    #[test]
    fn our_own_windows_hold_the_answer_instead_of_answering_it() {
        // Hovering the scanned text focuses the overlay and clicking the dictionary
        // focuses the popup. Recomputing then would decide the source had lost focus,
        // hide the text being read, and close the popup that took the focus.
        let focus = source_focus(
            Some(source().as_str()),
            front(1234, OWN_PID),
            OWN_PID,
            on_screen(),
            shown(),
        );
        assert!(focus.focused, "the reader is still reading the same window");
        assert!(focus.held);
    }

    #[test]
    fn holding_preserves_a_hidden_state_as_well_as_a_shown_one() {
        let hidden = SourceFocus {
            focused: false,
            present: true,
            ..SourceFocus::default()
        };
        let focus = source_focus(
            Some(source().as_str()),
            front(1234, OWN_PID),
            OWN_PID,
            on_screen(),
            hidden,
        );
        assert!(!focus.focused);
    }

    #[test]
    fn another_application_takes_precedence_over_a_held_answer() {
        let held = SourceFocus {
            focused: true,
            present: true,
            held: true,
            ..SourceFocus::default()
        };
        let focus = source_focus(Some(source().as_str()), front(555, 9001), OWN_PID, on_screen(), held);
        assert!(!focus.focused);
        assert!(!focus.held);
    }

    #[test]
    fn hovering_our_own_window_repeatedly_cannot_drift() {
        // The self-dismissal loop this exists to prevent: each sample holds, so the
        // answer never decays while the reader interacts with the dictionary.
        let mut focus = shown();
        for _ in 0..50 {
            focus = source_focus(
                Some(source().as_str()),
                front(1234, OWN_PID),
                OWN_PID,
                on_screen(),
                focus,
            );
        }
        assert!(focus.focused);
    }

    #[test]
    fn no_frontmost_application_keeps_the_last_answer() {
        // The window server has nothing to say, and a guess would blink the text.
        let focus = source_focus(Some(source().as_str()), None, OWN_PID, on_screen(), shown());
        assert!(focus.focused);
        assert!(!focus.held);
    }

    #[test]
    fn our_own_windows_floating_above_the_source_do_not_count_as_being_in_front() {
        // The regression this rule exists for. Kimochi's windows are ordinary layer-0
        // windows that float above everything, so the topmost window on the desktop is
        // almost always one of ours. Answering by z-order alone left the captured
        // window permanently "behind" once the overlay was up, and its text never came
        // back. `front` is the frontmost window of the frontmost *application*: while
        // the reader is in the captured app, that is the captured window, whatever is
        // floating over it.
        let focus = source_focus(
            Some(source().as_str()),
            front(SOURCE_WINDOW, 56963),
            OWN_PID,
            on_screen(),
            SourceFocus {
                focused: false,
                present: true,
                ..SourceFocus::default()
            },
        );
        assert!(focus.focused, "the reader is in the captured window again");
    }

    #[test]
    fn an_application_with_no_ordinary_window_on_screen_is_not_the_source() {
        // A menu-bar agent, or an app whose windows are all minimised: window 0 matches
        // nothing, which is the right answer, and the pid still identifies the owner.
        let focus = source_focus(Some(source().as_str()), front(0, 9001), OWN_PID, on_screen(), shown());
        assert!(!focus.focused);

        let ours = source_focus(
            Some(source().as_str()),
            front(0, OWN_PID),
            OWN_PID,
            on_screen(),
            shown(),
        );
        assert!(ours.held, "and ours is still recognised as ours");
        assert!(ours.focused);
    }

    #[test]
    fn a_display_capture_is_always_in_front() {
        // A screen capture is of whatever is on that screen: there is no window whose
        // focus could be lost, and window rules would blank it for no reason.
        for front in [None, front(1, 9001), front(2, OWN_PID)] {
            let focus = source_focus(Some(display().as_str()), front, OWN_PID, None, shown());
            assert!(focus.focused);
            assert!(focus.present);
        }
    }

    #[test]
    fn an_id_this_build_cannot_resolve_is_unknown_not_a_display() {
        // A malformed id used to fall through to the display rule and count as
        // "focused, present". It points at nothing, so it is neither.
        let foreign = if Platform::current() == Platform::MacOs {
            "windows:window:0x000A0B2C:4242"
        } else {
            "macos:window:15970:56963"
        };
        for id in ["", "macos:window:", "nonsense", "amiga:display:1", foreign] {
            for front in [None, front(SOURCE_WINDOW, 9001), front(1, OWN_PID)] {
                let focus = source_focus(Some(id), front, OWN_PID, on_screen(), shown());
                assert!(!focus.focused, "{id:?}");
                assert!(!focus.present, "{id:?}");
                assert!(!focus.held, "{id:?}");
            }
        }
    }

    #[test]
    fn no_source_at_all_shows_rather_than_hides() {
        let focus = source_focus(None, front(1, 9001), OWN_PID, None, SourceFocus::default());
        assert!(focus.focused);
        assert!(focus.present);
    }

    #[test]
    fn the_unknown_state_shows_text_rather_than_hiding_it_forever() {
        // What the view starts with, before the first sample. The reader chose the
        // source; hiding everything until something unrelated happens is the failure
        // this default exists to avoid.
        let unknown = SourceFocus::default();
        assert!(unknown.focused);
        assert!(unknown.present);
    }
}

#[cfg(test)]
mod pointer_tests {
    use super::*;

    fn region(x: f64, y: f64, focus: bool) -> Region {
        Region {
            x,
            y,
            width: 100.,
            height: 40.,
            focus,
        }
    }

    /// The overlay owns a word it drew; a separate window owns the dictionary popup
    /// that opened over it. Two windows, one desktop.
    fn desktop() -> Regions {
        Regions::from([
            ("overlay".to_string(), vec![region(200., 500., true)]),
            ("popup-host".to_string(), vec![region(200., 300., true)]),
        ])
    }

    fn look(
        regions: &Regions,
        label: &str,
        x: f64,
        y: f64,
        down: bool,
        was: PointerHistory,
    ) -> PointerVerdict {
        classify_pointer(&regions[label], true, x, y, down, true, was)
    }

    /// The pointer has not moved since the previous sample.
    fn resting(
        regions: &Regions,
        label: &str,
        x: f64,
        y: f64,
        was: PointerHistory,
    ) -> PointerVerdict {
        classify_pointer(&regions[label], true, x, y, false, false, was)
    }

    #[test]
    fn a_press_inside_the_popup_is_interaction_not_a_dismissal() {
        // The whole of the original fault: with no rectangle for the popup, this
        // press went to the application underneath *and* closed the dictionary.
        let regions = desktop();
        assert!(!dismissed(&regions, &[], 250., 320., true, false));
        assert!(
            look(
                &regions,
                "popup-host",
                250.,
                320.,
                true,
                PointerHistory::default()
            )
            .interactive
        );
    }

    #[test]
    fn a_press_on_a_different_word_changes_the_lookup_rather_than_dismissing_it() {
        let regions = desktop();
        assert!(!dismissed(&regions, &[], 250., 520., true, false));
        assert!(
            look(
                &regions,
                "overlay",
                250.,
                520.,
                true,
                PointerHistory::default()
            )
            .interactive
        );
    }

    #[test]
    fn a_press_the_popup_owns_does_not_dismiss_even_though_the_overlay_does_not_own_it() {
        // The union is the rule. Asking only the overlay would close the dictionary
        // the moment it was clicked, because the popup belongs to another window.
        let regions = desktop();
        assert!(
            !look(
                &regions,
                "overlay",
                250.,
                320.,
                true,
                PointerHistory::default()
            )
            .interactive
        );
        assert!(!dismissed(&regions, &[], 250., 320., true, false));
    }

    #[test]
    fn a_press_on_bare_desktop_still_dismisses() {
        assert!(dismissed(&desktop(), &[], 900., 900., true, false));
    }

    #[test]
    fn holding_the_button_down_dismisses_once_not_every_frame() {
        let regions = desktop();
        let mut was_down = false;
        let mut dismissals = 0;
        for _ in 0..30 {
            dismissals += u32::from(dismissed(&regions, &[], 900., 900., true, was_down));
            was_down = true;
        }
        assert_eq!(dismissals, 1);
    }

    #[test]
    fn a_hidden_window_stops_claiming_its_rectangles() {
        // Hiding the overlay is a view flag, not a close: its rectangles are still
        // published, and a press over where its text used to be must dismiss.
        let regions = desktop();
        assert!(!dismissed(&regions, &[], 250., 520., true, false));
        assert!(dismissed(&regions, &["overlay"], 250., 520., true, false));
        assert!(!dismissed(&regions, &["overlay"], 250., 320., true, false));
    }

    #[test]
    fn a_drag_that_began_on_a_region_survives_leaving_it() {
        // Selecting text in the popup, or dragging its scrollbar, ends up outside.
        let regions = desktop();
        let was = PointerHistory {
            interactive: true,
            down: true,
            over_target: true,
        };
        let v = look(&regions, "popup-host", 5000., 5000., true, was);
        assert!(
            v.interactive,
            "the rest of the gesture belongs to the popup"
        );
        assert!(!dismissed(&regions, &[], 5000., 5000., true, true));
    }

    #[test]
    fn focus_is_taken_on_arrival_and_not_again_while_resting() {
        let regions = desktop();
        let first = look(
            &regions,
            "overlay",
            250.,
            520.,
            false,
            PointerHistory::default(),
        );
        assert!(
            first.take_focus,
            "arriving on a word must make the window key"
        );

        let mut was = PointerHistory {
            interactive: first.interactive,
            down: false,
            over_target: first.over_target,
        };
        for _ in 0..60 {
            let v = look(&regions, "overlay", 250., 520., false, was);
            assert!(!v.take_focus, "resting on a word must not re-take focus");
            was.over_target = v.over_target;
            was.interactive = v.interactive;
        }
    }

    #[test]
    fn moving_across_the_transparent_desktop_never_takes_focus() {
        let regions = desktop();
        let mut was = PointerHistory::default();
        for step in 0..200 {
            let v = look(
                &regions,
                "overlay",
                900. + f64::from(step),
                900.,
                false,
                was,
            );
            assert!(!v.take_focus);
            assert!(!v.interactive);
            was.over_target = v.over_target;
            was.interactive = v.interactive;
        }
    }

    #[test]
    fn the_region_select_drag_rectangle_is_not_a_focus_target() {
        // It covers the whole display: focusing on entry would mean focusing on any
        // pointer movement at all.
        let whole_display = vec![Region {
            x: 0.,
            y: 0.,
            width: 3440.,
            height: 1440.,
            focus: false,
        }];
        let v = classify_pointer(
            &whole_display,
            true,
            1000.,
            700.,
            false,
            true,
            PointerHistory::default(),
        );
        assert!(
            v.interactive,
            "the drag still needs every event on the display"
        );
        assert!(!v.take_focus);
    }

    #[test]
    fn leaving_and_returning_takes_focus_again() {
        let regions = desktop();
        let on = look(
            &regions,
            "overlay",
            250.,
            520.,
            false,
            PointerHistory::default(),
        );
        assert!(on.take_focus);
        let off = look(
            &regions,
            "overlay",
            900.,
            900.,
            false,
            PointerHistory {
                interactive: on.interactive,
                down: false,
                over_target: on.over_target,
            },
        );
        assert!(!off.take_focus);
        let back = look(
            &regions,
            "overlay",
            250.,
            520.,
            false,
            PointerHistory {
                interactive: off.interactive,
                down: false,
                over_target: off.over_target,
            },
        );
        assert!(back.take_focus);
    }

    #[test]
    fn a_hidden_window_owns_nothing_and_focuses_nothing() {
        let regions = desktop();
        let v = classify_pointer(
            &regions["overlay"],
            false,
            250.,
            520.,
            true,
            true,
            PointerHistory::default(),
        );
        assert!(!v.interactive);
        assert!(!v.over_target);
        assert!(!v.take_focus);
    }

    #[test]
    fn region_edges_are_half_open_so_adjacent_rectangles_do_not_overlap() {
        let r = region(200., 500., true);
        assert!(r.contains(200., 500.));
        assert!(!r.contains(300., 540.));
        assert!(r.contains(299.9, 539.9));
    }

    #[test]
    fn unusable_rectangles_are_rejected() {
        assert!(region(0., 0., true).usable());
        for bad in [
            Region {
                width: 0.,
                ..region(0., 0., true)
            },
            Region {
                height: -1.,
                ..region(0., 0., true)
            },
            Region {
                x: f64::NAN,
                ..region(0., 0., true)
            },
            Region {
                y: f64::INFINITY,
                ..region(0., 0., true)
            },
        ] {
            assert!(!bad.usable());
        }
    }

    #[test]
    fn focus_defaults_off_for_a_payload_that_does_not_mention_it() {
        let parsed: Region =
            serde_json::from_str(r#"{"x":1,"y":2,"width":3,"height":4}"#).expect("region");
        assert!(!parsed.focus);
    }

    #[test]
    fn a_popup_opening_under_a_still_pointer_does_not_take_focus() {
        // The dictionary opens beside the word being read. If it lands under a
        // pointer that has not moved, the reader has not reached for it, and taking
        // the keyboard would stop them moving on to the next word.
        let regions = desktop();
        let v = resting(
            &regions,
            "popup-host",
            250.,
            320.,
            PointerHistory::default(),
        );
        assert!(v.over_target);
        assert!(!v.take_focus);

        // Moving onto it is the whole difference.
        let moved = look(
            &regions,
            "popup-host",
            251.,
            321.,
            false,
            PointerHistory::default(),
        );
        assert!(moved.take_focus);
    }

    #[test]
    fn a_release_is_never_a_dismissal() {
        assert!(!dismissed(&desktop(), &[], 900., 900., false, true));
        assert!(!dismissed(&desktop(), &[], 900., 900., false, false));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image() -> Image {
        Image::encoded(vec![1, 2, 3], Value::Null)
    }

    #[test]
    fn in_flight_frame_remains_publishable_when_a_new_candidate_arrives() {
        let mut images = Images::default();
        let in_flight = images.put_latest(image());
        assert!(images.pin_candidate(in_flight));
        let pending = images.put_latest(image());
        assert!(images.pin_candidate(pending));
        images.put_latest(image());
        assert!(
            images.frame(in_flight).is_some(),
            "OCR still owns the first frame"
        );
        assert!(
            images.pin_published(in_flight),
            "completed OCR must remain previewable"
        );
        assert!(images.release_candidate(in_flight));
        assert!(images.frame(pending).is_some());
    }

    #[test]
    fn live_preview_tracks_probes_without_revoking_ocr_or_picker_frames() {
        let mut images = Images::default();
        let published = images.put_latest(image());
        assert!(images.pin_published(published));
        let picker = images.put_preview(image());
        let first = images.live_preview().unwrap().0;
        let fresh = images.put_latest(image());
        assert_eq!(images.live_preview().unwrap().0, fresh);
        assert!(images.live_image(first).is_some());
        images.put_latest(image());
        images.live_preview();
        assert!(images.live_image(first).is_none());
        assert!(images.frame(published).is_some());
        assert!(images.preview(picker).is_some());
        assert_eq!(images.live_previews.len(), 2);
    }

    #[test]
    fn retaining_too_many_frames_refuses_without_revoking_existing_owners() {
        let mut images = Images::default();
        for _ in 0..MAX_RETAINED_FRAMES {
            let id = images.put_latest(image());
            assert!(images.pin_candidate(id));
        }
        let refused = images.put_latest(image());
        assert!(!images.pin_candidate(refused));
        assert!(images.frame(1).is_some());
        assert!(images.release_candidate(1));
        assert!(images.pin_candidate(refused));
    }

    #[test]
    fn mining_frame_prefers_the_wanted_scan_then_the_published_then_the_latest() {
        let mut images = Images::default();
        assert_eq!(images.mining_frame(None), None, "nothing captured yet");
        assert_eq!(images.mining_frame(Some(7)), None);
        let first = images.put_latest(image());
        assert_eq!(images.mining_frame(None), Some((first, false)));
        assert_eq!(images.mining_frame(Some(first)), Some((first, true)));
        assert!(images.pin_published(first));
        let probe = images.put_latest(image());
        assert_eq!(
            images.mining_frame(None),
            Some((first, false)),
            "the frame whose text is on screen wins over a newer probe"
        );
        assert_eq!(images.mining_frame(Some(probe)), Some((probe, true)));
        images.put_latest(image());
        assert_eq!(
            images.mining_frame(Some(probe)),
            Some((first, false)),
            "an evicted scan falls back to the current frame"
        );
        images.clear();
        assert_eq!(images.mining_frame(Some(first)), None);
    }

    #[test]
    fn native_frame_pins_count_independent_owners() {
        let mut images = Images::default();
        let id = images.put_latest(image());
        assert!(images.pin_candidate(id));
        assert!(images.pin_candidate(id));
        images.put_latest(image());
        assert!(images.release_candidate(id));
        assert!(images.frame(id).is_some());
        assert!(images.release_candidate(id));
        assert!(images.frame(id).is_none());
    }

    #[test]
    fn observation_frames_encode_only_on_consumption_and_share_the_cached_png() {
        let frame = kimochi_capture::Frame {
            info: kimochi_capture::FrameInfo {
                source_id: "fixture".into(),
                width: 2,
                height: 2,
                stride: 8,
                full_width: 2,
                full_height: 2,
                crop_pixels: [0, 0, 2, 2],
                scale_factor: 1.0,
                source_bounds: None,
                pixel_format: "rgba8",
                color_space: "srgb",
                resolve_ms: 0.0,
                acquisition_ms: 0.0,
                pixels_ms: 0.0,
                total_ms: 0.0,
            },
            pixels: vec![255; 16],
        };
        let image = Image::captured(frame, Value::Null);
        let reader = image.clone();
        assert!(
            image.png.get().is_none(),
            "storing a probe must not encode it"
        );
        let png = reader.png().unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert!(
            image.png.get().is_some(),
            "consumers share the one encoding"
        );
        drop(image);
        assert_eq!(
            reader.png().unwrap(),
            png,
            "reader retains its pixels independently"
        );
    }

    #[test]
    fn a_published_frame_survives_later_captures() {
        let mut images = Images::default();
        let published = images.put_latest(image());
        assert!(images.pin_published(published));
        // Change-detection probes that the hash discards must not evict it.
        for _ in 0..5 {
            images.put_latest(image());
        }
        assert!(
            images.frame(published).is_some(),
            "the Capture Preview's snapshot.scan.id must keep resolving"
        );
        // ...and the newest frame is still addressable too.
        let newest = images.put_latest(image());
        assert!(images.frame(newest).is_some());
        assert!(images.frame(published).is_some());
    }

    #[test]
    fn pinning_shares_bytes_rather_than_copying() {
        let mut images = Images::default();
        let id = images.put_latest(image());
        let before = Arc::as_ptr(images.frame(id).unwrap());
        images.pin_published(id);
        assert_eq!(before, Arc::as_ptr(images.frame(id).unwrap()));
    }

    #[test]
    fn pinning_an_unknown_frame_reports_failure() {
        let mut images = Images::default();
        assert!(!images.pin_published(999));
    }

    #[test]
    fn clear_releases_the_pinned_frame_too() {
        let mut images = Images::default();
        let id = images.put_latest(image());
        images.pin_published(id);
        images.clear();
        assert!(images.frame(id).is_none());
    }

    #[test]
    fn hover_preview_is_isolated_from_scan_frames() {
        let mut images = Images::default();
        let latest = images.put_latest(image());
        let picker = images.put_preview(image());
        let first = images.put_hover(image());
        let second = images.put_hover(image());
        assert!(
            images.hover_image(first).is_none(),
            "a replaced hover image must 404"
        );
        assert!(images.hover_image(second).is_some());
        assert!(
            images.frame(latest).is_some(),
            "a hover must not evict the latest frame"
        );
        assert!(
            images.preview(picker).is_some(),
            "a hover must not evict a picker preview"
        );
        assert_eq!(
            images.next_frame, latest,
            "a hover must not consume a frame id"
        );
    }

    #[test]
    fn previews_are_bounded_and_addressable() {
        let mut images = Images::default();
        let first = images.put_preview(image());
        for _ in 0..MAX_PREVIEWS {
            images.put_preview(image());
        }
        assert_eq!(images.previews.len(), MAX_PREVIEWS);
        // The oldest token has been evicted rather than served stale.
        assert!(images.preview(first).is_none());
        let newest = images.next_token;
        assert!(images.preview(newest).is_some());
    }

    #[test]
    fn an_unpinned_frame_only_answers_for_its_own_id() {
        let mut images = Images::default();
        let id = images.put_latest(image());
        assert!(images.frame(id).is_some());
        assert!(images.frame(id + 1).is_none());
        // Ids never repeat, so a stale url cannot resolve to a newer frame.
        let next = images.put_latest(image());
        assert_ne!(id, next);
        assert!(images.frame(id).is_none());
    }

    #[test]
    fn descriptor_prefers_app_then_title() {
        assert_eq!(
            descriptor_key("window", "Doc — Safari", Some("Safari")),
            "Safari"
        );
        assert_eq!(descriptor_key("window", "Doc", Some("   ")), "Doc");
        // Normalised, so this key matches whether it was minted from the native kind
        // or from a restored descriptor.
        assert_eq!(descriptor_key("display", "", None), "screen:unknown");
        assert_eq!(descriptor_key("screen", "", None), "screen:unknown");
    }

    #[test]
    fn display_is_reported_to_the_frontend_as_screen() {
        assert_eq!(descriptor_type("display"), "screen");
        assert_eq!(descriptor_type("window"), "window");
    }
}
