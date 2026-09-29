import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { acceleratorCaps, acceleratorFromEvent, detectKeyPlatform, formatAccelerator } = await load(
  '../frontend/panels/settings/accelerator.ts'
)

const press = (code, key, mods = {}) => ({
  code,
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

test('detects macOS from navigator hints', () => {
  assert.equal(detectKeyPlatform({ platform: 'MacIntel', userAgent: '' }), 'mac')
  assert.equal(detectKeyPlatform({ platform: 'Win32', userAgent: 'Windows NT 10.0' }), 'other')
  assert.equal(detectKeyPlatform({ platform: '', userAgent: 'X11; Linux x86_64' }), 'other')
})

test('formats accelerators as platform key caps', () => {
  assert.deepEqual(acceleratorCaps('CommandOrControl+Shift+8', 'mac'), ['⇧', '⌘', '8'])
  assert.deepEqual(acceleratorCaps('CommandOrControl+Shift+8', 'other'), ['Ctrl', 'Shift', '8'])
  assert.deepEqual(acceleratorCaps('Control+Alt+Up', 'mac'), ['⌃', '⌥', '↑'])
  assert.deepEqual(acceleratorCaps('CmdOrCtrl+Space', 'other'), ['Ctrl', 'Space'])
  assert.deepEqual(acceleratorCaps('F5', 'mac'), ['F5'])
  assert.deepEqual(acceleratorCaps('CommandOrControl++', 'other'), ['Ctrl', '+'])
  assert.deepEqual(acceleratorCaps('Alt+KeyK', 'other'), ['Alt', 'K'])
  assert.equal(formatAccelerator('CommandOrControl+Shift+8', 'mac'), '⇧⌘8')
  assert.equal(formatAccelerator('CommandOrControl+Shift+8', 'other'), 'Ctrl+Shift+8')
})

test('converts key presses to Tauri accelerators', () => {
  assert.equal(acceleratorFromEvent(press('Digit8', '*', { metaKey: true, shiftKey: true }), 'mac'), 'CommandOrControl+Shift+8')
  assert.equal(acceleratorFromEvent(press('Digit8', '*', { ctrlKey: true, shiftKey: true }), 'other'), 'CommandOrControl+Shift+8')
  assert.equal(acceleratorFromEvent(press('KeyK', 'k', { ctrlKey: true }), 'mac'), 'Control+K')
  assert.equal(acceleratorFromEvent(press('KeyJ', '∆', { altKey: true }), 'mac'), 'Alt+J')
  assert.equal(acceleratorFromEvent(press('ArrowUp', 'ArrowUp', { metaKey: true }), 'mac'), 'CommandOrControl+Up')
  assert.equal(acceleratorFromEvent(press('Space', ' ', { ctrlKey: true }), 'other'), 'CommandOrControl+Space')
  assert.equal(acceleratorFromEvent(press('F13', 'F13'), 'mac'), 'F13')
  assert.equal(acceleratorFromEvent(press('Comma', ',', { metaKey: true }), 'mac'), 'CommandOrControl+,')
})

test('rejects keys that cannot be global shortcuts', () => {
  assert.equal(acceleratorFromEvent(press('KeyA', 'a'), 'mac'), null)
  assert.equal(acceleratorFromEvent(press('KeyA', 'A', { shiftKey: true }), 'mac'), null)
  assert.equal(acceleratorFromEvent(press('MetaLeft', 'Meta', { metaKey: true }), 'mac'), null)
  assert.equal(acceleratorFromEvent(press('Shift', 'Shift', { shiftKey: true }), 'other'), null)
})
