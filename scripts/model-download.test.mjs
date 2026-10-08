import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from './load.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (file) => readFile(path.join(root, file), 'utf8')

const {
  badgeKind,
  badgeLabel,
  formatBytes,
  isModelEngine,
  modelActions,
  normalizeModelStatus,
  percent,
  progressText,
  showsProgress,
  stateLabel
} = await load('model-download.ts')
const { normalizeCapabilities, DEFAULT_CAPABILITIES_MACOS } = await load('capabilities.ts')

const MEIKI_TOTAL = 45970040
const status = (patch = {}) =>
  normalizeModelStatus({
    engine: 'meikiocr',
    name: 'MeikiOCR',
    state: 'absent',
    source: null,
    file: null,
    receivedBytes: null,
    totalBytes: null,
    overallReceived: 0,
    overallTotal: MEIKI_TOTAL,
    message: null,
    ...patch
  })

test('native model statuses are normalised and anything else is refused', () => {
  const s = status({ state: 'downloading', file: 'a.onnx', receivedBytes: 5, totalBytes: 10, overallReceived: 5 })
  assert.equal(s.state, 'downloading')
  assert.equal(s.receivedBytes, 5)
  assert.equal(s.source, null)
  assert.equal(normalizeModelStatus(null), null)
  assert.equal(normalizeModelStatus({ engine: 'cloud', state: 'ready' }), null)
  assert.equal(normalizeModelStatus({ engine: 'meikiocr', state: 'exploded' }), null)
  // Missing numbers read as zero rather than NaN in the progress bar.
  assert.equal(normalizeModelStatus({ engine: 'mangaocr', state: 'absent' }).overallTotal, 0)
  assert.equal(isModelEngine('meikiocr'), true)
  assert.equal(isModelEngine('cloud'), false)
})

test('percent rounds down like native, so 100% only ever means done', () => {
  assert.equal(percent(0, 0), 0)
  assert.equal(percent(329, 1000), 32)
  assert.equal(percent(999, 1000), 99)
  assert.equal(percent(1000, 1000), 100)
  assert.equal(percent(5000, 1000), 100)
  assert.equal(percent(-5, 1000), 0)
})

test('sizes read like a file manager shows them', () => {
  assert.equal(formatBytes(0), '0 MB')
  assert.equal(formatBytes(228), '1 KB')
  assert.equal(formatBytes(77546), '78 KB')
  assert.equal(formatBytes(4_200_000), '4.2 MB')
  assert.equal(formatBytes(MEIKI_TOTAL), '46 MB')
  assert.equal(formatBytes(538907077), '539 MB')
  assert.equal(formatBytes(1_234_000_000), '1.2 GB')
  assert.equal(progressText(14_503_825, MEIKI_TOTAL), '15 MB of 46 MB')
})

test('each state has its label, its buttons and its badge', () => {
  const cases = [
    [{ state: 'absent' }, 'Not downloaded', ['download'], 'warning'],
    [{ state: 'downloading', overallReceived: MEIKI_TOTAL * 0.325 }, 'Downloading… 32%', ['pause', 'cancel'], 'progress'],
    [{ state: 'verifying', file: 'a.onnx' }, 'Verifying…', ['cancel'], 'progress'],
    [{ state: 'paused', overallReceived: MEIKI_TOTAL / 2 }, 'Paused at 50%', ['resume', 'cancel'], 'warning'],
    [{ state: 'paused' }, 'Paused', ['resume', 'cancel'], 'warning'],
    [{ state: 'failed', message: 'x' }, 'Download failed', ['retry', 'cancel'], 'warning'],
    [{ state: 'ready', source: 'downloaded' }, 'Downloaded', ['delete'], null],
    [{ state: 'ready', source: 'bundled' }, 'Included with this build', [], null],
    [{ state: 'ready', source: 'development' }, 'Using the development copy', [], null]
  ]
  for (const [patch, label, actions, badge] of cases) {
    const s = status(patch)
    assert.equal(stateLabel(s), label, JSON.stringify(patch))
    assert.deepEqual(modelActions(s), actions, JSON.stringify(patch))
    assert.equal(badgeKind(s), badge, JSON.stringify(patch))
  }
  assert.equal(badgeKind(null), null)
  assert.match(badgeLabel(status({ state: 'failed', message: 'HTTP 503' })), /failed: HTTP 503\. Open OCR settings/)
})

test('progress bars show while busy and for a resumable partial download', () => {
  assert.equal(showsProgress(status({ state: 'downloading' })), true)
  assert.equal(showsProgress(status({ state: 'verifying' })), true)
  assert.equal(showsProgress(status({ state: 'paused', overallReceived: 10 })), true)
  assert.equal(showsProgress(status({ state: 'failed', overallReceived: 0 })), false)
  assert.equal(showsProgress(status({ state: 'ready', source: 'downloaded' })), false)
})

