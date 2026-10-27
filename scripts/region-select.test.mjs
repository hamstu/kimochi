/**
 * The region editor behind "Select region" on a screen source and Quick Shot. Its look cannot be
 * checked from here, but the parts that silently go wrong (the minimum drag, confirm-not-release,
 * moving and resizing, the local/desktop mapping, Escape, and click-through cleanup) are pure logic
 * over a DOM, so they are pinned here against a minimal DOM stub.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

function createElement(tag) {
  const listeners = new Map()
  const element = {
    tag,
    // Real elements always have this; the module uses it to tell an element from an options object.
    nodeType: 1,
    style: {},
    dataset: {},
    children: [],
    parent: null,
    captured: new Set(),
    textContent: '',
    append: (...nodes) => {
      for (const node of nodes) {
        if (typeof node === 'object') node.parent = element
        element.children.push(node)
      }
    },
    remove: () => {
      if (element.parent) {
        element.parent.children = element.parent.children.filter((child) => child !== element)
        element.parent = null
      }
    },
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(handler)
    },
    removeEventListener: (type, handler) => listeners.get(type)?.delete(handler),
    dispatch: (type, event = {}) => {
      for (const handler of listeners.get(type) ?? []) handler({ preventDefault() {}, ...event })
    },
    listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    setPointerCapture: (id) => element.captured.add(id),
    hasPointerCapture: (id) => element.captured.has(id),
    releasePointerCapture: (id) => element.captured.delete(id),
    // The surface covers the window exactly: no offset, no scaling.
    getBoundingClientRect: () => ({ left: 0, top: 0 })
  }
  return element
}

const documentListeners = new Map()
const doc = {
  createElement,
  body: createElement('body'),
  addEventListener: (type, handler) => {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set())
    documentListeners.get(type).add(handler)
  },
  removeEventListener: (type, handler) => documentListeners.get(type)?.delete(handler),
  dispatch: (type, event) => {
    for (const handler of documentListeners.get(type) ?? []) {
      handler({ preventDefault() {}, ...event })
    }
  }
}
globalThis.document = doc

const { RegionSelect, selectRegion, MINIMUM_DRAG } = (await import('../ui/region-select.js')).default

const BOUNDS = { x: -1920, y: 240, width: 1920, height: 1080 }
const surface = () => doc.body.children.at(-1)

function drag(element, from, to, pointerId = 1) {
  element.dispatch('pointerdown', { button: 0, pointerId, clientX: from.x, clientY: from.y })
  element.dispatch('pointermove', { pointerId, clientX: to.x, clientY: to.y })
  element.dispatch('pointerup', { pointerId, clientX: to.x, clientY: to.y })
}

/** Draw a box and confirm it with Return, as a reader would. */
function select(element, from, to) {
  drag(element, from, to)
  doc.dispatch('keydown', { key: 'Enter' })
}

test('a drag resolves in overlay-local AND desktop points, with no DPR or menu-bar offset', async () => {
  const selector = new RegionSelect()
  const pending = selector.start({ bounds: BOUNDS })
  select(surface(), { x: 100, y: 50 }, { x: 340, y: 210 })
  const result = await pending

  // Local is exactly the client coordinates: this overlay covers the full display, so the
  // Electron original's menu-bar offset is deliberately absent.
  assert.deepEqual(result.local, { x: 100, y: 50, width: 240, height: 160 })
  // Desktop adds the display origin, including a negative one on a secondary display.
  assert.deepEqual(result.desktop, { x: -1820, y: 290, width: 240, height: 160 })
  assert.deepEqual(result.bounds, BOUNDS)
})

test('a drag in any direction normalises to a positive rectangle', async () => {
  const selector = new RegionSelect()
  const pending = selector.start({ bounds: BOUNDS })
  select(surface(), { x: 400, y: 300 }, { x: 100, y: 100 })
  const result = await pending
  assert.deepEqual(result.local, { x: 100, y: 100, width: 300, height: 200 })
})

test(`a drag under ${MINIMUM_DRAG} points is discarded and selection stays open`, async () => {
  const selector = new RegionSelect()
  let settled = false
  const pending = selector.start({ bounds: BOUNDS }).then((value) => {
    settled = true
    return value
  })
  const element = surface()
  drag(element, { x: 10, y: 10 }, { x: 10 + MINIMUM_DRAG - 1, y: 400 })
  await Promise.resolve()

  assert.equal(settled, false, 'a misclick must not resolve')
  assert.equal(selector.active, true, 'the surface stays up for another attempt')

  // A real drag afterwards still works.
  select(element, { x: 0, y: 0 }, { x: 200, y: 200 })
  assert.deepEqual((await pending).local, { x: 0, y: 0, width: 200, height: 200 })
})

