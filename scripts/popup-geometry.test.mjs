/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
/**
 * Where the dictionary popup's own window goes.
 *
 * The popup is positioned by Yomitan's own `_getPosition`, which places a rectangle
 * inside whatever viewport it is handed. Hand it the work area of the display the
 * scanned text is on and it answers in desktop points, flip and clamp included. So
 * what has to be right here is which display that is, and how a chain of nested
 * popups fits in one window.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const geometry = await load('popup-geometry.ts')
const { anchorViewport, boundsOf, chainWindow, insetIn, asViewport } = geometry

const rect = (x, y, width, height) => ({ x, y, width, height })

/**
 * A source rectangle in the shape Yomitan actually sends.
 *
 * `Popup.showContent`'s `sourceRects` are edges, not an origin and a size. Reading
 * `x` off one yields `undefined`, which looks like "no anchor" rather than an error —
 * and "no anchor" meant the popup opened on the first display instead of the one the
 * text was on. Every anchor in this file is built this way on purpose: a test that
 * invents a shape the caller never sends cannot catch that.
 */
const source = (x, y, width, height) => ({
  left: x,
  top: y,
  right: x + width,
  bottom: y + height
})

// The real desktop this was written against: a laptop display at the origin and a
// wide monitor to its right. A display above or to the left has a negative origin,
// which is why nothing may assume positive coordinates.
const DISPLAYS = [
  { work_area: rect(0, 25, 1728, 1092) },
  { work_area: rect(1728, 0, 3440, 1440) }
]

test('the popup is positioned on the display the scanned text is on', () => {
  assert.deepEqual(anchorViewport([source(2000, 500, 40, 20)], DISPLAYS, rect(0, 0, 1, 1)), {
    left: 1728,
    top: 0,
    right: 5168,
    bottom: 1440
  })
})

test('text on the laptop display gets the laptop work area, not the bigger monitor', () => {
  const viewport = anchorViewport([source(300, 400, 40, 20)], DISPLAYS, rect(0, 0, 1, 1))
  assert.equal(viewport.left, 0)
  // The menu bar is not part of the work area, and a popup must not open under it.
  assert.equal(viewport.top, 25)
  assert.equal(viewport.bottom, 1117)
})

test('a display above or to the left is handled by its signed origin', () => {
  const above = [{ work_area: rect(-1440, -900, 1440, 900) }, ...DISPLAYS]
  const viewport = anchorViewport([source(-800, -400, 40, 20)], above, rect(0, 0, 1, 1))
  assert.deepEqual(viewport, { left: -1440, top: -900, right: 0, bottom: 0 })
})

test('a word straddling two displays opens on the one most of it is on', () => {
  // Centre falls on neither work area cleanly; overlap decides.
  const viewport = anchorViewport([source(1700, 500, 120, 20)], DISPLAYS, rect(0, 0, 1, 1))
  assert.equal(viewport.left, 1728, 'most of the word is on the right-hand monitor')
})

test('a multi-line match is bounded before a display is chosen', () => {
  // Yomitan sends one rectangle per line, so a wrapped word arrives as two.
  const box = boundsOf([source(2000, 500, 40, 20), source(1900, 520, 90, 20)])
  assert.deepEqual(box, rect(1900, 500, 140, 40))
})

test('a source rectangle given as an origin and a size is not an anchor', () => {
  // The shape mismatch that put the popup on the wrong monitor. These are rejected
  // rather than half-read, so the failure is a missing anchor and not a wrong one.
  assert.equal(boundsOf([{ x: 2000, y: 500, width: 40, height: 20 }]), null)
})

test('an anchor on the second display is not mistaken for no anchor', () => {
  // The regression itself: unusable anchors fall through to "no anchor", which picks
  // the first display, which clamps the popup to the wrong monitor's right edge.
  const viewport = anchorViewport([source(4271, 526, 220, 38)], DISPLAYS, rect(0, 0, 1, 1))
  assert.notDeepEqual(viewport, asViewport(DISPLAYS[0].work_area))
  assert.equal(viewport.left, 1728)
  assert.equal(viewport.right, 5168)
})

test('with no anchor at all the first display is used rather than nothing', () => {
  const viewport = anchorViewport([], DISPLAYS, rect(0, 0, 1, 1))
  assert.deepEqual(viewport, asViewport(DISPLAYS[0].work_area))
})

