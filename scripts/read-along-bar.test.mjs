/**
 * Read along's control bar (ui/read-along-bar.js): outside a window source where there is room,
 * inside a full-screen one, never over the line being read; and what the setting keeps in it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { READ_ALONG_BAR_DEFAULTS, barHints, placeBar, readAlongBarSettings } from '../ui/read-along-bar.js'

const view = { width: 1920, height: 1080 }
const size = { width: 600, height: 44 }

test('a window with room below gets the bar under it, centred on the window', () => {
  const area = { x: 400, y: 200, width: 800, height: 600 }
  assert.deepEqual(placeBar({ view, area, size }), { x: 800, y: 810, edge: 'below' })
})

test('a window at the bottom of the display gets the bar above it', () => {
  const area = { x: 400, y: 460, width: 800, height: 600 }
  assert.deepEqual(placeBar({ view, area, size }), { x: 800, y: 406, edge: 'above' })
})

test('a window filling the height keeps the bar inside along its bottom, as before', () => {
  const area = { x: 400, y: 0, width: 800, height: 1080 }
  // 64 above the source's bottom edge, where the bar always was.
  assert.deepEqual(placeBar({ view, area, size }), { x: 800, y: 1016, edge: 'bottom' })
})

test('a full-screen source keeps the bar inside, whether native says so or it covers the display', () => {
  const full = { x: 0, y: 0, width: 1920, height: 1080 }
  assert.equal(placeBar({ view, area: full, size }).edge, 'bottom')
  // Native says full screen: inside even though it would fit outside.
  const window = { x: 400, y: 200, width: 800, height: 600 }
  assert.equal(placeBar({ view, area: window, fullscreen: true, size }).edge, 'bottom')
})

test('an unknown source puts the bar along the bottom of the display', () => {
  assert.deepEqual(placeBar({ view, area: null, size }), { x: 960, y: 1016, edge: 'bottom' })
})

test('the bar moves to the other edge rather than cover the line being read', () => {
  const full = { x: 0, y: 0, width: 1920, height: 1080 }
  // The dialogue's last line along the bottom, where the bar would go.
  const line = { left: 300, top: 1000, width: 1300, height: 40 }
  assert.equal(placeBar({ view, area: full, size, avoid: [line] }).edge, 'top')
  // A line elsewhere leaves it at the bottom.
  const high = { left: 300, top: 500, width: 1300, height: 40 }
  assert.equal(placeBar({ view, area: full, size, avoid: [high] }).edge, 'bottom')
})

test('a tall window with its text at the bottom: the bar goes to the top, off the text', () => {
  const area = { x: 600, y: 0, width: 720, height: 1080 }
  const lines = [
    { left: 640, top: 980, width: 600, height: 36 },
    { left: 640, top: 1024, width: 600, height: 36 }
  ]
  assert.deepEqual(placeBar({ view, area, size, avoid: lines }), { x: 960, y: 20, edge: 'top' })
})

test('a window hanging off the display is measured by the part on it', () => {
  // Off the left edge and below the bottom: no room below, room above.
  const area = { x: -300, y: 500, width: 800, height: 700 }
  const place = placeBar({ view, area, size })
  assert.equal(place.edge, 'above')
  // Centred on the visible part, kept on the display.
  assert.equal(place.x, size.width / 2 + 8)
})

test('a small window on a small display: the bar stays on screen', () => {
  const small = { width: 1280, height: 800 }
  const area = { x: 1000, y: 100, width: 260, height: 300 }
  const place = placeBar({ view: small, area, size })
  assert.equal(place.edge, 'below')
  assert.equal(place.x, 1280 - size.width / 2 - 8)
})

test('a line it cannot escape anywhere leaves the bar at its first place', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1080 }
  const everywhere = { left: 0, top: 0, width: 1920, height: 1080 }
  assert.equal(placeBar({ view, area, size, avoid: [everywhere] }).edge, 'bottom')
})

test('the setting: defaults for anything missing, and the hints it keeps', () => {
  assert.deepEqual(readAlongBarSettings(undefined), READ_ALONG_BAR_DEFAULTS)
  assert.deepEqual(readAlongBarSettings({ shown: false, hints: 'nonsense' }), {
    shown: false,
    counter: true,
    hints: 'all'
  })
  const hints = [
    { html: '<a>', basic: true },
    { html: '<b>', basic: false },
    { html: '<c>', basic: true }
  ]
  assert.equal(barHints(hints, 'all'), '<a><b><c>')
  assert.equal(barHints(hints, 'basic'), '<a><c>')
  assert.equal(barHints(hints, 'none'), '')
})

test('the defaults agree with ui/settings.ts and the Rust store', async () => {
  const ts = await readFile(new URL('../ui/settings.ts', import.meta.url), 'utf8')
  assert.match(ts, /DEFAULT_READ_ALONG_BAR: ReadAlongBarSettings = \{ shown: true, counter: true, hints: 'all' \}/)
  const rust = await readFile(new URL('../src-tauri/src/settings.rs', import.meta.url), 'utf8')
  assert.match(rust, /"readAlongBar": \{ "shown": true, "counter": true, "hints": "all" \}/)
  assert.deepEqual(READ_ALONG_BAR_DEFAULTS, { shown: true, counter: true, hints: 'all' })
})
