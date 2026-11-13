//! A game shown through a scaler: a separate program (Magpie, on Windows) that draws an enlarged
//! copy of the game's window over the screen while the game keeps running, unscaled, underneath.
//! Readers use one to play old visual novels full screen without exclusive full screen, which an
//! overlay cannot sit over.
//!
//! Kimochi still captures the game's own window, so OCR, hooks and crops see exactly what they see
//! without a scaler. What changes is *where the reader sees it*: every rectangle of the game's
//! window is drawn somewhere else, larger, and while the scaler hands the game the mouse, the
//! system cursor sits over the game's real window, not over the picture the reader is pointing at.
//! This is the arithmetic for both, as the scaler itself does it, in the raw desktop units the
//! scaler reports (physical pixels on Windows). The OS adapter reads the geometry
//! (`platform::windows::magpie`); nothing here touches the window server, so it is tested
//! everywhere.
// Only the Windows adapter (Magpie) uses this yet; the tests run everywhere.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]
use kimochi_capture::Rect;

/// One scaling session, as the scaler publishes it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scaling {
    /// The part of the game's window that is scaled (its client area, usually), in raw desktop
    /// units. Right and bottom are exclusive, as in a Win32 `RECT`.
    pub src: Edges,
    /// Where the scaled picture of `src` is drawn.
    pub dest: Edges,
    /// The scaler's whole window: `dest` plus any black bars around it.
    pub surface: Edges,
    /// Scaled in a window of its own, rather than over the whole display.
    pub windowed: bool,
}

/// A rectangle as left, top, right, bottom: the scaler's own spelling, kept so its rounding can be
/// followed exactly.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Edges {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl Edges {
    pub fn width(&self) -> f64 {
        self.right - self.left
    }
    pub fn height(&self) -> f64 {
        self.bottom - self.top
    }
    pub fn rect(&self) -> Rect {
        Rect { x: self.left, y: self.top, width: self.width(), height: self.height() }
    }
    pub fn of(rect: Rect) -> Edges {
        Edges { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height }
    }
    fn contains(&self, (x, y): (f64, f64)) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}

impl Scaling {
    /// Geometry a session can be used with: both rectangles have area. A scaler between frames
    /// can publish an empty one; using it would divide by zero.
    pub fn usable(&self) -> bool {
        self.src.width() >= 1. && self.src.height() >= 1. && self.dest.width() >= 1. && self.dest.height() >= 1.
    }

    /// Where a rectangle of the game's window appears on screen. The picture is `src` stretched
    /// onto `dest`, so edges map linearly; the parts of the window outside `src` (a title bar)
    /// land outside `dest`, where nothing is drawn, which keeps the mapping one stretch for the
    /// whole frame a capture returns.
    pub fn show_rect(&self, rect: Rect) -> Rect {
        let sx = self.dest.width() / self.src.width();
        let sy = self.dest.height() / self.src.height();
        Rect {
            x: self.dest.left + (rect.x - self.src.left) * sx,
            y: self.dest.top + (rect.y - self.src.top) * sy,
            width: rect.width * sx,
            height: rect.height * sy,
        }
    }

    /// Where the reader sees the cursor while the scaler has handed it to the game, and so to the
    /// game's real (unscaled, hidden) window: Magpie's own `SrcToScaling`. The first and last
    /// pixels of `src` map to the first and last of `dest`, which is why this is not `show_rect`
    /// applied to a point; outside `src` the distance is kept unscaled.
    pub fn show_cursor(&self, (x, y): (f64, f64)) -> (f64, f64) {
        let axis = |p: f64, from_lo: f64, from_hi: f64, to_lo: f64, to_hi: f64| -> f64 {
            if p >= from_hi {
                to_hi + p - from_hi
            } else if p < from_lo {
                to_lo + p - from_lo
            } else {
                let span = (from_hi - from_lo - 1.).max(1.);
                ((p - from_lo) / span * (to_hi - to_lo - 1.)).round() + to_lo
            }
        };
        (
            axis(x, self.src.left, self.src.right, self.dest.left, self.dest.right),
            axis(y, self.src.top, self.src.bottom, self.dest.top, self.dest.bottom),
        )
    }

