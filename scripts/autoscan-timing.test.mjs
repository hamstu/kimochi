/**
 * Timed replay of the real scanner, at its real scheduling seam.
 *
 * The other suites call `tick()` by hand, which answers "is the decision right"
 * but says nothing about *when* anything happens — and the three faults the user
 * reported are all about when. This one starts the scanner for real, so the
 * `setTimeout` in `schedule()` is what advances it, and `adapt()`'s interval, the
 * settle count, the minimum request spacing and the cost of each call all compose
 * in scheduled time exactly as they do in the app.
 *
 * Deterministic because time is virtual: `setTimeout` is replaced by a clock the
 * test advances, and the same clock is injected as the scanner's `now` and used
 * to spend the modelled cost of capturing, observing and recognising. Nothing
 * here touches a screen, a service or a real timer, so a sixty-second scenario
 * runs in a millisecond and runs the same way every time.
 *
 * The costs are measured, on an actual game window, and are stated in
 * `scripts/fixtures/auto-ocr-timing/scenarios.json`. They matter more than they look:
 * a capture that costs 400ms is most of a poll interval, so the cadence a reader
 * experiences is the interval *plus* the work, not the interval.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { load } from './load.mjs'

const { AutoScanner, DEFAULT_AUTO_OCR_SETTINGS } = await load('autoscan.ts')
const { stabilityKey } = await load('observation.ts')

const FIXTURES = new URL('./fixtures/auto-ocr-timing/', import.meta.url)
const scenarios = JSON.parse(readFileSync(new URL('scenarios.json', FIXTURES), 'utf8'))
// Measured results are written to the gitignored evidence/ folder, not beside the fixture.
const RESULTS = new URL('../evidence/auto-ocr-timing/', import.meta.url)
mkdirSync(RESULTS, { recursive: true })

const realSetImmediate = setImmediate

/**
 * Virtual time.
 *
 * Owns `now`, owns the timer queue the scanner schedules into, and is the only
 * thing that makes time pass. `advance` fires due timers in order and lets every
 * pending microtask run between them, so an async tick reaches its next awaited
 * timer before the clock moves again.
 */
class Clock {
  constructor() {
    this.now = 0
    this.timers = new Map()
    this.seq = 0
  }

  setTimeout(fn, delay) {
    const id = ++this.seq
    this.timers.set(id, { id, at: this.now + Math.max(0, delay || 0), fn })
    return id
  }

  clearTimeout(id) {
    this.timers.delete(id)
  }

  /** Spend virtual time inside an awaited call, as a real round trip would. */
  sleep(ms) {
    return new Promise((resolve) => this.setTimeout(resolve, ms))
  }

  async flush(turns = 6) {
    for (let i = 0; i < turns; i++) await new Promise((resolve) => realSetImmediate(resolve))
  }

  nextDue(limit) {
    let best = null
    for (const timer of this.timers.values()) {
      if (timer.at > limit) continue
      if (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id)) best = timer
    }
    return best
  }

  async advance(ms) {
    const target = this.now + ms
    for (;;) {
      await this.flush()
      const due = this.nextDue(target)
      if (!due) break
      this.timers.delete(due.id)
      this.now = due.at
      due.fn()
      await this.flush()
    }
    this.now = target
    await this.flush()
  }
}

/** What the screen shows at a given moment. */
function screenAt(screen, at) {
  let text = ''
  for (const frame of screen) if (frame.at <= at) text = frame.text
  return text
}

/**
 * Replay one scenario against a real, started scanner.
 *
 * Returns a log of everything that happened and when, plus a model of what the
 * overlay would be showing — which is updated only where `overlay.js` updates it,
 * so "are stale boxes still on screen" is a question this can answer.
 */
const replay = (scenario, settings = {}, pipeline = 'new', fingerprints = true) =>
  replayInstrumented(scenario, settings, null, pipeline, fingerprints)

