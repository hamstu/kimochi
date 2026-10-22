/**
 * Notebook names in the Log (frontend/texthooker/lib/nameMatch.ts): what a line matches is decided
 * by its text and the notebook it is shown with, never by a line or notebook that came before.
 * Line ids restart at 1 in every session and after a clear, and each session's notebook counts its
 * own `cacheVersion`, so neither identifies what was matched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { getMatcher, matchLine } = await load('../frontend/texthooker/lib/nameMatch.ts')

const person = (id, family, given = '') => ({
  id,
  kind: 'person',
  family,
  given,
  aliases: [],
  matchEnabled: true,
  matchGivenAlone: true
})
const notebook = (cacheVersion, ...entries) => ({ version: 2, cacheVersion, entries })
const line = (id, text) => ({ id, text, source: 'ocr', ts: 0 })
const matched = (l, nb) =>
  matchLine(l, getMatcher(nb)).map((m) => [m.entryId, l.text.slice(m.start, m.end)])

const TEXT = 'ちなみに、タッチスクリーンを\n短くタッチすると、\n話したり調べたりもできるのよ。'

test('a line matches only names that are in its own text', () => {
  const nb = notebook(5, person('crono', 'Crono'))
  assert.deepEqual(matched(line(3, TEXT), nb), [])
  assert.deepEqual(matched(line(4, 'Crono woke up.'), nb), [['crono', 'Crono']])
})

test('another session’s line with the same id does not lend this one its matches', () => {
  const other = notebook(5, person('crono', 'Crono'))
  // Line 3 of another session, where the name is 29 characters in.
  const before = line(3, 'x'.repeat(29) + 'Crono and the rest.')
  assert.deepEqual(matched(before, other), [['crono', 'Crono']])
  // This session's line 3, with a notebook at the same cacheVersion.
  const mine = notebook(5, person('crono', 'Crono'))
  assert.deepEqual(matched(line(3, TEXT), mine), [])
})

test('a line whose text changes in place is matched again', () => {
  const nb = notebook(1, person('lucca', 'ルッカ'))
  const id = 7
  assert.deepEqual(matched(line(id, 'ルッカだ'), nb), [['lucca', 'ルッカ']])
  // A merged reading replaces the last line's text and keeps its id.
  assert.deepEqual(matched(line(id, 'こんにちは'), nb), [])
})

test('a different notebook at the same cacheVersion gets its own matcher', () => {
  const first = notebook(3, person('marle', 'マール'))
  const second = notebook(3, person('frog', 'カエル'))
  assert.deepEqual(matched(line(1, 'マールとカエル'), first), [['marle', 'マール']])
  assert.deepEqual(matched(line(1, 'マールとカエル'), second), [['frog', 'カエル']])
})
