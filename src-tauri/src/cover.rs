//! Whether one of Kimochi's own windows covers the text drawn over the captured window.
//!
//! While the reader is in Kimochi itself (the main window, mini mode, Settings…), the
//! scanned text stays on screen as long as none of those windows is on top of it: Kimochi
//! on another monitor, tucked in a corner in mini mode, or moved aside on the same screen.
//! The moment one of them overlaps a line of text, the text goes, as it would for any other
//! application in front of the game.
//!
//! Both sides of the comparison are cached here and kept current by events, never by
//! polling the window server:
//!
//!  - **Kimochi's window frames** are noted by `panels.rs` from each window's own
//!    move, resize, focus, minimise, show and hide;
//!  - **the overlay's text boxes** are published by the overlay (`overlay_text_boxes`)
//!    whenever the text or where it sits changes, *whether or not it is drawn*. Hidden text
//!    has to keep reporting where it would be, or hiding it would make it uncovered and
//!    bring it straight back.
//!
//! Both are in desktop points (see `platform::DesktopGeometry`), the one space where a
//! window on a Retina display, one on a 150 % Windows monitor and a monitor to the left
//! of the primary (negative origin) can be compared directly.
//!
//! A change that flips the answer wakes the focus watch, so the text goes the moment a
//! window is dragged onto it and comes back the moment it is dragged off, rather than at
//! the watch's next tick.
use kimochi_capture::Rect;
use std::{
    collections::BTreeMap,
    sync::{Condvar, Mutex},
    time::Duration,
};

/// Kimochi's ordinary windows: the ones that, focused, put the reader "in Kimochi" (the
/// same set `gamepad::panel_focus` tracks). The overlay and the dictionary pop-up are
/// deliberately absent: they are *meant* to sit over the text, and while one of them is
/// in front the previous answer is held anyway (`state::source_focus`).
pub const COVERING: &[&str] = &["log", "settings", "diagnostics", "dictionary", "welcome"];

/// The most text boxes kept. A page of dense text is a few hundred words; anything past
/// this is a malformed payload, not a reason to compare more rectangles.
const MAX_TEXT_BOXES: usize = 2000;

/// Slack around each text box, in desktop points. Grouped text is drawn with padding and
/// a border outside the recognised box, and a window frame that stops a few points short
/// of a word still sits on top of what is drawn around it.
pub const TEXT_MARGIN: f64 = 8.;

/// One of Kimochi's windows, as last seen.
#[derive(Clone, Copy, Debug)]
pub struct OwnFrame {
    /// Its frame in desktop points, or `None` when it could not be read. A visible
    /// window whose frame is unknown counts as covering: hiding text for a moment is
    /// better than drawing it over a window the reader is using.
    pub bounds: Option<Rect>,
    pub visible: bool,
    pub minimized: bool,
}

impl OwnFrame {
    /// Whether this window is on screen at all. Hidden and minimised windows have a
    /// frame (on Windows a minimised one sits at -32000), but nothing of them is there.
    fn on_screen(&self) -> bool {
        self.visible && !self.minimized
    }
}

fn finite(r: &Rect) -> bool {
    [r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite()) && r.width > 0. && r.height > 0.
}

/// Whether two rectangles share any area. Touching edges do not count: a window placed
/// flush against a line of text is beside it, not over it.
pub fn intersects(a: &Rect, b: &Rect) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

fn padded(r: &Rect, margin: f64) -> Rect {
    Rect {
        x: r.x - margin,
        y: r.y - margin,
        width: r.width + 2. * margin,
        height: r.height + 2. * margin,
    }
}

/// Whether any of Kimochi's windows on screen covers any of the overlay's text boxes.
///
/// `reliable` is the platform's word that window frames mean what they say
/// (`platform::own_frames_reliable`). Where they do not — gamescope, which composites
/// Kimochi full screen over the game whatever its X11 frame says, and Wayland, which
/// never reports where a window is — every frame is taken to cover the text, which is
/// exactly the behaviour from before this rule existed.
///
/// No text at all is never covered: there is nothing to hide, and an empty overlay
/// staying "shown" is what lets the next scan appear without a focus change.
pub fn covers_text<'a>(
    frames: impl IntoIterator<Item = &'a OwnFrame>,
    text: &[Rect],
    reliable: bool,
) -> bool {
    let text: Vec<Rect> = text.iter().filter(|r| finite(r)).map(|r| padded(r, TEXT_MARGIN)).collect();
    if text.is_empty() {
        return false;
    }
    frames.into_iter().filter(|f| f.on_screen()).any(|frame| {
        if !reliable {
            return true;
        }
        match frame.bounds {
            Some(bounds) if finite(&bounds) => text.iter().any(|t| intersects(&bounds, t)),
            // A zero-sized frame covers nothing; an unreadable one is assumed to.
            Some(_) => false,
            None => true,
        }
    })
}

static FRAMES: Mutex<BTreeMap<String, OwnFrame>> = Mutex::new(BTreeMap::new());
static TEXT: Mutex<Vec<Rect>> = Mutex::new(Vec::new());
static WAKE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

