//! A window source's content area, as the crop it starts with (#235).
//!
//! A window's frame (its title bar, the title and the buttons in it, the frame around it) is not
//! something anyone reads, but OCR of the whole window reads it: a game's minimise and maximise
//! glyphs came out as 「一口」 and reached the Log. So when a window becomes the source and the
//! reader never decided a crop for it, it starts cropped to its content area
//! (`sources::select_keeping_crop`; `sources::adopt_content_crop` when it goes full screen or
//! comes back). A crop the reader saved or cleared is never replaced (`sources::crop_decided`).
//!
//! Each OS says where a window's content is with `platform::window_content`: the frame exactly as
//! it is captured, and the content area, in the same raw desktop units. Windows asks USER for the
//! client area; macOS measures the title bar through Accessibility; Linux leaves it (see there).
//! Everything after that is the geometry here, shared and tested on every OS: a crop relative to
//! the captured frame, with the frame's own size as its reference, which `kimochi_capture::crop_rect`
//! scales to whatever size the frames come in (Retina, a Windows frame in physical pixels).
//!
//! A window without decorations (borderless, a game in borderless full screen, a full-screen
//! Space on macOS) reports content that is its whole frame, and gets no crop: the whole window is
//! read, as before.
use crate::platform;
use kimochi_capture::{Crop, Rect, SourceId};

/// A top inset this small (in the frame's units) is a border, not a title bar: Windows 11 draws a
/// one-pixel border around a window's client area, which is four physical pixels at 400 %.
/// Without a title bar above the content nothing is cropped, whatever the sides: a borderless
/// window, or one drawing its own title bar inside its client area (Windows 11's Notepad,
/// browsers), whose content the OS cannot tell apart from that title bar.
const BORDER: f64 = 4.;

/// The content must cover at least this much of the frame in each direction. A title bar and a
/// frame take a few dozen pixels; a "client area" much smaller than its window is a window doing
/// something else (or geometry read mid-resize), and cropping to it would hide what it shows.
const MIN_SHARE: f64 = 0.5;

/// The crop that starts window source `id` at its content area, or `None` when the whole window
/// is its content, or the OS cannot say.
pub fn content_crop(id: &SourceId) -> Option<Crop> {
    if !id.is_window() {
        return None;
    }
    let (frame, content) = platform::window_content(id)?;
    crop_for(frame, content)
}

/// The crop of a window `frame` that keeps only its `content`, both in the same desktop units.
/// Rounded inwards to whole units, so no row of the title bar is kept at a fractional scale.
pub fn crop_for(frame: Rect, content: Rect) -> Option<Crop> {
    let finite = [frame.x, frame.y, frame.width, frame.height, content.x, content.y, content.width, content.height];
    if finite.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let (reference_width, reference_height) = (frame.width.round(), frame.height.round());
    if reference_width < 1. || reference_height < 1. {
        return None;
    }
    // The content, relative to the frame and inside it.
    let left = (content.x - frame.x).max(0.).ceil();
    let top = (content.y - frame.y).max(0.).ceil();
    let right = (content.x + content.width - frame.x).min(reference_width).floor();
    let bottom = (content.y + content.height - frame.y).min(reference_height).floor();
    let (width, height) = (right - left, bottom - top);
    if width < reference_width * MIN_SHARE || height < reference_height * MIN_SHARE {
        return None;
    }
    if top <= BORDER {
        return None;
    }
    Some(Crop {
        x: left as u32,
        y: top as u32,
        width: width as u32,
        height: height as u32,
        reference_width: reference_width as u32,
        reference_height: reference_height as u32,
    })
}

