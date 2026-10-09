/**
 * Controller mode's pure parts: turning controller and key input into commands, splitting a
 * scan into words, stepping a cursor through them, and which menu item a stick or D-pad names.
 * The menu's look and the focus hand-off need the real app; these are what can quietly go wrong.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ControllerInput,
  BUTTON,
  REPEAT_DELAY_MS,
  REPEAT_RATE_MS,
  stickDirection
} from '../ui/controller-input.js'
import {
  WordCursor,
  segmentText,
  tokensFromParse,
  tokensFromSegmenter
} from '../ui/word-nav.js'
import { itemAt, itemFor } from '../ui/radial-menu.js'
import { scrollSpeed } from '../ui/controller.js'

/** Timers that only fire when the test says so. */
function manualTimers() {
  let now = 0
  let next = 1
  const pending = new Map()
  return {
    setTimeout: (fn, delay) => {
      pending.set(next, { fn, at: now + delay })
      return next++
    },
    clearTimeout: (id) => pending.delete(id),
    advance(ms) {
      const until = now + ms
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        pending.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = until
    }
  }
}

function input() {
  const commands = []
  const timers = manualTimers()
  const controls = new ControllerInput((command) => commands.push(command), timers)
  return { commands, timers, controls }
}

const pad = (pressed = [], held = pressed, extra = {}) => ({
  pressed,
  released: [],
  held,
  stick: { x: 0, y: 0 },
  rstick: { x: 0, y: 0 },
  ...extra
})

test('south confirms, east and north cancel, shoulders step', () => {
  const { commands, controls } = input()
  controls.nav(pad([BUTTON.south]))
  controls.nav(pad([BUTTON.east]))
  controls.nav(pad([BUTTON.north]))
  controls.nav(pad([BUTTON.lb]))
  controls.nav(pad([BUTTON.rb]))
  assert.deepEqual(commands, [
    { type: 'confirm' },
    { type: 'cancel' },
    { type: 'cancel' },
    { type: 'step', delta: -1 },
    { type: 'step', delta: 1 }
  ])
})

test('a held D-pad direction repeats after a pause, and stops when released', () => {
  const { commands, timers, controls } = input()
  controls.nav(pad([BUTTON.right]))
  assert.deepEqual(commands, [{ type: 'dir', dir: 'right', source: 'dpad', repeat: false }])
  timers.advance(REPEAT_DELAY_MS - 1)
  assert.equal(commands.length, 1)
  timers.advance(1 + REPEAT_RATE_MS * 2)
  assert.equal(commands.length, 4)
  assert.ok(commands.slice(1).every((command) => command.repeat && command.dir === 'right'))
  controls.nav({ ...pad([], []), released: [BUTTON.right] })
  timers.advance(REPEAT_RATE_MS * 5)
  assert.equal(commands.length, 4)
})

test('the stick aims every move, but only steps once it leans far enough', () => {
  const { commands, controls } = input()
  controls.nav(pad([], [], { stick: { x: 0.3, y: 0 } }))
  assert.deepEqual(commands, [{ type: 'aim', x: 0.3, y: 0 }])
  controls.nav(pad([], [], { stick: { x: 0.8, y: 0.1 } }))
  assert.deepEqual(commands.at(-1), { type: 'dir', dir: 'right', source: 'stick', repeat: false })
  // Hysteresis: easing back to 0.5 still counts as leaning; no new step.
  const count = commands.length
  controls.nav(pad([], [], { stick: { x: 0.5, y: 0 } }))
  assert.equal(commands.filter((c) => c.type === 'dir').length, 1)
  assert.equal(commands.length, count + 1)
  controls.nav(pad([], [], { stick: { x: 0, y: 0 } }))
  controls.nav(pad([], [], { stick: { x: 0, y: -0.9 } }))
  assert.deepEqual(commands.at(-1), { type: 'dir', dir: 'down', source: 'stick', repeat: false })
})

test('stick directions follow the dominant axis, with y up', () => {
  assert.equal(stickDirection({ x: 0, y: 0.9 }), 'up')
  assert.equal(stickDirection({ x: -0.9, y: 0.2 }), 'left')
  assert.equal(stickDirection({ x: 0.2, y: 0.3 }), null)
})

