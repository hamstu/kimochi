import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { waitForDictionarySetup } = await load('dictionary-setup-switch.ts')

test('engine switching waits through download and import, then proceeds on completion', async () => {
  const jobs = [{ stage: 'downloading' }, { stage: 'importing' }, null]
  let waits = 0
  await waitForDictionarySetup(async () => jobs.shift(), () => waits++, async () => {})
  assert.equal(waits, 2)
})

test('failed jobs allow another engine; relay errors stop the switch instead of reloading', async () => {
  await waitForDictionarySetup(async () => ({ stage: 'failed' }), () => assert.fail('must not wait'))
  await assert.rejects(waitForDictionarySetup(async () => { throw Error('Disconnected') }, () => {}), /Disconnected/)
})
