#!/usr/bin/env node
// The KDE Plasma overlay scenario, end to end in the rig (see README.md):
//   node scripts/e2e-kde/run.mjs [--scale 1.5] [--x11] [--outputs 2] [--dictionary] [--twin] [--no-eavesdrop] [--portal] [--keep]
// A fresh headless Plasma session, the fake game, the debug app; the window is chosen in Kimochi's
// own picker and captured through KWin's screencast by its window id (with --portal: in KDE's
// screen-share dialog, then linked to its KWin window). Then: OCR, the overlay drawn on the game's text, following a moved window,
// hover, Bring to front, and the global scan shortcut; with --dictionary, 10ten is downloaded
// through Settings and a hover must open its pop-up; with --twin, a second window of the same size
// makes the link ambiguous, so Kimochi must ask which window was shared. Shift works as on macOS
// and Windows (read through XWayland, which KWin hands the modifier keys): the words let clicks
// through to the game until it is held. --no-eavesdrop turns that relay off in kwinrc (Legacy X11
// App Support: Never), where the overlay's text looks up on hover instead.
// Screenshots and results.json go to $RIG/out.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rig, until, sleep, RIG } from './rig.mjs'
import { evaluate } from './wk.mjs'
import { tap } from './ui.mjs'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback }
const scale = Number(value('--scale', '1'))
const x11 = flag('--x11')
// Native capture (KWin's own screencast, sources chosen in Kimochi's picker) unless --portal.
const native = !flag('--portal')
if (!native) process.env.KIMOCHI_WAYLAND_CAPTURE = 'portal'
const outputs = Number(value('--outputs', '1'))
const out = join(RIG, 'out'); 
const results = []
let failed = false
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`)
}
const invoke = (cmd, args) => evaluate('panel.html', `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`)
const shot = (name) => { const file = join(out, `${name}.png`); rig.shot(file); return file }
const game = () => rig.windows().find(w => w.caption === 'Rig Game')
/** The game's text lines on screen, in logical pixels. An XWayland game that applies scaling itself
 * (Plasma's default) reports device pixels, so its own client size against KWin's gives the factor. */
function gameLines() {
  const layout = rig.targetLayout(), w = game()
  const k = w.client.width / layout.client[0]
  return layout.lines.map(l => ({ text: l.text, x: w.client.x + l.x * k, y: w.client.y + l.y * k, width: l.width * k, height: l.height * k }))
}

/** Where Kimochi's overlay surface is: its layer-shell window (non-normal layer) fills an output. */
const overlayOrigin = () => rig.windows().find(w => w.pid === rig.kjson('status').pid && w.layer > 2)?.frame ?? { x: 0, y: 0 }
/** The overlay's word boxes, in global logical pixels. */
async function boxes() {
  const o = overlayOrigin()
  const local = await evaluate('overlay.html', `[...document.querySelectorAll('#words > *')].map(e => {
    const r = e.getBoundingClientRect(); return { text: e.innerText, x: r.x, y: r.y, width: r.width, height: r.height } })
    .filter(b => b.width > 0 && b.height > 0)`)
  return local.map(b => ({ ...b, x: b.x + o.x, y: b.y + o.y }))
}

/** Every line the game drew has an overlay box on it (within `slack` px, covering most of it). */
async function boxesOnText(label) {
  const found = await boxes()
  const misses = gameLines().map(want => {
    const line = want
    const hit = found.find(b => Math.abs(b.y + b.height / 2 - (want.y + want.height / 2)) < Math.max(12, want.height / 3)
      && b.x < want.x + 16 && b.x + b.width > want.x + want.width * 0.8)
    return hit ? null : { line: line.text, want: Object.fromEntries(Object.entries(want).map(([k, v]) => [k, Math.round(v)])) }
  }).filter(Boolean)
  check(`overlay boxes sit on the game's text (${label})`, misses.length === 0 && found.length > 0,
    misses.length ? { misses, boxes: found.map(b => [b.x, b.y, b.width, b.height].map(Math.round)) } : `${found.length} boxes`)
}

