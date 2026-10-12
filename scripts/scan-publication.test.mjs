import test from 'node:test'
import assert from 'node:assert/strict'
import { scanWasPublished, markScanPublished } from '../ui/scan-publication.js'

test('native scan outputs are not replayed when an engine switch recreates the overlay', () => {
  const entries = new Map()
  const session = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) }
  const output = []
  const apply = (id, storage) => {
    if (!scanWasPublished(id, storage)) {
      output.push(id)
      markScanPublished(id, storage)
    }
  }
  apply(12, session)
  apply(12, { ...session }) // A new document with the same native window session.
  apply(13, session)
  assert.deepEqual(output, [12, 13])
  const nextSession = { getItem: () => null, setItem: () => {} }
  apply(12, nextSession) // A new native process may reuse scan IDs.
  assert.deepEqual(output, [12, 13, 12])
})

test('unavailable session storage and scans without an ID retain publication', () => {
  const denied = { getItem() { throw new Error('unavailable') }, setItem() { throw new Error('unavailable') } }
  assert.equal(scanWasPublished(1, denied), false)
  assert.doesNotThrow(() => markScanPublished(1, denied))
  assert.equal(scanWasPublished(null, denied), false)
})
