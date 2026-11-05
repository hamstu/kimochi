/**
 * The fast lane between Kimochi's own windows (ui/app-lane.js): a window sends to another over it
 * only once that window has said it is there, and not after it has gone.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { openAppLane } from '../ui/app-lane.js'

const opened = []
class Channel extends BroadcastChannel {
  constructor(name) {
    super(name)
    opened.push(this)
  }
}
afterEach(() => {
  for (const channel of opened.splice(0)) channel.close()
})

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, what) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return
    await tick(5)
  }
  assert.fail(`timed out waiting for ${what}`)
}

function fakeWindow({ channels = true } = {}) {
  const listeners = new Map()
  return {
    BroadcastChannel: channels ? Channel : undefined,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(listener)
    },
    fire(type) {
      for (const listener of listeners.get(type) ?? []) listener({})
    }
  }
}

test('windows find each other, send by label, and say who sent', async () => {
  const overlayWin = fakeWindow()
  const overlay = openAppLane(overlayWin, 'overlay')
  // One per window.
  assert.equal(openAppLane(overlayWin, 'overlay'), overlay)
  // Nobody has said they are there yet: the caller uses ext_relay.
  assert.equal(overlay.send('log', { kind: 'request', id: 1 }), false)
  const log = openAppLane(fakeWindow(), 'log')
  await until(() => overlay.reachable('log') && log.reachable('overlay'), 'both to hear of the other')
  const got = []
  overlay.listen((payload, from) => got.push([from, payload]))
  assert.equal(log.send('overlay', { kind: 'request', id: 2, message: { action: 'termsFind' } }), true)
  await until(() => got.length, 'the request')
  assert.deepEqual(got, [['log', { kind: 'request', id: 2, message: { action: 'termsFind' } }]])
  assert.equal(log.send('popup-host', { kind: 'port-open' }), false, 'a window that never said it is there')
})

test('a window that leaves is no longer sent to over the lane', async () => {
  const overlay = openAppLane(fakeWindow(), 'overlay')
  const logWin = fakeWindow()
  openAppLane(logWin, 'log')
  await until(() => overlay.reachable('log'), 'the log')
  logWin.fire('pagehide')
  await until(() => !overlay.reachable('log'), 'the log to go')
  assert.equal(overlay.send('log', { kind: 'response' }), false)
})

test('without channels, or turned off, there is no lane', () => {
  const none = openAppLane(fakeWindow({ channels: false }), 'log')
  assert.equal(none.reachable('overlay'), false)
  assert.equal(none.send('overlay', {}), false)
  const off = fakeWindow()
  off.__kimochiNoLane = true
  assert.equal(openAppLane(off, 'log').send('overlay', {}), false)
})
