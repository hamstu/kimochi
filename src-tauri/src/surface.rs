//! What each recognised box sits on, for the overlay's "Blend" cards (Settings → OCR & Overlay →
//! Overlay look): the colour of the source's background around the text, top and bottom, and
//! whether text over it reads better light or dark.
//!
//! Computed once, from the frame the scan read, when the scan finishes (`ocr_frame`), and carried
//! on the result as each annotation's and group's `surface`. Only a thin ring around each box is
//! read, a little outside it so the glyphs themselves are left out:
//!
//!  - each side's colour is the most common one in its strip (pixels bucketed by colour, the
//!    fullest bucket averaged), so a stray stroke of a neighbouring glyph or of furigana, being
//!    the minority, never colours it;
//!  - a side whose strip has no clear majority (a busy picture), or that falls outside the frame,
//!    takes the colour common to the whole ring instead;
//!  - the card is filled top to bottom between the top and bottom colours, which follows the
//!    vertical gradients dialogue boxes are usually drawn with;
//!  - light or dark text is whichever contrasts more with that fill (WCAG relative luminance).
use serde_json::{json, Value};

/// A frame's pixels as the sampler reads them: RGBA rows, `stride` bytes apart.
pub struct Pixels<'a> {
    pub rgba: &'a [u8],
    pub width: u32,
    pub height: u32,
    pub stride: usize,
}

impl Pixels<'_> {
    fn at(&self, x: u32, y: u32) -> [u8; 3] {
        let i = y as usize * self.stride + x as usize * 4;
        [self.rgba[i], self.rgba[i + 1], self.rgba[i + 2]]
    }
}

/// A side's colour and how much of its strip shares it.
#[derive(Clone, Copy, Debug)]
struct Side {
    color: [f64; 3],
    share: f64,
}

/// Below this share of its strip, a side's colour is not trusted (a busy background).
const MAJORITY: f64 = 0.35;
/// At most this many pixels are read from each strip.
const SAMPLES_PER_SIDE: f64 = 400.;

/// The most common colour of these pixels: bucketed 16 levels a channel, the fullest bucket's
/// pixels averaged.
fn dominant(pixels: &[[u8; 3]]) -> Option<Side> {
    if pixels.is_empty() {
        return None;
    }
    let bucket = |p: &[u8; 3]| (p[0] as usize >> 4) << 8 | (p[1] as usize >> 4) << 4 | p[2] as usize >> 4;
    let mut counts = vec![0u32; 4096];
    for p in pixels {
        counts[bucket(p)] += 1;
    }
    let (best, count) = counts.iter().enumerate().max_by_key(|(_, c)| **c)?;
    let mut sum = [0f64; 3];
    for p in pixels.iter().filter(|p| bucket(p) == best) {
        for c in 0..3 {
            sum[c] += f64::from(p[c]);
        }
    }
    let n = f64::from(*count);
    Some(Side { color: sum.map(|s| s / n), share: n / pixels.len() as f64 })
}

/// Pixels of the frame in `[x0, x1) × [y0, y1)` (clamped to it), read on a grid fine enough
/// for about `SAMPLES_PER_SIDE` of them.
fn strip(pixels: &Pixels, x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<[u8; 3]> {
    let x0 = x0.max(0.).floor() as u32;
    let y0 = y0.max(0.).floor() as u32;
    let x1 = (x1.min(f64::from(pixels.width))).ceil().max(0.) as u32;
    let y1 = (y1.min(f64::from(pixels.height))).ceil().max(0.) as u32;
    if x1 <= x0 || y1 <= y0 {
        return Vec::new();
    }
    let area = f64::from(x1 - x0) * f64::from(y1 - y0);
    let step = (area / SAMPLES_PER_SIDE).sqrt().max(1.) as usize;
    let mut out = Vec::new();
    for y in (y0..y1).step_by(step) {
        for x in (x0..x1).step_by(step) {
            out.push(pixels.at(x, y));
        }
    }
    out
}

/// sRGB channel to linear light, for relative luminance.
fn linear(channel: f64) -> f64 {
    let c = channel / 255.;
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

fn luminance(color: [f64; 3]) -> f64 {
    0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2])
}

