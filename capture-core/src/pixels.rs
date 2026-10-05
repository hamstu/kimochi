//! Portable pixel helpers shared by every capture backend.
//!
//! Backends hand these whatever their OS produced (BGRA rows with padding,
//! premultiplied alpha) and get back the crate's one frame format: tightly packed
//! RGBA8, straight alpha, top-left rows.

/// Copy a rectangle out of a BGRA buffer with `stride` bytes per row, as RGBA.
pub fn bgra_crop_to_rgba(source: &[u8], stride: usize, crop: [u32; 4]) -> Vec<u8> {
    let [x, y, w, h] = crop;
    let row_bytes = w as usize * 4;
    let mut out = vec![0u8; row_bytes * h as usize];
    for (row, target) in (y..y + h).zip(out.chunks_exact_mut(row_bytes)) {
        let from = row as usize * stride + x as usize * 4;
        for (p, q) in source[from..from + row_bytes]
            .chunks_exact(4)
            .zip(target.chunks_exact_mut(4))
        {
            // One word per pixel: swap the red and blue bytes, keep green and alpha.
            let v = u32::from_le_bytes([p[0], p[1], p[2], p[3]]);
            let swapped = (v & 0xFF00_FF00) | ((v >> 16) & 0xFF) | ((v & 0xFF) << 16);
            q.copy_from_slice(&swapped.to_le_bytes());
        }
    }
    out
}

