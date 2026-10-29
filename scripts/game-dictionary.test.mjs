/**
 * The full-screen dictionary's pure parts (ui/game-dictionary.js, ui/game-dictionary-anki.js) and
 * when Read along opens it (`fullscreenDictionary`, `fullscreenDictionarySource` in ui/settings.ts). The view itself is checked
 * on the overlay stage (`/dev/stage.html?scene=controller-words&dictionary=full`).
 */
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import {
  GameDictionary,
  edgeFades,
  entryAudio,
  firstWord,
  inflectionChains,
  lineRects,
  lookupSpan,
  nextWord,
  scrollToShow,
  sentenceLines,
  sentenceScale,
  sentenceTokens,
  soundFiles,
  splitTags
} from '../ui/game-dictionary.js'
import { createAnki, expressionField, noteFields } from '../ui/game-dictionary-anki.js'

const outDir = await mkdtemp(path.join(tmpdir(), 'kimochi-game-dictionary-'))
const outfile = path.join(outDir, 'settings.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../ui/settings.ts', import.meta.url))],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { fullscreenDictionary, fullscreenDictionarySource, SETTINGS_DEFAULTS } = await import(pathToFileURL(outfile).href)
await rm(outDir, { recursive: true, force: true })

const word = (start, end, text) => ({ start, end, text, word: true })

test('the boxes become one line of text, with every gap kept as a filler', () => {
  const { text, tokens } = sentenceTokens([
    { text: '今日はいい天気ですね。', tokens: [word(0, 2, '今日'), word(2, 3, 'は'), word(3, 5, 'いい'), word(5, 7, '天気')] },
    { text: '海まで', tokens: [word(0, 1, '海'), word(1, 3, 'まで')] }
  ])
  assert.equal(text, '今日はいい天気ですね。海まで')
  assert.deepEqual(
    tokens.map((t) => [t.text, t.word]),
    [['今日', true], ['は', true], ['いい', true], ['天気', true], ['ですね。', false], ['海', true], ['まで', true]]
  )
  assert.equal(tokens.map((t) => t.text).join(''), text)
  assert.deepEqual(
    tokens.map((t) => t.unit),
    [0, 0, 0, 0, 0, 1, 1]
  )
})

test("a box's lines are one box; another element starts the next", () => {
  const bubble = {}
  const { tokens } = sentenceTokens([
    { text: '待って！', element: bubble, tokens: [word(0, 3, '待って')] },
    { text: 'まだ', element: bubble, tokens: [word(0, 2, 'まだ')] },
    { text: '剣', element: {}, tokens: [word(0, 1, '剣')] }
  ])
  assert.deepEqual(
    tokens.map((t) => [t.text, t.box]),
    [['待って', 0], ['！', 0], ['まだ', 0], ['剣', 2]]
  )
})

test('a gap that crosses into the next box is split there', () => {
  const { tokens } = sentenceTokens([
    { text: '待って！', tokens: [word(0, 3, '待って')] },
    { text: '「まだ', tokens: [] }
  ])
  assert.deepEqual(
    tokens.map((t) => [t.text, t.unit]),
    [['待って', 0], ['！', 0], ['「まだ', 1]]
  )
})

test('a word that runs on into the next box is one stop, and that box loses the text it covers', () => {
  const { tokens } = sentenceTokens([
    { text: '散', tokens: [word(0, 2, '散歩')] },
    { text: '歩した', tokens: [word(0, 1, '歩'), word(1, 3, 'した')] }
  ])
  assert.deepEqual(
    tokens.map((t) => t.text),
    ['散歩', 'した']
  )
})

test('stepping skips fillers and stops at either end', () => {
  const tokens = [{ word: false }, { word: true }, { word: false }, { word: true }]
  assert.equal(firstWord(tokens), 1)
  assert.equal(nextWord(tokens, 1, 1), 3)
  assert.equal(nextWord(tokens, 3, 1), 3)
  assert.equal(nextWord(tokens, 3, -1), 1)
  assert.equal(nextWord(tokens, 1, -1), 1)
  assert.equal(firstWord([{ word: false }]), -1)
})

