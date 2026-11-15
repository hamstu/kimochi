/**
 * The Stats tab's numbers. Native reads the reading history, credits every line by the reading-time
 * rule (`with_read_time` in src-tauri/src/reading_history.rs, the same rule and fixtures as
 * `@texthooker/lib/readingTime`) and sums it by reading day, session and hour
 * (`reading_history_stats`), off the UI thread; this adds those sums up for the sessions and range
 * being looked at, which is quick however long the history is.
 */
import { MIN_LINES_FOR_SPEED } from '@texthooker/lib/readingTime'

/** One session's reading on one reading day in one local hour (`reading_history::Bucket`). */
export interface Bucket {
  day: string
  session: string
  hour: number
  chars: number
  ms: number
  lines: number
  last: number
}

/** What `reading_history_stats` returns. */
export interface StatsSource {
  sessions: { id: string; name: string }[]
  buckets: Bucket[]
}

/** What `reading_history_kanji` returns. */
export interface KanjiStats {
  /** Distinct kanji read in the range. */
  distinct: number
  /** Of those, how many were never read before it. */
  fresh: number
  /** The range's kanji, most read first. */
  top: { kanji: string; count: number; fresh: boolean }[]
}

export interface Totals {
  chars: number
  ms: number
  lines: number
}

export type Range = 'week' | 'month' | 'year' | 'all'

export const RANGE_DAYS: Record<Exclude<Range, 'all'>, number> = { week: 7, month: 30, year: 365 }

export interface DayPoint extends Totals {
  /** The first reading day of the point (`YYYY-MM-DD`). */
  day: string
  /** How many days it covers: 1, or 7 when a long range is drawn by week. */
  span: number
}

export interface SessionStats extends Totals {
  id: string
  name: string
  last: number
  /** The reading day of `last`. */
  lastDay: string
}

export interface Streaks {
  /** Days in a row up to today, or up to yesterday while today has nothing yet. */
  current: number
  longest: number
  daysRead: number
}

export interface Stats {
  today: Totals
  week: Totals
  all: Totals
  /** Totals per reading day, every day with reading (for the heatmap). */
  days: Map<string, Totals>
  streaks: Streaks
  /** The range: its totals, its days (or weeks) zero-filled, its reading by hour of day, by session. */
  range: Totals
  series: DayPoint[]
  hours: Totals[]
  sessions: SessionStats[]
}

const DAY_MS = 86_400_000

/** `YYYY-MM-DD` `n` days after `day`. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
}

/** Whole days from `a` to `b`. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)
}

/** Characters an hour, or null with too few lines (or no time) to say. */
export function speed(totals: Totals): number | null {
  if (totals.lines < MIN_LINES_FOR_SPEED || totals.ms <= 0) return null
  return Math.round(totals.chars / (totals.ms / 3_600_000))
}

const zero = (): Totals => ({ chars: 0, ms: 0, lines: 0 })
const add = (into: Totals, from: Totals): void => {
  into.chars += from.chars
  into.ms += from.ms
  into.lines += from.lines
}

/** Current and longest runs of reading days, by `today`. */
export function streaks(days: Iterable<string>, today: string): Streaks {
  const sorted = [...new Set(days)].sort()
  let longest = 0
  let run = 0
  let prev: string | null = null
  for (const day of sorted) {
    run = prev && daysBetween(prev, day) === 1 ? run + 1 : 1
    longest = Math.max(longest, run)
    prev = day
  }
  const read = new Set(sorted)
  let current = 0
  let cursor = read.has(today) ? today : addDays(today, -1)
  while (read.has(cursor)) {
    current += 1
    cursor = addDays(cursor, -1)
  }
  return { current, longest, daysRead: sorted.length }
}

/** The first day of `range` ending `today`; for all time, the first day read (or today). */
export function rangeStart(range: Range, today: string, first: string | undefined): string {
  if (range === 'all') return first && first < today ? first : today
  return addDays(today, -(RANGE_DAYS[range] - 1))
}

/**
 * The stats of `buckets` (oldest first, already narrowed to the sessions looked at) on reading
 * day `today`, with the charts for `range`. `names` names each session.
 */
export function computeStats(
  buckets: readonly Bucket[],
  { range, today, names }: { range: Range; today: string; names: ReadonlyMap<string, string> }
): Stats {
  const weekStart = addDays(today, -6)
  const first = buckets.length ? buckets[0].day : undefined
  const start = rangeStart(range, today, first)

  const all = zero()
  const todayTotals = zero()
  const week = zero()
  const rangeTotals = zero()
  const days = new Map<string, Totals>()
  const hours = Array.from({ length: 24 }, zero)
  const bySession = new Map<string, SessionStats>()

  for (const bucket of buckets) {
    add(all, bucket)
    let day = days.get(bucket.day)
    if (!day) days.set(bucket.day, (day = zero()))
    add(day, bucket)
    if (bucket.day === today) add(todayTotals, bucket)
    if (bucket.day >= weekStart && bucket.day <= today) add(week, bucket)
    if (bucket.day < start || bucket.day > today) continue
    add(rangeTotals, bucket)
    add(hours[bucket.hour], bucket)
    let session = bySession.get(bucket.session)
    if (!session) {
      session = {
        id: bucket.session,
        name: names.get(bucket.session) ?? 'Untitled',
        last: 0,
        lastDay: bucket.day,
        ...zero()
      }
      bySession.set(bucket.session, session)
    }
    add(session, bucket)
    if (bucket.last >= session.last) {
      session.last = bucket.last
      session.lastDay = bucket.day
    }
  }

  // Up to 120 days are drawn a bar a day; longer, a bar a week.
  const length = daysBetween(start, today) + 1
  const span = length > 120 ? 7 : 1
  const series: DayPoint[] = []
  // Weeks end today, so the last bar is always this week.
  const offset = (span - (length % span)) % span
  for (let i = -offset; i < length; i += span) {
    const point: DayPoint = { day: addDays(start, Math.max(0, i)), span, ...zero() }
    for (let d = Math.max(0, i); d < i + span; d++) {
      const totals = days.get(addDays(start, d))
      if (!totals) continue
      point.chars += totals.chars
      point.ms += totals.ms
      point.lines += totals.lines
    }
    series.push(point)
  }

  return {
    today: todayTotals,
    week,
    all,
    days,
    streaks: streaks(days.keys(), today),
    range: rangeTotals,
    series,
    hours,
    sessions: [...bySession.values()].sort((a, b) => b.chars - a.chars || b.last - a.last)
  }
}
