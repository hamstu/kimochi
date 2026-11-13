/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
/**
 * The text pipeline for a language other than Japanese (the `language` setting): the script
 * gates keep the language's own text, words are joined with spaces where the language spaces
 * them, vertical text is only looked for where the language is set vertically, and a lookup in
 * a spaced language starts at the hovered word's start. Beside each, Japanese is checked to be
 * exactly what it was without a language.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'
import { load } from './load.mjs'
import {
  JAPANESE_WORDS,
  readingUnits,
  segmentAcross,
  segmentText,
  tokensFromSegmenter
} from '../ui/word-nav.js'
import { gnomeWordCells } from '../ui/gnome-word-cells.js'

const { dropsText, japaneseFilterOf, mostlyNonJapanese } = await load('japanese-text.ts')
const { hasLanguageScript, joiner } = await load('script-text.ts')
const { visibleAnnotations, buildFilteredText, groupTextAnnotations } = await load('annotations.ts')
const { inferOrientations, logicalGroups, normalizeOcrResult } = await load('ocr-result.ts')
const { SceneMemory, decorationOnly, inLanguage } = await load('scene.ts')
const { placeHookedLine, splitAcrossLines } = await load('hook-match.ts')
const { lookaheadTexts, selectionExtension } = await load('render.js')
const scanText = await (async () => {
  // scan-text.ts is plain DOM with no imports; loaded as scan-text.test.mjs loads it.
  const source = await readFile(new URL('../ui/scan-text.ts', import.meta.url), 'utf8')
  const { code } = await transform(source, { loader: 'ts', format: 'esm' })
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
})()

/** Read along's words for a language, as the overlay builds them (`languageWords`). */
const wordsOf = (code, spaces = true) => ({ code, spaces, test: (text) => hasLanguageScript(text, code) })

const box = (description, x, y = 0, width = 100, height = 20, extra = {}) => ({
  description,
  boundingPoly: {
    vertices: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height }
    ]
  },
  ...extra
})

// --- 1. the line filter ---------------------------------------------------------------------

const SAMPLES = ['猫が好きです', 'Options', 'Options 設定', 'Save データ', '안녕하세요', 'Привет, мир', 'Hello there', '123 !!', '', '「はい」']

test('with Japanese, given or not, the filter drops exactly what it always did', () => {
  for (const mode of ['off', 'noJapanese', 'mostlyNonJapanese'])
    for (const text of SAMPLES) {
      const before = dropsText(text, japaneseFilterOf({ japaneseFilter: mode }))
      assert.equal(dropsText(text, japaneseFilterOf({ japaneseFilter: mode }, 'ja')), before, `${mode}: ${text}`)
      assert.equal(mostlyNonJapanese(text, 'ja'), mostlyNonJapanese(text), text)
    }
  // The filter object is as it was when no language is given.
  assert.deepEqual(japaneseFilterOf(null), { japaneseFilter: 'noJapanese' })
  assert.deepEqual(japaneseFilterOf(null, 'ko'), { japaneseFilter: 'noJapanese', language: 'ko' })
})

test('Korean keeps Hangul, and drops lines without it', () => {
  const plain = japaneseFilterOf({}, 'ko')
  const strict = japaneseFilterOf({ japaneseFilter: 'mostlyNonJapanese' }, 'ko')
  assert.equal(dropsText('안녕하세요', plain), false)
  assert.equal(dropsText('漢字', plain), true)
  assert.equal(dropsText('漢字 한자', plain), false)
  assert.equal(dropsText('Options', plain), true)
  assert.equal(dropsText('猫が好きです', plain), true, 'Japanese is not Korean')
  assert.equal(dropsText('こんにちは', plain), true, 'kana are not Korean')
  assert.equal(dropsText('Options 설정', plain), false)
  assert.equal(dropsText('Options 설정', strict), true)
  assert.equal(dropsText('저장하기 OK', strict), false)
})

test('English keeps letters, and drops lines without any', () => {
  const plain = japaneseFilterOf({}, 'en')
  const strict = japaneseFilterOf({ japaneseFilter: 'mostlyNonJapanese' }, 'en')
  assert.equal(dropsText('Hello there', plain), false)
  assert.equal(dropsText('123 !!', plain), true)
  assert.equal(dropsText('こんにちは', plain), true)
  assert.equal(dropsText('Level 10', strict), false)
  assert.equal(dropsText('HP 100/100', strict), true)
  // An accent typed as a combining mark belongs to its letter.
  assert.equal(mostlyNonJapanese('été', 'fr'), false)
})

test('Russian keeps Cyrillic, and drops Latin-only lines', () => {
  const plain = japaneseFilterOf({}, 'ru')
  const strict = japaneseFilterOf({ japaneseFilter: 'mostlyNonJapanese' }, 'ru')
  assert.equal(dropsText('Привет, мир', plain), false)
  assert.equal(dropsText('Hello', plain), true)
  assert.equal(dropsText('Да Options', strict), true)
  assert.equal(dropsText('Сохранить игру OK', strict), false)
})

