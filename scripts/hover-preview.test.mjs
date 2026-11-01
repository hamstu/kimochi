/**
 * The hover outline's window picture: one capture per hover, reused briefly, and
 * never shown once its hover has ended. The picture itself needs the real app; the
 * timing rules that decide whether it appears are pinned here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HoverPreview } from '../ui/hover.js'

function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

function harness({ now = () => 0 } = {}) {
  const calls = []
  const preview = new HoverPreview({
    now,
    capture: ({ reusable }) => {
      const recent = reusable('win-1')
      if (recent) return { key: 'win-1', url: recent, reused: true }
      const pending = deferred()
      calls.push(pending)
      return pending.promise
    }
  })
  return { preview, calls }
}

test('shows the picture once the capture lands', async () => {
  const { preview, calls } = harness()
  const started = preview.start()
  assert.equal(preview.url, null)
  calls[0].resolve({ key: 'win-1', url: 'capture://localhost/hover/1' })
  await started
  assert.equal(preview.url, 'capture://localhost/hover/1')
})

test('a capture that lands after the hover ended is dropped', async () => {
  const { preview, calls } = harness()
  const started = preview.start()
  preview.stop()
  calls[0].resolve({ key: 'win-1', url: 'capture://localhost/hover/1' })
  await started
  assert.equal(preview.url, null)
})

test('a slow capture cannot overwrite a newer hover', async () => {
  let clock = 0
  const { preview, calls } = harness({ now: () => clock })
  const first = preview.start()
  preview.stop()
  const second = preview.start()
  calls[1].resolve({ key: 'win-1', url: 'capture://localhost/hover/2' })
  await second
  calls[0].resolve({ key: 'win-1', url: 'capture://localhost/hover/1' })
  await first
  assert.equal(preview.url, 'capture://localhost/hover/2')
})

test('reuses a recent capture of the same source, recaptures a stale one', async () => {
  let clock = 0
  const { preview, calls } = harness({ now: () => clock })
  const first = preview.start()
  calls[0].resolve({ key: 'win-1', url: 'capture://localhost/hover/1' })
  await first
  preview.stop()

  clock = 1500
  await preview.start()
  assert.equal(calls.length, 1, 'a hover within the reuse window must not capture again')
  assert.equal(preview.url, 'capture://localhost/hover/1')
  preview.stop()

  clock = 2500
  const third = preview.start()
  assert.equal(calls.length, 2, 'an old capture is retaken')
  calls[1].resolve({ key: 'win-1', url: 'capture://localhost/hover/2' })
  await third
  assert.equal(preview.url, 'capture://localhost/hover/2')
})

test('a failed or busy capture leaves the outline alone', async () => {
  const preview = new HoverPreview({
    capture: async () => {
      throw new Error('busy: a scan is running')
    }
  })
  await preview.start()
  assert.equal(preview.url, null)
})

test('a later hover shows the last picture at once, then the fresh one, releasing the old', async () => {
  let clock = 0
  const released = []
  const calls = []
  const seen = []
  const preview = new HoverPreview({
    now: () => clock,
    release: (url) => released.push(url),
    onChange: () => seen.push(preview.url),
    capture: ({ reusable, show }) => {
      const recent = reusable('win-1')
      if (recent) return { key: 'win-1', url: recent, reused: true }
      show('win-1')
      const pending = deferred()
      calls.push(pending)
      return pending.promise
    }
  })
  const first = preview.start()
  calls[0].resolve({ key: 'win-1', url: 'blob:1' })
  await first
  preview.stop()

  clock = 5000
  const second = preview.start()
  assert.equal(preview.url, 'blob:1', 'the stale picture shows while the new capture runs')
  assert.equal(preview.fresh, false, 'the stale picture is drawn blurred')
  calls[1].resolve({ key: 'win-1', url: 'blob:2' })
  await second
  assert.equal(preview.url, 'blob:2')
  assert.equal(preview.fresh, true)
  assert.deepEqual(released, ['blob:1'])
  assert.ok(!seen.includes(null) || seen.lastIndexOf(null) < seen.indexOf('blob:1', 1))
})

test('show() is ignored for another source and after the hover ends', async () => {
  const calls = []
  const preview = new HoverPreview({
    capture: ({ show }) => {
      calls.push(show)
      const pending = deferred()
      calls.push(pending)
      return pending.promise
    }
  })
  const first = preview.start()
  calls[1].resolve({ key: 'win-1', url: 'blob:1' })
  await first
  preview.stop()
  void preview.start()
  calls[2]('win-2')
  assert.equal(preview.url, null, 'no picture of another source')
  preview.stop()
  calls[2]('win-1')
  assert.equal(preview.url, null, 'nothing once the hover has ended')
})

test('the window is not marked when its markings would cover the hovered card', async () => {
  const { marksUnderPointer } = await import('../ui/hover.js')
  // A maximised game behind Kimochi: the card being hovered is inside the game's bounds, so
  // its outline and picture would be drawn over the card and its Crop area / Change source.
  const game = { x: 0, y: 0, width: 2560, height: 1400 }
  assert.equal(marksUnderPointer(game, { x: 300, y: 200 }), true)
  // A window elsewhere on the desktop, or on a display left of the primary, is marked.
  assert.equal(marksUnderPointer(game, { x: 2600, y: 200 }), false)
  assert.equal(marksUnderPointer({ x: -1920, y: 0, width: 1920, height: 1080 }, { x: 100, y: 10 }), false)
  // Edges are half-open, like every other rectangle test here.
  assert.equal(marksUnderPointer(game, { x: 2560, y: 0 }), false)
  // No pointer reading (Wayland, a failed call) or no bounds yet: mark as before.
  assert.equal(marksUnderPointer(game, null), false)
  assert.equal(marksUnderPointer(null, { x: 1, y: 1 }), false)
  assert.equal(marksUnderPointer(game, { x: Number.NaN, y: 1 }), false)
})
