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
