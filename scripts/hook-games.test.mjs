import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'
const { hookCardShow, hookSettings, overrides, textHookOn, withLegacyShowCard, withSetting } =
  await load('hook-games.ts')

test('the card shows always, only with the lookup key held, or never; older settings read as before', () => {
  assert.equal(hookCardShow(undefined), 'always', 'shown unless turned off')
  assert.equal(hookCardShow(true), 'always')
  assert.equal(hookCardShow(false), 'never', 'the switch turned off, before there was a choice')
  assert.equal(hookCardShow('hold'), 'hold')
  assert.equal(hookCardShow('never'), 'never')
  assert.equal(hookCardShow('sometimes'), 'always', 'anything else is the default')
})

test('whether the card shows is per game, after the defaults, which take the old global setting', () => {
  assert.equal(hookSettings(null, null).showCard, 'always')
  assert.equal(hookSettings({ showCard: 'hold' }, null).showCard, 'hold')
  assert.equal(hookSettings({ showCard: 'hold' }, { showCard: 'never' }).showCard, 'never', 'the game’s own wins')
  // `textHookerShowCard`, from before it was per game, is the default until the defaults have one.
  assert.equal(hookSettings(withLegacyShowCard({}, false), null).showCard, 'never')
  assert.equal(hookSettings(withLegacyShowCard({}, 'hold'), null).showCard, 'hold')
  assert.equal(hookSettings(withLegacyShowCard({ showCard: 'always' }, false), null).showCard, 'always')
  assert.deepEqual(withLegacyShowCard({ opacity: 0.5 }, undefined), { opacity: 0.5 })
  // Set to the default, a game follows it again.
  assert.deepEqual(withSetting({ showCard: 'never' }, 'showCard', 'hold', { showCard: 'hold' }), {})
  assert.equal(overrides({ showCard: 'never' }, 'showCard', { showCard: 'hold' }), true)
})

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

test('the Line delay is 100 ms unless the reader chose one, for every game or for one (#222)', () => {
  // Never changed: nothing is stored, so the shipped default applies (300 ms before #222).
  assert.equal(hookSettings(null, null).flushMs, 100)
  assert.equal(hookSettings({}, { hookedAt: 1 }).flushMs, 100)
  // A value chosen under Defaults is kept, and every game without its own follows it.
  assert.equal(hookSettings({ flushMs: 300 }, null).flushMs, 300)
  assert.equal(hookSettings({ flushMs: 500 }, { hookedAt: 1 }).flushMs, 500)
  // A game's own value is kept, whatever the default.
  assert.equal(hookSettings(null, { flushMs: 800 }).flushMs, 800)
  assert.equal(hookSettings({ flushMs: 50 }, { flushMs: 300 }).flushMs, 300)
})
