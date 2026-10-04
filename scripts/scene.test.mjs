/**
 * The scene memory behind automatic OCR: lines followed one at a time, learned behaviour, and
 * readings that never get worse. Every case here is something the old whole-screen comparison
 * got wrong in a recorded session.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { SceneMemory, agreement, decoratedVariant, isJapanese } = await load('scene.ts')
const { normalizeOcrResult } = await load('ocr-result.ts')

const line = (text, y, x = 90, width = text.length * 30, height = 36) => ({
  text,
  box: { x, y, width, height }
})

/** A MeikiOCR-shaped recognition: one annotation per line, in capture pixels. */
function reading(lines, engine = 'meikiocr') {
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
    engine
  )
}

/** The passages published now, as plain strings. */
const published = (scene, at) =>
  scene.takePublishable(at).map((passage) => passage.result.fullText.replace(/\n/g, ''))

const shownText = (scene) => scene.composite().fullText.replace(/\n/g, '')

const DIALOGUE = [line('今日はいい天気ですね', 396), line('散歩に行きましょうか', 436)]
const ARROW = line('▼', 470, 400, 20, 30)

/** Observe the same lines `times` times from `at`, a quarter second apart. */
function hold(scene, lines, at, times = 2) {
  let last
  for (let i = 0; i < times; i++) last = scene.observe(lines, at + i * 250)
  return { at: at + (times - 1) * 250, last }
}

test('a settled passage asks for a reading once, and the reading is shown', () => {
  const scene = new SceneMemory()
  scene.observe(DIALOGUE, 0)
  assert.equal(scene.readiness(0, 4000), null, 'one sighting is not settled')
  scene.observe(DIALOGUE, 250)
  const ready = scene.readiness(250, 4000)
  assert.equal(ready?.reason, 'settled')
  scene.apply(reading(DIALOGUE), scene.snapshot(250), 300)
  assert.equal(shownText(scene), '今日はいい天気ですね散歩に行きましょうか')
  scene.observe(DIALOGUE, 500)
  assert.equal(scene.readiness(500, 4000), null, 'already read')
})

test('a blinking arrow costs one reading, then nothing, and never disturbs the dialogue', () => {
  const scene = new SceneMemory()
  hold(scene, DIALOGUE, 0)
  scene.apply(reading(DIALOGUE), scene.snapshot(250), 300)
  let asked = 0
  let at = 500
  for (let cycle = 0; cycle < 10; cycle++) {
    for (const lines of [[...DIALOGUE, ARROW], [...DIALOGUE, ARROW], DIALOGUE, DIALOGUE]) {
      scene.observe(lines, at)
      const ready = scene.readiness(at, 4000)
      if (ready) {
        asked++
        scene.apply(reading(lines), scene.snapshot(at), at + 10)
      }
      assert.ok(shownText(scene).startsWith('今日はいい天気ですね散歩に行きましょうか'), `cycle ${cycle}`)
      at += 250
    }
  }
  assert.equal(asked, 1, 'the arrow is read once and remembered')
  assert.equal(scene.stats(at).blinking, 1)
})

test('a worse reading of the same text never replaces a better one', () => {
  const scene = new SceneMemory()
  hold(scene, DIALOGUE, 0)
  const snapshot = scene.snapshot(250)
  scene.apply(reading(DIALOGUE), snapshot, 300)
  const outcome = scene.apply(
    reading([line('今日は天気', 396), line('散歩に行きましょうか', 436)]),
    snapshot,
    400
  )
  // Both pieces are turned away: the first is worse, the second no better.
  assert.equal(outcome.rejected, 2)
  assert.equal(shownText(scene), '今日はいい天気ですね散歩に行きましょうか')
})

test('a doubted reading earns a second opinion, and the better one takes its place', () => {
  const scene = new SceneMemory()
  hold(scene, DIALOGUE, 0)
  scene.apply(reading([line('今日は天気', 396), DIALOGUE[1]]), scene.snapshot(250), 300)
  scene.observe(DIALOGUE, 500)
  assert.equal(scene.readiness(500, 4000)?.reason, 'second-opinion')
  const outcome = scene.apply(reading(DIALOGUE), scene.snapshot(500), 600)
  assert.equal(outcome.improved, 1)
  assert.equal(shownText(scene), '今日はいい天気ですね散歩に行きましょうか')
  scene.observe(DIALOGUE, 750)
  assert.equal(scene.readiness(750, 4000), null, 'two attempts is enough')
})

