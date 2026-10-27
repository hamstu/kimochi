/**
 * The controller driving the region editor (ui/region-pad.js): which buttons save and cancel, the
 * sticks reaching the editor, and, under Gamescope, controller navigation held while the editor is
 * open and handed back when it closes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { padButtons, startRegionPad } from '../ui/region-pad.js'

function fakes() {
  const listeners = new Map()
  const calls = []
  const native = {
    listen: async (name, handler) => {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    },
    controllerNav: async (on) => {
      calls.push(on)
      return { gamescopeInput: true }
    }
  }
  const selector = {
    active: true,
    confirmed: 0,
    cancelled: 0,
    sticks_: null
  }
  selector.sticks = (left, right) => (selector.sticks_ = { left, right })
  selector.confirm = () => selector.confirmed++
  selector.cancel = () => selector.cancelled++
  const timers = { setInterval: (fn) => ((timers.renew = fn), 1), clearInterval: () => (timers.cleared = true) }
  const emit = (name, payload) => listeners.get(name)?.({ payload })
  return { native, selector, calls, timers, emit, listeners }
}

test('Select and Back come from controllerButtons, with defaults for what is missing', () => {
  assert.deepEqual(padButtons(null), { confirm: 0, back: 1 })
  assert.deepEqual(padButtons({ confirm: 18, back: null }), { confirm: 18, back: null })
})

test('under Gamescope it holds controller navigation, renews it, and hands it back on close', async () => {
  const { native, selector, calls, timers, emit, listeners } = fakes()
  const stop = await startRegionPad(selector, { native, gamescope: true, buttons: { confirm: 0, back: 1 }, ...timers })
  assert.deepEqual(calls, [true])
  timers.renew()
  await Promise.resolve()
  assert.deepEqual(calls, [true, true])
  emit('controller-nav', { stick: { x: -1, y: 0 }, rstick: { x: 0, y: 0.5 }, pressed: [] })
  assert.deepEqual(selector.sticks_, { left: { x: -1, y: 0 }, right: { x: 0, y: 0.5 } })
  emit('controller-nav', { stick: { x: 0, y: 0 }, rstick: { x: 0, y: 0 }, pressed: [0] })
  assert.equal(selector.confirmed, 1)
  emit('controller-nav', { pressed: [1] })
  assert.equal(selector.cancelled, 1)
  emit('controller-nav-cancel', {})
  assert.equal(selector.cancelled, 2, 'Steam taking the controller back cancels')
  await stop()
  assert.equal(timers.cleared, true)
  assert.deepEqual(calls, [true, true, false])
  assert.equal(listeners.size, 0)
})

test('elsewhere it reads the gamepad state, ignores a button held when it opened, and applies a deadzone', async () => {
  const { native, selector, calls, emit } = fakes()
  const stop = await startRegionPad(selector, { native, gamescope: false, buttons: { confirm: 0, back: 1 } })
  const state = (buttons, axes = [0, 0, 0, 0]) => ({
    activeGamepadIndex: 0,
    buttonStates: [0, 1, 2].map((i) => buttons.includes(i)),
    axisStates: axes
  })
  emit('gamepad', state([0], [0.1, 0.9, 0, -0.5]))
  assert.equal(selector.confirmed, 0, 'A was already down')
  assert.deepEqual(selector.sticks_, { left: { x: 0, y: 0.9 }, right: { x: 0, y: -0.5 } })
  emit('gamepad', state([]))
  emit('gamepad', state([0]))
  assert.equal(selector.confirmed, 1)
  emit('gamepad', state([0, 1]))
  assert.equal(selector.cancelled, 1)
  await stop()
  assert.deepEqual(calls, [], 'nothing is taken from the system')
})
