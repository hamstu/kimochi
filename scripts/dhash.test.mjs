import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { hashFromRgba, hammingDistance, levenshteinDistance, textSimilarity, HASH_WIDTH, HASH_HEIGHT } =
  await load('dhash.ts')

/** A 9x8 RGBA buffer whose grey level is produced by `value(x, y)`. */
const frame = (value) => {
  const pixels = new Uint8ClampedArray(HASH_WIDTH * HASH_HEIGHT * 4)
  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH; x++) {
      const i = (y * HASH_WIDTH + x) * 4
      const v = value(x, y)
      pixels[i] = pixels[i + 1] = pixels[i + 2] = v
      pixels[i + 3] = 255
    }
  }
  return pixels
}

test('a left-to-right ramp has no bits set and its mirror has all of them', () => {
  // Every pixel darker than its right neighbour -> 0; brighter -> 1.
  assert.equal(hashFromRgba(frame((x) => x * 20)), '0'.repeat(16))
  assert.equal(hashFromRgba(frame((x) => 255 - x * 20)), 'f'.repeat(16))
})

test('the hash is 64 bits and ignores uniform brightness', () => {
  const hash = hashFromRgba(frame((x, y) => (x + y) * 10))
  assert.equal(hash.length, 16)
  // A flat image has no left-to-right difference at all, so no bits are set.
  assert.equal(hashFromRgba(frame(() => 128)), '0'.repeat(16))
})

test('a short buffer is rejected rather than silently hashing garbage', () => {
  assert.throws(() => hashFromRgba(new Uint8ClampedArray(16)), /RGBA bytes/)
})

test('hamming distance counts differing bits and rejects incompatible hashes', () => {
  assert.equal(hammingDistance('0'.repeat(16), '0'.repeat(16)), 0)
  assert.equal(hammingDistance('0'.repeat(16), 'f'.repeat(16)), 64)
  assert.equal(hammingDistance('0000000000000001', '0000000000000000'), 1)
  assert.equal(hammingDistance('0000000000000007', '0000000000000000'), 3)
  // A mismatch must read as "changed", never as "unchanged".
  assert.equal(hammingDistance('00', '0000'), Infinity)
})

test('edit distance and similarity behave at the edges', () => {
  assert.equal(levenshteinDistance('', ''), 0)
  assert.equal(levenshteinDistance('', 'abc'), 3)
  assert.equal(levenshteinDistance('猫が好き', '犬が好き'), 1)

  assert.equal(textSimilarity('同じ', '同じ'), 1)
  assert.equal(textSimilarity('', ''), 1)
  assert.equal(textSimilarity('', '猫'), 0)
  assert.equal(textSimilarity('猫が好き', '犬が好き'), 0.75)
})
