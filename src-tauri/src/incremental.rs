//! Incremental looks for Auto OCR's watcher: read only the part of the screen that changed.
//!
//! Between two looks at a dialogue box, what changes is usually one line growing as it types
//! out, or a small animation (a blinking "next" arrow, a pulsing icon) that is not text at all.
//! Reading the whole frame again for that costs the watcher its full price every time: PaddleOCR
//! on a CPU read a 1924x1004 game window in about 330 ms, and the region around one line in
//! about 55. So when the watcher has a reading of an earlier frame of the same source, the frame
//! is compared with that one, and only the regions that changed are read; every line outside
//! them keeps its earlier reading.
//!
//! The regions are built so that no line is ever read in halves: a region that touches a line
//! the previous reading had grows to take in all of it, plus a margin, and the margin is what
//! lets a line that is typing out be read together with its next glyph. A reading from inside
//! a region that runs into the region's edge (other than the frame's own) is text cut by the
//! crop, and is dropped. Anything that changes too much of the frame is read whole, and so is
//! every `FULL_EVERY`th look, so a reading can never drift far from what a full read would say.

use kimochi_capture::Frame;
use meikiocr::TextLine;

/// Side of the square cells two frames are compared in.
const TILE: usize = 16;
/// Changed area, as a share of the frame, beyond which a whole read is cheaper anyway.
const MAX_AREA_SHARE: f64 = 0.5;
/// More separate regions than this is a screen changing everywhere: read it whole.
const MAX_REGIONS: usize = 6;
/// Every this many incremental looks, one full read.
pub const FULL_EVERY: u32 = 10;

/// Left, top, right, bottom, in frame pixels (right and bottom exclusive).
pub type Rect = [u32; 4];

/// The frame the watcher last read and what it read on it.
pub struct Previous {
    source: String,
    width: u32,
    height: u32,
    crop: [u32; 4],
    stride: usize,
    pixels: Vec<u8>,
    pub lines: Vec<TextLine>,
}

impl Previous {
    pub fn new(frame: &Frame, lines: Vec<TextLine>) -> Self {
        Self {
            source: frame.info.source_id.clone(),
            width: frame.info.width,
            height: frame.info.height,
            crop: frame.info.crop_pixels,
            stride: stride(frame),
            pixels: frame.pixels.clone(),
            lines,
        }
    }
}

/// What to read of a new frame: these regions, keeping these earlier lines.
#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub regions: Vec<Rect>,
    /// The previous lines no region touches, in their reading order.
    pub keep: Vec<TextLine>,
    /// Where in `keep` the lines read from the regions go: where the first line they replace
    /// was. None when they replace nothing.
    pub insert_at: Option<usize>,
    /// The previous lines inside the regions, which their reading replaces.
    pub removed: Vec<TextLine>,
    /// Where the pixels actually changed (before the regions were grown around them).
    pub changed: Vec<Rect>,
}

fn stride(frame: &Frame) -> usize {
    frame.info.stride.max(frame.info.width as usize * 4)
}

/// The regions of `frame` to read, given the previous reading; None when it should be read
/// whole. `min_size` is the smallest region an engine reads well (MeikiOCR's detector scales
/// any image up to 960x544, so a sliver would reach it many times enlarged).
pub fn plan(previous: &Previous, frame: &Frame, min_size: (u32, u32)) -> Option<Plan> {
    let (width, height) = (frame.info.width, frame.info.height);
    if previous.source != frame.info.source_id
        || previous.width != width
        || previous.height != height
        || previous.crop != frame.info.crop_pixels
        || width == 0
        || height == 0
    {
        return None;
    }
    let tiles = changed_tiles(previous, frame)?;
    let margin = margin(&previous.lines);
    let changed = components(&tiles, width, height);
    let mut regions: Vec<Rect> = changed.iter().map(|r| grow(*r, margin, width, height)).collect();
    let lines: Vec<Rect> = previous.lines.iter().map(|l| l.bbox).collect();
    // Grow until every region either holds a line whole or misses it, and regions that meet
    // are one region.
    loop {
        let mut changed = false;
        for region in &mut regions {
            let sized = at_least(*region, min_size, width, height);
            if sized != *region {
                *region = sized;
                changed = true;
            }
            for line in &lines {
                if intersects(*region, *line) && !contains(*region, *line) {
                    *region = union(*region, grow(*line, margin, width, height));
                    changed = true;
                }
            }
        }
        changed |= merge_overlapping(&mut regions);
        if !changed {
            break;
        }
    }
    let area: u64 = regions.iter().map(|r| u64::from(r[2] - r[0]) * u64::from(r[3] - r[1])).sum();
    if regions.len() > MAX_REGIONS || area as f64 > MAX_AREA_SHARE * f64::from(width) * f64::from(height) {
        return None;
    }
    let mut keep = Vec::new();
    let mut removed = Vec::new();
    let mut insert_at = None;
    for line in &previous.lines {
        if regions.iter().any(|r| intersects(*r, line.bbox)) {
            insert_at.get_or_insert(keep.len());
            removed.push(line.clone());
        } else {
            keep.push(line.clone());
        }
    }
    Some(Plan { regions, keep, insert_at, removed, changed })
}