mkdirSync(out, { recursive: true })
if (!flag('--keep')) rig.up({ SCALE: String(scale), OUTPUTS: String(outputs) })
mkdirSync(out, { recursive: true })

// The game first, so it is the first window in KDE's picker.
process.env.GDK_BACKEND = x11 ? 'x11' : ''
rig.target(960, 540, 'Rig Game')
await until('the game window', () => game() && rig.targetLayout())
if (flag('--twin')) {
  // Same size, opened second (so the game stays the picker's first card), offset to stay distinct.
  rig.target(960, 540, 'Rig Twin')
  await until('the twin window', () => rig.windows().find(w => w.caption === 'Rig Twin'))
  rig.js(`for (const w of workspace.windowList()) if (w.caption == 'Rig Twin') { const f = w.frameGeometry; w.frameGeometry = {x: 20, y: 20, width: f.width, height: f.height}; }
    for (const w of workspace.windowList()) if (w.caption == 'Rig Game') workspace.activeWindow = w`)
}
const eavesdrop = !flag('--no-eavesdrop')
if (!eavesdrop) {
  rig.sh('x', 'kwriteconfig6', '--file', 'kwinrc', '--group', 'Xwayland', '--key', 'XwaylandEavesdrops', 'None')
  rig.sh('x', 'busctl', '--user', 'call', 'org.kde.KWin', '/KWin', 'org.kde.KWin', 'reconfigure')
}
rig.app()
await until('the Kimochi CLI', () => rig.kjson('status').running, { timeout: 60000 })
// The bridge loads on first use (the overlay's first pointer poll).
const bridged = await until('the KWin bridge', () => /KWin window tracking: bridge script loaded/.test(rig.log('kimochi.log')), { timeout: 20000 }).catch(() => false)
check('KWin bridge loaded', bridged, rig.log('kimochi.log').split('\n').filter(l => /KWin|layer-shell/.test(l)).join(' | '))

// KDE asks once whether Kimochi may have its global shortcuts.
const asked = await until('the shortcut request', () => rig.windows().find(w => w.caption.startsWith('Global Shortcuts')), { timeout: 15000 }).catch(() => null)
if (asked) {
  rig.js(`for (const w of workspace.windowList()) if (w.caption.startsWith('Global Shortcuts')) workspace.activeWindow = w`)
  await sleep(300); rig.input('key', 28)
}
const shortcuts = await until('shortcut registration', () => rig.evidence().findLast(e => e.check === 'global-shortcuts'), { timeout: 15000 }).catch(() => null)
check('global shortcuts registered on first launch', shortcuts?.report?.registered?.length > 0, shortcuts?.report?.failed?.[0]?.error ?? '')

