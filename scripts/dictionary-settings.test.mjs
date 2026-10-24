/**
 * Settings → Dictionary and Settings → Anki decisions: what the engine in use says while it is not
 * ready (ui/dictionary-readiness.ts), and when the Yomitan API pop-up offers Add to Anki, in the
 * Log (frontend/texthooker/lib/ankiConfig.ts) and over the game (ui/api-lookup.js).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const outDir = await mkdtemp(path.join(tmpdir(), 'kimochi-dictionary-settings-'))
test.after(() => rm(outDir, { recursive: true, force: true }))

async function bundle(entry, name, external = []) {
  const outfile = path.join(outDir, name)
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external,
    alias: {
      '@ui': fileURLToPath(new URL('../ui', import.meta.url)),
      '@texthooker': fileURLToPath(new URL('../frontend/texthooker', import.meta.url))
    }
  })
  return import(pathToFileURL(outfile).href)
}

const { readinessView } = await bundle('../ui/dictionary-readiness.ts', 'readiness.mjs')
const { buildAnkiConfigForPopover, ankiMiningGap } = await bundle('../frontend/texthooker/lib/ankiConfig.ts', 'anki-config.mjs')
const { popupAnkiConfig } = await bundle('../ui/api-lookup.js', 'api-lookup.mjs', ['/spike/*'])

const starting = { phase: 'starting', settingsReady: false, message: 'Starting the dictionary…' }

test('an engine in use that is not downloaded says so, not "Starting" forever, and has no settings to open', () => {
  for (const download of ['absent', 'paused', 'failed']) {
    const view = readinessView(starting, download, 'Hachidori')
    assert.equal(view.show, true)
    assert.equal(view.busy, false, 'nothing is under way')
    assert.match(view.text, /Hachidori is not downloaded yet/)
    assert.equal(view.badge.label, 'Not downloaded')
    assert.equal(view.settingsAvailable, false)
  }
  const downloading = readinessView(starting, 'downloading', '10ten')
  assert.equal(downloading.busy, true)
  assert.match(downloading.text, /^Downloading 10ten/)
  assert.equal(downloading.badge.label, 'Downloading')
  // Even a readiness left over from earlier in the session cannot open a page that is not there.
  assert.equal(readinessView({ ...starting, phase: 'ready', settingsReady: true }, 'absent', 'X').settingsAvailable, false)
})

test('a downloaded engine follows its readiness', () => {
  const ready = readinessView({ phase: 'ready', settingsReady: true, message: 'Hachidori is ready.' }, 'ready', 'Hachidori')
  assert.equal(ready.show, false)
  assert.deepEqual(ready.badge, { label: 'Active', tone: 'accent' })
  assert.equal(ready.settingsAvailable, true)
  // No download to report (the Yomitan API, an older backend) counts as downloaded.
  assert.equal(readinessView({ phase: 'ready', settingsReady: true, message: '' }, null, 'Yomitan API').show, false)

  const start = readinessView(starting, 'ready', 'Hachidori')
  assert.equal(start.busy, true)
  assert.equal(start.badge.label, 'Setting up')
  assert.equal(start.settingsAvailable, false)
  assert.equal(start.text, 'Starting the dictionary… Words are looked up once setup is complete.')
})

test("the note joins the engine's message as sentences, and tells the truth about lookups", () => {
  // Hachidori's progress message has no full stop of its own.
  const hachidori = readinessView(
    { phase: 'downloading', settingsReady: true, message: 'Hachidori is downloading dictionary data: 25%', progress: 25 },
    'ready',
    'Hachidori'
  )
  assert.equal(hachidori.text, 'Hachidori is downloading dictionary data: 25%. Words are looked up once setup is complete.')
  assert.equal(hachidori.progress, 25)
  // 10ten looks words up from its bundled list while its full dictionaries download.
  const tenten = readinessView(
    { phase: 'downloading', settingsReady: true, message: '10ten is downloading words data: 42%', progress: 42, lookups: true },
    'ready',
    '10ten'
  )
  assert.match(tenten.text, /Words are already looked up meanwhile\.$/)
  assert.doesNotMatch(tenten.text, /once setup is complete/)
  // A failure needs the user: no promise that it completes on its own.
  const failed = readinessView(
    { phase: 'failed', settingsReady: false, message: 'Yomitan could not start. Choose another dictionary engine and switch back to retry.' },
    'ready',
    'Built-in Yomitan'
  )
  assert.equal(failed.tone, 'warn')
  assert.equal(failed.busy, false)
  assert.equal(failed.badge.label, 'Needs attention')
  assert.equal(failed.text, 'Yomitan could not start. Choose another dictionary engine and switch back to retry.')
  assert.equal(readinessView({ phase: 'setup-needed', settingsReady: true, message: 'Open Hachidori settings to install or import a dictionary.' }, 'ready', 'Hachidori').settingsAvailable, true)
})

const reader = {
  ankiEnabled: true,
  ankiConnectUrl: 'http://127.0.0.1:8765',
  ankiDeckName: 'Mining',
  ankiModelName: 'Lapis',
  ankiModelFields: ['Expression', 'Sentence'],
  ankiFieldMappings: [{ ankiField: 'Expression', mappingType: 'marker', marker: 'expression' }],
  ankiTags: ['kimochi']
}

test('the pop-up over the game offers Add to Anki only when the Log pop-up would', () => {
  for (const settings of [
    reader,
    { ...reader, ankiEnabled: false },
    { ...reader, ankiDeckName: null },
    { ...reader, ankiModelName: null },
    { ...reader, ankiModelFields: [] },
    { ...reader, ankiConnectUrl: '' }
  ]) {
    assert.deepEqual(popupAnkiConfig(settings), buildAnkiConfigForPopover(settings), JSON.stringify(settings))
  }
  assert.equal(popupAnkiConfig({ ...reader, ankiDeckName: null }), null)
  assert.equal(popupAnkiConfig({}), null, 'reader settings never saved')
  assert.equal(popupAnkiConfig({ ...reader, ankiModelFields: undefined }), null)
  assert.equal(popupAnkiConfig({ ...reader, ankiConnectUrl: '' }).ankiConnectUrl, 'http://127.0.0.1:8765')
  assert.equal(buildAnkiConfigForPopover({ ...reader, ankiConnectUrl: '  ' }).ankiConnectUrl, 'http://127.0.0.1:8765')
})

test('Settings → Anki says what mining still needs before the pop-up shows Add to Anki', () => {
  assert.equal(ankiMiningGap(reader), null)
  assert.match(ankiMiningGap({ ...reader, ankiDeckName: null, ankiModelName: null }), /Choose a deck and a note type/)
  assert.match(ankiMiningGap({ ...reader, ankiDeckName: null }), /Choose a deck before/)
  assert.match(ankiMiningGap({ ...reader, ankiModelName: null }), /Choose a note type before/)
  assert.match(ankiMiningGap({ ...reader, ankiModelFields: [] }), /Open Anki/)
  assert.equal(ankiMiningGap({ ...reader, ankiModelFields: [] }, true), null, 'fields just read, being saved')
  // Exactly when the pop-up has no Anki config while mining is on.
  for (const settings of [reader, { ...reader, ankiDeckName: null }, { ...reader, ankiModelFields: [] }]) {
    assert.equal(ankiMiningGap(settings) === null, buildAnkiConfigForPopover(settings) !== null)
  }
})
