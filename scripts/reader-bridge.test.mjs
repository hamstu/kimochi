import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../frontend/texthooker/bridge.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  plugins: [
    {
      name: 'reader-events',
      setup(builder) {
        builder.onResolve({ filter: /^@tauri-apps\/api\// }, (args) => ({ path: args.path, namespace: 'mock' }))
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
          contents: `
      const backend = globalThis.__readerBridgeTest;
      export const listen = (...args) => backend.listen(...args);
      export const emit = (...args) => backend.emit(...args);
      export const getCurrentWindow = () => ({label: 'log'});
    `
        }))
      }
    }
  ]
})
let sequence = 0
async function setup() {
  const handlers = new Map()
  const backend = {
    handlers,
    requests: [],
    removed: [],
    listen: async (name, fn) => {
      handlers.set(name, fn)
      return () => {
        backend.removed.push(name)
        handlers.delete(name)
      }
    },
    emit: async (name, payload) => {
      backend.requests.push(payload)
      handlers.get('reader:response')({ payload: { id: payload.id, value: 'ok' } })
    }
  }
  globalThis.__readerBridgeTest = backend
  const api = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text + `\n// ${sequence++}`).toString('base64')}`
  )
  return { api, backend }
}

test('reader mutations retain the session visible when the action began', async () => {
  const { api, backend } = await setup()
  api.acceptSnapshot({ sessions: { activeId: 'original' } })
  const pending = api.call('store', 'deleteLine', [1])
  api.acceptSnapshot({ sessions: { activeId: 'replacement' } })
  await pending
  assert.equal(backend.requests[0].sessionId, 'original')
  await api.call('store', 'deleteLine', [2])
  assert.equal(backend.requests[1].sessionId, 'replacement')
})

for (const failedEvent of ['reader:snapshot', 'reader:response']) {
  test(`reader connection can retry after ${failedEvent} subscription fails`, async () => {
    const { api, backend } = await setup()
    const originalListen = backend.listen
    let fail = true
    backend.listen = async (...args) => {
      if (args[0] === failedEvent && fail) {
        fail = false
        throw Error('listener unavailable')
      }
      return originalListen(...args)
    }
    await assert.rejects(api.call('host', 'snapshot'), /listener unavailable/)
    if (failedEvent === 'reader:response') assert.deepEqual(backend.removed, ['reader:snapshot'])
    assert.equal(await api.call('host', 'snapshot'), 'ok')
    assert.equal(backend.handlers.size, 2)
  })
}
