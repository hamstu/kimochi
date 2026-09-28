/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
/**
 * The dictionary popup has to be a rectangle the overlay defends.
 *
 * Everything here is about a popup the DOM cannot show you: Yomitan builds it in a
 * closed shadow root, so the only handle on it is the popup object, and if its
 * rectangle is missing the overlay both ignores its clicks and treats them as a
 * click away from the dictionary.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { popupHitRects } = await load('regions.ts')

/** A stand-in with the same shape as the original `Popup`. */
function popup({ rect, visible = true, valid = true, child = null }) {
  const [left, top, right, bottom] = rect
  return {
    isVisibleSync: () => visible,
    getFrameRect: () => ({ left, top, right, bottom, valid }),
    child
  }
}

const ORIGIN = { x: 1728, y: 0 }

test('a visible popup becomes one desktop rectangle marked as a lookup target', () => {
  const rects = popupHitRects([popup({ rect: [100, 200, 500, 450] })], ORIGIN)
  assert.deepEqual(rects, [{ x: 1828, y: 200, width: 400, height: 250, focus: true }])
})

test('the rectangle lands where the popup is, on a display with a negative origin', () => {
  const [rect] = popupHitRects([popup({ rect: [10, 20, 410, 270] })], { x: -1440, y: -300 })
  assert.equal(rect.x, -1430)
  assert.equal(rect.y, -280)
})

test('a hidden popup contributes nothing, so a closed lookup leaves no dead zone', () => {
  // Yomitan keeps the container in the DOM at its last position when it hides, which
  // is exactly why visibility has to be asked rather than inferred from the element.
  assert.deepEqual(popupHitRects([popup({ rect: [0, 0, 400, 250], visible: false })], ORIGIN), [])
})

test('a nested lookup adds its own rectangle', () => {
  const child = popup({ rect: [300, 400, 700, 650] })
  const rects = popupHitRects([popup({ rect: [100, 200, 500, 450], child })], ORIGIN)
  assert.equal(rects.length, 2)
  assert.deepEqual(rects[1], { x: 2028, y: 400, width: 400, height: 250, focus: true })
})

test('a child of a hidden parent is not on screen and is not defended', () => {
  const child = popup({ rect: [300, 400, 700, 650] })
  assert.deepEqual(
    popupHitRects([popup({ rect: [100, 200, 500, 450], visible: false, child })], ORIGIN),
    []
  )
})

test('a hidden child stops the walk without dropping its visible parent', () => {
  const child = popup({ rect: [300, 400, 700, 650], visible: false })
  const rects = popupHitRects([popup({ rect: [100, 200, 500, 450], child })], ORIGIN)
  assert.equal(rects.length, 1)
})

test('a popup whose frame is in another realm claims no rectangle here', () => {
  // PopupProxy and PopupWindow both answer valid:false by contract. Their pixels
  // belong to the window that owns the frame.
  assert.deepEqual(popupHitRects([popup({ rect: [0, 0, 400, 250], valid: false })], ORIGIN), [])
})

test('degenerate and non-finite rectangles are dropped rather than published', () => {
  const bad = [
    popup({ rect: [10, 10, 10, 260] }),
    popup({ rect: [10, 10, 410, 10] }),
    popup({ rect: [Number.NaN, 10, 410, 260] }),
    popup({ rect: [10, 10, Number.POSITIVE_INFINITY, 260] })
  ]
  assert.deepEqual(popupHitRects(bad, ORIGIN), [])
})

test('with no origin there is no desktop to map onto', () => {
  assert.deepEqual(popupHitRects([popup({ rect: [100, 200, 500, 450] })], null), [])
})

test('several independent popups each contribute', () => {
  const rects = popupHitRects(
    new Set([popup({ rect: [0, 0, 400, 250] }), popup({ rect: [500, 500, 900, 750] })]),
    ORIGIN
  )
  assert.equal(rects.length, 2)
  assert.ok(rects.every((r) => r.focus === true))
})
