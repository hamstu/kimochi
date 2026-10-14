/**
 * The dictionary engine table and its helpers (ui/settings.ts; DICTIONARY_ENGINES.md §1, §2).
 *
 * The stored spelling (`yomitanSettings.popupType`) and the engine names differ for Yomitan
 * (`'builtin'` ↔ `'yomitan'`), and the document-start mirror holds a HOST engine (Kimochi's
 * pop-up runs over Yomitan's). A slip in any of these mappings shows up as a window that installs
 * the wrong host, so they are pinned here, compiled from the real module like settings-defaults.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const outDir = await mkdtemp(path.join(tmpdir(), 'kimochi-dictionary-engines-'))
const outfile = path.join(outDir, 'settings.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../ui/settings.ts', import.meta.url))],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022'
})
const {
  DICTIONARY_ENGINES,
  DICTIONARY_ENGINE_KEY,
  ENGINE_SWITCH_KEY,
  ENGINE_SWITCH_TTL_MS,
  SETTINGS_DEFAULTS,
  decodeEngineSwitch,
  encodeEngineSwitch,
  dictionaryEngine,
  dictionaryEngineOf,
  hostEngineOf,
  popupTypeOf,
  resolveDictionaryEngine,
  resolveHostEngine,
  NO_ENGINE_MESSAGE,
  withDefaults
} = await import(pathToFileURL(outfile).href)
process.on('exit', () => {
  rm(outDir, { recursive: true, force: true }).catch(() => {})
})

const readJson = async (relative) =>
  JSON.parse(await readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'))

test('the chooser lists the four engines, Yomitan first', () => {
  assert.deepEqual(Object.keys(DICTIONARY_ENGINES), ['yomitan', 'hachidori', 'tenten', 'custom-api'])
})

test('every engine has the copy the chooser draws', () => {
  for (const [id, info] of Object.entries(DICTIONARY_ENGINES)) {
    for (const field of ['name', 'tagline', 'description', 'requirements', 'licence', 'upstream']) {
      assert.equal(typeof info[field], 'string', `${id}.${field}`)
      assert.ok(info[field].length > 0, `${id}.${field} is empty`)
    }
    assert.ok(info.strengths.length >= 2 && info.strengths.length <= 4, `${id} strengths`)
    assert.ok(['local', 'online'].includes(info.runs), `${id}.runs`)
    assert.match(info.upstream, /^https:\/\//, `${id}.upstream`)
  }
  assert.equal(DICTIONARY_ENGINES['custom-api'].runs, 'local')
  assert.equal(DICTIONARY_ENGINES['custom-api'].optionsPage, null)
  assert.equal(DICTIONARY_ENGINES['custom-api'].experimental, true)
})

test('options pages are the ones the dictionary window loads (§3)', () => {
  assert.equal(DICTIONARY_ENGINES.yomitan.optionsPage, 'settings.html')
  assert.equal(DICTIONARY_ENGINES.hachidori.optionsPage, 'settings.html')
  assert.equal(DICTIONARY_ENGINES.tenten.optionsPage, 'options.html')
})

test('versions and licences match the pinned releases', async () => {
  for (const id of ['yomitan', 'hachidori', 'tenten']) {
    const source = await readJson(`../extensions/${id}.source.json`)
    const manifest = await readJson(`../extensions/${id}.manifest.json`)
    assert.equal(manifest.version, source.version, `${id}.manifest.json is the pinned release's`)
    assert.equal(DICTIONARY_ENGINES[id].version, source.version, `${id} version`)
    assert.equal(DICTIONARY_ENGINES[id].licence, source.license, `${id} licence`)
    assert.equal(DICTIONARY_ENGINES[id].upstream, source.upstream, `${id} upstream`)
  }
})

test("Hachidori's requirements say it runs single-threaded here", () => {
  assert.match(DICTIONARY_ENGINES.hachidori.requirements, /single-threaded/)
})

test('dictionaryEngineOf maps the stored spelling, defaulting to Yomitan', () => {
  assert.equal(dictionaryEngineOf('builtin'), 'yomitan')
  assert.equal(dictionaryEngineOf('custom-api'), 'custom-api')
  assert.equal(dictionaryEngineOf('hachidori'), 'hachidori')
  assert.equal(dictionaryEngineOf('tenten'), 'tenten')
  for (const unknown of [undefined, null, '', 'yomichan', 'toString', 42, {}]) {
    assert.equal(dictionaryEngineOf(unknown), 'yomitan', String(unknown))
  }
  assert.equal(dictionaryEngine, dictionaryEngineOf)
})

test('popupTypeOf is its inverse for every engine', () => {
  for (const engine of Object.keys(DICTIONARY_ENGINES)) {
    assert.equal(dictionaryEngineOf(popupTypeOf(engine)), engine)
  }
  assert.equal(popupTypeOf('yomitan'), 'builtin')
  assert.equal(popupTypeOf('custom-api'), 'custom-api')
})

test('the Yomitan API engine runs over the Yomitan host', () => {
  assert.equal(hostEngineOf('custom-api'), 'yomitan')
  assert.equal(hostEngineOf('yomitan'), 'yomitan')
  assert.equal(hostEngineOf('hachidori'), 'hachidori')
  assert.equal(hostEngineOf('tenten'), 'tenten')
})

test('document-start resolution: mirror, then prelude, then Yomitan (§2)', () => {
  assert.equal(DICTIONARY_ENGINE_KEY, 'kimochi.dictionaryEngine')
  assert.equal(resolveDictionaryEngine(null, undefined), 'yomitan')
  assert.equal(resolveDictionaryEngine('tenten', 'hachidori'), 'tenten')
  assert.equal(resolveDictionaryEngine(null, 'hachidori'), 'hachidori')
  assert.equal(resolveDictionaryEngine(undefined, 'builtin'), 'yomitan')
  assert.equal(resolveDictionaryEngine('yomitan', 'tenten'), 'yomitan')
  assert.equal(resolveDictionaryEngine('custom-api', null), 'custom-api')
  assert.equal(resolveDictionaryEngine('garbage', null), 'yomitan')
})

test('the stored default is still Yomitan, spelled builtin', () => {
  assert.deepEqual(SETTINGS_DEFAULTS.yomitanSettings, { popupType: 'builtin', customApiUrl: '' })
})

test('withDefaults keeps known engines and reads an unknown one as Yomitan', () => {
  for (const popupType of ['builtin', 'custom-api', 'hachidori', 'tenten']) {
    assert.deepEqual(withDefaults('yomitanSettings', { popupType, customApiUrl: 'http://x' }), {
      popupType,
      customApiUrl: 'http://x'
    })
  }
  assert.deepEqual(withDefaults('yomitanSettings', { popupType: 'future-engine' }), {
    popupType: 'builtin',
    customApiUrl: ''
  })
  assert.deepEqual(withDefaults('yomitanSettings', null), SETTINGS_DEFAULTS.yomitanSettings)
})

// The record a switch leaves in the main window's sessionStorage so its reload lands back on
// Settings → Dictionary (frontend/main/engineSwitch.ts; DICTIONARY_ENGINES.md §2).
const switchRecord = (overrides = {}) => ({
  engine: 'hachidori',
  view: 'settings',
  tab: 'dictionary',
  back: 'notebook',
  scrollTop: 240,
  at: 1_000_000,
  ...overrides
})

test('a switch record survives the round trip through sessionStorage', () => {
  assert.equal(ENGINE_SWITCH_KEY, 'kimochi.engineSwitch')
  const record = switchRecord()
  assert.deepEqual(decodeEngineSwitch(encodeEngineSwitch(record), record.at + 800), record)
})

test('a switch record is only this reload\'s: stale, future and malformed ones are dropped', () => {
  const raw = encodeEngineSwitch(switchRecord())
  assert.equal(decodeEngineSwitch(raw, 1_000_000 + ENGINE_SWITCH_TTL_MS + 1), null)
  assert.ok(decodeEngineSwitch(raw, 1_000_000 + ENGINE_SWITCH_TTL_MS))
  assert.equal(decodeEngineSwitch(raw, 1_000_000 - 60_000), null)
  for (const bad of [null, undefined, '', 'not json', '42', 'null', '[]']) {
    assert.equal(decodeEngineSwitch(bad, 1_000_000), null, String(bad))
  }
  for (const overrides of [
    { engine: 'builtin' },
    { engine: 'toString' },
    { view: 'dictionary' },
    { tab: '' },
    { tab: 7 },
    { at: 'now' },
    { at: Number.NaN }
  ]) {
    assert.equal(decodeEngineSwitch(encodeEngineSwitch(switchRecord(overrides)), 1_000_000), null, JSON.stringify(overrides))
  }
})

test('a switch made from the sidebar reopens the Log or Notebook it was made from', () => {
  for (const view of ['log', 'notebook']) {
    const record = switchRecord({ view })
    assert.deepEqual(decodeEngineSwitch(encodeEngineSwitch(record), record.at + 800), record)
  }
})

test('a switch record normalises what it can rather than dropping the route', () => {
  const decoded = decodeEngineSwitch(
    JSON.stringify(switchRecord({ engine: 'custom-api', back: 'settings', scrollTop: -5 })),
    1_000_000
  )
  assert.equal(decoded.engine, 'custom-api')
  assert.equal(decoded.back, 'log')
  assert.equal(decoded.scrollTop, 0)
  const withoutScroll = switchRecord()
  delete withoutScroll.scrollTop
  assert.equal(decodeEngineSwitch(JSON.stringify(withoutScroll), 1_000_000).scrollTop, 0)
})

test("resolveHostEngine keeps 'none' (no engine downloaded) and otherwise resolves like the hosts", () => {
  assert.equal(resolveHostEngine('none', 'yomitan'), 'none', 'the mirror wins')
  assert.equal(resolveHostEngine(null, 'none'), 'none', 'the prelude when there is no mirror')
  assert.equal(resolveHostEngine(undefined, undefined), 'yomitan')
  assert.equal(resolveHostEngine('custom-api', null), 'yomitan')
  assert.equal(resolveHostEngine('builtin', null), 'yomitan')
  assert.equal(resolveHostEngine('tenten', 'none'), 'tenten')
  assert.match(NO_ENGINE_MESSAGE, /Settings → Dictionary/)
})

test('each downloadable engine says it is downloaded when chosen, and how big (its pinned size)', async () => {
  for (const id of ['yomitan', 'hachidori', 'tenten']) {
    const { asset } = await readJson(`../extensions/${id}.source.json`)
    const mb = Math.round(asset.size / 1e6)
    assert.match(DICTIONARY_ENGINES[id].requirements, new RegExp(`Downloaded .* \\(about ${mb} MB\\)`), id)
  }
})
