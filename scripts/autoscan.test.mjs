import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { AutoScanner, DEFAULT_AUTO_OCR_SETTINGS, migrateAutoScanSettings } =
  await load('autoscan.ts')

const HASH_A = '0000000000000000'
const HASH_B = 'ffffffffffffffff'

const line = (text, x = 40, y = 400, width = 600, height = 30) => ({
  text,
  box: { x, y, width, height }
})

/**
 * A scanner wired to scripted fakes and a hand-cranked clock.
 *
 * Nothing here captures a screen, opens a socket, or starts a timer. `step()`
 * advances the fake clock and drives one tick, so every interval, every backoff
 * and every settling decision is observed directly rather than waited for.
 */
function harness(overrides = {}, depOverrides = {}) {
  const state = {
    time: 100000,
    frames: 0,
    generation: 1,
    hash: HASH_A,
    /** What the local observer reads this tick. */
    text: '',
    lines: null,
    observerError: null,
    observerUnsupported: false,
    /** What the accurate recogniser answers. A function sees the frame. */
    recognized: (frame) => ({ fullText: `cloud:${frame.observedText}`, textAnnotations: [] }),
    recognizeError: null,
    captureError: null,
    /** Another path (a hand-triggered scan) holds the shared lock. */
    busy: false,
    /** Set to block capture, for driving two ticks at once. */
    captureGate: null,
    captures: [],
    recognizeCalls: [],
    results: [],
    events: [],
    retained: [],
    released: [],
    /** Every pin operation in the order it was actually applied natively. */
    pinLog: [],
    /** Resolve a retain only when the test says so. */
    retainGate: null,
    /** Gate only this frame id's retain, leaving earlier ones alone. */
    retainGateFor: null,
    /** Make the native retain refuse. */
    retainError: null,
    /** Refuse only this frame id's retain. */
    retainErrorFor: null,
    releaseError: null,
    /** Hold up result application, standing in for drawing and publishing. */
    slowResult: null
  }
  /** Stands in for the overlay's PipelineLock, shared by both paths. */
  const lock = {
    held: false,
    acquire() {
      if (this.held) return false
      this.held = true
      return true
    },
    release() {
      this.held = false
    }
  }

  const scanner = new AutoScanner(
    {
      now: () => state.time,
      generation: () => state.generation,
      isBusy: () => state.busy || lock.held,
      tryAcquire: () => {
        if (state.busy || lock.held) return false
        lock.held = true
        return true
      },
      releaseLock: () => {
        lock.held = false
      },
      captureFrame: async () => {
        if (state.captureGate) await state.captureGate
        if (state.captureError) throw new Error(state.captureError)
        const frame = { id: ++state.frames, observedText: state.text }
        state.captures.push(frame.id)
        const blind = state.observerError || state.observerUnsupported
        return {
          frame,
          hash: state.hash,
          observation: blind
            ? null
            : { text: state.text, lines: state.lines ?? (state.text ? [line(state.text)] : []) },
          observerError: state.observerError,
          observerUnsupported: state.observerUnsupported,
          observerBusy: state.observerBusy,
          generation: state.generation
        }
      },
      recognize: async (frame) => {
        state.recognizeCalls.push(frame.id)
        if (state.recognizeError) throw new Error(state.recognizeError)
        return typeof state.recognized === 'function' ? state.recognized(frame) : state.recognized
      },
      retainFrame: async (frame) => {
        if (
          state.retainGate &&
          (state.retainGateFor === null || state.retainGateFor === frame.id)
        ) {
          await state.retainGate
        }
        if (
          state.retainError &&
          (state.retainErrorFor === null || state.retainErrorFor === frame.id)
        ) {
          throw new Error(state.retainError)
        }
        state.retained.push(frame.id)
        state.pinLog.push(`retain:${frame.id}`)
      },
      releaseFrame: async (frame) => {
        if (state.releaseError) throw new Error(state.releaseError)
        state.released.push(frame.id)
        state.pinLog.push(`release:${frame.id}`)
      },
      onResult: async (result, frame, info) => {
        if (state.slowResult) await state.slowResult
        state.results.push({
          text: result.fullText,
          frame: frame.id,
          publish: info.publish,
          reason: info.reason
        })
      },
      onEvent: (event) => state.events.push(event),
      ...depOverrides
    },
    { ...DEFAULT_AUTO_OCR_SETTINGS, ...overrides }
  )

  /**
   * Advance the clock, run one tick, and wait for any recognition it started.
   *
   * A request deliberately outlives the tick that began it, so a test that wants
   * to assert on its result has to say so. `stepAsync` is the variant that does
   * not wait, for the tests that are about what happens *while* one is out.
   */
  const step = async (ms = 2000) => {
    state.time += ms
    const outcome = await scanner.tick()
    await scanner.idle()
    return outcome
  }
  const stepAsync = async (ms = 2000) => {
    state.time += ms
    return scanner.tick()
  }
  /** Set what the observer will read from now on. */
  const sees = (text, lines = null) => {
    state.text = text
    state.lines = lines
  }
  const published = () => state.results.filter((r) => r.publish).map((r) => r.text)
  const skips = (reason) =>
    state.events.filter((e) => e.type === 'skip' && e.reason === reason).length

  /** Stand in for the manual path trying to take the shared lock. */
  const tryManual = () => lock.acquire()
  const releaseManual = () => lock.release()

  return {
    scanner,
    state,
    lock,
    step,
    stepAsync,
    sees,
    published,
    skips,
    tryManual,
    releaseManual
  }
}

/** Frames pinned natively but never released. */
const leaked = (state) => {
  const open = new Map()
  for (const id of state.retained) open.set(id, (open.get(id) ?? 0) + 1)
  for (const id of state.released) open.delete(id)
  return [...open.keys()]
}

// --- settling --------------------------------------------------------------

test('one sighting is not enough; the second identical observation settles it', async () => {
  const h = harness()
  h.sees('猫が好きです')

  assert.equal(await h.step(), 'observed')
  assert.equal(h.state.recognizeCalls.length, 0, 'a first sighting costs nothing')

  assert.equal(await h.step(), 'requested')
  assert.equal(h.state.recognizeCalls.length, 1)
  assert.deepEqual(h.published(), ['cloud:猫が好きです'])
})

test('static dialogue: many identical observations produce exactly one request', async () => {
  const h = harness()
  h.sees('動かない台詞')
  for (let i = 0; i < 30; i++) await h.step()

  assert.equal(h.state.recognizeCalls.length, 1, 'thirty observations, one recognition')
  assert.deepEqual(h.published(), ['cloud:動かない台詞'])
  assert.equal(h.scanner.stats().requests, 1)
  assert.equal(h.state.captures.length, 30, 'but it kept looking, cheaply')
})

test('scenery animating behind unchanged text costs nothing', async () => {
  const h = harness()
  h.sees('背景は動くが台詞は同じ')
  for (let i = 0; i < 20; i++) {
    // Every frame is pixel-different: a whole-crop image hash would pass all 20.
    h.state.hash = i % 2 ? HASH_A : HASH_B
    await h.step()
  }
  assert.equal(h.state.recognizeCalls.length, 1)
  assert.equal(h.scanner.stats().observations, 20)
})

test('an unchanged hash never suppresses the observation that settles a candidate', async () => {
  const h = harness()
  h.state.hash = HASH_A
  h.sees('止まった画面')
  await h.step()
  // Same pixels, same hash: the second observation must still be taken and must
  // still settle the candidate, or a frozen screen is never recognised at all.
  assert.equal(await h.step(), 'requested')
  assert.equal(h.scanner.stats().hashUnchanged, 1)
  assert.equal(h.state.recognizeCalls.length, 1)
})

// --- typewriter ------------------------------------------------------------

