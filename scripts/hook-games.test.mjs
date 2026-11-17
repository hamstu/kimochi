import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'
const {
  exeFolder,
  hookCardShow,
  hookGameName,
  hookSettings,
  overrides,
  textHookOn,
  windowGameTitle,
  withLegacyShowCard,
  withSetting
} = await load('hook-games.ts')

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

test('a game is called what its window is called until the reader names it', () => {
  const key = String.raw`c:\games\a\siglusengine.exe`
  const exe = String.raw`C:\Games\A\SiglusEngine.exe`
  assert.equal(hookGameName(key, { exe }), 'SiglusEngine', 'the exe’s name before anything else is known')
  assert.equal(hookGameName(key, { exe, title: 'Summer Pockets' }), 'Summer Pockets', 'its window’s title')
  // A name Kimochi gave it (its session's, when it was linked) gives way to the window's title...
  assert.equal(hookGameName(key, { exe, name: 'SiglusEngine', title: 'Summer Pockets' }), 'Summer Pockets')
  // ...but a name the reader gave it never does, and its session's name is the reader's too.
  assert.equal(
    hookGameName(key, {
      exe,
      name: 'SP',
      named: true,
      title: 'Summer Pockets'
    }),
    'SP'
  )
  assert.equal(
    hookGameName(key, { exe, name: 'SP', named: true, title: 'Summer Pockets' }, 'SP Reflection'),
    'SP Reflection'
  )
  assert.equal(windowGameTitle('  Summer   Pockets ', 'SiglusEngine'), 'Summer Pockets')
  assert.equal(windowGameTitle('', 'Summer Pockets'), 'Summer Pockets', 'a window without a title: its app')
  assert.equal(windowGameTitle(' ', null), null)
})

test('games of the same name are told apart by the folders their exes are in', () => {
  const a = String.raw`C:\Games\Summer Pockets\SiglusEngine.exe`
  const b = String.raw`C:\Games\Rewrite\SiglusEngine.exe`
  assert.equal(exeFolder(a, [a, b]), 'Summer Pockets')
  const c = String.raw`D:\Copy\Rewrite\SiglusEngine.exe`
  assert.equal(exeFolder(b, [a, b, c]), String.raw`Games\Rewrite`, 'as many folders as it takes')
  assert.equal(exeFolder('/home/me/vn/game.exe', ['/home/me/other/game.exe']), 'vn')
})
