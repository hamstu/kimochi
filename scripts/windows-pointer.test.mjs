import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installWindowsPointer } from '../host/windows-pointer.js'

class Event {
  constructor(type, init) { this.type = type; Object.assign(this, init) }
}
function fixture(label = 'overlay', bus = []) {
  const received = []
  const target = { tagName: 'BUTTON', dispatchEvent: e => received.push(e), contains: () => false }
  let hit = target
  const doc = { elementFromPoint: () => hit, defaultView: { PointerEvent: Event, MouseEvent: Event } }
  const win = { document: doc, __TAURI__: {
    window: { getCurrentWindow: () => ({ label }) },
    event: { listen: async (_, callback, options) => { bus.push({ callback, target: options?.target ?? { kind: 'Any' } }) } }
  } }
  return { win, doc, target, received, point: value => { hit = value }, send: (payload, destination = label) => {
    // Tauri delivers emit_to to Any subscriptions as well as matching targets.
    for (const listener of bus) if (listener.target.kind === 'Any' || listener.target.label === destination) listener.callback({ payload })
  } }
}

test('popup presses stay in their window instead of clearing the Log source selection', async () => {
  const bus = []
  const log = fixture('log', bus)
  const overlay = fixture('overlay', bus)
  const popup = fixture('popup-host', bus)
  for (const f of [log, overlay, popup]) await installWindowsPointer(f.win)
  popup.send({ x: 40, y: 57, button: 0, down: true })
  popup.send({ x: 40, y: 57, button: 0, down: false })
  assert.deepEqual(log.received, [], 'popup-local presses must never hit the Log scanner')
  assert.deepEqual(overlay.received, [], 'popup-local presses must never hit the overlay')
  assert.deepEqual(popup.received.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
  overlay.send({ x: 12, y: 18, button: 0, down: true })
  overlay.send({ x: 12, y: 18, button: 0, down: false })
  assert.deepEqual(log.received, [])
  assert.equal(popup.received.length, 5, 'the popup must not replay overlay presses either')
  assert.equal(overlay.received.at(-1).type, 'click')
})

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

test('every window the Windows mouse hook delivers to replays the presses it consumed', async () => {
  const { readFile } = await import('node:fs/promises')
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
  const guard = await read('src-tauri/src/platform/windows/mouseguard.rs')
  const labels = JSON.parse(guard.match(/for label in (\[[^\]]+\])/)[1])
  const pages = { overlay: 'ui/overlay.js', 'popup-host': 'ui/popup-host.js' }
  assert.deepEqual(labels.toSorted(), Object.keys(pages).toSorted())
  for (const label of labels) {
    assert.match(await read(pages[label]), /installWindowsPointer\(/, `${label} drops every click on Windows`)
  }
})
