import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cropFromPoints, cropForFrame } from '../ui/linux-crop-geometry.js'

test('Linux image crop accepts reverse drags and rounds outwards to full-frame pixels', () => {
  assert.deepEqual(cropFromPoints({ x: 300.2, y: 140.8 }, { x: 100.5, y: 50.1 }, { width: 3440, height: 1440 }),
    { x: 100, y: 50, width: 201, height: 91, reference_width: 3440, reference_height: 1440 })
})

test('Linux image crop clamps pointer capture outside the image to its edges', () => {
  assert.deepEqual(cropFromPoints({ x: -80, y: -20 }, { x: 4000, y: 2000 }, { width: 3440, height: 1440 }),
    { x: 0, y: 0, width: 3440, height: 1440, reference_width: 3440, reference_height: 1440 })
})

test('Linux saved crop rescales axes independently when the shared frame changes', () => {
  assert.deepEqual(cropForFrame({ x: 10, y: 20, width: 80, height: 30, reference_width: 100, reference_height: 100 }, { width: 200, height: 300 }),
    { x: 20, y: 60, width: 160, height: 90, reference_width: 200, reference_height: 300 })
})

test('Linux image crop rejects empty and nonfinite selections or invalid saved references', () => {
  const frame = { width: 800, height: 600 }
  assert.equal(cropFromPoints({ x: 10, y: 20 }, { x: 10, y: 80 }, frame), null)
  assert.equal(cropFromPoints({ x: NaN, y: 20 }, { x: 40, y: 80 }, frame), null)
  assert.equal(cropForFrame({ x: 0, y: 0, width: 10, height: 10, reference_width: 0, reference_height: 100 }, frame), null)
})
