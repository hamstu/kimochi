import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { PopupLeave, popupLeaveDelayOf } = await load('popup-leave.ts')
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

test('dismissal delay accepts manual mode, bounds stored values and defaults to one second', () => {
  assert.equal(popupLeaveDelayOf(0), 0)
  assert.equal(popupLeaveDelayOf(1500), 1500)
  assert.equal(popupLeaveDelayOf(30000), 10000)
  for (const value of [undefined, null, -1, NaN, Infinity, '600']) {
    assert.equal(popupLeaveDelayOf(value), 1000)
  }
})

test('changing grace keeps elapsed time while entering any popup cancels it', () => {
  const leave = new PopupLeave(600)
  leave.update(0, null, [word, popup], true)
  leave.graceMs = 1500
  assert.equal(leave.update(700, null, [word, popup], true), false)
  assert.equal(leave.remaining(700), 800)
  assert.equal(leave.update(900, { x: 110, y: 150 }, [word, popup], true), false)
  assert.equal(leave.remaining(10000), null)
})
