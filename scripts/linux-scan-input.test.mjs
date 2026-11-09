/* eslint @typescript-eslint/explicit-function-return-type: "off" */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installLinuxScanInput } from '../host/linux-scan-input.js'

function fixture(os = 'linux') {
  const listeners = new Map(), received = [], primes = []
  const native = new Map()
  class PointerEvent { constructor(type, init) { this.type = type; Object.assign(this, init) } }
  // A Shift scan is preceded by a plain move a pixel off (10ten's Safari workaround); kept apart.
  const target = { dispatchEvent: e => (e.kimochiPrime ? primes : received).push(e), closest: () => null }
  const win = { __KIMOCHI_PLATFORM__: { os }, PointerEvent,
    document: { activeElement: target, elementFromPoint: () => target, hasFocus: () => true },
    addEventListener: (type, fn) => listeners.set(type, fn),
    __TAURI__: { event: { listen: async (name, fn) => { native.set(name, fn) } } } }
  return { win, received, primes, listeners, target,
    move: shiftKey => {
      let blocked=false
      listeners.get('pointermove')({ target, pointerType: 'mouse', isPrimary: true,
        clientX: 17, clientY: 23, shiftKey, stopImmediatePropagation() { blocked=true } })
      return blocked
    },
    send: shift => native.get('linux-dictionary-modifier')({ payload: { shift } }),
    surface: over => native.get('wayland-layer-pointer')?.({ payload: over }) }
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
test('native layer exit prevents a later Shift press reopening a stale lookup', async () => {
  const f = fixture(); await installLinuxScanInput(f.win, { passive: true }); f.move(false)
  f.surface(false); f.send(true)
  assert.equal(f.received.length, 0)
  f.surface(true); f.send(false); f.send(true)
  assert.equal(f.received.length, 0, 'enter alone does not invent pointer coordinates')
  f.move(false)
  assert.equal(f.received.at(-1).shiftKey, true, 'fresh movement resumes glide scanning')
})
test('authoritative outside position rejects queued movement and Shift without a native leave', async () => {
  const f = fixture(); await installLinuxScanInput(f.win, { passive: true }); f.move(false)
  f.win.__linuxLayerPointerInside = false
  f.move(false); f.send(true)
  assert.equal(f.received.length, 0)
  f.win.__linuxLayerPointerInside = true
  f.send(false); f.send(true)
  assert.equal(f.received.length, 0)
  f.move(false)
  assert.equal(f.received.at(-1).shiftKey, true)
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
test('a Shift-up event with stale shiftKey=true must never start a lookup', async () => {
  const f = fixture(); await installLinuxScanInput(f.win); f.move(false)
  f.listeners.get('keyup')({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })
  assert.equal(f.received.length, 0)
})
test('passive overlay keeps the portal hold through focus transitions and gliding', async () => {
  const f = fixture(); await installLinuxScanInput(f.win, { passive: true }); f.move(false)
  f.send(true); f.listeners.get('blur')(); f.move(false); f.move(false)
  assert.deepEqual(f.received.map(e => e.shiftKey), [true, true, true])
  f.send(false); f.move(true)
  assert.equal(f.received.at(-1).shiftKey, false)
})
test('releasing one locally held Shift does not clear the other', async () => {
  const f = fixture(); await installLinuxScanInput(f.win); f.move(false)
  f.listeners.get('keydown')({ key:'Shift',code:'ShiftLeft' })
  f.listeners.get('keydown')({ key:'Shift',code:'ShiftRight' })
  f.listeners.get('keyup')({ key:'Shift',code:'ShiftLeft',shiftKey:true })
  f.move(false); assert.equal(f.received.at(-1).shiftKey,true)
  f.listeners.get('keyup')({ key:'Shift',code:'ShiftRight',shiftKey:true })
  f.move(true); assert.equal(f.received.at(-1).shiftKey,false)
})
test('dictionary frame uses the top host transport and focus without stealing focus', async () => {
  const f=fixture(); const child=fixture(); child.win.top=f.win
  delete child.win.__TAURI__; delete child.win.__KIMOCHI_PLATFORM__
  child.win.document.hasFocus=()=>false
  await installLinuxScanInput(child.win); child.move(false); f.send(true)
  assert.equal(child.received.length,1)
})

test('a dictionary frame opened during a portal hold inherits the modifier', async () => {
  const parent=fixture(); await installLinuxScanInput(parent.win, {passive:true}); parent.send(true)
  const child=fixture(); child.win.top=parent.win; delete child.win.__TAURI__
  await installLinuxScanInput(child.win, {passive:true}); child.move(false)
  assert.equal(child.received.at(-1).shiftKey,true)
  parent.send(false); child.move(true)
  assert.equal(child.received.at(-1).shiftKey,false)
})

test('focusing a popup iframe cannot cancel a local Shift hold', async () => {
  const f=fixture(); await installLinuxScanInput(f.win); f.move(false)
  f.listeners.get('keydown')({key:'Shift',code:'ShiftLeft'})
  f.listeners.get('blur')(); f.move(false)
  assert.equal(f.received.length,2)
  assert.equal(f.received.at(-1).shiftKey,true)
})
test('a key released in a popup iframe releases the parent local hold', async () => {
  const parent=fixture(); await installLinuxScanInput(parent.win); parent.move(false)
  parent.listeners.get('keydown')({key:'Shift',code:'ShiftLeft'})
  const child=fixture(); child.win.top=parent.win; await installLinuxScanInput(child.win); child.move(false)
  assert.equal(child.received.at(-1).shiftKey,true)
  child.listeners.get('keyup')({key:'Shift',code:'ShiftLeft',shiftKey:true})
  parent.move(true); assert.equal(parent.received.at(-1).shiftKey,false)
})
test('leaving the native reader clears local keys without a release in that reader', async () => {
  const f=fixture(); await installLinuxScanInput(f.win); f.move(false)
  f.listeners.get('keydown')({key:'Shift',code:'ShiftLeft'})
  f.win.document.hasFocus=()=>false; f.listeners.get('blur')()
  f.move(true); assert.equal(f.received.at(-1).shiftKey,false)
})
test('physical Shift code works when its logical key name is remapped', async () => {
  const f=fixture(); await installLinuxScanInput(f.win); f.move(false)
  f.listeners.get('keydown')({key:'Unidentified',code:'ShiftLeft'})
  assert.equal(f.received.at(-1).shiftKey,true)
  f.listeners.get('keyup')({key:'Unidentified',code:'ShiftLeft',shiftKey:true})
  f.move(true); assert.equal(f.received.at(-1).shiftKey,false)
})

test('returning to a reader with Shift already held accepts fresh native pointer modifiers', async () => {
  const f=fixture(); await installLinuxScanInput(f.win); f.move(false)
  f.listeners.get('keydown')({key:'Shift',code:'ShiftLeft'})
  f.win.document.hasFocus=()=>false; f.listeners.get('blur')()
  assert.equal(f.move(true),true)
  f.win.document.hasFocus=()=>true; f.listeners.get('focus')()
  assert.equal(f.move(true),false)
})
test('an engine that reads mousemove (Hachidori) gets the Shift scan and glide as mousemove', async () => {
  const f = fixture()
  class MouseEvent { constructor(type, init) { this.type = type; Object.assign(this, init) } }
  f.win.MouseEvent = MouseEvent
  f.win.__kimochiExtensionHost = { descriptor: { pointerEvents: ['mousemove'] } }
  await installLinuxScanInput(f.win, { passive: true }); f.move(false)
  f.send(true)
  assert.deepEqual(f.received.map(e => [e.type, e.shiftKey]), [['mousemove', true]])
  let blocked = false
  f.listeners.get('mousemove')({ target: f.target, clientX: 18, clientY: 23, shiftKey: false,
    stopImmediatePropagation() { blocked = true } })
  assert.equal(blocked, true, 'the real move without Shift does not reach the engine')
  assert.deepEqual([f.received.at(-1).type, f.received.at(-1).shiftKey, f.received.at(-1).clientX], ['mousemove', true, 18])
})
test('hover mode looks up without any Shift feed (KDE Plasma overlay)', async () => {
  const f = fixture(); await installLinuxScanInput(f.win, { passive: true, hover: true })
  const blocked = f.move(false)
  assert.equal(blocked, true)
  assert.equal(f.received.at(-1).shiftKey, true)
  assert.deepEqual([f.received.at(-1).clientX, f.received.at(-1).clientY], [17, 23])
  f.surface(false)
  assert.equal(f.move(false), true, 'still corrected after the pointer comes back')
})
test('hover mode follows a live switch: once Shift is readable, the text waits for it', async () => {
  let hover = true
  const f = fixture(); await installLinuxScanInput(f.win, { passive: true, hover: () => hover })
  f.move(false)
  assert.equal(f.received.at(-1).shiftKey, true, 'hovering looks up while nothing reports Shift')
  hover = false
  f.send(false)
  const blocked = f.move(false)
  assert.equal(blocked, false, 'a plain move passes untouched once Shift is reported')
  const before = f.received.length
  f.send(true)
  assert.equal(f.received.length, before + 1, 'pressing Shift looks up the word under the pointer')
  assert.equal(f.received.at(-1).shiftKey, true)
})
test('a Shift scan is preceded by a plain move a pixel off, so 10ten does not drop it', async () => {
  const f = fixture(); await installLinuxScanInput(f.win, { passive: true }); f.move(false)
  f.send(true)
  assert.equal(f.received.length, 1)
  assert.equal(f.primes.length, 1)
  assert.deepEqual([f.primes[0].clientX, f.primes[0].shiftKey], [18, false])
  assert.deepEqual([f.received[0].clientX, f.received[0].shiftKey], [17, true])
})
