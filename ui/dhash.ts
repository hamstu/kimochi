/**
 * Perceptual image hashing and text similarity, as pure functions.
 *
 * Ported from src/renderer/src/windows/background/background.ts. `hammingDistance`
 * is the live one: it compares the hashes that now arrive with each capture,
 * computed natively in `capture-core/src/hash.rs` from the same buffer the
 * observer reads.
 *
 * `hashFromRgba` is the browser-side equivalent, and nothing calls it any more.
 * Producing a hash here meant fetching the captured PNG back over the `capture:`
 * protocol, decoding it and drawing it into a canvas — the sequence a saved
 * diagnostic sample recorded `Load failed` from, which, because a failed gate fell
 * through to the expensive call, turned a broken hash into a remote OCR request
 * on every tick. The failing step was never identified. This is kept because it
 * is the readable definition of what the Rust implementation computes, and tested
 * alongside it; it is not a path to put back into the scan loop.
 */

/** dHash needs one extra column to produce 8 horizontal comparisons per row. */
export const HASH_WIDTH = 9
export const HASH_HEIGHT = 8

/**
 * 64-bit difference hash of a 9x8 RGBA buffer, as 16 hex characters.
 *
 * Each bit is 1 when a pixel is brighter than its right-hand neighbour, walking
 * row-major, using the Rec. 601 luminance weights. Structure survives, absolute
 * brightness does not — which is what makes it a good first gate for "did the
 * text on screen actually change".
 */
export function hashFromRgba(pixels: ArrayLike<number>): string {
  const expected = HASH_WIDTH * HASH_HEIGHT * 4
  if (pixels.length < expected) {
    throw new Error(`Expected ${expected} RGBA bytes for a ${HASH_WIDTH}x${HASH_HEIGHT} hash`)
  }
  const gray = (index: number): number =>
    pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114

  let bits = ''
  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH - 1; x++) {
      const left = (y * HASH_WIDTH + x) * 4
      const right = (y * HASH_WIDTH + x + 1) * 4
      bits += gray(left) > gray(right) ? '1' : '0'
    }
  }

  let hex = ''
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

/**
 * Differing bits between two hex hashes. Returns Infinity for incompatible
 * hashes so a mismatch always reads as "changed" rather than "unchanged".
 */
export function hammingDistance(hash1: string, hash2: string): number {
  if (hash1.length !== hash2.length) return Infinity
  let distance = 0
  for (let i = 0; i < hash1.length; i++) {
    let xor = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16)
    while (xor) {
      distance++
      xor &= xor - 1
    }
  }
  return distance
}

/** Classic two-row Levenshtein; the full matrix is unnecessary for a distance. */
export function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length
  const n = str2.length
  if (m === 0) return n
  if (n === 0) return m

  let previous = Array.from({ length: n + 1 }, (_, j) => j)
  let current = new Array<number>(n + 1)
  for (let i = 1; i <= m; i++) {
    current[0] = i
    for (let j = 1; j <= n; j++) {
      current[j] =
        str1[i - 1] === str2[j - 1]
          ? previous[j - 1]
          : 1 + Math.min(previous[j], current[j - 1], previous[j - 1])
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[n]
}

/** 1 = identical, 0 = nothing in common. */
export function textSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1
  if (str1.length === 0 && str2.length === 0) return 1
  if (str1.length === 0 || str2.length === 0) return 0
  return 1 - levenshteinDistance(str1, str2) / Math.max(str1.length, str2.length)
}
