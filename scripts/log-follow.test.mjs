import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { distanceFromBottom, followAfterScroll, followThreshold } = await load('../frontend/texthooker/lib/logFollow.ts')

// A 600 px view over 2000 px of lines: 1400 is the very end.
const at = (scrollTop, scrollHeight = 2000) => ({ scrollTop, scrollHeight, clientHeight: 600 })
const T = followThreshold(20)

test('the threshold is about two furigana lines, never under 80 px', () => {
  assert.equal(followThreshold(12), 80)
  assert.equal(followThreshold(20), 80)
  assert.equal(followThreshold(32), 128)
  assert.equal(followThreshold(48), 192)
})

test('distance from the end is never negative (fractional overscroll)', () => {
  assert.equal(distanceFromBottom(at(1400)), 0)
  assert.equal(distanceFromBottom(at(1400.5)), 0)
  assert.equal(distanceFromBottom(at(1350)), 50)
})

test('at or near the end follows, wherever the view came from', () => {
  assert.equal(followAfterScroll(at(1400), 1400, true, T, true), true)
  // A few pixels up (after a lookup, a resize): still follows. This used to stop at 32 px.
  assert.equal(followAfterScroll(at(1360), 1400, true, T, true), true)
  assert.equal(followAfterScroll(at(1320), 1400, true, T, true), true)
  // Coming back down to the end starts following again.
  assert.equal(followAfterScroll(at(1390), 200, false, T, true), true)
})

test('scrolling clearly up stops following', () => {
  assert.equal(followAfterScroll(at(1300), 1400, true, T, true), false)
  assert.equal(followAfterScroll(at(200), 1400, true, T, true), false)
})

test('the lines growing under a following view do not count as scrolling away', () => {
  // A line laid out taller (furigana, a screenshot): the content grows, scrollTop stays.
  assert.equal(followAfterScroll(at(1400, 2300), 1400, true, T, true), true)
  // Scroll anchoring moved the view down to keep a grown row in place.
  assert.equal(followAfterScroll(at(1500, 2400), 1400, true, T, true), true)
})

test('a reader scrolled up stays put until they reach the end', () => {
  assert.equal(followAfterScroll(at(800), 600, false, T, true), false)
  assert.equal(followAfterScroll(at(800, 2600), 800, false, T, true), false)
  // One pixel of rounding is not a scroll up.
  assert.equal(followAfterScroll(at(1000.4, 2600), 1001, true, T, true), true)
})

test('the layout moving the view up is not the reader scrolling away', () => {
  // At the line limit the oldest row goes and scroll anchoring lowers scrollTop by its height.
  assert.equal(followAfterScroll(at(1200, 2000), 1400, true, T, false), true)
  // The same move from the reader's own wheel or scrollbar does stop it.
  assert.equal(followAfterScroll(at(1200, 2000), 1400, true, T, true), false)
  // Without the reader, an unfollowed Log stays unfollowed too.
  assert.equal(followAfterScroll(at(800), 1000, false, T, false), false)
})
