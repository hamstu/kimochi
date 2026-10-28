import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { dictionaryPageReady } = await load('../frontend/panels/dictionaryPageState.ts')

test('a loaded hidden Yomitan body is not ready until its startup handshake reveals it', () => {
  assert.equal(dictionaryPageReady(null), false)
  assert.equal(dictionaryPageReady({ readyState: 'complete', body: { hidden: true } }), false)
  assert.equal(dictionaryPageReady({ readyState: 'loading', body: { hidden: false } }), false)
  assert.equal(dictionaryPageReady({ readyState: 'complete', body: { hidden: false } }), true)
})
