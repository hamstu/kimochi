import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { dayKey, dayLabel, dayStarts, lineDate, lineTime } = await load(
  '../frontend/texthooker/lib/logDays.ts'
)

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime()
const NOW = at(2026, 10, 19, 21, 30)

test('a line shows its 24-hour time, and its full date on hover', () => {
  assert.equal(lineTime(at(2026, 10, 19, 9, 4)), '09:04')
  assert.equal(lineTime(at(2026, 10, 19, 21, 59)), '21:59')
  assert.match(lineDate(at(2026, 10, 19, 21, 4), 'en-US'), /Monday, October 19, 2026 at 9:04/)
})

test('days are calendar days in local time', () => {
  assert.equal(dayKey(at(2026, 10, 19, 0, 0)), dayKey(at(2026, 10, 19, 23, 59)))
  assert.notEqual(dayKey(at(2026, 10, 19, 23, 59)), dayKey(at(2026, 10, 20, 0, 0)))
})

test('dividers read Today, Yesterday, then the date, with the year only when it differs', () => {
  assert.equal(dayLabel(at(2026, 10, 19, 1), NOW, 'en-US'), 'Today')
  assert.equal(dayLabel(at(2026, 10, 18, 23), NOW, 'en-US'), 'Yesterday')
  assert.equal(dayLabel(at(2026, 10, 13), NOW, 'en-US'), 'Tuesday, October 13')
  assert.equal(dayLabel(at(2025, 12, 31), NOW, 'en-US'), 'Wednesday, December 31, 2025')
  // Yesterday across a month boundary.
  assert.equal(dayLabel(at(2026, 10, 31), at(2026, 11, 1), 'en-US'), 'Yesterday')
})

test('no dividers while a session stays on one day', () => {
  const lines = [at(2026, 10, 19, 9), at(2026, 10, 19, 10), at(2026, 10, 19, 23)].map((ts) => ({ ts }))
  assert.deepEqual([...dayStarts(lines, lines)], [])
  assert.deepEqual([...dayStarts([], [])], [])
  assert.deepEqual([...dayStarts(lines.slice(0, 1), lines.slice(0, 1))], [])
})

test('once lines span days, every day is labelled where it starts', () => {
  const lines = [
    at(2026, 10, 17, 22),
    at(2026, 10, 17, 23),
    at(2026, 10, 19, 0, 5),
    at(2026, 10, 19, 1)
  ].map((ts) => ({ ts }))
  assert.deepEqual([...dayStarts(lines, lines)], [0, 2])
  // With earlier lines not shown, the first shown line still says its day.
  assert.deepEqual([...dayStarts(lines, lines.slice(1))], [0, 1])
  assert.deepEqual([...dayStarts(lines, lines.slice(2))], [0])
})