    /// Magpie's `ScalingToSrc`: the game's pixel under a point of the picture, which `show_cursor`
    /// must agree with (the e2e harness moves the pointer by it too: `scripts/e2e-windows`).
    #[cfg(test)]
    pub fn game_point(&self, (x, y): (f64, f64)) -> (f64, f64) {
        let axis = |p: f64, lo: f64, hi: f64, src_lo: f64, src_hi: f64| -> f64 {
            if p >= hi {
                src_hi + p - hi
            } else if p < lo {
                src_lo + p - lo
            } else {
                let span = (hi - lo - 1.).max(1.);
                src_lo + ((p - lo) / span * (src_hi - src_lo - 1.)).round()
            }
        };
        (
            axis(x, self.dest.left, self.dest.right, self.src.left, self.src.right),
            axis(y, self.dest.top, self.dest.bottom, self.src.top, self.src.bottom),
        )
    }

    /// Whether the cursor, at a point the scaler reports, is over the game's real window rather
    /// than over the picture: it can only be while scaling has it (`src`, give or take a pixel the
    /// scaler's clip allows), so a point far outside cannot be a captured one.
    pub fn in_src(&self, point: (f64, f64)) -> bool {
        let grown = Edges {
            left: self.src.left - 1.,
            top: self.src.top - 1.,
            right: self.src.right + 1.,
            bottom: self.src.bottom + 1.,
        };
        grown.contains(point)
    }

    /// The display this session fills, when it scales full screen: the one its surface covers.
    pub fn fills(&self, displays: &[Rect]) -> Option<Rect> {
        if self.windowed {
            return None;
        }
        let surface = self.surface.rect();
        displays.iter().copied().find(|display| super::covers_display(surface, *display))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn same(a: Rect, b: Rect) -> bool {
        (a.x, a.y, a.width, a.height) == (b.x, b.y, b.width, b.height)
    }

    fn edges(left: f64, top: f64, right: f64, bottom: f64) -> Edges {
        Edges { left, top, right, bottom }
    }

    /// The fake game's 1001×701 client scaled onto a 6880×2880 display, as Magpie did it on the
    /// development machine: 4108 wide, centred, black bars either side.
    fn full_screen() -> Scaling {
        Scaling {
            src: edges(138., 121., 1139., 822.),
            dest: edges(1386., 0., 5494., 2880.),
            surface: edges(0., 0., 6880., 2880.),
            windowed: false,
        }
    }

    #[test]
    fn a_window_rectangle_is_shown_stretched_onto_the_picture() {
        let s = full_screen();
        let client = s.show_rect(s.src.rect());
        assert!(same(client, s.dest.rect()));
        // A word 28 px tall at (50, 536) in the client is 115 px tall on screen.
        let word = s.show_rect(Rect { x: 188., y: 657., width: 56., height: 28. });
        let sy = 2880. / 701.;
        assert!((word.height - 28. * sy).abs() < 1e-9);
        assert!((word.y - 536. * sy).abs() < 1e-9);
        // The title bar above the client lands above the picture, off the top of the display.
        let frame = s.show_rect(Rect { x: 130., y: 90., width: 1017., height: 740. });
        assert!(frame.y < 0. && frame.x < s.dest.left);
    }

    #[test]
    fn the_cursor_maps_first_and_last_pixels_as_magpie_does() {
        let s = full_screen();
        assert_eq!(s.show_cursor((138., 121.)), (1386., 0.));
        assert_eq!(s.show_cursor((1138., 821.)), (5493., 2879.));
        // Outside the scaled area the offset is kept unscaled.
        assert_eq!(s.show_cursor((1139., 821.)), (5494., 2879.));
        assert_eq!(s.show_cursor((128., 121.)), (1376., 0.));
        // And back: each game pixel's shown position leads to that pixel again.
        for x in (138..1139).step_by(37) {
            for y in (121..822).step_by(29) {
                let shown = s.show_cursor((f64::from(x), f64::from(y)));
                assert_eq!(s.game_point(shown), (f64::from(x), f64::from(y)));
            }
        }
    }

    #[test]
    fn only_points_over_the_game_can_be_a_captured_cursor() {
        let s = full_screen();
        assert!(s.in_src((138., 121.)) && s.in_src((1138., 821.)) && s.in_src((1139., 822.)));
        assert!(!s.in_src((3000., 1500.)));
    }

    #[test]
    fn full_screen_scaling_fills_the_display_its_surface_covers() {
        let s = full_screen();
        let displays = [
            Rect { x: -1920., y: 0., width: 1920., height: 1080. },
            Rect { x: 0., y: 0., width: 6880., height: 2880. },
        ];
        assert!(s.fills(&displays).is_some_and(|d| same(d, displays[1])));
        assert!(Scaling { windowed: true, ..s }.fills(&displays).is_none());
    }

    #[test]
    fn empty_geometry_is_not_used() {
        assert!(full_screen().usable());
        assert!(!Scaling { dest: edges(0., 0., 0., 0.), ..full_screen() }.usable());
    }
}
