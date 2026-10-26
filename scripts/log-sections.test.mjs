/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node regression harness. */
/**
 * Read along's full-screen dictionary shows a scan as the Log does: a section per group the scan
 * is published with (`logGroups` / `scanGroups`, ui/ocr-result.ts, the same grouping
 * `publishOcrResult` writes to the history the Log reads), each section one run of text
 * (`sectionText`, ui/log-sections.js), however finely the OCR engine boxed it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { logSections, readingSections, sectionText } from '../ui/log-sections.js'

const outDir = await mkdtemp(path.join(tmpdir(), 'kimochi-log-sections-'))
const outfile = path.join(outDir, 'ocr-result.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../ui/ocr-result.ts', import.meta.url))],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { logGroups, scanGroups, normalizeOcrResult } = await import(pathToFileURL(outfile).href)
await rm(outDir, { recursive: true, force: true })

const GROUPING = { filterSmallText: true, filterSmallTextThreshold: 0.75 }

/** An OCR box: `text` at (x, y), `width` × `height` capture pixels. */
const box = (text, x, y, width, height, extra = {}) => ({
  description: text,
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

/**
 * What the overlay holds for a scan of these boxes: the engine's result as `normalizeOcrResult`
 * leaves it (the whole text first, as OCR results lead with it).
 */
const scan = (boxes) =>
  normalizeOcrResult({ engine: 'test', geometry: true, textAnnotations: [box(boxes.map((b) => b.description).join(''), 0, 0, 1, 1), ...boxes] }, 'test')

/** A horizontal line of word boxes, each 30 px a character, from x = 100. */
function wordsOnLine(words, y, x = 100) {
  return words.map((word) => {
    const at = x
    x += word.length * 30 + 2
    return box(word, at, y, word.length * 30, 30)
  })
}

test('a sentence boxed a word (a particle) at a time is one section, one run of text', () => {
  // The case that prompted this: an engine boxed each word and particle on its own, and the full
  // screen drew one fragment per line.
  const annotations = [
    ...wordsOnLine(['今日', 'は', 'いい', '天気', 'です', 'ね。'], 100),
    ...wordsOnLine(['一緒', 'に', '海', 'まで', '散歩', 'しません', 'か？'], 140)
  ]
  const result = scan(annotations)
  const groups = scanGroups(result.textAnnotations, GROUPING)
  assert.equal(groups.length, 1)
  assert.deepEqual(readingSections(groups), ['今日はいい天気ですね。一緒に海まで散歩しませんか？'])
  // The Log gets the same group, as published (`logGroups` on the engine's result).
  const published = logGroups(result, GROUPING)
  assert.deepEqual(published.map((group) => group.text), groups.map((group) => group.text))
})

test('separately detected text is separate sections, in the order the Log lists them', () => {
  const annotations = [
    ...wordsOnLine(['セリカ'], 40, 60), // a name label, apart from the box
    ...wordsOnLine(['待って', '！'], 400),
    ...wordsOnLine(['まだ', '話', 'は', '終わって', 'いない', 'よ。'], 440)
  ]
  const sections = readingSections(scanGroups(scan(annotations).textAnnotations, GROUPING))
  assert.deepEqual(sections, ['セリカ', '待って！まだ話は終わっていないよ。'])
})

test('a vertical bubble reads its columns right to left as one section', () => {
  // Two columns of character boxes, the right one first, 30 px apart.
  const column = (text, x) => [...text].map((ch, i) => box(ch, x, 100 + i * 32, 30, 30, { orientation: 'vertical' }))
  const annotations = [...column('世界を', 160), ...column('守る', 200)]
  const groups = scanGroups(scan(annotations).textAnnotations, GROUPING)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].orientation, 'vertical')
  assert.deepEqual(readingSections(groups), ['守る世界を'])
})

test("an engine's own blocks are the sections as it gave them, their line breaks taken out", () => {
  const result = normalizeOcrResult(
    {
      engine: 'googlelens',
      geometry: true,
      textAnnotations: [],
      groups: [
        { id: 'a', text: '今日は\nいい天気', bbox: [0, 0, 300, 80], orientation: 'horizontal' },
        { id: 'b', text: 'HP 100\nMP 20', bbox: [0, 200, 300, 260], orientation: 'horizontal' }
      ]
    },
    'googlelens'
  )
  assert.deepEqual(logSections(scanGroups(result.textAnnotations, GROUPING)), ['今日は\nいい天気', 'HP 100\nMP 20'])
  assert.deepEqual(readingSections(scanGroups(result.textAnnotations, GROUPING)), ['今日はいい天気', 'HP 100 MP 20'])
})

test('sections come from the groups, or the whole text when there are none, as the Log ingests them', () => {
  assert.deepEqual(logSections([{ text: 'a' }, { text: '  ' }, { text: 'b' }], 'a\nb'), ['a', 'b'])
  assert.deepEqual(logSections(null, '今日は'), ['今日は'])
  assert.deepEqual(logSections([], '  '), [])
  assert.deepEqual(logSections(undefined), [])
})

test('a section is one run: Japanese runs straight on across a break, Latin keeps a space', () => {
  assert.equal(sectionText('今日\nは\r\nいい\n\n天気'), '今日はいい天気')
  assert.equal(sectionText('Press\nStart'), 'Press Start')
  assert.equal(sectionText('レベル\n10'), 'レベル10')
  assert.equal(sectionText('ＨＰ\n100'), 'ＨＰ100')
  assert.equal(sectionText('  待って！　まだ  '), '待って！　まだ')
  assert.equal(sectionText(''), '')
  assert.deepEqual(readingSections([{ text: '\n\n' }, { text: 'は\nい' }]), ['はい'])
})
