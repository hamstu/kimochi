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
  buttonName,
  stickDirection
} from '../ui/controller-input.js'
import {
  WordCursor,
  characterUnits,
  segmentText,
  tokensFromParse,
  tokensFromSegmenter,
  readingUnits,
  dominantVertical,
  segmentAcross
} from '../ui/word-nav.js'
import { itemAt, itemFor } from '../ui/radial-menu.js'
import { scrollSpeed, pointerSpeed, characterAt } from '../ui/controller.js'

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

test('A confirms, B cancels, Y switches word and character, X plays audio, View shows controls', () => {
  const { commands, controls } = input()
  controls.nav(pad([BUTTON.south]))
  controls.nav(pad([BUTTON.east]))
  controls.nav(pad([BUTTON.north]))
  controls.nav(pad([BUTTON.west]))
  controls.nav(pad([BUTTON.lb]))
  controls.nav(pad([BUTTON.rb]))
  controls.nav(pad([BUTTON.view]))
  assert.deepEqual(commands, [
    { type: 'confirm' },
    { type: 'cancel' },
    { type: 'unit' },
    { type: 'audio' },
    { type: 'step', delta: -1 },
    { type: 'step', delta: 1 },
    { type: 'help' }
  ])
})

test('the second Back older settings kept on Y is ignored, so Y still switches', () => {
  const { commands, controls } = input()
  controls.setButtons({ confirm: 0, back: 1, backAlt: 3, previousDefinition: 4, nextDefinition: 5 })
  controls.nav(pad([BUTTON.north]))
  assert.deepEqual(commands, [{ type: 'unit' }])
  assert.equal('backAlt' in controls.buttons, false)
})