test('typewriter growth is recognised once, when it stops', async () => {
  const h = harness()
  for (const prefix of ['は', 'はじ', 'はじめ', 'はじめま', 'はじめまし', 'はじめまして']) {
    h.sees(prefix)
    await h.step(600)
  }
  assert.equal(h.state.recognizeCalls.length, 0, 'nothing is sent while it is still typing')

  h.sees('はじめまして')
  await h.step(600)
  assert.equal(h.state.recognizeCalls.length, 1)
  assert.deepEqual(h.published(), ['cloud:はじめまして'])
})

test('a pause mid-line does not publish the half-drawn line twice', async () => {
  const h = harness({ stableObservations: 2, maxCandidateAgeMs: 100000 })
  h.sees('お腹が')
  await h.step(600)
  await h.step(600) // it paused here: settles and is sent
  assert.equal(h.state.recognizeCalls.length, 1)

  h.sees('お腹が空きました')
  await h.step(600)
  await h.step(600)
  assert.equal(h.state.recognizeCalls.length, 2, 'the completed line is worth a second look')
  assert.deepEqual(h.published(), ['cloud:お腹が', 'cloud:お腹が空きました'])
})

test('a wrap that only moves a line break is not new dialogue', async () => {
  const h = harness()
  h.sees('とても長い台詞がここに\nあります')
  await h.step()
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 1)

  // The same sentence, wrapped one character later.
  h.sees('とても長い台詞がここにあ\nります')
  await h.step()
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 1, 'a rewrap costs nothing')
})

test('a half-drawn final glyph resets settling rather than being recognised', async () => {
  const h = harness()
  h.sees('これは本当ぽ')
  await h.step(500)
  h.sees('これは本当に危')
  await h.step(500)
  assert.equal(h.state.recognizeCalls.length, 0, 'still evolving')
  h.sees('これは本当に危ない')
  await h.step(500)
  await h.step(500)
  assert.equal(h.state.recognizeCalls.length, 1)
  assert.deepEqual(h.published(), ['cloud:これは本当に危ない'])
})

// --- the changes that must never be swallowed ------------------------------

test('a one-character change is new dialogue and is recognised', async () => {
  const h = harness()
  h.sees('今日は寒いね')
  await h.step()
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 1)

  h.sees('今日は寒いよ')
  await h.step()
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 2)
  assert.deepEqual(h.published(), ['cloud:今日は寒いね', 'cloud:今日は寒いよ'])
})

test('a new sentence in exactly the same box is recognised, not suppressed', async () => {
  const h = harness()
  const box = [line('一行目', 40, 400, 600, 30)]
  h.sees('最初の台詞です', box)
  await h.step()
  await h.step()

  // Identical geometry, different words: GSM's detector path drops this.
  h.sees('二番目の台詞です', [line('二行目', 40, 400, 600, 30)])
  await h.step()
  await h.step()

  assert.equal(h.state.recognizeCalls.length, 2)
  assert.equal(h.scanner.stats().sameLayoutReplacements, 1, 'and it was noticed as such')
  assert.deepEqual(h.published(), ['cloud:最初の台詞です', 'cloud:二番目の台詞です'])
})

test('punctuation noise neither settles late nor triggers a second request', async () => {
  const h = harness()
  const jitter = ['そうか', 'そうか。', 'そうか', '「そうか」', 'そうか、', 'そうか']
  for (const reading of jitter) {
    h.sees(reading)
    await h.step(500)
  }
  assert.equal(h.state.recognizeCalls.length, 1, 'jitter is one settled candidate')
  assert.equal(h.published().length, 1, 'and one published line')
  assert.ok(
    h.scanner.currentInterval > DEFAULT_AUTO_OCR_SETTINGS.adaptivePollMin,
    'and it did not hold the loop at the floor'
  )
})

test('a dropped tail does not replace the candidate until it repeats', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  h.sees('今日は寒いね')
  await h.step()
  h.sees('今日は寒い') // one bad reading
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 0, 'not settled: the reading moved')
  h.sees('今日は寒いね')
  await h.step()
  await h.step()
  assert.deepEqual(h.published(), ['cloud:今日は寒いね'], 'the longer reading won')
})

test('a tail that really did vanish takes over after it repeats', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  h.sees('今日は寒いね')
  await h.step()
  h.sees('今日は寒い')
  await h.step()
  await h.step()
  assert.deepEqual(h.published(), ['cloud:今日は寒い'])
})

// --- bounded wait, disappearance, reappearance -----------------------------

test('text that never stops moving is recognised once the bounded wait expires', async () => {
  const h = harness({ maxCandidateAgeMs: 4000 })
  let n = 0
  for (let i = 0; i < 12; i++) {
    h.sees('伸び続ける台詞' + 'あ'.repeat(++n))
    await h.step(500)
  }
  const calls = h.state.recognizeCalls.length
  assert.ok(calls >= 1, 'the reader is not starved')
  assert.ok(calls <= 2, `bounded, not one per frame (was ${calls})`)
  assert.ok(h.scanner.stats().maxWaitFlushes >= 1)
})

test('text that vanishes before settling is recognised anyway', async () => {
  const h = harness()
  h.sees('一瞬だけ出る台詞')
  await h.step()
  h.sees('')
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 1)
  assert.equal(h.scanner.stats().disappearanceFlushes, 1)
})

test('the same line reappearing after a sustained blank is published again', async () => {
  const h = harness({ emptyObservationsToClear: 3, minRequestSpacingMs: 0 })
  h.sees('また会いましたね')
  await h.step()
  await h.step()
  assert.deepEqual(h.published(), ['cloud:また会いましたね'])

  h.sees('')
  for (let i = 0; i < 4; i++) await h.step()

  h.sees('また会いましたね')
  await h.step()
  await h.step()
  assert.deepEqual(h.published(), ['cloud:また会いましたね', 'cloud:また会いましたね'])
})

test('a brief blank does not reset deduplication', async () => {
  const h = harness({ emptyObservationsToClear: 3, minRequestSpacingMs: 0 })
  h.sees('消えない記憶')
  await h.step()
  await h.step()
  h.sees('')
  await h.step() // one blank only
  h.sees('消えない記憶')
  await h.step()
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 1, 'still the same line as far as we know')
  assert.equal(
    h.scanner.stats().suppressedDuplicateSubmission,
    1,
    'and the saving was made before the request, not after it'
  )
})

test('a cleared log lets the same line through again, but an unchanged screen stays free', async () => {
  const h = harness({ emptyObservationsToClear: 3, minRequestSpacingMs: 0 })
  h.sees('消した台詞')
  await h.step()
  await h.step()
  assert.deepEqual(h.published(), ['cloud:消した台詞'])

  // The reader clears the log while the line is still showing: nothing is written back.
  h.scanner.forgetPublished()
  for (let i = 0; i < 4; i++) await h.step()
  assert.equal(h.state.recognizeCalls.length, 1, 'an unchanged screen costs nothing')

  // A brief blank, then the same line: the log no longer has it, so it goes in again.
  h.sees('')
  await h.step()
  h.sees('消した台詞')
  await h.step()
  await h.step()
  assert.deepEqual(h.published(), ['cloud:消した台詞', 'cloud:消した台詞'])
})

test('an empty screen never spends a request', async () => {
  const h = harness()
  h.sees('')
  for (let i = 0; i < 10; i++) await h.step()
  assert.equal(h.state.recognizeCalls.length, 0)
  assert.equal(h.scanner.stats().emptyObservations, 10)
})

// --- publication versus refresh -------------------------------------------

