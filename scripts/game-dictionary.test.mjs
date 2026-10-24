/**
 * The full-screen dictionary's pure parts (ui/game-dictionary.js, ui/game-dictionary-anki.js) and
 * when Read along opens it (`fullscreenDictionary` in ui/settings.ts). The view itself is checked
 * on the overlay stage (`/dev/stage.html?scene=controller-words&dictionary=full`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import {
  entryAudio,
  firstWord,
  inflectionChains,
  nextWord,
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
const { fullscreenDictionary, SETTINGS_DEFAULTS } = await import(pathToFileURL(outfile).href)
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

test('Read along opens the full-screen dictionary only when chosen and with the Yomitan API', () => {
  assert.deepEqual(SETTINGS_DEFAULTS.gameModeSettings, { dictionaryView: 'popup' })
  assert.equal(fullscreenDictionary({ dictionaryView: 'fullscreen' }, 'custom-api'), true)
  assert.equal(fullscreenDictionary({ dictionaryView: 'fullscreen' }, 'builtin'), false)
  assert.equal(fullscreenDictionary({ dictionaryView: 'fullscreen' }, 'hachidori'), false)
  assert.equal(fullscreenDictionary({ dictionaryView: 'popup' }, 'custom-api'), false)
  assert.equal(fullscreenDictionary(undefined, 'custom-api'), false)
})
