//! The VOLM character n-gram LM (`runtime/vocr_lm.h`) and `runtime/vocr_lm.c`'s CTC prefix beam search,
//! as `vocr_onnx.CharLM` ports them.
use crate::Error;

const UNK: i64 = 0;
const BOS: i64 = 1;
const EOS: i64 = 2;
const FIRST: i64 = 3;
const NONE: i64 = -1;
const NEG: i64 = -(1 << 30);
const LP_FLOOR: i64 = -65536;
const MARGIN_CAP: f32 = 64.0;
const MAX_FRAMES: usize = 1024;
pub const FLAG_BOS: u32 = 1;
pub const FLAG_EOS: u32 = 2;
const QL: i64 = 1024;
const BRACKETS: [(char, char); 8] =
    [('「', '」'), ('『', '』'), ('（', '）'), ('【', '】'), ('〈', '〉'), ('《', '》'), ('〔', '〕'), ('［', '］')];
const MAX_ORDER: usize = 6;

/// The decoder's settings (beam, top-K, the gate and the bracket penalty; alpha, beta, gate and bracket
/// in 1/1000 nat).
#[derive(Debug, Clone, Copy)]
pub struct LmSettings {
    pub beam: usize,
    pub topk: usize,
    pub gate: i64,
    pub bracket: i64,
    pub alpha: i64,
    pub beta: i64,
    pub flags: u32,
}

impl LmSettings {
    /// Rubi's settings for `vocr_lm6_o3_1000k.vlm` (and the 4000k build): beam 8, top-8, gate and
    /// bracket 8 nats, weight 0.6, bonus 2.5 nats, the start-of-line context.
    pub const RUBI_LM6: LmSettings =
        LmSettings { beam: 8, topk: 8, gate: 8000, bracket: 8000, alpha: 600, beta: 2500, flags: FLAG_BOS };
}

struct Level {
    tok: Vec<u16>,
    prob: Vec<u8>,
    bo: Vec<u8>,
    child: Vec<u32>,
    cbp: Vec<i16>,
    cbb: Vec<i16>,
}

pub struct CharLm {
    order: usize,
    codepoints: Vec<u32>,
    levels: Vec<Level>,
    pub settings: LmSettings,
    /// Per recognizer vocabulary: the LM token of each class (brackets folded) and its bracket role.
    maps: Option<(usize, Vec<i64>, Vec<u8>)>,
}

type State = [i64; MAX_ORDER - 1];

fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}

fn slice(b: &[u8], off: usize, len: usize) -> Result<&[u8], Error> {
    b.get(off..off.checked_add(len).ok_or_else(|| Error::Model("VOLM offset".into()))?)
        .ok_or_else(|| Error::Model("VOLM section out of range".into()))
}

impl CharLm {
    pub fn from_bytes(b: &[u8], settings: LmSettings) -> Result<Self, Error> {
        if b.len() < 256 || &b[..4] != b"VOLM" {
            return Err(Error::Model("not a VOLM blob".into()));
        }
        let h: Vec<u32> = (0..7).map(|i| u32_at(b, 4 + 4 * i)).collect();
        let (version, total, order, v, crc, voc_off) = (h[0], h[1] as usize, h[2] as usize, h[3] as i64, h[5], h[6] as usize);
        if version != 1 || total != b.len() || !(2..=MAX_ORDER).contains(&order) || v < FIRST {
            return Err(Error::Model("unsupported VOLM header".into()));
        }
        if crc != crc32fast::hash(&b[64..total]) {
            return Err(Error::Model("VOLM CRC mismatch".into()));
        }
        let n_cp = (v - FIRST) as usize;
        let codepoints = slice(b, voc_off, 4 * n_cp)?.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
        let mut levels = Vec::with_capacity(order);
        for k in 1..=order {
            let o = 64 + (k - 1) * 32;
            let f: Vec<usize> = (0..7).map(|i| u32_at(b, o + 4 * i) as usize).collect();
            let (n, ot, op, ob, oc, ocp, ocb) = (f[0], f[1], f[2], f[3], f[4], f[5], f[6]);
            let u16s = |off: usize, len: usize| -> Result<Vec<u16>, Error> {
                Ok(slice(b, off, 2 * len)?.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect())
            };
            let i16s = |off: usize, len: usize| -> Result<Vec<i16>, Error> {
                Ok(slice(b, off, 2 * len)?.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect())
            };
            let upper = k < order;
            levels.push(Level {
                tok: if k >= 2 { u16s(ot, n)? } else { Vec::new() },
                prob: slice(b, op, n)?.to_vec(),
                bo: if upper { slice(b, ob, n)?.to_vec() } else { Vec::new() },
                child: if upper {
                    slice(b, oc, 4 * (n + 1))?.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect()
                } else {
                    Vec::new()
                },
                cbp: i16s(ocp, 256)?,
                cbb: if upper { i16s(ocb, 256)? } else { Vec::new() },
            });
        }
        Ok(Self { order, codepoints, levels, settings, maps: None })
    }

