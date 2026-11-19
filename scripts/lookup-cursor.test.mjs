import test from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { lookupCursorPoint, updateLookupCursor } = await load('lookup-cursor.ts')
const point = { x: 15.5, y: 21 }

test('the visual cursor follows the configured modifier and existing mouse-button mapping', () => {
  for (const key of ['shift', 'ctrl', 'alt', 'meta']) {
    assert.equal(lookupCursorPoint({ [key]: true }, point, key, true), point)
    assert.equal(lookupCursorPoint({}, point, key, true), null)
  }
  for (const key of ['MouseMiddle', 'MouseBack', 'MouseForward']) {
    // Native carries a held lookup mouse button as Shift.
    assert.equal(lookupCursorPoint({ shift: true }, point, key, true), point)
  }
  assert.equal(lookupCursorPoint({ shift: true }, point, 'ctrl', true), null)
})

test('disabled settings, popups and invalid positions never draw a cursor', () => {
  assert.equal(lookupCursorPoint({ shift: true }, point, 'shift', false), null)
  assert.equal(lookupCursorPoint({ shift: true, over: false }, point, 'shift', true), null)
  assert.equal(lookupCursorPoint({ shift: true, blocked: true }, point, 'shift', true), null)
  assert.equal(lookupCursorPoint({ shift: true }, null, 'shift', true), null)
  assert.equal(lookupCursorPoint({ shift: true }, { x: NaN, y: 1 }, 'shift', true), null)
  assert.equal(lookupCursorPoint({ shift: true }, { x: 1, y: Infinity }, 'shift', true), null)
})

test('releasing lookup or disabling the option restores the webview cursor', () => {
  let nativeCursorHidden = false
  const element = {
    style: {},
    ownerDocument: {
      documentElement: {
        classList: {
          toggle(_name, value) {
            nativeCursorHidden = value
          }
        }
      }
    }
  }
  updateLookupCursor(element, { ctrl: true }, point, 'ctrl', true)
  assert.equal(element.style.display, 'block')
  assert.equal(nativeCursorHidden, true)
  assert.equal(element.style.transform, 'translate(15.5px, 21px)')
  updateLookupCursor(element, {}, point, 'ctrl', true)
  assert.equal(element.style.display, 'none')
  assert.equal(nativeCursorHidden, false)
  updateLookupCursor(element, { ctrl: true }, point, 'ctrl', true)
  updateLookupCursor(element, { ctrl: true }, point, 'ctrl', false)
  assert.equal(element.style.display, 'none')
  assert.equal(nativeCursorHidden, false)
  assert.doesNotThrow(() => updateLookupCursor(null, {}, null, 'shift', false))
})