test('the same recognised text refreshes the overlay without publishing again', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  // Two genuinely different local readings that the accurate recogniser resolves
  // to the same sentence — OCR noise downstairs, one line of dialogue upstairs.
  h.state.recognized = () => ({ fullText: '同じ結果', textAnnotations: [] })

  h.sees('読み一')
  await h.step()
  await h.step()
  h.sees('読み二')
  await h.step()
  await h.step()

  assert.equal(h.state.recognizeCalls.length, 2, 'two genuinely different candidates were sent')
  assert.deepEqual(
    h.state.results.map((r) => r.publish),
    [true, false],
    'but the identical result was only redrawn, not written to the history'
  )
  assert.equal(h.scanner.stats().suppressedDuplicatePublication, 1)
  assert.equal(h.scanner.stats().refreshedWithoutPublishing, 1)
})

test('an empty recognition is not published and does not clear what is shown', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  h.state.recognized = () => ({ fullText: '   ', textAnnotations: [] })
  h.sees('何か')
  await h.step()
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 1)
  assert.equal(h.state.results.length, 0)
  assert.equal(h.scanner.stats().emptyResults, 1)
})

// --- one request at a time, no backlog ------------------------------------

test('rapid new dialogue never builds a backlog: only the latest waits', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  let release
  const gate = new Promise((resolve) => (release = resolve))
  let first = true
  h.state.recognized = async (frame) => {
    if (first) {
      first = false
      await gate
    }
    return { fullText: `cloud:${frame.observedText}`, textAnnotations: [] }
  }

  h.sees('台詞A')
  await h.stepAsync()
  await h.stepAsync() // settles A and starts a request that will not answer yet
  assert.equal(h.state.recognizeCalls.length, 1)

  for (const text of ['台詞B', '台詞C', '台詞D', '台詞E']) {
    h.sees(text)
    await h.stepAsync()
    await h.stepAsync()
  }
  assert.equal(h.state.recognizeCalls.length, 1, 'still exactly one recognition in flight')
  // Displaced or dropped for being overtaken by the screen — either way three
  // earlier candidates did not survive to become requests of their own.
  const { replacedPending, staleDiscarded } = h.scanner.stats()
  assert.ok(
    replacedPending + staleDiscarded >= 3,
    `earlier lines did not queue up (replaced ${replacedPending}, dropped ${staleDiscarded})`
  )

  release()
  await h.scanner.idle()
  await h.step()

  assert.equal(
    h.state.recognizeCalls.length,
    2,
    'four new lines during one slow request cost one extra request, not four'
  )
  assert.ok(
    h.published().includes('cloud:台詞E'),
    'and the newest line is the one that got through'
  )
  assert.ok(!h.published().includes('cloud:台詞C'), 'the ones the reader has passed are gone')
})

test('the loop keeps watching the screen while a slow recognition is out', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  let release
  const gate = new Promise((resolve) => (release = resolve))
  h.state.recognized = async () => {
    await gate
    return { fullText: 'x', textAnnotations: [] }
  }
  h.sees('台詞')
  await h.stepAsync()
  await h.stepAsync()
  const before = h.state.captures.length

  for (let i = 0; i < 5; i++) await h.stepAsync()
  assert.ok(
    h.state.captures.length > before,
    'a 45-second endpoint must not blind the loop for 45 seconds'
  )
  release()
  await h.scanner.idle()
})

test('a minimum spacing is enforced between two accurate recognitions', async () => {
  const h = harness({ minRequestSpacingMs: 3000, emptyObservationsToClear: 1 })
  h.sees('一つ目')
  await h.step(1000)
  await h.step(1000)
  assert.equal(h.state.recognizeCalls.length, 1)

  h.sees('二つ目')
  await h.step(1000)
  await h.step(1000) // settled, but only 2s since the last request
  assert.equal(h.state.recognizeCalls.length, 1, 'held back by spacing, not dropped')
  assert.ok(h.skips('spacing') > 0 || h.scanner.stats().spacingDeferrals > 0)

  await h.step(2000) // now past the spacing floor
  assert.equal(h.state.recognizeCalls.length, 2)
  assert.deepEqual(h.published(), ['cloud:一つ目', 'cloud:二つ目'])
})

// --- errors ----------------------------------------------------------------

test('an observer failure never becomes a recognition request', async () => {
  const h = harness()
  h.sees('読めるはずの台詞')
  h.state.observerError = 'Live Text timed out'

  for (let i = 0; i < 3; i++) {
    h.state.time += 60000 // past every backoff
    assert.equal(await h.scanner.tick(), 'error')
  }
  assert.equal(h.state.recognizeCalls.length, 0, 'a broken gate sends nothing')
  assert.equal(h.scanner.stats().observerErrors, 3)
})

test('a busy observer is waited out, never counted towards suspension (#41)', async () => {
  const h = harness({ errorBackoffMs: 2000, maxConsecutiveErrors: 3 })
  h.sees('台詞')
  h.state.observerError = 'The local MeikiOCR observer is still reading an earlier frame; retrying.'
  h.state.observerBusy = true
  for (let i = 0; i < 10; i++) {
    h.state.time += 60000
    assert.equal(await h.scanner.tick(), 'backoff')
  }
  assert.notEqual(h.scanner.state, 'suspended')
  assert.equal(h.scanner.stats().observerErrors, 0)
  h.state.observerError = null
  h.state.observerBusy = false
  await h.step(5000)
  await h.step(5000)
  assert.equal(h.state.recognizeCalls.length, 1, 'reads the text once the observer keeps up')
})

test('a failing observer backs off, then recovers without a restart', async () => {
  const h = harness({ errorBackoffMs: 2000, maxErrorBackoffMs: 30000, maxConsecutiveErrors: 99 })
  h.sees('台詞')
  h.state.observerError = 'Live Text timed out'
  await h.step(1000)
  assert.equal(await h.step(500), 'backoff', 'it does not retry immediately')

  h.state.observerError = null
  await h.step(5000)
  await h.step(5000)
  assert.equal(h.state.recognizeCalls.length, 1, 'and picks up where it left off')
})

test('a persistently failing observer suspends automatic scanning and says so', async () => {
  const h = harness({ maxConsecutiveErrors: 3 })
  h.sees('台詞')
  h.state.observerError = 'VisionKitCore is unavailable'
  for (let i = 0; i < 3; i++) await h.step(60000)

  assert.equal(h.scanner.state, 'suspended')
  assert.match(h.scanner.stateReason, /suspended after 3 consecutive failures/)
  assert.match(h.scanner.stateReason, /Manual scanning still works/)
  const status = h.state.events.filter((e) => e.type === 'status' && e.state === 'suspended')
  assert.equal(status.length, 1)

  assert.equal(await h.step(60000), 'paused')
  assert.equal(h.state.recognizeCalls.length, 0)
})

test('a recognition failure backs off instead of retrying in a loop', async () => {
  const h = harness({ errorBackoffMs: 1000, maxConsecutiveErrors: 99, minRequestSpacingMs: 0 })
  h.state.recognizeError = 'native: OCR network request failed'
  h.sees('台詞')

  for (let i = 0; i < 12; i++) await h.step(500)
  assert.ok(
    h.state.recognizeCalls.length <= 4,
    `twelve ticks did not become twelve requests (was ${h.state.recognizeCalls.length})`
  )
  assert.ok(h.scanner.stats().backoffSkips > 0)
  assert.equal(h.state.results.length, 0)
})

test('a failed recognition does not mark its text as already spent', async () => {
  const h = harness({ errorBackoffMs: 0, maxConsecutiveErrors: 99, minRequestSpacingMs: 0 })
  h.state.recognizeError = 'native: OCR HTTP 503'
  h.sees('もう一度読んで')
  await h.step()
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 1)

  h.state.recognizeError = null
  await h.step()
  await h.step()
  assert.deepEqual(h.published(), ['cloud:もう一度読んで'], 'the retry was allowed')
})

