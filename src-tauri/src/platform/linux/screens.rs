//! Shared screens on a layer-shell overlay (KDE Plasma, Hyprland, Sway and other wlroots
//! compositors).
//!
//! A layer surface covers one output, and Kimochi's overlay is one surface, so it can draw over one
//! output at a time. A shared screen is a rectangle of the compositor's global logical layout (a
//! portal monitor stream's position and size, or a native output's bounds). It may be any one
//! output, primary or not, or span several: KDE's "Full Workspace" share is every output at once.
//!
//! The overlay goes to the output holding the part of the screen being read: the saved crop's
//! centre, else the output it is already on, else the output with most of the screen. A frame's
//! `source_bounds` are then made relative to that output, the space the overlay draws in (as
//! `native.rs` and `kwin.rs` already do for windows). The region editor (`ui/wayland-screen-crop.js`)
//! uses [`layout`] to edit on whichever of the screen's outputs the pointer is over.
//!
//! A portal screen stream may come without a position: KDE's "Share full Workspace" stream has
//! only its size. Its shape says where it is (`assumed`): the whole workspace, or the only output.
//! A screen still without bounds (a virtual output, a region) is on no output the overlay can
//! cover: it keeps none, and the editor shows its picture instead.
use kimochi_capture::{Crop, Frame, Rect, SourceId};
use serde_json::{json, Value};

/// The part of `a` inside `b`, if any.
pub fn intersect(a: &Rect, b: &Rect) -> Option<Rect> {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let right = (a.x + a.width).min(b.x + b.width);
    let bottom = (a.y + a.height).min(b.y + b.height);
    (right - x >= 1. && bottom - y >= 1.).then_some(Rect { x, y, width: right - x, height: bottom - y })
}

fn contains(r: &Rect, (x, y): (f64, f64)) -> bool {
    x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height
}

fn same(a: &Rect, b: &Rect) -> bool {
    (a.x - b.x).abs() < 0.5 && (a.y - b.y).abs() < 0.5 && (a.width - b.width).abs() < 0.5 && (a.height - b.height).abs() < 0.5
}

/// The outputs showing some of `screen`.
pub fn outputs_of(screen: &Rect, outputs: &[Rect]) -> Vec<Rect> {
    outputs.iter().filter(|o| intersect(screen, o).is_some()).copied().collect()
}

/// Which of `screen`'s outputs the overlay should cover: the one holding `focus` (a point in the
/// global layout: the crop's centre), else `current` (where the overlay already is), else the one
/// with most of the screen. `None` when the screen is on no output.
pub fn choose(screen: &Rect, outputs: &[Rect], focus: Option<(f64, f64)>, current: Option<Rect>) -> Option<Rect> {
    let pieces = outputs_of(screen, outputs);
    if let Some(focus) = focus {
        if let Some(o) = pieces.iter().find(|o| contains(o, focus)) {
            return Some(*o);
        }
    }
    if let Some(current) = current {
        if let Some(o) = pieces.iter().find(|o| same(o, &current)) {
            return Some(*o);
        }
    }
    pieces.into_iter().max_by(|a, b| {
        let area = |o: &Rect| intersect(screen, o).map_or(0., |r| r.width * r.height);
        area(a).total_cmp(&area(b))
    })
}

/// The centre of a crop (frame pixels of `screen`'s reference size) in the global layout.
pub fn crop_centre(screen: &Rect, crop: &Crop) -> Option<(f64, f64)> {
    if crop.reference_width == 0 || crop.reference_height == 0 {
        return None;
    }
    let sx = screen.width / f64::from(crop.reference_width);
    let sy = screen.height / f64::from(crop.reference_height);
    Some((
        screen.x + (f64::from(crop.x) + f64::from(crop.width) / 2.) * sx,
        screen.y + (f64::from(crop.y) + f64::from(crop.height) / 2.) * sy,
    ))
}

/// `screen` relative to `output`'s origin.
pub fn relative(screen: &Rect, output: &Rect) -> Rect {
    Rect { x: screen.x - output.x, y: screen.y - output.y, ..*screen }
}

fn is_screen(source_id: &str) -> bool {
    matches!(SourceId::parse(source_id), Some(SourceId::Display { .. }))
}

