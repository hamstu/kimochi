//! A perceptual hash of captured pixels, computed where the pixels already are.
//!
//! The browser side used to produce this by fetching the frame's PNG over the
//! `capture:` protocol, decoding it, drawing it into a 9x8 canvas and reading the
//! pixels back — a PNG encode, an HTTP round trip, a decode and a canvas readback
//! to produce sixteen hex characters. Something in that sequence threw
//! `Load failed` in a saved diagnostic sample, and the loop carried on to the
//! expensive request anyway. Which step failed was never established.
//!
//! Here the same number is computed straight off the RGBA buffer the capture
//! already owns, so the whole sequence is gone rather than repaired.
//!
//! This is a cheap signal, not a semantic one: it says whether the picture moved,
//! never whether the words did. The scheduler reports it and, only when the user
//! explicitly chooses the image observer, settles on it.

/// dHash needs one extra column to produce 8 horizontal comparisons per row.
pub const HASH_WIDTH: u32 = 9;
pub const HASH_HEIGHT: u32 = 8;

/// Exact-content digest for observation identity, NOT the approximate dHash.
/// The native observation cache also compares bytes, so cache reuse never
/// depends on a hash collision. This digest is only a session-local UI hint.
pub fn content_fingerprint(frame: &crate::Frame) -> String {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    frame.info.source_id.hash(&mut hash);
    frame.info.width.hash(&mut hash);
    frame.info.height.hash(&mut hash);
    frame.info.crop_pixels.hash(&mut hash);
    frame.pixels.hash(&mut hash);
    format!("{:016x}", hash.finish())
}

/// Rec. 601 luminance, matching `ui/dhash.ts` so the two describe the same thing.
fn luma(r: f64, g: f64, b: f64) -> f64 {
    r * 0.299 + g * 0.587 + b * 0.114
}

/// 64-bit difference hash of an RGBA buffer, as 16 lowercase hex characters.
///
/// The image is box-averaged down to 9x8 and each bit records whether a cell is
/// brighter than the one to its right. Averaging rather than sampling matters for
/// text: a nearest-neighbour downscale of a thin glyph flickers between frames
/// that look identical to a reader.
///
/// Deliberately not bit-compatible with the canvas implementation it replaces —
/// a browser's `drawImage` filter is not specified — and it does not need to be.
/// Hashes are only ever compared with other hashes from this function.
pub fn dhash_rgba(pixels: &[u8], width: u32, height: u32) -> Option<String> {
    if width == 0 || height == 0 {
        return None;
    }
    let expected = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    if pixels.len() < expected {
        return None;
    }

    let mut cells = [0.0f64; (HASH_WIDTH * HASH_HEIGHT) as usize];
    for cy in 0..HASH_HEIGHT {
        // Integer edges, so every source pixel belongs to exactly one cell and no
        // cell is ever empty even for an image narrower than nine pixels.
        let y0 = (u64::from(cy) * u64::from(height) / u64::from(HASH_HEIGHT)) as u32;
        let y1 = (((u64::from(cy) + 1) * u64::from(height)).div_ceil(u64::from(HASH_HEIGHT))
            as u32)
            .max(y0 + 1)
            .min(height);
        for cx in 0..HASH_WIDTH {
            let x0 = (u64::from(cx) * u64::from(width) / u64::from(HASH_WIDTH)) as u32;
            let x1 = (((u64::from(cx) + 1) * u64::from(width)).div_ceil(u64::from(HASH_WIDTH))
                as u32)
                .max(x0 + 1)
                .min(width);
            let mut total = 0.0f64;
            let mut count = 0u32;
            for y in y0..y1 {
                let row = y as usize * width as usize * 4;
                for x in x0..x1 {
                    let i = row + x as usize * 4;
                    total += luma(
                        f64::from(pixels[i]),
                        f64::from(pixels[i + 1]),
                        f64::from(pixels[i + 2]),
                    );
                    count += 1;
                }
            }
            cells[(cy * HASH_WIDTH + cx) as usize] = if count == 0 {
                0.0
            } else {
                total / f64::from(count)
            };
        }
    }

    let mut bits: u64 = 0;
    let mut n = 0;
    for cy in 0..HASH_HEIGHT {
        for cx in 0..HASH_WIDTH - 1 {
            let left = cells[(cy * HASH_WIDTH + cx) as usize];
            let right = cells[(cy * HASH_WIDTH + cx + 1) as usize];
            bits = (bits << 1) | u64::from(left > right);
            n += 1;
        }
    }
    debug_assert_eq!(n, 64);
    Some(format!("{bits:016x}"))
}

