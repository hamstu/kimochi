import test from 'node:test'
import assert from 'node:assert/strict'
import { installWaylandPointerExit } from '../ui/wayland-pointer-exit.js'
import { load } from './load.mjs'
const { ReadingHold } = await load('reading-hold.ts')

function fixture() {
  const root = new EventTarget(), win = new EventTarget(), timers = new Map()
  let next = 0, dismissed = 0, pointer = { x: 15, y: 25 }, popup = false
  const hold = new ReadingHold(), rect = { x: 10, y: 20, width: 100, height: 30 }
  win.document = { documentElement: root }
  win.setTimeout = fn => { timers.set(++next, fn); return next }
  win.clearTimeout = id => timers.delete(id)
  const held = () => hold.update(pointer, [rect], popup)
  const stop = installWaylandPointerExit(win, {
    leave: () => { pointer = null },
    dismiss: () => { dismissed++; popup = false }
  })
  return { root, win, held, stop, timers, popup: value => { popup = value },
    dismissed: () => dismissed,
    flush: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()) } }
}

test('leaving a Wayland text input region releases stale hover and the reading hold', () => {
  const f = fixture()
  assert.equal(f.held(), true)
  f.root.dispatchEvent(new Event('mouseleave'))
  assert.equal(f.held(), false)
  f.flush()
  assert.equal(f.dismissed(), 1)
})

test('a popup holds reading until exit grace expires; entering its iframe preserves it', () => {
  const f = fixture()
  f.popup(true)
  f.root.dispatchEvent(new Event('mouseleave'))
  assert.equal(f.held(), true)
  f.root.dispatchEvent(new Event('mouseenter'))
  f.flush()
  assert.equal(f.dismissed(), 0)
  assert.equal(f.held(), true)
  f.root.dispatchEvent(new Event('mouseleave'))
  f.flush()
  assert.equal(f.dismissed(), 1)
  assert.equal(f.held(), false)
})

test('returning pointer movement cancels dismissal and teardown cancels pending work', () => {
  const f = fixture()
  f.root.dispatchEvent(new Event('mouseleave'))
  f.win.dispatchEvent(new Event('pointermove'))
  f.flush()
  assert.equal(f.dismissed(), 0)
  f.root.dispatchEvent(new Event('mouseleave'))
  f.stop()
  f.flush()
  f.root.dispatchEvent(new Event('mouseleave'))
  assert.equal(f.timers.size, 0)
})

test('queued WebKit movement cannot cancel native exit or keep its popup held', () => {
  const f = fixture()
  f.popup(true)
  f.stop.enter()
  f.stop.leave()
  f.win.dispatchEvent(new Event('pointermove'))
  f.root.dispatchEvent(new Event('mouseenter'))
  assert.equal(f.stop.outside(), true)
  f.flush()
  assert.equal(f.dismissed(), 1)
  assert.equal(f.held(), false)
})

test('compositor samples recover a missed leave without postponing dismissal each tick', () => {
  const f = fixture()
  f.popup(true)
  f.stop.enter()
  f.stop.sample(false)
  const timer = [...f.timers.keys()][0]
  for (let i = 0; i < 10; i++) {
    f.stop.enter() // Spurious/late surface events must not override compositor position.
    f.win.dispatchEvent(new Event('pointermove'))
    f.stop.sample(false)
  }
  assert.deepEqual([...f.timers.keys()], [timer])
  assert.equal(f.stop.outside(), true)
  f.flush()
  assert.equal(f.dismissed(), 1)
  f.stop.sample(true)
  assert.equal(f.stop.outside(), false)
  f.stop.leave() // Shape updates can unmap the surface while the real pointer stays put.
  assert.equal(f.stop.outside(), false)
})