/// The bounding box of every output: the whole workspace.
pub fn union(outputs: &[Rect]) -> Option<Rect> {
    let first = outputs.first()?;
    let (mut left, mut top, mut right, mut bottom) = (first.x, first.y, first.x + first.width, first.y + first.height);
    for o in &outputs[1..] {
        left = left.min(o.x);
        top = top.min(o.y);
        right = right.max(o.x + o.width);
        bottom = bottom.max(o.y + o.height);
    }
    Some(Rect { x: left, y: top, width: right - left, height: bottom - top })
}

/// Where a screen stream that came without a position is, from its shape: the only output, or,
/// with several, the whole workspace (KDE's "Share full Workspace" stream has a size in pixels and
/// no position). `None` for any other shape: a virtual screen, or a region, is never guessed.
pub fn assumed(width: u32, height: u32, outputs: &[Rect]) -> Option<Rect> {
    if width == 0 || height == 0 {
        return None;
    }
    let candidate = if outputs.len() == 1 { outputs[0] } else { union(outputs)? };
    let shape = (f64::from(width) / f64::from(height)) / (candidate.width / candidate.height);
    ((shape - 1.).abs() < 0.01).then_some(candidate)
}

/// A screen frame with no bounds (a portal stream without a position) given the ones its shape
/// says it has (`assumed`), with its scale to match. Global coordinates.
pub fn assume_bounds(frame: &mut Frame) {
    if frame.info.source_bounds.is_some() || !super::layer::available() || !frame.info.source_id.starts_with("portal:display:") {
        return;
    }
    if let Some(bounds) = assumed(frame.info.full_width, frame.info.full_height, &super::layer::outputs()) {
        frame.info.scale_factor = f64::from(frame.info.full_width) / bounds.width;
        frame.info.source_bounds = Some(bounds);
    }
}

/// Move the overlay to the output `choose` picks for this screen (when there is more than one
/// output) and return the screen's bounds relative to it.
fn place(screen: &Rect, crop: Option<&Crop>) -> Option<Rect> {
    let outputs = super::layer::outputs();
    let target = choose(screen, &outputs, crop.and_then(|c| crop_centre(screen, c)), super::layer::current_output())?;
    if outputs.len() > 1 {
        super::layer::follow_output(target);
    }
    Some(relative(screen, &target))
}

/// A captured screen frame's `source_bounds` (global, from capture-core) made relative to the
/// layer overlay's output, after moving the overlay to the output its crop is on. A screen on no
/// output the overlay can reach keeps no bounds: the overlay then fits its text to its own output.
pub fn enrich(frame: &mut Frame, crop: Option<&Crop>) {
    if !super::layer::available() || !is_screen(&frame.info.source_id) {
        return;
    }
    assume_bounds(frame);
    let Some(screen) = frame.info.source_bounds else {
        // Logged: the overlay then fits this screen's text to its own output.
        eprintln!("Wayland screens: {} has no place among {} outputs ({}x{})", frame.info.source_id, super::layer::outputs().len(), frame.info.full_width, frame.info.full_height);
        return;
    };
    frame.info.source_bounds = place(&screen, crop);
    if frame.info.source_bounds.is_none() {
        eprintln!("Wayland screens: {} at {screen:?} is on none of the outputs", frame.info.source_id);
    }
}

/// `layer_outputs` `list`: every output (global logical), the one the overlay is on, and the
/// pointer (global; `null` where no compositor bridge reports it).
pub fn layout() -> Value {
    let outputs = super::layer::outputs();
    let current = super::layer::current_output().or_else(|| (outputs.len() == 1).then(|| outputs[0]));
    let pointer = super::tracking::pointer_global().map(|(x, y)| json!({"x": x, "y": y}));
    json!({"outputs": outputs, "current": current, "pointer": pointer})
}

