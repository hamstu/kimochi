/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
/**
 * The Japanese filter, one rule for the Log and the overlay (ui/japanese-text.ts): off, drop text
 * with no Japanese (the default), or also drop text that is mostly not Japanese.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { mostlyNonJapanese, dropsText, japaneseFilterOf } = await load('japanese-text.ts')
const { visibleAnnotations } = await load('annotations.ts')

test('mostly not Japanese: more non-Japanese than Japanese, spaces and punctuation aside', () => {
  assert.equal(mostlyNonJapanese('Save データ'), true) // 4 letters against 3 kana
  assert.equal(mostlyNonJapanese('Lv.5 勇者'), true) // Lv5 against 勇者
  assert.equal(mostlyNonJapanese('Options 設定'), true)
  assert.equal(mostlyNonJapanese('|||#@ ~ 日'), true)
  assert.equal(mostlyNonJapanese('今日はGameをする日'), false)
  assert.equal(mostlyNonJapanese('「はい、そうです。」……!?'), false)
  assert.equal(mostlyNonJapanese('HPが減った'), false)
  assert.equal(mostlyNonJapanese(''), false)
})

test('the filter comes from the Log settings, and is on unless turned off', () => {
  assert.deepEqual(japaneseFilterOf(null), { japaneseFilter: 'noJapanese' })
  assert.deepEqual(japaneseFilterOf({ japaneseFilter: 'bogus' }), { japaneseFilter: 'noJapanese' })
  const off = japaneseFilterOf({ japaneseFilter: 'off' })
  const plain = japaneseFilterOf({})
  const strict = japaneseFilterOf({ japaneseFilter: 'mostlyNonJapanese' })
  assert.equal(dropsText('Options', off), false)
  assert.equal(dropsText('Options', plain), true)
  assert.equal(dropsText('Options 設定', plain), false)
  assert.equal(dropsText('Options 設定', strict), true)
  assert.equal(dropsText('Options', strict), true)
  assert.equal(dropsText('猫が好きです', strict), false)
  // A caller that never read the setting filters nothing.
  assert.equal(dropsText('Options', {}), false)
})

const box = (description, x, granularity = 'line') => ({
  description,
  granularity,
  boundingPoly: {
    vertices: [
      { x, y: 0 },
      { x: x + 100, y: 0 },
      { x: x + 100, y: 20 },
      { x, y: 20 }
    ]
  }
})

test('the overlay drops the same lines, and leaves word fragments alone', () => {
  const aggregate = { ...box('all', 0), granularity: 'aggregate' }
  const annotations = [
    aggregate,
    box('猫が好きです', 0),
    box('Options', 200),
    box('Options 設定', 400),
    box('Start', 600, 'fragment')
  ]
  const grouping = { enabled: false, proximityThreshold: 100, filterSmallText: false, filterSmallTextThreshold: 0.75 }
  const shown = (filter) => visibleAnnotations(annotations, { ...grouping, ...filter }).map((a) => a.description)
  assert.deepEqual(shown({}), ['猫が好きです', 'Options', 'Options 設定', 'Start'])
  assert.deepEqual(shown(japaneseFilterOf({ japaneseFilter: 'off' })), [
    '猫が好きです',
    'Options',
    'Options 設定',
    'Start'
  ])
  assert.deepEqual(shown(japaneseFilterOf({})), ['猫が好きです', 'Options 設定', 'Start'])
  assert.deepEqual(shown(japaneseFilterOf({ japaneseFilter: 'mostlyNonJapanese' })), ['猫が好きです', 'Start'])
})