fn hex(color: [f64; 3]) -> String {
    let [r, g, b] = color.map(|c| c.round().clamp(0., 255.) as u8);
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// What the box `[x1, y1, x2, y2]` (frame pixels) sits on, or None when nothing around it is
/// in the frame.
pub fn surface_of(pixels: &Pixels, [x1, y1, x2, y2]: [f64; 4]) -> Option<Value> {
    if !(x2 > x1 && y2 > y1) {
        return None;
    }
    // The glyph size, near enough: a box's short side.
    let size = (x2 - x1).min(y2 - y1);
    let gap = (size * 0.12).clamp(1., 6.);
    let band = (size * 0.25).clamp(2., 10.);
    let top = strip(pixels, x1, y1 - gap - band, x2, y1 - gap);
    let bottom = strip(pixels, x1, y2 + gap, x2, y2 + gap + band);
    let left = strip(pixels, x1 - gap - band, y1, x1 - gap, y2);
    let right = strip(pixels, x2 + gap, y1, x2 + gap + band, y2);
    let ring: Vec<[u8; 3]> = [&top, &bottom, &left, &right].into_iter().flatten().copied().collect();
    let base = dominant(&ring)?;
    let trusted = |side: Option<Side>| side.filter(|s| s.share >= MAJORITY).map_or(base.color, |s| s.color);
    let top = trusted(dominant(&top));
    let bottom = trusted(dominant(&bottom));
    let fill = [0, 1, 2].map(|c| (top[c] + bottom[c]) / 2.);
    let l = luminance(fill);
    // Contrast against white text and against the near-black the light cards use (#1c2024).
    let with_light = 1.05 / (l + 0.05);
    let with_dark = (l + 0.05) / (luminance([28., 32., 36.]) + 0.05);
    let ink = if with_light >= with_dark { "light" } else { "dark" };
    Some(json!({ "top": hex(top), "bottom": hex(bottom), "ink": ink }))
}

/// A box's bounds from a `boundingPoly`.
fn poly_bounds(poly: &Value) -> Option<[f64; 4]> {
    let vertices = poly["vertices"].as_array()?;
    let xs: Vec<f64> = vertices.iter().map(|v| v["x"].as_f64().unwrap_or(0.)).collect();
    let ys: Vec<f64> = vertices.iter().map(|v| v["y"].as_f64().unwrap_or(0.)).collect();
    if xs.is_empty() {
        return None;
    }
    let min = |v: &[f64]| v.iter().copied().fold(f64::INFINITY, f64::min);
    let max = |v: &[f64]| v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    Some([min(&xs), min(&ys), max(&xs), max(&ys)])
}

/// Every annotation (but the whole-frame aggregate) and every group of an OCR result, given its
/// `surface`.
pub fn annotate(result: &mut Value, pixels: &Pixels) {
    if let Some(annotations) = result["textAnnotations"].as_array_mut() {
        for annotation in annotations.iter_mut().filter(|a| a["granularity"] != "aggregate") {
            if let Some(surface) = poly_bounds(&annotation["boundingPoly"]).and_then(|b| surface_of(pixels, b)) {
                annotation["surface"] = surface;
            }
        }
    }
    if let Some(groups) = result["groups"].as_array_mut() {
        for group in groups.iter_mut() {
            let bbox = group["bbox"].as_array().and_then(|b| {
                let v: Vec<f64> = b.iter().filter_map(Value::as_f64).collect();
                (v.len() == 4).then(|| [v[0], v[1], v[2], v[3]])
            });
            if let Some(surface) = bbox.and_then(|b| surface_of(pixels, b)) {
                group["surface"] = surface;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame filled by `paint(x, y)`.
    fn frame(width: u32, height: u32, paint: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let [r, g, b] = paint(x, y);
                rgba.extend_from_slice(&[r, g, b, 255]);
            }
        }
        rgba
    }

    fn pixels(rgba: &[u8], width: u32, height: u32) -> Pixels<'_> {
        Pixels { rgba, width, height, stride: width as usize * 4 }
    }

    #[test]
    fn a_dark_dialogue_box_gets_its_own_colour_and_light_text() {
        // Navy with white glyph strokes inside the box, and furigana-like strokes just above it.
        let rgba = frame(200, 100, |x, y| {
            let glyph = (40..160).contains(&x) && (40..60).contains(&y) && x % 6 < 2;
            let furigana = (40..160).contains(&x) && (33..36).contains(&y) && x % 9 == 0;
            if glyph || furigana { [255, 255, 255] } else { [20, 30, 70] }
        });
        let surface = surface_of(&pixels(&rgba, 200, 100), [40., 40., 160., 60.]).unwrap();
        assert_eq!(surface["top"], "#141e46");
        assert_eq!(surface["bottom"], "#141e46");
        assert_eq!(surface["ink"], "light");
    }

    #[test]
    fn a_vertical_gradient_is_followed_top_to_bottom_and_pale_ground_takes_dark_text() {
        let rgba = frame(200, 100, |_, y| if y < 50 { [250, 245, 230] } else { [210, 200, 180] });
        let surface = surface_of(&pixels(&rgba, 200, 100), [40., 45., 160., 55.]).unwrap();
        assert_eq!(surface["top"], "#faf5e6");
        assert_eq!(surface["bottom"], "#d2c8b4");
        assert_eq!(surface["ink"], "dark");
    }

    #[test]
    fn a_box_filling_the_frame_has_nothing_around_it() {
        let rgba = frame(50, 20, |_, _| [0, 0, 0]);
        assert!(surface_of(&pixels(&rgba, 50, 20), [0., 0., 50., 20.]).is_none());
    }

    #[test]
    fn annotations_and_groups_get_surfaces_and_the_aggregate_does_not() {
        let rgba = frame(200, 100, |_, _| [240, 240, 240]);
        let poly = |x1: f64, y1: f64, x2: f64, y2: f64| {
            json!({"vertices": [{"x": x1, "y": y1}, {"x": x2, "y": y1}, {"x": x2, "y": y2}, {"x": x1, "y": y2}]})
        };
        let mut result = json!({
            "textAnnotations": [
                {"description": "全部", "granularity": "aggregate", "boundingPoly": poly(0., 0., 200., 100.)},
                {"description": "猫", "granularity": "line", "boundingPoly": poly(50., 40., 90., 60.)}
            ],
            "groups": [{"id": "g", "text": "猫", "bbox": [50., 40., 90., 60.]}]
        });
        annotate(&mut result, &pixels(&rgba, 200, 100));
        assert!(result["textAnnotations"][0].get("surface").is_none());
        assert_eq!(result["textAnnotations"][1]["surface"]["ink"], "dark");
        assert_eq!(result["groups"][0]["surface"]["top"], "#f0f0f0");
    }
}