    fn token_of(&self, text: &str) -> i64 {
        let mut it = text.chars();
        let (Some(ch), None) = (it.next(), it.next()) else { return UNK };
        match self.codepoints.binary_search(&(ch as u32)) {
            Ok(i) => FIRST + i as i64,
            Err(_) => UNK,
        }
    }

    /// `_find(k, parent, t)`: the order-(k+1) entry under `parent` for token `t`.
    fn find(&self, k: usize, parent: i64, t: i64) -> i64 {
        let child = &self.levels[k - 1].child;
        let (mut lo, mut hi) = (child[parent as usize] as usize, child[parent as usize + 1] as usize);
        let toks = &self.levels[k].tok;
        while lo < hi {
            let mid = (lo + hi) >> 1;
            let v = toks[mid] as i64;
            if v < t {
                lo = mid + 1;
            } else if v > t {
                hi = mid;
            } else {
                return mid as i64;
            }
        }
        NONE
    }

    fn initial(&self) -> State {
        let mut s = [NONE; MAX_ORDER - 1];
        if self.settings.flags & FLAG_BOS != 0 {
            s[0] = BOS;
        }
        s
    }

    /// (log P(t | state) in Q10, the next state): `vocr_lm.c` lm_score.
    fn score(&self, state: &State, t: i64) -> (i64, State) {
        let n = self.order;
        let mut e = [NONE; MAX_ORDER];
        for k in 1..n {
            let p = state[k - 1];
            e[k] = if p != NONE { self.find(k, p, t) } else { NONE };
        }
        let mut lp = 0i64;
        let mut hit = false;
        for k in (1..n).rev() {
            if e[k] != NONE {
                let l = &self.levels[k];
                lp += l.cbp[l.prob[e[k] as usize] as usize] as i64;
                hit = true;
                break;
            }
            if state[k - 1] != NONE {
                let l = &self.levels[k - 1];
                lp += l.cbb[l.bo[state[k - 1] as usize] as usize] as i64;
            }
        }
        if !hit {
            let l = &self.levels[0];
            lp += l.cbp[l.prob[t as usize] as usize] as i64;
        }
        let mut next = [NONE; MAX_ORDER - 1];
        next[0] = t;
        next[1..(n - 1)].copy_from_slice(&e[1..(n - 1)]);
        (lp, next)
    }

    fn class_maps(&mut self, vocab: &[String]) -> (&[i64], &[u8]) {
        let key = vocab.as_ptr() as usize ^ vocab.len();
        if self.maps.as_ref().is_none_or(|m| m.0 != key) {
            let mut cmap = vec![UNK];
            cmap.extend(vocab[1..].iter().map(|t| {
                let r = bracket_role(t);
                if r == 0 {
                    self.token_of(t)
                } else if r & 0x80 != 0 {
                    self.token_of("」")
                } else {
                    self.token_of("「")
                }
            }));
            let roles = vocab.iter().map(|t| bracket_role(t)).collect();
            self.maps = Some((key, cmap, roles));
        }
        let m = self.maps.as_ref().unwrap();
        (&m.1, &m.2)
    }

