/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
/**
 * How the learner's text is set by language (ui/language-style.ts, render.js `measureFor`,
 * text-layout.js): Japanese exactly as before the language setting existed (its font stacks, `lang`,
 * one em per code point, character line breaking), Chinese and Korean in their own CJK fonts,
 * English measured per letter and broken between words, and every script but CJK divided into
 * grapheme clusters so a combining mark stays with its letter.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load } from './load.mjs'
import { distribute, estimate, layoutParts, characterCells, fit, chars } from '../ui/text-layout.js'

const { textStyle, textLang, textFont, textUnits, wordPieces, graphemes, JAPANESE_TEXT_FONT } = await load(
  'language-style.ts'
)
const { measureFor, measureEms, GROUP_FONT, MANGA_FONT } = await load('render.js')
const { sampleFor, SAMPLE_LANGUAGES } = await load('language-samples.ts')

const css = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const oneLine = (text) => text.replace(/\s+/g, ' ')

test('Japanese keeps its lang, its font stack and its measure exactly', async () => {
  assert.equal(textLang('ja'), 'ja')
  assert.equal(textLang(undefined), 'ja')
  assert.equal(textFont('ja'), GROUP_FONT)
  assert.equal(JAPANESE_TEXT_FONT, GROUP_FONT)
  assert.equal(
    GROUP_FONT,
    "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', 'Noto Sans CJK JP', 'Yu Gothic', 'Meiryo', sans-serif"
  )
  assert.equal(MANGA_FONT, `'Zen Kaku Gothic Antique', ${GROUP_FONT}`)
  // The same measure object, with no language's way of setting text on it.
  assert.equal(measureFor('default', 'ja'), measureEms)
  assert.equal(measureFor('default', undefined), measureEms)
  assert.equal(measureEms.style, undefined)
  assert.equal(measureEms('あいう'), 3)
  assert.equal(measureEms('abc'), 0.56 * 3)
  // The CSS draws Japanese in the same stack when nothing overrides it.
  const fallback = oneLine(`var(--kimochi-text-font, ${GROUP_FONT})`)
  for (const file of ['ui/overlay-text.css', 'ui/hook-card.css'])
    assert.ok(oneLine(await css(file)).includes(fallback), file)
  assert.match(await css('frontend/kit/tokens.css'), /--k-font-text: var\(--kimochi-text-font, var\(--k-font-jp\)\);/)
})

test('Chinese and Korean get their own CJK fonts first, so Han takes their forms', () => {
  assert.match(textFont('zh-Hans'), /^'PingFang SC', .*'Microsoft YaHei'.*'Noto Sans CJK SC'/)
  assert.match(textFont('zh-Hant'), /^'PingFang TC', .*'Microsoft JhengHei'.*'Noto Sans CJK TC'/)
  assert.match(textFont('yue'), /^'PingFang HK'/)
  assert.match(textFont('ko'), /^'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans CJK KR'/)
  for (const code of ['zh-Hans', 'zh-Hant', 'ko', 'en', 'ru', 'el', 'th', 'hi']) {
    assert.doesNotMatch(textFont(code), /Hiragino Sans'|Noto Sans JP/, code)
    assert.match(textFont(code), /sans-serif$/, code)
  }
  assert.equal(textLang('zh-Hans'), 'zh-Hans')
  assert.equal(textLang('ko'), 'ko')
  assert.ok(textStyle('ko').fullWidth && textStyle('zh-Hant').fullWidth)
  // Latin, Cyrillic and Greek in the system UI faces, not a Japanese font's full-width forms.
  assert.match(textFont('ru'), /^-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans'/)
  assert.match(textFont('th'), /^'Thonburi', 'Leelawadee UI', 'Noto Sans Thai'/)
  assert.ok(textStyle('th').shaped && textStyle('hi').shaped && !textStyle('en').shaped)
})

test('Japanese layout through its measure is what it was without one', () => {
  const text = 'この先の森には、古い神社があると聞きました。'
  const rect = { x: 10, y: 20, width: 200, height: 70 }
  assert.deepEqual(estimate(text, rect, false, measureEms), estimate(text, rect, false))
  const lines = [
    { x: 0, y: 0, width: 160, height: 20 },
    { x: 0, y: 30, width: 90, height: 20 }
  ]
  assert.deepEqual(distribute(text, lines, false, measureEms), distribute(text, lines, false))
  const parts = [{ text, rect, block: true }]
  assert.deepEqual(layoutParts(parts, measureEms), layoutParts(parts, (t) => measureEms(t)))
  assert.deepEqual(layoutParts(parts, measureEms).flat().map((run) => run.text), estimate(text, rect, false).map((run) => run.text))
  // Code points, even where a mark would join a cluster.
  assert.deepEqual(textUnits('か\u3099', 'ja'), ['か', '\u3099'])
})

test('English is measured per letter, a space narrower, not an em a character', () => {
  const en = measureFor('default', 'en')
  assert.equal(en.language, 'en')
  assert.ok(en.style && !en.style.fullWidth && en.style.spaces)
  const village = en('village')
  assert.ok(village > 2.5 && village < 4.5, `village: ${village} ems`)
  assert.ok(en(' ') < en('a'))
  assert.ok(en('m') > en('i'))
  // Its no-canvas estimate never takes a Latin letter as wide as a kanji.
  assert.ok(en('They say') < measureEms('They say') * 1.05)
  // Russian is not drawn full-width.
  assert.ok(measureFor('default', 'ru')('деревня') < 5)
})

test('English text is shared over lines at word boundaries, never mid-word', () => {
  const en = measureFor('default', 'en')
  const text = 'They say there is an old village on the other side of the river.'
  const lines = [
    { x: 0, y: 0, width: 260, height: 22 },
    { x: 0, y: 30, width: 150, height: 22 },
    { x: 0, y: 60, width: 60, height: 22 }
  ]
  const runs = distribute(text, lines, false, en)
  assert.equal(runs.map((run) => run.text).join(''), text)
  for (const run of runs.slice(0, -1)) assert.match(run.text, /\s$/u, `"${run.text}" ends between words`)
  const words = text.split(' ')
  for (const run of runs) for (const word of run.text.trim().split(' ')) assert.ok(words.includes(word), word)
  // The longest line takes the most words.
  assert.ok(runs[0].text.length > runs[1].text.length && runs[1].text.length > runs[2].text.length)

  // With no lines found, the estimate breaks between words too, each line as long as its words.
  const estimated = estimate(text, { x: 0, y: 0, width: 220, height: 90 }, false, en)
  assert.ok(estimated.length >= 2)
  assert.equal(estimated.map((run) => run.text).join(''), text)
  for (const run of estimated.slice(0, -1)) assert.match(run.text, /\s$/u)
  for (const run of estimated) assert.ok(run.rect.width <= 220 + 1e-6)

  // Japanese still shares characters (森 never waits for a space).
  const ja = distribute('この先の森には古い神社がある', lines.slice(0, 2), false)
  assert.equal(ja.map((run) => run.text).join(''), 'この先の森には古い神社がある')
})

test('English letters keep near their own spacing; the leftover goes between words', () => {
  const en = measureFor('default', 'en')
  const run = { text: 'an old village', rect: { x: 0, y: 0, width: 400, height: 24 } }
  const fitted = fit(run, false, en)
  assert.ok(Math.abs(fitted.spacing) <= 0.06 * fitted.fontSize + 1e-9, `spacing ${fitted.spacing}`)
  assert.ok(fitted.wordSpacing > 0)
  // Japanese is spread to its box, as always.
  const ja = fit({ text: 'あいう', rect: { x: 0, y: 0, width: 400, height: 24 } }, false, measureEms)
  assert.ok(ja.spacing > fitted.spacing && ja.wordSpacing === undefined)
})

test('Thai and Devanagari are never letter-spaced or moved glyph by glyph', () => {
  for (const code of ['th', 'hi']) {
    const measure = measureFor('default', code)
    const text = code === 'th' ? 'หมู่บ้านเก่าแก่' : 'पुराना गाँव'
    const segments = [{ text: text.slice(0, 3), x: 0, y: 0, width: 30, height: 24, at: 0 }]
    const fitted = fit({ text, rect: { x: 0, y: 0, width: 400, height: 24 }, segments }, false, measure)
    assert.equal(fitted.spacing, 0, code)
    assert.equal(fitted.offsets, undefined, code)
  }
})

test('Every script but CJK is split by grapheme cluster: a mark stays with its letter', () => {
  // Thai: ภู is ภ with a vowel sign below; เขา is three clusters.
  assert.deepEqual(textUnits('ภูเขา', 'th'), ['ภู', 'เ', 'ข', 'า'])
  assert.equal(chars('ภูเขา').length, 5)
  // é written as e and a combining acute is one character.
  const decomposed = 'cafe\u0301'
  assert.deepEqual(textUnits(decomposed, 'fr'), ['c', 'a', 'f', 'e\u0301'])
  assert.deepEqual(graphemes('ne\u0302\u0301'), ['n', 'e\u0302\u0301'])
  // Devanagari: गाँव is ग + ा + ँ, then व.
  assert.deepEqual(textUnits('गाँव', 'hi'), ['गाँ', 'व'])

  // The layout counts and places clusters: both code units of é share one cell.
  const fr = measureFor('default', 'fr')
  const runs = layoutParts([{ text: decomposed, rect: { x: 0, y: 0, width: 60, height: 20 } }], fr)[0]
  const cells = characterCells(decomposed, runs, false, fr)
  assert.equal(cells.length, decomposed.length)
  assert.equal(cells[3], cells[4])
  assert.notEqual(cells[2], cells[3])
})

test('word pieces: at spaces, or by the segmenter where a script has none', () => {
  assert.deepEqual(wordPieces('an old  village', 'en'), ['an ', 'old  ', 'village'])
  const thai = wordPieces('มีหมู่บ้านเก่าแก่', 'th')
  assert.equal(thai.join(''), 'มีหมู่บ้านเก่าแก่')
  assert.ok(thai.length >= 2)
})

test('sample sentences: Japanese keeps its preview, each sample previews its own words', () => {
  const ja = sampleFor('ja')
  assert.deepEqual(ja.preview, ['今日は', 'いい', '天気', 'ですね'])
  assert.equal(ja.lit, 2)
  assert.equal(sampleFor('ka'), null)
  assert.ok(SAMPLE_LANGUAGES.length >= 19)
  for (const code of SAMPLE_LANGUAGES) {
    const sample = sampleFor(code)
    assert.ok(sample.lit >= 0 && sample.lit < sample.preview.length, code)
    if (code === 'ja') continue
    for (const word of sample.preview) assert.ok(sample.sentence.includes(word), `${code}: ${word}`)
    for (const word of sample.highlights) assert.ok(sample.sentence.includes(word), `${code}: ${word}`)
  }
})