test('Escape cancels with null', async () => {
  const selector = new RegionSelect()
  const pending = selector.start({ bounds: BOUNDS })
  doc.dispatch('keydown', { key: 'a' })
  doc.dispatch('keydown', { key: 'Escape' })
  assert.equal(await pending, null)
  assert.equal(selector.active, false)
})

test('hit rectangles cover the display in desktop points, and clear on teardown', async () => {
  const published = []
  const selector = new RegionSelect({ onHitRects: (rects) => published.push(rects) })
  assert.deepEqual(selector.hitRects, [], 'nothing is interactive before starting')

  const pending = selector.start({ bounds: BOUNDS })
  assert.deepEqual(selector.hitRects, [BOUNDS], 'the whole display is interactive while selecting')
  assert.deepEqual(published.at(0), [BOUNDS])

  select(surface(), { x: 5, y: 5 }, { x: 105, y: 105 })
  await pending

  // The caller needs the empty set to restore click-through.
  assert.deepEqual(published.at(-1), [])
  assert.deepEqual(selector.hitRects, [])
})

test('teardown removes the surface and every listener it added', async () => {
  const selector = new RegionSelect()
  const pending = selector.start({ bounds: BOUNDS })
  const element = surface()
  assert.ok(element.listenerCount() > 0)
  assert.equal(doc.body.children.includes(element), true)

  selector.cancel()
  assert.equal(await pending, null)
  assert.equal(element.listenerCount(), 0, 'listeners must not outlive the surface')
  assert.equal(doc.body.children.includes(element), false)

  selector.destroy()
  selector.cancel()
})

test('an abort signal cancels, including one already aborted', async () => {
  const controller = new AbortController()
  const selector = new RegionSelect()
  const pending = selector.start({ bounds: BOUNDS, signal: controller.signal })
  controller.abort()
  assert.equal(await pending, null)

  const aborted = AbortSignal.abort()
  assert.equal(await new RegionSelect().start({ bounds: BOUNDS, signal: aborted }), null)
})

test('starting again supersedes the previous run instead of stacking surfaces', async () => {
  const selector = new RegionSelect()
  const first = selector.start({ bounds: BOUNDS })
  const before = doc.body.children.length
  const second = selector.start({ bounds: BOUNDS })

  assert.equal(await first, null, 'the superseded run resolves as cancelled')
  assert.equal(doc.body.children.length, before, 'only one surface is ever mounted')

  select(surface(), { x: 0, y: 0 }, { x: 50, y: 50 })
  assert.deepEqual((await second).local, { x: 0, y: 0, width: 50, height: 50 })
})

test('malformed bounds are refused rather than producing a meaningless rectangle', async () => {
  await assert.rejects(
    () => new RegionSelect().start({ bounds: { x: 0, y: 0, width: 0, height: 100 } }),
    /display bounds/
  )
  await assert.rejects(
    () => new RegionSelect().start({ bounds: { x: 0, y: 0, width: 10 } }),
    /display bounds/
  )
})

test('the element call shape resolves overlay-local pixels and never rejects', async () => {
  const container = doc.createElement('div')
  const pending = selectRegion(container)
  // The surface mounts into the given element, not the document body.
  const element = container.children.at(-1)
  select(element, { x: 20, y: 30 }, { x: 220, y: 130 })
  assert.deepEqual(await pending, { x: 20, y: 30, width: 200, height: 100 })

  const cancelled = selectRegion(container)
  doc.dispatch('keydown', { key: 'Escape' })
  assert.equal(await cancelled, null)
})

test('a misclick keeps the surface up by default, and cancels only when asked', async () => {
  // Default: Electron's behaviour — a stray click must not abandon the scan the user asked for.
  const container = doc.createElement('div')
  const selector = new RegionSelect({ container })
  const pending = selector.start({})
  // A click, not a drag: the only thing that draws nothing now.
  drag(container.children.at(-1), { x: 0, y: 0 }, { x: 0, y: 0 })
  await Promise.resolve()
  assert.equal(selector.active, true)
  selector.cancel()
  assert.equal(await pending, null)

  // Opt-in: resolve null on a misclick, for a caller that wants every gesture to settle.
  const eager = new RegionSelect({ container, cancelOnMisclick: true })
  const settles = eager.start({})
  drag(container.children.at(-1), { x: 0, y: 0 }, { x: 0, y: 0 })
  assert.equal(await settles, null)
})