/// How tall a macOS window's title bar is, from where its close button sits in it: AppKit centres
/// the traffic lights vertically in the title bar (or in the unified toolbar, which is the title
/// bar of such a window), so the bar is the button's height plus twice its distance from the
/// window's top. That follows the window's style and the macOS version (a plain title bar is
/// 28 points with 14-point buttons 7 points down; a unified toolbar is taller) without a table
/// of either. `None` when the button is not where a title bar's would be.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn title_bar_height(window: Rect, close: Rect) -> Option<f64> {
    let offset = close.y - window.y;
    let inside = close.x >= window.x && close.x + close.width <= window.x + window.width;
    if !inside || offset < 0. || close.height <= 0. {
        return None;
    }
    let height = (2. * offset + close.height).round();
    (height <= window.height * (1. - MIN_SHARE)).then_some(height)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }

    fn crop(x: u32, y: u32, width: u32, height: u32, reference_width: u32, reference_height: u32) -> Crop {
        Crop { x, y, width, height, reference_width, reference_height }
    }

    fn same(a: Option<Crop>, b: Option<Crop>) -> bool {
        let key = |c: Crop| (c.x, c.y, c.width, c.height, c.reference_width, c.reference_height);
        a.map(key) == b.map(key)
    }

    #[test]
    fn a_titled_windows_11_window_loses_its_title_bar_and_border() {
        // DWM's visible frame, and the client area 31 px down inside a one-pixel border.
        let frame = rect(100., 200., 1282., 752.);
        let content = rect(101., 231., 1280., 720.);
        assert!(same(crop_for(frame, content), Some(crop(1, 31, 1280, 720, 1282, 752))));
    }

    #[test]
    fn a_window_on_a_monitor_left_of_the_primary_keeps_the_same_offsets() {
        let frame = rect(-1600., -100., 1282., 752.);
        let content = rect(-1599., -69., 1280., 720.);
        assert!(same(crop_for(frame, content), Some(crop(1, 31, 1280, 720, 1282, 752))));
    }

    #[test]
    fn a_window_with_a_menu_bar_starts_below_the_menu_too() {
        // Notepad-style: caption and menu bar are both outside the client area.
        let frame = rect(0., 0., 1000., 800.);
        let content = rect(1., 51., 998., 748.);
        assert!(same(crop_for(frame, content), Some(crop(1, 51, 998, 748, 1000, 800))));
    }

    #[test]
    fn a_maximised_window_loses_its_caption() {
        // Maximised: the visible frame is the work area, the caption is still there.
        let frame = rect(0., 0., 2560., 1392.);
        let content = rect(0., 23., 2560., 1369.);
        assert!(same(crop_for(frame, content), Some(crop(0, 23, 2560, 1369, 2560, 1392))));
    }

    #[test]
    fn a_borderless_or_full_screen_window_is_read_whole() {
        let frame = rect(0., 0., 1920., 1080.);
        assert!(crop_for(frame, frame).is_none());
        // A border of a pixel or two is not decorations, nor is one of 1 px at 300 %.
        assert!(crop_for(rect(10., 10., 802., 602.), rect(11., 11., 800., 600.)).is_none());
        assert!(crop_for(rect(0., 0., 1206., 906.), rect(3., 3., 1200., 900.)).is_none());
    }

    #[test]
    fn a_window_drawing_its_own_title_bar_is_read_whole() {
        // Windows 11's Notepad at 300 %: the client area reaches the top, inside a 3 px border.
        let frame = rect(801., 474., 2850., 1389.);
        let content = rect(804., 474., 2844., 1386.);
        assert!(crop_for(frame, content).is_none());
    }

    #[test]
    fn content_reaching_outside_the_frame_is_kept_inside_it() {
        // A maximised window's client area can overhang the visible frame.
        let frame = rect(0., 0., 1920., 1040.);
        let content = rect(-8., 23., 1936., 1025.);
        assert!(same(crop_for(frame, content), Some(crop(0, 23, 1920, 1017, 1920, 1040))));
    }

    #[test]
    fn fractional_points_round_inwards() {
        // A macOS window at a fractional origin: never keep a partial row of title bar.
        let frame = rect(10.5, 20.25, 800., 628.);
        let content = rect(10.5, 48.25, 800., 600.);
        assert!(same(crop_for(frame, content), Some(crop(0, 28, 800, 600, 800, 628))));
        let content = rect(10.5, 48.75, 800., 599.5);
        let c = crop_for(frame, content).unwrap();
        assert_eq!((c.y, c.y + c.height), (29, 628));
    }

    #[test]
    fn a_client_area_much_smaller_than_its_window_is_not_trusted() {
        let frame = rect(0., 0., 1000., 800.);
        assert!(crop_for(frame, rect(0., 30., 400., 770.)).is_none());
        assert!(crop_for(frame, rect(0., 500., 1000., 300.)).is_none());
        // Outside the frame altogether (stale geometry), or nothing at all.
        assert!(crop_for(frame, rect(2000., 0., 1000., 800.)).is_none());
        assert!(crop_for(frame, rect(0., 0., 0., 0.)).is_none());
    }

    #[test]
    fn degenerate_frames_have_no_crop() {
        assert!(crop_for(rect(0., 0., 0., 0.), rect(0., 0., 0., 0.)).is_none());
        assert!(crop_for(rect(0., 0., f64::NAN, 10.), rect(0., 0., 10., 10.)).is_none());
    }

    #[test]
    fn every_crop_is_one_capture_accepts() {
        let cases = [
            (rect(100., 200., 1282., 752.), rect(101., 231., 1280., 720.)),
            (rect(0., 0., 2560., 1392.), rect(0., 23., 2560., 1369.)),
            (rect(10.5, 20.25, 800., 628.), rect(10.5, 48.75, 800., 599.5)),
        ];
        for (frame, content) in cases {
            let c = crop_for(frame, content).unwrap();
            // The frame arrives at its size, or at twice it (Retina): both are valid crops.
            for scale in [1, 2] {
                kimochi_capture::crop_rect(Some(c), c.reference_width * scale, c.reference_height * scale).unwrap();
            }
        }
    }

    #[test]
    fn a_macos_title_bar_is_as_tall_as_its_buttons_are_centred_in() {
        let window = rect(200., 100., 800., 628.);
        // A plain title bar: 14-point buttons 7 points down.
        assert_eq!(title_bar_height(window, rect(207., 107., 14., 14.)), Some(28.));
        // A unified toolbar: the buttons are centred in the taller bar.
        assert_eq!(title_bar_height(window, rect(220., 119., 14., 14.)), Some(52.));
        // Fractional offsets round to whole points.
        assert_eq!(title_bar_height(window, rect(207., 106.6, 14., 14.)), Some(27.));
    }

    #[test]
    fn a_close_button_out_of_place_says_nothing() {
        let window = rect(200., 100., 800., 628.);
        assert_eq!(title_bar_height(window, rect(207., 90., 14., 14.)), None);
        assert_eq!(title_bar_height(window, rect(100., 107., 14., 14.)), None);
        assert_eq!(title_bar_height(window, rect(207., 107., 14., 0.)), None);
        // A "title bar" taller than half the window is not one.
        assert_eq!(title_bar_height(window, rect(207., 400., 14., 14.)), None);
    }

    /// Every window on this desktop, with its frame, content area and the crop it would start
    /// with. As the app sees them: Per-Monitor-V2 aware, as tao makes the app.
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "reads the live desktop: cargo test --bin kimochi window_content_probe -- --ignored --nocapture"]
    fn window_content_probe() {
        use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
        unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        for source in platform::picker_sources().unwrap() {
            let Some(id) = SourceId::parse(&source.id).filter(SourceId::is_window) else {
                continue;
            };
            println!("{} | {:?} | {:?}", source.name, platform::window_content(&id), content_crop(&id));
        }
    }

    #[test]
    fn a_macos_window_crop_keeps_its_content_below_the_title_bar() {
        let frame = rect(200., 100., 800., 628.);
        let height = title_bar_height(frame, rect(207., 107., 14., 14.)).unwrap();
        let content = rect(frame.x, frame.y + height, frame.width, frame.height - height);
        assert!(same(crop_for(frame, content), Some(crop(0, 28, 800, 600, 800, 628))));
    }
}
