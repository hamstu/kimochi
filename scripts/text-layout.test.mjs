/**
 * Overlay text layout: where each line goes and how it is stretched over the original. The
 * pixel result needs a real font (scripts/overlay-alignment.test.mjs scores that against real
 * OCR), so these pin the arithmetic — character sharing, line estimation, the fit, one size per
 * row, cutting at gaps — with a stand-in measure of one em per character, whose ink fills each em
 * square but for 0.06 em at either end.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  apportion,
  characterCells,
  columns,
  distribute,
  estimate,
  fit,
  harmonize,
  layoutGroup,
  layoutParts,
  readingOrder,
  splitAtGaps,
  PAD
} from '../ui/text-layout.js'

const em = (text) => [...text].length
/** Where the stand-in measure's ink starts and ends in a run of n glyphs, in ems. */
const EDGE = 0.06
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

test("a run's ink fills its box: sized across, spaced along, starting and ending at the ink", () => {
  const run = fit({ text: 'あいう', rect: { x: 0, y: 0, width: 90, height: 20 } }, false, em)
  // The ink (0.92 em tall with the stand-in's ascent and descent) plus a margin either side.
  close(run.fontSize, 20 / (0.84 + 0.08 + 2 * PAD), 'font size')
  const f = run.fontSize
  // Glyph i's origin is lead + i * (f + spacing): the first glyph's ink starts a margin in from
  // the box, the last one's ends a margin short of it, and the pitch between them is even.
  close(run.lead + EDGE * f, PAD * f, 'first ink')
  close(run.lead + 2 * (f + run.spacing) + (1 - EDGE) * f, 90 - PAD * f, 'last ink')
  assert.ok(run.spacing > 0)
})

test('a crowded run shrinks its glyphs rather than overlapping them', () => {
  const run = fit({ text: 'あいうえお', rect: { x: 0, y: 0, width: 50, height: 40 } }, false, em)
  close(run.fontSize, 50 / (5 - 2 * EDGE + 2 * PAD), 'font size limited by length')
  close(run.spacing, 0, 'no spacing left')
})

test("a glyph's own ink decides where it starts: 「 sits half an em into its cell", () => {
  // A measure that knows the ink: 「 is drawn only in the right half of its em square.
  const inked = Object.assign((text) => em(text), {
    ink: (text) => ({
      advance: em(text),
      start: text.startsWith('「') ? 0.5 : EDGE,
      end: em(text) - EDGE,
      ascent: 0.84,
      descent: 0.08,
      fontAscent: 0.88,
      fontDescent: 0.12
    })
  })
  const rect = { x: 100, y: 0, width: 300, height: 30 }
  const plain = fit({ text: '「あい', rect }, false, em)
  const bracket = fit({ text: '「あい', rect }, false, inked)
  // The bracket's ink, not its cell, starts at the box: its origin sits further left.
  assert.ok(bracket.lead < plain.lead)
  close(bracket.lead + 0.5 * bracket.fontSize, PAD * bracket.fontSize, 'bracket ink at the box')
})

test("an engine's own margins move the ink: a box that runs on below a line", () => {
  const rect = { x: 0, y: 0, width: 200, height: 40 }
  const even = fit({ text: 'あいう', rect }, false, em)
  // Live Text's boxes run on below the ink: the glyph is smaller, and set higher.
  const below = fit({ text: 'あいう', rect, margin: [0.05, 0.05, 0.04, 0.3] }, false, em)
  assert.ok(below.fontSize < even.fontSize)
  assert.ok(below.shift < even.shift, 'moved up')
  // For a column the margin before is on the right: more of it moves the ink left.
  const column = { x: 0, y: 0, width: 40, height: 200 }
  const right = fit({ text: 'あいう', rect: column, margin: [0.05, 0.05, 0.3, 0.05] }, true, em)
  assert.ok(right.shift < 0)
})