test('letting go does not commit: the box waits to be adjusted and confirmed', async () => {
  const selector = new RegionSelect()
  let settled = false
  const pending = selector.start({ bounds: BOUNDS }).then((value) => {
    settled = true
    return value
  })
  drag(surface(), { x: 100, y: 100 }, { x: 300, y: 200 })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.deepEqual(selector.rect, { x: 100, y: 100, width: 200, height: 100 })
  selector.confirm()
  assert.deepEqual((await pending).local, { x: 100, y: 100, width: 200, height: 100 })
})

test('the result says which confirm committed it: Return is the primary, the alternate button its own', async () => {
  const primary = new RegionSelect({ alternateLabel: 'Save' })
  const first = primary.start({ bounds: BOUNDS })
  select(surface(), { x: 100, y: 100 }, { x: 300, y: 200 })
  assert.equal((await first).action, 'primary')

  const alternate = new RegionSelect({ alternateLabel: 'Save' })
  const second = alternate.start({ bounds: BOUNDS })
  drag(surface(), { x: 100, y: 100 }, { x: 300, y: 200 })
  alternate.confirm('alternate')
  const result = await second
  assert.equal(result.action, 'alternate')
  assert.deepEqual(result.local, { x: 100, y: 100, width: 200, height: 100 })
})

test('dragging inside moves the box, and dragging an edge or corner resizes it', async () => {
  const selector = new RegionSelect()
  const pending = selector.start({ bounds: BOUNDS })
  const element = surface()
  drag(element, { x: 100, y: 100 }, { x: 300, y: 200 })

  drag(element, { x: 200, y: 150 }, { x: 230, y: 170 })
  assert.deepEqual(selector.rect, { x: 130, y: 120, width: 200, height: 100 }, 'moved')

  drag(element, { x: 330, y: 170 }, { x: 400, y: 170 })
  assert.deepEqual(selector.rect, { x: 130, y: 120, width: 270, height: 100 }, 'right edge')

  drag(element, { x: 130, y: 120 }, { x: 100, y: 90 })
  assert.deepEqual(selector.rect, { x: 100, y: 90, width: 300, height: 130 }, 'top-left corner')

  // Past the opposite edge flips rather than inverting.
  drag(element, { x: 100, y: 150 }, { x: 450, y: 150 })
  assert.deepEqual(selector.rect, { x: 400, y: 90, width: 50, height: 130 }, 'flipped')

  doc.dispatch('keydown', { key: 'Enter' })
  assert.deepEqual((await pending).local, { x: 400, y: 90, width: 50, height: 130 })
})

test('dragging outside the box starts a new one', async () => {
  const selector = new RegionSelect()
  const pending = selector.start({ bounds: BOUNDS })
  const element = surface()
  drag(element, { x: 10, y: 10 }, { x: 60, y: 60 })
  select(element, { x: 500, y: 500 }, { x: 600, y: 550 })
  assert.deepEqual((await pending).local, { x: 500, y: 500, width: 100, height: 50 })
})

test('Return before a box exists does nothing; arrow keys nudge the box', async () => {
  const selector = new RegionSelect()
  const pending = selector.start({ bounds: BOUNDS })
  doc.dispatch('keydown', { key: 'Enter' })
  assert.equal(selector.active, true)
  drag(surface(), { x: 100, y: 100 }, { x: 200, y: 200 })
  doc.dispatch('keydown', { key: 'ArrowRight' })
  doc.dispatch('keydown', { key: 'ArrowDown', shiftKey: true })
  doc.dispatch('keydown', { key: 'Enter' })
  assert.deepEqual((await pending).local, { x: 101, y: 110, width: 100, height: 100 })
})

test('a box of any size is kept; only a plain click draws nothing', async () => {
  const selector = new RegionSelect()
  const pending = selector.start({ bounds: BOUNDS })
  const element = surface()
  drag(element, { x: 100, y: 100 }, { x: 100, y: 100 })
  assert.equal(selector.rect, null, 'a click is not a box')
  assert.equal(selector.idle, true, 'idle again, so the cursor bubble returns')
  select(element, { x: 100, y: 100 }, { x: 104, y: 103 })
  assert.deepEqual((await pending).local, { x: 100, y: 100, width: 4, height: 3 })
})

test('a resize that collapses the box is undone rather than clearing it', async () => {
  const selector = new RegionSelect()
  const pending = selector.start({ bounds: BOUNDS })
  const element = surface()
  drag(element, { x: 100, y: 100 }, { x: 300, y: 300 })
  // Drag the right edge exactly onto the left one.
  drag(element, { x: 300, y: 200 }, { x: 100, y: 200 })
  assert.deepEqual(selector.rect, { x: 100, y: 100, width: 200, height: 200 })
  doc.dispatch('keydown', { key: 'Enter' })
  assert.deepEqual((await pending).local, { x: 100, y: 100, width: 200, height: 200 })
})