async function replayInstrumented(
  scenario,
  settings = {},
  onStarted = null,
  pipeline = 'new',
  fingerprints = true
) {
  const clock = new Clock()
  const costs = scenario.costs ?? scenarios.costs[pipeline]
  const log = []
  const record = (type, detail = {}) => log.push({ at: clock.now, type, ...detail })

  /** What `overlay.js` would currently be drawing. */
  const overlay = { annotations: [], showing: '', clears: 0 }

  let observations = 0
  let frames = 0
  let lastShown = null
  const state = { generation: 1 }

  const realTimeout = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = (fn, delay) => clock.setTimeout(fn, delay)
  globalThis.clearTimeout = (id) => clock.clearTimeout(id)

  const scanner = new AutoScanner(
    {
      now: () => clock.now,
      generation: () => state.generation,
      isBusy: () => false,
      tryAcquire: () => true,
      releaseLock: () => {},
      captureFrame: async () => {
        // The native round trip: capture, digest and locally observe, all before
        // this resolves. The tick genuinely spans it, and an unchanged image
        // costs less because native serves the cached reading.
        const shown = screenAt(scenario.screen, clock.now)
        const unchanged = shown === lastShown
        lastShown = shown
        await clock.sleep(unchanged ? costs.observeUnchangedMs : costs.observeChangedMs)
        observations++
        let read = shown
        const noise = scenario.noise
        if (noise && shown !== '') {
          const phase = observations % noise.everyNth
          if (phase !== 0 && phase <= noise.forObservations) read = noise.as
        }
        record('observed', { read, shown, chars: read.length })
        return {
          frame: { id: ++frames, read },
          generation: state.generation,
          hash: `h${read.length}`,
          // The exact pixel digest. Describes what is displayed, never the
          // observer's reading of it — which is the whole reason it can tell
          // read noise from a changed screen.
          contentFingerprint: fingerprints ? `fp:${shown}` : null,
          observation: { text: read, lines: read ? [{ text: read, box: { x: 0, y: 0, width: 100, height: 20 } }] : [] }
        }
      },
      recognize: async (frame) => {
        record('recognize:start', { read: frame.read })
        await clock.sleep(costs.recognizeMs)
        record('recognize:end', { read: frame.read })
        // The accurate recogniser sees the real screen content of the frame it
        // was given, not the observer's noisy reading of it.
        return { fullText: frame.read, textAnnotations: [{ description: frame.read }] }
      },
      retainFrame: () => {},
      releaseFrame: () => {},
      onResult: (result, frame, info) => {
        // Mirrors overlay.js applyResult: annotations are replaced on every
        // result, published or not.
        overlay.annotations = result.textAnnotations
        overlay.showing = result.fullText
        record('applied', { text: result.fullText, publish: info.publish, reason: info.reason })
      },
      onEvent: (event) => {
        if (event.type === 'request' && !event.queued) record('request', { reason: event.reason })
        if (event.type === 'error') record('error', { stage: event.stage })
        // The contract the overlay needs in order to clear. Absent today.
        if (event.type === 'visual-invalidated') {
          overlay.annotations = []
          overlay.showing = ''
          overlay.clears++
          record('visual-invalidated', { reason: event.reason })
        }
      }
    },
    { ...DEFAULT_AUTO_OCR_SETTINGS, ...(scenario.settings ?? {}), ...settings }
  )

  try {
    scanner.start()
    onStarted?.(scanner, clock)
    await clock.advance(scenario.runForMs)
    scanner.stop()
    await clock.advance(2000)
    await scanner.idle()
  } finally {
    globalThis.setTimeout = realTimeout
    globalThis.clearTimeout = realClear
  }

  return { log, overlay, scanner, clock, observations, stats: scanner.stats() }
}

/**
 * Replay, with a hook run as virtual time passes.
 *
 * Lets a test drive something that happens *to* the scanner while it runs — a
 * reader hovering a word, say — at the same cadence the real caller would.
 */