rig.k('settings', 'set', 'liveOverlayEnabled', 'true')
if (flag('--dictionary')) {
  // 10ten, downloaded and chosen in Settings → Dictionary, then its word data (~1 min).
  rig.k('open', 'settings', 'dictionary')
  await sleep(2000)
  await tap('panel.html', 'Kimochi', '10ten')
  await tap('panel.html', 'Kimochi', 'Download (')
  await until('10ten downloaded', async () => /Use 10ten/.test(await evaluate('panel.html', 'document.body.innerText')), { timeout: 120000, every: 2000 })
  await tap('panel.html', 'Kimochi', 'Use 10ten')
  const ready = await until('10ten\'s dictionary data', () => rig.evidence().findLast(e => e.check === 'dictionary-readiness' && /ready|failed/.test(e.phase)), { timeout: 240000, every: 2000 })
  check('10ten dictionary ready', ready.phase === 'ready', ready.message)
  await tap('panel.html', 'Kimochi', 'Back')
}
rig.k('ocr', 'meikiocr')
rig.k('open')
await sleep(1500)
let source
if (native) {
  // Kimochi's own picker: the compositor's windows by name, with thumbnails; no system dialog.
  await tap('panel.html', 'Kimochi', 'Choose a source', 'Window or screen')
  await sleep(1500) // thumbnails
  shot('1-picker')
  await tap('panel.html', 'Kimochi', 'Rig Game')
  source = await until('the chosen window', () => { const s = rig.kjson('status').source; return s?.sourceId?.startsWith('wayland:window:') && s })
  check('native window chosen in Kimochi\'s own picker (no system dialog)', source && !rig.windows().some(w => w.caption.startsWith('Share screen')), source.sourceId)
  const named = rig.kjson('status').source
  check('the source is named after the window and its app', named.name === 'Rig Game', named)
  if (flag('--twin')) {
    await sleep(3000)
    const text = await evaluate('panel.html', 'document.body.innerText')
    check('equal-size windows: nothing asks which one (the source names its window)', !/Link the shared window|Choose the shared window/.test(text))
  }
} else {
await tap('panel.html', 'Kimochi', 'Choose a source', 'Window or screen', 'Choose New Source')
const picker = await until('KDE\'s screen picker', () => rig.windows().find(w => w.caption.startsWith('Share screen')))
await sleep(1500) // thumbnails
// The game's card, found by its thumbnail (a solid block of the game's navy background); a click
// may only focus the dialog, so click until it closes.
const f = picker.frame
const found = rig.sh('shot', join(out, '1-picker.png'), '--find', 0x1d, 0x23, 0x33, ...[f.x, f.y, f.width, f.height].map(v => Math.round(v * scale))).match(/find \((\d+), (\d+)\)/)
if (!found) throw new Error('the game is not in KDE\'s picker')
const card = [Math.round(found[1] / scale), Math.round(found[2] / scale)]
console.log('picker card at', card.join(','))
for (let i = 0; i < 3 && rig.windows().some(w => w.caption.startsWith('Share screen')); i++) {
  rig.input('move', ...card, 'sleep', 300, 'click')
  await sleep(1200)
}
source = await until('the shared window', () => { const s = rig.kjson('status').source; return s?.sourceId?.startsWith('portal:window:') && s })
check('portal window source chosen', source, source.sourceId)
if (flag('--twin')) {
  // Two windows fit the stream: the source panel asks (HyprlandWindowLink, KDE too).
  const asked = await until('the link dialog', async () => /Link the shared window/.test(await evaluate('panel.html', 'document.body.innerText')), { timeout: 15000 }).catch(() => false)
  check('equal-size windows: Kimochi asks which one was shared', asked)
  const before = await invoke('linux_window_geometry', { operation: 'status', sourceId: source.sourceId, windowAddress: null })
  check('nothing is linked by guessing', !before.linked, before)
  await tap('panel.html', 'Kimochi', 'Rig Game', 'Link window')
  const linked = await until('the explicit link', async () => (await invoke('linux_window_geometry', { operation: 'status', sourceId: source.sourceId, windowAddress: null })).linked, { timeout: 8000 }).catch(() => false)
  check('the chosen window is linked', linked)
}
}

// Read with Kimochi out of the way, as a player would.
rig.js(`for (const w of workspace.windowList()) { if (w.resourceClass == 'kimochi' && w.normalWindow) w.minimized = true; if (w.caption == 'Rig Game') workspace.activeWindow = w }`)
await sleep(800)
const text = rig.k('scan', '--wait', '--timeout', '90')
check('OCR reads the shared window', /今日は/.test(text) && /図書館/.test(text), text.replace(/\n/g, ' / '))
const status = native
  ? await until('the window bounds', async () => { const s = await invoke('source_window_state', { sourceId: source.sourceId }); return s?.bounds && { linked: true, bounds: s.bounds } })
  : await until('the window link', async () => { const s = await invoke('linux_window_geometry', { operation: 'status', sourceId: source.sourceId, windowAddress: null }); return s.linked && s })
