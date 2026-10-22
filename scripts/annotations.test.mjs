import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const {
  filterSmallTextAnnotations,
  buildFilteredText,
  groupTextAnnotations,
  visibleAnnotations,
  getBoundingBox,
  FILTER_LEVELS,
  filterLevelOf
} = await load('annotations.ts')

/** A box from its edges, in OCR pixel space, the way the endpoint reports it. */
const at = (description, x, y, width, height) => ({
  description,
  boundingPoly: {
    vertices: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height }
    ]
  }
})

test('bounding box tolerates the omitted-zero vertices the endpoint sends', () => {
  const box = getBoundingBox({ description: 'あ', boundingPoly: { vertices: [{}, { x: 30, y: 40 }] } })
  assert.deepEqual([box.minX, box.minY, box.maxX, box.maxY], [0, 0, 30, 40])
})

test('furigana, thin artifacts and crammed noise are dropped; long words survive', () => {
  // The long word is the regression the per-character median fixes: with a
  // whole-word median, a page of long words raises the bar so far that shorter
  // real words get filtered out as "crammed".
  const long = at('日本語を勉強しています', 0, 0, 440, 40) //  40 px per character
  const cat = at('猫', 0, 100, 40, 40) //  40 px per character
  const book = at('本', 60, 100, 40, 40) //  40 px per character
  const noise = at('｜｜｜｜', 200, 100, 12, 40) //   3 px per character -> noise
  const furigana = at('ほん', 60, 80, 36, 18) //  half height -> furigana

  const kept = filterSmallTextAnnotations([long, cat, book, noise, furigana], 0.75)
  assert.deepEqual(
    kept.map((a) => a.description),
    ['日本語を勉強しています', '猫', '本']
  )
})

test('a single annotation is never filtered away', () => {
  const only = [at('猫', 0, 0, 8, 8)]
  assert.deepEqual(filterSmallTextAnnotations(only, 0.75), only)
})

test('reading order adds newlines between lines and a space across wide gaps', () => {
  const full = at('一二三四', 0, 0, 240, 140)
  const one = at('一', 0, 0, 40, 40)
  const two = at('二', 50, 0, 40, 40)
  const far = at('三', 200, 0, 40, 40) // gap of 110 px > 1.5x median height
  const nextLine = at('四', 0, 100, 40, 40)

  assert.equal(buildFilteredText([full, one, two, far, nextLine], false, 0.75), '一二 三\n四')
})

test('history text is built from the filtered annotations, not the raw ones', () => {
  const full = at('猫ほん', 0, 0, 100, 60)
  const cat = at('猫', 0, 0, 40, 40)
  const other = at('本', 50, 0, 40, 40)
  const furigana = at('ほん', 100, 0, 36, 16)

  assert.equal(buildFilteredText([full, cat, other, furigana], true, 0.75), '猫本')
  assert.equal(buildFilteredText([full, cat, other, furigana], false, 0.75), '猫本ほん')
})

test('empty input and an all-filtered capture produce no text', () => {
  assert.equal(buildFilteredText([], true, 0.75), '')
  const full = at('.', 0, 0, 4, 4)
  const tiny = at('.', 0, 0, 1, 1)
  assert.equal(buildFilteredText([full, tiny, tiny], true, 10), '')
})

test('proximity clustering merges neighbours and separates distant text', () => {
  const near = at('日', 0, 0, 40, 40)
  const alsoNear = at('本', 60, 0, 40, 40) // 20 px gap
  const far = at('猫', 1000, 0, 40, 40) // 900 px gap

  const groups = groupTextAnnotations([near, alsoNear, far], 100)
  assert.equal(groups.length, 2)
  const texts = groups.map((g) => g.text).sort()
  assert.deepEqual(texts, ['日本', '猫'].sort())

  const merged = groups.find((g) => g.text === '日本')
  assert.deepEqual(
    [merged.boundingBox.minX, merged.boundingBox.maxX, merged.boundingBox.height],
    [0, 100, 40]
  )
})

test('grouped text uses a full-width space for word gaps and a newline for new lines', () => {
  const left = at('日', 0, 0, 40, 40)
  const right = at('語', 120, 0, 40, 40) // 80 px gap > 1.5 x 40 px character
  assert.equal(groupTextAnnotations([left, right], 200)[0].text, '日　語')

  const below = at('語', 0, 100, 40, 40)
  assert.equal(groupTextAnnotations([left, below], 200)[0].text, '日\n語')
})

test('tight kerning on one line stays a single run', () => {
  const a = at('日', 0, 0, 40, 40)
  const b = at('本', 42, 0, 40, 40) // 2 px gap, well under the word-boundary threshold
  assert.equal(groupTextAnnotations([a, b], 100)[0].text, '日本')
})

test('visibleAnnotations drops the full-text block and honours the filter switch', () => {
  const full = at('猫ほん', 0, 0, 100, 60)
  const cat = at('猫', 0, 0, 40, 40)
  const other = at('本', 50, 0, 40, 40)
  const furigana = at('ほん', 100, 0, 36, 16)
  const grouping = { enabled: false, proximityThreshold: 100, filterSmallTextThreshold: 0.75 }

  assert.deepEqual(
    visibleAnnotations([full, cat, other, furigana], { ...grouping, filterSmallText: true }).map(
      (a) => a.description
    ),
    ['猫', '本']
  )
  assert.deepEqual(
    visibleAnnotations([full, cat, other, furigana], { ...grouping, filterSmallText: false }).map(
      (a) => a.description
    ),
    ['猫', '本', 'ほん']
  )
})

test('the filter strengths run from gentle to strict, and a stored threshold shows on its nearest', () => {
  const thresholds = FILTER_LEVELS.map((level) => level.threshold)
  assert.deepEqual([...thresholds].sort((a, b) => a - b), thresholds, 'stronger steps remove more')
  assert.equal(FILTER_LEVELS[filterLevelOf(0.75)].label, 'Balanced', 'the default is Balanced')
  // Values the old 50–95% slider could save land on a step.
  assert.equal(filterLevelOf(0.5), 0)
  assert.equal(filterLevelOf(0.7), 2)
  assert.equal(filterLevelOf(0.87), 3)
  assert.equal(filterLevelOf(0.95), 4)
  assert.equal(filterLevelOf(2), 4)
})
