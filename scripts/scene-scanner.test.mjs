/**
 * The scene-driven automatic OCR loop, end to end with scripted fakes and a hand-cranked clock.
 *
 * The headline case is a recorded session: a three-line dialogue with a small element beside it
 * that blinks, read by a recogniser that sometimes returns a partial result. The old loop
 * re-recognised on every blink and drew whatever came back, so the complete line kept being
 * replaced by the partial one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { SceneScanner } = await load('scene-scanner.ts')
const { normalizeOcrResult } = await load('ocr-result.ts')

const line = (text, y, x = 90, width = text.length * 30, height = 36) => ({
  text,
  box: { x, y, width, height }
})

function reading(lines) {
  const annotations = lines.map(({ text, box }) => ({
    description: text,
    boundingPoly: {
      vertices: [
        { x: box.x, y: box.y },
        { x: box.x + box.width, y: box.y },
        { x: box.x + box.width, y: box.y + box.height },
        { x: box.x, y: box.y + box.height }
      ]
    }
  }))
  return normalizeOcrResult(
    {
      fullText: lines.map((l) => l.text).join('\n'),
      textAnnotations: annotations.length ? [{ ...annotations[0], description: '' }, ...annotations] : []
    },
    'meikiocr'
  )
}

function harness({ screen, recognise, settings = {} }) {
  const state = { time: 100000, frames: 0, scenes: [], published: [], recognitions: 0, pins: new Map(), events: [] }
  const scanner = new SceneScanner(
    {
      now: () => state.time,
      generation: () => 1,
      captureFrame: async () => {
        if (state.captureError) throw state.captureError
        if (state.observerBusy) {
          return { frame: { id: ++state.frames, lines: [] }, generation: 1, hash: '0000000000000000', observation: null,
            observerError: 'The local MeikiOCR observer is still reading an earlier frame; retrying.', observerBusy: true }
        }
        const lines = screen(state)
        if (state.captureGate) await state.captureGate
        const frame = { id: ++state.frames, lines }
        return {
          frame,
          generation: 1,
          hash: '0000000000000000',
          observation: { text: lines.map((l) => l.text).join('\n'), lines }
        }
      },
      recognize: async (frame) => {
        state.recognitions++
        return recognise(frame, state)
      },
      retainFrame: (frame) => state.pins.set(frame.id, (state.pins.get(frame.id) ?? 0) + 1),
      releaseFrame: (frame) => state.pins.set(frame.id, (state.pins.get(frame.id) ?? 0) - 1),
      onEvent: (event) => state.events.push(event),
      onScene: (update) => {
        state.scenes.push(update.result.fullText.replace(/\n/g, ''))
        for (const passage of update.publish) {
          state.published.push(passage.result.fullText.replace(/\n/g, ''))
        }
      }
    },
    {
      ...{
        version: 2,
        pollInterval: 250,
        adaptivePollingEnabled: false,
        adaptivePollMin: 250,
        adaptivePollMax: 500,
        observerMode: 'text',
        stableObservations: 2,
        maxCandidateAgeMs: 4000,
        minRequestSpacingMs: 0,
        emptyObservationsToClear: 3,
        boxTolerancePx: 3,
        errorBackoffMs: 2000,
        maxErrorBackoffMs: 30000,
        maxConsecutiveErrors: 5,
        imageHashThreshold: 5,
        localOCRGateEnabled: false,
        localOCRSimilarityThreshold: 0.85
      },
      ...settings
    }
  )
  const step = async (ms = 250) => {
    state.time += ms
    await scanner.tick()
    await scanner.idle()
  }
  return { scanner, state, step }
}

const DIALOGUE = [
  line('今日はいい天気ですね', 396),
  line('散歩に行きましょうか', 436),
  line('それとも家で', 470)
]
const ARROW = line('▼', 470, 460, 20, 30)
const FULL = '今日はいい天気ですね散歩に行きましょうかそれとも家で'

test('text mode waits through a long minimisation and resumes without suspending (#2)', async () => {
  const { scanner, state, step } = harness({
    screen: () => DIALOGUE,
    recognise: (frame) => reading(frame.lines),
    settings: { maxConsecutiveErrors: 3 }
  })
  state.captureError = 'gone: hidden: Window is minimized; restore it before capturing.'
  for (let i = 0; i < 20; i++) await step(5000)
  assert.notEqual(scanner.state, 'suspended', '100 seconds out of view is not a capture failure')
  assert.equal(scanner.stats().captureErrors, 0)
  assert.equal(state.events.filter((e) => e.type === 'error').length, 0)
  const waits = state.events.filter((e) => e.type === 'skip' && e.reason === 'hidden')
  assert.equal(waits.length, 20, 'keeps checking at the base backoff instead of doubling it')
  assert.equal(waits[0].detail, 'Window is minimized; restore it before capturing.')
  state.captureError = null
  for (let i = 0; i < 12; i++) await step(500)
  assert.ok(state.recognitions > 0, 'restored text is recognised')
  assert.ok(state.scenes.some((text) => text.startsWith(FULL)), 'the restored scene is drawn')
})

test('a busy observer is waited for, never counted towards suspension (#41)', async () => {
  const { scanner, state, step } = harness({
    screen: () => DIALOGUE,
    recognise: (frame) => reading(frame.lines),
    settings: { maxConsecutiveErrors: 3 }
  })
  state.observerBusy = true
  for (let i = 0; i < 20; i++) await step(2500)
  assert.notEqual(scanner.state, 'suspended', 'a slow observer is not a failing one')
  assert.equal(scanner.stats().observerErrors, 0)
  const waits = state.events.filter((e) => e.type === 'skip' && e.reason === 'observer-busy')
  assert.ok(waits.length >= 19, 'keeps looking at the base backoff')
  state.observerBusy = false
  for (let i = 0; i < 12; i++) await step(500)
  assert.ok(state.scenes.some((text) => text.startsWith(FULL)), 'the scene is read once the observer keeps up')
})

test('a missing observation that is not busy still counts', async () => {
  const { scanner, state, step } = harness({ screen: () => DIALOGUE, recognise: (frame) => reading(frame.lines), settings: { maxConsecutiveErrors: 3 } })
  state.observerBusy = true
  // A failure without the busy flag: the observer returned nothing.
  const capture = scanner.deps.captureFrame
  scanner.deps.captureFrame = async () => ({ ...(await capture()), observerBusy: false })
  for (let i = 0; i < 6; i++) await step(60000)
  assert.equal(scanner.state, 'suspended')
})

test('text mode still suspends for a genuinely closed source', async () => {
  const { scanner, state, step } = harness({ screen: () => DIALOGUE, recognise: (frame) => reading(frame.lines) })
  state.captureError = 'gone: Source has closed or disconnected.'
  for (let i = 0; i < 5; i++) await step(60000)
  assert.equal(scanner.state, 'suspended')
  assert.equal(scanner.stats().captureErrors, 5)
})

test('a blinking element beside the dialogue never replaces a full reading with a partial one', async () => {
  const { state, step } = harness({
    // The arrow blinks every half second.
    screen: (s) => (Math.floor(s.time / 500) % 2 ? [...DIALOGUE, ARROW] : DIALOGUE),
    // Every other recognition loses most of the first line, as the recorded partials did.
    recognise: (frame, s) =>
      reading(
        s.recognitions % 2 === 0
          ? [line('今日は', 396), ...frame.lines.slice(1)]
          : frame.lines
      )
  })
  for (let i = 0; i < 60; i++) await step()

  assert.ok(state.recognitions <= 6, `${state.recognitions} recognitions in 15 seconds`)
  const best = state.scenes.findIndex((text) => text.startsWith(FULL))
  assert.ok(best >= 0, 'the full reading was drawn')
  for (const text of state.scenes.slice(best)) {
    assert.ok(text.startsWith(FULL), `a later drawing lost text: ${text}`)
  }
  assert.deepEqual(state.published, [FULL], 'published once, complete')
})

test('a partial first reading is corrected by a second opinion before anything is published', async () => {
  const { state, step } = harness({
    screen: () => DIALOGUE,
    recognise: (frame, s) =>
      reading(s.recognitions === 1 ? [line('今日は', 396), ...frame.lines.slice(1)] : frame.lines)
  })
  for (let i = 0; i < 12; i++) await step()
  assert.equal(state.recognitions, 2)
  assert.equal(state.scenes.at(-1), FULL)
  assert.deepEqual(state.published, [FULL])
})

test('the next line of dialogue in the same box is read and published', async () => {
  const next = [line('明日は雨だそうです', 396), line('傘を持って行こう', 436)]
  const { state, step } = harness({
    screen: (s) => (s.time < 102000 ? DIALOGUE : next),
    recognise: (frame) => reading(frame.lines)
  })
  for (let i = 0; i < 16; i++) await step()
  assert.deepEqual(state.published, [FULL, '明日は雨だそうです傘を持って行こう'])
  assert.equal(state.scenes.at(-1), '明日は雨だそうです傘を持って行こう')
  assert.equal(state.recognitions, 2)
})

test('dialogue skipped before it settled is rescued from the last frame that showed it', async () => {
  const { state, step } = harness({
    screen: (s) => (s.time <= 100500 ? DIALOGUE : []),
    recognise: (frame) => reading(frame.lines)
  })
  // Seen twice, then gone, with the recogniser busy elsewhere: hold requests briefly.
  for (let i = 0; i < 6; i++) await step()
  assert.ok(state.published.includes(FULL), `published: ${JSON.stringify(state.published)}`)
  assert.equal(state.scenes.at(-1), '')
})

test('a screen the observer cannot read is recognised once it holds still', async () => {
  const hidden = [line('ひみつの文字', 100, 300)]
  let hash = '0000000000000000'
  const { state, step, scanner } = harness({
    screen: () => [],
    recognise: () => reading(hidden)
  })
  scanner.deps.captureFrame = async () => ({
    frame: { id: ++state.frames, lines: [] },
    generation: 1,
    hash,
    observation: { text: '', lines: [] }
  })
  for (let i = 0; i < 4; i++) await step()
  assert.equal(state.recognitions, 1)
  assert.equal(state.scenes.at(-1), 'ひみつの文字')
  for (let i = 0; i < 8; i++) await step()
  assert.equal(state.recognitions, 1, 'the same picture is not read again')
  hash = 'ffffffffffffffff'
  for (let i = 0; i < 12; i++) await step()
  assert.equal(state.recognitions, 2, 'a changed picture is')
})

test('pins are balanced once the loop stops', async () => {
  const { state, step, scanner } = harness({
    screen: () => DIALOGUE,
    recognise: (frame) => reading(frame.lines)
  })
  for (let i = 0; i < 8; i++) await step()
  scanner.stop()
  await scanner.pinsSettled()
  for (const [id, count] of state.pins) assert.equal(count, 0, `frame ${id} left pinned`)
})

test('paused (controller menu or word mode): nothing is captured or drawn, and it picks up on resume', async () => {
  let release
  const { state, step, scanner } = harness({
    screen: () => DIALOGUE,
    recognise: (frame) => new Promise((resolve) => (release = () => resolve(reading(frame.lines))))
  })
  await step()
  state.time += 250
  await scanner.tick() // settles and sends a recognition, which stays out
  assert.equal(state.recognitions, 1)
  scanner.pause()
  release()
  await scanner.idle()
  assert.equal(state.scenes.length, 0, 'a result landing while paused is set aside')
  const frames = state.frames
  for (let i = 0; i < 8; i++) await step()
  assert.equal(state.frames, frames, 'nothing captured while paused')
  scanner.resume()
  for (let i = 0; i < 3; i++) {
    state.time += 250
    await scanner.tick()
    release()
    await scanner.idle()
  }
  assert.equal(state.recognitions, 2, 'the set-aside text is read again')
  assert.equal(state.scenes.at(-1), FULL)
  assert.deepEqual(state.published, [FULL])
})

test('Scan with automatic OCR on: nothing new means straight in, new text is read at once', async () => {
  let screen = DIALOGUE
  const { state, step, scanner } = harness({
    screen: () => screen,
    recognise: (frame) => reading(frame.lines)
  })
  scanner.start()
  scanner.stop() // drive by hand, but let refresh see a running loop
  scanner.running = true
  for (let i = 0; i < 4; i++) await step()
  assert.equal(state.recognitions, 1)
  assert.equal(await scanner.refresh(), true, 'already current: nothing to catch up on')
  assert.equal(state.recognitions, 1)

  screen = [line('明日は雨だそうです', 396)]
  state.time += 250
  assert.equal(await scanner.refresh(), true)
  assert.equal(state.recognitions, 2, 'read at once, without waiting to settle')
  assert.equal(state.scenes.at(-1), '明日は雨だそうです')
})


test('entering an overlay lookup while a capture is out freezes visible text until a fresh observation',async()=>{
 let lines=DIALOGUE
 const {scanner,state,step}=harness({screen:()=>lines,recognise:frame=>reading(frame.lines)})
 for(let n=0;n<4;n++)await step()
 const scenes=state.scenes.length
 lines=[]
 let release
 state.captureGate=new Promise(resolve=>{release=resolve})
 const pending=scanner.tick()
 scanner.pause();release()
 assert.equal(await pending,'paused')
 assert.equal(state.scenes.length,scenes,'late blank observation must not clear text under lookup')
 state.captureGate=null
 scanner.resume()
 for(let n=0;n<5;n++)await step()
 assert.equal(state.scenes.at(-1),'','real disappearance is still processed after leaving')
})
