#!/usr/bin/env node
// Crop areas with two monitors on KDE Plasma, end to end in the rig (see README.md):
//   node scripts/e2e-kde/crop.mjs [--portal] [--scale2 1.5] [--only screens|window] [--keep]
// Two outputs side by side, the fake game on the second (not the primary, where Kimochi opens).
//
// - The second screen shared on its own: the crop editor opens on that screen (not the primary),
//   the region drawn there is saved in the screen's own pixels, the scan reads it, and the
//   overlay's text sits on the game there.
// - A window: a second crop replaces the first, and Clear OCR crop area clears it. Through the
//   portal the window is linked to its KWin window, which renames the source after it; both used
//   to keep the window's first crop (saved under the stream's anonymous name, read under its title).
// - With --portal, also KDE's "Share full Workspace" (both outputs in one stream: the editor opens
//   under the pointer and follows it to the other output) and "Share virtual screen" (an output on
//   no monitor: the editor shows its picture).
// --scale2 gives the second output its own scale (mixed DPI). Screenshots and results.json go to
// $RIG/out. Run it in its own rig (KIMOCHI_KDE_CONTAINER, KIMOCHI_KDE_RIG, WK_HOST and
// WEBKIT_INSPECTOR_HTTP_SERVER) when another one is up.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rig, until, sleep, RIG } from './rig.mjs'
import { evaluate } from './wk.mjs'
import { tap } from './ui.mjs'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const portal = flag('--portal')
if (portal) process.env.KIMOCHI_WAYLAND_CAPTURE = 'portal'
const scale2 = Number(value('--scale2', '1'))
// --only screens|window: one part of the scenario.
const only = value('--only', null)
const out = join(RIG, 'out')
const results = []
let failed = false
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  if (!ok) failed = true
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`
  )
}
const invoke = (cmd, args) =>
  evaluate('panel.html', `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`)
const shot = (name) => {
  const file = join(out, `${name}.png`)
  rig.shot(file)
  return file
}
const game = () => rig.windows().find((w) => w.caption === 'Rig Game')
const screens = () =>
  rig
    .js(`for (const o of workspace.screens) out({name: o.name, geometry: o.geometry, scale: o.devicePixelRatio})`)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
const near = (a, b, slack = 1) => Math.abs(a - b) <= slack
const sameRect = (a, b, slack = 1) =>
  a &&
  b &&
  near(a.x, b.x, slack) &&
  near(a.y, b.y, slack) &&
  near(a.width, b.width, slack) &&
  near(a.height, b.height, slack)

/** The game's text lines in global logical pixels (see run.mjs). */
function gameLines() {
  const layout = rig.targetLayout(),
    w = game()
  const k = w.client.width / layout.client[0]
  return layout.lines.map((l) => ({
    text: l.text,
    x: w.client.x + l.x * k,
    y: w.client.y + l.y * k,
    width: l.width * k,
    height: l.height * k
  }))
}
/** Kimochi's overlay: its layer surface fills one output. */
const overlay = () =>
  rig.windows().find((w) => w.pid === rig.kjson('status').pid && w.layer > 2 && w.frame.width > 400)?.frame ?? null
async function boxes() {
  const o = overlay() ?? { x: 0, y: 0 }
  const local = await evaluate(
    'overlay.html',
    `[...document.querySelectorAll('#words > *')].map(e => {
    const r = e.getBoundingClientRect(); return { text: e.innerText, x: r.x, y: r.y, width: r.width, height: r.height } })
    .filter(b => b.width > 0 && b.height > 0)`
  )
  return local.map((b) => ({ ...b, x: b.x + o.x, y: b.y + o.y }))
}
/** Overlay boxes over every line of the game inside `area` (global). */
async function boxesOnText(label, area) {
  const want = gameLines().filter((l) => l.y >= area.y && l.y + l.height <= area.y + area.height)
  const found = await boxes()
  const misses = want
    .filter(
      (l) =>
        !found.some(
          (b) =>
            Math.abs(b.y + b.height / 2 - (l.y + l.height / 2)) < Math.max(12, l.height / 3) &&
            b.x < l.x + 16 &&
            b.x + b.width > l.x + l.width * 0.8
        )
    )
    .map((l) => l.text)
  check(
    `overlay text sits on the game (${label})`,
    want.length > 0 && misses.length === 0,
    misses.length
      ? { misses, boxes: found.map((b) => [b.x, b.y, b.width, b.height].map(Math.round)) }
      : `${found.length} boxes`
  )
}

const evidenceCount = () => rig.evidence().length
const newEvidence = (from, check) =>
  rig
    .evidence()
    .slice(from)
    .filter((e) => e.check === check)

/** Open the OCR crop editor; resolves with the overlay's frame once the editor is up on `on`. */
async function openEditor({ on, label }) {
  await invoke('trigger_action', { name: 'setCropArea' })
  const editor = await until(
    'the crop editor',
    async () => {
      const o = overlay()
      const open = await evaluate('overlay.html', `Boolean(document.querySelector('[data-kimochi-region-select]'))`)
      return open && o && (!on || sameRect(o, on)) && o
    },
    { timeout: 8000 }
  ).catch(() => null)
  check(`the crop editor opens on ${label}`, editor, { overlay: overlay(), want: on })
  if (!editor) {
    // Escape, as the editor receives it (`region-key`), so the next step starts clean.
    await evaluate(
      'overlay.html',
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    ).catch(() => {})
    await sleep(500)
  }
  return editor
}
/** In the open editor, drag `box` (global logical) and press `button`; the `region-saved` record. */
async function dragAndSave(box, { button = 'Save and Scan', label }) {
  const from = evidenceCount()
  const editor = overlay()
  const [x0, y0, x1, y1] = [box.x, box.y, box.x + box.width, box.y + box.height].map(Math.round)
  rig.input(
    'move',
    x0,
    y0,
    'sleep',
    150,
    'down',
    'sleep',
    80,
    'move',
    (x0 + x1) >> 1,
    (y0 + y1) >> 1,
    'sleep',
    80,
    'move',
    x1,
    y1,
    'sleep',
    150,
    'up',
    'sleep',
    400
  )
  const target = await evaluate(
    'overlay.html',
    `(() => {
    const b = [...document.querySelectorAll('[data-kimochi-region-select] button')].find(e => e.innerText.trim().startsWith(${JSON.stringify(button)}))
    if (!b) return null
    const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`
  )
  if (!target) {
    check(`the editor offers ${button}`, false)
    return null
  }
  rig.input('move', Math.round(editor.x + target.x), Math.round(editor.y + target.y), 'sleep', 120, 'click')
  const saved = await until('the saved region', () => newEvidence(from, 'region-saved').at(-1), {
    timeout: 8000
  }).catch(() => null)
  check(`a region drawn on ${label} is saved`, saved, saved ?? newEvidence(from, 'region-edit-error').at(-1))
  return saved
}
async function drawCrop(box, { on, button = 'Save and Scan', label }) {
  return (await openEditor({ on, label })) ? dragAndSave(box, { button, label }) : null
}

/** A scan's text; once more if the first was discarded (a commit just changed the region). */
function scan(label = 'scan') {
  const once = () => rig.k('scan', '--wait', '--timeout', '90')
  try {
    return once()
  } catch {
    try {
      return once()
    } catch (error) {
      check(
        `${label}: the scan completes`,
        false,
        String(error.stderr ?? error.stdout ?? error.message)
          .trim()
          .slice(0, 400)
      )
      return ''
    }
  }
}
/** The crop that scans use now, as global logical pixels of the screen at `bounds`. */
function cropOnScreen(crop, bounds) {
  const sx = bounds.width / crop.reference_width,
    sy = bounds.height / crop.reference_height
  return { x: bounds.x + crop.x * sx, y: bounds.y + crop.y * sy, width: crop.width * sx, height: crop.height * sy }
}
/** The crop the selected source reads with (what a scan uses), from the shared view. */
const currentCrop = async () => (await invoke('snapshot', {}))?.crop ?? null

mkdirSync(out, { recursive: true })
if (!flag('--keep')) rig.up({ OUTPUTS: '2' })
mkdirSync(out, { recursive: true })
let [first, second] = screens()
if (scale2 !== 1) {
  rig.sh('x', 'kscreen-doctor', `output.${second.name}.scale.${scale2}`)
  await sleep(1500)
  ;[first, second] = screens()
}
console.log('outputs', JSON.stringify([first, second]))
check('two outputs side by side', first && second && second.geometry.x >= first.geometry.x + first.geometry.width, [
  first,
  second
])

rig.target(960, 540, 'Rig Game')
await until('the game window', () => game() && rig.targetLayout())
const placeGame = (x, y) =>
  rig.js(
    `for (const w of workspace.windowList()) if (w.caption == 'Rig Game') { const f = w.frameGeometry; w.frameGeometry = {x: ${x}, y: ${y}, width: f.width, height: f.height} }`
  )
placeGame(second.geometry.x + 120, second.geometry.y + 90)
await until('the game on the second output', () => game()?.output === second.name)

rig.app()
await until('the Kimochi CLI', () => rig.kjson('status').running, { timeout: 60000 })
const asked = await until(
  'the shortcut request',
  () => rig.windows().find((w) => w.caption.startsWith('Global Shortcuts')),
  { timeout: 15000 }
).catch(() => null)
if (asked) {
  rig.js(
    `for (const w of workspace.windowList()) if (w.caption.startsWith('Global Shortcuts')) workspace.activeWindow = w`
  )
  await sleep(300)
  rig.input('key', 28)
}
rig.k('settings', 'set', 'liveOverlayEnabled', 'true')
rig.k('ocr', 'meikiocr')
rig.k('open')
const main = await until('the main window', () => rig.windows().find((w) => w.caption === 'Kimochi' && w.normal))
check('Kimochi opens on the primary output', main.output === first.name, main.output)
await until('the KWin bridge', () => /KWin window tracking: bridge script loaded/.test(rig.log('kimochi.log')), {
  timeout: 20000
}).catch(() => false)

const keepOutOfTheWay = async () => {
  rig.js(
    `for (const w of workspace.windowList()) { if (w.resourceClass == 'kimochi' && w.normalWindow) w.minimized = true; if (w.caption == 'Rig Game') workspace.activeWindow = w }`
  )
  await sleep(800)
}

/** KDE's share dialog, from Kimochi's source menu: click where `at(dialog frame)` says. */
async function sharePortal(at, name) {
  // The main window offers "Choose a source" while nothing is.
  rig.k('source', 'clear')
  rig.js(
    `for (const w of workspace.windowList()) if (w.resourceClass == 'kimochi' && w.normalWindow) { w.minimized = false; workspace.activeWindow = w }`
  )
  await sleep(1000)
  await tap('panel.html', 'Kimochi', 'Choose a source', 'Window or screen', 'Choose New Source')
  const picker = await until("KDE's screen picker", () =>
    rig.windows().find((w) => w.caption.startsWith('Share screen'))
  )
  await sleep(1500)
  const file = join(out, `picker-${name}.png`)
  const point = at(picker.frame, file)
  if (!point) throw new Error(`${name} is not in KDE's picker (${file})`)
  for (let i = 0; i < 3 && rig.windows().some((w) => w.caption.startsWith('Share screen')); i++) {
    rig.input('move', ...point.map(Math.round), 'sleep', 300, 'click')
    await sleep(1500)
  }
}
// The dialog's cards, from its top-left (Plasma 6: one card per screen, then the full workspace,
// a virtual screen and a region; windows below).
const card = (dx, dy) => (f, file) => {
  rig.shot(file)
  return [f.x + dx, f.y + dy]
}
const SCREEN_CARD = [card(185, 300), card(532, 300)]
const WORKSPACE_CARD = card(185, 430)
const VIRTUAL_CARD = card(530, 430)
// KWin's workspace screenshot is at the highest output scale: `--find` works in its pixels.
const shotScale = () => Math.max(...screens().map((o) => o.scale || 1))
const GAME_CARD = (f, file) => {
  const k = shotScale()
  const found = rig
    .sh('shot', file, '--find', 0x1d, 0x23, 0x33, ...[f.x, f.y, f.width, f.height].map((v) => Math.round(v * k)))
    .match(/find \((\d+), (\d+)\)/)
  return found && [Number(found[1]) / k, Number(found[2]) / k]
}
let lastSource = null
/** The source just shared: one matching `pattern` other than the one before. */
const chosen = async (pattern) => {
  const s = await until(
    'the shared source',
    () => {
      const s = rig.kjson('status').source
      return pattern.test(s?.sourceId ?? '') && s.sourceId !== lastSource && s
    },
    { timeout: 15000 }
  )
  lastSource = s.sourceId
  return s
}
const preview = async (sourceId) => invoke('source_hover_preview', { sourceId })

const lines = gameLines()
const pad = 12
const textBox = {
  x: Math.min(...lines.map((l) => l.x)) - pad,
  y: Math.min(...lines.map((l) => l.y)) - pad,
  width: Math.max(...lines.map((l) => l.x + l.width)) - Math.min(...lines.map((l) => l.x)) + 2 * pad,
  height: Math.max(...lines.map((l) => l.y + l.height)) - Math.min(...lines.map((l) => l.y)) + 2 * pad
}
/** Crop `textBox` on a screen source at `bounds` (global), then scan and check the overlay. */
async function cropTheText(source, bounds, label, { on = second.geometry, open = true } = {}) {
  const saved = open ? await drawCrop(textBox, { on, label }) : await dragAndSave(textBox, { label })
  shot(`${label.replace(/\W+/g, '-')}-cropped`)
  if (!saved) return
  const crop = await currentCrop()
  const region = crop && cropOnScreen(crop, bounds)
  check(
    `${label}: the saved crop is the box drawn, in the screen's own pixels`,
    region && sameRect(region, textBox, 3),
    { region, drawn: textBox, crop }
  )
  const text = scan()
  check(`${label}: the scan reads the cropped text`, /今日は/.test(text), text.replace(/\n/g, ' / '))
  await until('overlay boxes', async () => (await boxes()).length > 0, { timeout: 10000 }).catch(() => {})
  check(`${label}: the overlay is on the second output after the scan`, sameRect(overlay(), second.geometry), overlay())
  await boxesOnText(label, textBox)
  shot(`${label.replace(/\W+/g, '-')}-text`)
  await invoke('commit_source', { sourceId: source.sourceId, crop: null, keepCrop: false })
  check(`${label}: Clear OCR crop area clears it`, (await currentCrop()) === null, await currentCrop())
}

if (only !== 'window') {
  // ---- 1. The second screen, shared on its own
  if (portal) {
    await sharePortal(SCREEN_CARD[1], 'second-screen')
  } else {
    const listed = rig.kjson('source', 'list')
    const sources = Array.isArray(listed) ? listed : (listed.sources ?? [])
    const screen = sources.find((s) => (s.kind ?? s.type) === 'display' && sameRect(s.bounds, second.geometry, 2))
    check(
      'the second output is a source',
      screen,
      sources.map((s) => [s.kind, s.name, s.bounds])
    )
    if (screen) rig.k('source', 'set', screen.sourceId ?? screen.id)
  }
  const screen2 = await chosen(/:display:/)
  check(
    'the second screen is where the source says',
    sameRect((await preview(screen2.sourceId)).sourceBounds, second.geometry),
    (await preview(screen2.sourceId)).sourceBounds
  )
  await keepOutOfTheWay()
  rig.input('move', first.geometry.x + 300, first.geometry.y + 300) // the pointer on the primary
  await cropTheText(screen2, second.geometry, 'second screen')

  if (portal) {
    // ---- 2. The full workspace: both outputs in one stream
    await sharePortal(WORKSPACE_CARD, 'workspace')
    const workspace = await chosen(/^portal:display:/)
    const bounds = (await preview(workspace.sourceId)).sourceBounds
    const union = {
      x: first.geometry.x,
      y: 0,
      width: second.geometry.x + second.geometry.width - first.geometry.x,
      height: Math.max(first.geometry.height, second.geometry.height)
    }
    check('the workspace stream covers both outputs', sameRect(bounds, union, 2), { bounds, union })
    await keepOutOfTheWay()
    rig.input('move', first.geometry.x + 400, first.geometry.y + 400)
    await sleep(300)
    if (await openEditor({ on: first.geometry, label: 'the output under the pointer (workspace)' })) {
      // Over to the second output, where the game is: the editor follows while nothing is drawn.
      rig.input(
        'move',
        second.geometry.x + 200,
        second.geometry.y + 500,
        'sleep',
        100,
        'move',
        second.geometry.x + 260,
        second.geometry.y + 520
      )
      const followed = await until(
        'the editor on the second output',
        () => sameRect(overlay(), second.geometry) && overlay(),
        { timeout: 5000 }
      ).catch(() => null)
      check('the workspace editor follows the pointer to the other output', followed, overlay())
      if (followed) await cropTheText(workspace, bounds ?? union, 'workspace', { open: false })
    }

    // ---- 3. A virtual screen: an output on no monitor, edited as its picture
    await sharePortal(VIRTUAL_CARD, 'virtual')
    const virtual = await chosen(/^portal:display:/)
    const frame = await preview(virtual.sourceId)
    check('a virtual screen has no place on the desktop', !frame.sourceBounds, frame.sourceBounds)
    await keepOutOfTheWay()
    const from = evidenceCount()
    const editor = await openEditor({ label: 'the virtual screen (as its picture)' })
    if (editor) {
      const picture = await until(
        'the picture',
        () =>
          evaluate(
            'overlay.html',
            `(() => { const i = document.querySelector('[data-kimochi-region-select] img'); if (!i) return null; const r = i.getBoundingClientRect(); return r.width > 0 && { x: r.x, y: r.y, width: r.width, height: r.height } })()`
          ),
        { timeout: 8000 }
      ).catch(() => null)
      check(
        "the virtual screen's editor shows its picture",
        picture && newEvidence(from, 'region-edit-screen-picture').length,
        picture
      )
      if (picture) {
        const box = {
          x: editor.x + picture.x + picture.width * 0.25,
          y: editor.y + picture.y + picture.height * 0.25,
          width: picture.width / 2,
          height: picture.height / 2
        }
        const saved = await dragAndSave(box, { label: "the virtual screen's picture" })
        const crop = await currentCrop()
        check(
          "the virtual screen's crop is in its own pixels",
          saved && crop?.reference_width === frame.width && Math.abs(crop.x / frame.width - 0.25) < 0.02,
          { crop, frame: [frame.width, frame.height] }
        )
      }
    }
  }
}

if (only !== 'screens') {
  // ---- 4. A window: a second crop replaces the first, Clear clears it
  if (portal) {
    await sharePortal(GAME_CARD, 'window')
  } else {
    rig.k('source', 'set', 'Rig Game')
  }
  const shared = await chosen(/:window:/)
  await keepOutOfTheWay()
  scan()
  if (portal) {
    await until(
      'the window link',
      async () =>
        (await invoke('linux_window_geometry', { operation: 'status', sourceId: shared.sourceId, windowAddress: null }))
          .linked
    )
    const named = await until(
      'the source named after the window',
      () => rig.kjson('status').source?.name === 'Rig Game',
      { timeout: 8000 }
    ).catch(() => null)
    check('the linked stream is named after its window', named)
  }
  const w = game()
  const top = { x: w.client.x + 40, y: w.client.y + 30, width: 300, height: 120 }
  const bottom = { x: w.client.x + 200, y: w.client.y + 260, width: 420, height: 160 }
  const crops = []
  for (const [i, box] of [top, bottom].entries()) {
    await drawCrop(box, { on: second.geometry, label: `the window (crop ${i + 1})`, button: 'Save' })
    await sleep(500)
    scan() // refreshes a linked stream's identity, as Auto OCR would
    crops.push(await currentCrop())
  }
  const reference = crops[1] && { width: crops[1].reference_width, height: crops[1].reference_height }
  const within = (crop, box) =>
    crop &&
    reference &&
    Math.abs(crop.width / reference.width - box.width / w.frame.width) < 0.05 &&
    Math.abs(crop.height / reference.height - box.height / w.frame.height) < 0.05
  check('the first window crop is the box drawn', within(crops[0], top), crops[0])
  check('a second window crop replaces the first', within(crops[1], bottom), crops[1])
  await invoke('commit_source', { sourceId: shared.sourceId, crop: null, keepCrop: false })
  scan()
  check(
    "Clear OCR crop area clears the window's crop (and it stays cleared)",
    (await currentCrop()) === null,
    await currentCrop()
  )
  shot('window-cleared')
}

writeFileSync(join(out, 'results.json'), JSON.stringify({ portal, scale2, results }, null, 1))
console.log(`\n${failed ? 'FAILED' : 'ALL PASSED'}  screenshots and results: ${out}`)
process.exit(failed ? 1 : 0)
