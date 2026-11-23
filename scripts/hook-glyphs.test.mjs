import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { glyphGeometry, rowIndents, leadingSpaces } = await load('hook-glyphs.ts')

/** OCR's character boxes for `row` drawn from `start` (the first glyph's centre), `pitch` apart. */
function boxes(row, start, pitch, top, { ink = 0.7, skip = [], misread = {}, shift = 0 } = {}) {
  return [...row].flatMap((c, i) => {
    if (skip.includes(i)) return []
    const x = start + i * pitch + shift
    const half = (pitch * ink) / 2
    return [{ text: misread[i] ?? c, box: [x - half, top, x + half, top + pitch * 0.9] }]
  })
}
const near = (a, b, within = 0.5) => assert.ok(Math.abs(a - b) <= within, `${a} is not within ${within} of ${b}`)

test('a row of glyphs gives the pitch and where its first character is', () => {
  const row = 'そしてなにより、穂織の町は温泉が知られている。'
  const g = glyphGeometry([row], [[470, 900, 1400, 950]], boxes(row, 481.9, 38.9, 905))
  near(g.pitch, 38.9, 0.05)
  near(g.rows[0].start, 481.9)
  near(g.rows[0].middle, 925)
})

test("a quote's second row starts where the game starts it: under the first character after 「", () => {
  const rows = ['「あー……すみません。アタシはここいらに詳しくないんです', 'よ」']
  const pitch = 38.9
  const g = glyphGeometry(
    rows,
    [
      [470, 900, 1600, 950],
      [500, 952, 600, 1002]
    ],
    [...boxes(rows[0], 481.9, pitch, 905), ...boxes(rows[1], 481.9 + pitch, pitch, 957)]
  )
  near(g.rows[1].start - g.rows[0].start, pitch)
  near(g.rows[1].middle - g.rows[0].middle, 52)
})

test('misreads, missed characters and a box over two glyphs change nothing', () => {
  const row = '小京都とも呼ばれる、整備された街並みは、いい意味で'
  const g = glyphGeometry(
    [row],
    [[470, 900, 1600, 950]],
    [
      ...boxes(row, 481.9, 38.9, 905, { skip: [3, 4, 12], misread: { 6: '日', 9: '.' } }),
      // OCR merged two glyphs into one wide box.
      { text: 'され', box: [481.9 + 12 * 38.9 - 14, 905, 481.9 + 13 * 38.9 + 14, 940] }
    ]
  )
  near(g.pitch, 38.9, 0.1)
  near(g.rows[0].start, 481.9, 1)
})

test("a short line takes the pitch the game's long lines had", () => {
  const row = 'え、本当にそうかな？'
  // Few glyphs, and OCR a pixel or two off on each: their own slope would be off.
  const pieces = boxes(row, 500, 38.9, 905).map((p, i) => ({
    ...p,
    box: [p.box[0] + (i % 2 ? 2 : -2), p.box[1], p.box[2] + (i % 2 ? 2 : -2), p.box[3]]
  }))
  const g = glyphGeometry([row], [[480, 900, 900, 950]], pieces, 38.9)
  near(g.pitch, 38.9, 0.001)
})

test('too little or too loose a reading is no geometry', () => {
  assert.equal(glyphGeometry(['あい'], [[0, 0, 100, 40]], boxes('あい', 20, 40, 0)), null)
  const row = 'そしてなにより穂織の町は'
  const scattered = boxes(row, 100, 40, 0).map((p, i) => ({
    ...p,
    box: p.box.map((v, k) => (k % 2 ? v : v + (i % 2 ? 15 : -15)))
  }))
  assert.equal(glyphGeometry([row], [[0, 0, 600, 40]], scattered), null)
  assert.equal(glyphGeometry(['a', 'b'], [[0, 0, 1, 1]], []), null)
})

// Rows placed by OCR's row boxes (`rowIndents`): Muv-Luv Alternative's 決起の目的を… over 現実的な…
// (Ice's report), its second row a full-width space in. The game's ink of each row starts where
// OCR's row box does; the card's ink of each row starts `inkLefts` into its row.
const FONT = 30
const ROWS = ['決起の目的を達成するためには、オレ達を騙すっていう', '現実的な選択をしてもおかしくないはずだろう。']
const GAME = [100, 100 + FONT] // the second row a whole em in, as the game draws it

test('a row the game indents is indented on the card when the hooked text has no indent', () => {
  const indents = rowIndents(GAME, [1.5, 1.5], ROWS.map(leadingSpaces), 0, FONT)
  assert.deepEqual(indents, [0, FONT])
})

test('a row whose hooked text holds the indent (U+3000) is not indented twice', () => {
  const rows = [ROWS[0], `　${ROWS[1]}`]
  // The card's U+3000 inks nothing: its row's ink starts an em in, as the game's does.
  const indents = rowIndents(GAME, [1.5, FONT + 1.5], rows.map(leadingSpaces), 0, FONT)
  assert.deepEqual(indents, [0, 0])
})

test("OCR's geometry wins over the hooked text's indent when the two disagree", () => {
  // Two ASCII spaces in the hooked text (about an em on the card), the game indents two ems.
  const rows = [ROWS[0], `  ${ROWS[1]}`]
  const indents = rowIndents([100, 100 + 2 * FONT], [1.5, FONT + 1.5], rows.map(leadingSpaces), 0, FONT)
  near(indents[1], FONT)
  // And a hooked indent the game does not draw is taken back out.
  const flush = rowIndents([100, 100], [1.5, FONT + 1.5], ['a', '　b'].map(leadingSpaces), 0, FONT)
  near(flush[1], -FONT)
})

test("the card's letter-spacing moves a row's leading indent along with it", () => {
  // At 3 px of spacing the card's U+3000 is an em and 3 px wide: the row moves 3 px less.
  const indents = rowIndents([100, 100 + FONT + 3], [1.5, FONT + 1.5], [0, 1], 3, FONT)
  assert.deepEqual(indents, [0, 0])
})

test('rows OCR boxes a few pixels apart are not indented, and one row is never moved', () => {
  assert.deepEqual(rowIndents([100, 103, 98], [1.5, 1.5, 1.5], [0, 0, 0], 0, FONT), [0, 0, 0])
  assert.deepEqual(rowIndents([100], [1.5], [0], 0, FONT), [0])
})

test('more than two rows, each at its own depth', () => {
  const indents = rowIndents([100, 100 + FONT, 100 + FONT / 2, 100], [1.5, 1.5, 1.5, 1.5], [0, 0, 0, 0], 0, FONT)
  assert.deepEqual(indents, [0, FONT, FONT / 2, 0])
})

test('a 「 inks half an em into its row: a row under the character after it is an em in', () => {
  // The game's 「 inks at 115, the row below starts under あ at 131; the card's 「 inks 15 px in.
  const indents = rowIndents([115, 131], [15, 1], [0, 0], 0, FONT)
  near(indents[1], FONT)
})

test('no row boxes to go by, or a count that does not match: nothing is moved', () => {
  assert.deepEqual(rowIndents([100, 130], [1.5], [0, 0], 0, FONT), [0, 0])
  assert.deepEqual(rowIndents([], [], [], 0, FONT), [])
})

test('leading whitespace is counted in characters', () => {
  assert.equal(leadingSpaces('　現実的な'), 1)
  assert.equal(leadingSpaces('  abc'), 2)
  assert.equal(leadingSpaces('現実的な'), 0)
})