/// Lines read inside `region`, moved into frame coordinates; lines cut by an edge of the
/// region that is not an edge of the frame are dropped.
pub fn place(lines: Vec<TextLine>, region: Rect, width: u32, height: u32) -> Vec<TextLine> {
    let [left, top, right, bottom] = region;
    let (w, h) = (right - left, bottom - top);
    lines
        .into_iter()
        .filter(|line| {
            let [l, t, r, b] = line.bbox;
            let cut = (left > 0 && l <= 1)
                || (top > 0 && t <= 1)
                || (right < width && r + 1 >= w)
                || (bottom < height && b + 1 >= h);
            !cut
        })
        .map(|mut line| {
            shift(&mut line.bbox, left, top);
            for c in &mut line.characters {
                shift(&mut c.bbox, left, top);
            }
            line
        })
        .collect()
}

/// The new reading: the kept lines, with the lines read from the regions where the lines they
/// replace were (or, replacing nothing, before the first kept line below them).
///
/// Inside a region, only what changed is taken from the new reading. A line whose pixels did
/// not change keeps its previous reading: read again from a crop it might come out a little
/// differently, or not at all, and a line nobody touched must not flicker or vanish.
pub fn merge(plan: Plan, read: Vec<TextLine>) -> Vec<TextLine> {
    let touched = |r: Rect| plan.changed.iter().any(|c| intersects(*c, r));
    let still: Vec<&TextLine> = plan.removed.iter().filter(|l| !touched(l.bbox)).collect();
    // New readings over changed pixels, or over text nobody had read before.
    let mut read: Vec<TextLine> = read
        .into_iter()
        .filter(|l| touched(l.bbox) || !still.iter().any(|s| intersects(s.bbox, l.bbox)))
        .collect();
    // Unchanged lines that no new reading took over keep what they said.
    for line in still {
        if !read.iter().any(|n| intersects(n.bbox, line.bbox)) {
            read.push(line.clone());
        }
    }
    read.sort_by_key(|l| (l.bbox[1], l.bbox[0]));
    let mut keep = plan.keep;
    match plan.insert_at {
        Some(at) => {
            let tail = keep.split_off(at.min(keep.len()));
            keep.extend(read);
            keep.extend(tail);
        }
        None => {
            for line in read {
                let at = keep.iter().position(|k| k.bbox[1] >= line.bbox[3]).unwrap_or(keep.len());
                keep.insert(at, line);
            }
        }
    }
    keep
}

fn shift(bbox: &mut Rect, dx: u32, dy: u32) {
    bbox[0] += dx;
    bbox[1] += dy;
    bbox[2] += dx;
    bbox[3] += dy;
}

/// Which `TILE`-square cells differ, as a grid; None when nothing does (nothing to plan).
fn changed_tiles(previous: &Previous, frame: &Frame) -> Option<Grid> {
    let (width, height) = (frame.info.width as usize, frame.info.height as usize);
    let (a_stride, b_stride) = (previous.stride, stride(frame));
    let row_bytes = width * 4;
    if previous.pixels.len() < a_stride * (height - 1) + row_bytes
        || frame.pixels.len() < b_stride * (height - 1) + row_bytes
    {
        return None;
    }
    let mut grid = Grid::new(width.div_ceil(TILE), height.div_ceil(TILE));
    let mut any = false;
    for y in 0..height {
        let a = &previous.pixels[y * a_stride..y * a_stride + row_bytes];
        let b = &frame.pixels[y * b_stride..y * b_stride + row_bytes];
        if a == b {
            continue;
        }
        for (column, (ca, cb)) in a.chunks(TILE * 4).zip(b.chunks(TILE * 4)).enumerate() {
            if ca != cb {
                grid.set(column, y / TILE);
                any = true;
            }
        }
    }
    any.then_some(grid)
}

struct Grid {
    columns: usize,
    rows: usize,
    cells: Vec<bool>,
}

impl Grid {
    fn new(columns: usize, rows: usize) -> Self {
        Self { columns, rows, cells: vec![false; columns * rows] }
    }
    fn set(&mut self, column: usize, row: usize) {
        self.cells[row * self.columns + column] = true;
    }
    fn get(&self, column: usize, row: usize) -> bool {
        self.cells[row * self.columns + column]
    }
}

