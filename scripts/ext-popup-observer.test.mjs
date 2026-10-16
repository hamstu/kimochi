import assert from 'node:assert/strict'
import test from 'node:test'
import { observePopup } from '../host/ext/content.js'

test('popup observation settles after the initial resize and follows replaced popup parts', () => {
  const frames = []
  const mutations = []
  const targets = new Set()
  let parts = []
  let measurements = 0
  const root = { querySelectorAll: () => parts }
  let host = { shadowRoot: root }
  const win = {
    document: { querySelector: () => { measurements++; return host } },
    requestAnimationFrame: (callback) => frames.push(callback),
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    MutationObserver: class {
      constructor(callback) { mutations.push(callback) }
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback }
      observe(element) {
        targets.add(element)
        // Browsers report a newly observed element's initial size.
        frames.push(() => this.callback())
      }
      unobserve(element) { targets.delete(element) }
      disconnect() { targets.clear() }
    }
  }
  const part = (x) => ({ getBoundingClientRect: () => ({ left: x, top: 0, right: x + 20, bottom: 20, width: 20, height: 20 }) })
  const flush = () => {
    for (let i = 0; frames.length && i < 20; i++) frames.shift()()
    assert.equal(frames.length, 0, 'an unchanged popup must not keep scheduling measurements')
  }
  const reports = []
  parts = [part(0)]
  const stop = observePopup(win, { popupSelector: 'host', popupParts: '.popup' }, (value) => reports.push(value))
  flush()
  assert.equal(reports.length, 1)
  assert.equal(targets.size, 1)
  const first = parts[0]
  parts = [part(30), part(60)]
  mutations.forEach((callback) => callback())
  flush()
  assert.equal(targets.has(first), false)
  assert.equal(targets.size, 2)
  assert.equal(reports.at(-1).rect.width, 50)
  host = null
  mutations.forEach((callback) => callback())
  flush()
  assert.equal(targets.size, 0)
  assert.equal(reports.at(-1).visible, false)
  mutations.forEach((callback) => callback())
  stop()
  const before = measurements
  flush()
  assert.equal(measurements, before, 'a queued frame must not measure after teardown')
})