test('new text in the same box needs confirming, then replaces the old reading', () => {
  const scene = new SceneMemory()
  hold(scene, DIALOGUE, 0)
  scene.apply(reading(DIALOGUE), scene.snapshot(250), 300)
  const next = [line('明日は雨だそうです', 396), DIALOGUE[1]]
  scene.observe(next, 500)
  assert.ok(shownText(scene).startsWith('今日は'), 'one sighting changes nothing')
  scene.observe(next, 750)
  assert.ok(!shownText(scene).startsWith('今日は'), 'confirmed: the old reading is taken off')
  assert.ok(shownText(scene).includes('散歩に'), 'the unchanged line keeps its reading')
  // Two identical sightings are what settled means, so the new line is due at once.
  assert.deepEqual(scene.readiness(750, 4000), { reason: 'settled', tracks: [1] })
})

test('a single noisy sighting is ignored', () => {
  const scene = new SceneMemory()
  hold(scene, DIALOGUE, 0)
  scene.apply(reading(DIALOGUE), scene.snapshot(250), 300)
  scene.observe([line('今目はいい天気ですね', 396), DIALOGUE[1]], 500)
  scene.observe(DIALOGUE, 750)
  assert.equal(shownText(scene), '今日はいい天気ですね散歩に行きましょうか')
  assert.equal(scene.readiness(750, 4000), null)
})

test('text being typed out keeps its shorter reading and is read again once it stops', () => {
  const scene = new SceneMemory()
  const typed = (text) => [line(text, 396)]
  hold(scene, typed('今日は'), 0)
  scene.apply(reading(typed('今日は')), scene.snapshot(250), 300)
  scene.observe(typed('今日はいい'), 500)
  assert.equal(shownText(scene), '今日は', 'the prefix still reads true')
  assert.equal(scene.readiness(500, 4000), null, 'still typing')
  scene.observe(typed('今日はいい天気'), 750)
  scene.observe(typed('今日はいい天気'), 1000)
  assert.equal(scene.readiness(1000, 4000)?.reason, 'settled')
})

test('a passage is read whole: a finished line waits for the line still typing beside it', () => {
  const scene = new SceneMemory()
  scene.observe([DIALOGUE[0], line('散歩', 436)], 0)
  scene.observe([DIALOGUE[0], line('散歩に行き', 436)], 250)
  scene.observe([DIALOGUE[0], line('散歩に行きましょうか', 436)], 500)
  assert.equal(scene.readiness(500, 4000), null)
  scene.observe(DIALOGUE, 750)
  assert.equal(scene.readiness(750, 4000)?.reason, 'settled')
})

test('a passage that never settles is read anyway after the longest wait', () => {
  const scene = new SceneMemory()
  let text = '今'
  for (let at = 0; at < 4000; at += 250) {
    text += 'あ'
    scene.observe([line(text, 396)], at)
  }
  assert.equal(scene.readiness(3750, 4000), null)
  text += 'あ'
  scene.observe([line(text, 396)], 4000)
  assert.equal(scene.readiness(4000, 4000)?.reason, 'max-wait')
})

test('a ticking counter is learned as volatile and stops asking, while dialogue still does', () => {
  const scene = new SceneMemory()
  const clock = (n) => line(`残り${n}秒`, 20, 600, 120, 30)
  let asked = 0
  let n = 60
  let at = 0
  for (let i = 0; i < 24; i++) {
    if (i % 3 === 0) n--
    scene.observe([clock(n)], at)
    const ready = scene.readiness(at, 100000)
    if (ready) {
      asked++
      scene.apply(reading([clock(n)]), scene.snapshot(at), at + 5)
    }
    at += 250
  }
  assert.ok(asked <= 5, `a counter asked ${asked} times`)
  assert.equal(scene.stats(at).volatile, 1)
  // The volatile line holds nothing else up.
  scene.observe([clock(n), ...DIALOGUE], at)
  scene.observe([clock(n - 1), ...DIALOGUE], at + 250)
  scene.observe([clock(n - 1), ...DIALOGUE], at + 500)
  assert.equal(scene.readiness(at + 500, 100000)?.reason, 'settled')
})

