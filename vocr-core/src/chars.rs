//! The greedy CTC characters, their confidence (`runtime/vocr.c`) and their cells along the line
//! (`runtime/vocr_charbox.c` without INK or PITCH, `vocr_charbox_align` for the LM's text).

/// One character with its cell along the line. `x`, `x0`, `x1` are in the crop's pixels until the
/// pipeline moves them into the frame's; `y0`, `y1` are the line's rows.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Char {
    pub text: String,
    /// Its class, or -1 for a character the LM inserted.
    pub cls: i64,
    /// Its run of CTC frames (-1, -1 for an LM insertion).
    pub f0: i64,
    pub f1: i64,
    pub x: f32,
    pub x0: f32,
    pub x1: f32,
    pub y0: i64,
    pub y1: i64,
    /// The confidence of its first frame (`topk_conf`); an LM insertion's is 0.
    pub conf: f32,
}

const LOG2E: u32 = 0x3FB8AA3B;
const POLY: [u32; 7] = [0x39218489, 0x3AAEC3FF, 0x3C1D955B, 0x3D635847, 0x3E75FDF0, 0x3F317218, 0x3F800000];

/// `runtime/vocr.c` exp_neg in float32 (x clamped to [-30, 0]).
pub fn exp_neg(x: f32) -> f32 {
    let mut x = if x > -30.0 { x } else { -30.0 };
    if x > 0.0 {
        x = 0.0;
    }
    let t = x * f32::from_bits(LOG2E);
    let mut e = t as i32;
    if e as f32 > t {
        e -= 1;
    }
    let f = t - e as f32;
    let mut p = f32::from_bits(POLY[0]);
    for c in &POLY[1..] {
        p = p * f + f32::from_bits(*c);
    }
    p * f32::from_bits(((e + 127) as u32) << 23)
}

/// `vocr.c` topk_conf for one frame: 1 / (1 + sum_j exp_neg(v_j - v_0)), in order.
pub fn topk_conf(top: &[f32]) -> f32 {
    let mut s = 1.0f32;
    for v in &top[1..] {
        s += exp_neg(*v - top[0]);
    }
    1.0 / s
}

/// The greedy characters as (class, f0, f1): a frame's class is emitted when it is not the blank and
/// differs from the frame before.
pub fn spans(best: &[i64]) -> Vec<(i64, i64, i64)> {
    let mut out: Vec<(i64, i64, i64)> = Vec::new();
    let mut last = 0;
    for (t, &c) in best.iter().enumerate() {
        let t = t as i64;
        if c != 0 && c != last {
            out.push((c, t, t));
        } else if c != 0 && c == last {
            out.last_mut().expect("a run").2 = t;
        }
        last = c;
    }
    out
}

const CLOSE: &str = "、。，．」』）】〉》〕｝］〙〗”’";
const OPEN: &str = "「『（【〈《〔｛［〘〖“‘";
const DOTS: &str = "…‥・";
const SMALL: &str = "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ";
const LONG: &str = "ー―─～〜－";
const MARK: &str = "！？♪☆★♥♡※";
/// Charbox fixed point: 1/16 px.
pub const Q: i64 = 16;

/// `eval/charbox.py` group(): 0 other, 1 close, 2 open, 3 dots, 4 small, 5 long, 6 mark, 7 half.
pub fn char_group(text: &str) -> usize {
    let mut it = text.chars();
    let (Some(ch), None) = (it.next(), it.next()) else { return 0 };
    for (g, set) in [(1, CLOSE), (2, OPEN), (3, DOTS), (4, SMALL), (5, LONG), (6, MARK)] {
        if set.contains(ch) {
            return g;
        }
    }
    let o = ch as u32;
    if o < 0x80 || (0xFF61..=0xFF9F).contains(&o) {
        7
    } else {
        0
    }
}

