import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'
const { overrides, textHookOn, withSetting } = await load('hook-games.ts')

test('a game value equal to the default is not a change', () => {
  assert.equal(overrides({ autoAlign: true }, 'autoAlign'), false)
  assert.equal(overrides({ placeWithOcr: true }, 'autoAlign'), false)
  assert.equal(overrides({ autoAlign: false }, 'autoAlign'), true)
  // Against the reader's own defaults, not the shipped ones.
  assert.equal(overrides({ autoAlign: false }, 'autoAlign', { autoAlign: false }), false)
  assert.equal(overrides({ flushMs: 300 }, 'flushMs', { flushMs: 500 }), true)
})

test('setting a game back to the default drops its own value', () => {
  assert.deepEqual(withSetting({ autoAlign: false, box: [1, 2, 3, 4] }, 'autoAlign', true), { box: [1, 2, 3, 4] })
  assert.deepEqual(withSetting({ placeWithOcr: true }, 'autoAlign', false), { autoAlign: false })
  assert.deepEqual(withSetting({}, 'flushMs', 500, { flushMs: 500 }), {})
  assert.deepEqual(withSetting({ leading: 1.4 }, 'textSize', 0.05), { leading: 1.4, text: 0.05 })
})

test('Text hooking is the reader switch for a game, and on for a game hooked before', () => {
  assert.equal(textHookOn(undefined), false)
  assert.equal(textHookOn({}), false)
  assert.equal(textHookOn({ hookedAt: 1 }), true)
  assert.equal(textHookOn({ hookedAt: 1, textHook: false }), false)
  assert.equal(textHookOn({ textHook: true }), true)
})
