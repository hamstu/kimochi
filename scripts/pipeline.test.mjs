import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { Generation, PipelineLock, selectionKey, sameSelection } = await load('pipeline.ts')
const { AutoScanner, DEFAULT_AUTO_OCR_SETTINGS } = await load('autoscan.ts')

const crop = { x: 0, y: 40, width: 576, height: 320, reference_width: 640, reference_height: 400 }

test('a selection is identified by its source and crop together', () => {
  assert.ok(sameSelection({ sourceId: 'w:1', crop }, { sourceId: 'w:1', crop: { ...crop } }))
  // Key order must not matter: the crop arrives as JSON from two different sides.
  assert.equal(
    selectionKey({ sourceId: 'w:1', crop }),
    selectionKey({
      sourceId: 'w:1',
      crop: { height: 320, width: 576, y: 40, x: 0, reference_height: 400, reference_width: 640 }
    })
  )
  assert.ok(!sameSelection({ sourceId: 'w:1', crop }, { sourceId: 'w:2', crop }))
  assert.ok(!sameSelection({ sourceId: 'w:1', crop }, { sourceId: 'w:1', crop: null }))
})

test('a result that lands after the source changed is stale', async () => {
  const generation = new Generation()
  const job = { generation: generation.current }

  // The endpoint has a 45 second timeout; the user is free to do anything in it.
  let settle
  const slowOcr = new Promise((resolve) => {
    settle = resolve
  })

  assert.equal(generation.isStale(job), false)
  generation.bumpIfChanged({ sourceId: 'w:1', crop: null }, { sourceId: 'w:2', crop: null })
  settle({ fullText: '古いテキスト' })
  await slowOcr

  assert.equal(
    generation.isStale(job),
    true,
    'the late result belongs to a source the user is no longer looking at'
  )
})

test('a result that lands after a new crop is committed is stale', () => {
  const generation = new Generation()
  const job = { generation: generation.current }
  generation.bumpIfChanged({ sourceId: 'w:1', crop: null }, { sourceId: 'w:1', crop })
  assert.equal(generation.isStale(job), true)
})

test('an unchanged selection does not invalidate work in flight', () => {
  const generation = new Generation()
  const job = { generation: generation.current }
  assert.equal(
    generation.bumpIfChanged({ sourceId: 'w:1', crop }, { sourceId: 'w:1', crop: { ...crop } }),
    false
  )
  assert.equal(generation.isStale(job), false)
})

test('the first selection seen establishes a baseline rather than invalidating', () => {
  const generation = new Generation()
  assert.equal(generation.bumpIfChanged(null, { sourceId: 'w:1', crop: null }), true)
  assert.equal(generation.current, 1)
})

test('the lock admits one holder and skips the rest', async () => {
  const lock = new PipelineLock()
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })

  const first = lock.run(async () => {
    await held
    return 'first'
  })
  assert.equal(lock.isHeld, true)
  assert.equal(await lock.run(async () => 'second'), null, 'the overlapping call is skipped')

  release()
  assert.equal(await first, 'first')
  assert.equal(lock.isHeld, false)
  assert.equal(await lock.run(async () => 'third'), 'third')
})

test('the lock is released even when the work throws', async () => {
  const lock = new PipelineLock()
  await assert.rejects(
    lock.run(async () => {
      throw new Error('permission: Screen Recording not granted')
    })
  )
  assert.equal(lock.isHeld, false)
})

test('the auto loop skips a tick entirely while a manual scan holds the lock', async () => {
  const lock = new PipelineLock()
  let captures = 0
  let recognitions = 0
  const scanner = new AutoScanner(
    {
      now: () => Date.now(),
      isBusy: () => lock.isHeld,
      tryAcquire: () => lock.acquire(),
      releaseLock: () => lock.release(),
      captureFrame: async () => {
        captures++
        return {
          frame: { id: captures },
          hash: '0000000000000000',
          observation: { text: '猫が好きです', lines: [] }
        }
      },
      recognize: async () => {
        recognitions++
        return { fullText: '猫', textAnnotations: [] }
      },
      onResult: () => {}
    },
    { ...DEFAULT_AUTO_OCR_SETTINGS, minRequestSpacingMs: 0 }
  )

  lock.acquire()
  assert.equal(await scanner.tick(), 'busy')
  assert.equal(captures, 0, 'a skipped tick does not even capture')

  lock.release()
  assert.equal(await scanner.tick(), 'observed', 'one sighting is not yet worth a request')
  assert.equal(await scanner.tick(), 'requested')
  await scanner.idle()
  assert.equal(captures, 2)
  assert.equal(recognitions, 1)
  assert.equal(lock.isHeld, false, 'and the loop gave the lock back')
})

test('the loop takes the same lock the manual path does, not a private flag', async () => {
  // The fault this closes: the automatic path used to check `isBusy` at the top
  // of a tick and then run its request without holding anything, so a scan
  // started by hand a moment later ran alongside it.
  const lock = new PipelineLock()
  const held = []
  const scanner = new AutoScanner(
    {
      now: () => Date.now(),
      isBusy: () => lock.isHeld,
      tryAcquire: () => lock.acquire(),
      releaseLock: () => lock.release(),
      captureFrame: async () => ({
        frame: {},
        observation: { text: '台詞', lines: [] }
      }),
      recognize: async () => {
        held.push(lock.isHeld)
        return { fullText: '台詞', textAnnotations: [] }
      },
      onResult: () => {}
    },
    { ...DEFAULT_AUTO_OCR_SETTINGS, minRequestSpacingMs: 0 }
  )

  await scanner.tick()
  await scanner.tick()
  await scanner.idle()
  assert.deepEqual(held, [true], 'the recognition ran with the shared lock held')
  assert.equal(lock.isHeld, false)
})

test("changing the active game invalidates OCR even when portal stream and crop stay identical", () => {
  const generation = new Generation();
  const job = { generation: generation.current };
  const previous = {
    sourceId: "portal:display:80",
    crop: null,
    applicationContextId: "steam:42",
  };
  assert.equal(
    generation.bumpIfChanged(previous, {
      ...previous,
      applicationContextId: "steam:43",
    }),
    true,
  );
  assert.equal(generation.isStale(job), true);
  assert.equal(sameSelection(previous, { ...previous }), true);
});