/// `layer_outputs` `move`: put the overlay on the output with this geometry. Whether it was moved
/// (false when it is there already, or no output has that geometry).
pub fn move_to(output: Rect) -> bool {
    super::layer::outputs().iter().any(|o| same(o, &output)) && super::layer::follow_output(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }
    const LEFT: Rect = Rect { x: 0., y: 0., width: 1920., height: 1080. };
    const RIGHT: Rect = Rect { x: 1920., y: 0., width: 2560., height: 1440. };

    #[test]
    fn a_secondary_screen_is_on_its_own_output() {
        let outputs = [LEFT, RIGHT];
        assert_eq!(outputs_of(&RIGHT, &outputs).len(), 1);
        let chosen = choose(&RIGHT, &outputs, None, Some(LEFT)).unwrap();
        assert!(same(&chosen, &RIGHT), "the overlay leaves the primary for the shared screen");
        let local = relative(&RIGHT, &chosen);
        assert_eq!((local.x, local.y, local.width, local.height), (0., 0., 2560., 1440.));
    }

    #[test]
    fn a_whole_workspace_follows_its_crop() {
        let outputs = [LEFT, RIGHT];
        let workspace = r(0., 0., 4480., 1440.);
        assert_eq!(outputs_of(&workspace, &outputs).len(), 2);
        // Frame pixels at 2x: a crop on the right-hand output.
        let crop = Crop { x: 5000, y: 200, width: 400, height: 100, reference_width: 8960, reference_height: 2880 };
        let centre = crop_centre(&workspace, &crop).unwrap();
        assert_eq!(centre, (2600., 125.));
        let chosen = choose(&workspace, &outputs, Some(centre), Some(LEFT)).unwrap();
        assert!(same(&chosen, &RIGHT));
        let local = relative(&workspace, &chosen);
        assert_eq!((local.x, local.y), (-1920., 0.));
    }

    #[test]
    fn without_a_crop_the_overlay_stays_or_takes_the_largest_part() {
        let outputs = [LEFT, RIGHT];
        let workspace = r(0., 0., 4480., 1440.);
        assert!(same(&choose(&workspace, &outputs, None, Some(LEFT)).unwrap(), &LEFT));
        assert!(same(&choose(&workspace, &outputs, None, None).unwrap(), &RIGHT));
        // A focus off every output (a stale crop) falls through as well.
        assert!(same(&choose(&workspace, &outputs, Some((-50., -50.)), Some(LEFT)).unwrap(), &LEFT));
    }

    #[test]
    fn a_screen_on_no_output_has_no_place() {
        let outputs = [LEFT, RIGHT];
        assert!(choose(&r(9000., 0., 1920., 1080.), &outputs, None, Some(LEFT)).is_none());
        assert!(choose(&LEFT, &[], None, None).is_none());
        // Touching edges share no pixels.
        assert!(intersect(&LEFT, &RIGHT).is_none());
    }

    #[test]
    fn negative_and_vertical_layouts() {
        let above = r(0., -1080., 1920., 1080.);
        let outputs = [LEFT, above];
        let chosen = choose(&above, &outputs, None, Some(LEFT)).unwrap();
        assert!(same(&chosen, &above));
        let local = relative(&above, &chosen);
        assert_eq!((local.x, local.y), (0., 0.));
    }

    #[test]
    fn a_stream_without_a_position_is_placed_by_its_shape() {
        let outputs = [LEFT, RIGHT];
        // KDE's full workspace: the bounding box of both outputs, in pixels (here at 2x).
        let workspace = assumed(8960, 2880, &outputs).unwrap();
        assert_eq!((workspace.x, workspace.y, workspace.width, workspace.height), (0., 0., 4480., 1440.));
        // One output's shape among several is not guessed (a virtual screen, a region).
        assert!(assumed(1920, 1080, &outputs).is_none());
        // Alone, an output of that shape is the screen.
        let only = assumed(3840, 2160, &[LEFT]).unwrap();
        assert!(same(&only, &LEFT));
        assert!(assumed(1080, 1920, &[LEFT]).is_none());
        assert!(assumed(0, 0, &[LEFT]).is_none());
        assert!(assumed(1920, 1080, &[]).is_none());
    }

    #[test]
    fn only_screens_are_placed() {
        assert!(is_screen("portal:display:57"));
        assert!(!is_screen("portal:window:57"));
        assert!(!is_screen("garbage"));
    }

    #[test]
    fn a_crop_without_a_reference_has_no_centre() {
        let crop = Crop { x: 0, y: 0, width: 1, height: 1, reference_width: 0, reference_height: 0 };
        assert!(crop_centre(&LEFT, &crop).is_none());
    }
}