test('a capture failure is reported and the loop survives it', async () => {
  const h = harness({ maxConsecutiveErrors: 99 })
  h.state.captureError = 'permission: Screen Recording not granted'
  assert.equal(await h.step(), 'error')
  assert.equal(h.scanner.stats().captureErrors, 1)

  h.state.captureError = null
  h.sees('回復した')
  await h.step(60000)
  await h.step(60000)
  assert.equal(h.state.recognizeCalls.length, 1)
})

test('a minimised source window is waited out, never suspends the loop, and is read on return', async () => {
  // #2: an exclusive-fullscreen game minimises whenever the reader clicks into Kimochi, so a
  // minimised window is the normal state while Auto OCR is being switched on.
  const h = harness({ errorBackoffMs: 2000, maxErrorBackoffMs: 30000, maxConsecutiveErrors: 3 })
  h.state.captureError = 'gone: hidden: Window is minimized; restore it before capturing.'
  for (let i = 0; i < 20; i++) await h.step(5000)

  assert.notEqual(h.scanner.state, 'suspended', 'a minute and a half away is not a failure')
  assert.equal(h.scanner.stats().captureErrors, 0)
  assert.equal(h.state.events.filter((e) => e.type === 'error').length, 0)
  const waits = h.state.events.filter((e) => e.type === 'skip' && e.reason === 'hidden')
  assert.ok(waits.length > 0)
  assert.equal(waits[0].detail, 'Window is minimized; restore it before capturing.')
  // It keeps looking at the base backoff rather than growing it.
  assert.equal(await h.step(500), 'backoff')
  assert.equal(await h.step(2000), 'backoff', 'still out of view: wait another base backoff')

  h.state.captureError = null
  h.sees('戻ってきた')
  await h.step(2000)
  await h.step(2000)
  assert.equal(h.state.recognizeCalls.length, 1, 'the game is read as soon as it is back')
})

test('a closed source still counts towards suspension', async () => {
  const h = harness({ maxConsecutiveErrors: 3 })
  h.state.captureError = 'gone: Source has closed or disconnected. Refresh sources and select again.'
  for (let i = 0; i < 3; i++) await h.step(60000)
  assert.equal(h.scanner.state, 'suspended')
})

// --- platform availability -------------------------------------------------

test('a platform with no observer reports automatic mode unavailable and uploads nothing', async () => {
  const h = harness()
  h.state.observerUnsupported = true
  h.state.observerError = 'Windows has no local text observer yet.'
  h.sees('台詞')

  assert.equal(await h.step(), 'unavailable')
  assert.equal(h.scanner.state, 'unavailable')
  assert.match(h.scanner.stateReason, /Windows has no local text observer/)
  assert.equal(h.state.recognizeCalls.length, 0)

  // And it stays off rather than retrying into the endpoint every tick.
  for (let i = 0; i < 10; i++) assert.equal(await h.step(), 'unavailable')
  assert.equal(h.state.recognizeCalls.length, 0)
  assert.equal(h.state.captures.length, 1, 'it stops capturing too')
})

test('image mode is a deliberate choice, and it works where text mode cannot', async () => {
  const h = harness({ observerMode: 'image', minRequestSpacingMs: 0 })
  h.state.observerUnsupported = true
  h.state.hash = HASH_A
  h.state.recognized = () => ({ fullText: '画像から', textAnnotations: [] })

  await h.step()
  await h.step()
  assert.notEqual(h.scanner.state, 'unavailable', 'no text observer is not an error in this mode')
  assert.equal(h.scanner.stats().observerErrors, 0)
  assert.equal(h.state.recognizeCalls.length, 1)

  for (let i = 0; i < 6; i++) await h.step()
  assert.equal(h.state.recognizeCalls.length, 1, 'an unchanging picture costs one request')
})

test('nothing selects image mode on the user’s behalf', () => {
  assert.equal(DEFAULT_AUTO_OCR_SETTINGS.observerMode, 'text')
  assert.equal(migrateAutoScanSettings({ localOCRGateEnabled: false }).observerMode, 'text')
  assert.equal(migrateAutoScanSettings({ observerMode: 'nonsense' }).observerMode, 'text')
})

// --- contention with the manual path ---------------------------------------

test('a tick is skipped outright while the manual pipeline holds the lock', async () => {
  const h = harness()
  h.sees('台詞')
  await h.step()
  h.state.busy = true
  assert.equal(await h.step(), 'busy')
  assert.equal(h.state.captures.length, 1, 'a locked tick does not even capture')
  assert.equal(h.scanner.stats().lockedSkips, 1)

  h.state.busy = false
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 1)
})

test('a manual scan’s result stops the loop repeating the same request', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  // The user scans by hand; the overlay tells the loop what it published.
  h.scanner.noteExternalScan('手動で読んだ台詞')
  h.sees('手動で読んだ台詞')
  h.state.recognized = () => ({ fullText: '手動で読んだ台詞', textAnnotations: [] })

  for (let i = 0; i < 6; i++) await h.step()
  assert.equal(h.state.recognizeCalls.length, 0, 'the loop knew it was already done')

  h.sees('次の台詞')
  await h.step()
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 1, 'and still reacts to the next line')
})

test('a manual scan also moves the request clock, so the loop respects spacing', async () => {
  const h = harness({ minRequestSpacingMs: 5000 })
  h.scanner.noteExternalScan('手動')
  h.sees('別の台詞')
  await h.step(1000)
  await h.step(1000)
  assert.equal(h.state.recognizeCalls.length, 0, 'held by the spacing the manual scan started')
  await h.step(5000)
  assert.equal(h.state.recognizeCalls.length, 1)
})

test('only one tick runs at a time', async () => {
  const h = harness()
  h.sees('台詞')
  let release
  h.state.captureGate = new Promise((resolve) => (release = resolve))

  const running = h.scanner.tick()
  await Promise.resolve()
  assert.equal(await h.scanner.tick(), 'busy', 'a second tick does not interleave with the first')

  release()
  await running
  h.state.captureGate = null
  assert.equal(h.state.captures.length, 1)
})

test('an automatic request contends for the same lock a manual scan takes', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  h.sees('台詞')
  await h.step()

  // The user hits the scan shortcut just as the candidate settles.
  h.state.busy = true
  assert.equal(await h.step(), 'busy', 'the tick is skipped rather than racing it')
  assert.equal(h.state.recognizeCalls.length, 0)

  h.state.busy = false
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 1, 'and it runs once the lock is free')
})

test('the lock is released even when a recognition fails', async () => {
  const h = harness({ minRequestSpacingMs: 0, maxConsecutiveErrors: 99, errorBackoffMs: 0 })
  h.state.recognizeError = 'native: OCR HTTP 500'
  h.sees('台詞')
  await h.step()
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 1)
  assert.equal(h.lock.held, false, 'a failed request must not wedge the manual path shut')
})

// --- generations// --- generations -----------------------------------------------------------

test('a source change discards a settling candidate rather than recognising it', async () => {
  const h = harness()
  h.sees('前の窓の台詞')
  await h.step()
  h.state.generation = 2 // the user picked a different window
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 0, 'the old candidate went with the old source')
  assert.ok(h.scanner.stats().staleDiscarded >= 1)

  await h.step()
  assert.equal(h.state.recognizeCalls.length, 1, 'and the new source settles normally')
})

test('a result for a source the user has left is never published', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  let release
  const gate = new Promise((resolve) => (release = resolve))
  h.state.recognized = async (frame) => {
    await gate
    return { fullText: `cloud:${frame.observedText}`, textAnnotations: [] }
  }
  h.sees('古い窓の台詞')
  await h.step()
  const running = h.scanner.tick()
  await Promise.resolve()

  h.state.generation = 7 // the crop was recommitted while the request was out
  release()
  await running

  assert.equal(h.state.results.length, 0, 'the late result was dropped')
  assert.ok(h.scanner.stats().staleDiscarded >= 1)
})