async function replayWithHook(scenario, hook, settings = {}) {
  const inner = { current: null }
  const wrapped = { ...scenario }
  const result = await replayInstrumented(wrapped, settings, (scanner, clock) => {
    inner.current = scanner
    const step = () => {
      if (clock.now <= scenario.runForMs) {
        hook(scanner, clock.now)
        clock.setTimeout(step, 200)
      }
    }
    clock.setTimeout(step, 0)
  })
  return result
}

// --- metrics ---------------------------------------------------------------

const requests = (log) => log.filter((e) => e.type === 'request').length
const applies = (log) => log.filter((e) => e.type === 'applied')

/** When did the text that appeared at `at` first reach the overlay? */
function latencyFor(log, appearedAt, text) {
  const key = stabilityKey(text)
  const hit = log.find((e) => e.type === 'applied' && stabilityKey(e.text) === key && e.at >= appearedAt)
  return hit ? hit.at - appearedAt : null
}

/** Longest stretch with no observation at all — how blind the loop goes. */
function largestObservationGap(log) {
  const times = log.filter((e) => e.type === 'observed').map((e) => e.at)
  let worst = 0
  for (let i = 1; i < times.length; i++) worst = Math.max(worst, times[i] - times[i - 1])
  return worst
}

const byId = (id) => scenarios.scenarios.find((s) => s.id === id)
const measured = {}

function remember(id, values) {
  measured[id] = values
  return values
}

// --- the three reported faults ---------------------------------------------

test('control: a still screen with a clean observer costs one request', async () => {
  const { log, stats, observations } = await replay(byId('control-static'))
  const count = requests(log)
  remember('control-static', { requests: count, observations, published: stats.published })

  assert.equal(count, 1, 'the harness does not manufacture requests on its own')
  assert.equal(stats.published, 1)
})

/**
 * How long a new line waits, across every phase of the polling interval.
 *
 * A single run measures one alignment, and alignment is luck: a line that appears
 * just before a scheduled observation is seen at once, and the same line a moment
 * later waits most of an interval. Sweeping the appearance time across a whole
 * interval is the only honest way to state this, and the tail is what the reader
 * actually complains about.
 */
async function latencySweep(baseScenario, appearsAt, step, samples, settings = {}, pipeline = 'new') {
  const results = []
  for (let i = 0; i < samples; i++) {
    const offset = i * step
    const scenario = {
      ...baseScenario,
      runForMs: baseScenario.runForMs + offset,
      screen: baseScenario.screen.map((frame) =>
        frame.at === appearsAt ? { ...frame, at: appearsAt + offset } : frame
      )
    }
    const { log } = await replay(scenario, settings, pipeline)
    const latency = latencyFor(log, appearsAt + offset, baseScenario.measureLatencyFor.text)
    results.push(latency)
  }
  const seen = results.filter((value) => value !== null)
  return {
    samples: results.length,
    missed: results.length - seen.length,
    bestMs: Math.min(...seen),
    meanMs: Math.round(seen.reduce((sum, value) => sum + value, 0) / seen.length),
    worstMs: Math.max(...seen)
  }
}

test('BASELINE: how long a new line waits when the reader has been still', async () => {
  const scenario = byId('latency-after-idle')
  const { log, scanner } = await replay(scenario)
  const gap = largestObservationGap(log)
  // Sweep a full 5s interval, which is where the cadence has backed off to.
  const sweep = await latencySweep(scenario, 60000, 500, 11)
  remember('latency-after-idle', {
    largestObservationGapMs: gap,
    intervalAtEndMs: scanner.currentInterval,
    requests: requests(log),
    latencyAcrossPhases: sweep
  })

  assert.equal(sweep.missed, 0, 'the line does eventually reach the overlay')
  console.log(`  # longest stretch with no observation at all: ${gap}ms`)
  console.log(
    `  # new line reached the reader in ${sweep.bestMs}-${sweep.worstMs}ms (mean ${sweep.meanMs}ms) across ${sweep.samples} phases`
  )
})

