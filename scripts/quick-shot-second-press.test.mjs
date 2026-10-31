/**
 * Quick Shot's shortcut pressed again while its editor is up. What it decides is pinned in
 * region-select.test.mjs; this pins that every Quick Shot editor gets the press, and that the press
 * is consumed rather than starting a second Quick Shot.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('a press during a Quick Shot goes to its editor before anything could open another', async () => {
  const overlay = await read('ui/overlay.js')
  const body = overlay.match(/async function quickShot\(\) \{([\s\S]*?)\n\}\n/)[1]
  const routed = body.indexOf('quickShotRun.press()')
  assert.ok(routed >= 0, 'a running Quick Shot takes the press')
  assert.ok(routed < body.indexOf('state.regionSelecting'), 'before the editor-open check')
  assert.ok(routed < body.indexOf('quickShotRun = run'), 'and before a new run is claimed')
  assert.ok(body.indexOf('QUICK_SHOT_REOPEN_MS') < body.indexOf('quickShotRun = run'))
  // The run is claimed with no await before it, so two presses cannot both start one.
  assert.doesNotMatch(body.slice(0, body.indexOf('quickShotRun = run')), /await /)
  // Every editor: the overlay's own (macOS, Windows, X11), the Wayland layer's and GNOME's.
  assert.match(body, /editRegion\('Scan', \{[\s\S]*?onStart: pressGoesTo[\s\S]*?\}\)\.finally\(closed\)/)
  assert.match(body, /editPortalRegion\(id, 'display', \{ quick: true, onStart: pressGoesTo \}\)/)
  assert.match(body, /editGnomeRegion\(id, \{ quick: true, onStart: pressGoesTo \}\)/)
  assert.match(body, /\} finally \{\s*closed\(\)\s*\}$/)
})

test('GNOME forwards the press to the crop host, which hands it to its editor', async () => {
  const crop = await read('ui/gnome-crop.js')
  assert.match(crop, /onStart\?\.\(\{shortcutPressed:\(\)=>\{void window\.__TAURI__\.event\.emit\('gnome-crop-press',\{id\}\)/)
  const host = await read('ui/gnome-crop-host.js')
  assert.match(host, /listen\('gnome-crop-press',\(\{payload\}\)=>\{\s*if\(active\?\.id===payload\?\.id\)active\.selector\.shortcutPressed\(\)/)
})
