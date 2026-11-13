import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { resolveWatcher, bestWatcher, watcherChoiceApplies } = await load('watcher.ts')

const on = (accelerator) => ({ available: true, ...(accelerator ? { accelerator } : {}) })
const off = { available: false, reason: 'not downloaded' }

const mac = { ppocr: on('coreml'), livetext: on(), meikiocr: on('coreml') }
const windowsGpu = { ppocr: on('directml'), oneocr: on(), meikiocr: on('directml') }
const linuxCpu = { ppocr: on('cpu'), meikiocr: on('cpu') }

test('a local engine watches for itself, whatever the setting says', () => {
  for (const mode of ['ppocr', 'meikiocr', 'livetext']) {
    assert.deepEqual(resolveWatcher(mode, mac, 'image'), { kind: 'text', engine: mode, because: 'selected' })
  }
  assert.equal(resolveWatcher('oneocr', windowsGpu).engine, 'oneocr')
  assert.equal(watcherChoiceApplies('ppocr', mac), false)
})

test('VOCR6 and Screen AI watch for themselves, but never for another reader', () => {
  const engines = { ...mac, vocr: on('cpu'), screenai: on('cpu') }
  for (const mode of ['vocr', 'screenai']) {
    assert.deepEqual(resolveWatcher(mode, engines, 'livetext'), { kind: 'text', engine: mode, because: 'selected' })
    assert.equal(watcherChoiceApplies(mode, engines), false)
    // Not downloaded (or no Screen AI copy): the best watcher here instead.
    assert.equal(resolveWatcher(mode, { ...mac, [mode]: off }).engine, 'ppocr')
  }
  assert.equal(resolveWatcher('googlelens', { vocr: on('cpu'), screenai: on('cpu') }).kind, 'image')
  assert.equal(resolveWatcher('googlelens', engines, 'vocr').engine, 'ppocr')
})

test('an online engine or Manga OCR gets the best watcher here', () => {
  assert.equal(resolveWatcher('googlelens', mac).engine, 'ppocr')
  assert.equal(resolveWatcher('cloud', windowsGpu).engine, 'ppocr')
  assert.equal(resolveWatcher('mangaocr', mac).engine, 'ppocr')
  assert.equal(watcherChoiceApplies('mangaocr', mac), true)
})

test('the built-in OS engine beats PaddleOCR on a CPU, which beats MeikiOCR', () => {
  assert.equal(bestWatcher({ ppocr: on('cpu'), livetext: on(), meikiocr: on() }), 'livetext')
  assert.equal(bestWatcher({ ppocr: on('cpu'), oneocr: on() }), 'oneocr')
  assert.equal(bestWatcher(linuxCpu), 'ppocr')
  assert.equal(bestWatcher({ ppocr: off, meikiocr: on('cpu') }), 'meikiocr')
  // Still probing: no accelerator yet is not a GPU.
  assert.equal(bestWatcher({ ppocr: on(), livetext: on() }), 'livetext')
})

test('nothing downloaded and no OS engine falls back to image comparison', () => {
  assert.deepEqual(resolveWatcher('googlelens', { ppocr: off, meikiocr: off }), { kind: 'image', because: 'none' })
  // A selected local engine whose models are missing does not watch; nor does anything download.
  assert.deepEqual(resolveWatcher('ppocr', { ppocr: off, meikiocr: off }), { kind: 'image', because: 'none' })
  assert.equal(resolveWatcher('ppocr', { ppocr: off, livetext: on() }).engine, 'livetext')
})

test('a chosen watcher is used when available, otherwise the best one', () => {
  assert.deepEqual(resolveWatcher('googlelens', mac, 'livetext'), {
    kind: 'text',
    engine: 'livetext',
    because: 'chosen'
  })
  assert.deepEqual(resolveWatcher('googlelens', mac, 'image'), { kind: 'image', because: 'chosen' })
  assert.equal(resolveWatcher('googlelens', linuxCpu, 'livetext').engine, 'ppocr')
})

test('off macOS, the capabilities Auto OCR reads never offer Live Text as the watcher', async () => {
  const { fallbackCapabilities, normalizeCapabilities } = await load('capabilities.ts')
  // What native sends on Linux before this fix: no livetext key at all.
  const linux = {
    os: 'linux',
    ocrEngines: { googlelens: on(), mangaocr: on('cpu'), ppocr: on('cpu'), meikiocr: on('cpu') }
  }
  for (const ua of ['X11; Linux aarch64', 'Windows NT 10.0']) {
    const caps = normalizeCapabilities(linux, fallbackCapabilities({ platform: '', userAgent: ua }))
    assert.equal(caps.ocrEngines.livetext.available, false)
    assert.equal(resolveWatcher('googlelens', caps.ocrEngines).engine, 'ppocr')
    assert.equal(resolveWatcher('mangaocr', caps.ocrEngines).engine, 'ppocr')
  }
})
