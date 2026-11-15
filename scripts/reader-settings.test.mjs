import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../frontend/texthooker/lib/settings.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  plugins: [
    {
      name: 'reader-settings-transport',
      setup(builder) {
        builder.onResolve({ filter: /^(?:@tauri-apps\/api\/(?:core|event)|\.\.\/\.\.\/bridge\/settings)$/ }, () => ({
          path: 'transport',
          namespace: 'test'
        }))
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: `
            const backend = globalThis.__readerSettingsTest;
            export const getSetting = (key, fallback) => backend.get(key, fallback);
            export const onSettingsChange = callback => { backend.change = callback; };
            export const invoke = (command, args) => backend.invoke(command, args);
            export const listen = async () => () => {};
          `
        }))
      }
    }
  ]
})

let sequence = 0
async function client(saved = {}) {
  const backend = {
    get: async (key, fallback) => (key === 'superTexthooker' ? saved : fallback),
    invoke: async (command, { patch }) => {
      assert.equal(command, 'reader_settings_patch')
      saved = { ...saved, ...patch }
      backend.change('superTexthooker', saved)
    }
  }
  globalThis.__readerSettingsTest = backend
  const source = compiled.outputFiles[0].text + `\n// instance ${sequence++}`
  const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  return { api, backend }
}

test('reopening settings shows the current line filter after a local change', async () => {
  const { api } = await client()
  assert.equal((await api.loadSettings()).japaneseFilter, 'noJapanese')
  for (const japaneseFilter of ['off', 'mostlyNonJapanese', 'noJapanese']) {
    await api.updateSettings({ japaneseFilter })
    // ReaderSettingsProvider calls loadSettings again each time Settings mounts.
    assert.equal((await api.loadSettings()).japaneseFilter, japaneseFilter)
  }
})

test('reopening settings shows changes received from another window', async () => {
  const { api, backend } = await client()
  await api.loadSettings()
  backend.change('superTexthooker', { japaneseFilter: 'off', audioVolume: 0.25 })
  const reopened = await api.loadSettings()
  assert.equal(reopened.japaneseFilter, 'off')
  assert.equal(reopened.audioVolume, 0.25)
  assert.equal(reopened, api.getSettings())
})

test('concurrent initial loads share their read and failed loads can be retried', async () => {
  const { api, backend } = await client()
  const originalGet = backend.get
  let reads = 0
  backend.get = async (key, fallback) => {
    if (key === 'superTexthooker' && ++reads === 1) throw Error('offline')
    return originalGet(key, fallback)
  }
  const first = api.loadSettings()
  assert.equal(api.loadSettings(), first)
  await assert.rejects(first, /offline/)
  assert.equal(api.isSettingsLoaded(), false)
  assert.equal((await api.loadSettings()).japaneseFilter, 'noJapanese')
  assert.equal(api.isSettingsLoaded(), true)
  assert.equal(reads, 2)
})