/// Straight alpha from premultiplied, in place.
///
/// Fully opaque and fully transparent pixels are already equal in both
/// representations, which is every pixel of an ordinary screen capture, so the
/// division is only paid where there is real translucency.
pub fn unpremultiply(pixels: &mut [u8]) {
    for p in pixels.chunks_exact_mut(4) {
        let a = u32::from(p[3]);
        if a > 0 && a < 255 {
            for v in &mut p[..3] {
                *v = ((u32::from(*v) * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

/// Copy a rectangle out of a tightly packed RGBA buffer.
///
/// The caller has already established, via `crop_rect`, that the rectangle lies
/// inside the image, and that `source` holds `width * height * 4` bytes.
pub fn crop_pixels(source: &[u8], width: u32, crop: [u32; 4]) -> Vec<u8> {
    let [x, y, w, h] = crop;
    let row_bytes = w as usize * 4;
    let mut out = Vec::with_capacity(row_bytes * h as usize);
    for row in y..y + h {
        let from = (row as usize * width as usize + x as usize) * 4;
        out.extend_from_slice(&source[from..from + row_bytes]);
    }
    out
}

/// The size of an image scaled so its longest edge is at most `edge`, keeping its
/// aspect ratio; an image already that small is left as it is.
pub fn fit_within(width: u32, height: u32, edge: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= edge {
        return (width, height);
    }
    (
        (u64::from(width) * u64::from(edge) / u64::from(longest)).max(1) as u32,
        (u64::from(height) * u64::from(edge) / u64::from(longest)).max(1) as u32,
    )
}

/// Shrink a tightly packed RGBA image to `to_width` x `to_height` by averaging each
/// destination pixel's box of source pixels (every source pixel lands in exactly one
/// box). For backends that cannot scale on the GPU while capturing.
///
/// Averaging is done on whatever alpha the caller holds; for premultiplied pixels,
/// shrink first and unpremultiply after, which is the correct order. Never enlarges:
/// a target dimension larger than the source is clamped to it.
pub fn box_downscale(
    source: &[u8],
    width: u32,
    height: u32,
    to_width: u32,
    to_height: u32,
) -> Vec<u8> {
    let (to_width, to_height) = (
        to_width.clamp(1, width.max(1)),
        to_height.clamp(1, height.max(1)),
    );
    if width == 0 || height == 0 {
        return Vec::new();
    }
    let span = |i: u32, from: u32, to: u32| -> (usize, usize) {
        let start = u64::from(i) * u64::from(from) / u64::from(to);
        let end = (u64::from(i + 1) * u64::from(from) / u64::from(to)).max(start + 1);
        (start as usize, end as usize)
    };
    let columns: Vec<_> = (0..to_width).map(|x| span(x, width, to_width)).collect();
    let row_bytes = width as usize * 4;
    let mut out = Vec::with_capacity(to_width as usize * to_height as usize * 4);
    for y in 0..to_height {
        let (top, bottom) = span(y, height, to_height);
        for &(left, right) in &columns {
            let mut sum = [0u64; 4];
            for row in top..bottom {
                let line = &source[row * row_bytes..(row + 1) * row_bytes];
                for p in line[left * 4..right * 4].chunks_exact(4) {
                    for (s, v) in sum.iter_mut().zip(p) {
                        *s += u64::from(*v);
                    }
                }
            }
            let count = ((bottom - top) * (right - left)) as u64;
            out.extend(sum.iter().map(|s| ((s + count / 2) / count) as u8));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic stand-in for captured pixels, including real translucency
    /// so the conversion has something to do.
    fn buffer(width: u32, height: u32) -> Vec<u8> {
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut out = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..width * height {
            let mut next = || {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                (seed & 0xff) as u8
            };
            let a = next();
            // Premultiplied means no channel may exceed alpha.
            let clamp = |v: u8| if a == 0 { 0 } else { v.min(a) };
            let (r, g, b) = (clamp(next()), clamp(next()), clamp(next()));
            out.extend_from_slice(&[r, g, b, a]);
        }
        out
    }

    /// The property the reordering rests on.
    #[test]
    fn crop_then_convert_matches_convert_then_crop() {
        let (width, height) = (64u32, 48u32);
        let source = buffer(width, height);
        for crop in [
            [0, 0, 64, 48],
            [0, 0, 1, 1],
            [10, 20, 17, 9],
            [63, 47, 1, 1],
            [32, 0, 32, 48],
        ] {
            // Old order: convert everything, then take the rectangle.
            let mut whole = source.clone();
            unpremultiply(&mut whole);
            let old = crop_pixels(&whole, width, crop);

            // New order: take the rectangle, then convert it.
            let mut new = crop_pixels(&source, width, crop);
            unpremultiply(&mut new);

            assert_eq!(old, new, "crop {crop:?}");
            assert_eq!(new.len(), (crop[2] * crop[3] * 4) as usize);
        }
    }

    /// Stream frames arrive BGRA with padded rows; the copy honours the stride,
    /// swaps red and blue, and takes exactly the rectangle asked for.
    #[test]
    fn stream_frames_are_cropped_through_their_stride_into_rgba() {
        let (width, height, stride) = (5usize, 4usize, 32usize);
        let mut source = vec![0xEEu8; stride * height];
        for y in 0..height {
            for x in 0..width {
                let i = y * stride + x * 4;
                source[i..i + 4].copy_from_slice(&[x as u8, y as u8, 200, 255]);
            }
        }
        let out = bgra_crop_to_rgba(&source, stride, [1, 2, 3, 2]);
        assert_eq!(out.len(), 3 * 2 * 4);
        for row in 0..2usize {
            for column in 0..3usize {
                let i = (row * 3 + column) * 4;
                assert_eq!(&out[i..i + 4], &[200, 2 + row as u8, 1 + column as u8, 255]);
            }
        }
    }

    #[test]
    fn a_full_frame_crop_is_the_whole_buffer_unchanged() {
        let source = buffer(16, 8);
        assert_eq!(crop_pixels(&source, 16, [0, 0, 16, 8]), source);
    }

    #[test]
    fn the_rectangle_taken_is_the_rectangle_asked_for() {
        // Each pixel carries its own coordinates, so a misplaced row or column
        // is visible rather than merely different.
        let (width, height) = (8u32, 6u32);
        let mut source = Vec::new();
        for y in 0..height {
            for x in 0..width {
                source.extend_from_slice(&[x as u8, y as u8, 0, 255]);
            }
        }
        let out = crop_pixels(&source, width, [3, 2, 4, 3]);
        assert_eq!(out.len(), 4 * 3 * 4);
        for row in 0..3usize {
            for column in 0..4usize {
                let i = (row * 4 + column) * 4;
                assert_eq!(out[i], 3 + column as u8, "x at {row},{column}");
                assert_eq!(out[i + 1], 2 + row as u8, "y at {row},{column}");
            }
        }
    }

    #[test]
    fn opaque_and_transparent_pixels_are_left_exactly_as_they_are() {
        let mut pixels = vec![
            10, 20, 30, 255, // opaque: already straight
            0, 0, 0, 0, // transparent: nothing to recover
        ];
        let before = pixels.clone();
        unpremultiply(&mut pixels);
        assert_eq!(pixels, before);
    }

    #[test]
    fn translucent_pixels_are_scaled_back_up_and_never_overflow() {
        // Half alpha: a premultiplied 64 came from a straight 128.
        let mut pixels = vec![64, 32, 0, 128];
        unpremultiply(&mut pixels);
        assert_eq!(pixels, vec![128, 64, 0, 128]);

        // A channel equal to alpha is fully saturated and must clamp at 255,
        // not wrap.
        let mut saturated = vec![7, 7, 7, 7];
        unpremultiply(&mut saturated);
        assert_eq!(saturated, vec![255, 255, 255, 7]);
    }

    #[test]
    fn fit_within_keeps_aspect_and_never_enlarges() {
        assert_eq!(fit_within(3456, 2234, 320), (320, 206));
        assert_eq!(fit_within(2234, 3456, 320), (206, 320));
        assert_eq!(fit_within(100, 50, 320), (100, 50));
        assert_eq!(fit_within(10_000, 1, 320), (320, 1));
    }

    #[test]
    fn box_downscale_averages_each_block() {
        // 4x2 -> 2x1: each output pixel averages one 2x2 block.
        #[rustfmt::skip]
        let source = vec![
            0, 0, 0, 255,     100, 100, 100, 255,   10, 20, 30, 255,  10, 20, 30, 255,
            200, 200, 200, 255, 100, 100, 100, 255, 10, 20, 30, 255,  10, 20, 30, 255,
        ];
        let out = box_downscale(&source, 4, 2, 2, 1);
        assert_eq!(out, vec![100, 100, 100, 255, 10, 20, 30, 255]);
    }

    #[test]
    fn box_downscale_identity_and_uneven_ratios() {
        let source = buffer(7, 5);
        assert_eq!(box_downscale(&source, 7, 5, 7, 5), source);
        // Uneven ratios still produce exactly the requested size, and a solid
        // image stays solid.
        let solid: Vec<u8> = [9u8, 8, 7, 255].repeat(97 * 61);
        let out = box_downscale(&solid, 97, 61, 32, 20);
        assert_eq!(out.len(), 32 * 20 * 4);
        assert!(out.chunks_exact(4).all(|p| p == [9, 8, 7, 255]));
        // Never enlarges.
        assert_eq!(box_downscale(&source, 7, 5, 100, 100).len(), 7 * 5 * 4);
    }
}