    /// `vocr_lm_decode`: the classes of the best prefix, from each frame's top-K logits and classes
    /// (`k` per frame) and its blank logit.
    pub fn decode_classes(&mut self, vocab: &[String], topv: &[f32], topc: &[i64], k_per: usize, blank: Option<&[f32]>) -> Result<Vec<i64>, Error> {
        let t_len = topv.len().checked_div(k_per).unwrap_or(0);
        if t_len > MAX_FRAMES {
            return Err(Error::Input(format!("{t_len} frames: the decoder takes at most {MAX_FRAMES}")));
        }
        let s = self.settings;
        let k = if t_len > 0 { s.topk.min(k_per) } else { 0 };
        let (a, b, g, br) = (milli_q10(s.alpha), milli_q10(s.beta), milli_q10(s.gate), milli_q10(s.bracket));
        let use_lm = a != 0;
        let (cmap, roles) = {
            let (c, r) = self.class_maps(vocab);
            (c.to_vec(), r.to_vec())
        };
        let mut par = vec![NONE];
        let mut cls = vec![0i64];
        let mut ln = vec![0i64];
        let mut hs = vec![0u32];
        let mut bk = vec![0u32];
        let mut st = vec![self.initial()];
        let mut hyps: Vec<(usize, i64, i64)> = vec![(0, 0, NEG)];
        let mut cand: Vec<(i64, i64)> = Vec::with_capacity(k + 1);
        for t in 0..t_len {
            let tv = &topv[t * k_per..(t + 1) * k_per];
            let tc = &topc[t * k_per..(t + 1) * k_per];
            cand.clear();
            cand.push((tc[0], 0));
            for j in 1..k {
                let q = margin_q10(tv[0], tv[j]);
                if -q >= g {
                    break;
                }
                cand.push((tc[j], q));
            }
            if let Some(bl) = blank {
                if cand.iter().all(|&(c, _)| c != 0) {
                    let q = margin_q10(tv[0], bl[t]);
                    if -q < g {
                        cand.push((0, q));
                    }
                }
            }
            let mut stay = vec![[NEG, NEG]; hyps.len()];
            let mut new: Vec<(usize, i64, i64, State, u32)> = Vec::new();
            for (i, &(n, sb, snb)) in hyps.iter().enumerate() {
                let best = sb.max(snb);
                let last = if n != 0 { cls[n] } else { 0 };
                for &(c, q) in &cand {
                    if c == 0 {
                        stay[i][0] = stay[i][0].max(best + q);
                        continue;
                    }
                    let src = if c == last {
                        if snb > NEG {
                            stay[i][1] = stay[i][1].max(snb + q);
                        }
                        sb
                    } else {
                        best
                    };
                    if src <= NEG {
                        continue;
                    }
                    let h = hs[n].wrapping_mul(0x9E3779B1).wrapping_add(c as u32).wrapping_add(1);
                    let found = hyps.iter().position(|&(m, _, _)| {
                        m != 0 && cls[m] == c && ln[m] == ln[n] + 1 && hs[m] == h && same_prefix(&par, &cls, par[m], n as i64)
                    });
                    let (lmq, nst) = if use_lm {
                        let (lp, nst) = self.score(&st[n], cmap[c as usize]);
                        (tdiv(a * lp.clamp(LP_FLOOR, 0), QL), nst)
                    } else {
                        (0, st[n])
                    };
                    let mut val = src + q + lmq + b;
                    let mut bst = 0;
                    if br != 0 {
                        let (next, mis) = bracket_next(bk[n], roles[c as usize]);
                        bst = next;
                        if mis {
                            val -= br;
                        }
                    }
                    match found {
                        Some(j) => stay[j][1] = stay[j][1].max(val),
                        None => new.push((n, c, val, nst, bst)),
                    }
                }
            }
            let mut ranked: Vec<(i64, usize)> = stay
                .iter()
                .enumerate()
                .filter_map(|(i, x)| (x[0].max(x[1]) > NEG).then_some((x[0].max(x[1]), i)))
                .collect();
            ranked.extend(new.iter().enumerate().filter(|(_, e)| e.2 > NEG).map(|(j, e)| (e.2, hyps.len() + j)));
            ranked.sort_by(|x, y| y.0.cmp(&x.0).then(x.1.cmp(&y.1)));
            let mut next = Vec::with_capacity(s.beam);
            for &(_, idx) in ranked.iter().take(s.beam) {
                if idx < hyps.len() {
                    next.push((hyps[idx].0, stay[idx][0], stay[idx][1]));
                } else {
                    let (n, c, val, nst, bst) = new[idx - hyps.len()];
                    par.push(n as i64);
                    cls.push(c);
                    ln.push(ln[n] + 1);
                    hs.push(hs[n].wrapping_mul(0x9E3779B1).wrapping_add(c as u32).wrapping_add(1));
                    bk.push(bst);
                    st.push(nst);
                    next.push((par.len() - 1, NEG, val));
                }
            }
            hyps = next;
        }
        let mut best = 0usize;
        let mut best_s: Option<i64> = None;
        for &(n, sb, snb) in &hyps {
            let mut sc = sb.max(snb);
            if use_lm && s.flags & FLAG_EOS != 0 {
                let (lp, _) = self.score(&st[n], EOS);
                sc += tdiv(a * lp.clamp(LP_FLOOR, 0), QL);
            }
            if best_s.is_none_or(|b| sc > b) {
                best = n;
                best_s = Some(sc);
            }
        }
        let mut out = Vec::new();
        let mut n = best as i64;
        while n > 0 {
            out.push(cls[n as usize]);
            n = par[n as usize];
        }
        out.reverse();
        Ok(out)
    }
}

