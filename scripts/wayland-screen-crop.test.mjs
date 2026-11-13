// The Linux layer overlay's shared-screen editor geometry (ui/wayland-screen-crop.js): a screen on
// a secondary output, a whole-workspace share across two, mixed sizes and negative layouts.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cropFromOutput,
  cropToOutput,
  outputArea,
  outputAt,
  screenOutputs,
  startOutput
} from '../ui/wayland-screen-crop.js'

const LEFT = { x: 0, y: 0, width: 1920, height: 1080 }
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1440 }
const OUTPUTS = [LEFT, RIGHT]
// KDE's "Full Workspace": both outputs, at 2x in the frame.
const WORKSPACE = { x: 0, y: 0, width: 4480, height: 1440 }
const WORKSPACE_FRAME = { width: 8960, height: 2880 }

test('a secondary monitor is edited on that monitor, not the primary', () => {
  const start = startOutput(RIGHT, OUTPUTS, { current: LEFT })
  assert.deepEqual(start, RIGHT)
  assert.deepEqual(outputArea(RIGHT, start), { x: 0, y: 0, width: 2560, height: 1440 })
  // A box drawn on it is that monitor's own pixels (frame at 1x here).
  const crop = cropFromOutput({ x: 100, y: 200, width: 300, height: 50 }, RIGHT, start, { width: 2560, height: 1440 })
  assert.deepEqual(crop, { x: 100, y: 200, width: 300, height: 50, reference_width: 2560, reference_height: 1440 })
})

test('a whole-workspace share opens on the output under the pointer', () => {
  assert.equal(screenOutputs(WORKSPACE, OUTPUTS).length, 2)
  assert.deepEqual(startOutput(WORKSPACE, OUTPUTS, { pointer: { x: 3000, y: 500 }, current: LEFT }), RIGHT)
  assert.deepEqual(startOutput(WORKSPACE, OUTPUTS, { pointer: { x: 10, y: 10 }, current: RIGHT }), LEFT)
})

test('a region drawn on the second output maps into the workspace frame and back', () => {
  const rect = { x: 100, y: 100, width: 400, height: 80 } // RIGHT's points
  const crop = cropFromOutput(rect, WORKSPACE, RIGHT, WORKSPACE_FRAME)
  assert.deepEqual(crop, { x: 4040, y: 200, width: 800, height: 160, reference_width: 8960, reference_height: 2880 })
  // Reopened: on RIGHT it is the same box; on LEFT there is nothing of it.
  assert.deepEqual(cropToOutput(crop, WORKSPACE, RIGHT), rect)
  assert.equal(cropToOutput(crop, WORKSPACE, LEFT), null)
  // With no pointer, the editor opens where the saved region is.
  assert.deepEqual(startOutput(WORKSPACE, OUTPUTS, { saved: crop, current: LEFT }), RIGHT)
})

test('each output limits the editor to its own part of the screen', () => {
  assert.deepEqual(outputArea(WORKSPACE, LEFT), { x: 0, y: 0, width: 1920, height: 1080 })
  assert.deepEqual(outputArea(WORKSPACE, RIGHT), { x: 0, y: 0, width: 2560, height: 1440 })
  // A screen that only partly covers an output (a portal stream of a scaled-down layout).
  const partial = { x: 1000, y: 0, width: 2000, height: 1080 }
  assert.deepEqual(outputArea(partial, LEFT), { x: 1000, y: 0, width: 920, height: 1080 })
  assert.deepEqual(outputArea(partial, RIGHT), { x: 0, y: 0, width: 1080, height: 1080 })
})

test('a region is clipped to what the output shows, and to the frame', () => {
  const crop = cropFromOutput({ x: -50, y: -50, width: 100, height: 100 }, RIGHT, RIGHT, { width: 2560, height: 1440 })
  assert.deepEqual(crop, { x: 0, y: 0, width: 50, height: 50, reference_width: 2560, reference_height: 1440 })
  assert.equal(
    cropFromOutput({ x: 3000, y: 0, width: 10, height: 10 }, RIGHT, RIGHT, { width: 2560, height: 1440 }),
    null
  )
})

test('negative layouts: a monitor left of and above the primary', () => {
  const leftOfPrimary = { x: -1920, y: 0, width: 1920, height: 1080 }
  const above = { x: 0, y: -1080, width: 1920, height: 1080 }
  const outputs = [LEFT, leftOfPrimary, above]
  assert.deepEqual(startOutput(leftOfPrimary, outputs, { current: LEFT }), leftOfPrimary)
  assert.deepEqual(startOutput(above, outputs, { current: LEFT }), above)
  const crop = cropFromOutput({ x: 10, y: 20, width: 30, height: 40 }, leftOfPrimary, leftOfPrimary, {
    width: 1920,
    height: 1080
  })
  assert.deepEqual([crop.x, crop.y, crop.width, crop.height], [10, 20, 30, 40])
})

test('the overlay stays put without a pointer or region, else takes the largest part', () => {
  assert.deepEqual(startOutput(WORKSPACE, OUTPUTS, { current: LEFT }), LEFT)
  assert.deepEqual(startOutput(WORKSPACE, OUTPUTS, {}), RIGHT)
})

test('a screen on no output (a virtual screen) has nowhere to be edited', () => {
  const virtual = { x: 4480, y: 0, width: 1920, height: 1080 }
  assert.equal(startOutput(virtual, OUTPUTS, { current: LEFT }), null)
  assert.equal(screenOutputs(virtual, OUTPUTS).length, 0)
  assert.equal(outputAt(screenOutputs(virtual, OUTPUTS), { x: 5000, y: 10 }), null)
})
