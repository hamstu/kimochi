/**
 * Settings → Anki's model (ui/anki-connect.ts): the AnkiConnect address as typed, and the words
 * for each connection state. The address rules mirror Rust's `parse_url`
 * (src-tauri/src/reader/ankiconnect.rs, cargo test), which has the last word.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const outDir = await mkdtemp(path.join(tmpdir(), 'kimochi-anki-connect-'))
const outfile = path.join(outDir, 'anki.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../ui/anki-connect.ts', import.meta.url))],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022'
})
const anki = await import(pathToFileURL(outfile).href)
test.after(() => rm(outDir, { recursive: true, force: true }))

test('an address is completed the way people type it', () => {
  const ok = (input, url) => assert.deepEqual(anki.normalizeAnkiConnectUrl(input), { ok: true, url }, input)
  ok('', 'http://127.0.0.1:8765')
  ok('  ', 'http://127.0.0.1:8765')
  ok('8770', 'http://127.0.0.1:8770')
  ok('127.0.0.1:8770', 'http://127.0.0.1:8770')
  ok('localhost:8770/', 'http://localhost:8770')
  ok('http://[::1]:9000', 'http://[::1]:9000')
  ok('HTTP://192.168.1.5:8765', 'http://192.168.1.5:8765')
  ok('https://anki.example', 'https://anki.example')
  ok('https://anki.example/anki/', 'https://anki.example/anki')
})

test('an address AnkiConnect cannot be at is refused, with the reason', () => {
  const bad = (input, pattern) => {
    const result = anki.normalizeAnkiConnectUrl(input)
    assert.equal(result.ok, false, input)
    assert.match(result.error, pattern, input)
  }
  bad('http://127.0.0.1', /needs a port/)
  bad('localhost', /needs a port/)
  bad('99999', /not an address/)
  bad('ftp://127.0.0.1:8765', /http:\/\/ or https:\/\//)
  bad('http://user:pw@127.0.0.1:8765', /user name or password/)
  bad('http://127.0.0.1:8765/?x=1', /query or fragment/)
  bad('http://127.0.0.1:8765/api/v1', /api\/v1/)
  bad('http://', /not an address/)
})

test('only loopback addresses count as this computer', () => {
  for (const url of ['http://127.0.0.1:8765', 'http://localhost:8765', 'http://[::1]:8765', 'http://127.1.2.3:1'])
    assert.equal(anki.isLocalAddress(url), true, url)
  for (const url of ['http://192.168.1.5:8765', 'https://anki.example', 'not a url'])
    assert.equal(anki.isLocalAddress(url), false, url)
})

test('every connection state reads as what to do next', () => {
  const url = 'http://127.0.0.1:8770'
  const said = (status) => anki.describeAnkiStatus(status)
  assert.equal(said(null).tone, 'neutral')
  assert.deepEqual(
    [said({ state: 'connected', url, version: 6, latencyMs: 3, keyRequired: false }).tone, said({ state: 'connected', url, version: 6, latencyMs: 3, keyRequired: false }).title],
    ['ok', 'Connected']
  )
  assert.match(said({ state: 'connected', url, version: 6, latencyMs: 3, keyRequired: false }).detail, /API version 6/)
  assert.equal(said({ state: 'keyRequired', url }).title, 'API key needed')
  assert.equal(said({ state: 'keyRejected', url }).title, 'Wrong API key')
  assert.equal(said({ state: 'notRunning', url, suggestion: null }).title, 'Not running')
  const wrongPort = said({ state: 'notRunning', url, suggestion: 'http://127.0.0.1:8765' })
  assert.equal(wrongPort.title, 'Wrong port')
  assert.match(wrongPort.detail, /8765/)
  assert.equal(said({ state: 'notAnkiConnect', url, detail: 'HTTP 404', suggestion: null }).title, 'Wrong port')
  // A refusal is never answered with "add Kimochi's origins": they would not help (no Origin is sent).
  const blocked = said({ state: 'blocked', url, status: 403 })
  assert.equal(blocked.tone, 'danger')
  assert.doesNotMatch(blocked.detail, /tauri:\/\//)
  assert.equal(said({ state: 'invalidUrl', url, error: 'Nope.' }).detail, 'Nope.')
  assert.equal(said({ state: 'error', url, message: 'Boom.' }).detail, 'Boom.')
})

test('the check runs again sooner while it is not connected', () => {
  assert.ok(anki.nextCheckMs({ state: 'notRunning', url: '', suggestion: null }) < anki.nextCheckMs({ state: 'connected', url: '', version: 6, latencyMs: 1, keyRequired: false }))
})

test('each engine has its way of adding cards', () => {
  assert.deepEqual(anki.ANKI_ROUTE, { yomitan: 'engine', hachidori: 'engine', tenten: 'none', 'custom-api': 'kimochi' })
})
