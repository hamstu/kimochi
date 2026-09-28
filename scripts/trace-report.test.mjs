import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarize } from './trace-report.mjs'

test('report counts actual recognitions separately from pending events and correlates frame identity', () => {
  const common = { session: 'fixture', at: 1000 }
  const report = summarize([
    {
      ...common,
      kind: 'first-pass',
      frameId: 4,
      relation: 'identical',
      normalizedTextId: 2,
      pixelsChanged: true,
      normalizedTextChanged: false,
      captureMs: 120
    },
    { ...common, kind: 'decision', event: { type: 'request', queued: true } },
    { ...common, kind: 'second-pass-start', frameId: 4 },
    { ...common, kind: 'second-pass-end', frameId: 4, durationMs: 900 },
    { ...common, kind: 'apply-end', frameId: 4, durationMs: 12 },
    { ...common, kind: 'decision', event: { type: 'skip', reason: 'superseded' } }
  ])
  assert.equal(report.actualRequests, 1)
  assert.equal(report.queuedEvents, 1)
  assert.equal(report.firstPass.pixelChangesWithUnchangedText, 1)
  assert.equal(report.timingsMs.secondPass.p50, 900)
  assert.equal(report.requests[0].normalizedTextId, 2)
  assert.equal(report.skips.superseded, 1)
})
