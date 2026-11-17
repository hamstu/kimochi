import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'
const { cleanTitle, confidentMatch, normalizeTitle, titleCandidates, vndbPlan, VNDB_SEARCH_AGAIN_MS } =
  await load('vndb-link.ts')
const { hookSettings } = await load('hook-games.ts')

test('names are cleaned of what stores and sharing sites add, as LunaTranslator cleans them', () => {
  assert.equal(cleanTitle('[RJ123456] 夏色ノスタルジア (同人ゲーム)'), '夏色ノスタルジア')
  assert.equal(cleanTitle('[2024-05-01] サマーポケッツ【体験版】'), 'サマーポケッツ')
  assert.equal(cleanTitle('ゲーム (Ver1.02)'), 'ゲーム')
})

test('the names searched for: window title, then folder, then exe, leaving out generic and short ones', () => {
  assert.deepEqual(
    titleCandidates('サマーポケッツ', String.raw`C:\Games\Summer Pockets REFLECTION BLUE\SiglusEngine.exe`),
    ['サマーポケッツ', 'Summer Pockets REFLECTION BLUE']
  )
  // An engine's exe and a short ASCII folder say nothing; the same name twice is searched once.
  assert.deepEqual(titleCandidates('', '/home/me/Games/sp/game.exe'), [])
  assert.deepEqual(titleCandidates('白昼夢の青写真', String.raw`D:\白昼夢の青写真\白昼夢の青写真.exe`), [
    '白昼夢の青写真'
  ])
  assert.deepEqual(titleCandidates(null, String.raw`D:\VN\Steins;Gate\Launcher.exe`), ['Steins;Gate'])
})

test('a result is taken only when one of its titles is the name, case, width and punctuation aside', () => {
  const results = [
    { id: 'v1', title: 'Summer Pockets', alttitle: 'サマーポケッツ', titles: [] },
    {
      id: 'v2',
      title: 'Summer Pockets Reflection Blue',
      titles: [{ title: 'Summer Pockets REFLECTION BLUE', lang: 'en' }]
    }
  ]
  assert.equal(confidentMatch('ｓｕｍｍｅｒ pockets!', results)?.id, 'v1')
  assert.equal(confidentMatch('Summer Pockets REFLECTION BLUE', results)?.id, 'v2')
  assert.equal(confidentMatch('Summer', results), null, 'a partial name is not sure enough')
  assert.equal(confidentMatch('', results), null)
  assert.equal(normalizeTitle('Steins;Gate 0'), 'steinsgate0')
})

test('a game is linked from the hook database, else searched, but never against the reader', () => {
  const now = 1_000_000_000_000
  assert.deepEqual(vndbPlan(undefined, { vndb: 'v20424', title: 'サマポケ' }, now), {
    kind: 'link',
    id: 'v20424',
    title: 'サマポケ'
  })
  assert.deepEqual(vndbPlan({}, null, now), { kind: 'search' })
  assert.deepEqual(vndbPlan({ vndb: { id: 'v1' } }, { vndb: 'v2' }, now), { kind: 'none' }, 'already linked')
  assert.deepEqual(vndbPlan({ vndb: null }, { vndb: 'v2' }, now), { kind: 'none' }, 'unlinked by the reader')
  assert.deepEqual(vndbPlan({ vndbSearchedAt: now - 1000 }, null, now), { kind: 'none' }, 'searched lately')
  assert.deepEqual(vndbPlan({ vndbSearchedAt: now - VNDB_SEARCH_AGAIN_MS - 1 }, null, now), { kind: 'search' })
})

test('the hook database is on unless turned off, for every game or one', () => {
  assert.equal(hookSettings(null, null).hookDatabase, true)
  assert.equal(hookSettings({ hookDatabase: false }, null).hookDatabase, false)
  assert.equal(hookSettings({ hookDatabase: false }, { hookDatabase: true }).hookDatabase, true)
})