test('a pending candidate from an old source is dropped, not recognised', async () => {
  const h = harness({ minRequestSpacingMs: 10000 })
  h.sees('古い台詞')
  await h.step(1000)
  await h.step(1000) // settles, deferred by spacing into the pending slot
  assert.equal(h.state.recognizeCalls.length, 1)

  h.sees('もっと古い台詞')
  await h.step(1000)
  await h.step(1000)
  h.state.generation = 3
  await h.step(20000)
  assert.ok(
    !h.state.results.some((r) => r.text.includes('もっと古い')),
    'nothing from the abandoned source reached the overlay'
  )
})

// --- lifecycle and resources -----------------------------------------------

test('stopping releases every pinned frame', async () => {
  const h = harness({ minRequestSpacingMs: 10000 })
  h.sees('台詞')
  await h.step()
  await h.step()
  h.sees('別の台詞')
  await h.step()
  await h.step() // one settled candidate parked in the pending slot

  h.scanner.stop()
  assert.equal(h.scanner.retainedFrames, 0)
  // Unpinning is a native round trip, so the queue has to drain before the
  // store can be asked what it still holds.
  await h.scanner.pinsSettled()
  assert.deepEqual(leaked(h.state), [], 'no frame stayed pinned in the native store')
})

test('a frame under recognition keeps its pin through a stop', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  let release
  const gate = new Promise((resolve) => (release = resolve))
  let inFlightFrame = null
  h.state.recognized = async (frame) => {
    inFlightFrame = frame.id
    await gate
    return { fullText: 'x', textAnnotations: [] }
  }
  h.sees('台詞')
  await h.stepAsync()
  await h.stepAsync()
  assert.ok(inFlightFrame !== null, 'a request is out')

  h.scanner.stop()
  await h.scanner.pinsSettled()
  assert.ok(
    !h.state.released.includes(inFlightFrame),
    'the image being recognised was not evicted out from under the request'
  )

  release()
  await h.scanner.idle()
  await h.scanner.pinsSettled()
  assert.ok(h.state.released.includes(inFlightFrame), 'and it is released once the request lands')
  assert.deepEqual(leaked(h.state), [])
})

test('a result that lands after the user switched automatic scanning off is discarded', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  let release
  const gate = new Promise((resolve) => (release = resolve))
  h.state.recognized = async () => {
    await gate
    return { fullText: '遅すぎた', textAnnotations: [] }
  }
  h.sees('台詞')
  await h.stepAsync()
  await h.stepAsync()

  h.scanner.stop()
  release()
  await h.scanner.idle()

  assert.equal(h.state.results.length, 0, 'nothing was drawn over what the user is now looking at')
  assert.ok(h.scanner.stats().staleDiscarded >= 1)
})

test('a candidate replaced by newer text releases the frame it was holding', async () => {
  const h = harness()
  h.sees('一つ目の台詞')
  await h.step()
  const firstFrame = h.state.frames
  h.sees('二つ目の台詞')
  await h.step()
  await h.scanner.pinsSettled()
  assert.ok(h.state.released.includes(firstFrame))
  assert.equal(h.scanner.retainedFrames, 1, 'exactly one candidate is held at a time')
})

test('a source change releases the frames it made meaningless', async () => {
  const h = harness()
  h.sees('台詞')
  await h.step()
  const held = h.state.frames
  h.state.generation = 2
  await h.step()
  await h.scanner.pinsSettled()
  assert.ok(h.state.released.includes(held))
})

test('restarting forgets what was seen, so the same screen is scanned again', async () => {
  const h = harness()
  h.sees('同じ画面')
  await h.step()
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 1)

  h.scanner.stop()
  h.scanner.reset()
  h.scanner.start()
  assert.equal(h.scanner.state, 'running')

  await h.step()
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 2)
  h.scanner.stop() // and do not leave a timer running behind the test
  assert.equal(h.scanner.state, 'idle')
})

test('resuming clears a suspension so the user is not stuck', async () => {
  const h = harness({ maxConsecutiveErrors: 2 })
  h.sees('台詞')
  h.state.observerError = 'boom'
  await h.step(60000)
  await h.step(60000)
  assert.equal(h.scanner.state, 'suspended')

  h.state.observerError = null
  h.scanner.resume()
  assert.notEqual(h.scanner.state, 'suspended')
  await h.step(60000)
  await h.step(60000)
  assert.equal(h.state.recognizeCalls.length, 1)
})

test('pausing stops the work without losing what has been seen', async () => {
  const h = harness()
  h.sees('台詞')
  await h.step()
  h.scanner.pause()
  assert.equal(await h.step(), 'paused')
  assert.equal(h.state.captures.length, 1, 'a paused scanner does not even capture')

  h.scanner.resume()
  await h.step()
  assert.equal(h.state.recognizeCalls.length, 1)
})

// --- cadence ---------------------------------------------------------------

test('the cadence tightens on new text and backs off on a frozen screen', async () => {
  const { pollInterval, adaptivePollMin, adaptivePollMax } = DEFAULT_AUTO_OCR_SETTINGS
  const h = harness()
  assert.equal(h.scanner.currentInterval, pollInterval, 'starts at the base interval')

  h.sees('動いている')
  await h.step()
  assert.equal(h.scanner.currentInterval, adaptivePollMin, 'new text drops it to the floor')

  for (let i = 0; i < 30; i++) await h.step()
  assert.equal(
    h.scanner.currentInterval,
    adaptivePollMax,
    'a still screen backs off to the ceiling'
  )

  h.sees('新しい台詞')
  await h.step()
  assert.equal(h.scanner.currentInterval, adaptivePollMin, 'and comes straight back')
})

test('the ceiling is close enough that a still screen is still watched', async () => {
  // The number the reader feels: how long a new line can sit unnoticed. At the
  // old five-second ceiling a line waited up to 6.1s to reach them.
  assert.ok(
    DEFAULT_AUTO_OCR_SETTINGS.adaptivePollMax <= 500,
    'a quiet screen is still observed at least twice a second'
  )
  assert.ok(DEFAULT_AUTO_OCR_SETTINGS.adaptivePollMin <= 250)
})

test('punctuation jitter no longer holds the loop at the floor', async () => {
  const h = harness()
  for (let i = 0; i < 10; i++) {
    h.sees(i % 2 ? 'ねえ' : 'ねえ。')
    await h.step()
  }
  assert.ok(
    h.scanner.currentInterval > DEFAULT_AUTO_OCR_SETTINGS.adaptivePollMin,
    'the old build sat at 500ms forever here'
  )
})

test('the base interval is used verbatim when adaptive polling is off', async () => {
  const h = harness({ adaptivePollingEnabled: false, pollInterval: 3000 })
  h.sees('台詞')
  await h.step()
  assert.equal(h.scanner.currentInterval, 3000)
  await h.step()
  assert.equal(h.scanner.currentInterval, 3000)
})

// --- settings migration ----------------------------------------------------

test('an old settings file gets the observer without the user finding a switch', () => {
  const stored = {
    pollInterval: 2000,
    imageHashThreshold: 5,
    localOCRSimilarityThreshold: 0.85,
    localOCRGateEnabled: false,
    adaptivePollingEnabled: true,
    adaptivePollMin: 500,
    adaptivePollMax: 5000
  }
  const migrated = migrateAutoScanSettings(stored)
  assert.equal(migrated.observerMode, 'text', 'automatic mode actually uses the new observer')
  assert.equal(migrated.localOCRGateEnabled, false, 'and their local-OCR preference is preserved')
  assert.equal(migrated.stableObservations, 2)
  assert.equal(migrated.minRequestSpacingMs, 1200)
})

