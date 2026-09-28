/**
 * The panels refuse a user-configured URL that the app's capability would reject anyway, so the
 * user sees an explanation instead of an opaque plugin failure. That check needs to know the real
 * allow-list, which lives in the Rust capability file — this test fails if the two drift apart.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

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

test('the Yomitan requests match the Electron handlers exactly', async () => {
  const electron = await readFile(
    new URL('../../kimochi/src/main/index.ts', import.meta.url),
    'utf8'
  )
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