test("an entry's audio is the media its audio field names", () => {
  const fields = { audio: '[sound:yomitan_audio_tenki.mp3]' }
  assert.deepEqual(soundFiles(fields), ['yomitan_audio_tenki.mp3'])
  const media = [
    { ankiFilename: 'yomitan_audio_kyou.mp3', content: 'a' },
    { ankiFilename: 'yomitan_audio_tenki.mp3', content: 'b' }
  ]
  assert.equal(entryAudio(fields, media)?.content, 'b')
  assert.equal(entryAudio({}, media), null)
})

test('tags and inflections read as the pop-up shows them', () => {
  assert.deepEqual(splitTags('P, ichi1 news1'), ['P', 'ichi1', 'news1'])
  assert.deepEqual(splitTags('Unknown'), [])
  assert.deepEqual(inflectionChains('<ul><li>polite « negative</li><li>-te</li></ul>'), [['polite', 'negative'], ['-te']])
  assert.deepEqual(inflectionChains(''), [])
})

const CONFIG = {
  ankiConnectUrl: 'http://127.0.0.1:8765',
  deck: 'Mining "VN"',
  model: 'Lapis',
  modelFields: ['Expression', 'Sentence', 'MainDefinition', 'Picture'],
  mappings: [
    { ankiField: 'Expression', mappingType: 'marker', marker: 'expression' },
    { ankiField: 'Sentence', mappingType: 'sentence' },
    { ankiField: 'MainDefinition', mappingType: 'marker', marker: 'glossary' }
  ],
  tags: ['kimochi']
}
const FIELDS = { expression: '天気', glossary: '<ol><li>weather</li></ol>' }

test('the note maps every field of the note type, as the pop-up does', () => {
  assert.deepEqual(noteFields(CONFIG, FIELDS, '今日はいい天気ですね。'), {
    Expression: '天気',
    Sentence: '今日はいい天気ですね。',
    MainDefinition: '<ol><li>weather</li></ol>',
    Picture: ''
  })
  assert.deepEqual(expressionField(CONFIG, FIELDS, ''), { name: 'Expression', value: '天気' })
})

test('Add to Anki stores media, adds the note, and recovers a duplicate', async () => {
  const calls = []
  let duplicate = false
  const invoke = async (command, args) => {
    calls.push([command, args])
    if (command === 'anki_add_note') {
      if (duplicate) throw Error('cannot create note because it is a duplicate')
      return 42
    }
    if (command === 'anki_find_notes') return [7]
    return null
  }
  const anki = createAnki(invoke, CONFIG)
  const added = await anki.add(
    { fields: FIELDS, audioMedia: [{ ankiFilename: 'a.mp3', content: 'QUJD' }], dictionaryMedia: [] },
    'sentence'
  )
  assert.deepEqual(added, { noteId: 42, duplicate: false })
  assert.deepEqual(calls[0], ['anki_store_media_file', { url: CONFIG.ankiConnectUrl, filename: 'a.mp3', dataBase64: 'QUJD' }])
  assert.equal(calls[1][1].allowDuplicate, false)
  duplicate = true
  assert.deepEqual(await anki.add({ fields: FIELDS, audioMedia: [], dictionaryMedia: [] }, ''), { noteId: 7, duplicate: true })
  calls.length = 0
  assert.equal(await anki.exists(FIELDS, ''), 7)
  assert.deepEqual(calls[0][1].query, '"deck:Mining \\"VN\\"" "Expression:天気"')
})

test('Read along opens the full-screen dictionary whenever it is chosen, with every engine', () => {
  assert.deepEqual(SETTINGS_DEFAULTS.gameModeSettings, { dictionaryView: 'popup' })
  for (const engine of ['custom-api', 'builtin', 'hachidori', 'tenten', undefined]) {
    assert.equal(fullscreenDictionary({ dictionaryView: 'fullscreen' }, engine), true, engine)
    assert.equal(fullscreenDictionary({ dictionaryView: 'popup' }, engine), false, engine)
  }
  assert.equal(fullscreenDictionary(undefined, 'custom-api'), false)
  assert.equal(fullscreenDictionary(null), false)
  // The Yomitan API's entries are drawn by Kimochi; every other engine fills the space with its pop-up.
  assert.equal(fullscreenDictionarySource('custom-api'), 'entries')
  assert.equal(fullscreenDictionarySource('builtin'), 'popup')
  assert.equal(fullscreenDictionarySource('hachidori'), 'popup')
  assert.equal(fullscreenDictionarySource('tenten'), 'popup')
  assert.equal(fullscreenDictionarySource(undefined), 'popup')
})

