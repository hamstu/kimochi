/**
 * #257: one press of the controller's previous/next definition button (L1/R1) moves the dictionary
 * popup exactly one entry, never more, and holding it does not repeat.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ControllerInput, BUTTON, REPEAT_DELAY_MS } from '../ui/controller-input.js'
import { ENTRY_MARGIN, entryHotkeyCount, entryStepTarget, hotkeyKeydown, singleEntryHotkey } from '../ui/entry-step.js'

/** Yomitan's default popup entry hotkeys, in its own order (options-util.js, schema defaults). */
const YOMITAN_DEFAULTS = [
  {
    action: 'previousEntry',
    argument: '3',
    key: 'PageUp',
    modifiers: ['alt'],
    scopes: ['popup', 'search'],
    enabled: true
  },
  {
    action: 'nextEntry',
    argument: '3',
    key: 'PageDown',
    modifiers: ['alt'],
    scopes: ['popup', 'search'],
    enabled: true
  },
  { action: 'lastEntry', argument: '', key: 'End', modifiers: ['alt'], scopes: ['popup', 'search'], enabled: true },
  { action: 'firstEntry', argument: '', key: 'Home', modifiers: ['alt'], scopes: ['popup', 'search'], enabled: true },
  {
    action: 'previousEntry',
    argument: '1',
    key: 'ArrowUp',
    modifiers: ['alt'],
    scopes: ['popup', 'search'],
    enabled: true
  },
  {
    action: 'nextEntry',
    argument: '1',
    key: 'ArrowDown',
    modifiers: ['alt'],
    scopes: ['popup', 'search'],
    enabled: true
  }
]

test("Yomitan's defaults: the one-entry Alt+↓ / Alt+↑, never Alt+PageDown's three (listed first)", () => {
  assert.deepEqual(singleEntryHotkey(YOMITAN_DEFAULTS, 1), { key: 'ArrowDown', modifiers: ['alt'] })
  assert.deepEqual(singleEntryHotkey(YOMITAN_DEFAULTS, -1), { key: 'ArrowUp', modifiers: ['alt'] })
})

test('the argument is read as Yomitan reads it', () => {
  assert.equal(entryHotkeyCount('1'), 1)
  assert.equal(entryHotkeyCount(1), 1)
  assert.equal(entryHotkeyCount('3'), 3)
  // Yomitan: a string that is not a number moves one; a missing argument moves none.
  assert.equal(entryHotkeyCount(''), 1)
  assert.equal(entryHotkeyCount('x'), 1)
  assert.equal(entryHotkeyCount(undefined), 0)
  assert.equal(entryHotkeyCount('-2'), 0)
})

test('a disabled, out-of-popup, keyless or multi-entry hotkey is skipped; none left means the fallback', () => {
  const only = (overrides) => [{ ...YOMITAN_DEFAULTS[5], ...overrides }]
  assert.equal(singleEntryHotkey(only({ enabled: false }), 1), null)
  assert.equal(singleEntryHotkey(only({ scopes: ['search'] }), 1), null)
  assert.equal(singleEntryHotkey(only({ key: null }), 1), null)
  assert.equal(singleEntryHotkey(only({ argument: '2' }), 1), null)
  assert.equal(singleEntryHotkey(only({ argument: undefined }), 1), null)
  assert.deepEqual(singleEntryHotkey(only({ key: 'KeyJ', modifiers: undefined }), 1), { key: 'KeyJ', modifiers: [] })
  // Only PageDown (3) bound: nothing Yomitan can do in one, so Kimochi steps the entries itself.
  assert.equal(singleEntryHotkey([YOMITAN_DEFAULTS[1]], 1), null)
  assert.equal(singleEntryHotkey(undefined, 1), null)
})

test('the keydown carries the hotkey code and its modifiers', () => {
  assert.deepEqual(hotkeyKeydown({ key: 'ArrowDown', modifiers: ['alt'] }), {
    key: 'arrowdown',
    code: 'ArrowDown',
    altKey: true,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    bubbles: true,
    cancelable: true
  })
  assert.equal(hotkeyKeydown({ key: 'KeyJ', modifiers: ['ctrl', 'shift'] }).key, 'j')
})

/** Press `step` `times` times from `from`, as the fallback does: each press from where the last landed. */
function walk(offsets, max, step, times, from = 0) {
  const landed = []
  let last = null
  for (let i = 0; i < times; i++) {
    const target = entryStepTarget({ offsets, from, max, step, last })
    if (!target) break
    landed.push(target.index)
    last = target
    from = target.to
  }
  return landed
}

