import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const {
  IDLE,
  currentSelection,
  enter,
  lineKey,
  prune,
  selectRange,
  selecting,
  selectionLabel,
  selectionText,
  setSelection,
  startSelecting,
  stopSelecting,
  subscribeSelection,
  toggle
} = await load('../frontend/texthooker/lib/logSelection.ts')

const line = (id, text, extra = {}) => ({ id, uid: `u${id}`, text, source: 'ocr', ts: id, ...extra })
const LINES = [
  line(1, '一'),
  line(2, '二', { translation: 'two', showTranslation: true }),
  line(3, '三', { translation: 'three', showTranslation: false }),
  line(4, '**mine**', { source: 'note' }),
  line(5, '五')
]
const ORDER = LINES.map(lineKey)
const keys = (state) => [...state.selected].sort()

test('Select starts the mode with that row selected, and it is where a range starts', () => {
  const state = enter('u3')
  assert.equal(state.active, true)
  assert.deepEqual(keys(state), ['u3'])
  assert.equal(state.anchor, 'u3')
  assert.equal(lineKey({ id: 9 }), '#9', 'a row without a uid is known by its id')
})

test('a click toggles a row and moves the range start to it', () => {
  let state = enter('u1')
  state = toggle(state, 'u3')
  assert.deepEqual(keys(state), ['u1', 'u3'])
  assert.equal(state.anchor, 'u3')
  state = toggle(state, 'u1')
  assert.deepEqual(keys(state), ['u3'])
  assert.equal(state.anchor, 'u1')
  state = toggle(state, 'u3')
  assert.deepEqual(keys(state), [], 'everything can be unticked without leaving the mode')
  assert.equal(state.active, true)
  assert.equal(toggle(IDLE, 'u1'), IDLE, 'outside the mode a click selects nothing')
})

test('Shift+click selects every row from the last one clicked, either way, and keeps the start', () => {
  let state = selectRange(enter('u2'), 'u4', ORDER)
  assert.deepEqual(keys(state), ['u2', 'u3', 'u4'])
  assert.equal(state.anchor, 'u2')
  state = selectRange(state, 'u1', ORDER)
  assert.deepEqual(keys(state), ['u1', 'u2', 'u3', 'u4'], 'upwards from the same start, adding to what was selected')
  // Unticked rows inside a range are ticked again; rows outside it are left as they were.
  state = toggle(toggle(state, 'u3'), 'u5')
  state = selectRange(state, 'u3', ORDER)
  assert.deepEqual(keys(state), ['u1', 'u2', 'u3', 'u4', 'u5'])
})

test('a Shift+click with no start (or a start since deleted) is a plain click', () => {
  const state = { active: true, selected: new Set(['u1']), anchor: null }
  assert.deepEqual(keys(selectRange(state, 'u4', ORDER)), ['u1', 'u4'])
  const gone = { active: true, selected: new Set(), anchor: 'u9' }
  assert.deepEqual(keys(selectRange(gone, 'u2', ORDER)), ['u2'])
})

test('rows deleted elsewhere leave the selection; the same state when none did', () => {
  const state = toggle(enter('u1'), 'u4')
  const present = new Set(['u1', 'u2', 'u3', 'u5'])
  const pruned = prune(state, present)
  assert.deepEqual(keys(pruned), ['u1'])
  assert.equal(pruned.anchor, null, 'the range start went with its row')
  assert.equal(prune(pruned, present), pruned)
  assert.equal(prune(IDLE, present), IDLE)
})

test('Copy text is each row as it shows, in the Log order, one per line, notes included', () => {
  const picked = new Set(['u5', 'u4', 'u2', 'u3'])
  assert.equal(selectionText(LINES, picked), 'two\n三\n**mine**\n五')
  assert.equal(selectionText(LINES, new Set()), '')
})

test('the bar names what is selected', () => {
  assert.equal(selectionLabel(LINES, new Set(['u1'])), '1 line')
  assert.equal(selectionLabel(LINES, new Set(['u1', 'u2'])), '2 lines')
  assert.equal(selectionLabel(LINES, new Set(['u4'])), '1 note')
  assert.equal(selectionLabel(LINES, new Set(['u1', 'u2', 'u4'])), '2 lines and 1 note')
  assert.equal(selectionLabel(LINES, new Set(['gone'])), 'Nothing')
})

test('the window has one selection: lookups are held off exactly while it is on', () => {
  const seen = []
  const stop = subscribeSelection(() => seen.push(selecting()))
  assert.equal(selecting(), false)
  startSelecting(LINES[3])
  assert.equal(selecting(), true)
  assert.deepEqual(keys(currentSelection()), ['u4'], 'a note can be selected')
  setSelection(toggle(currentSelection(), 'u1'))
  stopSelecting()
  assert.equal(selecting(), false)
  assert.equal(currentSelection(), IDLE, 'leaving clears the selection')
  stopSelecting()
  assert.deepEqual(seen, [true, true, false], 'told of each change, once')
  stop()
})
