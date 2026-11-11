//! Grey images and the recognizer's line preprocessing (`runtime/vocr.c`, `vocr_onnx.preprocess`),
//! integer for integer.

/// An 8-bit grey image, row-major with no padding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grey {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

impl Grey {
    pub fn new(width: usize, height: usize, data: Vec<u8>) -> Self {
        assert_eq!(data.len(), width * height, "grey buffer size");
        Self { width, height, data }
    }

    /// Integer luma `(77 R + 150 G + 29 B) >> 8` of interleaved RGB or RGBA pixels (`channels` 3 or 4),
    /// rows `stride` bytes apart.
    pub fn from_interleaved(pixels: &[u8], width: usize, height: usize, stride: usize, channels: usize) -> Self {
        assert!(channels == 3 || channels == 4, "3 or 4 channels");
        assert!(stride >= width * channels && pixels.len() >= stride * height.saturating_sub(1) + width * channels);
        let mut data = Vec::with_capacity(width * height);
        for row in 0..height {
            let line = &pixels[row * stride..row * stride + width * channels];
            data.extend(line.chunks_exact(channels).map(|p| luma(p[0], p[1], p[2])));
        }
        Self { width, height, data }
    }

    #[inline]
    pub fn at(&self, x: usize, y: usize) -> u8 {
        self.data[y * self.width + x]
    }

    /// The rectangle `x, y, w, h` (inside the image) as its own image.
    pub fn crop(&self, x: usize, y: usize, w: usize, h: usize) -> Grey {
        let mut data = Vec::with_capacity(w * h);
        for row in y..y + h {
            data.extend_from_slice(&self.data[row * self.width + x..row * self.width + x + w]);
        }
        Grey { width: w, height: h, data }
    }

    /// An area-average (box filter) resize to `w x h`, for scaling a capture down to the frame size
    /// VOCR was trained on. Not part of the reference pipeline.
    pub fn resize_area(&self, w: usize, h: usize) -> Grey {
        if w == self.width && h == self.height {
            return self.clone();
        }
        let xs = spans(self.width, w);
        let ys = spans(self.height, h);
        // Horizontal pass into f32 rows, then vertical.
        let mut tmp = vec![0f32; w * self.height];
        for y in 0..self.height {
            let row = &self.data[y * self.width..(y + 1) * self.width];
            for (x, span) in xs.iter().enumerate() {
                tmp[y * w + x] = span.iter().map(|&(i, k)| row[i] as f32 * k).sum();
            }
        }
        let mut data = vec![0u8; w * h];
        for (y, span) in ys.iter().enumerate() {
            for x in 0..w {
                let v: f32 = span.iter().map(|&(i, k)| tmp[i * w + x] * k).sum();
                data[y * w + x] = v.round().clamp(0.0, 255.0) as u8;
            }
        }
        Grey { width: w, height: h, data }
    }
}

#[inline]
pub fn luma(r: u8, g: u8, b: u8) -> u8 {
    ((77 * r as u32 + 150 * g as u32 + 29 * b as u32) >> 8) as u8
}

/// Per output index, the source indices and weights (summing to 1) an area resize from `n_in` to
/// `n_out` averages; an enlargement samples linearly.
fn spans(n_in: usize, n_out: usize) -> Vec<Vec<(usize, f32)>> {
    let scale = n_in as f64 / n_out as f64;
    (0..n_out)
        .map(|o| {
            if scale <= 1.0 {
                let c = ((o as f64 + 0.5) * scale - 0.5).max(0.0);
                let i = (c.floor() as usize).min(n_in - 1);
                let j = (i + 1).min(n_in - 1);
                let t = (c - i as f64) as f32;
                return vec![(i, 1.0 - t), (j, t)];
            }
            let (a, b) = (o as f64 * scale, (o as f64 + 1.0) * scale);
            let mut out = Vec::new();
            let mut i = a.floor() as usize;
            while (i as f64) < b && i < n_in {
                let cover = (b.min(i as f64 + 1.0) - a.max(i as f64)) / scale;
                if cover > 0.0 {
                    out.push((i, cover as f32));
                }
                i += 1;
            }
            out
        })
        .collect()
}

/// `vocr_resized_width()`: round(w * height / h), half to even, clamped to [min_width, max_width].
pub fn resized_width(w: usize, h: usize, height: usize, max_width: usize, min_width: usize) -> usize {
    let (w, h, height) = (w as i64, h as i64, height as i64);
    let num = w * height;
    let mut q = (2 * num + h) / (2 * h);
    if (2 * num + h) % (2 * h) == 0 && q & 1 == 1 {
        q -= 1;
    }
    (q as usize).clamp(min_width, max_width)
}