test('buttons are named the way the Deck and an Xbox pad print them', () => {
  assert.equal(buttonName(BUTTON.south), 'A')
  assert.equal(buttonName(BUTTON.west), 'X')
  assert.equal(buttonName(BUTTON.view), 'View')
  assert.equal(buttonName(null), null)
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
  controls.key({ key: 'Space', type: 'keydown' })
  controls.key({ key: ' ', type: 'keydown' })
  timers.advance(2000)
  assert.deepEqual(commands, [
    { type: 'dir', dir: 'left', source: 'key', repeat: false },
    { type: 'confirm' },
    { type: 'cancel' },
    { type: 'unit' },
    { type: 'unit' }
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

test('a stray box read the other way cannot loop the cursor: right always moves on', () => {
  // A line of dialogue, then a lone glyph from the background (as tall as it is wide, so read
  // as vertical), then the next line.
  const cursor = new WordCursor([unit('この|刀|を'), unit('ロ', true), unit('買って|行け')])
  const seen = [cursor.current.text]
  while (cursor.move('right')) seen.push(cursor.current.text)
  assert.deepEqual(seen, ['この', '刀', 'を', 'ロ', '買って', '行け'])
})

test('the scan runs in the direction most of its characters do', () => {
  assert.equal(dominantVertical([unit('この|刀|を'), unit('ロ', true)]), false)
  assert.equal(dominantVertical([unit('この|刀|を', true), unit('ロ')]), true)
})

const boxed = (text, x, y, width = 100, height = 20, vertical = false) => ({
  text,
  vertical,
  box: { x, y, width, height }
})

test('units are read by position, rows from the top and left to right', () => {
  const order = readingUnits(
    [boxed('二行目', 10, 60), boxed('右', 300, 12), boxed('一行目', 10, 10)],
    false
  ).map((u) => u.text)
  assert.deepEqual(order, ['一行目', '右', '二行目'])
})

test('vertical units are read in columns from the right, top to bottom', () => {
  const column = (text, x, y) => boxed(text, x, y, 20, 100, true)
  const order = readingUnits(
    [column('左', 10, 10), column('右下', 50, 120), column('右上', 50, 10)],
    true
  ).map((u) => u.text)
  assert.deepEqual(order, ['右上', '右下', '左'])
})

test('units with no Japanese (background read as symbols or digits) are skipped', () => {
  const order = readingUnits(
    [boxed('■■', 10, 200), boxed('88', 10, 240), boxed('買って行かんか?', 10, 10)],
    false
  ).map((u) => u.text)
  assert.deepEqual(order, ['買って行かんか?'])
})

test('without a dictionary, kanji keep the kana of their inflection', () => {
  const words = (text) => tokensFromSegmenter(text).filter((t) => t.word).map((t) => t.text)
  assert.deepEqual(words('作った剣でも'), ['作った', '剣でも'])
  assert.deepEqual(words('食べさせられた'), ['食べさせられた'])
  assert.deepEqual(words('刀の'), ['刀', 'の'])
})

test('a word OCR split across two boxes is one stop, starting in the first', async () => {
  // Boxes 「この刀かじポッシュの作 and った剣でも: the verb spans them.
  const split = async (text) => tokensFromSegmenter(text)
  const units = await segmentAcross([{ text: 'ポッシュの作' }, { text: 'った剣でも' }], split)
  const cursor = new WordCursor(units.map((u) => ({ ...u, vertical: false })))
  const seen = [cursor.current]
  while (cursor.step(1)) seen.push(cursor.current)
  assert.deepEqual(
    seen.map((w) => [w.unit, w.start, w.end]),
    [
      [0, 0, 4], // ポッシュ
      [0, 4, 5], // の
      [0, 5, 8], // 作った, running two characters into the next box
      [1, 2, 5] // 剣でも
    ]
  )
})

test('fitting a word to a shorter match makes the rest the next stop', () => {
  const cursor = new WordCursor([unit('刀|剣でも|買う')])
  cursor.step(1)
  assert.equal(cursor.fit(1), true) // the dictionary matched 剣
  assert.equal(cursor.current.text, '剣')
  const seen = []
  while (cursor.step(1)) seen.push(cursor.current.text)
  assert.deepEqual(seen, ['でも', '買う'])
})

test('fitting a word to a longer match drops the stops it covers, into the next box too', () => {
  const cursor = new WordCursor([unit('思い|返'), unit('せば|今')])
  assert.equal(cursor.fit(5), true) // 思い返せば
  assert.equal(cursor.current.end, 5)
  const seen = []
  while (cursor.step(1)) seen.push(cursor.current.text)
  assert.deepEqual(seen, ['今'])
  // A match the same length as the word changes nothing.
  assert.equal(cursor.fit(1), false)
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
  controls.setButtons({ confirm: BUTTON.west, toggleUnit: null, playAudio: BUTTON.rt, nextDefinition: BUTTON.south })
  controls.nav(pad([BUTTON.west]))
  controls.nav(pad([BUTTON.north]))
  controls.nav(pad([BUTTON.south]))
  controls.nav(pad([BUTTON.east]))
  controls.nav(pad([BUTTON.rt]))
  assert.deepEqual(commands, [
    { type: 'confirm' },
    { type: 'step', delta: 1 },
    { type: 'cancel' },
    { type: 'audio' }
  ])
})

// --- by character, and the free cursor -------------------------------------------

const box = (text, tokens, extra = {}) => ({ text, vertical: false, tokens, ...extra })

test('by character, every letter is a stop and punctuation is not', () => {
  const [unit] = characterUnits([box('猫、が。', [])])
  assert.deepEqual(
    unit.tokens.map((token) => [token.text, token.word]),
    [['猫', true], ['、', false], ['が', true], ['。', false]]
  )
  const cursor = new WordCursor(characterUnits([box('食べた', []), box('猫', [])]))
  assert.deepEqual(cursor.words.map((word) => word.text), ['食', 'べ', 'た', '猫'])
})

test('characters reach what the dictionary left as gaps between words', () => {
  // 〇〇 matched nothing: no word stop there, but each character is one.
  const tokens = [
    { start: 0, end: 2, text: '〇〇', word: false },
    { start: 2, end: 4, text: '食べ', word: true }
  ]
  const words = new WordCursor([box('〇〇食べ', tokens)])
  const characters = new WordCursor(characterUnits([box('〇〇食べ', tokens)]))
  assert.equal(words.words.length, 1)
  assert.equal(characters.words.length, 4)
})

test('switching between word and character steps keeps the place', () => {
  const tokens = [
    { start: 0, end: 3, text: '食べた', word: true },
    { start: 3, end: 4, text: 'の', word: true },
    { start: 4, end: 5, text: '猫', word: true }
  ]
  const words = new WordCursor([box('食べたの猫', tokens)])
  const characters = new WordCursor(characterUnits([box('食べたの猫', tokens)]))
  // From a character inside a word, to that word.
  characters.index = 2
  assert.equal(words.seek(0, characters.current.start), true)
  assert.equal(words.current.text, '食べた')
  // From a word, to its first character.
  words.index = 2
  characters.seek(0, words.current.start)
  assert.equal(characters.current.text, '猫')
})

test('seeking a place with no stop lands on the stop before it, else the first after', () => {
  const units = [
    box('「猫」', [{ start: 1, end: 2, text: '猫', word: true }]),
    box('犬', [{ start: 0, end: 1, text: '犬', word: true }])
  ]
  const cursor = new WordCursor(units)
  cursor.seek(0, 2) // 」
  assert.equal(cursor.current.text, '猫')
  cursor.index = 1
  cursor.seek(0, 0) // 「, before any stop
  assert.equal(cursor.current.text, '猫')
  assert.equal(new WordCursor([]).seek(0, 0), false)
})

test('the free cursor creeps with a light push and crosses the screen at full tilt', () => {
  assert.equal(pointerSpeed(0), 0)
  assert.equal(pointerSpeed(0.2), 0)
  const light = pointerSpeed(0.3)
  const full = pointerSpeed(1)
  assert.ok(light > 100 && light < 200, `light push ${light}`)
  assert.ok(full >= 1400, `full push ${full}`)
  assert.ok(pointerSpeed(0.6) < full / 2)
})

test('the free cursor is on the character under it, or one close by, and nothing far away', () => {
  const rect = (left, top) => ({ left, top, width: 20, height: 20 })
  const targets = [[rect(0, 0)], [rect(20, 0)], [rect(100, 0), rect(0, 40)]]
  assert.equal(characterAt(targets, 25, 10, 14), 1)
  assert.equal(characterAt(targets, 10, 55, 14), 2, 'a character drawn on two lines counts on both')
  assert.equal(characterAt(targets, 52, 10, 14), 1, 'just past the last character')
  assert.equal(characterAt(targets, 70, 10, 14), -1)
  assert.equal(characterAt([], 0, 0, 14), -1)
})
