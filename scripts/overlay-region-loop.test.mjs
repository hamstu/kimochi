import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { parse, topLevelFunctions, text } from './source-ast.mjs'
import { load } from './load.mjs'

const { ReadingHold } = await load('reading-hold.ts')
const source = await readFile(new URL('../ui/overlay.js', import.meta.url), 'utf8')
const program = parse('overlay.js', source)
const functions = topLevelFunctions(program)
const names = ['syncHints', 'syncReadingHold', 'hitRects', 'publishRegions', 'startRegionLoop']
const bindings = new Set(['publishing', 'republish', 'publishedSignature', 'publishedAt', 'REPUBLISH_MS'])
const code = [
  ...program.body.filter(
    (n) => n.type === 'VariableDeclaration' && n.declarations.some((d) => bindings.has(d.id.name))
  ),
  ...names.map((name) => {
    assert.ok(functions.has(name), `overlay declares ${name}`)
    return functions.get(name)
  })
]
  .map((node) => text(source, node))
  .join('\n')

/** Run the real region-loop functions; only their DOM/native dependencies are substituted. */
function fixture() {
  let tick
  let samples = 0
  let now = 0
  let rects = [{ x: 10, y: 20, width: 60, height: 24, focus: false, shift: true }]
  const sent = [],
    hints = [],
    holds = [],
    errors = []
  const context = vm.createContext({
    state: { origin: { x: -800, y: 100, width: 800, height: 600 }, flags: { overlayVisible: true } },
    renderer: {
      mouse: { x: 15, y: 25 },
      hitRects(origin) {
        samples++
        return origin ? rects.map((r) => ({ ...r, x: origin.x + r.x, y: origin.y + r.y })) : []
      },
      clearPointer() {}
    },
    native: {
      getSetting: () => undefined,
      setRegions: async (value) => {
        sent.push(value)
      }
    },
    hints: { sync: (shown) => hints.push(shown), place() {}, rects: () => [] },
    reading: new ReadingHold(),
    readingHold: false,
    syncScanHold: () => holds.push(context.readingHold),
    overlayTextOn: () => true,
    refreshLayerPointer() {},
    shiftGated: true,
    waylandDisabled: false,
    gnomeOverlay: null,
    layerPointerExit: null,
    remoteReadingPopup: false,
    apiReadingPopup: false,
    extensionPopupRect: null,
    livePopups: new Set(),
    controller: { mode: 'idle', hitRects: () => [] },
    hook: { card: { rects: () => [], dragging: () => false } },
    HINTS_DISMISSED: 'overlayHintsDismissed',
    clickThrough: () => true,
    hoverLookup: () => false,
    hintArea: () => null,
    document: { querySelectorAll: () => [] },
    popupRects: () => [],
    popupShown: () => false,
    innerWidth: 800,
    innerHeight: 600,
    performance: { now: () => now },
    setInterval(fn, ms) {
      assert.equal(ms, 100)
      tick = fn
    },
    log: (record) => {
      if (record.error) errors.push(record)
    }
  })
  vm.runInContext(code, context)
  context.startRegionLoop()
  return {
    context,
    sent,
    hints,
    holds,
    errors,
    tick: () => tick(),
    samples: () => samples,
    rects: (value) => {
      rects = value
    },
    time: (value) => {
      now = value
    }
  }
}
const plain = (value) => JSON.parse(JSON.stringify(value))
const settled = () => new Promise((resolve) => setImmediate(resolve))

test('one idle tick samples words once for holds, hints and native regions with desktop translation', async () => {
  const f = fixture()
  f.tick()
  await settled()
  assert.equal(f.samples(), 1)
  assert.deepEqual(f.holds, [true], 'reading uses local coordinates, not the negative desktop origin')
  assert.deepEqual(f.hints, [true])
  assert.deepEqual(plain(f.sent), [[{ x: -790, y: 120, width: 60, height: 24, focus: false, shift: true }]])
  // Nothing is retained across ticks: a hidden/replaced word must lose its native click target.
  f.rects([])
  f.context.renderer.mouse = { x: 200, y: 200 }
  f.tick()
  await settled()
  assert.equal(f.samples(), 2)
  assert.deepEqual(f.holds, [true, false])
  assert.deepEqual(f.hints, [true, false])
  assert.deepEqual(plain(f.sent.at(-1)), [])
  assert.deepEqual(f.errors, [])
})

test('polling still refreshes geometry every tick and renews unchanged native regions once a second', async () => {
  const f = fixture()
  for (const time of [0, 100, 200, 999, 1000]) {
    f.time(time)
    f.tick()
    await settled()
  }
  assert.equal(f.samples(), 5)
  assert.equal(f.sent.length, 2)
  assert.deepEqual(plain(f.sent[0]), plain(f.sent[1]))
})