test('one size per row: the runs on a line share the median size, a lone mark is not counted', () => {
  const runs = [
    { text: 'こんにちは', rect: { x: 0, y: 0, width: 100, height: 20 }, natural: 20 },
    { text: '、', rect: { x: 100, y: 4, width: 8, height: 8 }, natural: 34 },
    { text: 'げんき', rect: { x: 110, y: 1, width: 66, height: 22 }, natural: 22 },
    { text: 'ですか', rect: { x: 180, y: 0, width: 60, height: 21 }, natural: 21 },
    // The next line down, and a heading twice the size beside it, are rows of their own.
    { text: 'はい', rect: { x: 0, y: 40, width: 40, height: 20 }, natural: 19 },
    { text: '見出し', rect: { x: 260, y: -10, width: 150, height: 40 }, natural: 45 }
  ]
  assert.deepEqual(harmonize(runs), [21, 21, 21, 21, 19, 45])
})

test('a whole frame is laid out at once, every row at one size', () => {
  const parts = [
    { text: 'こんにちは', rect: { x: 0, y: 0, width: 110, height: 22 } },
    { text: 'げんき', rect: { x: 120, y: 1, width: 70, height: 20 } }
  ]
  const [[first], [second]] = layoutParts(parts, em)
  close(first.fontSize, second.fontSize, 'one size')
})

test('a line is cut where its words show a gap OCR left out of the text, separators kept', () => {
  const run = { text: 'ゆうしゃは スライムを', rect: { x: 0, y: 0, width: 400, height: 20 } }
  const word = (text, x, width) => ({ text, x, y: 0, width, height: 20 })
  // Two words 20 px apart, then one 70 px on: a space the text has only as ' '.
  const pieces = splitAtGaps(
    run,
    [word('ゆうしゃ', 0, 80), word('は', 100, 20), word('スライムを', 190, 100)],
    false
  )
  assert.deepEqual(
    pieces.map((piece) => [piece.text, piece.rect.x, piece.rect.width]),
    [
      ['ゆうしゃは ', 0, 120],
      ['スライムを', 190, 100]
    ]
  )
  // Each piece knows where its words start, in characters, for placing its glyphs by them.
  assert.deepEqual(
    pieces[0].segments.map((s) => s.at),
    [0, 4]
  )
  // Words that do not match the text, or no gap, leave the line whole.
  assert.equal(splitAtGaps(run, [word('ちがう', 0, 60)], false)[0].text, run.text)
  assert.equal(
    splitAtGaps(run, [word('ゆうしゃは', 0, 100), word('スライムを', 110, 100)], false).length,
    1
  )
})

test("characters the engine boxed place the glyphs, whatever the run's ends say", () => {
  // Four characters on a 30 px pitch starting at x = 10 (each boxed a margin outside its ink);
  // the line's box runs on 40 px past the last one, which the ends alone would spread them over.
  const f = 20 / (0.84 + 0.08 + 2 * PAD)
  const segments = [...'あいうえ'].map((text, at) => ({
    text,
    at,
    x: 10 + at * 30 + EDGE * f - PAD * f,
    y: 0,
    width: (1 - 2 * EDGE + 2 * PAD) * f,
    height: 20
  }))
  const run = fit(
    { text: 'あいうえ', rect: { x: 10, y: 0, width: 160, height: 20 }, segments },
    false,
    em
  )
  close(run.lead, 0, 'first origin on the first character')
  close(run.fontSize + run.spacing, 30, 'pitch from the characters')
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
  // Cells tile the line: each glyph's advance and the spacing around it, end to end, the first
  // centred on the first glyph, whose ink starts at the start of the line.
  close(cells[0].x + cells[0].width, cells[1].x, 'cells meet')
  const [run] = layoutGroup(
    [{ text: 'あい', rect: { x: 0, y: 0, width: 60, height: 20 } }],
    false,
    em
  )
  close(cells[0].x, run.lead - run.spacing / 2, 'first cell around the first glyph')
  close(cells[1].x + cells[1].width, run.lead + 2 * run.fontSize + 1.5 * run.spacing, 'last cell')
  assert.deepEqual([cells[0].line, cells[1].line, cells[3].line, cells[5].line], [0, 0, 1, 1])
  close(cells[5].y, 40, 'second line cells sit on the second line')
})