test('BASELINE: dialogue advancing every four seconds', async () => {
  const scenario = byId('gameplay-cadence')
  const { log } = await replay(scenario)
  const lines = scenario.screen.filter((f) => f.text)
  const latencies = lines.map((line) => ({
    text: line.text,
    latencyMs: latencyFor(log, line.at, line.text)
  }))
  const missed = latencies.filter((l) => l.latencyMs === null)
  const seen = latencies.filter((l) => l.latencyMs !== null)
  const worst = Math.max(...seen.map((l) => l.latencyMs))
  const mean = Math.round(seen.reduce((sum, l) => sum + l.latencyMs, 0) / seen.length)
  remember('gameplay-cadence', {
    lines: lines.length,
    reached: seen.length,
    missedEntirely: missed.length,
    meanLatencyMs: mean,
    worstLatencyMs: worst,
    requests: requests(log)
  })

  console.log(`  # ${seen.length}/${lines.length} lines reached the overlay`)
  console.log(`  # mean ${mean}ms, worst ${worst}ms`)
  if (missed.length) console.log(`  # never shown: ${missed.map((l) => l.text).join(', ')}`)
})

test('BASELINE: read noise on a static screen', async () => {
  const single = await replay(byId('read-noise-single'))
  const sustained = await replay(byId('read-noise-sustained'))
  remember('read-noise-single', {
    requests: requests(single.log),
    applied: applies(single.log).length,
    published: single.stats.published
  })
  remember('read-noise-sustained', {
    requests: requests(sustained.log),
    applied: applies(sustained.log).length,
    published: sustained.stats.published,
    refreshedWithoutPublishing: sustained.stats.refreshedWithoutPublishing
  })

  console.log(`  # one bad reading in seven: ${requests(single.log)} requests over 60s`)
  console.log(`  # two bad readings in seven: ${requests(sustained.log)} requests over 60s`)
  console.log(`  # ... of which overlay re-applications: ${applies(sustained.log).length}`)
})

test('BASELINE: what the overlay still shows after the text disappears', async () => {
  for (const id of ['disappearance-after-settling', 'disappearance-before-settling']) {
    const scenario = byId(id)
    const { log, overlay } = await replay(scenario)
    remember(id, {
      stillShowing: overlay.showing,
      clears: overlay.clears,
      requests: requests(log),
      appliedAfterBlank: applies(log).filter((e) => e.at >= scenario.clearedBy - 10000).length
    })
    console.log(`  # ${id}: overlay still showing ${JSON.stringify(overlay.showing)}, ${overlay.clears} clears`)
  }
})

// --- the contract the overlay needs ----------------------------------------

test('FAILING: a blank screen invalidates what is drawn', async () => {
  const { overlay } = await replay(byId('disappearance-after-settling'))
  assert.equal(
    overlay.clears > 0,
    true,
    'the scanner must tell the overlay the text is gone, so the boxes can be cleared'
  )
  assert.equal(overlay.showing, '', 'and nothing stale is left on screen')
})

test('FAILING: changed text invalidates what is drawn before the new result lands', async () => {
  const scenario = byId('gameplay-cadence')
  const { log } = await replay(scenario)
  const invalidations = log.filter((e) => e.type === 'visual-invalidated' && e.reason === 'changed')
  assert.ok(
    invalidations.length >= 6,
    `boxes for the previous line must be dropped as soon as the text changes (saw ${invalidations.length})`
  )
})

test('FAILING: a new line reaches the reader promptly after an idle spell', async () => {
  // Stated against the worst phase, not a lucky one: the reader meets every
  // alignment, and the tail is the experience they describe.
  const sweep = await latencySweep(byId('latency-after-idle'), 60000, 500, 11)
  assert.ok(
    sweep.worstMs <= 2500,
    `a line appearing after an idle spell should reach the reader within 2.5s in every phase (worst was ${sweep.worstMs}ms, mean ${sweep.meanMs}ms)`
  )
})

