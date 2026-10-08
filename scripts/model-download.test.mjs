import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from './load.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (file) => readFile(path.join(root, file), 'utf8')

const {
  actionLabel,
  badgeKind,
  badgeLabel,
  barPercent,
  canRemoveModel,
  primaryModelActions,
  showsBar,
  downloadPrompt,
  engineChoice,
  formatBytes,
  isModelEngine,
  modelActions,
  normalizeModelStatus,
  percent,
  progressText,
  statusLine
} = await load('model-download.ts')
const { normalizeCapabilities, DEFAULT_CAPABILITIES_MACOS } = await load('capabilities.ts')
const { acceleratorLabel, engineHint, engineSelectable } = await load('ocr-engines.ts')
const { OCR_MODES } = await load('settings.ts')

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

const MANGA_TOTAL = 538907077
const manga = (patch = {}) =>
  normalizeModelStatus({ engine: 'mangaocr', name: 'Manga OCR', state: 'absent', overallTotal: MANGA_TOTAL, ...patch })

test('each state has one status line, one bar, its buttons and its badge', () => {
  const cases = [
    [{ state: 'absent' }, 'Not downloaded · 539 MB', 0, ['download'], 'warning'],
    [{ state: 'downloading', overallReceived: 212e6 }, 'Downloading Manga OCR · 212 MB of 539 MB', 39, ['pause', 'cancel'], 'progress'],
    [{ state: 'verifying', file: 'a.onnx', overallReceived: MANGA_TOTAL }, 'Verifying…', 100, ['cancel'], 'progress'],
    [{ state: 'paused', overallReceived: MANGA_TOTAL * 0.405 }, 'Paused at 40%', 40, ['resume', 'cancel'], 'warning'],
    [{ state: 'paused' }, 'Paused', 0, ['resume', 'cancel'], 'warning'],
    [{ state: 'failed', message: 'HTTP 503', overallReceived: 1e6 }, 'Download failed: HTTP 503', 0, ['retry', 'cancel'], 'warning'],
    [{ state: 'failed' }, 'Download failed', 0, ['retry', 'cancel'], 'warning'],
    [{ state: 'ready', source: 'downloaded' }, 'Ready · 539 MB', 100, ['delete'], null],
    [{ state: 'ready', source: 'bundled' }, 'Ready · included with this build', 100, [], null],
    [{ state: 'ready', source: 'development' }, 'Ready · using the development copy', 100, [], null]
  ]
  for (const [patch, line, bar, actions, badge] of cases) {
    const s = manga(patch)
    assert.equal(statusLine(s), line, JSON.stringify(patch))
    assert.equal(barPercent(s), bar, JSON.stringify(patch))
    // The bar is only shown while something is happening; before and after, the line stands alone.
    assert.equal(showsBar(s), !['absent', 'ready'].includes(s.state), JSON.stringify(patch))
    assert.deepEqual(modelActions(s), actions, JSON.stringify(patch))
    assert.equal(badgeKind(s), badge, JSON.stringify(patch))
  }
  assert.equal(badgeKind(null), null)
  assert.match(badgeLabel(status({ state: 'failed', message: 'HTTP 503' })), /failed: HTTP 503\. Open OCR settings/)
})

test('the Download button names the size, since pressing it is the consent', () => {
  assert.equal(actionLabel('download', manga()), 'Download (539 MB)')
  assert.equal(actionLabel('download', status()), 'Download (46 MB)')
  assert.equal(actionLabel('download', manga({ overallTotal: 0 })), 'Download')
  assert.equal(actionLabel('pause', manga()), 'Pause')
  assert.equal(actionLabel('delete', manga()), 'Delete')
})

test('picking an engine asks first only when its model was never downloaded', () => {
  assert.equal(engineChoice('mangaocr', manga()), 'confirm')
  assert.equal(engineChoice('meikiocr', status()), 'confirm')
  for (const state of ['downloading', 'verifying', 'paused', 'failed']) {
    assert.equal(engineChoice('mangaocr', manga({ state })), 'select', state)
  }
  assert.equal(engineChoice('mangaocr', manga({ state: 'ready', source: 'downloaded' })), 'select')
  assert.equal(engineChoice('mangaocr', manga({ state: 'ready', source: 'bundled' })), 'select')
  // Cloud engines have no model; a backend without model downloads answers nothing.
  assert.equal(engineChoice('cloud', null), 'select')
  assert.equal(engineChoice('websocket', null), 'select')
  assert.equal(engineChoice('mangaocr', null), 'select')
  // A status for another engine says nothing about this one.
  assert.equal(engineChoice('mangaocr', status()), 'select')
})