test('a stored cadence nobody chose is brought forward with the defaults', () => {
  // Every existing install holds 2000/500/5000 because that is what shipped, not
  // because anyone picked it. Leaving them there would leave them waiting
  // seconds for each line on a loop that no longer needs to be slow.
  const migrated = migrateAutoScanSettings({
    pollInterval: 2000,
    adaptivePollMin: 500,
    adaptivePollMax: 5000
  })
  assert.equal(migrated.pollInterval, DEFAULT_AUTO_OCR_SETTINGS.pollInterval)
  assert.equal(migrated.adaptivePollMin, DEFAULT_AUTO_OCR_SETTINGS.adaptivePollMin)
  assert.equal(migrated.adaptivePollMax, DEFAULT_AUTO_OCR_SETTINGS.adaptivePollMax)
  assert.equal(migrated.version, 2, 'and it is marked, so it happens exactly once')
})

test('a cadence somebody did choose is left alone', () => {
  const chosen = migrateAutoScanSettings({
    pollInterval: 3000,
    adaptivePollMin: 500,
    adaptivePollMax: 1500
  })
  assert.equal(chosen.pollInterval, 3000, 'a deliberate value survives')
  assert.equal(chosen.adaptivePollMax, 1500, 'and so does this one')
  // Only the field that still held the old default moves.
  assert.equal(chosen.adaptivePollMin, DEFAULT_AUTO_OCR_SETTINGS.adaptivePollMin)
})

test('a settings file already on this version is not re-migrated', () => {
  const tuned = migrateAutoScanSettings({
    version: 2,
    pollInterval: 2000,
    adaptivePollMin: 500,
    adaptivePollMax: 5000
  })
  assert.equal(tuned.pollInterval, 2000, 'these are now deliberate values')
  assert.equal(tuned.adaptivePollMax, 5000)
})

test('nonsense in a settings file cannot produce an unbounded scanner', () => {
  const migrated = migrateAutoScanSettings({
    stableObservations: 0,
    minRequestSpacingMs: -5000,
    maxCandidateAgeMs: 1,
    pollInterval: 2000
  })
  assert.equal(migrated.stableObservations, 2, 'one observation is never "settled"')
  assert.equal(migrated.minRequestSpacingMs, 0)
  assert.equal(migrated.maxCandidateAgeMs, migrated.pollInterval, 'never shorter than one poll')
  assert.deepEqual(migrateAutoScanSettings(null), DEFAULT_AUTO_OCR_SETTINGS)
})

// --- diagnostics -----------------------------------------------------------

test('the diagnostics carry counts and reasons, never recognised text', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  h.sees('秘密の台詞です')
  await h.step()
  await h.step()

  const serialised = JSON.stringify(h.state.events)
  assert.ok(!serialised.includes('秘密'), 'no recognised text reached the log')
  assert.ok(!serialised.includes('cloud:'), 'nor did any recognition result')
  assert.ok(h.state.events.some((e) => e.type === 'observation' && e.chars > 0))
  assert.ok(h.state.events.some((e) => e.type === 'result' && e.published === true))

  const stats = h.scanner.stats()
  assert.equal(stats.requests, 1)
  assert.equal(stats.published, 1)
  assert.equal(stats.observations, 2)
  assert.equal(stats.captures, 2)
})

// --- native frame pins ------------------------------------------------------

test('a release can never overtake the retain it belongs to', async () => {
  // Both are native round trips. Unordered, a release could unpin nothing and
  // leave the frame pinned for the rest of the session, or arrive first and
  // unpin a frame that had not been pinned yet.
  const h = harness({ minRequestSpacingMs: 0 })
  h.sees('一つ目')
  await h.step()
  h.sees('二つ目')
  await h.step()
  h.sees('三つ目')
  await h.step()
  await h.scanner.pinsSettled()

  const seen = new Map()
  for (const entry of h.state.pinLog) {
    const [operation, id] = entry.split(':')
    if (operation === 'retain') seen.set(id, true)
    else assert.ok(seen.get(id), `release:${id} arrived before its retain`)
  }
  assert.ok(h.state.pinLog.length > 0, 'pins were actually applied')
})

test('a tick does not finish until the pins it queued have landed', async () => {
  // The next capture is what evicts a candidate natively, so a retain that is
  // still in flight when the loop comes round again protects nothing.
  const h = harness()
  let resolveRetain
  h.state.retainGate = new Promise((resolve) => (resolveRetain = resolve))
  h.sees('台詞')

  let finished = false
  const tick = h.scanner.tick().then(() => (finished = true))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(finished, false, 'the tick is still waiting for its pin')

  resolveRetain()
  await tick
  assert.equal(finished, true)
  assert.deepEqual(h.state.retained, [1], 'and the pin really was applied')
})

test('a refused pin is counted and reported rather than swallowed', async () => {
  const h = harness()
  h.state.retainError = 'gone: that frame has been replaced'
  h.sees('台詞')
  await h.step()
  await h.scanner.pinsSettled()

  assert.equal(h.scanner.stats().pinFailures, 1)
  const reported = h.state.events.filter((e) => e.type === 'error' && e.stage === 'pin-retain')
  assert.equal(reported.length, 1)
  assert.match(reported[0].message, /gone/)
})

test('a frame whose retain was refused is never released as if it were pinned', async () => {
  // The bookkeeping has to match what the native store actually holds, or a
  // later release is sent for a frame that was never pinned.
  const h = harness()
  h.state.retainError = 'gone: that frame has been replaced'
  h.sees('一つ目')
  await h.step()
  h.sees('二つ目') // replaces the candidate, releasing the first
  await h.step()
  await h.scanner.pinsSettled()

  assert.deepEqual(h.state.released, [], 'nothing was unpinned that was never pinned')
  assert.ok(h.scanner.stats().pinFailures >= 1)
})

test('a refused release is reported and does not wedge the pin queue', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  h.state.releaseError = 'busy: the image store is poisoned'
  h.sees('一つ目')
  await h.step()
  h.sees('二つ目')
  await h.step()
  await h.scanner.pinsSettled()

  assert.ok(h.scanner.stats().pinFailures >= 1)
  assert.ok(
    h.state.events.some((e) => e.type === 'error' && e.stage === 'pin-release'),
    'the failure was reported'
  )
  // And the queue kept working afterwards.
  h.sees('三つ目')
  await h.step()
  await h.scanner.pinsSettled()
  assert.ok(h.state.retained.length >= 3)
})

test('pins still balance when the native side is slow', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  let releaseGate
  h.state.retainGate = new Promise((resolve) => (releaseGate = resolve))
  h.sees('台詞')
  const first = h.scanner.tick()
  h.sees('別の台詞')
  releaseGate()
  await first
  await h.step()
  await h.step()
  h.scanner.stop()
  await h.scanner.pinsSettled()
  assert.deepEqual(leaked(h.state), [], 'every pin was matched by a release')
})

// --- a frame is never recognised unless it is actually pinned ---------------

/** Let queued microtasks run without advancing the fake clock. */
const flush = async (turns = 12) => {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}

test('a settled candidate waits for its pin before it is recognised', async () => {
  // `retain` is a native round trip. Sending the frame before it lands means
  // sending whatever the store evicted it for.
  const h = harness({ minRequestSpacingMs: 0 })
  let resolveRetain
  h.state.retainGate = new Promise((resolve) => (resolveRetain = resolve))
  h.state.retainGateFor = 2 // the frame the candidate settles on

  h.sees('台詞')
  await h.step() // frame 1 pins normally
  const settling = h.scanner.tick() // frame 2: settles, submits, waits for its pin
  await flush()

  assert.equal(h.state.recognizeCalls.length, 0, 'not sent while the pin is in flight')

  resolveRetain()
  await settling
  await h.scanner.idle()
  assert.equal(h.state.recognizeCalls.length, 1, 'and sent once the pin lands')
  assert.deepEqual(h.published(), ['cloud:台詞'])
})