test('the overlay drops the same lines in the language, and skips the furigana filter without ruby', () => {
  const annotations = [
    { ...box('all', 0), granularity: 'aggregate' },
    box('Hello there', 0, 0, 200, 40),
    box('Привет', 300, 0, 200, 40),
    box('on', 600, 0, 40, 20)
  ]
  const grouping = { enabled: false, proximityThreshold: 100, filterSmallText: true, filterSmallTextThreshold: 0.75 }
  const shown = (language) =>
    visibleAnnotations(annotations, { ...grouping, ...japaneseFilterOf({}, language) }).map((a) => a.description)
  assert.deepEqual(shown('en'), ['Hello there', 'on'], 'a short word is not furigana in English')
  assert.deepEqual(shown('ru'), ['Привет'])
  // In Japanese the small word goes (furigana), and then the Latin lines with it.
  assert.deepEqual(shown('ja'), [])
  assert.deepEqual(
    visibleAnnotations(annotations, { ...grouping, ...japaneseFilterOf({ japaneseFilter: 'off' }, 'ja') }).map((a) => a.description),
    visibleAnnotations(annotations, { ...grouping, ...japaneseFilterOf({ japaneseFilter: 'off' }) }).map((a) => a.description)
  )
})

// --- 2. the other script gates ----------------------------------------------------------------

test('Read along steps through boxes in the language: Korean, English and Russian', () => {
  const units = [{ text: '안녕하세요' }, { text: 'Hello' }, { text: 'Привет' }, { text: '猫' }, { text: '123' }]
  const kept = (words) => readingUnits(units, false, words).map((u) => u.text)
  assert.deepEqual(kept(wordsOf('ko')), ['안녕하세요'])
  assert.deepEqual(kept(wordsOf('en')), ['Hello'])
  assert.deepEqual(kept(wordsOf('ru')), ['Привет'])
  assert.deepEqual(kept(), ['猫'], 'Japanese, as before')
  assert.deepEqual(kept(JAPANESE_WORDS), ['猫'])
})

test('a parse that matched nothing falls back to the segmenter for text in the language', async () => {
  const parse = async () => [{ source: 'scanning-parser', content: [] }]
  const english = await segmentText('the cat', parse, wordsOf('en'))
  assert.deepEqual(english.filter((t) => t.word).map((t) => t.text), ['the', 'cat'])
  // Japanese keeps the empty parse for text with no Japanese in it.
  assert.deepEqual(await segmentText('the cat', parse), [])
})

test('Auto OCR publishes text in the language, and judges decoration by it', () => {
  assert.equal(inLanguage('Hello', 'en'), true)
  assert.equal(inLanguage('Hello'), false)
  assert.equal(inLanguage('안녕', 'ko'), true)
  assert.equal(inLanguage('Привет', 'ru'), true)
  assert.equal(inLanguage('Привет', 'en'), false)
  assert.equal(decorationOnly('Hello', 'Hello!', 'en'), true)
  assert.equal(decorationOnly('Hell', 'Hello', 'en'), false, 'a late letter is content')
  assert.equal(decorationOnly('Hell', 'Hello'), true, 'not to Japanese')
  assert.equal(decorationOnly('はい', 'はい▼'), true)
  assert.equal(decorationOnly('はい', 'はい▼', 'ja'), true)

  const line = (text, y, x = 90) => ({ text, box: { x, y, width: text.length * 20, height: 36 } })
  const reading = (lines, language) =>
    normalizeOcrResult(
      {
        fullText: lines.map((l) => l.text).join('\n'),
        textAnnotations: [
          box('', 0),
          ...lines.map(({ text, box: b }) => box(text, b.x, b.y, b.width, b.height))
        ]
      },
      'livetext',
      language
    )
  const publishes = (language, lines) => {
    const scene = new SceneMemory(language ? { language } : {})
    scene.observe(lines, 0)
    scene.observe(lines, 250)
    scene.apply(reading(lines, language), scene.snapshot(250), 300)
    return scene.takePublishable(300).map((p) => p.result.fullText)
  }
  const english = [line('How are you today?', 396), line('Fine, thanks.', 436)]
  assert.deepEqual(publishes('en', english), ['How are you today?\nFine, thanks.'])
  assert.deepEqual(publishes(null, english), [], 'Japanese publishes no English')
  assert.deepEqual(publishes('ru', [line('Как дела?', 396)]), ['Как дела?'])
  assert.deepEqual(publishes('ko', [line('잘 지내요', 396)]), ['잘 지내요'])
  assert.deepEqual(publishes('ja', [line('今日はいい天気', 396)]), publishes(null, [line('今日はいい天気', 396)]))
})

