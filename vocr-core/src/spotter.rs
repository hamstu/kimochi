//! textspot8, the dialogue-line spotter: its network's codes decoded into boxes as
//! `runtime/vocr_textspot6.c` does (`vocr_onnx.Spotter`), with the dark flag, blocks, reading order and
//! the dialogue pick.
use crate::grey::Grey;
use crate::onnx::{self, Meta};
use crate::Error;
use ort::session::Session;
use ort::value::TensorRef;
use std::path::Path;

pub const BOX_MAX: usize = 64;
const PAD_PCT: i64 = 18;
const PAD_MIN: i64 = 2;
const MIN_ACROSS: i64 = 4;
const TCONF_MAX: i64 = 127;
/// `runtime/vocr_textspot.h` VOCR_TEXTSPOT_MAX_SIDE: the C spotter refuses a larger side.
pub const MAX_SIDE: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct SpotBox {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub vertical: bool,
    pub conf: i64,
    pub dark: bool,
    pub block: usize,
    /// 0 dialogue, 1 name, 2 choice, 3 UI, 4 scene (`Spotter::classes`).
    pub tag: usize,
    pub tconf: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Block {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub vertical: bool,
    pub first: usize,
    pub count: usize,
    pub tag: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Spots {
    pub boxes: Vec<SpotBox>,
    pub blocks: Vec<Block>,
    /// The dialogue block Rubi would pick on a whole frame, if any.
    pub pick: Option<usize>,
    pub truncated: bool,
    pub presence: i64,
}

pub struct Spotter {
    session: Session,
    pub tags: usize,
    pub classes: Vec<String>,
    half_above: usize,
    half_above_h: usize,
    conf_min: i64,
    min_cells: usize,
    stride: i64,
}

/// The 2 x 2 mean (rounded) of the spotter's half scale: ceil(H / 2) x ceil(W / 2), the last row and
/// column repeated for an odd side.
pub fn halve(g: &Grey) -> Grey {
    let (w2, h2) = (g.width.div_ceil(2), g.height.div_ceil(2));
    let mut data = Vec::with_capacity(w2 * h2);
    for y in 0..h2 {
        let (y0, y1) = (2 * y, (2 * y + 1).min(g.height - 1));
        for x in 0..w2 {
            let (x0, x1) = (2 * x, (2 * x + 1).min(g.width - 1));
            let s = g.at(x0, y0) as u32 + g.at(x1, y0) as u32 + g.at(x0, y1) as u32 + g.at(x1, y1) as u32;
            data.push(((s + 2) >> 2) as u8);
        }
    }
    Grey::new(w2, h2, data)
}

/// `vocr_line_dark`: whether the text in the box is darker than its background.
pub fn line_dark(g: &Grey, (x, y, w, h): (usize, usize, usize, usize)) -> bool {
    let mut border = Vec::with_capacity(2 * (w + h));
    border.extend((x..x + w).map(|i| g.at(i, y)));
    border.extend((x..x + w).map(|i| g.at(i, y + h - 1)));
    border.extend((y..y + h).map(|j| g.at(x, j)));
    border.extend((y..y + h).map(|j| g.at(x + w - 1, j)));
    border.sort_unstable();
    let bg = border[border.len() / 2] as i64;
    let mut hist = [0i64; 256];
    for j in y..y + h {
        for &v in &g.data[j * g.width + x..j * g.width + x + w] {
            hist[v as usize] += 1;
        }
    }
    let n = (w * h) as i64;
    let first = |k: i64| {
        let mut cum = 0;
        for (v, c) in hist.iter().enumerate() {
            cum += c;
            if cum >= k {
                return v as i64;
            }
        }
        255
    };
    let (lo, hi) = (first(n * 2 / 100), first(n * 98 / 100));
    let d = 16.max((hi - lo) / 4);
    let (mut nd, mut nb) = (0i64, 0i64);
    for v in (0..256).map(|v| v as i64) {
        if v < bg - d {
            nd += hist[v as usize];
        } else if v > bg + d {
            nb += hist[v as usize];
        }
    }
    nd > 8 * nb
}

/// 4-connected components of a map's positive cells, as lists of (row, col).
fn components(mask: &[bool], h: usize, w: usize) -> Vec<Vec<(usize, usize)>> {
    let mut seen = vec![false; h * w];
    let mut out = Vec::new();
    let mut stack = Vec::new();
    for start in 0..h * w {
        if !mask[start] || seen[start] {
            continue;
        }
        let mut cells = Vec::new();
        seen[start] = true;
        stack.push(start);
        while let Some(i) = stack.pop() {
            let (r, c) = (i / w, i % w);
            cells.push((r, c));
            let mut visit = |j: usize| {
                if mask[j] && !seen[j] {
                    seen[j] = true;
                    stack.push(j);
                }
            };
            if r > 0 {
                visit(i - w);
            }
            if r + 1 < h {
                visit(i + w);
            }
            if c > 0 {
                visit(i - 1);
            }
            if c + 1 < w {
                visit(i + 1);
            }
        }
        out.push(cells);
    }
    out
}

/// A box before grouping: (x, y, w, h, vertical, conf, dark, tag, tconf), compared as Python's tuples.
type Raw = (i64, i64, i64, i64, i64, i64, i64, i64, i64);
/// A candidate's sort key: (-conf, -cells, vertical, y0, x0, h, w, tag).
type Key = (i64, i64, i64, i64, i64, i64, i64, i64);

/// textspot6_twin._joins: one tag, one orientation, an overlap along the line, a gap across it at most
/// the larger size across, sizes across within 3 : 2.
fn joins(a: &Raw, b: &Raw) -> bool {
    if a.7 != b.7 || a.4 != b.4 {
        return false;
    }
    let (ov, gap, sa, sb) = if a.4 != 0 {
        (
            (a.1 + a.3).min(b.1 + b.3) - a.1.max(b.1),
            a.0.max(b.0) - (a.0 + a.2).min(b.0 + b.2),
            a.2,
            b.2,
        )
    } else {
        (
            (a.0 + a.2).min(b.0 + b.2) - a.0.max(b.0),
            a.1.max(b.1) - (a.1 + a.3).min(b.1 + b.3),
            a.3,
            b.3,
        )
    };
    ov > 0 && gap <= sa.max(sb) && 2 * sa.max(sb) <= 3 * sa.min(sb)
}

/// Runs of items overlapping the run's first item across the line, each run in `key_row` order.
fn rows<T: Copy, K1: Ord, K2: Ord>(
    items: &[T],
    key_sort: impl Fn(&T) -> K1,
    lo: impl Fn(&T) -> i64,
    size: impl Fn(&T) -> i64,
    key_row: impl Fn(&T) -> K2,
) -> Vec<T> {
    let mut sorted = items.to_vec();
    sorted.sort_by_key(&key_sort);
    let mut out = Vec::new();
    let mut run: Vec<T> = Vec::new();
    for it in sorted {
        if let Some(f) = run.first() {
            let ov = (lo(&it) + size(&it)).min(lo(f) + size(f)) - lo(&it).max(lo(f));
            if 2 * ov >= size(&it).min(size(f)) {
                run.push(it);
                continue;
            }
            run.sort_by_key(&key_row);
            out.append(&mut run);
        }
        run = vec![it];
    }
    run.sort_by_key(&key_row);
    out.append(&mut run);
    out
}

fn order_block(members: &[Raw]) -> Vec<Raw> {
    if members[0].4 != 0 {
        rows(
            members,
            |b| (-(b.0 + b.2), b.1, b.0, b.2, b.3),
            |b| b.0,
            |b| b.2,
            |b| (b.1, -(b.0 + b.2), b.3, b.2),
        )
    } else {
        rows(members, |b| (b.1, b.0, b.3, b.2), |b| b.1, |b| b.3, |b| (b.0, b.1, b.3, b.2))
    }
}

/// textspot6_twin.group_and_order: boxes into blocks, blocks into reading order, and the pick.
#[allow(clippy::needless_range_loop)] // the pairwise join loop reads clearest by index
fn group_and_order(mut boxes: Vec<Raw>, height: i64) -> (Vec<SpotBox>, Vec<Block>, Option<usize>) {
    boxes.sort();
    let n = boxes.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], mut a: usize) -> usize {
        while parent[a] != a {
            parent[a] = parent[parent[a]];
            a = parent[a];
        }
        a
    }
    for i in 0..n {
        for j in i + 1..n {
            if joins(&boxes[i], &boxes[j]) {
                let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                if ri != rj {
                    parent[ri.max(rj)] = ri.min(rj);
                }
            }
        }
    }
    // Groups in the order of their first member.
    let mut roots: Vec<usize> = Vec::new();
    let mut groups: Vec<Vec<Raw>> = Vec::new();
    for i in 0..n {
        let r = find(&mut parent, i);
        match roots.iter().position(|&x| x == r) {
            Some(g) => groups[g].push(boxes[i]),
            None => {
                roots.push(r);
                groups.push(vec![boxes[i]]);
            }
        }
    }
    // (x, y, w, h, vertical, tag) per block, with its members in order.
    type Bb = (i64, i64, i64, i64, i64, i64);
    let mut blocks: Vec<(Bb, Vec<Raw>)> = groups
        .iter()
        .map(|m| {
            let x0 = m.iter().map(|b| b.0).min().unwrap();
            let y0 = m.iter().map(|b| b.1).min().unwrap();
            let x1 = m.iter().map(|b| b.0 + b.2).max().unwrap();
            let y1 = m.iter().map(|b| b.1 + b.3).max().unwrap();
            ((x0, y0, x1 - x0, y1 - y0, m[0].4, m[0].7), order_block(m))
        })
        .collect();
    blocks.sort_by_key(|t| (t.0 .1, t.0 .0, t.0 .3, t.0 .2, t.0 .5));
    let mut runs: Vec<Vec<(Bb, Vec<Raw>)>> = Vec::new();
    for bk in blocks {
        if let Some(run) = runs.last_mut() {
            let (f, b) = (run[0].0, bk.0);
            let ov = (b.1 + b.3).min(f.1 + f.3) - b.1.max(f.1);
            if 2 * ov >= b.3.min(f.3) {
                run.push(bk);
                continue;
            }
        }
        runs.push(vec![bk]);
    }
    let mut ordered: Vec<(Bb, Vec<Raw>)> = Vec::new();
    for mut run in runs {
        if run.iter().all(|t| t.0 .4 != 0) {
            run.sort_by_key(|t| (-(t.0 .0 + t.0 .2), t.0 .1, t.0 .3, t.0 .2, t.0 .5));
        } else {
            run.sort_by_key(|t| (t.0 .0, t.0 .1, t.0 .3, t.0 .2, t.0 .5));
        }
        ordered.extend(run);
    }
    let mut out_boxes = Vec::new();
    let mut out_blocks = Vec::new();
    for (k, (bb, members)) in ordered.iter().enumerate() {
        out_blocks.push(Block {
            x: bb.0,
            y: bb.1,
            w: bb.2,
            h: bb.3,
            vertical: bb.4 != 0,
            first: out_boxes.len(),
            count: members.len(),
            tag: bb.5 as usize,
        });
        out_boxes.extend(members.iter().map(|m| SpotBox {
            x: m.0,
            y: m.1,
            w: m.2,
            h: m.3,
            vertical: m.4 != 0,
            conf: m.5,
            dark: m.6 != 0,
            block: k,
            tag: m.7 as usize,
            tconf: m.8,
        }));
    }
    let mut pick = None;
    let mut best: Option<(i64, i64)> = None;
    for (k, (bb, members)) in ordered.iter().enumerate() {
        if bb.5 != 0 {
            continue;
        }
        let area: i64 = members.iter().map(|m| m.2 * m.3).sum();
        let score = area * if 2 * bb.1 + bb.3 >= height { 2 } else { 1 };
        let key = (score, bb.1);
        if best.is_none_or(|b| key > b) {
            pick = Some(k);
            best = Some(key);
        }
    }
    (out_boxes, out_blocks, pick)
}