const g = game()
check(native ? 'bounds are the game window\'s own' : 'stream linked to the game window', status.linked && Math.abs(status.bounds.x - g.frame.x) < 1 && Math.abs(status.bounds.y - g.frame.y) < 1
  && Math.abs(status.bounds.width - g.frame.width) < 1, { bounds: status.bounds, frame: g.frame })
await until('overlay boxes', async () => (await boxes()).length > 0, { timeout: 10000 }).catch(() => {})
await boxesOnText('in place')
shot('2-overlay')

rig.js(`for (const w of workspace.windowList()) if (w.caption == 'Rig Game') { const f = w.frameGeometry; w.frameGeometry = {x: f.x - 280, y: f.y - 150, width: f.width, height: f.height} }`)
await sleep(1500)
await boxesOnText('after the window moved')
shot('3-moved')

if (outputs > 1) {
  const [, second] = JSON.parse(rig.js(`out(workspace.screens.map(o => ({name: o.name, geometry: o.geometry})))`))
  rig.js(`for (const w of workspace.windowList()) if (w.caption == 'Rig Game') { const f = w.frameGeometry; w.frameGeometry = {x: ${second.geometry.x} + 100, y: ${second.geometry.y} + 80, width: f.width, height: f.height} }`)
  await sleep(2500)
  check('the game is on the second output', game().output === second.name, game().output)
  await boxesOnText(`on the second output (${second.name})`)
  shot('3b-second-output')
}

// Hover the first line. The overlay answers the compositor's pointer (KWin bridge) with its card,
// but only while Shift is held, as on macOS and Windows; until then the text lets clicks through.
const caps = await invoke('platform_capabilities', {})
check(eavesdrop ? 'Shift is readable on Wayland (XWayland relay)' : 'without the relay, hover lookups stand in for Shift',
  eavesdrop ? caps?.overlay?.shiftGate === true && caps?.overlay?.shiftSource === 'xwayland'
    : caps?.overlay?.shiftGate === false && caps?.overlay?.lookupOnHover === true,
  caps?.overlay)
const [line] = gameLines()
const hx = Math.round(line.x + line.width / 3), hy = Math.round(line.y + line.height / 2)
// A pixel just above the glyphs, inside the card the overlay draws around the line.
const probe = [Math.round(hx * scale), Math.round((line.y + 2) * scale)]
const brightness = s => { const p = s.match(/pixel \d+ \d+ (\d+) (\d+) (\d+)/); return p ? (Number(p[1]) + Number(p[2]) + Number(p[3])) / 3 : -1 }
const before = rig.sh('shot', join(out, '4-before-hover.png'), '--pixel', ...probe)
rig.input('move', hx - 40, hy, 'sleep', 150, 'move', hx, hy, 'sleep', 1500)
const plain = rig.sh('shot', join(out, '4-hover-no-shift.png'), '--pixel', ...probe)
if (eavesdrop) {
  check('without Shift, hovering a line leaves it alone', Math.abs(brightness(plain) - brightness(before)) < 30, { before: brightness(before), after: brightness(plain) })
  // Fake input acts from where its own call last put the pointer: move, then click, in one call.
  const clicks = rig.targetClicks()
  rig.input('move', hx, hy, 'sleep', 150, 'click', 'sleep', 600)
  check('without Shift, a click on the text reaches the game', rig.targetClicks() > clicks, { clicks: rig.targetClicks() - clicks })
}
// Shift held (in the background) while the screenshot is taken, with the pointer at rest.
const holding = eavesdrop ? rig.hold('keydown', 42, 'sleep', 2500, 'keyup', 42) : null
if (eavesdrop) await sleep(1200)
const after = rig.sh('shot', join(out, '4-hover.png'), '--pixel', ...probe)
await holding
check(eavesdrop ? 'pressing Shift over a line shows its reading card' : 'hovering a line shows its reading card',
  brightness(after) > brightness(before) + 80, { before: brightness(before), after: brightness(after) })