// --- 4. joins -------------------------------------------------------------------------------

test('words OCR boxed apart are joined with a space in a spaced language, and as before in Japanese', () => {
  const words = [box('The', 0, 0, 60), box('quick', 70, 0, 90), box('brown', 170, 0, 90), box('fox', 0, 30, 60)]
  const text = (language) => logicalGroups(words, language).groups.map((g) => g.text)
  assert.deepEqual(text('en'), ['The quick brown\nfox'])
  assert.deepEqual(text('ru'), ['The quick brown\nfox'])
  assert.deepEqual(text('ja'), text(undefined))
  assert.deepEqual(text(undefined), ['Thequickbrown\nfox'])
  // Text that already has its space gets no second one.
  assert.deepEqual(logicalGroups([box('The ', 0, 0, 60), box('end', 70, 0, 60)], 'en').groups[0].text, 'The end')
  // Line-level boxes keep the spaces the engine put in them.
  assert.deepEqual(logicalGroups([box('잘 지내요', 0, 0, 200)], 'ko').groups[0].text, '잘 지내요')
  assert.equal(joiner('猫', '犬', 'ja'), '')
  assert.equal(joiner('猫', '犬', 'zh-Hans'), '')
  assert.equal(joiner('a', 'b', 'en'), ' ')
})

test('the published text and the grouped cards space words too', () => {
  const words = [box('aggregate', 0), box('Hello', 0, 0, 80), box('there', 90, 0, 80), box('friend', 0, 40, 100)]
  assert.equal(buildFilteredText(words, false, 0.75, 'en'), 'Hello there\nfriend')
  assert.equal(buildFilteredText(words, false, 0.75, 'ja'), buildFilteredText(words, false, 0.75))
  assert.equal(buildFilteredText(words, false, 0.75), 'Hellothere\nfriend')
  const cards = (language) => groupTextAnnotations(words.slice(1), 100, language).map((g) => g.text)
  assert.deepEqual(cards('en'), ['Hello there\nfriend'])
  assert.deepEqual(cards('ja'), cards(undefined))
})

test('the lookahead spaces the next boxes apart, and a selection running into it crosses the space', () => {
  const boxes = [{ text: 'can' }, { text: 'not' }, { text: 'be' }]
  const next = [1, 2, -1]
  assert.deepEqual(lookaheadTexts(boxes, next, 10, 'en'), [' not be', ' be', ''])
  assert.deepEqual(lookaheadTexts(boxes, next, 10), ['notbe', 'be', ''])
  assert.deepEqual(lookaheadTexts(boxes, next, 10, 'ja'), lookaheadTexts(boxes, next, 10))
  const chain = boxes.map((b, i) => ({ text: b.text, next: next[i] }))
  assert.deepEqual(selectionExtension('can not', 0, chain, true), { extension: ' not', consumed: [1] })
  assert.deepEqual(selectionExtension('cannot', 0, chain), { extension: 'not', consumed: [1] })
})

test("a spaced language's boxes do not run into each other when Read along splits them", async () => {
  const words = wordsOf('en')
  const split = async (text) => tokensFromSegmenter(text, Intl.Segmenter, words)
  const units = [{ text: 'can' }, { text: 'not' }]
  const segmented = await segmentAcross(units, split, words)
  assert.deepEqual(segmented.map((u) => u.tokens.filter((t) => t.word).map((t) => t.text)), [['can'], ['not']])
  // A dictionary match running across the space (an expression) covers the next box's first word.
  const expression = async (text) =>
    text.startsWith('can not') ? [{ start: 0, end: 7, text: 'can not', word: true }] : split(text)
  const covered = await segmentAcross(units, expression, words)
  assert.deepEqual(covered[1].tokens.map((t) => t.word), [false])
})

test('a hooked line broken over rows keeps a space at each break in a spaced language', () => {
  const groups = [
    {
      id: 'g',
      text: 'Hello there,\nhow are you?',
      bbox: [0, 0, 300, 60],
      orientation: 'horizontal',
      linePolygons: [
        [[0, 0], [300, 0], [300, 30], [0, 30]],
        [[0, 30], [300, 30], [300, 60], [0, 60]]
      ]
    }
  ]
  const hooked = 'Hello there,\nhow are you?'
  const spaced = placeHookedLine(groups, hooked, true)
  assert.equal(spaced.groups.find((g) => g.id === spaced.matched).text, 'Hello there, how are you?')
  const japanese = placeHookedLine(groups, hooked)
  assert.equal(japanese.groups.find((g) => g.id === japanese.matched).text, 'Hello there,how are you?')
  const ocr = ['one two', 'three four', 'five']
  assert.deepEqual(splitAcrossLines('one\ntwo three four five', ocr, true), ['one two', 'three four', 'five'])
  // Japanese as ever: the break is nothing, and the space before a line starts it.
  assert.deepEqual(splitAcrossLines('one\ntwo three four five', ocr), ['onetwo', ' three four', ' five'])
  assert.deepEqual(splitAcrossLines('ああ、いい。うう', ['ああ', 'いいうう'], false), ['ああ、', 'いい。うう'])
})

