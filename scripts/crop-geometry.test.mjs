/**
 * Region editor boxes to saved crops at fractional display scales (K-054): at 125% a windowed game
 * 802 × 633 pixels wide is 641.6 × 506.4 points, its corner a fractional point, and the editor's
 * whole-point box (-0.4, 642 wide from that corner) used to become an 803-pixel crop of an
 * 802-pixel capture, which native rejects ("Crop must be nonempty and inside its reference image").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cropFor } from '../ui/crop-geometry.js'
import { areaOffset } from '../ui/region-select.js'

/** capture-core's `crop_rect` validation (capture-core/src/lib.rs), the rule a saved crop must pass. */
function nativeAccepts(crop) {
  const whole = (n) => Number.isInteger(n) && n >= 0
  return (
    crop !== null &&
    ['x', 'y', 'width', 'height', 'reference_width', 'reference_height'].every((k) => whole(crop[k])) &&
    crop.width > 0 &&
    crop.height > 0 &&
    crop.reference_width > 0 &&
    crop.reference_height > 0 &&
    crop.x + crop.width <= crop.reference_width &&
    crop.y + crop.height <= crop.reference_height
  )
}

/** The reporter's window: 1536 × 864 display at 125%, game at (430.4, 72) points, 802 × 633 pixels. */
const display = { x: 0, y: 0, width: 1536, height: 864 }
const clannad = { x: 430.4, y: 72, width: 641.6, height: 506.4 }
const frame = { width: 802, height: 633 }
const scale = frame.width / clannad.width

/** What the editor hands back: a whole-point box, from the window's corner as the HUD shows it. */
const box = (dx, dy, width, height) => ({ x: Math.round(clannad.x + dx), y: clannad.y + dy, width, height })

test('the 125% whole window the editor offered (HUD "642 × 506  -0.4, 0") saves as the whole capture', () => {
  const rect = box(-0.4, 0, 642, 506)
  assert.equal(rect.x, 430)
  const crop = cropFor(rect, display, clannad, scale, frame)
  assert.deepEqual(crop, { x: 0, y: 0, width: 802, height: 633, reference_width: 802, reference_height: 633 })
  assert.ok(nativeAccepts(crop))
})

test('the 125% client area under the title bar (HUD "642 × 478  -0.4, 29") saves inside the capture', () => {
  const crop = cropFor(box(-0.4, 29, 642, 478), display, clannad, scale, frame)
  assert.deepEqual(crop, { x: 0, y: 36, width: 802, height: 597, reference_width: 802, reference_height: 633 })
  assert.ok(nativeAccepts(crop))
})

test('the old origin-and-size conversion of the same box is the crop native rejected', () => {
  const rect = box(-0.4, 29, 642, 478)
  const old = {
    x: Math.max(0, Math.round((rect.x - clannad.x) * scale)),
    y: Math.max(0, Math.round((rect.y - clannad.y) * scale)),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
    reference_width: frame.width,
    reference_height: frame.height
  }
  assert.deepEqual([old.x, old.width, old.y, old.height], [0, 803, 36, 598])
  assert.ok(!nativeAccepts(old))
})

test('before the first picture arrives, the reference is the bounds at the display scale', () => {
  const crop = cropFor(box(-0.4, 0, 642, 506), display, clannad, 1.25)
  assert.deepEqual(crop, { x: 0, y: 0, width: 802, height: 633, reference_width: 802, reference_height: 633 })
})

test('a box inside the window keeps its pixels at 125%', () => {
  const crop = cropFor(box(99.6, 400, 200, 80), display, clannad, scale, frame)
  assert.deepEqual(crop, { x: 125, y: 500, width: 250, height: 100, reference_width: 802, reference_height: 633 })
  assert.ok(nativeAccepts(crop))
})

test('at 100% whole-point windows map one to one', () => {
  const bounds = { x: 100, y: 50, width: 800, height: 600 }
  const crop = cropFor({ x: 110, y: 70, width: 300, height: 200 }, display, bounds, 1, { width: 800, height: 600 })
  assert.deepEqual(crop, { x: 10, y: 20, width: 300, height: 200, reference_width: 800, reference_height: 600 })
  assert.deepEqual(cropFor({ ...bounds }, display, bounds, 1), {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    reference_width: 800,
    reference_height: 600
  })
})

test('every whole-window box stays inside the capture at 125%, 150% and 175%', () => {
  for (const s of [1.25, 1.5, 1.75]) {
    for (let pixels = 600; pixels < 640; pixels++) {
      for (const corner of [0, 101, 333, 517]) {
        const bounds = { x: corner / s, y: corner / s, width: pixels / s, height: (pixels - 7) / s }
        const reference = { width: pixels, height: pixels - 7 }
        // The editor snaps both edges of a whole-window box to whole points, either way.
        for (const snap of [Math.floor, Math.round, Math.ceil]) {
          const x = snap(bounds.x)
          const y = snap(bounds.y)
          const rect = {
            x,
            y,
            width: snap(bounds.x + bounds.width) - x,
            height: snap(bounds.y + bounds.height) - y
          }
          const crop = cropFor(rect, display, bounds, s, reference)
          assert.ok(nativeAccepts(crop), `${s} ${pixels} ${corner} ${snap.name}: ${JSON.stringify(crop)}`)
          assert.ok(crop.width >= pixels - 2 * s, `${s} ${pixels} ${corner}: lost too much (${crop.width})`)
        }
      }
    }
  }
})

test('a box with nothing inside the capture is still no crop', () => {
  assert.equal(cropFor(box(0, 0, 0, 100), display, clannad, scale, frame), null)
  assert.equal(cropFor(box(0, 0, 100, 0), display, clannad, scale, frame), null)
  // Wholly beside the window: clamped to its edge, nothing is left.
  assert.equal(cropFor({ x: 1200, y: 100, width: 100, height: 100 }, display, clannad, scale, frame), null)
  assert.equal(cropFor({ x: 10, y: 600, width: 100, height: 100 }, display, clannad, scale, frame), null)
  assert.equal(cropFor({ x: Number.NaN, y: 100, width: 100, height: 100 }, display, clannad, scale, frame), null)
})

test('the HUD counts a box on a fractional window corner from 0, not -0.399999999997726', () => {
  assert.equal(String(areaOffset(430, 430.4)), '0')
  assert.equal(areaOffset(459, 430.4), 29)
  assert.equal(areaOffset(530.4, 430.4), 100)
})