fn floor_div(a: i64, b: i64) -> i64 {
    a.div_euclid(b) // b > 0: Python's //
}

impl Spotter {
    pub fn load(path: &Path, threads: usize) -> Result<Self, Error> {
        let session = onnx::session(path, threads)?;
        let meta = Meta::read(&session)?;
        if meta.str("vocr.kind")? != "spotter" {
            return Err(Error::Model(format!("{}: not a spotter", path.display())));
        }
        Ok(Self {
            tags: meta.int("vocr.tags")? as usize,
            classes: meta.get::<Vec<String>>("vocr.classes")?,
            half_above: meta.int("vocr.half_above")? as usize,
            half_above_h: meta.int("vocr.half_above_h")? as usize,
            conf_min: meta.int("vocr.conf_min")?,
            min_cells: meta.int("vocr.min_cells")? as usize,
            stride: meta.int("vocr.map_stride")?,
            session,
        })
    }

    /// 2 when a frame of this size is halved before the network (a region is read at its frame's scale).
    pub fn scale_of(&self, width: usize, height: usize) -> usize {
        let wide = self.half_above > 0 && width > self.half_above;
        let tall = self.half_above_h > 0 && height > self.half_above_h;
        if wide || tall {
            2
        } else {
            1
        }
    }

    /// The decode's maps, (4 + T) planes of ceil(h / 4) x ceil(w / 4), from a network input.
    fn maps(&mut self, x: &Grey) -> Result<(Vec<i64>, usize, usize), Error> {
        let input = TensorRef::from_array_view(([1usize, 1, x.height, x.width], x.data.as_slice()))?;
        let outputs = self.session.run(ort::inputs!["grey" => input])?;
        let (shape, head) = outputs["head"].try_extract_tensor::<i8>()?;
        let (c, hn, wn) = (shape[1] as usize, shape[2] as usize, shape[3] as usize);
        let t = self.tags;
        if c != 16 + 4 * t {
            return Err(Error::Model(format!("spotter head has {c} channels")));
        }
        let (mh, mw) = (x.height.div_ceil(4), x.width.div_ceil(4));
        let planes = 4 + t;
        let mut out = vec![0i64; planes * mh * mw];
        for dy in 0..2 {
            for dx in 0..2 {
                let q = 2 * dy + dx;
                for p in 0..planes {
                    let ch = if p < 4 { 4 * q + p } else { 16 + t * q + (p - 4) };
                    for r in 0..hn {
                        let row = 2 * r + dy;
                        if row >= mh {
                            continue;
                        }
                        for cc in 0..wn {
                            let col = 2 * cc + dx;
                            if col >= mw {
                                continue;
                            }
                            out[(p * mh + row) * mw + col] = head[(ch * hn + r) * wn + cc] as i64;
                        }
                    }
                }
            }
        }
        Ok((out, mh, mw))
    }

