import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'
import { installFakeDom, draw } from './overlay-cases.mjs'

installFakeDom()

const { hookAnnotations, annotationGroups } = await load('hook-match.ts')
const { mapAnnotations } = await load('geometry.ts')
const rendererModules = await load('render.js')
const { wordLayout } = rendererModules
const { remapHookSegments, hookGeometryAnnotations } = await load('hook-anchors.ts')
const polygon = ([x0, y0, x1, y1]) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1]
]
const segment = (text, x, y = 100) => ({ text, bbox: [x, y, x + [...text].length * 24, y + 24] })
const words = [segment('今日は', 100), segment('晴れ。', 172), segment('明日は', 256), segment('雨です。', 328)]
const text = '今日は晴れ。明日は雨です。'
const annotation = (pieces = words) => ({
  description: pieces.map((word) => word.text).join(''),
  groupId: 'dialogue',
  granularity: 'block',
  orientation: 'horizontal',
  boundingPoly: { vertices: polygon([100, 100, 424, 124]).map(([x, y]) => ({ x, y })) },
  linePolygons: [polygon([100, 100, 424, 124])],
  lineTexts: [pieces.map((word) => word.text).join('')],
  lineSegments: [pieces]
})

test('hook matching preserves word boxes, including a half-character gap after a sentence', () => {
  const placed = hookAnnotations([annotation()], text, { speakers: false })
  assert.deepEqual(placed.annotations[0].lineSegments, [words])
})

test('correcting OCR text changes the word text while keeping its measured box', () => {
  const incorrect = words.map((word) => ({ ...word, text: word.text.replace('晴', '睛') }))
  const placed = hookAnnotations([annotation(incorrect)], text, { speakers: false })
  assert.deepEqual(placed.annotations[0].lineSegments, [words])
  assert.equal(incorrect[1].text, '睛れ。', 'the original OCR result is not mutated')
})

test('fragmented OCR keeps word and character boxes when assembled into rows', () => {
  const pieces = words.map((word) => ({
    description: word.text,
    groupId: 'dialogue',
    granularity: 'fragment',
    boundingPoly: { vertices: polygon(word.bbox).map(([x, y]) => ({ x, y })) }
  }))
  assert.deepEqual(annotationGroups(pieces)[0].lineSegments, [words])
})

const bounds = { x: 0, y: 0, width: 1000, height: 600 }
const info = { full_width: 1000, full_height: 600, crop_pixels: [0, 0], source_bounds: bounds }

test('the real renderer fits each hooked word to its own measured box, rather than redistributing a row', () => {
  const placed = hookAnnotations([annotation()], text, { speakers: false })
  const annotations = hookGeometryAnnotations(placed.annotations, placed.names)
  const mapped = mapAnnotations(info, annotations, bounds, bounds)
  const runs = wordLayout(mapped, (text) => [...text].length)[0]
  assert.deepEqual(
    runs.map((run) => run.text),
    words.map((word) => word.text)
  )
  assert.deepEqual(
    runs.map((run) => run.rect.x),
    [100, 172, 256, 328]
  )
  assert.equal(runs[2].rect.x - (runs[1].rect.x + runs[1].rect.width), 12)
  assert.equal(runs.map((run) => run.text).join(''), text)
  for (const scale of [0.75, 1.5, 2]) {
    const scaledBounds = { x: 40, y: 25, width: 1000 * scale, height: 600 * scale }
    const scaled = wordLayout(mapAnnotations(info, annotations, bounds, scaledBounds), (value) => [...value].length)[0]
    assert.deepEqual(
      scaled.map((run) => run.rect.x),
      [100, 172, 256, 328].map((x) => 40 + x * scale)
    )
  }
})

test('a substring of an OCR paragraph keeps only its own word geometry and indentation', () => {
  const first = [segment('過去の台詞です。', 80, 50)]
  const second = words
  const all = annotation()
  all.description = first[0].text + '\n' + text
  all.lineTexts = [first[0].text, text]
  all.linePolygons = [polygon([80, 50, 272, 74]), polygon([100, 100, 424, 124])]
  all.lineSegments = [first, second]
  all.boundingPoly = { vertices: polygon([80, 50, 424, 124]).map(([x, y]) => ({ x, y })) }
  const placed = hookAnnotations([all], text, { speakers: false })
  assert.deepEqual(placed.annotations[0].lineSegments, [second])
})