if (eavesdrop) {
  const clicks = rig.targetClicks()
  rig.input('keydown', 42, 'move', hx + 2, hy, 'sleep', 150, 'click', 'sleep', 600, 'keyup', 42)
  check('with Shift held, the overlay takes the click', rig.targetClicks() === clicks, { clicks: rig.targetClicks() - clicks })
}
const pointer = await invoke('linux_window_geometry', { operation: 'pointer', sourceId: source.sourceId, windowAddress: null })
const origin = overlayOrigin() // the pointer is reported in the overlay's own coordinates
check('compositor pointer reaches the overlay', pointer && Math.abs(pointer.x + origin.x - hx - (eavesdrop ? 2 : 0)) < 2 && Math.abs(pointer.y + origin.y - hy) < 2, { pointer, origin: [origin.x, origin.y] })
if (eavesdrop) {
  rig.input('move', hx, hy + 200, 'sleep', 900)
  const gone = rig.sh('shot', join(out, '4c-shift-released.png'), '--pixel', ...probe)
  check('letting go of Shift and moving away puts the card away', brightness(gone) < brightness(after) - 40, { held: brightness(after), released: brightness(gone) })
  // The gate closed with nothing repainting: the input region must still drop the words (GTK
  // commits it on a paint), so a plain click on them reaches the game again.
  await sleep(600)
  const again = rig.targetClicks()
  rig.input('move', hx, hy, 'sleep', 600, 'click', 'sleep', 600)
  check('after Shift, a plain click on the text reaches the game again', rig.targetClicks() > again, { clicks: rig.targetClicks() - again })
}
if (flag('--dictionary')) {
  const popupShown = () => evaluate('overlay.html', 'window.__kimochiExtensionHost?.isPopupVisible?.() === true')
  if (eavesdrop) {
    // Over a word in the middle of the line, first without Shift: nothing opens.
    rig.input('move', hx + 20, hy, 'sleep', 120, 'move', hx + 24, hy + 1, 'sleep', 1500)
    check('without Shift, hovering a word opens nothing', !(await popupShown()))
  } else {
    rig.input('move', hx + 20, hy, 'sleep', 120, 'move', hx + 24, hy + 1)
  }
  // Then (with the relay) Shift with the pointer resting on the word: the word under it is looked up.
  const holding = eavesdrop ? rig.hold('keydown', 42, 'sleep', 6000, 'keyup', 42) : null
  const popup = await until('the dictionary pop-up', popupShown, { timeout: 5000 }).catch(() => false)
  check(eavesdrop ? 'pressing Shift over a word opens its dictionary pop-up' : 'hovering a word opens its dictionary pop-up', popup)
  shot('4b-dictionary')
  await holding
}
rig.input('move', 5, 5)

rig.js(`for (const w of workspace.windowList()) if (w.caption == 'Rig Game') w.minimized = true`)
const hidden = await until('the overlay to clear', async () => (await boxes()).length === 0, { timeout: 5000 }).catch(() => false)
check('a minimized game takes its overlay text with it', hidden)
const activated = await invoke('activate_source', { sourceId: source.sourceId }).then(() => 'ok', e => String(e))
await sleep(500)
const front = game()
check('Bring to front restores and activates the game', activated === 'ok' && !front.minimized && front.active, { activated, minimized: front.minimized, active: front.active })

const scans = () => rig.evidence().filter(e => e.check === 'overlay-action' && e.name === 'triggerScan').length
const n = scans()
rig.input('keydown', 42, 'key', 66, 'keyup', 42) // Shift+F8
const fired = await until('the scan shortcut', () => scans() > n, { timeout: 8000 }).catch(() => false)
check('Shift+F8 (portal global shortcut) scans', fired)

writeFileSync(join(out, 'results.json'), JSON.stringify({ scale, x11, results }, null, 1))
console.log(`\n${failed ? 'FAILED' : 'ALL PASSED'}  screenshots and results: ${out}`)
process.exit(failed ? 1 : 0)
