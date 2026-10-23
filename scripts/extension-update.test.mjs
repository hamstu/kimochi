/**
 * A dictionary engine's background update after an app update moved its pin, as the UI reads it
 * (`ExtensionStatus.update`, ui/extension-download.ts): usable throughout, with the new release's
 * download in its own progress block, and the preview harness's scenarios for it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load } from './load.mjs'

const { normalizeExtensionStatus, updateDownload, updateLine, updateActions, isEngineReady, canRemoveExtension } =
  await load('extension-download.ts')

/** The `extension-download` payload of `ExtensionStatus::updating_from` in extension_store.rs. */
const payload = (update) => ({
  engine: 'yomitan',
  name: 'Yomitan',
  version: '26.10.22.0',
  state: 'ready',
  source: 'downloaded',
  file: null,
  receivedBytes: null,
  totalBytes: null,
  overallReceived: 15_392_420,
  overallTotal: 15_392_420,
  message: null,
  update: {
    from: '26.8.24.0',
    state: 'downloading',
    file: '26.10.22.0.zip',
    receivedBytes: 3_000_000,
    totalBytes: 15_392_420,
    overallReceived: 3_000_000,
    overallTotal: 15_392_420,
    message: null,
    retryAt: null,
    ...update
  }
})

test('an updating engine is ready, with its update beside it', () => {
  const status = normalizeExtensionStatus(payload({}))
  assert.equal(status.state, 'ready')
  assert.equal(isEngineReady(status), true, 'lookups keep working on the earlier release')
  assert.equal(canRemoveExtension(status), true)
  assert.deepEqual(status.update, {
    from: '26.8.24.0',
    state: 'downloading',
    file: '26.10.22.0.zip',
    receivedBytes: 3_000_000,
    totalBytes: 15_392_420,
    overallReceived: 3_000_000,
    overallTotal: 15_392_420,
    message: null,
    retryAt: null
  })
  const download = updateDownload(status)
  assert.equal(download.name, 'Yomitan 26.10.22.0')
  assert.equal(download.state, 'downloading')
  assert.equal(download.overallReceived, 3_000_000)
})

test('a status without an update, or with a malformed one, has none', () => {
  const plain = normalizeExtensionStatus({ ...payload({}), update: undefined })
  assert.equal(plain.update, null)
  assert.equal(updateDownload(plain), null)
  assert.deepEqual(updateActions(plain), [])
  assert.equal(updateLine(plain), '')
  for (const bad of [{ state: 'ready' }, { state: 'bogus' }, { from: 7 }]) {
    assert.equal(normalizeExtensionStatus(payload(bad)).update, null, JSON.stringify(bad))
  }
  assert.equal(updateDownload(null), null)
})

test('the update line names the new release, and the one still in use whenever it is stuck', () => {
  const line = (update) => updateLine(normalizeExtensionStatus(payload(update)))
  assert.equal(line({}), 'Updating to 26.10.22.0 · 3.0 MB of 15 MB')
  assert.equal(line({ state: 'verifying' }), 'Verifying 26.10.22.0…')
  assert.equal(line({ state: 'paused' }), 'Update to 26.10.22.0 paused at 19%. Using 26.8.24.0 until then.')
  assert.equal(
    line({ state: 'failed', message: 'network error', retryAt: 1_800_000_000 }),
    'Update to 26.10.22.0 failed: network error. Using 26.8.24.0 until then; Kimochi tries again later.'
  )
  assert.equal(line({ state: 'failed', message: null }), 'Update to 26.10.22.0 failed. Using 26.8.24.0 until then.')
  assert.equal(
    line({ state: 'absent', overallReceived: 0 }),
    'Update to 26.10.22.0 available · 15 MB. Using 26.8.24.0 until then.'
  )
})

test('the update offers pause, resume, retry or update, never cancel', () => {
  const actions = (state) => updateActions(normalizeExtensionStatus(payload({ state })))
  assert.deepEqual(actions('downloading'), ['pause'])
  assert.deepEqual(actions('paused'), ['resume'])
  assert.deepEqual(actions('failed'), ['retry'])
  assert.deepEqual(actions('absent'), ['download'])
  assert.deepEqual(actions('verifying'), [])
})

test('the preview harness and the studio can show an update under way and a failed one', async () => {
  const harness = await readFile(new URL('../frontend/dev/preview-extensions.ts', import.meta.url), 'utf8')
  assert.match(harness, /seeded === 'updating'/)
  assert.match(harness, /seeded === 'update-failed'/)
  const studio = await readFile(new URL('../frontend/dev/studio/surfaces.ts', import.meta.url), 'utf8')
  assert.match(studio, /\['updating', /)
  assert.match(studio, /\['update-failed', /)
})
