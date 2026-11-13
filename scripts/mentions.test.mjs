import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { mentionAt, rankMentions, applyMention, fold, mentionName } = await load(
  '../frontend/texthooker/lib/mentions.ts'
)

const person = (id, family, given, extra = {}) => ({
  id, kind: 'person', family, given, familyReading: '', givenReading: '', aliases: [], description: '',
  images: [], matchEnabled: true, ...extra,
})
const place = (id, name, extra = {}) => ({
  id, kind: 'place', name, reading: '', aliases: [], description: '', images: [], matchEnabled: true, ...extra,
})

const okabe = person('p1', '岡部', '倫太郎', { familyReading: 'おかべ', givenReading: 'りんたろう', aliases: ['オカリン', '鳳凰院凶真'] })
const mayuri = person('p2', '椎名', 'まゆり', { familyReading: 'しいな' })
const kurisu = person('p3', 'Makise', 'Kurisu')
const lab = place('l1', '未来ガジェット研究所', { aliases: ['ラボ'] })
const hidden = place('l2', 'ラジ館', { matchEnabled: false })
const ENTRIES = [okabe, mayuri, kurisu, lab, hidden]

test('an @ at the start, after a space or after Japanese starts a mention; one in an address does not', () => {
  assert.deepEqual(mentionAt('@オカ', 3), { start: 0, end: 3, query: 'オカ' })
  assert.deepEqual(mentionAt('see @mak', 8), { start: 4, end: 8, query: 'mak' })
  assert.deepEqual(mentionAt('今日は＠ラボ', 6), { start: 3, end: 6, query: 'ラボ' })
  assert.deepEqual(mentionAt('note @', 6), { start: 5, end: 6, query: '' })
  assert.equal(mentionAt('mail me@example.com', 19), null)
  assert.equal(mentionAt('@okabe and more', 15), null, 'a space after the query ends it')
  assert.equal(mentionAt('no mention here', 8), null)
})

test('kana, width and case fold together', () => {
  assert.equal(fold('オカリン'), fold('おかりん'))
  assert.equal(fold('ＭＡＫＩＳＥ'), 'makise')
  assert.equal(fold('ｵｶﾘﾝ'), fold('おかりん'))
})

test('a Japanese name is written whole, a Latin one with its space', () => {
  assert.equal(mentionName(okabe), '岡部倫太郎')
  assert.equal(mentionName(kurisu), 'Makise Kurisu')
  assert.equal(mentionName(lab), '未来ガジェット研究所')
})

test('a leading match beats one in the middle, and an alias typed toward is what gets written', () => {
  const oka = rankMentions(ENTRIES, 'おかり')
  assert.equal(oka[0].entry.id, 'p1')
  assert.equal(oka[0].insert, 'オカリン', 'typed toward the alias, so the alias is written')
  assert.equal(rankMentions(ENTRIES, 'りんたろう')[0].insert, '岡部倫太郎', 'by reading: the name is written')
  assert.equal(rankMentions(ENTRIES, 'kuri')[0].insert, 'Makise Kurisu', 'a later word of the name')
  assert.equal(rankMentions(ENTRIES, 'らぼ')[0].insert, 'ラボ')
})

test('an empty query lists characters first; unnamed and unlinked entries never show', () => {
  const all = rankMentions([...ENTRIES, place('l3', '')], '')
  assert.deepEqual(all.map((o) => o.entry.kind), ['person', 'person', 'person', 'place'])
  assert.ok(!all.some((o) => o.entry.id === 'l2'), 'matching is off for it, so a mention would not link')
  assert.equal(rankMentions(ENTRIES, 'zzz').length, 0)
  assert.equal(rankMentions(ENTRIES, '', 2).length, 2)
})

test('choosing replaces the @ and its query, and puts the caret after the name', () => {
  const text = '今日は＠おかと話した'
  const mention = mentionAt(text, 6)
  assert.deepEqual(applyMention(text, mention, 'オカリン'), { text: '今日はオカリンと話した', caret: 7 })
})
