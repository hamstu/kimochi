/**
 * The controller menu's model (ui/radial-items.js): which actions it holds and in what order, as
 * Settings → Radial menu edits it and the overlay draws it, and the per-item shortcuts' names
 * against native's list and defaults.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  RADIAL_ITEMS,
  DEFAULT_RADIAL_MENU,
  addRadialItem,
  canRemoveRadialItem,
  effectiveRadialMenu,
  hotkeyConflicts,
  isDefaultRadialMenu,
  missingRadialItems,
  radialItemForHotkey,
  radialItemsFor,
  removeRadialItem,
  reorderShownItems
} from '../ui/radial-items.js'

test('nothing stored is the shipped menu, which is the menu as it was before it could be changed', () => {
  assert.deepEqual(effectiveRadialMenu(undefined), DEFAULT_RADIAL_MENU)
  assert.deepEqual(effectiveRadialMenu(null), DEFAULT_RADIAL_MENU)
  assert.equal(isDefaultRadialMenu(undefined), true)
  // An OCR source: Scan, Read along, Auto OCR, Recent text, Kimochi, settings.
  assert.deepEqual(
    radialItemsFor(undefined, false).map((item) => item.id),
    ['scan', 'dictionary', 'auto', 'history', 'controls', 'ocr-settings']
  )
  // The Text Hooker: no Scan or Auto OCR, and its own card.
  assert.deepEqual(
    radialItemsFor(undefined, true).map((item) => item.id),
    ['dictionary', 'card', 'history', 'controls', 'ocr-settings']
  )
})

test('a stored menu keeps its order and loses unknown and repeated ids, but is never empty', () => {
  assert.deepEqual(effectiveRadialMenu(['history', 'retired', 'dictionary', 'history', 7]), ['history', 'dictionary'])
  assert.deepEqual(effectiveRadialMenu([]), DEFAULT_RADIAL_MENU)
  assert.deepEqual(effectiveRadialMenu(['retired']), DEFAULT_RADIAL_MENU)
  assert.deepEqual(effectiveRadialMenu('scan'), DEFAULT_RADIAL_MENU)
  assert.equal(isDefaultRadialMenu(['dictionary', 'scan']), false)
  assert.equal(isDefaultRadialMenu([...DEFAULT_RADIAL_MENU]), true)
})

test('items are removed down to one, and the last one stays', () => {
  let menu = ['dictionary', 'history']
  assert.equal(canRemoveRadialItem(menu, 'history'), true)
  menu = removeRadialItem(menu, 'history')
  assert.deepEqual(menu, ['dictionary'])
  assert.equal(canRemoveRadialItem(menu, 'dictionary'), false)
  assert.deepEqual(removeRadialItem(menu, 'dictionary'), ['dictionary'])
  // Not in the menu: nothing to remove.
  assert.equal(canRemoveRadialItem(['dictionary', 'history'], 'scan'), false)
})

test('an item added goes back where it was in the shipped menu, once', () => {
  const menu = removeRadialItem(removeRadialItem(DEFAULT_RADIAL_MENU, 'auto'), 'scan')
  assert.deepEqual(
    missingRadialItems(menu).map((item) => item.id),
    ['scan', 'auto', 'pause', 'pause-scan', 'pause-read-along']
  )
  assert.deepEqual(addRadialItem(menu, 'auto'), ['dictionary', 'auto', 'card', 'history', 'controls', 'ocr-settings'])
  assert.deepEqual(addRadialItem(menu, 'scan')[0], 'scan')
  assert.deepEqual(addRadialItem(menu, 'dictionary'), menu)
  assert.deepEqual(addRadialItem(menu, 'unknown'), menu)
  // In a reordered menu it goes before the first item that comes after it by default.
  assert.deepEqual(addRadialItem(['controls', 'dictionary'], 'history'), ['history', 'controls', 'dictionary'])
  // Only the optional items are missing from the menu as it ships.
  assert.deepEqual(
    missingRadialItems(DEFAULT_RADIAL_MENU).map((item) => item.id),
    ['pause', 'pause-scan', 'pause-read-along']
  )
})

test('an optional item is not in the shipped menu, and goes at its catalogue place when added', () => {
  for (const id of ['pause', 'pause-scan', 'pause-read-along']) assert.equal(DEFAULT_RADIAL_MENU.includes(id), false)
  assert.deepEqual(addRadialItem(DEFAULT_RADIAL_MENU, 'pause'), [...DEFAULT_RADIAL_MENU, 'pause'])
  assert.deepEqual(addRadialItem([...DEFAULT_RADIAL_MENU, 'pause-read-along'], 'pause-scan'), [
    ...DEFAULT_RADIAL_MENU,
    'pause-scan',
    'pause-read-along'
  ])
  // In a reordered menu it goes before the first item the catalogue puts after it.
  assert.deepEqual(addRadialItem(['scan', 'pause'], 'dictionary'), ['scan', 'dictionary', 'pause'])
  assert.equal(radialItemForHotkey('menuPause')?.id, 'pause')
  assert.equal(radialItemForHotkey('menuPauseScan')?.id, 'pause-scan')
  assert.equal(radialItemForHotkey('menuPauseReadAlong')?.id, 'pause-read-along')
})

test('Pause game is for any source; Pause & scan and Pause & read along only with OCR', () => {
  const menu = ['card', 'pause', 'pause-scan', 'pause-read-along']
  assert.deepEqual(radialItemsFor(menu, true), [
    { id: 'card', inapplicable: false },
    { id: 'pause', inapplicable: false }
  ])
  assert.deepEqual(radialItemsFor(menu, false), [
    { id: 'pause', inapplicable: false },
    { id: 'pause-scan', inapplicable: false },
    { id: 'pause-read-along', inapplicable: false }
  ])
})

test('a menu of items for the other kind of source shows them, unavailable, rather than nothing', () => {
  assert.deepEqual(radialItemsFor(['scan', 'auto'], true), [
    { id: 'scan', inapplicable: true },
    { id: 'auto', inapplicable: true }
  ])
  assert.deepEqual(radialItemsFor(['scan', 'card'], true), [{ id: 'card', inapplicable: false }])
  assert.deepEqual(radialItemsFor(['scan', 'card'], false), [{ id: 'scan', inapplicable: false }])
})

test('every item has its own shortcut action, which native knows, in the same order', async () => {
  const hotkeys = RADIAL_ITEMS.map((item) => item.hotkey)
  assert.equal(new Set(hotkeys).size, hotkeys.length)
  for (const item of RADIAL_ITEMS) assert.equal(radialItemForHotkey(item.hotkey), item)
  assert.equal(radialItemForHotkey('triggerScan'), undefined)
  const actions = await readFile(new URL('../src-tauri/src/actions.rs', import.meta.url), 'utf8')
  const list = (name) =>
    [...actions.match(new RegExp(`pub const ${name}[^=]*=\\s*&\\[([\\s\\S]*?)\\];`))[1].matchAll(/"(\w+)"/g)].map(
      (m) => m[1]
    )
  for (const name of hotkeys) {
    assert.ok(list('ACTIONS').includes(name), `${name} in ACTIONS`)
    assert.ok(list('HOTKEY_ACTIONS').includes(name), `${name} in HOTKEY_ACTIONS`)
  }
  // Native's defaults come from MENU_ITEM_ACTIONS, unbound (settings.rs tests the values).
  const items = [...actions.matchAll(/\("(menu\w+)", "/g)].map((m) => m[1])
  assert.deepEqual(items, hotkeys)
})

test('a shortcut that another one already uses is named, by keys and by buttons', () => {
  const hotkeys = {
    triggerScan: { name: 'Scan', accelerator: 'Shift+F8', enabled: true, gamepadButtons: [] },
    openControllerMenu: { name: 'Radial menu', accelerator: 'Shift+F9', enabled: true, gamepadButtons: [10, 11] },
    menuReadAlong: { name: 'Read along', accelerator: 'shift+f8', enabled: true, gamepadButtons: [11, 10] },
    menuRecentText: { name: 'Recent text', accelerator: '', enabled: true, gamepadButtons: [] },
    menuKimochi: { name: 'Kimochi', accelerator: '', enabled: true, gamepadButton: 10 },
    menuSettings: { name: 'Settings', accelerator: 'Shift+F8', enabled: false, gamepadButtons: [10, 11] }
  }
  assert.deepEqual(hotkeyConflicts(hotkeys, 'menuReadAlong'), { keys: ['Scan'], buttons: ['Radial menu'] })
  assert.deepEqual(hotkeyConflicts(hotkeys, 'triggerScan'), { keys: ['Read along'], buttons: [] })
  // Unbound shortcuts never clash with one another.
  assert.deepEqual(hotkeyConflicts(hotkeys, 'menuRecentText'), { keys: [], buttons: [] })
  // The legacy single button reads as a chord of one, which is not LS + RS.
  assert.deepEqual(hotkeyConflicts(hotkeys, 'menuKimochi'), { keys: [], buttons: [] })
  // A switched-off shortcut fires nothing, so clashes with nothing.
  assert.deepEqual(hotkeyConflicts(hotkeys, 'menuSettings'), { keys: [], buttons: [] })
  assert.deepEqual(hotkeyConflicts(hotkeys, 'missing'), { keys: [], buttons: [] })
})

test('dragging round the ring reorders what it shows, leaving the other source’s items where they were', () => {
  // With the Text Hooker the ring shows Read along, Text Hooker, Recent text, Kimochi, settings.
  assert.deepEqual(
    reorderShownItems(DEFAULT_RADIAL_MENU, ['card', 'dictionary', 'history', 'controls', 'ocr-settings']),
    ['scan', 'card', 'auto', 'dictionary', 'history', 'controls', 'ocr-settings']
  )
  assert.deepEqual(reorderShownItems(['history', 'scan'], ['scan', 'history']), ['scan', 'history'])
  // Nonsense leaves the menu as it was.
  assert.deepEqual(reorderShownItems(['history', 'scan'], ['scan', 'scan']), ['history', 'scan'])
})
