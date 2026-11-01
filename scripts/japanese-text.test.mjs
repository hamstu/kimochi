/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
/**
 * "Japanese only", one rule for the Log and the overlay (ui/japanese-text.ts): drop text with no
 * Japanese, and, in the stricter mode, text whose first or last letter is Roman.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { latinAtEdge, dropsText, japaneseFilterOf } = await load('japanese-text.ts')
const { visibleAnnotations } = await load('annotations.ts')

test('a Roman letter at either end marks the line', () => {
  assert.equal(latinAtEdge('Save データ'), true)
  assert.equal(latinAtEdge('もう一度Start'), true)
  assert.equal(latinAtEdge('HPが減った'), true)
  // Full-width Roman letters are Roman.
  assert.equal(latinAtEdge('ＨＰが減った'), true)
})

test('punctuation, brackets, digits and spaces at the ends are looked past', () => {
  assert.equal(latinAtEdge('「はい」'), false)
  assert.equal(latinAtEdge('  …猫が好きです。123 '), false)
  assert.equal(latinAtEdge('(Start) を押す'), true)
  assert.equal(latinAtEdge('5 Lv'), true)
})

test('Japanese at both ends, with Roman letters inside, is kept', () => {
  assert.equal(latinAtEdge('猫が好きです'), false)
  assert.equal(latinAtEdge('今日はGameをする日'), false)
  // No letters at all: nothing to judge.
  assert.equal(latinAtEdge('123 !?'), false)
  assert.equal(latinAtEdge(''), false)
})

test('the filter comes from the Log settings, and the stricter mode needs Japanese only', () => {
  assert.deepEqual(japaneseFilterOf(null), { japaneseOnly: false, latinEdges: false })
  const plain = japaneseFilterOf({ cjkOnly: true })
  const strict = japaneseFilterOf({ cjkOnly: true, cjkOnlyLatinEdges: true })
  const edgesAlone = japaneseFilterOf({ cjkOnly: false, cjkOnlyLatinEdges: true })
  assert.equal(dropsText('Options', plain), true)
  assert.equal(dropsText('Save データ', plain), false)
  assert.equal(dropsText('Save データ', strict), true)
  assert.equal(dropsText('猫が好きです', strict), false)
  assert.equal(dropsText('Options', edgesAlone), false)
})

const box = (description, x, granularity = 'line') => ({
  description,
  granularity,
  boundingPoly: { vertices: [{ x, y: 0 }, { x: x + 100, y: 0 }, { x: x + 100, y: 20 }, { x, y: 20 }] }
})

test('the overlay drops the same lines, and leaves word fragments alone', () => {
  const aggregate = { ...box('all', 0), granularity: 'aggregate' }
  const annotations = [aggregate, box('猫が好きです', 0), box('Options', 200), box('Save データ', 400), box('Start', 600, 'fragment')]
  const grouping = { enabled: false, proximityThreshold: 100, filterSmallText: false, filterSmallTextThreshold: 0.75 }
  const shown = (filter) => visibleAnnotations(annotations, { ...grouping, ...filter }).map((a) => a.description)
  assert.deepEqual(shown({}), ['猫が好きです', 'Options', 'Save データ', 'Start'])
  assert.deepEqual(shown(japaneseFilterOf({ cjkOnly: true })), ['猫が好きです', 'Save データ', 'Start'])
  assert.deepEqual(shown(japaneseFilterOf({ cjkOnly: true, cjkOnlyLatinEdges: true })), ['猫が好きです', 'Start'])
})
