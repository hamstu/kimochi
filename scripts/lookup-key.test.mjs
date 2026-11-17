/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
/**
 * The overlay's lookup key can be a modifier or a mouse button (#204). Native carries a held
 * button as Shift, so what the dictionary hears never changes; these are the rules for the parts
 * that read the setting itself.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const {
  effectiveLookupKey,
  isLookupButton,
  lookupButtonFromEvent,
  lookupButtonsBit,
  lookupKeyLabel,
  lookupKeyWord,
  lookupModifier,
  lookupModifierFromKey
} = await load('lookup-key.ts')
const { withHoverKey } = await load('scan-input.ts')
const { fallbackCapabilities, normalizeCapabilities, DEFAULT_CAPABILITIES_MACOS } = await load('capabilities.ts')

test('mouse buttons are stored under the names a mouse shortcut uses', () => {
  for (const key of ['MouseMiddle', 'MouseBack', 'MouseForward']) assert.ok(isLookupButton(key), key)
  for (const key of ['shift', 'ctrl', 'alt', 'meta', 'MouseLeft', 'mousemiddle', '', undefined, null, 1]) {
    assert.ok(!isLookupButton(key), String(key))
  }
  assert.equal(lookupButtonFromEvent(1), 'MouseMiddle')
  assert.equal(lookupButtonFromEvent(3), 'MouseBack')
  assert.equal(lookupButtonFromEvent(4), 'MouseForward')
  // Never left or right: those are clicks.
  assert.equal(lookupButtonFromEvent(0), null)
  assert.equal(lookupButtonFromEvent(2), null)
  assert.equal(lookupButtonsBit('MouseMiddle'), 4)
  assert.equal(lookupButtonsBit('MouseBack'), 8)
  assert.equal(lookupButtonsBit('MouseForward'), 16)
  assert.equal(lookupButtonsBit('shift'), 0)
})

test('a button where none can be read is Shift, as native reads it', () => {
  assert.equal(effectiveLookupKey('MouseMiddle', 'consumed'), 'MouseMiddle')
  assert.equal(effectiveLookupKey('MouseBack', 'needsAccessibility'), 'MouseBack')
  assert.equal(effectiveLookupKey('MouseForward', 'passthrough'), 'MouseForward')
  assert.equal(effectiveLookupKey('MouseMiddle', 'unsupported'), 'shift')
  // An older backend says nothing: no buttons.
  assert.equal(effectiveLookupKey('MouseMiddle', undefined), 'shift')
  assert.equal(effectiveLookupKey('ctrl', 'unsupported'), 'ctrl')
  assert.equal(effectiveLookupKey('hyper', 'consumed'), 'shift')
  assert.equal(effectiveLookupKey(undefined, 'consumed'), 'shift')
})

test('the dictionary hears a lookup button as Shift', () => {
  assert.equal(lookupModifier('MouseMiddle'), 'shift')
  assert.equal(lookupModifier('alt'), 'alt')
  const resting = { x: 1, y: 2, hover: true }
  assert.equal(withHoverKey(resting, true, 'MouseBack', false).shift, true)
  assert.equal(withHoverKey(resting, true, 'ctrl', false).ctrl, true)
})

test('labels name the button, and the platform key elsewhere', () => {
  assert.equal(lookupKeyLabel('MouseMiddle', true), 'Middle Mouse')
  assert.equal(lookupKeyLabel('MouseBack', false), 'Mouse Back')
  assert.equal(lookupKeyLabel('MouseForward', false), 'Mouse Forward')
  assert.equal(lookupKeyLabel('shift', true), '⇧ Shift')
  assert.equal(lookupKeyLabel('ctrl', false), 'Ctrl')
  assert.equal(lookupKeyWord('alt', true), 'Option')
  assert.equal(lookupKeyWord('MouseMiddle', true), 'Middle Mouse')
})

test('a key press records one modifier on its own; Command only on a Mac', () => {
  assert.equal(lookupModifierFromKey('Shift', false), 'shift')
  assert.equal(lookupModifierFromKey('Control', true), 'ctrl')
  assert.equal(lookupModifierFromKey('Alt', false), 'alt')
  assert.equal(lookupModifierFromKey('Meta', true), 'meta')
  assert.equal(lookupModifierFromKey('Meta', false), null)
  for (const key of ['a', 'Escape', 'F8', 'CapsLock', 'AltGraph']) assert.equal(lookupModifierFromKey(key, true), null)
})

test('capabilities without lookupButtons say buttons are unsupported', () => {
  assert.equal(DEFAULT_CAPABILITIES_MACOS.keys.lookupButtons, 'unsupported')
  assert.equal(
    fallbackCapabilities({ platform: 'Win32', userAgent: 'Windows NT 10.0' }).keys.lookupButtons,
    'unsupported'
  )
  const windows = normalizeCapabilities({ os: 'windows', keys: { lookupButtons: 'consumed' } })
  assert.equal(windows.keys.lookupButtons, 'consumed')
})

test('the hint bar names the lookup key as Settings does', async () => {
  const keys = ['shift', 'ctrl', 'alt', 'meta', 'MouseMiddle', 'MouseBack', 'MouseForward']
  for (const os of ['macos', 'windows']) {
    globalThis.window = { __KIMOCHI_PLATFORM__: { os } }
    const { lookupKeyLabel: hintLabel } = await import(`../ui/overlay-hints.js?${os}`)
    for (const key of keys) assert.equal(hintLabel(key), lookupKeyLabel(key, os === 'macos'), `${os} ${key}`)
  }
  delete globalThis.window
})