// --- 5. vertical text ------------------------------------------------------------------------

test('a column of short items is vertical only in a language set vertically', () => {
  const column = [box('A', 0, 0, 20, 20), box('B', 0, 30, 20, 20), box('C', 0, 60, 20, 20)]
  const orientations = (language) => inferOrientations(column, language).map((a) => a.orientation)
  assert.deepEqual(orientations(undefined), ['vertical', 'vertical', 'vertical'])
  assert.deepEqual(orientations('ja'), orientations(undefined))
  assert.deepEqual(orientations('zh-Hant'), orientations(undefined))
  assert.deepEqual(orientations('en'), ['horizontal', 'horizontal', 'horizontal'])
  assert.deepEqual(orientations('ko'), ['horizontal', 'horizontal', 'horizontal'])
  // A tall word box, and an engine's tall block, too.
  assert.equal(inferOrientations([box('ab', 0, 0, 20, 60)], 'ru')[0].orientation, 'horizontal')
  assert.equal(inferOrientations([box('ab', 0, 0, 20, 60)])[0].orientation, 'vertical')
  // The engine's word is final either way.
  assert.equal(inferOrientations([box('ab', 0, 0, 20, 60, { orientation: 'vertical' })], 'en')[0].orientation, 'vertical')
  const tall = { groups: [{ id: 'b', text: 'Menu', bbox: [0, 0, 20, 100] }], textAnnotations: [] }
  assert.equal(normalizeOcrResult(tall, 'cloud', 'en').groups[0].orientation, 'horizontal')
  assert.equal(normalizeOcrResult(tall, 'cloud').groups[0].orientation, 'vertical')
})

// --- 6. word boundaries -----------------------------------------------------------------------

test('the Yomitan API scan starts at the hovered word and reads whole words', () => {
  const { wordStartIn, wholeWords, wordStarts } = scanText
  assert.equal(wordStartIn('reading', 3), 0, 'the d of reading')
  assert.equal(wordStartIn('the reading', 6), 4)
  assert.equal(wordStartIn("don't stop", 4), 0)
  assert.equal(wordStartIn('the reading', 3), 3, 'a space is no word')
  assert.equal(wordStartIn('чтение книг', 4), 0)
  assert.equal(wordStartIn('책을 읽다', 1), 0)
  assert.equal(wholeWords('the quick brown', 12), 'the quick')
  assert.equal(wholeWords('the quick', 12), 'the quick')
  assert.equal(wholeWords('Donaudampfschifffahrt', 8), 'Donaudam', 'one word longer than the window')
  assert.equal(wholeWords('the quick brown', 10), 'the quick')
  assert.deepEqual(wordStarts('the quick, brown'), [4, 11])
})

test('the platform segmenter splits in the language, and merges okurigana only in Japanese', () => {
  const words = (text, language) =>
    tokensFromSegmenter(text, Intl.Segmenter, language).filter((t) => t.word).map((t) => t.text)
  assert.deepEqual(words('The quick brown fox', wordsOf('en')), ['The', 'quick', 'brown', 'fox'])
  assert.deepEqual(words('Быстрая лиса', wordsOf('ru')), ['Быстрая', 'лиса'])
  assert.deepEqual(words('책을 읽어요', wordsOf('ko')), ['책을', '읽어요'])
  // Chinese is not one Han run per "word".
  assert.ok(words('我喜欢吃苹果', wordsOf('zh-Hans', false)).length > 1)
  assert.deepEqual(words('作った'), ['作った'])
  assert.deepEqual(words('作った', JAPANESE_WORDS), ['作った'])
})

test('GNOME gives a spaced language one cell per word, and Japanese one per character', () => {
  const rect = { x: 0, y: 0, width: 220, height: 20 }
  const cells = gnomeWordCells('the reading', rect, false, (t) => [...t].length, true)
  assert.deepEqual(cells.map((c) => [c.offset, c.text]), [[0, 'the reading'], [3, ' reading'], [4, 'reading']])
  const reading = cells[2]
  const characters = gnomeWordCells('the reading', rect)
  assert.equal(characters.length, 11)
  assert.equal(reading.x, characters[4].x)
  assert.equal(Math.round(reading.x + reading.width), Math.round(characters[10].x + characters[10].width))
  assert.deepEqual(gnomeWordCells('今日は', rect), gnomeWordCells('今日は', rect, false, undefined, false))
})
