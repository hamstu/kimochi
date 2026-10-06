/* eslint @typescript-eslint/explicit-function-return-type: "off" */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installLinuxScanInput } from '../host/linux-scan-input.js'

function fixture(os = 'linux') {
  const listeners = new Map(), received = []
  let portal
  class PointerEvent { constructor(type, init) { this.type = type; Object.assign(this, init) } }
  const target = { dispatchEvent: e => received.push(e), closest: () => null }
  const win = { __KIMOCHI_PLATFORM__: { os }, PointerEvent,
    document: { activeElement: target, elementFromPoint: () => target, hasFocus: () => true },
    addEventListener: (type, fn) => listeners.set(type, fn),
    __TAURI__: { event: { listen: async (_, fn) => { portal = fn } } } }
  return { win, received, listeners, target,
    move: shiftKey => listeners.get('pointermove')({ target, pointerType: 'mouse', isPrimary: true,
      clientX: 17, clientY: 23, shiftKey, stopImmediatePropagation() {} }),
    send: shift => portal({ payload: { shift } }) }
}
test('portal Shift scans a stationary pointer on press, never on release', async () => {
  const f = fixture(); await installLinuxScanInput(f.win); f.move(false)
  f.send(true); f.send(true); f.send(false)
  assert.equal(f.received.length, 1)
  assert.deepEqual([f.received[0].clientX, f.received[0].clientY, f.received[0].shiftKey], [17,23,true])
  f.move(true)
  assert.equal(f.received.at(-1).shiftKey, false)
})
test('local keydown scans without requiring movement and respects text inputs', async () => {
  const f = fixture(); await installLinuxScanInput(f.win); f.move(false)
  f.listeners.get('keydown')({ key: 'Shift' }); assert.equal(f.received.length, 1)
  f.listeners.get('keyup')({ key: 'Shift', shiftKey: false })
  f.win.document.activeElement = { closest: () => ({}) }
  f.send(true); assert.equal(f.received.length, 1)
})
test('leaving the surface prevents stale-point lookups', async () => {
  const f = fixture(); await installLinuxScanInput(f.win); f.move(false)
  f.listeners.get('pointerout')({ relatedTarget: null }); f.send(true)
  assert.equal(f.received.length, 0)
})
test('Mac and Windows install no Linux listeners', async () => {
  for (const os of ['macos', 'windows']) {
    const f = fixture(os); await installLinuxScanInput(f.win); assert.equal(f.listeners.size, 0)
  }
})
test('unfocused reader ignores global presses; passive overlay still scans', async () => {
  const reader = fixture(); reader.win.document.hasFocus = () => false
  await installLinuxScanInput(reader.win); reader.move(false); reader.send(true)
  assert.equal(reader.received.length, 0)
  const overlay = fixture(); overlay.win.document.hasFocus = () => false
  await installLinuxScanInput(overlay.win, { passive: true }); overlay.move(false); overlay.send(true)
  assert.equal(overlay.received.length, 1)
})
