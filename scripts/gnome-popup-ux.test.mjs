import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Execute the real Shell implementation methods with only the compositor/DBus
// boundary substituted. No second implementation of selection or dismissal.
const source = (await readFile(new URL('../src-tauri/gnome-extension/implementation.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export default class', 'class') + '\nKimochiOverlay'
const Overlay = vm.runInNewContext(source, { Extension: class {}, GLib: { Variant: class {} } })
function fixture() {
  const overlay = new Overlay()
  const actors = Array.from({length: 6}, () => ({set_style(style) { this.style = style }}))
  const signals = []
  overlay._group = { get_child_at_index: i => actors[i] }
  overlay._words = ['日本語', '本語', '語', '日本語', '本語', '語'].map((text, i) => ({
    sentence: '日本語', text, offset: i % 3
  }))
  overlay._owner = ':1.2'; overlay._serial = 7; overlay._lastLookup = 0
  overlay._bus = { emit_signal: name => signals.push(name) }
  let visible = true
  const actor = { get_paint_visibility: () => visible, hide: () => { visible = false } }
  overlay._nativePopup = { get_compositor_private: () => actor,
    get_frame_rect: () => ({ x: 100, y: 100, width: 400, height: 250 }) }
  const invocation = { get_sender: () => ':1.2', return_value() {},
    return_dbus_error(name, message) { this.error = {name, message} } }
  return { overlay, actors, signals, invocation, visible: () => visible }
}
test('dictionary match highlights all three kanji without selecting an identical later line', () => {
  const f = fixture()
  f.overlay.HighlightAsync([JSON.stringify({serial:7,index:0,length:3})], f.invocation)
  assert.ok(f.actors.slice(0,3).every(a => a.style.includes('border-bottom')))
  assert.ok(f.actors.slice(3).every(a => !a.style.includes('border-bottom')))
})
test('late dictionary results and foreign clients cannot replace the current highlight', () => {
  const f = fixture()
  f.overlay.HighlightAsync([JSON.stringify({serial:6,index:0,length:3})], f.invocation)
  assert.equal(f.overlay._match, undefined)
  f.invocation.get_sender = () => ':1.3'
  f.overlay.HighlightAsync([JSON.stringify({serial:7,index:0,length:3})], f.invocation)
  assert.match(f.invocation.error.message, /Only the annotation owner/)
})
test('clicks inside the real popup remain interactive; outside clicks dismiss once', () => {
  const f = fixture()
  f.overlay._outsidePress(150, 150)
  assert.equal(f.visible(), true)
  assert.equal(f.signals.length, 0)
  f.overlay._outsidePress(10, 10)
  assert.equal(f.visible(), false)
  assert.deepEqual(f.signals, ['Dismiss'])
  f.overlay._outsidePress(10, 10)
  assert.equal(f.signals.length, 1)
})

test('transparent popup shadow is outside the interactive dictionary', () => {
  const f = fixture()
  f.overlay._popupRects = [{ x:116, y:116, width:368, height:218 }]
  f.overlay._outsidePress(105, 150)
  assert.deepEqual(f.signals, ['Dismiss'])
})

test('popup placement raises a mapped window once, without activating or repeatedly restacking it', () => {
  const overlay = new Overlay()
  let above = false, raised = 0, moved = 0, mapped = false
  const win = {
    get_compositor_private: () => ({get_paint_visibility: () => mapped}),
    is_override_redirect: () => false,
    is_above: () => above,
    make_above: () => { raised++; above = true },
    get_frame_rect: () => ({x:100, y:100}),
    move_frame: () => { moved++ },
    activate: () => assert.fail('hover must not activate the popup')
  }
  overlay._watchPopupButtons = () => {}
  const rect = {x:100,y:100,width:400,height:250}
  overlay._placePopup(win, rect)
  assert.equal(raised, 0, 'unmapped windows are not in Mutter’s stack')
  mapped = true
  for (let i = 0; i < 100; i++) overlay._placePopup(win, rect)
  assert.equal(raised, 1)
  assert.equal(moved, 0)
  win.is_override_redirect = () => true
  above = false
  overlay._placePopup(win, rect)
  assert.equal(raised, 1, 'override-redirect surfaces are not stack-managed')
})