test('FAILING: read noise on a static screen does not buy repeated requests', async () => {
  const { log } = await replay(byId('read-noise-sustained'))
  const count = requests(log)
  assert.ok(
    count <= 2,
    `a screen that never actually changes should not cost ${count} requests in a minute`
  )
})

// --- before and after, under the same measured costs ------------------------

/**
 * A calibrated simulation of the old configuration against the new one.
 *
 * Read the limits before reading the numbers, because this is not an
 * original-code measurement and cannot be made into one:
 *
 *  - **Both columns execute the current code.** Only the configuration differs:
 *    "before" is the legacy cadence with no pixel digest supplied, "after" is the
 *    retuned cadence with one. Visual invalidation and superseded-result
 *    rejection are in both columns because they are in the code; the original
 *    code had neither concept, so the before column's counts for those are
 *    artefacts of the simulation, not history.
 *  - **The two columns also use different costs.** Before runs the `old` cost
 *    model, after the `new` one, so the gap includes the native pipeline change
 *    as well as the scheduling change. It is an end-to-end old-versus-new
 *    figure, not an isolation of either.
 *
 * What it is good for: showing what a reader would experience on the old
 * configuration versus the new one. What it is not: evidence about what the
 * original code did.
 */
const LEGACY_SETTINGS = { pollInterval: 2000, adaptivePollMin: 500, adaptivePollMax: 5000 }

async function compare(scenario) {
  const before = await replay(scenario, LEGACY_SETTINGS, 'old', false)
  const after = await replay(scenario, {}, 'new', true)
  const shape = (run) => ({
    requests: requests(run.log),
    observations: run.observations,
    applied: applies(run.log).length,
    published: run.stats.published,
    invalidations: run.stats.invalidations,
    supersededResults: run.stats.supersededResults,
    largestObservationGapMs: largestObservationGap(run.log),
    stillShowing: run.overlay.showing
  })
  return { before: shape(before), after: shape(after) }
}

test('COMPARISON: every scenario, before and after, at measured costs', async () => {
  const comparison = {}
  for (const scenario of scenarios.scenarios) {
    comparison[scenario.id] = await compare(scenario)
  }

  // The latency ones get a phase sweep in both columns.
  const idle = byId('latency-after-idle')
  comparison['latency-after-idle'].before.latency = await latencySweep(
    idle, 60000, 500, 11, LEGACY_SETTINGS, 'old'
  )
  comparison['latency-after-idle'].after.latency = await latencySweep(idle, 60000, 500, 11, {}, 'new')

  writeFileSync(
    new URL('comparison.json', RESULTS),
    JSON.stringify(
      {
        note:
          'CALIBRATED SIMULATION, not an original-code before/after. Both columns execute the CURRENT code; only the configuration differs — before = legacy cadence 2000/500/5000 with no contentFingerprint supplied, after = retuned cadence 500/250/500 with one. The columns also use DIFFERENT cost models (before: old 400ms flat, after: new 250/150), so the gap includes the native pipeline change as well as the scheduling change and isolates neither. Invalidation and superseded-result counts appear in the before column only because they are in the code being run; the original code had no such mechanism, so those before values are simulation artefacts and not history. See baseline.json for what was actually measured against the original code, and its caveat.',
        costs: scenarios.costs,
        comparison
      },
      null,
      2
    ) + '\n'
  )

  for (const [id, sides] of Object.entries(comparison)) {
    console.log(
      `  # ${id}: requests ${sides.before.requests} -> ${sides.after.requests}, ` +
        `applied ${sides.before.applied} -> ${sides.after.applied}, ` +
        `gap ${Math.round(sides.before.largestObservationGapMs)} -> ${Math.round(sides.after.largestObservationGapMs)}ms`
    )
  }
  const idleSides = comparison['latency-after-idle']
  console.log(
    `  # latency after idle: ${Math.round(idleSides.before.latency.meanMs)}ms mean / ${Math.round(idleSides.before.latency.worstMs)}ms worst ` +
      `-> ${Math.round(idleSides.after.latency.meanMs)}ms / ${Math.round(idleSides.after.latency.worstMs)}ms`
  )
  assert.ok(Object.keys(comparison).length >= 9)
})