test('with no displays reported the caller fallback is used rather than an empty box', () => {
  assert.deepEqual(anchorViewport([source(10, 10, 5, 5)], [], rect(4, 5, 6, 7)), {
    left: 4,
    top: 5,
    right: 10,
    bottom: 12
  })
})

test('one popup gives a window exactly its own size', () => {
  assert.deepEqual(chainWindow([rect(100, 200, 400, 250)]), rect(100, 200, 400, 250))
})

test('a nested lookup makes the window the bounding box of the chain', () => {
  // One window cannot be in two places, so it becomes both.
  const window = chainWindow([rect(100, 200, 400, 250), rect(300, 380, 400, 250)])
  assert.deepEqual(window, rect(100, 200, 600, 430))
  assert.deepEqual(insetIn(window, rect(100, 200, 400, 250)), { left: 0, top: 0 })
  assert.deepEqual(insetIn(window, rect(300, 380, 400, 250)), { left: 200, top: 180 })
})

test('every popup keeps the desktop position Yomitan gave it', () => {
  const rects = [rect(-500, -100, 400, 250), rect(-300, 60, 400, 250)]
  const window = chainWindow(rects)
  for (const popup of rects) {
    const { left, top } = insetIn(window, popup)
    assert.equal(window.x + left, popup.x)
    assert.equal(window.y + top, popup.y)
  }
})

test('nothing visible means no window', () => {
  assert.equal(chainWindow([]), null)
  assert.equal(chainWindow([rect(10, 10, 0, 250)]), null)
})

test('a chain that fits on its screen is kept whole', () => {
  const { fitsIn, asEdges } = geometry
  const chain = chainWindow([rect(2000, 500, 400, 250), rect(2200, 700, 400, 250)])
  assert.ok(fitsIn(chain, asViewport(DISPLAYS[1].work_area)))
  assert.deepEqual(asEdges(chain), {
    left: 2000,
    top: 500,
    right: 2600,
    bottom: 950
  })
})

test('a chain spanning two monitors does not fit on either', () => {
  // One badly placed popup would otherwise make the window the size of the whole
  // desktop — and a transparent always-on-top window that big takes every click on
  // both monitors, which is far worse than a popup in the wrong place.
  const { fitsIn } = geometry
  const chain = chainWindow([rect(0, 0, 400, 250), rect(2600, 900, 400, 250)])
  assert.ok(!fitsIn(chain, asViewport(DISPLAYS[0].work_area)))
  assert.ok(!fitsIn(chain, asViewport(DISPLAYS[1].work_area)))
})

test('a zero-width rectangle at the end of the previous line is not an anchor', () => {
  const { withExtent } = geometry
  // What `Range.getClientRects()` returns for a range starting at a line boundary:
  // a caret-position rectangle at the end of the line above, then the real text.
  const rects = [
    { left: 1180, top: 900, right: 1180, bottom: 917 },
    { left: 400, top: 917, right: 512, bottom: 934 }
  ]
  assert.deepEqual(withExtent(rects), [rects[1]])
})

test('the popup then opens on the word rather than a line up and to the right', () => {
  const { withExtent } = geometry
  const rects = [
    { left: 1180, top: 900, right: 1180, bottom: 917 },
    { left: 400, top: 917, right: 512, bottom: 934 }
  ]
  assert.deepEqual(boundsOf(rects), rect(400, 900, 780, 34), 'unfiltered spans the line above')
  assert.deepEqual(boundsOf(withExtent(rects)), rect(400, 917, 112, 17))
})

test('a collapsed range keeps its rectangles rather than losing its anchor', () => {
  const { withExtent } = geometry
  // No anchor at all falls back to the first display, which is a worse failure than
  // an anchor that is merely imprecise.
  const collapsed = [{ left: 1180, top: 900, right: 1180, bottom: 917 }]
  assert.deepEqual(withExtent(collapsed), collapsed)
})

test('rectangles with extent are all kept, in order', () => {
  const { withExtent } = geometry
  const rects = [
    { left: 400, top: 900, right: 700, bottom: 917 },
    { left: 400, top: 917, right: 512, bottom: 934 }
  ]
  assert.deepEqual(withExtent(rects), rects)
})
