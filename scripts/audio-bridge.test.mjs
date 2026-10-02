/**
 * The Yomitan backend's audio requests: cross-origin reads go native (no CORS for an
 * extension), everything else stays on the page's own fetch; and JapanesePod101's
 * "not available" clip is recognised by its WebKit duration too.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.location = { href: 'tauri://localhost/spike/background.html', origin: 'tauri://localhost' }
const pageCalls = []
globalThis.fetch = async (input, init) => {
  pageCalls.push([String(input), init?.method ?? 'GET'])
  return new Response('page')
}
const nativeCalls = []
const invoke = async (command, args) => {
  nativeCalls.push([command, args])
  if (args.url.includes('fail')) throw new Error('native: request failed (refused)')
  return {
    status: 200,
    statusText: 'OK',
    headers: [['content-type', 'application/json']],
    body: Buffer.from('{"type":"audioSourceList"}').toString('base64')
  }
}
const logs = []
const { installBackendFetch, installAudioValidity } = await import('../host/audio-bridge.js')
installBackendFetch(invoke, (value) => logs.push(value))

test('a cross-origin GET goes through native code and comes back as a Response', async () => {
  const response = await fetch('http://127.0.0.1:5050/?term=食べる&reading=たべる')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.deepEqual(await response.json(), { type: 'audioSourceList' })
  assert.equal(nativeCalls.at(-1)[0], 'extension_fetch')
  assert.equal(nativeCalls.at(-1)[1].method, 'GET')
})

test('same-origin files and non-read methods keep the page fetch', async () => {
  const before = nativeCalls.length
  await fetch('/data/schemas/custom-audio-list-schema.json')
  await fetch('http://127.0.0.1:8765', { method: 'POST', body: '{}' })
  assert.equal(nativeCalls.length, before)
  assert.deepEqual(pageCalls.slice(-2).map(([, method]) => method), ['GET', 'POST'])
})

test('a native failure rejects like a network error, and is reported once', async () => {
  await assert.rejects(() => fetch('https://fail.example/a.mp3'), TypeError)
  await assert.rejects(() => fetch('https://fail.example/b.mp3'), TypeError)
  assert.equal(logs.filter((l) => l.check === 'extension-fetch-failed').length, 1)
})

test('an already-aborted request never leaves', async () => {
  const before = nativeCalls.length
  await assert.rejects(
    () => fetch('https://example.com/a.mp3', { signal: AbortSignal.abort() }),
    { name: 'AbortError' }
  )
  assert.equal(nativeCalls.length, before)
})

test('the "not available" clip is invalid for jpod101 at WebKit durations, other audio is not', async () => {
  const url = new URL('./fixtures/audio-system-stub.mjs', import.meta.url)
  await installAudioValidity(url.href)
  const { AudioSystem } = await import(url.href)
  const system = new AudioSystem()
  assert.equal(system._isAudioValid({ duration: 5.68 }, 'jpod101'), false)
  assert.equal(system._isAudioValid({ duration: 5.694694 }, 'jpod101'), false)
  assert.equal(system._isAudioValid({ duration: 0.9 }, 'jpod101'), true)
  assert.equal(system._isAudioValid({ duration: 5.68 }, 'custom'), true)
})
