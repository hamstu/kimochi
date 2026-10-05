import assert from 'node:assert/strict'
import test from 'node:test'
import { observeFrame } from '../host/observe.js'

test('only Windows dictionary imports use the ZIP worker bootstrap', () => {
  const calls = []
  class Worker {
    constructor(url, options) { calls.push({ url: String(url), options }) }
    addEventListener() {}
  }
  const options = { type: 'module' }
  for (const os of ['windows', 'macos', 'linux']) {
    const win = { Worker, location: { href: 'http://tauri.localhost/settings.html' }, __KIMOCHI_PLATFORM__: { os } }
    observeFrame(win, { log() {} })
    new win.Worker('/js/dictionary/dictionary-worker-main.js', options)
    assert.equal(calls.at(-1).url, os === 'windows'
      ? 'http://tauri.localhost/spike/windows-dictionary-worker.js'
      : '/js/dictionary/dictionary-worker-main.js')
    assert.equal(calls.at(-1).options, options)
    new win.Worker('/js/display/media-drawing-worker.js', options)
    assert.equal(calls.at(-1).url, '/js/display/media-drawing-worker.js')
  }
})