/// Differing bits between two hashes of the same length; `None` if they differ.
pub fn hamming(a: &str, b: &str) -> Option<u32> {
    if a.len() != b.len() {
        return None;
    }
    let left = u64::from_str_radix(a, 16).ok()?;
    let right = u64::from_str_radix(b, 16).ok()?;
    Some((left ^ right).count_ones())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, value: u8) -> Vec<u8> {
        vec![value; (width * height * 4) as usize]
    }

    /// A left-to-right ramp: every cell is darker than the one to its right.
    fn ramp(width: u32, height: u32) -> Vec<u8> {
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..height {
            for x in 0..width {
                let v = (x * 255 / width.max(1)) as u8;
                pixels.extend_from_slice(&[v, v, v, 255]);
            }
        }
        pixels
    }

    #[test]
    fn a_flat_image_has_no_set_bits() {
        assert_eq!(
            dhash_rgba(&solid(64, 64, 128), 64, 64).unwrap(),
            format!("{:016x}", 0u64)
        );
    }

    #[test]
    fn a_left_to_right_ramp_never_sets_a_bit_and_its_mirror_always_does() {
        let hash = dhash_rgba(&ramp(64, 64), 64, 64).unwrap();
        assert_eq!(hash, format!("{:016x}", 0u64));

        let mut mirrored = ramp(64, 64);
        for row in mirrored.chunks_exact_mut(64 * 4) {
            let flipped: Vec<u8> = row.chunks_exact(4).rev().flatten().copied().collect();
            row.copy_from_slice(&flipped);
        }
        assert_eq!(
            dhash_rgba(&mirrored, 64, 64).unwrap(),
            format!("{:016x}", u64::MAX)
        );
    }

    #[test]
    fn the_same_pixels_always_produce_the_same_hash() {
        let pixels = ramp(200, 120);
        assert_eq!(
            dhash_rgba(&pixels, 200, 120).unwrap(),
            dhash_rgba(&pixels, 200, 120).unwrap()
        );
    }

    #[test]
    fn a_hash_is_always_sixteen_hex_characters() {
        for (w, h) in [(1, 1), (3, 2), (9, 8), (1920, 1080)] {
            let hash = dhash_rgba(&solid(w, h, 200), w, h).unwrap();
            assert_eq!(hash.len(), 16, "{w}x{h}");
            assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn an_image_smaller_than_the_hash_grid_still_hashes() {
        // Every cell must borrow a source pixel rather than divide by zero.
        assert!(dhash_rgba(&ramp(2, 2), 2, 2).is_some());
    }

    #[test]
    fn a_short_or_empty_buffer_is_refused_rather_than_read_past() {
        assert!(dhash_rgba(&solid(8, 8, 0)[..100], 8, 8).is_none());
        assert!(dhash_rgba(&[], 0, 0).is_none());
    }

    #[test]
    fn hamming_counts_differing_bits_and_rejects_mismatched_hashes() {
        assert_eq!(hamming("0000000000000000", "0000000000000000"), Some(0));
        assert_eq!(hamming("0000000000000000", "0000000000000001"), Some(1));
        assert_eq!(hamming("0000000000000000", "ffffffffffffffff"), Some(64));
        assert_eq!(hamming("0000", "0000000000000000"), None);
    }
}