test('rapid dialogue while the cloud is slow does not pile up or go stale', async () => {
  const scenario = byId('rapid-change-slow-cloud')
  const { log, stats, overlay } = await replay(scenario)
  const lines = scenario.screen.filter((f) => f.text)
  const shown = applies(log).map((e) => e.text)
  remember('rapid-change-slow-cloud', {
    lines: lines.length,
    requests: requests(log),
    applied: shown.length,
    supersededResults: stats.supersededResults,
    staleDiscarded: stats.staleDiscarded,
    invalidations: stats.invalidations,
    endedShowing: overlay.showing
  })

  console.log(
    `  # ${lines.length} lines in 10s, 3s cloud: ${requests(log)} requests, ${shown.length} drawn, ` +
      `${stats.supersededResults} results dropped as superseded`
  )
  assert.ok(
    requests(log) <= lines.length,
    'a slow endpoint must not make the loop spend more requests than there were lines'
  )
  // Whatever it drew must have been on screen at the time, not a line the
  // reader had already passed.
  const last = lines[lines.length - 1].text
  assert.equal(overlay.showing, last, 'and it ends up showing the line that is actually up')
})

test('the box emptying while a request is queued clears rather than draws', async () => {
  const scenario = byId('blank-after-last-pending')
  const { log, stats, overlay } = await replay(scenario)
  remember('blank-after-last-pending', {
    requests: requests(log),
    applied: applies(log).length,
    invalidations: stats.invalidations,
    supersededResults: stats.supersededResults,
    staleDiscarded: stats.staleDiscarded,
    endedShowing: overlay.showing
  })

  console.log(
    `  # blank after last pending: ${requests(log)} requests, ${stats.invalidations} invalidations, ` +
      `ends showing ${JSON.stringify(overlay.showing)}`
  )
  assert.equal(overlay.showing, '', 'nothing is left drawn over an empty dialogue box')
  assert.ok(stats.invalidations >= 1, 'and the overlay was told to clear')
})

/**
 * How long stale boxes stay on screen after the text goes.
 *
 * The number the reader actually sees. Swept across phases of the observation
 * cycle, because where the blank falls relative to the next observation is
 * luck and the reader meets every alignment.
 */
async function blankClearSweep(samples = 13, step = 75) {
  const results = []
  for (let i = 0; i < samples; i++) {
    const blankAt = 10000 + i * step
    const { log } = await replay({
      id: 'blank-clear-latency',
      runForMs: blankAt + 5000,
      costs: { observeChangedMs: 250, observeUnchangedMs: 150, recognizeMs: 900 },
      screen: [
        { at: 0, text: '消える台詞' },
        { at: blankAt, text: '' }
      ]
    })
    const cleared = log.find(
      (e) => e.type === 'visual-invalidated' && e.reason === 'empty' && e.at >= blankAt
    )
    results.push(cleared ? cleared.at - blankAt : null)
  }
  const seen = results.filter((value) => value !== null)
  return {
    samples: results.length,
    neverCleared: results.length - seen.length,
    bestMs: Math.round(Math.min(...seen)),
    meanMs: Math.round(seen.reduce((sum, value) => sum + value, 0) / seen.length),
    worstMs: Math.round(Math.max(...seen))
  }
}

test('METRIC: how long stale boxes survive the text going away', async () => {
  const sweep = await blankClearSweep()
  remember('blank-clear-latency', sweep)
  console.log(
    `  # boxes cleared ${sweep.bestMs}-${sweep.worstMs}ms after the text went (mean ${sweep.meanMs}ms) across ${sweep.samples} phases`
  )
  assert.equal(sweep.neverCleared, 0, 'every phase cleared')
  assert.ok(
    sweep.worstMs <= 1000,
    `stale boxes should not outlive the text by more than the observation cycle (worst ${sweep.worstMs}ms)`
  )
})

