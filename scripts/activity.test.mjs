import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const {
  ActivityFeed,
  ACTIVITY_TIMES_LIMIT,
  activityText,
  normalizeActivity,
  relativeTime,
  relativeTimeRefreshMs
} = await load('activity.ts')

/** A feed on a clock the test moves by hand. */
function feed(limit) {
  let now = 1_000_000
  const f = new ActivityFeed(limit, () => now)
  return { f, tick: (ms) => (now += ms), now: () => now }
}
const texts = (f) => f.entries().map((e) => (e.count > 1 ? `${e.text} ×${e.count}` : e.text))

test('the same message again bumps the newest entry instead of adding a row', () => {
  const { f, tick, now } = feed()
  const first = f.post({ text: 'Nothing recognised', tone: 'warn' })
  tick(2000)
  const again = f.post({ text: 'Nothing recognised', tone: 'warn' })
  assert.equal(again.id, first.id)
  assert.equal(again.count, 2)
  assert.equal(again.at, first.at)
  assert.equal(again.lastAt, now())
  assert.deepEqual(again.times, [first.at, now()])
  assert.equal(f.entries().length, 1)
})

test('only the newest entry coalesces, and only with the same tone and key', () => {
  const { f } = feed()
  f.post({ text: 'A' })
  f.post({ text: 'B' })
  f.post({ text: 'A' })
  f.post({ text: 'A', tone: 'warn' })
  f.post({ text: 'A', tone: 'warn', key: 'scan' })
  assert.deepEqual(texts(f), ['A', 'B', 'A', 'A', 'A'])
})

test('a busy entry is settled by the next post with its key', () => {
  const { f } = feed()
  const busy = f.post({ text: 'Scanning…', tone: 'busy', key: 'scan' })
  const done = f.post({ text: 'Added 3 lines', tone: 'ok', key: 'scan' })
  assert.notEqual(done.id, busy.id)
  assert.deepEqual(texts(f), ['Added 3 lines'])
  assert.equal(f.latest().tone, 'ok')
})

test('busy progress updates its row in place, wherever it stands', () => {
  const { f, tick } = feed()
  const download = f.post({ text: 'Downloading MeikiOCR model… 10%', tone: 'busy', key: 'model:meikiocr' })
  f.post({ text: 'Auto-scan on' })
  tick(1000)
  const progress = f.post({ text: 'Downloading MeikiOCR model… 42%', tone: 'busy', key: 'model:meikiocr' })
  assert.equal(progress.id, download.id)
  assert.equal(progress.count, 1)
  assert.deepEqual(texts(f), ['Downloading MeikiOCR model… 42%', 'Auto-scan on'])
  // The outcome is news: it retires the busy row and becomes the newest entry.
  f.post({ text: 'MeikiOCR model ready', tone: 'ok', key: 'model:meikiocr' })
  assert.deepEqual(texts(f), ['Auto-scan on', 'MeikiOCR model ready'])
})

test('repeated scans with the same outcome fold into one row', () => {
  const { f } = feed()
  for (let i = 0; i < 3; i++) {
    f.post({ text: 'Scanning…', tone: 'busy', key: 'scan' })
    assert.equal(f.latest().tone, 'busy', 'each scan is visibly in progress')
    f.post({ text: 'Nothing recognised', tone: 'warn', key: 'scan' })
  }
  assert.deepEqual(texts(f), ['Nothing recognised ×3'])
})

test('a new busy post does not coalesce into a settled entry with its key', () => {
  const { f } = feed()
  f.post({ text: 'Added 1 line', tone: 'ok', key: 'scan' })
  f.post({ text: 'Scanning…', tone: 'busy', key: 'scan' })
  assert.deepEqual(texts(f), ['Added 1 line', 'Scanning…'])
})

test('a post with another key leaves a busy entry alone', () => {
  const { f } = feed()
  f.post({ text: 'Scanning…', tone: 'busy', key: 'scan' })
  f.post({ text: 'MeikiOCR model ready', tone: 'ok', key: 'model:meikiocr' })
  assert.deepEqual(texts(f), ['Scanning…', 'MeikiOCR model ready'])
})

test('the history is bounded, dropping the oldest', () => {
  const { f } = feed(5)
  for (let i = 0; i < 8; i++) f.post({ text: `message ${i}` })
  assert.deepEqual(texts(f), ['message 3', 'message 4', 'message 5', 'message 6', 'message 7'])
})

test('a coalesced entry remembers a bounded number of occurrences', () => {
  const { f, tick } = feed()
  for (let i = 0; i < ACTIVITY_TIMES_LIMIT + 10; i++) {
    f.post({ text: 'same' })
    tick(10)
  }
  const entry = f.latest()
  assert.equal(entry.count, ACTIVITY_TIMES_LIMIT + 10)
  assert.equal(entry.times.length, ACTIVITY_TIMES_LIMIT)
  assert.equal(entry.times.at(-1), entry.lastAt)
})

test('snapshots change identity on every change and listeners hear it', () => {
  const { f } = feed()
  let heard = 0
  const stop = f.subscribe(() => heard++)
  const before = f.entries()
  f.post({ text: 'one' })
  const after = f.entries()
  assert.notEqual(before, after)
  f.post({ text: 'one' })
  assert.notEqual(after, f.entries())
  // Saying exactly what a busy entry already says changes nothing.
  f.post({ text: 'Scanning…', tone: 'busy', key: 'scan' })
  const busy = f.entries()
  f.post({ text: 'Scanning…', tone: 'busy', key: 'scan' })
  assert.equal(busy, f.entries())
  assert.equal(heard, 3)
  stop()
  f.post({ text: 'two' })
  assert.equal(heard, 3)
})

test('empty messages are ignored and text is flattened to one line', () => {
  const { f } = feed()
  assert.equal(f.post({ text: '   ' }), null)
  assert.equal(f.entries().length, 0)
  assert.equal(activityText('OCR failed:\n  timeout\t(45 s)'), 'OCR failed: timeout (45 s)')
  assert.equal([...activityText('x'.repeat(1000))].length, 300)
  assert.ok(activityText('x'.repeat(1000)).endsWith('…'))
})

test('event payloads are validated', () => {
  assert.deepEqual(normalizeActivity({ text: 'Added 1 line', tone: 'ok', key: 'scan', at: 5 }), {
    text: 'Added 1 line',
    tone: 'ok',
    key: 'scan',
    at: 5
  })
  assert.deepEqual(normalizeActivity({ text: 'x', tone: 'shouting' }), {
    text: 'x',
    tone: 'info',
    key: null
  })
  assert.equal(normalizeActivity({ text: '' }), null)
  assert.equal(normalizeActivity(null), null)
  assert.equal(normalizeActivity('text'), null)
})

test('relative times read naturally', () => {
  const now = 10_000_000
  assert.equal(relativeTime(now, now), 'just now')
  assert.equal(relativeTime(now + 500, now), 'just now', 'a slightly later clock is not the future')
  assert.equal(relativeTime(now - 2999, now), 'just now')
  assert.equal(relativeTime(now - 4000, now), '4 s ago')
  assert.equal(relativeTime(now - 59_999, now), '59 s ago')
  assert.equal(relativeTime(now - 60_000, now), '1 min ago')
  assert.equal(relativeTime(now - 125_000, now), '2 min ago')
  assert.equal(relativeTime(now - 3 * 3600_000, now), '3 h ago')
  assert.equal(relativeTime(now - 50 * 3600_000, now), '2 d ago')
  assert.equal(relativeTimeRefreshMs(now - 5000, now), 1000)
  assert.equal(relativeTimeRefreshMs(now - 120_000, now), 15_000)
})