fn div_round(a: i64, b: i64) -> i64 {
    if a >= 0 {
        (a + b / 2) / b
    } else {
        -((-a + b / 2) / b)
    }
}

/// Per greedy character (centre, x0, x1) in 1/16 crop px: calibrated frame centres, cells cut halfway
/// between neighbours, the outer ones half the median pitch wide.
pub fn cells(sp: &[(i64, i64, i64)], w: i64, h: i64, nw: i64, cal: &[i64; 9], groups: &[u8], stride: i64) -> Vec<(i64, i64, i64)> {
    let n = sp.len();
    if n == 0 {
        return Vec::new();
    }
    let c: Vec<i64> = sp
        .iter()
        .map(|&(cls, f0, _)| {
            let r = Q * (stride * f0 + stride / 2) + cal[0] + cal[1 + groups[cls as usize] as usize];
            div_round(r * w, nw).max(0).min(w * Q)
        })
        .collect();
    let mut d: Vec<i64> = c.windows(2).map(|p| p[1] - p[0]).collect();
    d.sort_unstable();
    let mut pitch = if d.is_empty() { h * Q } else { d[(d.len() - 1) / 2] };
    if pitch <= 0 {
        pitch = h * Q;
    }
    let cuts: Vec<i64> = c.windows(2).map(|p| div_round(p[0] + p[1], 2)).collect();
    let mut lo = vec![(c[0] - pitch / 2).max(0)];
    lo.extend_from_slice(&cuts);
    let mut hi = cuts;
    hi.push((c[n - 1] + pitch / 2).min(w * Q));
    (0..n).map(|i| (c[i], lo[i], lo[i].max(hi[i]))).collect()
}

/// `vocr_charbox.h` VOCR_CHARBOX_SYNC.
const SYNC: usize = 8;

/// `vocr_charbox_align`: dst[j] -> the index of the src character it is aligned to, or -1 (inserted).
pub fn align_map<T: PartialEq>(src: &[T], dst: &[T]) -> Vec<i64> {
    let (n, m) = (src.len(), dst.len());
    let mut out = vec![-1i64; m];
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if src[i] == dst[j] {
            out[j] = i as i64;
            i += 1;
            j += 1;
            continue;
        }
        let mut found = None;
        for s in 1..=2 * SYNC {
            let mut best: Option<(usize, usize, usize)> = None;
            for di in s.saturating_sub(SYNC)..=s.min(SYNC) {
                let dj = s - di;
                if i + di >= n || j + dj >= m || src[i + di] != dst[j + dj] {
                    continue;
                }
                if !(i + di + 1 >= n || j + dj + 1 >= m || src[i + di + 1] == dst[j + dj + 1]) {
                    continue;
                }
                let key = di.abs_diff(dj) * 64 + dj;
                if best.is_none_or(|b| key < b.0) {
                    best = Some((key, di, dj));
                }
            }
            if let Some((_, di, dj)) = best {
                found = Some((di, dj));
                break;
            }
        }
        let Some((di, dj)) = found else {
            out[j] = i as i64;
            i += 1;
            j += 1;
            continue;
        };
        for t in 0..di.min(dj) {
            out[j + t] = (i + t) as i64;
        }
        i += di;
        j += dj;
    }
    out
}

