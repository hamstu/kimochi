/**
 * The panels refuse a user-configured URL that the app's capability would reject anyway, so the
 * user sees an explanation instead of an opaque plugin failure. That check needs to know the real
 * allow-list, which lives in the Rust capability file — this test fails if the two drift apart.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const capability = JSON.parse(
  await readFile(new URL('../src-tauri/capabilities/network.json', import.meta.url), 'utf8')
)
const source = await readFile(
  fileURLToPath(new URL('../frontend/bridge/net.ts', import.meta.url)),
  'utf8'
)

const scopeFromCapability = capability.permissions
  .filter((permission) => typeof permission === 'object' && permission.identifier === 'http:default')
  .flatMap((permission) => permission.allow ?? [])
  .map((entry) => entry.url)

function listFromSource(name) {
  const start = source.indexOf(`${name}`)
  assert.notEqual(start, -1, `${name} not found in frontend/bridge/net.ts`)
  // `= [` rather than `[`, so a `string[]` type annotation is not mistaken for the literal.
  const open = source.indexOf('= [', start) + 2
  const close = source.indexOf(']', open)
  assert.ok(open !== -1 && close !== -1, `${name} is not an array literal`)
  return [...source.slice(open, close).matchAll(/'([^']+)'/g)].map((entry) => entry[1])
}

test('the frontend HTTP scope matches the Rust capability', () => {
  assert.deepEqual(
    listFromSource('HTTP_SCOPE').slice().sort(),
    scopeFromCapability.slice().sort(),
    'frontend/bridge/net.ts HTTP_SCOPE has drifted from src-tauri/capabilities/network.json'
  )
})

test('AnkiConnect allows remote hosts on its port, with the same decision in panels and extension hosts', async () => {
  const { scopeFromCapability, scopeAllows } = await import('./ext-dev-server.mjs')
  const scope = scopeFromCapability(capability)
  const bundled = await build({
    stdin: { contents: source, loader: 'ts' }, bundle: true, format: 'esm', write: false,
    plugins: [{ name: 'unused-http-transport', setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, () => ({ path: 'http', namespace: 'stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const fetch = () => { throw Error("not used") }' }))
    } }]
  })
  const { isWithinHttpScope } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
  for (const url of ['http://192.0.2.42:8765/', 'http://anki.example:8765/', 'http://localhost:8765/', 'http://127.0.0.1:8765/']) {
    assert.equal(scopeAllows(scope, url), true, url)
    assert.equal(isWithinHttpScope(url), true, url)
  }
  for (const url of ['http://192.0.2.42:8766/', 'http://anki.example/', 'https://example.com/', 'file:///tmp/data']) {
    assert.equal(scopeAllows(scope, url), false, url)
    assert.equal(isWithinHttpScope(url), false, url)
  }
})

test('the Yomitan API client goes through the native command, not the plugin scope', async () => {
  const yomitan = await readFile(
    fileURLToPath(new URL('../frontend/bridge/yomitan.ts', import.meta.url)),
    'utf8'
  )
  // A user-configured URL cannot be limited to an enumerated allow-list, so it is validated in
  // Rust instead. If this ever reverts to httpFetch, most addresses silently stop working.
  assert.ok(yomitan.includes("invoke<T>('yomitan_request'"), 'expected yomitan_request transport')
  assert.ok(!yomitan.includes('httpFetch'), 'the Yomitan client must not use the scoped plugin')
})

test('the Yomitan requests match the Electron handlers exactly', async (t) => {
  // The Electron app is a sibling checkout (`../kimochi`), absent on CI and fresh clones. Skip
  // rather than pass silently, and only when the file is missing: any other failure still fails.
  const electron = await readFile(
    new URL('../../kimochi/src/main/index.ts', import.meta.url),
    'utf8'
  ).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (electron === null) {
    t.skip('sibling ../kimochi checkout not found; Electron parity not checked')
    return
  }
  const yomitan = await readFile(
    fileURLToPath(new URL('../frontend/bridge/yomitan.ts', import.meta.url)),
    'utf8'
  )
  // Paths and bodies are the parity surface: a guessed endpoint silently returns nothing useful.
  for (const fragment of ['/tokenize', '/termEntries', 'scanLength: 32', "action: 'version'"]) {
    assert.ok(electron.includes(fragment), `${fragment} missing from the Electron handlers`)
    assert.ok(yomitan.includes(fragment), `${fragment} missing from the Tauri client`)
  }
})

test('the extension windows get event listening and the same HTTP scope as network.json, nothing else', async () => {
  const dir = new URL('../src-tauri/capabilities/', import.meta.url)
  const read = async (name) => JSON.parse(await readFile(new URL(name, dir), 'utf8'))
  const extension = await read('extension-windows.json')
  assert.deepEqual(extension.windows.slice().sort(), ['ext-hachidori', 'ext-tenten'])
  const names = extension.permissions.map((permission) => (typeof permission === 'string' ? permission : permission.identifier))
  assert.deepEqual(names, ['core:event:allow-listen', 'http:default'])
  const scope = extension.permissions
    .filter((permission) => typeof permission === 'object' && permission.identifier === 'http:default')
    .flatMap((permission) => permission.allow ?? [])
    .map((entry) => entry.url)
  assert.deepEqual(scope.slice().sort(), scopeFromCapability.slice().sort())
  // No other capability names an extension window (a broader grant would apply to it too).
  const { readdir } = await import('node:fs/promises')
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.json') || file === 'extension-windows.json') continue
    const capability = await read(file)
    for (const window of capability.windows ?? []) {
      assert.ok(!/^ext-|\*/.test(window), `${file} lists ${window}, which would reach an extension window`)
    }
  }
})