/// Bounding boxes, in pixels, of the groups of changed cells: cells within one cell of each
/// other are one group, so a glyph whose strokes leave a gap is still one change.
fn components(grid: &Grid, width: u32, height: u32) -> Vec<Rect> {
    let mut seen = vec![false; grid.cells.len()];
    let mut out = Vec::new();
    for start in 0..grid.cells.len() {
        if !grid.cells[start] || seen[start] {
            continue;
        }
        seen[start] = true;
        let mut stack = vec![start];
        let (mut c0, mut r0, mut c1, mut r1) = (usize::MAX, usize::MAX, 0, 0);
        while let Some(index) = stack.pop() {
            let (column, row) = (index % grid.columns, index / grid.columns);
            c0 = c0.min(column);
            r0 = r0.min(row);
            c1 = c1.max(column);
            r1 = r1.max(row);
            for dr in -2i64..=2 {
                for dc in -2i64..=2 {
                    let (c, r) = (column as i64 + dc, row as i64 + dr);
                    if c < 0 || r < 0 || c >= grid.columns as i64 || r >= grid.rows as i64 {
                        continue;
                    }
                    let (c, r) = (c as usize, r as usize);
                    let next = r * grid.columns + c;
                    if grid.get(c, r) && !seen[next] {
                        seen[next] = true;
                        stack.push(next);
                    }
                }
            }
        }
        out.push([
            (c0 * TILE) as u32,
            (r0 * TILE) as u32,
            (((c1 + 1) * TILE) as u32).min(width),
            (((r1 + 1) * TILE) as u32).min(height),
        ]);
    }
    out
}

/// Context around a change: most of a line's height, so the detector sees the whole of a line
/// that is typing out and the next glyph's room beside it.
fn margin(lines: &[TextLine]) -> u32 {
    let mut heights: Vec<u32> = lines
        .iter()
        .map(|l| {
            let (w, h) = (l.bbox[2] - l.bbox[0], l.bbox[3] - l.bbox[1]);
            if l.is_vertical { w } else { h }
        })
        .collect();
    heights.sort_unstable();
    let typical = heights.get(heights.len() / 2).copied().unwrap_or(32);
    (typical * 3 / 4).clamp(16, 96)
}

fn grow(r: Rect, by: u32, width: u32, height: u32) -> Rect {
    [r[0].saturating_sub(by), r[1].saturating_sub(by), (r[2] + by).min(width), (r[3] + by).min(height)]
}

fn at_least(r: Rect, (min_w, min_h): (u32, u32), width: u32, height: u32) -> Rect {
    let widen = |lo: u32, hi: u32, min: u32, limit: u32| -> (u32, u32) {
        let min = min.min(limit);
        if hi - lo >= min {
            return (lo, hi);
        }
        let extra = min - (hi - lo);
        let lo = lo.saturating_sub(extra / 2);
        let hi = (lo + min).min(limit);
        (hi - min, hi)
    };
    let (l, r2) = widen(r[0], r[2], min_w, width);
    let (t, b) = widen(r[1], r[3], min_h, height);
    [l, t, r2, b]
}

fn intersects(a: Rect, b: Rect) -> bool {
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

fn contains(outer: Rect, inner: Rect) -> bool {
    outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3]
}

fn union(a: Rect, b: Rect) -> Rect {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]
}

