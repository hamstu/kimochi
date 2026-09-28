import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { mapAnnotations, mapRect, scaleOf, sourceDisplay } = await load('geometry.ts')

/**
 * A window captured at 640 x 400 points on a Retina display: 1280 x 800 pixels,
 * cropped to the lower two thirds. The crop, the annotation and the full
 * dimensions are all in capture pixels and never change when the window moves.
 */
const frame = (bounds) => ({
  full_width: 1280,
  full_height: 800,
  crop_pixels: [0, 160, 1280, 640],
  source_bounds: bounds
})

const word = {
  description: '猫',
  boundingPoly: {
    vertices: [
      { x: 100, y: 40 },
      { x: 140, y: 40 },
      { x: 140, y: 80 },
      { x: 100, y: 80 }
    ]
  }
}

const RETINA = { x: 0, y: 0, width: 1728, height: 1117 }

test('text follows a window moved within the same display', () => {
  const start = { x: 200, y: 100, width: 640, height: 400 }
  const moved = { x: 500, y: 260, width: 640, height: 400 }

  const before = mapAnnotations(frame(start), [word], RETINA)[0]
  // The frame still describes the capture taken at `start`; only the live bounds
  // have moved. This is the regression: passing the frame alone leaves the box
  // stranded where the window used to be.
  const after = mapAnnotations(frame(start), [word], RETINA, moved)[0]

  assert.equal(after.x - before.x, moved.x - start.x)
  assert.equal(after.y - before.y, moved.y - start.y)
  assert.equal(after.width, before.width, 'a move does not resize the text')
  assert.equal(after.height, before.height)
})

test('without live bounds the box stays where the window used to be', () => {
  const start = { x: 200, y: 100, width: 640, height: 400 }
  const stale = mapAnnotations(frame(start), [word], RETINA)[0]
  const moved = mapAnnotations(frame(start), [word], RETINA, {
    ...start,
    x: start.x + 300
  })[0]
  assert.notEqual(stale.x, moved.x)
})

test('capture pixels and desktop points stay independent across a move', () => {
  const start = { x: 200, y: 100, width: 640, height: 400 }
  const moved = { x: -900, y: 40, width: 640, height: 400 }
  const info = frame(start)

  // Same size, so the pixels-to-points ratio is untouched by the move.
  assert.deepEqual(scaleOf(info, moved), scaleOf(info, start))
  assert.deepEqual(scaleOf(info, moved), { sx: 0.5, sy: 0.5 })

  // The crop offset is still measured in capture pixels and still scales by it.
  const box = mapRect(info, { x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 2, height: 2 }, moved)
  assert.equal(box.x, moved.x + 0)
  assert.equal(box.y, moved.y + 160 * 0.5)
})

test('a window resized after the scan rescales its text rather than clipping it', () => {
  const start = { x: 0, y: 0, width: 640, height: 400 }
  const halved = { x: 0, y: 0, width: 320, height: 200 }
  const info = frame(start)

  const before = mapAnnotations(info, [word], RETINA)[0]
  const after = mapAnnotations(info, [word], RETINA, halved)[0]

  assert.equal(after.width, before.width / 2)
  assert.equal(after.height, before.height / 2)
})

test('a window dragged to a second display maps against that display origin', () => {
  const displays = [
    { x: 0, y: 0, width: 1728, height: 1117 },
    // A display to the left, with a negative origin, as macOS reports them.
    { x: -1920, y: -200, width: 1920, height: 1080 }
  ]
  const onSecond = { x: -1500, y: 0, width: 640, height: 400 }

  const origin = sourceDisplay(onSecond, displays)
  assert.deepEqual(origin, displays[1])

  const box = mapAnnotations(frame(onSecond), [word], origin)[0]
  // Overlay-local coordinates: the box sits inside the display that holds it.
  assert.ok(box.x >= 0 && box.x <= origin.width, `x ${box.x} within display`)
  assert.ok(box.y >= 0 && box.y <= origin.height, `y ${box.y} within display`)
  assert.equal(box.x, onSecond.x - origin.x + 100 * 0.5)
})

test('the same window on displays of different backing scale maps to the same points', () => {
  const bounds = { x: 0, y: 0, width: 640, height: 400 }
  const retinaCapture = frame(bounds)
  // The same window captured on a 1x display: half the pixels, same points.
  const standardCapture = {
    full_width: 640,
    full_height: 400,
    crop_pixels: [0, 80, 640, 320],
    source_bounds: bounds
  }
  const halfScaleWord = {
    description: '猫',
    boundingPoly: {
      vertices: [
        { x: 50, y: 20 },
        { x: 70, y: 20 },
        { x: 70, y: 40 },
        { x: 50, y: 40 }
      ]
    }
  }

  assert.deepEqual(
    mapAnnotations(retinaCapture, [word], RETINA),
    mapAnnotations(standardCapture, [halfScaleWord], RETINA)
  )
})