test("a manga detector's line regions become columns: ruby dropped, pieces joined, a missed one found", () => {
  // Two columns of six 30 px glyphs, the right one with 15 px ruby beside it. The detector saw the
  // right column in two pieces, the top one with its ruby, and missed the left column.
  const box = { x: 0, y: 0, width: 85, height: 180 }
  const found = columns(
    [
      { x: 70, y: 0, width: 15, height: 120, segments: [] },
      { x: 40, y: 0, width: 45, height: 90, segments: [] },
      { x: 42, y: 92, width: 30, height: 88, segments: [] }
    ],
    'あいうえおかきくけこさし',
    box
  )
  assert.equal(found.length, 2)
  const [right, left] = readingOrder(found, true)
  assert.deepEqual([right.x, right.y, right.width, right.height], [40, 0, 45, 180])
  assert.deepEqual([left.x, left.width, left.height], [0, 40, 180])
})

test('columns the detector ran together leave the bubble to be estimated, at one size', () => {
  const box = { x: 0, y: 0, width: 90, height: 180 }
  const text = 'あいうえおかきくけこさし'
  assert.equal(columns([{ ...box, segments: [] }], text, box), null)
  const [runs] = layoutParts([{ text, rect: box, lines: [box], block: true, vertical: true }], em)
  assert.equal(runs.length, 2)
  close(runs[0].fontSize, runs[1].fontSize, 'one size')
})

test('two narration boxes boxed as one are set as wrapped text, never stretched over the join', () => {
  // Manga OCR on 「……」 high on the right joined to 「嘘だろ…？」 low on the left: one block over
  // both, with a line found for the left column only (y 951 to 1057 of a box from 882 to 1057).
  // Inventing the right column over the box's whole length spread …嘘だろ over 175 px.
  const box = { x: 312, y: 882, width: 55, height: 175 }
  const text = '…嘘だろ…？'
  const lines = [{ x: 312, y: 951, width: 29, height: 106 }]
  const [runs] = layoutParts([{ text, rect: box, lines, block: true, vertical: true }], em)
  assert.equal(runs.map((run) => run.text).join(''), text, 'every character, in reading order')
  assert.ok(runs.length > 1)
  for (let i = 1; i < runs.length; i++)
    assert.ok(runs[i - 1].rect.x > runs[i].rect.x, 'columns read right to left')
  for (const run of runs) {
    close(run.fontSize, runs[0].fontSize, 'one size')
    const pitch = run.fontSize + run.spacing
    assert.ok(pitch <= 1.1 * run.fontSize, `pitch ${pitch} for a ${run.fontSize} px glyph`)
    assert.ok(run.rect.y >= box.y - 1e-9 && run.rect.y + run.rect.height <= box.y + box.height + 1e-9)
  }
  // Broken where the boxes join, after the pause, as the source is lettered: the found column
  // keeps its place, low on the left, and the right one runs from the top.
  assert.deepEqual(
    runs.map((run) => run.text),
    ['…', '嘘だろ…？']
  )
  close(runs[1].rect.y, 951, 'the left column where it was found')
  close(runs[0].rect.y, 882, 'the right column from the top')
  assert.ok(runs[0].rect.height < 40, 'the right column only as long as its text')
})

