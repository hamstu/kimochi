/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node regression harness. */
/**
 * "Hide popup on cursor exit" with Yomitan (#95). Yomitan hears that the pointer left a popup
 * from a `mouseout` on the popup's frame element, which the windows holding popups never got,
 * since they never get the mouse's own moves. `trackPopupHover` fires `mouseover`/`mouseout` as
 * replayed samples cross a frame's edge, as a browser would.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

class FakeFrame {
  constructor(rect) {
    this.rect = rect
    this.isConnected = true
    this.events = []
  }

  getBoundingClientRect() {
    const { x, y, width, height } = this.rect
    return { left: x, top: y, right: x + width, bottom: y + height }
  }

  dispatchEvent(event) {
    this.events.push(event.type)
  }
}

globalThis.HTMLIFrameElement = FakeFrame
globalThis.MouseEvent ??= class MouseEvent {
  constructor(type, init) {
    this.type = type
    Object.assign(this, init)
  }
}

const { trackPopupHover } = await import('../host/popup-bridge.js')

const popup = (rect, depth = 0, visible = true) => ({ depth, _frame: new FakeFrame(rect), isVisibleSync: () => visible })

test('entering, moving within and leaving a popup fire one mouseover and one mouseout', () => {
  const outer = popup({ x: 100, y: 100, width: 300, height: 200 })
  const popups = [outer]
  let hovered = trackPopupHover(null, popups, 10, 10)
  assert.equal(hovered, null)
  hovered = trackPopupHover(hovered, popups, 150, 150)
  hovered = trackPopupHover(hovered, popups, 160, 170)
  assert.deepEqual(outer._frame.events, ['mouseover'])
  hovered = trackPopupHover(hovered, popups, 500, 500)
  assert.equal(hovered, null)
  assert.deepEqual(outer._frame.events, ['mouseover', 'mouseout'])
})

test('the pointer leaving the window (no point) counts as leaving the popup', () => {
  const outer = popup({ x: 0, y: 0, width: 50, height: 50 })
  let hovered = trackPopupHover(null, [outer], 10, 10)
  hovered = trackPopupHover(hovered, [outer], null, null)
  assert.equal(hovered, null)
  assert.deepEqual(outer._frame.events, ['mouseover', 'mouseout'])
})

test('a nested popup over its parent takes the pointer: out of the parent, into the child', () => {
  const outer = popup({ x: 0, y: 0, width: 400, height: 400 })
  const inner = popup({ x: 200, y: 200, width: 100, height: 100 }, 1)
  const popups = [outer, inner]
  let hovered = trackPopupHover(null, popups, 50, 50)
  hovered = trackPopupHover(hovered, popups, 250, 250)
  assert.equal(hovered, inner._frame)
  assert.deepEqual(outer._frame.events, ['mouseover', 'mouseout'])
  assert.deepEqual(inner._frame.events, ['mouseover'])
})

test('a hidden popup is not hovered, and a removed frame is not told it was left', () => {
  const hidden = popup({ x: 0, y: 0, width: 100, height: 100 }, 0, false)
  assert.equal(trackPopupHover(null, [hidden], 10, 10), null)
  assert.deepEqual(hidden._frame.events, [])
  const gone = popup({ x: 0, y: 0, width: 100, height: 100 })
  const hovered = trackPopupHover(null, [gone], 10, 10)
  gone._frame.isConnected = false
  trackPopupHover(hovered, [], 10, 10)
  assert.deepEqual(gone._frame.events, ['mouseover'])
})