test('holding Space while drawing moves the box; letting go carries on drawing', async () => {
  const selector = new RegionSelect()
  const pending = selector.start({ bounds: BOUNDS })
  const element = surface()
  const move = (x, y) => element.dispatch('pointermove', { pointerId: 1, clientX: x, clientY: y })
  element.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
  move(200, 150)
  assert.deepEqual(selector.rect, { x: 100, y: 100, width: 100, height: 50 })
  doc.dispatch('keydown', { key: ' ' })
  move(260, 190)
  assert.deepEqual(selector.rect, { x: 160, y: 140, width: 100, height: 50 }, 'moved, same size')
  doc.dispatch('keyup', { key: ' ' })
  move(300, 240)
  assert.deepEqual(selector.rect, { x: 160, y: 140, width: 140, height: 100 }, 'drawing again')
  element.dispatch('pointerup', { pointerId: 1, clientX: 300, clientY: 240 })
  doc.dispatch('keydown', { key: 'Enter' })
  assert.deepEqual((await pending).local, { x: 160, y: 140, width: 140, height: 100 })
})

test('Space does nothing when not drawing', async () => {
  const selector = new RegionSelect()
  const pending = selector.start({ bounds: BOUNDS })
  const element = surface()
  drag(element, { x: 100, y: 100 }, { x: 200, y: 200 })
  doc.dispatch('keydown', { key: ' ' })
  doc.dispatch('keyup', { key: ' ' })
  assert.deepEqual(selector.rect, { x: 100, y: 100, width: 100, height: 100 })
  doc.dispatch('keydown', { key: 'Escape' })
  assert.equal(await pending, null)
})

test('the cursor bubble shows only while idle with the pointer on the surface', async () => {
  const selector = new RegionSelect()
  const pending = selector.start({ bounds: BOUNDS })
  const element = surface()
  const bubble = element.children.find((child) => child.tag === 'div' && child.style.willChange)
  assert.equal(bubble.style.opacity, '0', 'hidden until the pointer is known')
  selector.pointerAt({ x: 400, y: 300 })
  assert.equal(bubble.style.opacity, '1')
  drag(element, { x: 400, y: 300 }, { x: 600, y: 500 })
  assert.equal(bubble.style.opacity, '0', 'gone once a box exists')
  selector.pointerAt(null)
  doc.dispatch('keydown', { key: 'Escape' })
  assert.equal(await pending, null)
})

test('an area limits drawing and moving, and presses outside it do nothing', async () => {
  const area = { x: 100, y: 100, width: 400, height: 300 }
  const selector = new RegionSelect({ area })
  const pending = selector.start({ bounds: BOUNDS })
  const element = surface()
  drag(element, { x: 20, y: 20 }, { x: 300, y: 300 })
  assert.equal(selector.rect, null, 'a press outside the area starts nothing')
  drag(element, { x: 200, y: 200 }, { x: 900, y: 900 })
  assert.deepEqual(selector.rect, { x: 200, y: 200, width: 300, height: 200 }, 'clamped to it')
  // Move it far up-left: it stops at the area's corner.
  drag(element, { x: 300, y: 300 }, { x: -500, y: -500 })
  assert.deepEqual(selector.rect, { x: 100, y: 100, width: 300, height: 200 })
  doc.dispatch('keydown', { key: 'Escape' })
  assert.equal(await pending, null)
})

test('an initial box opens ready to confirm, pristine until touched, and reset replaces it', async () => {
  const initial = { x: 50, y: 60, width: 200, height: 100 }
  const selector = new RegionSelect({ initial })
  const pending = selector.start({ bounds: BOUNDS })
  assert.deepEqual(selector.rect, initial)
  assert.equal(selector.pristine, true)
  assert.equal(selector.idle, false, 'a box is showing, so no cursor bubble')
  selector.reset(null)
  assert.equal(selector.rect, null)
  assert.equal(selector.idle, true)
  selector.reset(initial)
  doc.dispatch('keydown', { key: 'ArrowRight' })
  assert.equal(selector.pristine, false, 'a nudge is an edit')
  doc.dispatch('keydown', { key: 'Enter' })
  assert.deepEqual((await pending).local, { x: 51, y: 60, width: 200, height: 100 })
})

