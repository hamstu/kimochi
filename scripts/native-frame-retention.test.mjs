import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

test('the real native bridge rejects a false retain reply instead of treating it as a pin', async () => {
  let answer = false
  globalThis.__TAURI__ = { core: { invoke: async () => answer } }
  const native = await load('native.js')
  await assert.rejects(native.retainFrame(3, true), /could not be retained/)
  answer = true
  assert.equal(await native.retainFrame(3, true), true)
  answer = false
  assert.equal(await native.retainFrame(3, false), false)
  delete globalThis.__TAURI__
})