test('the fallback visits every entry in turn, tall (many dictionaries, grouped) or short', () => {
  // Grouped results with many dictionaries: each entry several screens tall, in a 400pt popup.
  const tall = [0, 2400, 5100, 7300]
  assert.deepEqual(walk(tall, 7300 + 2000 - 400, 1, 10), [1, 2, 3])
  // Ungrouped, or kanji: many short entries.
  const short = Array.from({ length: 12 }, (_, i) => i * 90)
  assert.deepEqual(walk(short, 12 * 90 - 400, 1, 20), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.deepEqual(walk(short, 12 * 90 - 400, -1, 20, 12 * 90 - 400), [6, 5, 4, 3, 2, 1, 0])
})

test("an entry's top lands just below the popup's top", () => {
  assert.deepEqual(entryStepTarget({ offsets: [0, 300, 900], from: 0, max: 2000, step: 1 }), {
    index: 1,
    to: 300 - ENTRY_MARGIN
  })
  // The first entry goes all the way back to the top.
  assert.deepEqual(entryStepTarget({ offsets: [0, 300, 900], from: 294, max: 2000, step: -1 }), { index: 0, to: 0 })
})

test('near the bottom each press is still one entry: no skipping back past the one clamped short', () => {
  // A(0) B(500) C(900); the popup scrolls no further than 700, so C cannot reach the top.
  const offsets = [0, 500, 900]
  const max = 700
  const toB = entryStepTarget({ offsets, from: 0, max, step: 1 })
  assert.deepEqual(toB, { index: 1, to: 494 })
  const toC = entryStepTarget({ offsets, from: toB.to, max, step: 1, last: toB })
  assert.deepEqual(toC, { index: 2, to: max })
  // By position alone the popup at 700 is "on B", and back would skip to A. It goes to B.
  assert.deepEqual(entryStepTarget({ offsets, from: max, max, step: -1, last: toC }), { index: 1, to: 494 })
  // Past the last entry there is nowhere to go.
  assert.equal(entryStepTarget({ offsets, from: max, max, step: 1, last: toC }), null)
})

test('entries already in view at the bottom are stepped through one per press without scrolling', () => {
  // Scrolled to the bottom by hand: the last three entries are all on screen.
  const offsets = [0, 400, 700, 760, 820]
  const max = 600
  assert.deepEqual(walk(offsets, max, 1, 5, max), [2, 3, 4])
  for (const index of walk(offsets, max, 1, 5, max)) assert.ok(index <= offsets.length - 1)
})

test('a scroll by hand since the last step counts from where the popup is now', () => {
  const offsets = [0, 300, 600, 900, 1200]
  const last = { index: 1, to: 294 }
  // The right stick took the popup down to 900: next is the entry after the one at 900.
  assert.deepEqual(entryStepTarget({ offsets, from: 900, max: 2000, step: 1, last }), { index: 4, to: 1194 })
})

test('nothing to step through: no entries, no step, or already at the first', () => {
  assert.equal(entryStepTarget({ offsets: [], from: 0, max: 0, step: 1 }), null)
  assert.equal(entryStepTarget({ offsets: [0, 100], from: 0, max: 500, step: 0 }), null)
  assert.equal(entryStepTarget({ offsets: [0, 100], from: 0, max: 500, step: -1 }), null)
  // A single entry taller than the popup: back from partway down returns to its top.
  assert.deepEqual(entryStepTarget({ offsets: [0], from: 350, max: 900, step: -1 }), { index: 0, to: 0 })
  assert.equal(entryStepTarget({ offsets: [0], from: 350, max: 900, step: 1 }), null)
})

test('a larger step is still taken as one entry', () => {
  assert.deepEqual(entryStepTarget({ offsets: [0, 100, 200, 300], from: 0, max: 900, step: 3 }), {
    index: 1,
    to: 100 - ENTRY_MARGIN
  })
})

/** Timers that only fire when the test says so. */
function manualTimers() {
  const pending = new Map()
  let next = 1
  return {
    setTimeout: (fn, delay) => (pending.set(next, { fn, delay }), next++),
    clearTimeout: (id) => pending.delete(id),
    runAll(rounds = 20) {
      for (let i = 0; i < rounds && pending.size; i++) {
        for (const [id, { fn }] of [...pending]) {
          pending.delete(id)
          fn()
        }
      }
    }
  }
}

/** A native `controller-nav` tick: the edges since the last, and what is held. */
const tick = (pressed, released, held) => ({
  pressed,
  released,
  held,
  stick: { x: 0, y: 0 },
  rstick: { x: 0, y: 0 }
})

test('holding R1 steps once, however long it is held; each new press steps again', () => {
  const timers = manualTimers()
  const commands = []
  const controls = new ControllerInput((command) => commands.push(command), timers)
  const steps = () => commands.filter((command) => command.type === 'step')

  controls.nav(tick([BUTTON.rb], [], [BUTTON.rb]))
  // Held: native reports it in `held` (other buttons and the sticks still send ticks), never as a press.
  for (let i = 0; i < 30; i++) controls.nav(tick([], [], [BUTTON.rb]))
  controls.nav(tick([BUTTON.south], [], [BUTTON.rb, BUTTON.south]))
  // Well past the D-pad's repeat delay: shoulder buttons have no repeat.
  timers.runAll()
  assert.ok(REPEAT_DELAY_MS > 0)
  assert.deepEqual(steps(), [{ type: 'step', delta: 1 }])

  controls.nav(tick([], [BUTTON.rb], [BUTTON.south]))
  controls.nav(tick([BUTTON.rb], [], [BUTTON.rb]))
  controls.nav(tick([], [BUTTON.rb], []))
  controls.nav(tick([BUTTON.lb], [], [BUTTON.lb]))
  controls.nav(tick([], [], [BUTTON.lb]))
  timers.runAll()
  assert.deepEqual(steps(), [
    { type: 'step', delta: 1 },
    { type: 'step', delta: 1 },
    { type: 'step', delta: -1 }
  ])
})

test('keys never step: a key-emulated or repeating keyboard cannot move entries', () => {
  const commands = []
  const controls = new ControllerInput((command) => commands.push(command))
  for (const key of ['PageDown', 'PageUp', 'ArrowDown', 'Tab', 'j']) {
    controls.key({ type: 'keydown', key })
    controls.key({ type: 'keydown', key, repeat: true })
  }
  assert.equal(commands.filter((command) => command.type === 'step').length, 0)
})

test('both Yomitan popups pick their entry hotkey through singleEntryHotkey, not the first one listed', () => {
  for (const file of ['ui/overlay.js', 'ui/popup-host.js']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.match(source, /singleEntryHotkey\(/, file)
    assert.doesNotMatch(source, /\.action === action/, `${file} looks the hotkey up by action alone`)
  }
})
