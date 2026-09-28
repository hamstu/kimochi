import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'
const { ScanTrace, editSummary } = await load('scan-trace.ts')
const line = (text, x = 0) => ({ text, box: { x, y: 10, width: 120, height: 20 } })
const input = (text, fingerprint, x = 0) => ({
  frameId: 1,
  generation: 1,
  fingerprint,
  observation: { text, lines: [line(text, x)] },
  captureMs: 120,
  observerMs: 30,
  roundTripMs: 155,
  width: 500,
  height: 800
})

test('trace separates pixel-only, punctuation, numeric and layout changes without logging content', async () => {
  const records = []
  const trace = new ScanTrace(
    async (batch) => records.push(...batch),
    () => 1000,
    'fixture'
  )
  trace.observation(input('秘密の文章HP12', 'private-pixel-digest'))
  trace.observation(input('秘密の文章HP12', 'changed-pixels'))
  trace.observation(input('秘密の文章HP12。', 'third'))
  trace.observation(input('秘密の文章HP13。', 'fourth'))
  trace.observation(input('秘密の文章HP13。', 'fifth', 30))
  trace.result(1, '秘密の文章HP13。', 900)
  await trace.flush()
  assert.equal(records[1].pixelsChanged, true)
  assert.equal(records[1].normalizedTextChanged, false)
  assert.equal(records[2].rawTextChanged, true)
  assert.equal(records[2].normalizedTextChanged, false)
  assert.equal(records[3].numericOnly, true)
  assert.equal(records[3].normalizedTextChanged, true)
  assert.equal(records[4].changedLines, 1)
  assert.equal(records[4].rawTextChanged, false)
  assert.equal(records[5].durationMs, 900)
  assert.ok(!JSON.stringify(records).includes('秘密'))
  assert.ok(!JSON.stringify(records).includes('private-pixel-digest'))
})

test('trace compares each source generation independently and caps per-line detail', async () => {
  const records = []
  const trace = new ScanTrace(
    async (batch) => records.push(...batch),
    () => 1000,
    'fixture'
  )
  trace.observation(input('abc', 'one'))
  const next = input('abc', 'one')
  next.generation = 2
  next.observation.lines = Array.from({ length: 60 }, (_, i) => line(String(i)))
  trace.observation(next)
  await trace.flush()
  assert.equal(records[1].pixelsChanged, null)
  assert.equal(records[1].relation, 'first')
  assert.equal(records[1].changes.length, 40)
  assert.equal(records[1].truncatedLines, 20)
})

test('blocked diagnostic writer stays bounded, records drops and cannot reject into OCR', async () => {
  let release
  let fail = true
  const batches = []
  const trace = new ScanTrace(
    async (batch) => {
      batches.push(batch)
      if (fail) {
        await new Promise((resolve) => {
          release = resolve
        })
        throw Error('disk unavailable')
      }
    },
    () => 0,
    'fixture'
  )
  trace.record('start')
  const pending = trace.flush()
  for (let i = 0; i < 1000; i++) trace.record('decision')
  release()
  await pending
  fail = false
  for (let i = 0; i < 4; i++) await trace.flush()
  assert.equal(batches.flat().length, 257)
  assert.equal(batches[1][0].droppedRecords, 745)
})

test('edit summaries count Unicode characters and preserve single-character semantic changes', () => {
  assert.deepEqual(editSummary('猫が好きです', '犬が好きです'), {
    prefixChars: 0,
    removedChars: 1,
    addedChars: 1,
    numericOnly: false
  })
})