test('the menu combination closes the menu instead of acting as its buttons', () => {
  const { commands, controls } = input()
  controls.setMenuChord([10, 11])
  controls.nav(pad([10], [10]))
  assert.deepEqual(commands, [])
  controls.nav(pad([11], [10, 11]))
  assert.deepEqual(commands, [{ type: 'menu' }])
})

test('a single-button menu binding closes the menu on its own', () => {
  const { commands, controls } = input()
  controls.setMenuChord([BUTTON.south])
  controls.nav(pad([BUTTON.south]))
  assert.deepEqual(commands, [{ type: 'menu' }])
})

test('keys: arrows step once per press, Return confirms, Escape cancels', () => {
  const { commands, timers, controls } = input()
  controls.key({ key: 'ArrowLeft', type: 'keydown' })
  controls.key({ key: 'ArrowLeft', type: 'keyup' })
  controls.key({ key: 'Enter', type: 'keydown' })
  controls.key({ key: 'Escape', type: 'keydown' })
  timers.advance(2000)
  assert.deepEqual(commands, [
    { type: 'dir', dir: 'left', source: 'key', repeat: false },
    { type: 'confirm' },
    { type: 'cancel' }
  ])
})

test('reset stops a repeat from leaking into the next mode', () => {
  const { commands, timers, controls } = input()
  controls.nav(pad([BUTTON.down]))
  controls.reset()
  timers.advance(5000)
  assert.equal(commands.length, 1)
})

// --- words -------------------------------------------------------------------

/** A Yomitan scanning-parser result: matches carry headwords, gaps do not. */
const parsed = (...tokens) =>
  tokens.map(([text, matched]) => [matched ? { text, reading: '', headwords: [[]] } : { text, reading: '' }])

test('parser tokens keep their offsets, and only dictionary matches are words', () => {
  const text = '「今日は、いい天気」'
  const tokens = tokensFromParse(
    text,
    parsed(['「', false], ['今日', true], ['は', true], ['、', false], ['いい', true], ['天気', true], ['」', false])
  )
  assert.deepEqual(
    tokens.map((token) => [token.text, token.start, token.word]),
    [
      ['「', 0, false],
      ['今日', 1, true],
      ['は', 3, true],
      ['、', 4, false],
      ['いい', 5, true],
      ['天気', 7, true],
      ['」', 9, false]
    ]
  )
})

test('a parse that matches nothing in Japanese falls back to the segmenter', async () => {
  const text = '今日はいい天気'
  const tokens = await segmentText(text, async () => [
    { source: 'scanning-parser', content: parsed([text, false]) }
  ])
  assert.ok(tokens.filter((token) => token.word).length > 1)
  assert.equal(tokens.map((token) => token.text).join(''), text)
})

test('a failing parser falls back rather than leaving nothing to step through', async () => {
  const tokens = await segmentText('天気', async () => {
    throw Error('not ready')
  })
  assert.equal(tokens.map((token) => token.text).join(''), '天気')
})

test('without any segmenter every character is still reachable', () => {
  const tokens = tokensFromSegmenter('あ。', null)
  assert.deepEqual(
    tokens.map((token) => [token.text, token.word]),
    [
      ['あ', true],
      ['。', false]
    ]
  )
})

/** A unit whose tokens are its words separated by `|`, with `.` for punctuation. */
function unit(spec, vertical = false) {
  const tokens = []
  let text = ''
  for (const line of spec.split('\n')) {
    if (text) text += '\n'
    for (const piece of line.split('|')) {
      tokens.push({ start: text.length, end: text.length + piece.length, text: piece, word: piece !== '.' })
      text += piece
    }
  }
  return { text, vertical, tokens }
}

test('the cursor steps across boxes and stops at the ends', () => {
  const cursor = new WordCursor([unit('今日|は|.'), unit('天気|だ')])
  assert.equal(cursor.current.text, '今日')
  assert.equal(cursor.step(-1), false)
  const seen = [cursor.current.text]
  while (cursor.step(1)) seen.push(cursor.current.text)
  assert.deepEqual(seen, ['今日', 'は', '天気', 'だ'])
  assert.equal(cursor.step(1), false)
})

