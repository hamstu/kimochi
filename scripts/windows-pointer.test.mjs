import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installWindowsPointer } from '../host/windows-pointer.js'

class Event {
  constructor(type, init) { this.type = type; Object.assign(this, init) }
}
function fixture() {
  const received = []
  const target = { tagName: 'BUTTON', dispatchEvent: e => received.push(e), contains: () => false }
  let hit = target
  let listener
  const doc = { elementFromPoint: () => hit, defaultView: { PointerEvent: Event, MouseEvent: Event } }
  const win = { document: doc, __TAURI__: { event: { listen: async (_, callback) => { listener = callback } } } }
  return { win, doc, target, received, point: value => { hit = value }, send: payload => listener({ payload }) }
}

test('consumed clicks deliver a complete gesture to the DOM button', async () => {
  const f = fixture()
  await installWindowsPointer(f.win)
  f.send({ x: 12, y: 18, button: 0, down: true })
  f.send({ x: 12, y: 18, button: 0, down: false })
  assert.deepEqual(f.received.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
  assert.deepEqual(f.received.map(e => e.buttons), [1, 1, 0, 0, 0])
})

test('release outside the page ends the gesture without activating the button', async () => {
  const f = fixture()
  await installWindowsPointer(f.win)
  f.send({ x: 12, y: 18, button: 0, down: true })
  f.point(null)
  f.send({ x: -10, y: -10, button: 0, down: false })
  assert.deepEqual(f.received.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup'])
})

test('dictionary button in a closed-shadow popup receives local frame coordinates', async () => {
  const f = fixture()
  const host = { tagName: 'DIV', dispatchEvent: () => assert.fail('must not click shadow host') }
  f.point(host)
  const frame = { tagName: 'IFRAME', clientLeft: 2, clientTop: 3,
    contentDocument: f.doc, getBoundingClientRect: () => ({ left: 100, top: 200, right: 200, bottom: 300 }) }
  const rootDoc = { elementFromPoint: () => host }
  f.win.document = rootDoc
  let sampled
  f.doc.elementFromPoint = (x, y) => { sampled = [x, y]; return f.target }
  await installWindowsPointer(f.win, () => [{ isVisibleSync: () => true, _frame: frame, child: null }])
  f.send({ x: 120, y: 230, button: 0, down: true })
  f.send({ x: 120, y: 230, button: 0, down: false })
  assert.deepEqual(sampled, [18, 27])
  assert.equal(f.received.at(-1).type, 'click')
  assert.deepEqual([f.received.at(-1).clientX, f.received.at(-1).clientY], [18, 27])
})