test('a reader clicking through dialogue in one box is never mistaken for churn', () => {
  const scene = new SceneMemory()
  const lines = ['おはよう', 'いい朝だね', '散歩しよう', 'どこへ行く', '公園がいい', 'そうしよう']
  let at = 0
  let asked = 0
  for (const text of lines) {
    // Each line holds for a second and a half: read, then clicked away.
    for (let i = 0; i < 6; i++, at += 250) {
      scene.observe([line(text, 396)], at)
      if (scene.readiness(at, 4000)) {
        asked++
        scene.apply(reading([line(text, 396)]), scene.snapshot(at), at + 5)
      }
    }
  }
  assert.equal(asked, lines.length)
  assert.equal(scene.stats(at).volatile, 0)
})

test('a line already being read is not rescued when it goes', () => {
  const scene = new SceneMemory()
  hold(scene, DIALOGUE, 0)
  const reading = new Set(scene.snapshot(250).tracks.map((t) => t.version))
  assert.equal(scene.observe([], 500, reading).lostUnread.length, 0)
})

test('lines that go are taken off after two misses, a blank screen included', () => {
  const scene = new SceneMemory()
  hold(scene, DIALOGUE, 0)
  scene.apply(reading(DIALOGUE), scene.snapshot(250), 300)
  scene.observe([DIALOGUE[1]], 500)
  assert.ok(shownText(scene).includes('今日は'), 'one miss is not gone')
  scene.observe([DIALOGUE[1]], 750)
  assert.ok(!shownText(scene).includes('今日は'), 'two misses are')
  // One blank frame (a flicker, a transition) changes nothing; two is a cleared screen.
  assert.equal(scene.observe([], 1000).displayChanged, false)
  assert.ok(shownText(scene).includes('散歩に'))
  assert.equal(scene.observe([], 1250).displayChanged, true)
  assert.equal(shownText(scene), '')
})

test('content that comes back brings its reading back, without asking again', () => {
  const scene = new SceneMemory()
  const a = [line('はい', 396)]
  const b = [line('いいえ', 396)]
  hold(scene, a, 0)
  scene.apply(reading(a), scene.snapshot(250), 300)
  hold(scene, b, 500)
  scene.apply(reading(b), scene.snapshot(750), 800)
  scene.observe(a, 1000)
  assert.equal(shownText(scene), 'はい')
  assert.equal(scene.readiness(1000, 4000), null)
})

test('a line that went before it was read is owed a rescue', () => {
  const scene = new SceneMemory()
  hold(scene, DIALOGUE, 0)
  assert.equal(scene.observe([], 500).lostUnread.length, 0, 'one blank frame is not gone')
  assert.equal(scene.observe([], 750).lostUnread.length, 2)
})

test('a doubted reading with no second opinion is published when its grace runs out', () => {
  const scene = new SceneMemory()
  hold(scene, DIALOGUE, 0)
  scene.apply(reading([line('今日は天気', 396), DIALOGUE[1]]), scene.snapshot(250), 300)
  assert.deepEqual(published(scene, 1000), [])
  assert.deepEqual(published(scene, 1800), ['今日は天気散歩に行きましょうか'])
})

test('the history gets new Japanese text once, and not its decorated twin', () => {
  const scene = new SceneMemory()
  hold(scene, DIALOGUE, 0)
  scene.apply(reading(DIALOGUE), scene.snapshot(250), 300)
  assert.deepEqual(published(scene, 300), ['今日はいい天気ですね散歩に行きましょうか'])
  assert.deepEqual(published(scene, 400), [], 'once')

  // The last line read again with an arrow on the end is the same line.
  const decorated = [DIALOGUE[0], line('散歩に行きましょうか▼', 436)]
  hold(scene, decorated, 500, 3)
  scene.apply(reading(decorated), scene.snapshot(1000), 1010)
  assert.deepEqual(published(scene, 1010), [])

  // Menu labels and numbers are drawn but not published.
  const menu = [line('SAVE', 20, 600, 80, 30)]
  hold(scene, [...decorated, ...menu], 1250)
  scene.apply(reading([...decorated, ...menu]), scene.snapshot(1500), 1510)
  assert.deepEqual(published(scene, 1510), [])
  assert.ok(shownText(scene).includes('SAVE'))
})

test('the same line after a blank screen is published again', () => {
  const scene = new SceneMemory()
  const a = [line('はい', 396)]
  hold(scene, a, 0)
  scene.apply(reading(a), scene.snapshot(250), 300)
  assert.equal(published(scene, 300).length, 1)
  hold(scene, [], 500)
  hold(scene, [line('はい', 396, 300)], 1000)
  scene.apply(reading([line('はい', 396, 300)]), scene.snapshot(1250), 1260)
  assert.equal(published(scene, 1260).length, 1)
})

