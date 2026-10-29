import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const {
  acceleratorCaps,
  acceleratorFromEvent,
  heldModifierCaps,
  isMouseAccelerator,
  isPrimaryModifier,
  keyPlatformOf,
  formatAccelerator,
  mouseButtonAccelerator
} =
  await load('../frontend/panels/settings/accelerator.ts')
const { fallbackCapabilities, normalizeCapabilities, DEFAULT_CAPABILITIES_MACOS } = await load('capabilities.ts')

const MAC = { os: 'macos', keys: { primaryModifier: 'meta' } }
const WINDOWS = { os: 'windows', keys: { primaryModifier: 'ctrl' } }
const LINUX = { os: 'linux', keys: { primaryModifier: 'ctrl' } }

const press = (code, key, mods = {}) => ({
  code,
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

test('the key platform comes from the platform capabilities', () => {
  assert.equal(keyPlatformOf(MAC), 'mac')
  assert.equal(keyPlatformOf(WINDOWS), 'windows')
  assert.equal(keyPlatformOf(LINUX), 'linux')
})

test('without native capabilities, the default still follows navigator hints', () => {
  assert.equal(keyPlatformOf(fallbackCapabilities({ platform: 'MacIntel', userAgent: '' })), 'mac')
  assert.equal(keyPlatformOf(fallbackCapabilities({ platform: 'Win32', userAgent: 'Windows NT 10.0' })), 'windows')
  assert.equal(keyPlatformOf(fallbackCapabilities({ platform: '', userAgent: 'X11; Linux x86_64' })), 'linux')
  // Nothing to go on: today's macOS.
  assert.equal(fallbackCapabilities({}), DEFAULT_CAPABILITIES_MACOS)
  assert.equal(normalizeCapabilities(null, DEFAULT_CAPABILITIES_MACOS), DEFAULT_CAPABILITIES_MACOS)
})

test('a partial capabilities payload is completed from the default', () => {
  const caps = normalizeCapabilities(
    { os: 'windows', keys: { primaryModifier: 'ctrl', labels: 'words', superName: 'Win' }, ocrEngines: { mangaocr: { available: false, reason: 'No' } } },
    DEFAULT_CAPABILITIES_MACOS
  )
  assert.equal(caps.os, 'windows')
  assert.equal(caps.keys.superName, 'Win')
  assert.equal(caps.ocrEngines.mangaocr.available, false)
  assert.equal(caps.ocrEngines.cloud.available, true)
  assert.deepEqual(caps.ownAppNames, DEFAULT_CAPABILITIES_MACOS.ownAppNames)
  assert.deepEqual(caps.input, DEFAULT_CAPABILITIES_MACOS.input)
})

test('formats accelerators as platform key caps', () => {
  assert.deepEqual(acceleratorCaps('CommandOrControl+Shift+8', 'mac'), ['⇧', '⌘', '8'])
  assert.deepEqual(acceleratorCaps('CommandOrControl+Shift+8', 'windows'), ['Ctrl', 'Shift', '8'])
  assert.deepEqual(acceleratorCaps('CommandOrControl+Shift+8', 'linux'), ['Ctrl', 'Shift', '8'])
  assert.deepEqual(acceleratorCaps('Control+Alt+Up', 'mac'), ['⌃', '⌥', '↑'])
  assert.deepEqual(acceleratorCaps('CmdOrCtrl+Space', 'windows'), ['Ctrl', 'Space'])
  assert.deepEqual(acceleratorCaps('F5', 'mac'), ['F5'])
  assert.deepEqual(acceleratorCaps('CommandOrControl++', 'windows'), ['Ctrl', '+'])
  assert.deepEqual(acceleratorCaps('Alt+KeyK', 'windows'), ['Alt', 'K'])
  assert.equal(formatAccelerator('CommandOrControl+Shift+8', 'mac'), '⇧⌘8')
  assert.equal(formatAccelerator('CommandOrControl+Shift+8', 'windows'), 'Ctrl+Shift+8')
})

test('converts key presses to Tauri accelerators', () => {
  assert.equal(acceleratorFromEvent(press('Digit8', '*', { metaKey: true, shiftKey: true }), 'mac'), 'CommandOrControl+Shift+8')
  assert.equal(acceleratorFromEvent(press('Digit8', '*', { ctrlKey: true, shiftKey: true }), 'windows'), 'CommandOrControl+Shift+8')
  assert.equal(acceleratorFromEvent(press('KeyK', 'k', { ctrlKey: true }), 'mac'), 'Control+K')
  assert.equal(acceleratorFromEvent(press('KeyJ', '∆', { altKey: true }), 'mac'), 'Alt+J')
  assert.equal(acceleratorFromEvent(press('ArrowUp', 'ArrowUp', { metaKey: true }), 'mac'), 'CommandOrControl+Up')
  assert.equal(acceleratorFromEvent(press('Space', ' ', { ctrlKey: true }), 'windows'), 'CommandOrControl+Space')
  assert.equal(acceleratorFromEvent(press('F13', 'F13'), 'mac'), 'F13')
  assert.equal(acceleratorFromEvent(press('Comma', ',', { metaKey: true }), 'mac'), 'CommandOrControl+,')
})

test('keys that type nothing can be a shortcut on their own or with Shift (#19)', () => {
  for (const platform of ['windows', 'linux', 'mac']) {
    assert.equal(acceleratorFromEvent(press('Insert', 'Insert'), platform), 'Insert')
    assert.equal(acceleratorFromEvent(press('Pause', 'Pause'), platform), platform === 'mac' ? null : 'Pause')
    assert.equal(acceleratorFromEvent(press('ScrollLock', 'ScrollLock'), platform), platform === 'mac' ? null : 'ScrollLock')
    assert.equal(acceleratorFromEvent(press('F8', 'F8', { shiftKey: true }), platform), 'Shift+F8')
    assert.equal(acceleratorFromEvent(press('Insert', 'Insert', { shiftKey: true }), platform), 'Shift+Insert')
  }
  assert.deepEqual(acceleratorCaps('Insert', 'windows'), ['Ins'])
  assert.deepEqual(acceleratorCaps('Shift+ScrollLock', 'windows'), ['Shift', 'ScrLk'])
  assert.deepEqual(acceleratorCaps('Pause', 'linux'), ['Pause'])
  // Keys that move the cursor or scroll stay modifier-only: taking them globally breaks every app.
  for (const [code, key] of [['Home', 'Home'], ['PageDown', 'PageDown'], ['ArrowUp', 'ArrowUp'], ['Space', ' '], ['Enter', 'Enter'], ['Digit8', '8']]) {
    assert.equal(acceleratorFromEvent(press(code, key), 'windows'), null, code)
  }
})

test('macOS rejects unsupported Pause and Scroll Lock even with modifiers', () => {
  for (const key of ['Pause', 'ScrollLock']) {
    for (const modifiers of [{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      assert.equal(acceleratorFromEvent(press(key, key, modifiers), 'mac'), null)
    }
    assert.equal(acceleratorFromEvent(press(key, key, { shiftKey: true }), 'windows'), `Shift+${key}`)
    assert.equal(acceleratorFromEvent(press(key, key, { ctrlKey: true }), 'linux'), `CommandOrControl+${key}`)
  }
})

test('rejects keys that cannot be global shortcuts', () => {
  assert.equal(acceleratorFromEvent(press('KeyA', 'a'), 'mac'), null)
  assert.equal(acceleratorFromEvent(press('KeyA', 'A', { shiftKey: true }), 'mac'), null)
  assert.equal(acceleratorFromEvent(press('MetaLeft', 'Meta', { metaKey: true }), 'mac'), null)
  assert.equal(acceleratorFromEvent(press('Shift', 'Shift', { shiftKey: true }), 'windows'), null)
})

test('the Super key is Win on Windows and Super on Linux', () => {
  assert.deepEqual(acceleratorCaps('Super+Alt+K', 'windows'), ['Win', 'Alt', 'K'])
  assert.deepEqual(acceleratorCaps('Super+Alt+K', 'linux'), ['Super', 'Alt', 'K'])
  assert.deepEqual(acceleratorCaps('Super+Alt+K', 'mac'), ['⌥', '⌘', 'K'])
  assert.equal(formatAccelerator('Control+Super+Shift+F2', 'windows'), 'Ctrl+Win+Shift+F2')
  assert.equal(formatAccelerator('CommandOrControl+Enter', 'linux'), 'Ctrl+Enter')
})

test('recording maps the primary modifier per platform', () => {
  for (const platform of ['windows', 'linux']) {
    assert.equal(acceleratorFromEvent(press('KeyK', 'k', { ctrlKey: true }), platform), 'CommandOrControl+K')
    assert.equal(acceleratorFromEvent(press('KeyK', 'k', { metaKey: true }), platform), 'Super+K')
  }
  assert.deepEqual(heldModifierCaps({ metaKey: true, ctrlKey: true, altKey: false, shiftKey: false }, 'windows'), ['Ctrl', 'Win'])
  assert.deepEqual(heldModifierCaps({ metaKey: true, ctrlKey: true, altKey: false, shiftKey: false }, 'linux'), ['Ctrl', 'Super'])
  assert.deepEqual(heldModifierCaps({ metaKey: true, ctrlKey: true, altKey: false, shiftKey: false }, 'mac'), ['⌃', '⌘'])
})

test('app shortcuts use ⌘ alone on macOS and Ctrl alone elsewhere', () => {
  const held = (mods) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })
  assert.equal(isPrimaryModifier(held({ metaKey: true }), MAC), true)
  assert.equal(isPrimaryModifier(held({ ctrlKey: true }), MAC), false)
  assert.equal(isPrimaryModifier(held({ metaKey: true, ctrlKey: true }), MAC), false)
  assert.equal(isPrimaryModifier(held({ metaKey: true, shiftKey: true }), MAC), false)
  assert.equal(isPrimaryModifier(held({ metaKey: true, altKey: true }), MAC), false)
  for (const caps of [WINDOWS, LINUX]) {
    assert.equal(isPrimaryModifier(held({ ctrlKey: true }), caps), true)
    assert.equal(isPrimaryModifier(held({ metaKey: true }), caps), false)
    assert.equal(isPrimaryModifier(held({ ctrlKey: true, shiftKey: true }), caps), false)
  }
})

test('middle, back and forward record as mouse accelerators; left and right never do', () => {
  assert.equal(mouseButtonAccelerator(1), 'MouseMiddle')
  assert.equal(mouseButtonAccelerator(3), 'MouseBack')
  assert.equal(mouseButtonAccelerator(4), 'MouseForward')
  for (const button of [0, 2, 5, -1]) assert.equal(mouseButtonAccelerator(button), null, `button ${button}`)
  for (const accelerator of ['MouseMiddle', 'MouseBack', 'MouseForward', 'mouseback']) {
    assert.equal(isMouseAccelerator(accelerator), true, accelerator)
  }
  for (const accelerator of ['', 'Insert', 'F8', 'CommandOrControl+Shift+8', 'MouseLeft', 'Shift+MouseBack']) {
    assert.equal(isMouseAccelerator(accelerator), false, accelerator)
  }
})

test('mouse accelerators read as their button on every platform', () => {
  for (const platform of ['mac', 'windows', 'linux']) {
    assert.deepEqual(acceleratorCaps('MouseMiddle', platform), ['Middle Click'])
    assert.deepEqual(acceleratorCaps('MouseBack', platform), ['Mouse Back'])
    assert.equal(formatAccelerator('MouseForward', platform), 'Mouse Forward')
  }
})

test('mouse buttons are offered only where native says they can fire', () => {
  // An older backend that never mentions them, and the default before native replies: never.
  assert.equal(DEFAULT_CAPABILITIES_MACOS.keys.mouseButtons, 'unsupported')
  const old = normalizeCapabilities({ os: 'windows', keys: { primaryModifier: 'ctrl', labels: 'words', superName: 'Win' } })
  assert.equal(old.keys.mouseButtons, 'unsupported')
  assert.equal(fallbackCapabilities({ platform: 'Win32', userAgent: 'Windows NT 10.0' }).keys.mouseButtons, 'unsupported')
  const windows = normalizeCapabilities({ os: 'windows', keys: { mouseButtons: 'available' } })
  assert.equal(windows.keys.mouseButtons, 'available')
})