test('a coalesced publication resamples after native acknowledges, never reusing an earlier tick', async () => {
  const f = fixture()
  let acknowledge
  f.context.native.setRegions = async (rects) => {
    f.sent.push(rects)
    if (f.sent.length === 1)
      await new Promise((resolve) => {
        acknowledge = resolve
      })
  }
  f.tick()
  f.rects([{ x: 50, y: 60, width: 10, height: 20, focus: false, shift: true }])
  f.tick()
  // It changes yet again while the first publication is awaiting native.
  f.rects([{ x: 70, y: 80, width: 30, height: 40, focus: false, shift: true }])
  acknowledge()
  await settled()
  assert.equal(f.samples(), 3, 'two ticks and one fresh read after the await')
  assert.equal(f.sent.length, 2)
  assert.equal(f.sent[1][0].x, -730)
  assert.equal(f.sent[1][0].y, 180)
  assert.deepEqual(f.errors, [])
})

test('immediate updates outside the timer keep reading live geometry and honor click-through changes', async () => {
  const f = fixture()
  f.context.syncReadingHold()
  f.context.syncHints()
  await f.context.publishRegions()
  assert.equal(f.samples(), 3)
  f.context.clickThrough = () => false
  f.context.state.origin = { x: 200, y: -100, width: 800, height: 600 }
  f.tick()
  await settled()
  assert.equal(f.sent.at(-1)[0].x, 210)
  assert.equal(f.sent.at(-1)[0].y, -80)
  assert.equal(f.sent.at(-1)[0].shift, false)
})

test('region selection keeps the whole display interactive; failed publications retry current geometry', async () => {
  const f = fixture()
  f.context.state.regionSelecting = true
  let fail = true
  f.context.native.setRegions = async (rects) => {
    if (fail) throw Error('native temporarily unavailable')
    f.sent.push(rects)
  }
  f.tick()
  await settled()
  assert.equal(f.errors.length, 1)
  fail = false
  f.tick()
  await settled()
  assert.deepEqual(plain(f.sent), [[{ ...f.context.state.origin, focus: false }]])
  assert.deepEqual(f.hints, [false, false])
  assert.equal(f.samples(), 0, 'region selection needs no word geometry')
})

test('a lazy sample preserves zero word reads when all consumers are inactive', async () => {
  for (const scenario of ['no-origin', 'wayland-disabled', 'card-drag']) {
    const f = fixture()
    // Reading holds are disabled while text is off. Other consumers have their own guards.
    f.context.overlayTextOn = () => false
    if (scenario === 'no-origin') f.context.state.origin = null
    if (scenario === 'wayland-disabled') {
      f.context.waylandDisabled = true
      f.context.shiftGated = false
    }
    if (scenario === 'card-drag') {
      f.context.native.getSetting = () => true // Hints dismissed.
      f.context.hook.card.dragging = () => true
    }
    f.tick()
    await settled()
    assert.equal(f.samples(), 0, scenario)
    assert.deepEqual(f.errors, [], scenario)
  }
})

test('clearing a departed layer pointer happens before the shared geometry sample', async () => {
  const f = fixture()
  const order = []
  f.context.window = {}
  f.context.layerPointerExit = { outside: () => true }
  f.context.renderer.clearPointer = () => {
    order.push('clear-pointer')
    f.context.renderer.mouse = { x: -100000, y: -100000 }
  }
  const sample = f.context.renderer.hitRects
  f.context.renderer.hitRects = (origin) => {
    order.push('sample')
    return sample(origin)
  }
  f.tick()
  await settled()
  assert.deepEqual(order, ['clear-pointer', 'sample'])
  assert.equal(f.context.readingHold, false)
  assert.equal(f.sent[0][0].x, -790, 'clearing the pointer does not move a text box')
})

test('hints and popup geometry are read after synchronization, separately from the shared word sample', async () => {
  const f = fixture()
  let hint = null
  f.context.hints.place = () => {
    hint = { x: 100, y: 200, width: 26, height: 26 }
  }
  f.context.hints.rects = () => (hint ? [hint] : [])
  const popup = { x: -600, y: 150, width: 200, height: 100, focus: true }
  f.context.popupRects = () => [popup]
  f.tick()
  await settled()
  assert.equal(f.samples(), 1)
  assert.deepEqual(plain(f.sent[0].slice(1)), [
    popup,
    { x: -700, y: 300, width: 26, height: 26, focus: false, shift: false }
  ])
})