test('records the measured baseline as evidence', async () => {
  writeFileSync(
    new URL('baseline.json', RESULTS),
    JSON.stringify(
      {
        note:
          'Measured against the CURRENT AutoScanner, driven through its real setTimeout scheduling seam on a virtual clock, using the calibrated cost model in scenarios.json. No app, no screen, no service. HISTORY: the first run of this file did measure the original, pre-change code — 26 requests on a noisy static screen, 0 clears on disappearance, 3691ms mean latency after idle — but it did so with a 60ms observation cost that later native probing showed to be about 6x too low. Those original-code latency figures are withdrawn as cost-model error; the request and clear counts from that run are unaffected by cost and stand.',
        settings: {
          pollInterval: DEFAULT_AUTO_OCR_SETTINGS.pollInterval,
          adaptivePollMin: DEFAULT_AUTO_OCR_SETTINGS.adaptivePollMin,
          adaptivePollMax: DEFAULT_AUTO_OCR_SETTINGS.adaptivePollMax,
          stableObservations: DEFAULT_AUTO_OCR_SETTINGS.stableObservations,
          minRequestSpacingMs: DEFAULT_AUTO_OCR_SETTINGS.minRequestSpacingMs,
          maxCandidateAgeMs: DEFAULT_AUTO_OCR_SETTINGS.maxCandidateAgeMs
        },
        costs: scenarios.costs,
        measured
      },
      null,
      2
    ) + '\n'
  )
  assert.ok(Object.keys(measured).length >= 6, 'every scenario was measured')
})

// --- holding recognition without going blind --------------------------------

test('holding recognition still observes, and still clears when the text goes', async () => {
  // The call site this exists for: the reader hovers a word, and the overlay
  // wants to stop spending on the endpoint while they read it. Pausing the loop
  // froze blank detection too, so the boxes they were pointing at outlived the
  // text underneath them.
  const scenario = {
    id: 'hold-during-hover',
    runForMs: 20000,
    costs: { observeChangedMs: 250, observeUnchangedMs: 150, recognizeMs: 900 },
    screen: [
      { at: 0, text: '読んでいる行' },
      { at: 8000, text: '' }
    ]
  }
  const clock = { at: 0 }
  const { log, overlay, stats, scanner } = await replayWithHook(scenario, (s, now) => {
    // Hover activity from 3s to 7s, re-armed every 200ms as a pointer would.
    if (now >= 3000 && now <= 7000) s.holdRequestsUntil(now + 3000)
    clock.at = now
  })

  const observedDuringHold = log.filter(
    (e) => e.type === 'observed' && e.at >= 3000 && e.at <= 7000
  ).length
  assert.ok(observedDuringHold >= 4, `the loop kept looking while held (${observedDuringHold})`)
  assert.ok(stats.invalidations >= 1, 'and still told the overlay when the text went')
  assert.equal(overlay.showing, '', 'so nothing was left drawn over an empty box')
  assert.equal(scanner.requestsHeld, false, 'and the hold lapsed on its own once activity stopped')
  console.log(`  # ${observedDuringHold} observations during a 4s hover hold, overlay cleared`)
})

test('a held line is recognised once the reader stops hovering, not dropped', async () => {
  const scenario = {
    id: 'hold-then-release',
    runForMs: 20000,
    costs: { observeChangedMs: 250, observeUnchangedMs: 150, recognizeMs: 900 },
    screen: [{ at: 0, text: '待っている行' }]
  }
  const { log, overlay } = await replayWithHook(scenario, (s, now) => {
    if (now <= 6000) s.holdRequestsUntil(now + 1000)
  })
  const first = log.find((e) => e.type === 'request')
  assert.ok(first, 'the line was eventually recognised')
  assert.ok(first.at >= 6000, `and not while held (ran at ${Math.round(first.at)}ms)`)
  assert.equal(overlay.showing, '待っている行')
  console.log(`  # held line recognised at ${Math.round(first.at)}ms, after the hold lifted`)
})
