import test from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { TextOverlayRenderer } = await load('render.js')

test('hit testing only queries animations for zero-opacity words and keeps the Wayland entrance exception', (t) => {
  const measured = [],
    animated = []
  const element = (name, opacity = '1', extra = {}) => ({
    name,
    computed: { opacity, visibility: 'visible', display: 'flex', ...extra },
    getAnimations() {
      animated.push(name)
      return name === 'appearing' ? [{ animationName: 'ocr-appear' }] : []
    },
    getBoundingClientRect() {
      measured.push(name)
      return { x: 10, y: 20, width: 80, height: 24 }
    }
  })
  const children = [
    element('visible'),
    element('fading-in', '0.2'),
    element('appearing', '0'),
    element('transparent', '0'),
    element('hidden', '1', { visibility: 'hidden' }),
    element('removed', '1', { display: 'none' }),
    element('leaving')
  ]
  const previous = globalThis.getComputedStyle
  globalThis.getComputedStyle = (node) => node.computed
  t.after(() => {
    if (previous) globalThis.getComputedStyle = previous
    else delete globalThis.getComputedStyle
  })
  const renderer = Object.assign(Object.create(TextOverlayRenderer.prototype), {
    container: { children },
    leaving: new Map([[children.at(-1), 1]])
  })
  const rects = renderer.hitRects({ x: -800, y: 100 })
  assert.deepEqual(animated, ['appearing', 'transparent'])
  assert.deepEqual(measured, ['visible', 'fading-in', 'appearing'])
  assert.deepEqual(
    rects,
    Array.from({ length: 3 }, () => ({ x: -790, y: 120, width: 80, height: 24, focus: false, shift: true }))
  )
  assert.deepEqual(renderer.hitRects(null), [])
  assert.equal(measured.length, 3, 'no origin needs no DOM reads')
})