test("a pop-up lookup reads from the lit word on, through the spans after it, up to the scan length", () => {
  const span = (text) => ({ firstChild: text === null ? null : { nodeType: 3, length: text.length, text } })
  const spans = [span('今日'), span('は'), span('いい'), span('天気'), span(null), span('ですね。')]
  const ends = lookupSpan(spans, 1, 5)
  assert.equal(ends.start.node.text, 'は')
  assert.equal(ends.start.offset, 0)
  // は + いい + 天気 = 5 characters: it ends at the end of 天気, skipping nothing it could read.
  assert.equal(ends.end.node.text, '天気')
  assert.equal(ends.end.offset, 2)
  // The default reaches on past the empty span, to the end of the text.
  const all = lookupSpan(spans, 0)
  assert.equal(all.end.node.text, 'ですね。')
  assert.equal(all.end.offset, 4)
  // Ends inside a span when the length runs out there.
  assert.equal(lookupSpan(spans, 0, 3).end.node.text, 'は')
  // 天気, past the span with no text, then one character of ですね。
  assert.deepEqual([lookupSpan(spans, 3, 3).end.node.text, lookupSpan(spans, 3, 3).end.offset], ['ですね。', 1])
  assert.equal(lookupSpan(spans, 4), null)
  assert.equal(lookupSpan(spans, -1), null)
  // From a character inside the word (the free cursor's): いい's second い, then 天気.
  const inside = lookupSpan(spans, 2, 3, 1)
  assert.deepEqual([inside.start.node.text, inside.start.offset], ['いい', 1])
  assert.deepEqual([inside.end.node.text, inside.end.offset], ['天気', 2])
  assert.equal(lookupSpan(spans, 2, 3, 2), null, 'past the word: nothing to start from')
})

