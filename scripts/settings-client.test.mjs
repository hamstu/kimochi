import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../frontend/bridge/settings.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  alias: { '@ui': fileURLToPath(new URL('../ui', import.meta.url)) },
  plugins: [{
    name: 'settings-transport',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/tauri$/ }, () => ({ path: 'transport', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
        const backend = globalThis.__settingsClientTest;
        export const settingsGet = key => backend.get(key);
        export const settingsSet = (key, value) => backend.set(key, value);
        export const settingsAll = () => Promise.resolve({});
        export const onSettingsChanged = callback => {
          backend.change = callback;
          return Promise.resolve(() => {});
        };
      ` }))
    }
  }]
})
let sequence = 0
async function client(backend) {
  globalThis.__settingsClientTest = backend
  const source = compiled.outputFiles[0].text + `\n// instance ${sequence++}`
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

test('concurrent setting reads share one IPC but keep each caller’s fallback', async () => {
  let calls = 0
  let resolve
  const api = await client({ get: () => { calls++; return new Promise(r => { resolve = r }) } })
  const requests = Array.from({ length: 100 }, (_, i) => api.getSetting('custom-key', i))
  assert.equal(calls, 1)
  resolve(null)
  assert.deepEqual(await Promise.all(requests), Array.from({ length: 100 }, (_, i) => i))
  const next = api.getSetting('custom-key')
  assert.equal(calls, 2, 'settled values are not cached')
  resolve('fresh')
  assert.equal(await next, 'fresh')
})

test('failed setting reads can be retried', async () => {
  let calls = 0
  const api = await client({ get: () => ++calls === 1 ? Promise.reject(Error('offline')) : Promise.resolve(42) })
  await assert.rejects(api.getSetting('custom-key'), /offline/)
  assert.equal(await api.getSetting('custom-key'), 42)
})

test('writes and external changes invalidate pending reads without old cleanup dropping a new read', async () => {
  const resolves = []
  const backend = { get: () => new Promise(r => resolves.push(r)), set: async () => {} }
  const api = await client(backend)
  api.onSettingsChange(() => {})
  const first = api.getSetting('custom-key')
  backend.change('custom-key', 2)
  const second = api.getSetting('custom-key')
  resolves[0](1)
  await first
  const shared = api.getSetting('custom-key')
  assert.equal(resolves.length, 2)
  resolves[1](2)
  assert.deepEqual(await Promise.all([second, shared]), [2, 2])
  const stale = api.getSetting('custom-key')
  await api.setSetting('custom-key', 3)
  const fresh = api.getSetting('custom-key')
  assert.equal(resolves.length, 4)
  resolves[2](2)
  resolves[3](3)
  assert.deepEqual(await Promise.all([stale, fresh]), [2, 3])
})
