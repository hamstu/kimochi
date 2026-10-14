// The sidebar's live preview keeps its shape unless the source's shape really changes:
// frame-to-frame pixel differences must not resize it (each resize flashed the overlay
// scrollbars of Windows and Linux).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { keepShape, SHAPE_TOLERANCE } = await load('preview-shape.ts')

test('the first frame sets the shape', () => {
  assert.deepEqual(keepShape(null, { width: 1280, height: 720, url: 'x' }), { width: 1280, height: 720 })
})

test('a few pixels of difference keep the shape the preview already has', () => {
  const shape = { width: 1280, height: 720 }
  assert.equal(keepShape(shape, { width: 1280, height: 723 }), shape)
  assert.equal(keepShape(shape, { width: 1276, height: 720 }), shape)
})

test('a really different shape (another source, a resized window) is followed', () => {
  const shape = { width: 1280, height: 720 }
  assert.deepEqual(keepShape(shape, { width: 1024, height: 768 }), { width: 1024, height: 768 })
  const edge = 1280 / 720 * (1 + SHAPE_TOLERANCE * 2)
  assert.notEqual(keepShape(shape, { width: Math.round(720 * edge), height: 720 }), shape)
})

test('an empty frame size changes nothing', () => {
  const shape = { width: 1280, height: 720 }
  assert.equal(keepShape(shape, { width: 0, height: 0 }), shape)
})