/** Animation frames run by hand, at chosen times, while `body` runs. */
async function withFrames(body) {
  const queue = []
  globalThis.requestAnimationFrame = (callback) => queue.push(callback)
  globalThis.cancelAnimationFrame = (id) => {
    queue[id - 1] = null
  }
  const run = (time) => {
    const pending = queue.splice(0)
    for (const callback of pending) callback?.(time)
  }
  try {
    await body(run)
  } finally {
    delete globalThis.requestAnimationFrame
    delete globalThis.cancelAnimationFrame
  }
}

test('a stick push opens stick mode: the left stick moves the top-left corner, the right the bottom-right', async () => {
  await withFrames(async (frame) => {
    const area = { x: 0, y: 0, width: 1000, height: 800 }
    const selector = new RegionSelect({ area, pad: { confirm: 'A', cancel: 'B' } })
    const pending = selector.start({ bounds: BOUNDS })
    assert.equal(selector.stickMode, false)
    // Full left and up on the left stick (y is positive up).
    selector.sticks({ x: -1, y: 1 }, { x: 0, y: 0 })
    assert.equal(selector.stickMode, true)
    assert.deepEqual(selector.rect, { x: 250, y: 200, width: 500, height: 400 }, 'the middle half of the area')
    frame(1000)
    frame(1050)
    const moved = selector.rect
    assert.ok(moved.x < 250 && moved.y < 200, 'top-left went up and left')
    assert.equal(moved.x + moved.width, 750, 'bottom-right stayed')
    // The right stick pushes the bottom-right corner down and right.
    selector.sticks({ x: 0, y: 0 }, { x: 1, y: -1 })
    frame(2000)
    frame(2050)
    assert.ok(selector.rect.x + selector.rect.width > 750)
    assert.ok(selector.rect.y + selector.rect.height > 600)
    selector.confirm()
    const { local } = await pending
    assert.ok(Number.isInteger(local.x) && Number.isInteger(local.width), 'whole points come back')
  })
})

test('in stick mode the corners stop at the area and never cross', async () => {
  await withFrames(async (frame) => {
    const area = { x: 100, y: 100, width: 400, height: 300 }
    const selector = new RegionSelect({ area, pad: {} })
    const pending = selector.start({ bounds: BOUNDS })
    selector.sticks({ x: 1, y: -1 }, { x: -1, y: 1 })
    for (let time = 0; time < 3000; time += 50) frame(time)
    const rect = selector.rect
    assert.ok(rect.width >= 16 && rect.height >= 16, 'the corners keep apart')
    selector.sticks({ x: -1, y: 1 }, { x: 1, y: -1 })
    for (let time = 3000; time < 6000; time += 50) frame(time)
    assert.deepEqual(selector.rect, area, 'out to the area and no further')
    selector.cancel()
    assert.equal(await pending, null)
  })
})

test('a stick at rest starts nothing, and touching the box leaves stick mode', async () => {
  await withFrames(async (frame) => {
    const selector = new RegionSelect({ area: { x: 0, y: 0, width: 1000, height: 800 }, pad: {} })
    const pending = selector.start({ bounds: BOUNDS })
    selector.sticks({ x: 0.1, y: 0.1 }, { x: 0, y: 0 })
    assert.equal(selector.rect, null, 'inside the deadzone')
    selector.sticks({ x: 0, y: 0 }, { x: 1, y: 0 })
    frame(0)
    frame(50)
    // A finger moves the box: stick mode ends, and a resting stick does not bring it back.
    drag(surface(), { x: 500, y: 400 }, { x: 520, y: 400 }, 7)
    assert.equal(selector.stickMode, false)
    selector.sticks({ x: 0, y: 0 }, { x: 0, y: 0 })
    assert.equal(selector.stickMode, false)
    selector.cancel()
    await pending
  })
})

test('a touch press grabs an edge from further away than a mouse press', async () => {
  const selector = new RegionSelect({ initial: { x: 100, y: 100, width: 200, height: 200 } })
  const pending = selector.start({ bounds: BOUNDS })
  const element = surface()
  // 15 points outside the right edge: a mouse there starts a new box, a finger resizes.
  element.dispatch('pointerdown', { button: 0, pointerId: 1, pointerType: 'touch', clientX: 315, clientY: 200 })
  element.dispatch('pointermove', { pointerId: 1, clientX: 400, clientY: 200 })
  element.dispatch('pointerup', { pointerId: 1, clientX: 400, clientY: 200 })
  assert.deepEqual(selector.rect, { x: 100, y: 100, width: 300, height: 200 })
  selector.cancel()
  await pending
})