fn frames_lock() -> std::sync::MutexGuard<'static, BTreeMap<String, OwnFrame>> {
    FRAMES.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn text_lock() -> std::sync::MutexGuard<'static, Vec<Rect>> {
    TEXT.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Wakes the focus watch so it re-evaluates now rather than at its next tick.
pub fn wake() {
    let (flag, signal) = &WAKE;
    *flag.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
    signal.notify_all();
}

/// Sleeps for up to `timeout`, returning early when something here changed.
pub fn wait(timeout: Duration) {
    let (flag, signal) = &WAKE;
    let guard = flag.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (mut woken, _) = signal
        .wait_timeout_while(guard, timeout, |woken| !*woken)
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *woken = false;
}

/// Applies a change and wakes the focus watch only if it flips the answer: a window being
/// dragged moves dozens of times a second, and only crossing onto or off the text matters.
fn changing(apply: impl FnOnce()) {
    let before = covered_now();
    apply();
    if covered_now() != before {
        wake();
    }
}

fn store(label: &str, frame: OwnFrame) {
    changing(|| {
        frames_lock().insert(label.to_owned(), frame);
    });
}

/// Reads one of Kimochi's windows as it is now. Called from that window's own events
/// (move, resize, focus, minimise), on the main thread where AppKit wants it.
pub fn note(window: &tauri::WebviewWindow) {
    let label = window.label();
    if !COVERING.contains(&label) {
        return;
    }
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let bounds = if visible && !minimized {
        crate::platform::desktop_bounds(window).ok()
    } else {
        None
    };
    store(
        label,
        OwnFrame {
            bounds,
            visible,
            minimized,
        },
    );
}

/// A window that was just hidden, minimised or destroyed. Recorded without asking the
/// window, which may not have caught up with the request yet.
pub fn note_gone(label: &str) {
    if !COVERING.contains(&label) {
        return;
    }
    store(
        label,
        OwnFrame {
            bounds: None,
            visible: false,
            minimized: false,
        },
    );
}

/// The overlay's text boxes, in desktop points.
pub fn set_text(rects: Vec<Rect>) {
    let rects: Vec<Rect> = rects.into_iter().filter(finite).take(MAX_TEXT_BOXES).collect();
    changing(|| *text_lock() = rects);
}