test('the capabilities carry the model gate and its human reason through normalisation', () => {
  const caps = normalizeCapabilities(
    {
      ocrEngines: {
        meikiocr: { available: false, reason: 'Downloading model… 32%', model: 'downloading' },
        mangaocr: { available: false, reason: 'Model download failed: huggingface.co answered HTTP 503', model: 'failed' }
      }
    },
    DEFAULT_CAPABILITIES_MACOS
  )
  assert.deepEqual(caps.ocrEngines.meikiocr, {
    available: false,
    reason: 'Downloading model… 32%',
    model: 'downloading'
  })
  assert.equal(caps.ocrEngines.mangaocr.model, 'failed')
  // A later payload without the gate (the models became ready) drops it.
  const ready = normalizeCapabilities(
    { ocrEngines: { meikiocr: { available: true, accelerator: 'coreml' } } },
    DEFAULT_CAPABILITIES_MACOS
  )
  assert.equal(ready.ocrEngines.meikiocr.model, undefined)
  assert.equal(ready.ocrEngines.meikiocr.available, true)
})

test('the native reasons are the strings the UI documents', async () => {
  const store = await read('src-tauri/src/model_store.rs')
  for (const reason of [
    '"Model not downloaded"',
    '"Downloading model… {}%"',
    '"Verifying model…"',
    '"Model download paused"',
    '"Model download failed: {message}"'
  ]) {
    assert.ok(store.includes(reason), `model_store.rs no longer says ${reason}`)
  }
  const commands = await read('COMMANDS.md')
  for (const reason of ['Downloading model… 32%', 'Model download paused', 'Model download failed:']) {
    assert.ok(commands.includes(reason), `COMMANDS.md does not document ${reason}`)
  }
})

test('every model command is registered, documented and reachable from the bridge', async () => {
  const main = await read('src-tauri/src/main.rs')
  const registered = new Set([...main.matchAll(/model_store::(model_[a-z_]+),/g)].map((m) => m[1]))
  const expected = [
    'model_status',
    'model_download_start',
    'model_download_pause',
    'model_download_resume',
    'model_download_retry',
    'model_download_cancel',
    'model_delete'
  ]
  assert.deepEqual([...registered].sort(), [...expected].sort())
  const commands = await read('COMMANDS.md')
  const bridge = await read('frontend/bridge/models.ts')
  for (const command of expected) {
    assert.ok(commands.includes(`\`${command}\``), `${command} is not in COMMANDS.md`)
    assert.ok(bridge.includes(`'${command}'`), `${command} is not called by frontend/bridge/models.ts`)
  }
  assert.ok(commands.includes('`model-download`'), 'the model-download event is not documented')
})

test('one manifest pins every model, and the bundle no longer carries them', async () => {
  const manifest = JSON.parse(await read('src-tauri/ocr-models.json'))
  for (const engine of ['meikiocr', 'mangaocr']) {
    const { files } = manifest.engines[engine]
    assert.ok(files.length > 0)
    for (const file of files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/, file.name)
      assert.ok(Number.isInteger(file.size) && file.size > 0, file.name)
      assert.match(file.url, /^https:\/\//, file.name)
      assert.doesNotMatch(file.name, /[\\/]/, file.name)
    }
  }
  // The staging scripts read the manifest instead of keeping their own copy of the checksums.
  for (const script of ['scripts/prepare-meikiocr.mjs', 'scripts/prepare-mangaocr.mjs']) {
    const source = await read(script)
    assert.ok(source.includes('src-tauri/ocr-models.json'), `${script} does not read the manifest`)
    for (const engine of Object.values(manifest.engines)) {
      for (const file of engine.files) {
        assert.ok(!source.includes(file.sha256), `${script} duplicates the checksum of ${file.name}`)
      }
    }
    assert.ok(source.includes('--with-models'), `${script} lost its --with-models opt-in`)
  }
  const config = JSON.parse(await read('src-tauri/tauri.conf.json'))
  const resources = Object.entries(config.bundle.resources)
  assert.ok(resources.length > 0)
  for (const [from, to] of resources) {
    assert.doesNotMatch(from, /models/, `${from} bundles models`)
    assert.doesNotMatch(to, /models/, `${to} bundles models`)
    // A whole engine directory would carry a developer's staged models along with it.
    assert.doesNotMatch(from, /^resources\/(meikiocr|mangaocr)\/?$/, `${from} bundles a whole engine directory`)
  }
  assert.ok(resources.some(([from]) => from === 'resources/meikiocr/runtime/'), 'the ONNX Runtime must stay bundled')
})