test('a candidate whose pin was refused is never recognised at all', async () => {
  const h = harness({ minRequestSpacingMs: 0, maxConsecutiveErrors: 99 })
  h.state.retainError = 'gone: that frame has been replaced'
  h.state.retainErrorFor = 2

  h.sees('台詞')
  await h.step()
  await h.step()
  await h.scanner.idle()
  await h.scanner.pinsSettled()

  assert.equal(h.state.recognizeCalls.length, 0, 'an unpinned frame is never sent')
  assert.equal(h.state.results.length, 0)
  assert.equal(h.scanner.stats().unpinnedDiscards, 1)
  assert.equal(h.scanner.stats().requests, 0, 'and it is not counted as a request')
  assert.ok(
    h.state.events.some((e) => e.type === 'error' && e.stage === 'pin'),
    'the discard is reported'
  )
})

test('a refused pin backs the loop off rather than retrying every tick', async () => {
  const h = harness({ minRequestSpacingMs: 0, errorBackoffMs: 4000, maxConsecutiveErrors: 99 })
  h.state.retainError = 'gone: that frame has been replaced'
  h.sees('台詞')
  for (let i = 0; i < 8; i++) await h.step(500)
  await h.scanner.idle()

  assert.equal(h.state.recognizeCalls.length, 0)
  assert.ok(h.scanner.stats().backoffSkips > 0, 'it waited instead of hammering')
})

test('a release queued before a retain fails does not unpin what was never pinned', async () => {
  // The ordering the second review found: stop() while a retain is in flight
  // used to commit a release, and the retain then failed behind it.
  const h = harness()
  let resolveRetain
  h.state.retainGate = new Promise((resolve) => (resolveRetain = resolve))
  h.state.retainError = 'gone: that frame has been replaced'

  h.sees('台詞')
  const running = h.scanner.tick()
  await flush()
  h.scanner.stop() // queues the release behind the still-pending retain

  resolveRetain()
  await running.catch(() => {})
  await h.scanner.pinsSettled()

  assert.deepEqual(h.state.released, [], 'nothing was unpinned that was never pinned')
  assert.ok(h.scanner.stats().pinFailures >= 1, 'and the refusal was still counted')
})

// --- the request owns the lock until its result has been applied ------------

test('the shared lock is held until the result has been applied', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  let releaseResult
  h.sees('台詞')
  await h.step()

  // A deliberately slow result application, standing in for the overlay drawing
  // and publishing what it was given.
  h.state.slowResult = new Promise((resolve) => (releaseResult = resolve))
  const settling = h.scanner.tick()
  await flush()

  assert.equal(h.state.recognizeCalls.length, 1, 'the endpoint has answered')
  assert.equal(h.state.results.length, 0, 'but the result is still being applied')
  assert.equal(h.lock.held, true, 'and the shared lock is still held')
  assert.equal(h.tryManual(), false, 'so a manual scan cannot publish alongside it')

  releaseResult()
  await settling
  await h.scanner.idle()
  assert.equal(h.state.results.length, 1)
  assert.equal(h.lock.held, false, 'the lock is given back once the result has landed')
  assert.equal(h.tryManual(), true)
  h.releaseManual()
})

test('a second recognition cannot start while the first is still publishing', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  let releaseResult
  h.state.slowResult = new Promise((resolve) => (releaseResult = resolve))

  h.sees('一つ目')
  await h.step()
  const first = h.scanner.tick() // settles, recognises, then blocks in onResult
  await flush()
  assert.equal(h.state.recognizeCalls.length, 1)

  h.sees('二つ目')
  await h.stepAsync()
  await h.stepAsync()
  await flush()
  assert.equal(
    h.state.recognizeCalls.length,
    1,
    'the next line waits rather than overlapping the one being published'
  )

  releaseResult()
  await first
  await h.scanner.idle()
  await h.step()
  await h.scanner.idle()
  assert.equal(h.state.recognizeCalls.length, 2, 'and runs once the first has finished')
})

test('a finishing run does not clear a newer run\u2019s in-flight slot', async () => {
  // `idle()` reporting quiet while a request is out would let a caller shut down
  // underneath one.
  const h = harness({ minRequestSpacingMs: 0 })
  h.sees('一つ目')
  await h.step()
  await h.step()
  await h.scanner.idle()

  let releaseSecond
  h.state.slowResult = new Promise((resolve) => (releaseSecond = resolve))
  h.sees('二つ目')
  await h.stepAsync()
  const second = h.scanner.tick()
  await flush()

  let idled = false
  const waiting = h.scanner.idle().then(() => (idled = true))
  await flush()
  assert.equal(idled, false, 'idle() waits for the run that is actually out')

  releaseSecond()
  await second
  await waiting
  assert.equal(idled, true)
})

// --- nothing obsolete is uploaded after waiting for a pin -------------------

test('a stop while the pin is in flight cancels the request outright', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  let resolveRetain
  h.state.retainGate = new Promise((resolve) => (resolveRetain = resolve))
  h.state.retainGateFor = 2

  h.sees('台詞')
  await h.step()
  const settling = h.scanner.tick() // settles, then waits on the pin
  await flush()
  assert.equal(h.state.recognizeCalls.length, 0)

  h.scanner.stop() // the user switched automatic scanning off
  resolveRetain()
  await settling
  await h.scanner.idle()

  assert.equal(h.state.recognizeCalls.length, 0, 'the frame was never uploaded')
  assert.equal(h.state.results.length, 0)
  assert.ok(h.scanner.stats().staleDiscarded >= 1)
})

test('a reset while the pin is in flight cancels the request outright', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  let resolveRetain
  h.state.retainGate = new Promise((resolve) => (resolveRetain = resolve))
  h.state.retainGateFor = 2

  h.sees('台詞')
  await h.step()
  const settling = h.scanner.tick()
  await flush()

  h.scanner.reset()
  resolveRetain()
  await settling
  await h.scanner.idle()

  assert.equal(h.state.recognizeCalls.length, 0, 'the frame was never uploaded')
})

test('a source change while the pin is in flight cancels the request outright', async () => {
  // The window the second review found: the selection can move while a retain is
  // still queued, and the frame waiting on it belongs to the old source.
  const h = harness({ minRequestSpacingMs: 0 })
  let resolveRetain
  h.state.retainGate = new Promise((resolve) => (resolveRetain = resolve))
  h.state.retainGateFor = 2

  h.sees('古い窓の台詞')
  await h.step()
  const settling = h.scanner.tick()
  await flush()

  h.state.generation = 9 // the user picked a different window
  resolveRetain()
  await settling
  await h.scanner.idle()

  assert.equal(h.state.recognizeCalls.length, 0, 'no upload of a frame from the old source')
  assert.equal(h.state.results.length, 0)
  assert.ok(h.scanner.stats().staleDiscarded >= 1)
})

test('pins and the lock are balanced when a pinned job is discarded', async () => {
  const h = harness({ minRequestSpacingMs: 0 })
  let resolveRetain
  h.state.retainGate = new Promise((resolve) => (resolveRetain = resolve))
  h.state.retainGateFor = 2

  h.sees('台詞')
  await h.step()
  const settling = h.scanner.tick()
  await flush()
  h.state.generation = 4
  resolveRetain()
  await settling
  await h.scanner.idle()
  h.scanner.stop()
  await h.scanner.pinsSettled()

  assert.equal(h.lock.held, false, 'the shared lock was given back')
  assert.deepEqual(leaked(h.state), [], 'and every pin was matched by a release')
})