test('an estimated column starts where the detector found it, when it fits there', () => {
  const box = { x: 0, y: 0, width: 60, height: 150 }
  const lines = [{ x: 0, y: 40, width: 26, height: 110 }]
  const [runs] = layoutParts([{ text: 'あいう。かきくけ', rect: box, lines, block: true, vertical: true }], em)
  assert.deepEqual(
    runs.map((run) => run.text),
    ['あいう。', 'かきくけ']
  )
  close(runs[1].rect.y, 40, 'the left column starts at the found line')
  close(runs[0].rect.y, 0, 'the right column at the top of the box')
})

test('joined narration boxes keep their own columns, and slanted handwriting keeps its three', () => {
  // Manga OCR on a Quick Shot: 「先に言って／おくと」 high on the right and 「これは業界が／どうとかの／
  // 大きな話じゃない」 lower on the left, one block; beside it a handwritten bubble whose slanted
  // columns are boxed twice as wide as their glyphs and overlap.
  const block = (text, [x1, y1, x2, y2], polygons) => ({
    text,
    rect: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
    lines: polygons.map(([a, b, c, d]) => ({ x: a, y: b, width: c - a, height: d - b })),
    block: true,
    vertical: true
  })
  const [narration, bubble] = layoutParts(
    [
      block('先に言っておくとこれは業界がどうとかの大きな話じゃない', [52, 75, 197, 281], [
        [145, 75, 170, 141],
        [173, 76, 197, 178],
        [80, 122, 100, 223],
        [106, 121, 129, 243],
        [53, 123, 73, 280]
      ]),
      block('アンコールないからはよ帰れ', [240, 199, 320, 288], [
        [281, 199, 320, 283],
        [261, 206, 299, 277],
        [240, 207, 281, 288]
      ])
    ],
    em
  )
  assert.deepEqual(
    narration.map((run) => run.text),
    ['先に言って', 'おくと', 'これは業界が', 'どうとかの', '大きな話じゃない']
  )
  assert.deepEqual(
    bubble.map((run) => run.text),
    ['アンコール', 'ないから', 'はよ帰れ']
  )
  for (const runs of [narration, bubble])
    for (const run of runs) {
      close(run.fontSize, runs[0].fontSize, 'one size per block')
      assert.ok(run.fontSize + run.spacing <= 1.25 * run.fontSize, `${run.text} spread out`)
    }
})

test('a break measured off line lengths moves to just after a nearby pause', () => {
  // Manga OCR's four columns of 「さすが／「どこでも勉強ニキ」／の異名を持つだけ／はあるね！」: by length
  // alone the second ends at ニ and the third starts with キ」.
  const lines = [
    { x: 1407, y: 709, width: 36, height: 74 },
    { x: 1381, y: 709, width: 34, height: 190 },
    { x: 1355, y: 713, width: 27, height: 165 },
    { x: 1327, y: 711, width: 27, height: 109 }
  ]
  const runs = distribute('さすが「どこでも勉強ニキ」の異名を持つだけはあるね！', lines, true)
  assert.equal(runs[1].text, '「どこでも勉強ニキ」')
  assert.equal(runs.map((run) => run.text).join(''), 'さすが「どこでも勉強ニキ」の異名を持つだけはあるね！')
})

test('a column of ellipses keeps its bubble\'s size, centred on its tight box', () => {
  // Manga OCR on 「……／かう」: the dots boxed 29 px long for two ellipses, beside 「かう」.
  const [runs] = layoutParts(
    [
      {
        text: '……かう',
        rect: { x: 73, y: 103, width: 113, height: 88 },
        lines: [
          { x: 163, y: 130, width: 23, height: 29 },
          { x: 73, y: 133, width: 34, height: 58 }
        ],
        block: true,
        vertical: true
      }
    ],
    em
  )
  assert.deepEqual(
    runs.map((run) => run.text),
    ['……', 'かう']
  )
  close(runs[0].fontSize, runs[1].fontSize, 'one size')
  close(runs[0].lead + runs[0].fontSize, 29 / 2, 'centred on its box')
  assert.equal(runs[0].spacing, 0)
})
