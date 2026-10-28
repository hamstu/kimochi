import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { createPointerFilter, installPointerFilter, DUPLICATE_MS, GHOST_MS, CLICK_MS } = await load('pointer-dedupe.ts')

const pointer = (type, t, extra = {}) => ({ type, timeStamp: t, pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 50, ...extra })
const mouse = (type, t, extra = {}) =>
  type.startsWith('pointer')
    ? pointer(type, t, { pointerType: 'mouse', pointerId: 1, ...extra })
    : { type, timeStamp: t, clientX: 100, clientY: 50, ...extra }
const touch = (type, t, extra = {}) => ({ type, timeStamp: t, changedTouches: [{ identifier: 0, clientX: 100, clientY: 50, ...extra }] })
const verdicts = (filter, events) => events.map((event) => filter.classify(event))

test("GTK's doubled touch begin reaches the page once", () => {
  const filter = createPointerFilter()
  assert.deepEqual(
    verdicts(filter, [touch('touchstart', 10), touch('touchstart', 10), pointer('pointerdown', 10), pointer('pointerdown', 10)]),
    ['pass', 'duplicate', 'pass', 'duplicate']
  )
  // Within a few ms and a pixel still counts; the next tap does not.
  assert.equal(filter.classify(pointer('pointerdown', 10 + DUPLICATE_MS, { clientX: 100.6 })), 'duplicate')
  assert.equal(filter.classify(pointer('pointerup', 120)), 'pass')
  assert.equal(filter.classify(pointer('pointerdown', 300)), 'pass')
})

test('two fingers at once are not duplicates of each other', () => {
  const filter = createPointerFilter()
  assert.equal(filter.classify(pointer('pointerdown', 10)), 'pass')
  assert.equal(filter.classify(pointer('pointerdown', 10, { pointerId: 3 })), 'pass')
  assert.equal(filter.classify(touch('touchstart', 10)), 'pass')
  assert.equal(filter.classify(touch('touchstart', 10, { identifier: 1 })), 'pass')
})

test("a tap's emulated mouse is dropped, and its click comes once", () => {
  const filter = createPointerFilter()
  const tap = [
    touch('touchstart', 0),
    pointer('pointerdown', 0),
    touch('touchend', 90),
    pointer('pointerup', 90),
    mouse('pointerdown', 95, { clientX: 101 }),
    mouse('mousedown', 95, { clientX: 101 }),
    mouse('pointerup', 96, { clientX: 101 }),
    mouse('mouseup', 96, { clientX: 101 }),
    mouse('click', 97),
    mouse('click', 140)
  ]
  assert.deepEqual(verdicts(filter, tap), ['pass', 'pass', 'pass', 'pass', 'ghost', 'ghost', 'ghost', 'ghost', 'pass', 'duplicate'])
})

test('the mouse after a touch elsewhere, or later, is the mouse', () => {
  const filter = createPointerFilter()
  filter.classify(pointer('pointerdown', 0))
  filter.classify(pointer('pointerup', 50))
  assert.equal(filter.classify(mouse('pointerdown', 100, { clientX: 400 })), 'pass')
  assert.equal(filter.classify(mouse('pointerdown', 50 + GHOST_MS + 1)), 'pass')
})

test('a touch seen only as touch events leaves the mouse events, the only press there is, alone', () => {
  const filter = createPointerFilter()
  filter.classify(touch('touchstart', 0))
  filter.classify(touch('touchend', 80))
  assert.deepEqual(verdicts(filter, [mouse('pointerdown', 85), mouse('mousedown', 85), mouse('click', 86)]), ['pass', 'pass', 'pass'])
})

test('a mouse double-click, and clicks without a touch, pass', () => {
  const filter = createPointerFilter()
  assert.deepEqual(
    verdicts(filter, [mouse('pointerdown', 0), mouse('click', 60), mouse('pointerdown', 150), mouse('click', 200)]),
    ['pass', 'pass', 'pass', 'pass']
  )
  // A second click soon after a touch is a duplicate; one after CLICK_MS is a second tap.
  filter.classify(touch('touchstart', 1000))
  filter.classify(mouse('click', 1050))
  assert.equal(filter.classify(mouse('click', 1050 + CLICK_MS + 1)), 'pass')
})

test('inactive (not Linux) it lets everything through until a touch is seen', () => {
  const filter = createPointerFilter({ active: false })
  assert.deepEqual(verdicts(filter, [mouse('pointerdown', 0), mouse('pointerdown', 0)]), ['pass', 'pass'])
  assert.deepEqual(verdicts(filter, [touch('touchstart', 10), touch('touchstart', 10)]), ['pass', 'duplicate'])
})

function target() {
  const listeners = new Map()
  return {
    listeners,
    addEventListener: (type, listener, options) => listeners.set(type, { listener, options }),
    removeEventListener: (type) => listeners.delete(type),
    dispatch(fields, extra = {}) {
      let stopped = false
      let prevented = false
      const event = {
        isTrusted: true,
        target: null,
        ...fields,
        ...extra,
        stopImmediatePropagation: () => (stopped = true),
        preventDefault: () => (prevented = true)
      }
      listeners.get(event.type).listener(event)
      return { stopped, prevented }
    }
  }
}

test('installed, it stops dropped events in the capture phase and reports when asked', () => {
  const window = target()
  const reports = []
  const uninstall = installPointerFilter(window, { active: true, debug: true, report: (value) => reports.push(value) })
  assert.equal(window.listeners.get('pointerdown').options.capture, true)
  assert.equal(window.listeners.get('touchstart').options.passive, true)
  assert.equal(window.listeners.get('mousedown').options.passive, false)
  assert.deepEqual(window.dispatch(pointer('pointerdown', 0)), { stopped: false, prevented: false })
  assert.deepEqual(window.dispatch(pointer('pointerdown', 0)), { stopped: true, prevented: false })
  window.dispatch(pointer('pointerup', 80))
  // The emulated mousedown keeps focus where it is, unless it lands on a text field.
  assert.deepEqual(window.dispatch(mouse('mousedown', 85)), { stopped: true, prevented: true })
  const field = { closest: (selector) => (selector.includes('input') ? {} : null) }
  assert.deepEqual(window.dispatch(mouse('mousedown', 86, { clientX: 120 }), { target: field }), { stopped: true, prevented: false })
  // The app's own synthetic events are never touched.
  assert.deepEqual(window.dispatch(mouse('pointerdown', 87), { isTrusted: false }), { stopped: false, prevented: false })
  assert.deepEqual(
    reports.map(({ type, verdict }) => `${type}:${verdict}`),
    ['pointerdown:pass', 'pointerdown:duplicate', 'pointerup:pass', 'mousedown:ghost', 'mousedown:ghost']
  )
  assert.equal(reports[0].check, 'pointer-debug')
  assert.equal(reports[0].pointerType, 'touch')
  uninstall()
  assert.equal(window.listeners.size, 0)
})