test('a doubted reading waits for its second opinion before it is published', () => {
  const scene = new SceneMemory()
  hold(scene, DIALOGUE, 0)
  scene.apply(reading([line('今日は天気', 396), DIALOGUE[1]]), scene.snapshot(250), 300)
  assert.deepEqual(published(scene, 300), [], 'the whole passage waits for the doubted line')
  scene.apply(reading(DIALOGUE), scene.snapshot(500), 600)
  assert.deepEqual(
    published(scene, 600),
    ['今日はいい天気ですね散歩に行きましょうか'],
    'the better reading is published, with its passage, in order'
  )
})

test('text the observer cannot see is kept as an orphan until recognitions stop finding it', () => {
  const scene = new SceneMemory()
  const hidden = [line('ひみつ', 100, 300)]
  scene.apply(reading(hidden), scene.snapshot(0), 0, 'blind')
  assert.equal(shownText(scene), 'ひみつ')
  scene.apply(reading(hidden), scene.snapshot(500), 500, 'auto')
  assert.equal(shownText(scene), 'ひみつ')
  scene.apply(reading([]), scene.snapshot(1000), 1000, 'blind')
  assert.equal(shownText(scene), '')
})

test('a bubble read as one block covers every line inside it', () => {
  const scene = new SceneMemory()
  const columns = [line('こんにちは', 100, 300, 30, 150), line('げんき', 100, 260, 30, 90)]
  hold(scene, columns, 0)
  const block = normalizeOcrResult(
    {
      groups: [{ id: 'b0', text: 'こんにちは\nげんき', bbox: [255, 95, 335, 255], orientation: 'vertical' }]
    },
    'mangaocr'
  )
  const outcome = scene.apply(block, scene.snapshot(250), 300)
  assert.equal(outcome.filed, 1)
  const shown = scene.composite()
  assert.equal(shown.groups.length, 1)
  assert.equal(shown.textAnnotations.at(-1).granularity, 'block')
  scene.observe(columns, 500)
  assert.equal(scene.readiness(500, 4000), null)
})

test('text helpers', () => {
  assert.equal(agreement('今日は', '今日は'), 1)
  assert.ok(agreement('今日はいい天気', '今日は天気') < 0.8)
  assert.ok(decoratedVariant('行きましょうか', '行きましょうか▼'))
  assert.ok(!decoratedVariant('殺す', '返す'), 'a changed character is never decoration')
  assert.ok(isJapanese('SAVE する') && !isJapanese('HP 120/300'))
})

// --- text that draws in -------------------------------------------------------------

/** A line whose ink is `level` in every cell: how faded in it is. */
const inked = (text, y, level) => ({ ...line(text, y), ink: Array(8).fill(level) })

test('text fading in is not settled until its ink stops changing', () => {
  const scene = new SceneMemory()
  // The observer reads the words from the first frame; the ink keeps rising.
  scene.observe([inked('今日はいい天気ですね', 396, 10)], 0)
  scene.observe([inked('今日はいい天気ですね', 396, 25)], 250)
  scene.observe([inked('今日はいい天気ですね', 396, 40)], 500)
  assert.equal(scene.readiness(500, 4000), null, 'still fading in')
  scene.observe([inked('今日はいい天気ですね', 396, 52)], 750)
  scene.observe([inked('今日はいい天気ですね', 396, 52)], 1000)
  assert.equal(scene.readiness(1000, 4000)?.reason, 'settled')
})

test('a line read while it was still drawing in is read again once it settles, and the fuller reading wins', () => {
  const scene = new SceneMemory()
  const text = '今日はいい天気ですね'
  hold(scene, [inked(text, 396, 20)], 0)
  // Read too early: the recogniser only made out the first half.
  scene.apply(reading([line('今日はいい', 396)]), scene.snapshot(250), 300)
  scene.observe([inked(text, 396, 35)], 500)
  scene.observe([inked(text, 396, 50)], 750)
  assert.equal(scene.readiness(750, 4000), null, 'not while it is still moving')
  scene.observe([inked(text, 396, 50)], 1000)
  assert.equal(scene.readiness(1000, 4000)?.reason, 'refresh')
  scene.apply(reading([line(text, 396)]), scene.snapshot(1000), 1050)
  assert.equal(shownText(scene), text)
  scene.observe([inked(text, 396, 50)], 1250)
  assert.equal(scene.readiness(1250, 4000), null, 'caught up')
})