test('the download confirmation names the engine and its size', () => {
  const prompt = downloadPrompt(manga())
  assert.equal(prompt.title, 'Download Manga OCR?')
  assert.match(prompt.description, /about 539 MB/)
  assert.match(prompt.description, /downloaded now/)
  assert.doesNotMatch(downloadPrompt(manga({ overallTotal: 0 })).description, /0 MB/)
})

test('both engine pickers share the confirmation and list engines by name alone', async () => {
  for (const file of ['frontend/main/MainSidebar.tsx', 'frontend/panels/settings/EngineChooser.tsx']) {
    const source = await read(file)
    assert.ok(source.includes('useEngineSelection()'), `${file} does not use useEngineSelection`)
    assert.ok(source.includes('<DownloadConfirmDialog'), `${file} does not render DownloadConfirmDialog`)
    assert.ok(!/useSetting<OcrMode>\('ocrMode'/.test(source), `${file} still writes ocrMode directly`)
  }
  const ocrTab = await read('frontend/panels/settings/OcrTab.tsx')
  assert.ok(ocrTab.includes('<EngineChooser />'), 'Settings → OCR & Overlay no longer shows the engine chooser')
  assert.ok(!ocrTab.includes('useEngineSelection'), 'OcrTab picks the engine itself instead of through EngineChooser')
  // The name is the name: where a download stands is a separate hint, never a label suffix.
  const sidebar = await read('frontend/main/MainSidebar.tsx')
  assert.ok(sidebar.includes('label: OCR_MODES[value].label\n'), 'the sidebar picker labels engines with more than their name')
  const chooser = await read('frontend/panels/settings/EngineChooser.tsx')
  // The name, then where the engine runs as an icon; never a download-state suffix.
  assert.match(
    chooser,
    /<span className="engine-item-name">\s*\{info\.name\}\s*<RunsIcon mode=\{mode\} \/>\s*<\/span>/,
    'the list labels engines with more than their name'
  )
  assert.ok(chooser.includes('engineHint(capability, status)'), 'the list no longer shows the download state as a hint')
})

test('the engine list is a listbox whose arrow keys look and whose Enter chooses', async () => {
  const chooser = await read('frontend/panels/settings/EngineChooser.tsx')
  assert.ok(chooser.includes('role="listbox"') && chooser.includes('role="option"'), 'the list lost its listbox semantics')
  assert.ok(chooser.includes('aria-selected={active}'), 'the chosen engine is not aria-selected')
  for (const key of ["'ArrowDown'", "'ArrowUp'", "'Home'", "'End'", "'Enter'", "' '"]) {
    assert.ok(chooser.includes(`case ${key}:`), `the list does not handle ${key}`)
  }
  assert.ok(chooser.includes('Use this engine'), 'the panel no longer offers to use the engine it shows')
})

test('removing a downloaded model lives in the overflow menu, not beside the bar', async () => {
  const block = await read('frontend/panels/settings/ModelDownload.tsx')
  assert.ok(block.includes('primaryModelActions(status)'), 'the download block offers every action, Delete included')
  const buttons = block.slice(block.indexOf('export function ModelDownload'), block.indexOf('export function RemoveModelDialog'))
  assert.ok(buttons.includes('<Button'), 'the download block has no buttons')
  assert.ok(!buttons.includes("'danger'") && !buttons.includes("'delete'"), 'the download block still has a Delete button')
  const chooser = await read('frontend/panels/settings/EngineChooser.tsx')
  assert.match(
    chooser,
    /<MenuItem[\s\S]*?disabled=\{!canRemoveModel\(model\.status\)[\s\S]*?Remove downloaded model…[\s\S]*?<\/MenuItem>/
  )
  assert.ok(chooser.includes('<RemoveModelDialog'), 'the removal is no longer confirmed')
})

test('the OCR page is "OCR & Overlay" and still answers to ocr', async () => {
  const nav = await read('frontend/panels/settings/settingsNav.tsx')
  assert.ok(nav.includes("{ value: 'ocr', label: 'OCR & Overlay'"), 'the nav entry is not OCR & Overlay on the ocr value')
  const ocrTab = await read('frontend/panels/settings/OcrTab.tsx')
  assert.ok(ocrTab.includes('title="OCR & Overlay"'), 'the page title is not OCR & Overlay')
})

test('only Delete leaves the buttons, and only a downloaded model can be removed', () => {
  for (const state of ['absent', 'downloading', 'verifying', 'paused', 'failed']) {
    const s = manga({ state })
    assert.deepEqual(primaryModelActions(s), modelActions(s), state)
    assert.equal(canRemoveModel(s), false, state)
  }
  assert.deepEqual(primaryModelActions(manga({ state: 'ready', source: 'downloaded' })), [])
  assert.equal(canRemoveModel(manga({ state: 'ready', source: 'downloaded' })), true)
  assert.equal(canRemoveModel(manga({ state: 'ready', source: 'bundled' })), false)
  assert.equal(canRemoveModel(manga({ state: 'ready', source: 'development' })), false)
  assert.equal(canRemoveModel(null), false)
})

test('each engine in the list says where it stands in a few words', () => {
  const ready = { available: true }
  const cases = [
    [manga(), 'Not downloaded', 'neutral'],
    [manga({ state: 'downloading', overallReceived: MANGA_TOTAL * 0.325 }), 'Downloading 32%', 'progress'],
    [manga({ state: 'downloading', overallTotal: 0 }), 'Downloading', 'progress'],
    [manga({ state: 'verifying' }), 'Verifying…', 'progress'],
    [manga({ state: 'paused', overallReceived: MANGA_TOTAL * 0.405 }), 'Paused at 40%', 'warn'],
    [manga({ state: 'paused' }), 'Paused', 'warn'],
    [manga({ state: 'failed', message: 'HTTP 503' }), 'Download failed', 'warn']
  ]
  for (const [s, text, tone] of cases) {
    const hint = engineHint(ready, s)
    assert.equal(hint.text, text, s.state)
    assert.equal(hint.tone, tone, s.state)
  }
  assert.equal(engineHint(ready, manga({ state: 'failed', message: 'HTTP 503' })).reason, 'HTTP 503')
  assert.equal(engineHint(ready, manga({ state: 'ready', source: 'downloaded' })), null)
  // A cloud engine, or a local one before its status arrives, with nothing to report.
  assert.equal(engineHint(ready, null), null)
  assert.equal(engineHint(undefined, null), null)
  // Until the live status arrives, the capability's model gate speaks.
  assert.deepEqual(
    engineHint({ available: false, reason: 'Downloading model… 32%', model: 'downloading' }, null),
    { text: 'Downloading', tone: 'progress', reason: 'Downloading model… 32%' }
  )
  assert.equal(
    engineHint({ available: false, reason: 'Model not downloaded', model: 'absent' }, null).text,
    'Not downloaded'
  )
  // Cannot run here at all: "Unavailable", with the reason for the tooltip, whatever the model says.
  assert.deepEqual(engineHint({ available: false, reason: 'Not available on Windows yet' }, manga()), {
    text: 'Unavailable',
    tone: 'muted',
    reason: 'Not available on Windows yet'
  })
  assert.equal(engineHint({ available: false }, null).reason, 'Not available on this computer')
})

test('only an engine this computer cannot run at all is held back from being chosen', () => {
  assert.equal(engineSelectable({ available: false, selectable: true }), true)
  assert.deepEqual(engineHint({ available: false, selectable: true, reason: 'Missing OneOCR files' }, null), {
    text: 'Setup needed', tone: 'warn', reason: 'Missing OneOCR files'
  })
  assert.equal(engineSelectable(undefined), true)
  assert.equal(engineSelectable({ available: true }), true)
  assert.equal(engineSelectable({ available: false, model: 'absent' }), true)
  assert.equal(engineSelectable({ available: false, reason: 'Not available on Windows yet' }), false)
  assert.equal(acceleratorLabel('coreml'), 'the GPU and Neural Engine, through Core ML')
  assert.equal(acceleratorLabel('cpu'), 'the CPU')
  assert.equal(acceleratorLabel(undefined), null)
})

test('every engine has the copy the chooser shows', () => {
  const modes = Object.keys(OCR_MODES)
  for (const mode of ['cloud', 'meikiocr', 'mangaocr', 'websocket']) assert.ok(modes.includes(mode), mode)
  for (const [mode, info] of Object.entries(OCR_MODES)) {
    for (const field of ['label', 'name', 'tagline', 'description', 'requirements']) {
      assert.equal(typeof info[field], 'string', `${mode}.${field}`)
      assert.ok(info[field].trim().length > 0, `${mode}.${field} is empty`)
    }
    assert.equal(typeof info.geometry, 'boolean', `${mode}.geometry`)
    assert.ok(Array.isArray(info.strengths) && info.strengths.length >= 2, `${mode} needs strengths`)
    assert.ok(['local', 'online'].includes(info.runs), `${mode} must say where it runs`)
    for (const strength of info.strengths) assert.ok(strength.trim().length > 0, `${mode} has an empty strength`)
    // A tagline fits one line of the list's third of the width.
    assert.ok(info.tagline.length <= 34, `${mode}.tagline is too long for the list`)
  }
})

test('no model download starts at launch, only when ocrMode is saved', async () => {
  const main = await read('src-tauri/src/main.rs')
  const calls = [...main.matchAll(/model_store::on_engine_selected\(/g)]
  assert.equal(calls.length, 1, 'on_engine_selected is called from more than settings_set')
  const settingsSet = main.slice(main.indexOf('fn settings_set'), main.indexOf('fn settings_all'))
  assert.ok(settingsSet.includes('model_store::on_engine_selected('), 'settings_set no longer starts the download')
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
