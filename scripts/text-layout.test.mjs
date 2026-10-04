/**
 * Grouped text layout: where each line goes and how it is stretched over the original. The
 * pixel result needs a real font, so these pin the arithmetic — character sharing, line
 * estimation and the fit — with a stand-in measure of one em per character.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  apportion,
  characterCells,
  distribute,
  estimate,
  fit,
  layoutGroup,
  readingOrder,
  INK
} from '../ui/text-layout.js'

const em = (text) => [...text].length
const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`)

test('apportion shares by capacity and always adds up', () => {
  assert.deepEqual(apportion(10, [5, 5]), [5, 5])
  assert.deepEqual(apportion(7, [10, 10, 1]), [4, 3, 0])
  assert.deepEqual(apportion(3, [0, 0]), [2, 1])
  for (const count of [0, 1, 13, 40]) {
    const shares = apportion(count, [3.3, 7.1, 2.2, 9.9])
    assert.equal(
      shares.reduce((a, b) => a + b, 0),
      count
    )
  }
})

test('reading order: top to bottom, and right to left for columns', () => {
  const a = { x: 0, y: 0, width: 10, height: 10 }
  const b = { x: 20, y: 20, width: 10, height: 10 }
  assert.deepEqual(readingOrder([b, a], false), [a, b])
  assert.deepEqual(readingOrder([a, b], true), [b, a])
})

test("a bubble's unbroken text is shared across its lines by length", () => {
  // Two columns 20 wide: one 200 tall (10 cells), one 100 tall (5 cells), right one first.
  const right = { x: 100, y: 0, width: 20, height: 200 }
  const left = { x: 70, y: 0, width: 20, height: 100 }
  const runs = distribute('一二三四五六七八九十壱弐参肆伍', [left, right], true)
  assert.deepEqual(
    runs.map((run) => [run.text, run.rect]),
    [
      ['一二三四五六七八九十', right],
      ['壱弐参肆伍', left]
    ]
  )
})

test('line breaks that match the lines are kept as they are', () => {
  const lines = [
    { x: 0, y: 0, width: 300, height: 20 },
    { x: 0, y: 30, width: 300, height: 20 }
  ]
  assert.deepEqual(
    distribute('あいう\nえお', lines, false).map((run) => run.text),
    ['あいう', 'えお']
  )
})

test('with no line geometry, the line count that gives the largest glyphs wins', () => {
  // 20 characters in a 200 x 100 box: no other line count may allow a larger glyph.
  const runs = estimate(
    'あいうえおかきくけこさしすせそたちつてと',
    { x: 0, y: 0, width: 200, height: 100 },
    false
  )
  const size = runs[0].rect.height
  for (const lines of [1, 2, 3, 4, 5]) {
    const perLine = Math.ceil(20 / lines)
    const candidate = Math.min(200 / perLine, 100 / (lines + (lines - 1) * 0.35))
    assert.ok(candidate <= size + 1e-9, `${lines} lines would allow ${candidate} > ${size}`)
  }
  assert.equal(runs.map((run) => run.text).join(''), 'あいうえおかきくけこさしすせそたちつてと')
  // Lines stay inside the box and in order.
  for (const run of runs) {
    assert.ok(run.rect.y >= 0 && run.rect.y + run.rect.height <= 100 + 1e-9)
    assert.ok(run.rect.x + run.rect.width <= 200 + 1e-9)
  }
})

test('estimated vertical columns start at the right edge', () => {
  const runs = estimate('あいうえおかきくけこ', { x: 0, y: 0, width: 60, height: 100 }, true)
  assert.ok(runs.length > 1)
  assert.ok(runs[0].rect.x > runs[1].rect.x, 'first column is the rightmost')
  close(runs[0].rect.x + runs[0].rect.width, 60, 'first column touches the right edge')
})

test('a run is sized to its thickness and spaced to its length, glyphs centred in cells', () => {
  const run = fit({ text: 'あいう', rect: { x: 0, y: 0, width: 90, height: 20 } }, false, em)
  close(run.fontSize, 20 * INK, 'font size')
  const cell = 90 / 3
  close(run.spacing, cell - run.fontSize, 'spacing')
  close(run.lead, run.spacing / 2, 'lead')
  // Glyph i starts at lead + i * (fontSize + spacing), so its centre is the cell's centre.
  for (let i = 0; i < 3; i++) {
    const centre = run.lead + i * (run.fontSize + run.spacing) + run.fontSize / 2
    close(centre, cell * i + cell / 2, `glyph ${i} centre`)
  }
})

test('a crowded run shrinks its glyphs rather than overlapping them', () => {
  const run = fit({ text: 'あいうえお', rect: { x: 0, y: 0, width: 50, height: 40 } }, false, em)
  close(run.fontSize, 10, 'font size limited by length')
  close(run.spacing, 0, 'no spacing left')
})

test('a group mixes the evidence it has: boxes as given, blocks split into lines', () => {
  const runs = layoutGroup(
    [
      { text: 'こんにちは', rect: { x: 0, y: 0, width: 100, height: 20 } },
      {
        text: '元気ですか',
        rect: { x: 0, y: 30, width: 100, height: 60 },
        block: true,
        lines: [
          { x: 0, y: 30, width: 60, height: 20 },
          { x: 0, y: 60, width: 40, height: 20 }
        ]
      }
    ],
    false,
    em
  )
  assert.deepEqual(
    runs.map((run) => run.text),
    ['こんにちは', '元気ですか'.slice(0, 3), 'すか']
  )
})

test('character cells tile each run and skip line breaks, one per code unit', () => {
  const runs = layoutGroup(
    [
      {
        text: 'あい\n𠮷う',
        rect: { x: 0, y: 0, width: 100, height: 70 },
        block: true,
        lines: [
          { x: 0, y: 0, width: 60, height: 20 },
          { x: 0, y: 40, width: 60, height: 20 }
        ]
      }
    ],
    false,
    em
  )
  const cells = characterCells('あい\n𠮷う', runs, false, em)
  // あ い \n 𠮷(two code units) う
  assert.equal(cells.length, 6)
  assert.equal(cells[2], null)
  assert.equal(cells[3], cells[4], 'a surrogate pair shares its cell')
  close(cells[0].x, 0, 'first cell starts the line')
  close(cells[1].x + cells[1].width, 60, 'last cell of a line ends it')
  assert.deepEqual([cells[0].line, cells[1].line, cells[3].line, cells[5].line], [0, 0, 1, 1])
  close(cells[5].y, 40, 'second line cells sit on the second line')
})