test('the full-screen dictionary keeps the scan drawn, so it has words to read', async () => {
  // It reads its words from the drawn text (`readUnits`) after switching mode and redrawing. When
  // only word mode held the text, the overlay cleared it whenever it would not otherwise show
  // (the game not in front), and full screen said "No words to look up in this text".
  const source = await readFile(new URL('../ui/controller.js', import.meta.url), 'utf8')
  const getter = source.match(/get holdsText\(\) \{\s*return ([^;]+);/)
  assert.ok(getter, 'holdsText is not where it was')
  assert.match(getter[1], /mode === "words"/)
  assert.match(getter[1], /mode === "dictionary"/)
  assert.match(getter[1], /!historical/)
})

test('the scan is drawn as the Log shows it: a line per scanned line, the words only spans in it', () => {
  const box = {}
  const { text, lines } = sentenceLines([
    { text: '今日はいい天', element: box, tokens: [word(0, 2, '今日'), word(2, 3, 'は'), word(3, 5, 'いい'), word(5, 7, '天気')] },
    { text: '気ですね。', element: box, tokens: [] },
    { text: '', tokens: [] },
    { text: '海まで', tokens: [word(0, 1, '海'), word(1, 3, 'まで')] }
  ])
  // The text of each line is exactly the scanned line's: nothing added between words or boxes.
  assert.deepEqual(lines.map((line) => line.map((piece) => piece.text).join('')), ['今日はいい天', '気ですね。', '海まで'])
  assert.equal(lines.flat().map((piece) => piece.text).join(''), text)
  // 天気 runs on from the first line into the second: both pieces are the same word.
  const tenki = lines.flat().filter((piece) => piece.text === '天' || piece.text === '気')
  assert.equal(tenki.length, 2)
  assert.equal(tenki[0].index, tenki[1].index)
  assert.ok(tenki.every((piece) => piece.word))
  assert.deepEqual(lines[1].map((piece) => [piece.text, piece.word]), [['気', true], ['ですね。', false]])
})

test('long scans are set smaller, in steps, and many lines step down too', () => {
  assert.equal(sentenceScale(12, 1), 1)
  assert.equal(sentenceScale(30, 2), 1)
  assert.ok(sentenceScale(50, 1) < 1)
  assert.ok(sentenceScale(100, 2) < sentenceScale(50, 2))
  assert.ok(sentenceScale(400, 12) >= 0.5, 'never below the smallest step')
  assert.equal(sentenceScale(20, 3), 0.85)
  assert.equal(sentenceScale(20, 6), 0.72)
  // More text never sets it larger.
  let last = 1
  for (let chars = 1; chars < 500; chars += 7) {
    const scale = sentenceScale(chars, 1)
    assert.ok(scale <= last)
    last = scale
  }
})

test('the text fades at an edge only while there is more that way, and scrolls the lit word clear of the fades', () => {
  assert.deepEqual(edgeFades(0, 100, 100), { above: false, below: false })
  assert.deepEqual(edgeFades(0, 100, 300), { above: false, below: true })
  assert.deepEqual(edgeFades(100, 100, 300), { above: true, below: true })
  assert.deepEqual(edgeFades(200, 100, 300), { above: true, below: false })
  assert.deepEqual(edgeFades(199.5, 100, 300), { above: true, below: false }, 'sub-pixel rounding is the end')

  const view = { scrollTop: 0, clientHeight: 100 }
  assert.equal(scrollToShow(20, 40, view, 10), null, 'already clear')
  assert.equal(scrollToShow(80, 110, view, 10), 20, 'below: just enough to clear the bottom fade')
  assert.equal(scrollToShow(30, 50, { scrollTop: 40, clientHeight: 100 }, 10), 20, 'above: clear of the top fade')
  assert.equal(scrollToShow(0, 20, { scrollTop: 30, clientHeight: 100 }, 10), 0, 'never past the top')
  assert.equal(scrollToShow(200, 400, view, 10), 190, 'taller than the room: from its top')
})

test('the free cursor picks the character drawn nearest it, within reach, and none scrolled out of the text', () => {
  // Each character 20 wide and 30 high, a word's characters side by side.
  const span = (index, text, left, top) => ({
    dataset: { index: String(index) },
    firstChild: { nodeType: 3, length: text.length, rects: [...text].map((_, at) => ({ left: left + at * 20, top, right: left + at * 20 + 20, bottom: top + 30, width: 20 })) }
  })
  const spans = [span(0, '今日', 10, 110), span(2, 'よ過ぎ', 60, 110), span(4, '時', 10, 150), span(6, '残', 10, 230)]
  const document = globalThis.document
  globalThis.document = {
    createRange: () => {
      const range = { setStart(node, at) { range.node = node; range.at = at }, setEnd() {}, getBoundingClientRect: () => range.node.rects[range.at] }
      return range
    }
  }
  try {
    const view = new GameDictionary({}, {})
    view.source = 'popup'
    view.root = {
      querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 100, right: 600, bottom: 200 }) }),
      querySelectorAll: () => spans
    }
    assert.deepEqual(view.pointAt(105, 120, 14), { index: 2, offset: 2 }, 'ぎ, the third character of よ過ぎ')
    assert.deepEqual(view.pointAt(55, 120, 14), { index: 0, offset: 1 }, 'between two, the nearer: 日')
    assert.equal(view.pointAt(300, 120, 14), null, 'nothing within reach')
    assert.deepEqual(view.pointAt(20, 188, 14), { index: 4, offset: 0 }, 'just under the last line in the text')
    assert.deepEqual(view.pointAt(20, 240, 60), { index: 4, offset: 0 }, 'a character scrolled under the fade is not pointed at')
    // The Yomitan API's entries are by word: the same point, from the word's start.
    view.source = 'entries'
    assert.deepEqual(view.pointAt(105, 120, 14), { index: 2, offset: 0 })
  } finally {
    globalThis.document = document
  }
})

test("an engine's match is outlined a line at a time: a line's pieces joined, empty ones dropped", () => {
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height })
  assert.deepEqual(
    lineRects([rect(100, 10, 20, 30), rect(120, 12, 40, 26), rect(160, 10, 0, 30), rect(0, 50, 30, 30)]),
    [
      { left: 100, top: 10, width: 60, height: 30 },
      { left: 0, top: 50, width: 30, height: 30 }
    ]
  )
  assert.deepEqual(lineRects([]), [])
})
