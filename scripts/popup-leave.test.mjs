import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { PopupLeave, lineAround, gapBetween } = await load('popup-leave.ts')
const word = { x: 100, y: 100, width: 60, height: 30 }
const popup = { x: 100, y: 140, width: 300, height: 200 }

test('the pop-up closes once the pointer has been off the words and the pop-up for the grace', () => {
  const leave = new PopupLeave(600)
  assert.equal(leave.update(0, { x: 110, y: 110 }, [word, popup], true), false, 'on the word')
  assert.equal(leave.update(10, { x: 600, y: 600 }, [word, popup], true), false, 'just left')
  assert.equal(leave.remaining(10), 600)
  assert.equal(leave.update(500, { x: 600, y: 600 }, [word, popup], true), false, 'still within the grace')
  assert.equal(leave.update(610, { x: 600, y: 600 }, [word, popup], true), true, 'gone for the grace')
  assert.equal(leave.update(620, { x: 600, y: 600 }, [word, popup], true), false, 'once')
})

test('crossing from the word into the pop-up keeps it open', () => {
  const leave = new PopupLeave(600)
  leave.update(0, { x: 110, y: 110 }, [word, popup], true)
  // The gap between them, briefly, then the pop-up.
  assert.equal(leave.update(100, { x: 110, y: 135 }, [word, popup], true), false)
  assert.equal(leave.update(300, { x: 200, y: 200 }, [word, popup], true), false)
  assert.equal(leave.update(5000, { x: 200, y: 200 }, [word, popup], true), false, 'reading inside it')
  assert.equal(leave.remaining(5000), null)
})

test('no pop-up, nothing to close; a pointer off the display counts as away', () => {
  const leave = new PopupLeave(600)
  assert.equal(leave.update(0, { x: 600, y: 600 }, [word], false), false)
  assert.equal(leave.update(1000, { x: 600, y: 600 }, [word], false), false)
  assert.equal(leave.update(1000, null, [word, popup], true), false)
  assert.equal(leave.update(1700, null, [word, popup], true), true)
})

test('look up on hover keeps the pop-up along the word’s own row only', () => {
  // A box of two lines; the word on its second.
  const block = { x: 0, y: 0, width: 400, height: 60 }
  const line = lineAround({ x: 100, y: 30, width: 50, height: 30 }, [block], [], false, 20)
  assert.deepEqual(line, { x: 0, y: 30, width: 400, height: 30 })
})

test('boxes OCR split off the row are joined up to 2em away, and no further', () => {
  const word = { x: 10, y: 0, width: 40, height: 20 }
  const home = { x: 0, y: 0, width: 100, height: 20 }
  const near = { x: 130, y: 0, width: 50, height: 20 } // 30 px past: within 2em of 20 px
  const far = { x: 230, y: 0, width: 50, height: 20 } // 50 px past the joined row: too far
  const other = { x: 0, y: 100, width: 300, height: 20 } // another line
  const line = lineAround(word, [far, other, near, home], [], false, 20)
  assert.deepEqual(line, { x: 0, y: 0, width: 180, height: 20 })
})

test('vertical text keeps the column, and glyphs drawn past the box count', () => {
  const word = { x: 0, y: 20, width: 20, height: 40 }
  const column = { x: 0, y: 0, width: 20, height: 100 }
  assert.deepEqual(lineAround(word, [column], [], true, 20), { x: 0, y: 0, width: 20, height: 100 })
  const overflow = { x: 0, y: 0, width: 20, height: 130 }
  assert.deepEqual(lineAround(word, [column], [overflow], true, 20), { x: 0, y: 0, width: 20, height: 130 })
})

test('with no box under the word, the drawn line or nothing', () => {
  const word = { x: 10, y: 0, width: 40, height: 20 }
  assert.equal(lineAround(word, [], [], false, 20), null)
  const drawn = { x: 0, y: 0, width: 200, height: 20 }
  assert.deepEqual(lineAround(word, [], [drawn], false, 20), { x: 0, y: 0, width: 200, height: 20 })
})

test('the gap between a word and its pop-up', () => {
  const word = { x: 100, y: 100, width: 60, height: 20 }
  // Below: the space between them vertically, across both widths.
  assert.deepEqual(gapBetween(word, { x: 80, y: 130, width: 300, height: 200 }), {
    x: 79,
    y: 119,
    width: 302,
    height: 12
  })
  // Beside: the space between them horizontally.
  assert.deepEqual(gapBetween(word, { x: 200, y: 90, width: 100, height: 100 }), {
    x: 159,
    y: 89,
    width: 42,
    height: 102
  })
  // Diagonal: the box around both.
  assert.deepEqual(gapBetween(word, { x: 200, y: 200, width: 100, height: 100 }), {
    x: 99,
    y: 99,
    width: 202,
    height: 202
  })
})