/// Whether one of Kimochi's windows covers the overlay's text right now, from the cache.
pub fn covered_now() -> bool {
    let frames: Vec<OwnFrame> = frames_lock().values().copied().collect();
    covers_text(&frames, &text_lock(), crate::platform::own_frames_reliable())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::{DesktopGeometry, DesktopUnit, DisplayInfo};

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn shown(bounds: Rect) -> OwnFrame {
        OwnFrame {
            bounds: Some(bounds),
            visible: true,
            minimized: false,
        }
    }

    /// Two lines of text in a game window at the left of a 1728×1117 display.
    fn text() -> Vec<Rect> {
        vec![rect(200., 700., 600., 40.), rect(200., 760., 480., 40.)]
    }

    #[test]
    fn a_window_over_a_line_of_text_covers_it() {
        let main = shown(rect(500., 600., 900., 560.));
        assert!(covers_text(&[main], &text(), true));
    }

    #[test]
    fn a_window_moved_aside_on_the_same_screen_does_not() {
        let main = shown(rect(900., 40., 800., 560.));
        assert!(!covers_text(&[main], &text(), true));
    }

    #[test]
    fn mini_mode_tucked_in_a_corner_does_not() {
        let mini = shown(rect(1728. - 340., 1117. - 220., 320., 200.));
        assert!(!covers_text(&[mini], &text(), true));
    }

    #[test]
    fn a_window_on_another_monitor_does_not() {
        // A second display to the right, and one to the left with a negative origin.
        let right = shown(rect(1728. + 100., 200., 900., 560.));
        let left = shown(rect(-1440. + 100., 200., 900., 560.));
        assert!(!covers_text(&[right, left], &text(), true));
    }

    #[test]
    fn text_on_a_monitor_left_of_the_primary_is_compared_in_the_same_space() {
        // Text on a display with a negative origin, under a window on that display.
        let text = [rect(-1200., 300., 400., 40.)];
        assert!(covers_text(&[shown(rect(-1300., 250., 300., 200.))], &text, true));
        assert!(!covers_text(&[shown(rect(100., 250., 300., 200.))], &text, true));
    }

    #[test]
    fn a_full_screen_window_covers_everything_on_its_display() {
        // Kimochi full screen (or on Steam Deck, filling the screen) is caught by the
        // same rule, with nothing special about it.
        let full = shown(rect(0., 0., 1728., 1117.));
        assert!(covers_text(&[full], &text(), true));
    }

    #[test]
    fn hidden_and_minimised_windows_are_ignored() {
        let over = rect(500., 600., 900., 560.);
        let hidden = OwnFrame {
            bounds: Some(over),
            visible: false,
            minimized: false,
        };
        let minimised = OwnFrame {
            bounds: Some(over),
            visible: true,
            minimized: true,
        };
        assert!(!covers_text(&[hidden, minimised], &text(), true));
        // Windows parks a minimised window at -32000; that must not count either way.
        let parked = OwnFrame {
            bounds: Some(rect(-32000., -32000., 160., 28.)),
            visible: true,
            minimized: true,
        };
        assert!(!covers_text(&[parked], &text(), true));
    }

    #[test]
    fn any_one_window_covering_is_enough() {
        let aside = shown(rect(900., 40., 800., 500.));
        let settings = shown(rect(150., 650., 400., 300.));
        assert!(covers_text(&[aside, settings], &text(), true));
    }

    #[test]
    fn touching_edges_and_the_margin() {
        let line = [rect(200., 700., 600., 40.)];
        // Further than the margin from the text: beside it.
        assert!(!covers_text(&[shown(rect(800. + TEXT_MARGIN + 1., 0., 300., 1000.))], &line, true));
        // Within the margin: on top of the padding drawn around the text.
        assert!(covers_text(&[shown(rect(800. + TEXT_MARGIN - 1., 0., 300., 1000.))], &line, true));
    }

    #[test]
    fn no_text_is_never_covered() {
        let full = shown(rect(0., 0., 1728., 1117.));
        assert!(!covers_text(&[full], &[], true));
        assert!(!covers_text(&[full], &[], false));
        // Malformed boxes are not text.
        let bad = [rect(f64::NAN, 0., 10., 10.), rect(0., 0., 0., 10.)];
        assert!(!covers_text(&[full], &bad, true));
    }

    #[test]
    fn an_unreadable_frame_is_assumed_to_cover() {
        let unknown = OwnFrame {
            bounds: None,
            visible: true,
            minimized: false,
        };
        assert!(covers_text(&[unknown], &text(), true));
    }

    #[test]
    fn where_frames_are_unreliable_any_visible_window_covers() {
        // gamescope and Wayland: the previous behaviour, whatever the frame says.
        let aside = shown(rect(1728. + 100., 200., 900., 560.));
        assert!(covers_text(&[aside], &text(), false));
        // But nothing on screen still covers nothing.
        let hidden = OwnFrame {
            visible: false,
            ..aside
        };
        assert!(!covers_text(&[hidden], &text(), false));
    }

    fn display(id: u32, bounds: Rect, scale: f64) -> DisplayInfo {
        DisplayInfo {
            id,
            source_id: format!("test:display:{id}"),
            bounds,
            work_area: bounds,
            scale_factor: scale,
        }
    }

    #[test]
    fn physical_frames_on_scaled_monitors_are_compared_in_desktop_points() {
        // Windows: a 100 % primary (1920×1080 px) and a 150 % monitor to its right
        // (2880×1620 px = 1920×1080 pt). Window frames arrive in physical pixels and the
        // overlay's text in desktop points; the frame is converted before comparing.
        let geometry = DesktopGeometry::new(
            DesktopUnit::PhysicalPixels,
            vec![
                display(1, rect(0., 0., 1920., 1080.), 1.),
                display(2, rect(1920., 0., 2880., 1620.), 1.5),
            ],
        );
        // Text on the 150 % monitor, at desktop points (2120..2520, 300..340).
        let text = [rect(2120., 300., 400., 40.)];

        // 300 px into the 150 % monitor and 600 px wide is 200..600 pt in: over the text.
        let over = geometry.rect_to_desktop(rect(1920. + 300., 300., 600., 300.));
        assert!((over.x - 2120.).abs() < 1e-9 && (over.width - 400.).abs() < 1e-9);
        assert!(covers_text(&[shown(over)], &text, true));

        // 700 px in is 2386 pt: still over the text, though the raw numbers (2620 px)
        // would put it to the right of it if they were taken for points.
        let raw = rect(1920. + 700., 300., 300., 300.);
        assert!(!covers_text(&[shown(raw)], &text, true));
        assert!(covers_text(&[shown(geometry.rect_to_desktop(raw))], &text, true));

        // Physical y 600 is 400 pt down: below the line.
        let below = geometry.rect_to_desktop(rect(1920. + 300., 600., 600., 300.));
        assert!((below.y - 400.).abs() < 1e-9);
        assert!(!covers_text(&[shown(below)], &text, true));

        // A window on the 100 % primary, physically left of the text, is not over it.
        let primary = geometry.rect_to_desktop(rect(1000., 280., 900., 200.));
        assert!(!covers_text(&[shown(primary)], &text, true));
    }

    #[test]
    fn retina_points_are_not_scaled() {
        // macOS: frames and text are both points, and a 2× backing scale never enters into it.
        let geometry = DesktopGeometry::new(
            DesktopUnit::Points,
            vec![display(1, rect(0., 0., 1728., 1117.), 2.)],
        );
        let frame = geometry.rect_to_desktop(rect(900., 40., 800., 560.));
        assert_eq!((frame.x, frame.y, frame.width, frame.height), (900., 40., 800., 560.));
        assert!(!covers_text(&[shown(frame)], &text(), true));
    }
}