    /// Boxes on a frame or region (1 to 2048 px a side). `frame_size` is the frame the region was cut
    /// from, whose size decides the scale (`None`: the image itself).
    pub fn spot(&mut self, g: &Grey, frame_size: Option<(usize, usize)>) -> Result<Spots, Error> {
        if g.width == 0 || g.height == 0 || g.width > MAX_SIDE || g.height > MAX_SIDE {
            return Err(Error::Input(format!(
                "a {} x {} image: the spotter reads 1 to {MAX_SIDE} px a side",
                g.width, g.height
            )));
        }
        let (fw, fh) = frame_size.unwrap_or((g.width, g.height));
        let f = self.scale_of(fw, fh);
        let halved;
        let x = if f == 2 {
            halved = halve(g);
            &halved
        } else {
            g
        };
        let (maps, mh, mw) = self.maps(x)?;
        Ok(self.decode(&maps, mh, mw, f as i64, g))
    }

    fn decode(&self, maps: &[i64], mh: usize, mw: usize, f: i64, g: &Grey) -> Spots {
        let s = self.stride;
        let plane = |p: usize| &maps[p * mh * mw..(p + 1) * mh * mw];
        let (kmap, omap, a1map, a2map) = (plane(0), plane(1), plane(2), plane(3));
        let (w_, h_) = (g.width as i64, g.height as i64);
        let mask: Vec<bool> = kmap.iter().map(|&v| v > 0).collect();
        let mut cands: Vec<(Key, Raw)> = Vec::new();
        for cells in components(&mask, mh, mw) {
            let n = cells.len();
            if n < self.min_cells {
                continue;
            }
            let at = |m: &[i64], (r, c): (usize, usize)| m[r * mw + c];
            let conf = floor_div(cells.iter().map(|&p| at(kmap, p)).sum(), n as i64);
            if conf < self.conf_min {
                continue;
            }
            let vertical = cells.iter().map(|&p| at(omap, p)).sum::<i64>() > 0;
            let (mut near_sum, mut far_sum) = (0i64, 0i64);
            let (mut amin, mut amax) = (i64::MAX, i64::MIN);
            for &(r, c) in &cells {
                let (across, along) = if vertical { (c as i64, r as i64) } else { (r as i64, c as i64) };
                let c2 = 2 * s * across + s - 1;
                near_sum += c2 - at(a1map, (r, c));
                far_sum += c2 + at(a2map, (r, c));
                amin = amin.min(along);
                amax = amax.max(along);
            }
            let n_ = n as i64;
            let near = floor_div(f * near_sum, 2 * n_);
            let far = -floor_div(-(f * far_sum), 2 * n_);
            let (lo, hi) = (f * s * amin, f * s * (amax + 1));
            let across = far - near;
            if across < MIN_ACROSS * f {
                continue;
            }
            let pad = PAD_MIN.max(floor_div(across * PAD_PCT + 50, 100));
            let (a0, a1, b0, b1) = (near - pad, far + pad, lo - pad, hi + pad);
            let (x0, x1, y0, y1) = if vertical { (a0, a1, b0, b1) } else { (b0, b1, a0, a1) };
            let (x0, y0, x1, y1) = (x0.max(0), y0.max(0), x1.min(w_), y1.min(h_));
            if x1 <= x0 || y1 <= y0 {
                continue;
            }
            let mut scores = vec![0i64];
            scores.extend((0..self.tags).map(|t| cells.iter().map(|&p| at(plane(4 + t), p)).sum::<i64>()));
            let mut tag = 0;
            for c in 1..scores.len() {
                if scores[c] > scores[tag] {
                    tag = c;
                }
            }
            let mut tconf = 0;
            if scores.len() > 1 {
                let second = (0..scores.len()).filter(|&c| c != tag).map(|c| scores[c]).max().unwrap();
                tconf = TCONF_MAX.min(floor_div(scores[tag] - second, n_));
            }
            let v = vertical as i64;
            let key = (-conf, -n_, v, y0, x0, y1 - y0, x1 - x0, tag as i64);
            cands.push((key, (x0, y0, x1 - x0, y1 - y0, v, conf, tag as i64, tconf, 0)));
        }
        let truncated = cands.len() > BOX_MAX;
        cands.sort();
        let boxes: Vec<Raw> = cands
            .into_iter()
            .take(BOX_MAX)
            .map(|(_, (bx, by, bw, bh, v, conf, tag, tconf, _))| {
                let dark = line_dark(g, (bx as usize, by as usize, bw as usize, bh as usize)) as i64;
                (bx, by, bw, bh, v, conf, dark, tag, tconf)
            })
            .collect();
        let (boxes, blocks, pick) = group_and_order(boxes, h_);
        let presence = boxes.iter().filter(|b| b.tag == 0).map(|b| b.conf).max().unwrap_or(0);
        Spots { boxes, blocks, pick, truncated, presence }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halve_rounds_and_repeats_the_edge() {
        let g = Grey::new(3, 1, vec![10, 13, 200]);
        assert_eq!(halve(&g).data, vec![12, 200]);
    }

    #[test]
    fn dark_text_on_light() {
        let mut g = Grey::new(20, 10, vec![240; 200]);
        for x in 5..15 {
            g.data[5 * 20 + x] = 10;
        }
        assert!(line_dark(&g, (0, 0, 20, 10)));
        let inv = Grey::new(20, 10, g.data.iter().map(|v| 255 - v).collect());
        assert!(!line_dark(&inv, (0, 0, 20, 10)));
    }

    #[test]
    fn two_lines_read_top_to_bottom_as_one_block() {
        let b = |x, y, w, h| (x, y, w, h, 0, 9, 0, 0, 0);
        let (boxes, blocks, pick) = group_and_order(vec![b(10, 60, 300, 30), b(10, 20, 300, 30)], 100);
        assert_eq!(blocks.len(), 1);
        assert_eq!(boxes[0].y, 20);
        assert_eq!(pick, Some(0));
    }
}