/// Cells for the characters of `text` (the beam + LM text) from the greedy characters: an aligned
/// character takes its greedy character's cell, an inserted one its neighbour's (the one before it,
/// after it at the line's start).
pub fn place(text: &str, chars: &[Char]) -> Vec<Char> {
    let joined: String = chars.iter().map(|c| c.text.as_str()).collect();
    if joined == text {
        return chars.to_vec();
    }
    let src: Vec<&str> = chars.iter().map(|c| c.text.as_str()).collect();
    let dst: Vec<String> = text.chars().map(String::from).collect();
    let dst_ref: Vec<&str> = dst.iter().map(String::as_str).collect();
    let m = align_map(&src, &dst_ref);
    let mut out = Vec::with_capacity(dst.len());
    for (j, (ch, &i)) in dst.into_iter().zip(&m).enumerate() {
        if i >= 0 {
            out.push(Char { text: ch, ..chars[i as usize].clone() });
            continue;
        }
        let before = m[..j].iter().rev().find(|&&k| k >= 0);
        let after = m[j + 1..].iter().find(|&&k| k >= 0);
        let base = Char { text: ch, cls: -1, f0: -1, f1: -1, x: 0.0, x0: 0.0, x1: 0.0, y0: 0, y1: 0, conf: 0.0 };
        out.push(match before.or(after) {
            Some(&k) => {
                let nb = &chars[k as usize];
                Char { x: nb.x, x0: nb.x0, x1: nb.x1, y0: nb.y0, y1: nb.y1, ..base }
            }
            None => base,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_merge_repeats_and_split_on_blank() {
        assert_eq!(spans(&[0, 3, 3, 0, 3, 5, 5, 0]), vec![(3, 1, 2), (3, 4, 4), (5, 5, 6)]);
        assert!(spans(&[0, 0]).is_empty());
    }

    #[test]
    fn exp_neg_matches_exp() {
        for x in [0.0f32, -0.5, -1.0, -3.3, -10.0, -29.9] {
            let r = exp_neg(x);
            assert!((r - x.exp()).abs() <= 1e-6 * x.exp().max(1e-6), "{x}: {r}");
        }
        assert_eq!(exp_neg(5.0), 1.0);
        assert!(exp_neg(-100.0) > 0.0);
        assert_eq!(topk_conf(&[1.0, f32::NEG_INFINITY]), 1.0 / (1.0 + exp_neg(-30.0)));
    }

    #[test]
    fn groups() {
        assert_eq!(char_group("」"), 1);
        assert_eq!(char_group("「"), 2);
        assert_eq!(char_group("っ"), 4);
        assert_eq!(char_group("A"), 7);
        assert_eq!(char_group("ｱ"), 7);
        assert_eq!(char_group("日"), 0);
        assert_eq!(char_group(""), 0);
    }

    #[test]
    fn align_takes_the_balanced_skip() {
        let a: Vec<char> = "abcdef".chars().collect();
        assert_eq!(align_map(&a, &"abXcdef".chars().collect::<Vec<_>>()), vec![0, 1, -1, 2, 3, 4, 5]);
        assert_eq!(align_map(&a, &"abdef".chars().collect::<Vec<_>>()), vec![0, 1, 3, 4, 5]);
        assert_eq!(align_map(&a, &"abYdef".chars().collect::<Vec<_>>()), vec![0, 1, 2, 3, 4, 5]);
    }

    #[test]
    fn inserted_characters_share_a_neighbours_cell() {
        let c = |t: &str, x0: f32| Char { text: t.into(), cls: 1, f0: 0, f1: 0, x: x0 + 5.0, x0, x1: x0 + 10.0, y0: 0, y1: 20, conf: 1.0 };
        let greedy = vec![c("あ", 0.0), c("い", 10.0)];
        let placed = place("あうい", &greedy);
        assert_eq!(placed[1].x0, 0.0);
        assert_eq!(placed[1].cls, -1);
        assert_eq!(placed[2].x0, 10.0);
        let placed = place("うあい", &greedy);
        assert_eq!(placed[0].x0, 0.0);
    }

    #[test]
    fn cells_tile_the_line() {
        let groups = vec![0u8; 10];
        let sp = vec![(1, 1, 1), (2, 3, 4), (3, 6, 6)];
        let cal = [0; 9];
        let cs = cells(&sp, 64, 32, 64, &cal, &groups, 8);
        assert_eq!(cs.len(), 3);
        for w in cs.windows(2) {
            assert_eq!(w[0].2, w[1].1);
        }
        assert_eq!(cs[0].0, 16 * 12);
    }
}
