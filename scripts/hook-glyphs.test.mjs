import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { glyphGeometry } = await load('hook-glyphs.ts')

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
