import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const {
  stabilityKey,
  identityKey,
  classify,
  commonPrefixLength,
  sameLayout,
  unionBox,
  layoutSignature,
  isEmptyText
} = await load('observation.ts')

const rel = (a, b) => classify(stabilityKey(a), stabilityKey(b))
const line = (text, x, y, width = 100, height = 20) => ({ text, box: { x, y, width, height } })

// --- normalisation ---------------------------------------------------------

test('settling ignores the punctuation a local recogniser flickers on', () => {
  assert.equal(stabilityKey('猫が好きです。'), stabilityKey('猫が好きです'))
  assert.equal(stabilityKey('「そうか」'), stabilityKey('そうか'))
  assert.equal(stabilityKey('ええと…'), stabilityKey('ええと'))
  assert.equal(stabilityKey('はい、そうです'), stabilityKey('はいそうです'))
})

test('settling keeps every symbol that changes what a sentence means', () => {
  // The whole reason punctuation is listed character by character instead of
  // being taken from \p{P} and \p{S}.
  assert.notEqual(stabilityKey('500円'), stabilityKey('500%'))
  assert.notEqual(stabilityKey('体温は36度'), stabilityKey('体温は36℃'))
  assert.notEqual(stabilityKey('x + 1'), stabilityKey('x − 1'))
  assert.notEqual(stabilityKey('A≦B'), stabilityKey('A≧B'))
  assert.notEqual(stabilityKey('$100'), stabilityKey('¥100'))
})

test('the prolonged sound mark and the iteration mark survive', () => {
  assert.equal(stabilityKey('コーヒー'), 'コーヒー')
  assert.equal(stabilityKey('人々'), '人々')
  assert.notEqual(stabilityKey('コーヒー'), stabilityKey('コヒ'))
})

test('compatibility forms and line wrapping fold, so a rewrap is not new text', () => {
  assert.equal(stabilityKey('ＡＢＣ'), stabilityKey('ABC'))
  assert.equal(stabilityKey('ｱｲｳ'), stabilityKey('アイウ'))
  assert.equal(stabilityKey('今日は\n寒いね'), stabilityKey('今日は寒いね'))
})

test('deduplication keeps punctuation, because 「はい」 and 「はい？」 differ', () => {
  assert.notEqual(identityKey('はい'), identityKey('はい？'))
  assert.notEqual(identityKey('行く'), identityKey('行く。'))
  // but it still folds width and whitespace, which are not meaning
  assert.equal(identityKey('Ａ Ｂ'), identityKey('AB'))
})

test('text that is only punctuation counts as empty', () => {
  assert.ok(isEmptyText('…'))
  assert.ok(isEmptyText('  \n '))
  assert.ok(!isEmptyText('あ'))
})

// --- relation classification ----------------------------------------------

test('a single-character change in the middle is a replacement, never a duplicate', () => {
  assert.equal(rel('彼を殺すつもりだ', '彼を返すつもりだ'), 'replacement')
})

test('a single-character change at the end of an equal-length line is a replacement', () => {
  assert.equal(rel('今日は寒いね', '今日は寒いよ'), 'replacement')
  assert.equal(rel('そうですか', 'そうですが'), 'replacement')
})

test('a one-character change survives however long the line is', () => {
  // The property worth having, because the obvious alternative does not have it:
  // under a ratio threshold, how much of a sentence must change before it counts
  // as changed grows with the sentence. Here it does not depend on length at all.
  // No punctuation, so the stability key is the string itself and the lengths
  // below are exact.
  const base = 'これは本当に長い文章でして最後の一文字だけが違いますという話です'
  for (const length of [4, 8, 16, 32]) {
    const a = base.slice(0, length)
    const b = a.slice(0, -1) + '為'
    assert.equal(commonPrefixLength(a, b), length - 1, `length ${length}: only the end differs`)
    // As a proportion these grow steadily more alike — 75% of four characters,
    // 97% of thirty-two — and a ratio threshold would stop calling them
    // different somewhere in that range. This does not.
    assert.equal(rel(a, b), 'replacement', `length ${length}`)
  }
})

test('adding a character is growth, but swapping one is a replacement', () => {
  const a = 'これは本当に長い文章でして、最後の一文字だけが違います'
  const b = 'これは本当に長い文章でして、最後の一文字だけが違いますね'
  // b is a clean extension of a, so this one genuinely is growth ...
  assert.equal(rel(a, b), 'growth')
  // ... but swapping the final character rather than adding one is not.
  assert.equal(rel(a, a.slice(0, -1) + '為'), 'replacement')
})

test('a line being typed out reads as growth', () => {
  assert.equal(rel('これは', 'これは本'), 'growth')
  assert.equal(rel('これは本', 'これは本当に'), 'growth')
})

test('a half-drawn final glyph still reads as the same line', () => {
  // The last character is misread on the way in, so neither string is a prefix
  // of the other, but something was genuinely added.
  assert.equal(rel('これは本当ぽ', 'これは本当に危'), 'evolving')
})

test('a dropped tail reads as shrink, not as new dialogue', () => {
  assert.equal(rel('今日は寒いね', '今日は寒い'), 'shrink')
})

test('punctuation-only jitter reads as identical', () => {
  assert.equal(rel('そうか', 'そうか。'), 'identical')
  assert.equal(rel('「行こう」', '行こう'), 'identical')
})

test('an empty reading and a first sighting are distinguished', () => {
  assert.equal(classify('あい', ''), 'empty')
  assert.equal(classify(null, 'あい'), 'first')
  assert.equal(classify('', 'あい'), 'first')
})

test('a short shared opening is not enough to claim the same line', () => {
  // Two characters shared, below the three-character floor.
  assert.equal(rel('今日はいい天気', '今晩は雨が降る'), 'replacement')
})

test('common prefix length is measured in code units', () => {
  assert.equal(commonPrefixLength('あいう', 'あいえ'), 2)
  assert.equal(commonPrefixLength('', 'あ'), 0)
})

// --- geometry --------------------------------------------------------------

test('the same boxes within tolerance are the same layout', () => {
  const a = [line('一', 10, 10), line('二', 10, 40)]
  const b = [line('三', 12, 11), line('四', 9, 41)]
  assert.ok(sameLayout(a, b, 3))
  assert.ok(!sameLayout(a, b, 1))
})

test('a different number of lines is never the same layout', () => {
  assert.ok(!sameLayout([line('一', 0, 0)], [line('一', 0, 0), line('二', 0, 30)], 3))
  assert.ok(!sameLayout([], [], 3))
  assert.ok(!sameLayout(null, [line('一', 0, 0)], 3))
})

test('the union box covers every line', () => {
  assert.deepEqual(unionBox([line('一', 10, 10, 50, 20), line('二', 30, 40, 80, 20)]), {
    x: 10,
    y: 10,
    width: 100,
    height: 50
  })
  assert.equal(unionBox([]), null)
})

test('the layout signature is coarse enough to survive a pixel of breathing', () => {
  const a = [line('一', 100, 200, 300, 40)]
  const b = [line('二', 102, 199, 301, 41)]
  assert.equal(layoutSignature(a), layoutSignature(b))
  assert.equal(layoutSignature(null), 'none')
  // and it carries no recognised text
  assert.ok(!layoutSignature(a).includes('一'))
})