test('edits and missing characters preserve exact hooked text without moving later word anchors', () => {
  for (const [ocr, hooked] of [
    ['今日は晴れ。', '今日は睛れ。'],
    ['猫いる', '猫がいる'],
    ['猫ががいる', '猫がいる'],
    ['Ａ１２は猫。', 'A12は猫。'],
    ['𠮷野の猫', '𠮷野の犬']
  ]) {
    const parts = Array.from(ocr, (character, index) => segment(character, 100 + index * 24))
    const corrected = remapHookSegments(hooked, parts)
    assert.equal(corrected.map((part) => part.text).join(''), hooked)
    assert.deepEqual(corrected.at(-1).bbox, parts.at(-1).bbox)
  }
})

test('line-only OCR retains the hooked text on the measured row as a fallback', () => {
  const row = annotation()
  delete row.lineSegments
  const placed = hookAnnotations([row], text, { speakers: false })
  const mapped = mapAnnotations(info, hookGeometryAnnotations(placed.annotations, []), bounds, bounds)
  const runs = wordLayout(mapped, (value) => [...value].length)[0]
  assert.equal(runs.length, 1)
  assert.equal(runs[0].text, text)
  assert.equal(runs[0].rect.x, 100)
  assert.deepEqual(remapHookSegments(text, []), [])
})

test('a failed match produces no anchored dialogue, while a separate speaker is retained', () => {
  const placed = hookAnnotations([annotation()], '全く違う台詞が来ました。', { speakers: false })
  assert.deepEqual(hookGeometryAnnotations(placed.annotations, []), [])
  const name = { ...annotation([segment('桜', 100, 50)]), description: '桜' }
  const matched = hookAnnotations([annotation()], text, { speakers: false })
  const withName = hookGeometryAnnotations(matched.annotations, [name])
  assert.equal(withName[0].granularity, 'aggregate')
  assert.equal(withName[1].anchorSegments, true)
  assert.equal(withName[2].description, '桜')
})

test('anchored words share one inline DOM text flow for lookups and full sentence context', () => {
  const placed = hookAnnotations([annotation()], text, { speakers: false })
  const { host, renderer } = draw(rendererModules, { annotations: hookGeometryAnnotations(placed.annotations, []) })
  const content = (node) =>
    node.className === 'ocr-lookahead'
      ? ''
      : node.children.length
        ? node.children.map(content).join('')
        : node.textContent
  assert.equal(content(host.children[0]), text)
  assert.equal(renderer.words[0].runs.length, 4)
  renderer.destroy()
})

test('vertical hooked words retain their individual positions down the column', () => {
  const vertical = annotation()
  vertical.orientation = 'vertical'
  vertical.description = '今日は晴れ。'
  vertical.lineTexts = [vertical.description]
  vertical.linePolygons = [polygon([100, 100, 124, 256])]
  vertical.lineSegments = [
    [
      { text: '今日は', bbox: [100, 100, 124, 172] },
      { text: '晴れ。', bbox: [100, 184, 124, 256] }
    ]
  ]
  vertical.boundingPoly = { vertices: polygon([100, 100, 124, 256]).map(([x, y]) => ({ x, y })) }
  const placed = hookAnnotations([vertical], vertical.description, { speakers: false })
  const runs = wordLayout(
    mapAnnotations(info, hookGeometryAnnotations(placed.annotations, []), bounds),
    (value) => [...value].length
  )[0]
  assert.deepEqual(
    runs.map((run) => run.rect.y),
    [100, 184]
  )
  assert.ok(runs.every((run) => run.vertical))
})

test('exact hooked text retains Latin replies that the OCR language filter would drop', async () => {
  const { visibleAnnotations } = await load('annotations.ts')
  const reply = { ...annotation([segment('OK!', 100)]), description: 'OK!' }
  const grouping = { enabled: false, filterSmallText: false, language: 'ja', japaneseFilter: 'no-japanese' }
  const placed = hookAnnotations([reply], 'OK!', { speakers: false })
  const anchored = hookGeometryAnnotations(placed.annotations, [])
  assert.equal(visibleAnnotations(anchored, grouping)[0]?.description, 'OK!')
  assert.equal(visibleAnnotations([reply], grouping).length, 0, 'ordinary OCR still follows the language filter')
})
