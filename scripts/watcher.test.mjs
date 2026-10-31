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
  assert.deepEqual(resolveWatcher('googlelens', mac, 'livetext'), { kind: 'text', engine: 'livetext', because: 'chosen' })
  assert.deepEqual(resolveWatcher('googlelens', mac, 'image'), { kind: 'image', because: 'chosen' })
  assert.equal(resolveWatcher('googlelens', linuxCpu, 'livetext').engine, 'ppocr')
})