test('line moves keep the place along the line, skipping lines with no words', () => {
  const cursor = new WordCursor([unit('あい|うえ|おか\n.\nきく|けこ|さし')])
  cursor.step(2) // おか, column 4
  assert.equal(cursor.current.text, 'おか')
  assert.equal(cursor.line(1), true)
  assert.equal(cursor.current.text, 'さし')
  assert.equal(cursor.line(-1), true)
  assert.equal(cursor.current.text, 'おか')
  assert.equal(cursor.line(-1), false)
})

test('directions follow the text: across and down for horizontal, down and left for vertical', () => {
  const horizontal = new WordCursor([unit('あ|い\nう|え')])
  horizontal.move('right')
  assert.equal(horizontal.current.text, 'い')
  horizontal.move('down')
  assert.equal(horizontal.current.text, 'え')

  const vertical = new WordCursor([unit('あ|い\nう|え', true)])
  vertical.move('down')
  assert.equal(vertical.current.text, 'い')
  // The next column of vertical Japanese is to the left.
  vertical.move('left')
  assert.equal(vertical.current.text, 'え')
  vertical.move('right')
  assert.equal(vertical.current.text, 'い')
})

test('a scan with no words leaves the cursor empty', () => {
  const cursor = new WordCursor([unit('.')])
  assert.equal(cursor.current, null)
  assert.equal(cursor.move('right'), false)
})

// --- menu ----------------------------------------------------------------------

test('the stick points at items clockwise from the top', () => {
  assert.equal(itemAt(0, 1, 4), 0)
  assert.equal(itemAt(1, 0, 4), 1)
  assert.equal(itemAt(0, -1, 4), 2)
  assert.equal(itemAt(-1, 0, 4), 3)
  assert.equal(itemAt(0.7, 0.72, 4), 0)
  assert.equal(itemAt(0.2, 0.2, 4), -1)
})

test('the item pointed at holds a little past its edge, so a boundary cannot flicker', () => {
  const at = (degrees, current) => {
    const radians = (degrees * Math.PI) / 180
    return itemAt(Math.sin(radians), Math.cos(radians), 4, current)
  }
  // Top and right meet at 45°.
  assert.equal(at(47, -1), 1)
  assert.equal(at(47, 0), 0)
  assert.equal(at(53, 0), 1)
  // Across the wrap at the top, too.
  assert.equal(at(318, 0), 0)
  assert.equal(at(308, 0), 3)
  // Pointing well into another item always takes it.
  assert.equal(at(180, 0), 2)
})

test('a D-pad direction names the item nearest it', () => {
  assert.equal(itemFor('left', 4, 0), 3)
  assert.equal(itemFor('down', 4, -1), 2)
  // Three items: Scan at the top, Dictionary lower right, Auto OCR lower left.
  assert.equal(itemFor('up', 3, -1), 0)
  assert.equal(itemFor('right', 3, -1), 1)
  assert.equal(itemFor('left', 3, -1), 2)
  assert.equal(itemFor('down', 3, 0), 1)
})

test('right-stick scrolling creeps with a light push and races at full tilt', () => {
  assert.equal(scrollSpeed(0), 0)
  assert.equal(scrollSpeed(0.2), 0)
  const light = scrollSpeed(0.35)
  const full = scrollSpeed(1)
  assert.ok(light > 0 && light < 150, `light push ${light}`)
  assert.ok(full > 2000, `full push ${full}`)
  assert.equal(scrollSpeed(-1), -full)
  assert.ok(scrollSpeed(0.6) < full / 2, 'the curve keeps most of its range for the far end')
})

test('command buttons follow the settings, and an unbound one does nothing', () => {
  const { commands, controls } = input()
  controls.setButtons({ confirm: BUTTON.west, backAlt: null, nextDefinition: BUTTON.south })
  controls.nav(pad([BUTTON.west]))
  controls.nav(pad([BUTTON.north]))
  controls.nav(pad([BUTTON.south]))
  controls.nav(pad([BUTTON.east]))
  assert.deepEqual(commands, [
    { type: 'confirm' },
    { type: 'step', delta: 1 },
    { type: 'cancel' }
  ])
})