/// `runtime/vocr.c` row_table / col_coef for an `n_in -> n_out` resize: per output index the first source
/// index and the fraction, from the same double / float arithmetic as OpenCV's INTER_LINEAR.
fn coef(n_out: usize, n_in: usize) -> (Vec<i64>, Vec<f32>) {
    let scale = 1.0 / (n_out as f64 / n_in as f64);
    let mut s = Vec::with_capacity(n_out);
    let mut f = Vec::with_capacity(n_out);
    for i in 0..n_out {
        let t = (i as f64 + 0.5) * scale;
        let fi = (t - 0.5) as f32;
        let mut si = fi as i64;
        if si as f32 > fi {
            si -= 1;
        }
        s.push(si);
        f.push(fi - si as f32);
    }
    (s, f)
}

#[inline]
fn round_even(v: f32) -> i64 {
    v.round_ties_even() as i64
}

/// The network's input for a line crop (`height x padded` uint8) and the resized width before padding:
/// `255 - grey` for dark text, the fixed-point INTER_LINEAR resize to `height`, then the right pad to a
/// multiple of `stride` repeating the last column.
pub fn preprocess(g: &Grey, invert: bool, height: usize, stride: usize, max_width: usize) -> (Vec<u8>, usize) {
    let (h, w) = (g.height, g.width);
    assert!(h > 0 && w > 0 && h <= 65535 && w <= 65535, "an empty or oversized crop");
    let px = |x: i64, y: i64| -> i64 {
        let v = g.data[y as usize * w + x as usize] as i64;
        if invert { 255 - v } else { v }
    };
    let nw = resized_width(w, h, height, max_width, 8);
    let padded = nw.div_ceil(stride) * stride;
    let (sy, fy) = coef(height, h);
    let (sx, fx) = coef(nw, w);
    let (w_, h_) = (w as i64, h as i64);
    let mut cols = Vec::with_capacity(nw);
    for i in 0..nw {
        let (mut s, mut f) = (sx[i], fx[i]);
        if s < 0 {
            f = 0.0;
            s = 0;
        }
        if s >= w_ - 1 {
            f = 0.0;
            s = w_ - 1;
        }
        let a0 = round_even((1.0f32 - f) * 2048.0f32);
        let a1 = round_even(f * 2048.0f32);
        let s1 = if s + 1 < w_ { s + 1 } else { s };
        cols.push((s, s1, a0, a1));
    }
    let mut out = vec![0u8; height * padded];
    for r in 0..height {
        let r0 = sy[r].clamp(0, h_ - 1);
        let r1 = (sy[r] + 1).clamp(0, h_ - 1);
        let b0 = round_even((1.0f32 - fy[r]) * 2048.0f32);
        let b1 = round_even(fy[r] * 2048.0f32);
        for c in 0..padded {
            let (s, s1, a0, a1) = cols[c.min(nw - 1)];
            let h0 = px(s, r0) * a0 + px(s1, r0) * a1;
            let h1 = px(s, r1) * a0 + px(s1, r1) * a1;
            let v = (((b0 * (h0 >> 4)) >> 16) + ((b1 * (h1 >> 4)) >> 16) + 2) >> 2;
            out[r * padded + c] = v as u8;
        }
    }
    (out, nw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resized_width_rounds_half_to_even_and_clamps() {
        assert_eq!(resized_width(100, 32, 32, 1024, 8), 100);
        assert_eq!(resized_width(5, 64, 32, 1024, 8), 8); // 2.5 -> clamped
        assert_eq!(resized_width(3, 2, 32, 1024, 8), 48);
        assert_eq!(resized_width(1, 64, 32, 1024, 8), 8);
        assert_eq!(resized_width(5000, 32, 32, 1024, 8), 1024);
        // 13 * 32 / 16 = 26 exactly; 25 * 32 / 64 = 12.5 -> 12 (even)
        assert_eq!(resized_width(25, 64, 32, 1024, 8), 12);
        assert_eq!(resized_width(27, 64, 32, 1024, 8), 14); // 13.5 -> 14
    }

    #[test]
    fn preprocess_pads_by_repeating_the_last_column() {
        let g = Grey::new(10, 32, (0..320).map(|i| (i % 10 * 20) as u8).collect());
        let (x, nw) = preprocess(&g, false, 32, 8, 1024);
        assert_eq!(nw, 10);
        assert_eq!(x.len(), 32 * 16);
        for r in 0..32 {
            for c in 10..16 {
                assert_eq!(x[r * 16 + c], x[r * 16 + 9]);
            }
            // Same height: the resize is the identity.
            for c in 0..10 {
                assert_eq!(x[r * 16 + c], (c * 20) as u8);
            }
        }
        let (inv, _) = preprocess(&g, true, 32, 8, 1024);
        assert_eq!(inv[0], 255);
    }

    #[test]
    fn area_resize_averages() {
        let g = Grey::new(4, 2, vec![0, 100, 200, 0, 0, 100, 200, 0]);
        let r = g.resize_area(2, 1);
        assert_eq!(r.data, vec![50, 100]);
    }
}