test('a refused pin lets the same line be recognised once pinning recovers', async () => {
  // Backing off is not enough on its own: the candidate is marked as sent, so
  // without clearing that the line would never be retried at all.
  const h = harness({ minRequestSpacingMs: 0, errorBackoffMs: 1000, maxConsecutiveErrors: 99 })
  h.state.retainError = 'gone: that frame has been replaced'
  h.state.retainErrorFor = 2

  h.sees('もう一度読んで')
  await h.step()
  await h.step() // settles, pin refused, nothing sent
  await h.scanner.idle()
  assert.equal(h.state.recognizeCalls.length, 0)
  assert.equal(h.scanner.stats().unpinnedDiscards, 1)

  // Pinning works again from here; the same text must still get through.
  await h.step(5000)
  await h.step(5000)
  await h.scanner.idle()

  assert.equal(h.state.recognizeCalls.length, 1, 'the same line was retried')
  assert.deepEqual(h.published(), ['cloud:もう一度読んで'], 'and published')
})

test('diagnostic callbacks cannot change decisions and correlate actual requests with their frame', async () => {
  const diagnostics = []
  const h = harness(
    {},
    {
      onDiagnostic(event, frame, counters) {
        diagnostics.push({ event, frame, requests: counters.requests })
        throw Error('diagnostic consumer failed')
      }
    }
  )
  h.state.text = '猫が好きです'
  await h.step()
  await h.step()
  await h.scanner.idle()
  assert.equal(h.state.recognizeCalls.length, 1)
  const request = diagnostics.find((d) => d.event.type === 'request' && !d.event.queued)
  assert.ok(request.frame)
  assert.equal(request.requests, 1)
})

test('a slow accurate result keeps unchanged dialogue when a HUD line changes, and clears on blank', async () => {
  const dialogue = line('猫が好きです', 0, 0, 100, 20)
  const hud = (text) => line(text, 0, 50, 100, 20)
  const annotation = (description, y, height = 10) => ({
    description,
    boundingPoly: {
      vertices: [
        { x: 0, y },
        { x: 100, y },
        { x: 100, y: y + height },
        { x: 0, y: y + height }
      ]
    }
  })
  let finish
  const gate = new Promise((resolve) => {
    finish = resolve
  })
  const h = harness({}, { recognize: () => gate })
  h.sees('猫が好きですHP12', [dialogue, hud('HP12')])
  await h.stepAsync()
  await h.stepAsync()
  h.sees('猫が好きですHP11', [dialogue, hud('HP11')])
  await h.stepAsync()
  finish({
    fullText: '猫が好きです HP12',
    geometry: true,
    textAnnotations: [
      annotation('whole page', 0, 100),
      annotation('猫が好きです', 0),
      annotation('HP12', 50)
    ]
  })
  await h.scanner.idle()
  assert.equal(h.state.results.length, 1)
  assert.equal(h.state.results[0].text, '猫が好きです')
  assert.equal(
    h.state.results[0].publish,
    false,
    'a partial page must not become a history fragment'
  )
  assert.ok(h.state.events.some((e) => e.type === 'result' && e.reason === 'partial-current-lines'))
  h.sees('猫が好きですHP10', [dialogue, hud('HP10')])
  await h.stepAsync()
  const invalidation = h.state.events.filter((e) => e.type === 'visual-invalidated').at(-1)
  assert.equal(invalidation, undefined, 'unchanged dialogue needs no redraw for another HUD change')
  h.sees('', [])
  await h.stepAsync()
  assert.equal(h.state.events.filter((e) => e.type === 'visual-invalidated').at(-1).reason, 'empty')
  h.scanner.stop()
})

test('a manual overlay-enable result carries local line evidence into the next HUD update', async () => {
  const dialogue = line('猫が好きです')
  const h = harness()
  h.scanner.noteExternalScan('猫が好きです HP12', [dialogue, line('HP12', 40, 500)])
  h.sees('猫が好きですHP11', [dialogue, line('HP11', 40, 500)])
  await h.step()
  assert.equal(
    h.state.events.some((e) => e.type === 'visual-invalidated'),
    false
  )
  await h.step()
  assert.deepEqual(h.state.events.find((e) => e.type === 'visual-invalidated').keepBoxes, [
    dialogue.box
  ])
  h.scanner.stop()
})

test('late geometric OCR cannot restore a line whose single character changed', async () => {
  let finish
  const gate = new Promise((resolve) => {
    finish = resolve
  })
  const h = harness({}, { recognize: () => gate })
  h.sees('猫が好きです', [line('猫が好きです', 0, 0, 100, 20)])
  await h.stepAsync()
  await h.stepAsync()
  h.sees('犬が好きです', [line('犬が好きです', 0, 0, 100, 20)])
  await h.stepAsync()
  finish({
    fullText: '猫が好きです',
    geometry: true,
    textAnnotations: [
      {
        description: '猫が好きです',
        boundingPoly: {
          vertices: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 20 },
            { x: 0, y: 20 }
          ]
        }
      }
    ]
  })
  await h.scanner.idle()
  assert.equal(h.state.results.length, 0)
  assert.equal(h.skips('superseded'), 1)
  h.scanner.stop()
})

test('a one-observation line misread does not flicker, but a repeated changed line is removed', async () => {
  const dialogue = line('猫が好きです', 0, 0, 100, 20)
  const hud = line('HP12', 0, 50, 100, 20)
  const changed = line('犬が好きです', 0, 0, 100, 20)
  const h = harness()
  h.scanner.noteExternalScan('猫が好きですHP12', [dialogue, hud])
  h.sees('犬が好きですHP12', [changed, hud])
  await h.step(50)
  assert.equal(
    h.state.events.some((e) => e.type === 'visual-invalidated'),
    false
  )
  h.sees('猫が好きですHP12', [dialogue, hud])
  await h.step(50)
  assert.equal(
    h.state.events.some((e) => e.type === 'visual-invalidated'),
    false
  )
  h.sees('犬が好きですHP12', [changed, hud])
  await h.step(50)
  await h.step(50)
  const removed = h.state.events.filter((e) => e.type === 'visual-invalidated').at(-1)
  assert.deepEqual(removed.keepBoxes, [hud.box])
  h.sees('', [])
  await h.step(50)
  assert.equal(h.state.events.filter((e) => e.type === 'visual-invalidated').at(-1).reason, 'empty')
  h.scanner.stop()
})

test('a new menu item settles independently of continuously changing background readings', async () => {
  const h = harness()
  const menu = line('たたかう', 0, 0, 100, 20)
  h.sees('たたかう背景甲', [menu, line('背景甲', 0, 100)])
  await h.step(500)
  assert.equal(h.state.recognizeCalls.length, 0)
  h.sees('たたかう背景乙', [menu, line('背景乙', 0, 100)])
  await h.step(500)
  assert.equal(
    h.state.recognizeCalls.length,
    1,
    'the second menu observation is enough; the whole page never settled'
  )
  assert.ok(
    h.state.events.some((e) => e.type === 'request' && !e.queued && e.reason === 'stable-line')
  )
  for (const text of ['背景丙', '背景丁', '背景戊', '背景己']) {
    h.sees(`たたかう${text}`, [menu, line(text, 0, 100)])
    await h.step(500)
  }
  assert.equal(
    h.state.recognizeCalls.length,
    1,
    'unchanged covered menu does not cause a request on each background change'
  )
  h.scanner.stop()
})

test('a hover pause during capture prevents observation and visual invalidation until a fresh capture', async()=>{
 let release
 const {scanner,state}=harness({}, {captureFrame:()=>new Promise(resolve=>{release=()=>resolve({frame:1,generation:state.generation,observation:{text:'新しい文章',lines:[line('新しい文章')]}})})})
 const pending=scanner.tick()
 scanner.pause();release()
 assert.equal(await pending,'paused')
 assert.equal(scanner.stats().observations,0)
 assert.equal(state.events.some(e=>e.type==='visual-invalidated'),false)
 scanner.resume()
 const fresh=scanner.tick();release();await fresh
 assert.equal(scanner.stats().observations,1)
})