test('ink that never stops moving is learned as a backdrop and stops holding the line open', () => {
  const scene = new SceneMemory()
  let at = 0
  for (let i = 0; i < 16; i++, at += 250) {
    scene.observe([inked('今日はいい天気ですね', 396, i % 2 ? 30 : 60)], at)
  }
  scene.observe([inked('今日はいい天気ですね', 396, 30)], at)
  assert.equal(scene.readiness(at, 100000)?.reason, 'settled')
})

test('a passage is published only once every line has finished arriving', () => {
  const scene = new SceneMemory()
  hold(scene, DIALOGUE, 0)
  scene.apply(reading(DIALOGUE), scene.snapshot(250), 300)
  // A third line starts typing before the history is written.
  const typing = [...DIALOGUE, line('どう', 470)]
  scene.observe(typing, 300)
  assert.deepEqual(published(scene, 300), [], 'a line of the passage is still arriving')
  const done = [...DIALOGUE, line('どうかな', 470)]
  hold(scene, done, 550)
  scene.apply(reading(done), scene.snapshot(800), 850)
  assert.deepEqual(published(scene, 850), ['今日はいい天気ですね散歩に行きましょうかどうかな'])
})

test('a passage that grows after it was written replaces its history entry', () => {
  const scene = new SceneMemory()
  const first = [line('今日は', 396)]
  hold(scene, first, 0)
  scene.apply(reading(first), scene.snapshot(250), 300)
  assert.deepEqual(published(scene, 300), ['今日は'])
  // The typewriter had only paused.
  const more = [line('今日はいい天気', 396)]
  hold(scene, more, 550)
  scene.apply(reading(more), scene.snapshot(800), 850)
  const [passage] = scene.takePublishable(850)
  assert.equal(passage.result.fullText, '今日はいい天気')
  assert.equal(passage.replaces, '今日は')
})

test('new dialogue in the same box is a new entry, not a correction', () => {
  const scene = new SceneMemory()
  hold(scene, DIALOGUE, 0)
  scene.apply(reading(DIALOGUE), scene.snapshot(250), 300)
  scene.takePublishable(300)
  const next = [line('明日は雨だそうです', 396), line('傘を持って行こう', 436)]
  hold(scene, next, 550)
  scene.apply(reading(next), scene.snapshot(800), 850)
  const [passage] = scene.takePublishable(850)
  assert.equal(passage.replaces, null)
})

test('a forced look reads what is owed without waiting for it to settle', () => {
  const scene = new SceneMemory()
  scene.observe(DIALOGUE, 0)
  assert.equal(scene.readiness(0, 4000), null)
  assert.equal(scene.readiness(0, 4000, new Set(), true)?.reason, 'forced')
})

// --- flicker -----------------------------------------------------------------------

test('a game drawing a line on alternate frames still settles, and is read once', () => {
  const scene = new SceneMemory()
  // The observer catches the third line on every other look, and the ink flickers with it.
  const on = [...DIALOGUE.map((l) => ({ ...l, ink: Array(8).fill(40) })), inked('それとも家で', 470, 40)]
  const off = DIALOGUE.map((l) => ({ ...l, ink: Array(8).fill(30) }))
  let asked = 0
  let at = 0
  for (let i = 0; i < 12; i++, at += 150) {
    scene.observe(i % 2 ? off : on, at)
    const ready = scene.readiness(at, 100000)
    if (ready) {
      asked++
      scene.apply(reading(i % 2 ? off : on), scene.snapshot(at), at + 5)
    }
  }
  assert.ok(asked >= 1 && asked <= 3, `asked ${asked} times`)
  const first = scene.stats(at)
  assert.equal(first.shown > 0, true)
})

test('the same passage read again with its lines split differently is not published twice', () => {
  const scene = new SceneMemory()
  hold(scene, DIALOGUE, 0)
  scene.apply(reading(DIALOGUE), scene.snapshot(250), 300)
  assert.equal(published(scene, 300).length, 1)
  // The observer now reads the two lines as one long line somewhere slightly different.
  const merged = [line('今日はいい天気ですね散歩に行きましょうか', 600, 90, 600, 40)]
  hold(scene, merged, 500)
  scene.apply(reading(merged), scene.snapshot(750), 760)
  assert.deepEqual(published(scene, 760), [])
})