/// Join regions that overlap; true when any were joined.
fn merge_overlapping(regions: &mut Vec<Rect>) -> bool {
    let mut joined = false;
    let mut i = 0;
    while i < regions.len() {
        let mut j = i + 1;
        while j < regions.len() {
            if intersects(regions[i], regions[j]) {
                let other = regions.remove(j);
                regions[i] = union(regions[i], other);
                joined = true;
                j = i + 1;
            } else {
                j += 1;
            }
        }
        i += 1;
    }
    joined
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimochi_capture::FrameInfo;

    fn frame(width: u32, height: u32, paint: &[Rect]) -> Frame {
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        for r in paint {
            for y in r[1]..r[3] {
                for x in r[0]..r[2] {
                    let i = ((y * width + x) * 4) as usize;
                    pixels[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
                }
            }
        }
        Frame {
            info: FrameInfo {
                source_id: "s".into(),
                width,
                height,
                stride: width as usize * 4,
                full_width: width,
                full_height: height,
                crop_pixels: [0, 0, width, height],
                scale_factor: 1.0,
                source_bounds: None,
                pixel_format: "rgba8",
                color_space: "srgb",
                resolve_ms: 0.0,
                acquisition_ms: 0.0,
                pixels_ms: 0.0,
                total_ms: 0.0,
            },
            pixels,
        }
    }

    fn line(text: &str, bbox: Rect) -> TextLine {
        TextLine { text: text.into(), bbox, detection_confidence: None, characters: vec![], is_vertical: false }
    }

    #[test]
    fn a_line_typing_out_is_read_whole_with_room_for_the_next_glyph() {
        let before = frame(800, 400, &[[100, 300, 300, 330]]);
        let previous = Previous::new(&before, vec![line("title", [100, 20, 400, 60]), line("今日は", [100, 300, 300, 330])]);
        // One more glyph at the end of the line.
        let after = frame(800, 400, &[[100, 300, 300, 330], [302, 300, 330, 330]]);
        let plan = plan(&previous, &after, (0, 0)).expect("incremental");
        assert_eq!(plan.regions.len(), 1);
        let region = plan.regions[0];
        assert!(contains(region, [100, 300, 330, 330]), "{region:?}");
        assert!(!intersects(region, [100, 20, 400, 60]), "the title is not re-read");
        assert_eq!(plan.keep.len(), 1);
        assert_eq!(plan.insert_at, Some(1));
    }

    #[test]
    fn identical_frames_need_no_plan_and_big_changes_are_read_whole() {
        let a = frame(400, 300, &[[10, 10, 50, 40]]);
        let previous = Previous::new(&a, vec![]);
        assert!(plan(&previous, &a, (0, 0)).is_none());
        let b = frame(400, 300, &[[0, 0, 400, 300]]);
        assert!(plan(&previous, &b, (0, 0)).is_none());
        let other_size = frame(401, 300, &[]);
        assert!(plan(&previous, &other_size, (0, 0)).is_none());
    }

    #[test]
    fn small_regions_grow_to_the_engines_minimum_and_swallow_lines_they_cut() {
        let a = frame(1000, 600, &[]);
        let previous = Previous::new(&a, vec![line("menu", [400, 290, 560, 320])]);
        let b = frame(1000, 600, &[[100, 300, 110, 310]]);
        let plan = plan(&previous, &b, (480, 272)).expect("incremental");
        let r = plan.regions[0];
        assert!(r[2] - r[0] >= 480 && r[3] - r[1] >= 272, "{r:?}");
        assert!(contains(r, [400, 290, 560, 320]), "a line the region reaches is read whole");
        assert!(plan.keep.is_empty());
    }

    #[test]
    fn readings_move_into_the_frame_and_cut_lines_are_dropped() {
        let region = [100, 200, 500, 300];
        let read = vec![line("whole", [10, 20, 200, 60]), line("cut", [0, 20, 50, 60])];
        let placed = place(read, region, 1000, 1000);
        assert_eq!(placed.len(), 1);
        assert_eq!(placed[0].bbox, [110, 220, 300, 260]);
    }

    #[test]
    fn merged_lines_take_the_place_of_the_ones_they_replace() {
        let plan = Plan {
            keep: vec![line("a", [0, 0, 10, 10]), line("c", [0, 100, 10, 110])],
            insert_at: Some(1),
            changed: vec![[0, 50, 10, 60]],
            ..Default::default()
        };
        let merged = merge(plan, vec![line("b", [0, 50, 10, 60])]);
        let texts: Vec<_> = merged.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, ["a", "b", "c"]);
        let plan = Plan {
            keep: vec![line("a", [0, 0, 10, 10]), line("c", [0, 100, 10, 110])],
            changed: vec![[0, 50, 10, 60]],
            ..Default::default()
        };
        let merged = merge(plan, vec![line("b", [0, 50, 10, 60])]);
        assert_eq!(merged.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
    }

    #[test]
    fn a_line_whose_pixels_did_not_change_keeps_its_reading() {
        // The region took in an unchanged line beside the one that grew.
        let plan = Plan {
            insert_at: Some(0),
            removed: vec![line("縦書きの文章", [20, 100, 50, 400]), line("今日は", [100, 300, 200, 330])],
            changed: vec![[200, 300, 230, 330]],
            ..Default::default()
        };
        // The crop read the unchanged column differently, and missed nothing else.
        let read = vec![line("縦書き", [20, 100, 50, 250]), line("今日はい", [100, 300, 230, 330])];
        let merged = merge(plan.clone(), read);
        let texts: Vec<_> = merged.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, ["縦書きの文章", "今日はい"]);
        // The crop missed the unchanged column entirely: it is not lost.
        let merged = merge(plan, vec![line("今日はい", [100, 300, 230, 330])]);
        assert_eq!(merged.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["縦書きの文章", "今日はい"]);
    }
}