fn same_prefix(par: &[i64], cls: &[i64], mut x: i64, mut y: i64) -> bool {
    while x != y {
        if cls[x as usize] != cls[y as usize] {
            return false;
        }
        x = par[x as usize];
        y = par[y as usize];
    }
    true
}

fn tdiv(a: i64, b: i64) -> i64 {
    a / b // Rust's integer division truncates toward zero, as C's
}

fn milli_q10(x: i64) -> i64 {
    let q = (x.abs() * QL + 500) / 1000;
    if x >= 0 {
        q
    } else {
        -q
    }
}

// `!(d >= 0)` is the C code's test: it also catches NaN.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
fn margin_q10(top: f32, v: f32) -> i64 {
    let mut d = top - v;
    if !(d >= 0.0) {
        d = 0.0;
    } else if d > MARGIN_CAP {
        d = MARGIN_CAP;
    }
    -((d * QL as f32 + 0.5) as i64).max(1)
}

fn bracket_role(text: &str) -> u8 {
    let mut it = text.chars();
    let (Some(ch), None) = (it.next(), it.next()) else { return 0 };
    if ch == '(' {
        return 3;
    }
    if ch == ')' {
        return 0x80 | 3;
    }
    for (k, &(o, c)) in BRACKETS.iter().enumerate() {
        let k = (k + 1) as u8;
        if ch == o {
            return k;
        }
        if ch == c {
            return 0x80 | k;
        }
    }
    0
}

fn bracket_next(st: u32, r: u8) -> (u32, bool) {
    let (s0, s1) = (st & 0xFF, st >> 8);
    if r == 0 {
        return (st, false);
    }
    let r = r as u32;
    if r & 0x80 == 0 {
        return (r | (s0 << 8), false);
    }
    let r = r & 0x7F;
    if s0 == r {
        return (s1, false);
    }
    if s0 == 0 {
        return (st, false);
    }
    (if s1 == r { 0 } else { st }, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn margins_and_brackets() {
        assert_eq!(margin_q10(1.0, 1.0), -1);
        assert_eq!(margin_q10(1.0, f32::NEG_INFINITY), -65536);
        assert_eq!(margin_q10(1.0, f32::NAN), -1);
        assert_eq!(milli_q10(8000), 8192);
        assert_eq!(milli_q10(-600), -614);
        assert_eq!(bracket_role("「"), 1);
        assert_eq!(bracket_role("』"), 0x82);
        assert_eq!(bracket_next(0, 1), (1, false));
        assert_eq!(bracket_next(1, 0x81), (0, false));
        assert_eq!(bracket_next(1, 0x82), (1, true));
        assert_eq!(bracket_next(0, 0x82), (0, false));
        assert_eq!(tdiv(-7, 2), -3);
    }
}
