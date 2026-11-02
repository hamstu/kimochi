/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
/**
 * Looking a word up without taking anybody's focus.
 *
 * The scan trigger is a modifier, and a modifier only ever reaches the window that
 * has the keyboard — which, while somebody is reading their game, is their game. So
 * the pointer and the modifiers are read natively and handed to the original scanner
 * as an ordinary event. These are the rules about when that is the right thing to do,
 * and they are all rules about not answering for a point that belongs to someone else.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { scanPointerInit, REAL_POINTER_GRACE_MS } = await load('scan-input.ts')
const { toOverlayLocal } = await load('geometry.ts')

const ORIGIN = { x: 1728, y: 30, width: 3440, height: 1410 }
const local = (sample) => toOverlayLocal(sample, ORIGIN)
const sample = (extra = {}) => ({ x: 2000, y: 500, over: true, ...extra })
const feed = (extra = {}, since = 10000) => {
  const s = sample(extra)
  return scanPointerInit(s, local(s), since)
}

test('a desktop point arrives in the window own coordinates', () => {
  const init = feed()
  assert.equal(init.clientX, 2000 - ORIGIN.x)
  assert.equal(init.clientY, 500 - ORIGIN.y)
})

test('the desktop point is kept as the screen position', () => {
  const init = feed()
  assert.equal(init.screenX, 2000)
  assert.equal(init.screenY, 500)
})

test('a display left of the primary keeps its negative origin', () => {
  const origin = { x: -1920, y: -200, width: 1920, height: 1080 }
  const s = { x: -1000, y: 100, over: true }
  const init = scanPointerInit(s, toOverlayLocal(s, origin), 10000)
  assert.equal(init.clientX, 920)
  assert.equal(init.clientY, 300)
})

test('the held modifiers are carried onto the event', () => {
  const init = feed({ shift: true, alt: true })
  assert.equal(init.shiftKey, true)
  assert.equal(init.altKey, true)
  assert.equal(init.ctrlKey, false)
  assert.equal(init.metaKey, false)
})

test('a held button is reported, so a drag is not read as a hover', () => {
  assert.equal(feed({ down: true }).buttons, 1)
  assert.equal(feed({ down: false }).buttons, 0)
})

test('it is a primary mouse pointermove, which is what the scanner listens for', () => {
  const init = feed()
  assert.equal(init.pointerType, 'mouse')
  assert.equal(init.isPrimary, true)
  assert.equal(init.bubbles, true)
})

test('nothing is dispatched for a point the dictionary already owns', () => {
  // Otherwise the word looked up is whichever one the popup happens to be covering.
  assert.equal(feed({ blocked: true }), null)
})

test('nothing is dispatched off the display the overlay covers', () => {
  assert.equal(feed({ over: false }), null)
})

test('nothing is dispatched without a window to translate against', () => {
  assert.equal(scanPointerInit(sample(), null, 10000), null)
})

test('real pointer events suppress the feed while they are arriving', () => {
  assert.equal(feed({}, REAL_POINTER_GRACE_MS - 1), null)
  assert.notEqual(feed({}, REAL_POINTER_GRACE_MS), null)
})

test('a modifier the real event did not report is not muted by it', () => {
  // Windows: the game has the keyboard, so the overlay's own pointermove reports Shift up
  // while it is held. Muting the native sample then lost the lookup entirely, because the
  // feed sends nothing new until the pointer moves again or a modifier changes.
  const s = sample({ shift: true })
  const unaware = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }
  const init = scanPointerInit(s, local(s), REAL_POINTER_GRACE_MS - 1, unaware)
  assert.notEqual(init, null)
  assert.equal(init.shiftKey, true)
  // No record of a real event's modifiers counts as none reported.
  assert.notEqual(scanPointerInit(s, local(s), 0), null)
})

test('a real event that already carries the modifier still wins', () => {
  // macOS and Linux, or Windows with Kimochi focused: the real event is the better
  // answer, and sending the native one too would scan the same point twice.
  const s = sample({ shift: true })
  const aware = { shiftKey: true, ctrlKey: false, altKey: false, metaKey: false }
  assert.equal(scanPointerInit(s, local(s), REAL_POINTER_GRACE_MS - 1, aware), null)
  // One the real event lacks is still enough, whichever key it is.
  const ctrl = sample({ shift: true, ctrl: true })
  assert.notEqual(scanPointerInit(ctrl, local(ctrl), REAL_POINTER_GRACE_MS - 1, aware), null)
})

test('a modifier alone is enough: the pointer need not have moved', () => {
  // Holding Shift over the word already under the pointer is how a reader asks for
  // the one they are looking at, so the sample carries no notion of movement at all.
  const first = feed({ shift: false })
  const second = feed({ shift: true })
  assert.equal(first.clientX, second.clientX)
  assert.equal(second.shiftKey, true)
})
