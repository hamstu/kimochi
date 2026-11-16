import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const mocks = {
  './sessions': 'export const getActiveSession = () => ({id: backend.session});',
  '@tauri-apps/api/core': 'export const invoke = (...args) => backend.invoke(...args);',
  '../../../ui/account': 'export const translationRoute = () => "deepl";',
  '../../bridge/account': 'export const loadAccount = () => backend.account();',
  '../../bridge/tauri': 'export const nativeError = e => ({message: String(e)});',
  '../core/language': 'export const currentLanguage = () => "ja";',
  './settings': 'export const getSettings = () => ({deeplApiKey: "test", translationProvider: "deepl"});',
  './store': `export const snapshotLines = () => backend.lines;
    export const setLineTranslation = (...args) => backend.writes.push([backend.session, ...args.slice(0, 3)]);
    export const setLineTranslationVisible = () => {};`,
  './translateLanguage': 'export const translationErrorMessage = e => e;'
}
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../frontend/texthooker/lib/translate.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  plugins: [
    {
      name: 'translation-transport',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) =>
          args.path in mocks ? { path: args.path, namespace: 'mock' } : null
        )
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
          contents: `const backend = globalThis.__translationLifecycle; ${mocks[args.path]}`
        }))
      }
    }
  ]
})
let sequence = 0
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function setup() {
  const line = { id: 1, uid: 'line-a', text: '猫', ts: 1, source: 'ocr' }
  const backend = {
    session: 'a',
    lines: [line],
    writes: [],
    calls: [],
    account: async () => ({ cloud: null }),
    invoke: (...args) => {
      backend.calls.push(args)
      return Promise.resolve('Cat')
    }
  }
  globalThis.__translationLifecycle = backend
  const api = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text + `\n// ${sequence++}`).toString('base64')}`
  )
  return { api, backend, line }
}

test('switching sessions while account loads cannot translate into the next session', async () => {
  const { api, backend, line } = await setup()
  const account = deferred()
  backend.account = () => account.promise
  const pending = api.showTranslation(line)
  backend.session = 'b'
  backend.lines = [{ ...line, uid: 'line-b', text: '犬' }]
  account.resolve({ cloud: null })
  await pending
  assert.deepEqual(backend.writes, [])
  assert.deepEqual(backend.calls, [], 'do not spend a request on an abandoned line')
})

test('a pending translation does not block the same line number in another session', async () => {
  const { api, backend, line } = await setup()
  const response = deferred()
  backend.invoke = () => response.promise
  const pending = api.showTranslation(line)
  await Promise.resolve()
  backend.session = 'b'
  backend.lines = [{ ...line, uid: 'line-b', text: '犬' }]
  assert.equal(api.getTranslateStatus(1), null)
  backend.invoke = async () => 'Dog'
  await api.showTranslation(backend.lines[0])
  response.resolve('Cat')
  await pending
  assert.deepEqual(backend.writes, [['b', 1, 'Dog', true]])
})

for (const action of ['edit', 'delete', 'replace']) {
  test(`a translation arriving after ${action} does not overwrite the line`, async () => {
    const { api, backend, line } = await setup()
    const response = deferred()
    backend.invoke = () => response.promise
    const pending = api.showTranslation(line)
    await Promise.resolve()
    backend.lines =
      action === 'delete' ? [] : [{ ...line, ...(action === 'edit' ? { text: '犬' } : { uid: 'replacement' }) }]
    response.resolve('Cat')
    await pending
    assert.deepEqual(backend.writes, [])
    assert.equal(api.getTranslateStatus(1), null)
  })
}

test('unchanged lines receive a translation and concurrent requests are deduplicated', async () => {
  const { api, backend, line } = await setup()
  await Promise.all([api.showTranslation(line), api.showTranslation(line)])
  assert.equal(backend.calls.length, 1)
  assert.deepEqual(backend.writes, [['a', 1, 'Cat', true]])
  assert.equal(api.getTranslateStatus(1), null)
})

test('a failed request from an old session does not show an error on its replacement', async () => {
  const { api, backend, line } = await setup()
  const response = deferred()
  backend.invoke = () => response.promise
  const pending = api.showTranslation(line)
  await Promise.resolve()
  backend.session = 'b'
  backend.lines = [{ ...line, uid: 'line-b', text: '犬' }]
  response.reject(new Error('offline'))
  await pending
  assert.equal(api.getTranslateStatus(1), null)
  backend.session = 'a'
  backend.lines = [line]
  assert.equal(api.getTranslateStatus(1), null, 'abandoned requests release their status')
})
