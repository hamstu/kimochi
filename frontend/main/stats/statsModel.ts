/**
 * The Stats tab's numbers, from the reading history (`reading_history_lines`). Every time, skip,
 * day and speed comes from the one rule in `@texthooker/lib/readingTime` (the footer and the
 * exports count by it too): lines are credited once, oldest first across every session, and only
 * then narrowed to the sessions being looked at, so a line's time doesn't change with the choice.
 */
import { creditLines, MIN_LINES_FOR_SPEED, readingDay } from '@texthooker/lib/readingTime'

/** A line as `reading_history_lines` returns it, with the fields the tab asks for. */
export interface HistoryLine {
  ts: number
  /** Minutes east of UTC where it was read (0 when unknown). */
  tz: number
  chars: number
  session: string
  sessionName: string
  text?: string
  backfilled?: boolean
}

/** The fields the tab asks native for. */
export const STATS_FIELDS = ['ts', 'tz', 'chars', 'session', 'sessionName', 'text', 'backfilled'] as const

/** A line read (not skipped), with its credited time, reading day and local hour. */
export interface ReadLine {
  ts: number
  day: string
  hour: number
  chars: number
  ms: number
  session: string
  text: string
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
const add = (into: Totals, line: ReadLine): void => {
  into.chars += line.chars
  into.ms += line.ms
  into.lines += 1
}

/**
 * The history's lines (oldest first) credited by the reading-time rule, skipped lines left out.
 * `ceilingMs` is the most one line may count (Settings → Log, `afkThresholdSec`). A backfilled line
 * from before the history kept time zones (`tz` 0) is placed in this computer's zone.
 */
export function readLines(lines: readonly HistoryLine[], ceilingMs: number): ReadLine[] {
  const credits = creditLines(lines, ceilingMs)
  const out: ReadLine[] = []
  lines.forEach((line, i) => {
    const credit = credits[i]
    if (credit.skipped) return
    const tz = line.backfilled && line.tz === 0 ? -new Date(line.ts).getTimezoneOffset() : line.tz
    out.push({
      ts: line.ts,
      day: readingDay(line.ts, tz),
      hour: new Date(line.ts + tz * 60_000).getUTCHours(),
      chars: line.chars,
      ms: credit.ms,
      session: line.session,
      text: line.text ?? ''
    })
  })
  return out
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
 * The stats of `lines` (from `readLines`) of `sessions` (all when null), at `now`, with the charts
 * for `range`. `names` names each session (the history's own names fill in deleted sessions).
 */
export function computeStats(
  lines: readonly ReadLine[],
  {
    sessions,
    range,
    now,
    names
  }: { sessions: ReadonlySet<string> | null; range: Range; now: number; names: ReadonlyMap<string, string> }
): Stats {
  const today = readingDay(now)
  const weekStart = addDays(today, -6)
  const picked = sessions ? lines.filter((line) => sessions.has(line.session)) : lines
  const first = picked.length ? picked[0].day : undefined
  const start = rangeStart(range, today, first)

  const all = zero()
  const todayTotals = zero()
  const week = zero()
  const rangeTotals = zero()
  const days = new Map<string, Totals>()
  const hours = Array.from({ length: 24 }, zero)
  const bySession = new Map<string, SessionStats>()

  for (const line of picked) {
    add(all, line)
    let day = days.get(line.day)
    if (!day) days.set(line.day, (day = zero()))
    add(day, line)
    if (line.day === today) add(todayTotals, line)
    if (line.day >= weekStart && line.day <= today) add(week, line)
    if (line.day < start || line.day > today) continue
    add(rangeTotals, line)
    add(hours[line.hour], line)
    let session = bySession.get(line.session)
    if (!session) {
      session = { id: line.session, name: names.get(line.session) ?? 'Untitled', last: 0, ...zero() }
      bySession.set(line.session, session)
    }
    add(session, line)
    session.last = Math.max(session.last, line.ts)
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

const KANJI = /\p{Script=Han}/u

export interface KanjiStats {
  /** Distinct kanji read in the range. */
  distinct: number
  /** Of those, how many were first read in the range. */
  fresh: number
  /** The range's kanji, most read first. */
  top: { kanji: string; count: number; fresh: boolean }[]
}

/** The kanji in `lines` (from `readLines`, already narrowed to the sessions) read in `range`. */
export function computeKanji(
  lines: readonly ReadLine[],
  { range, now, limit = 60 }: { range: Range; now: number; limit?: number }
): KanjiStats {
  const today = readingDay(now)
  const start = rangeStart(range, today, lines[0]?.day)
  const counts = new Map<string, number>()
  const before = new Set<string>()
  for (const line of lines) {
    const inRange = line.day >= start && line.day <= today
    for (const ch of line.text) {
      if (!KANJI.test(ch)) continue
      if (inRange) counts.set(ch, (counts.get(ch) ?? 0) + 1)
      else if (line.day < start) before.add(ch)
    }
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([kanji, count]) => ({ kanji, count, fresh: !before.has(kanji) }))
  let fresh = 0
  for (const kanji of counts.keys()) if (!before.has(kanji)) fresh++
  return { distinct: counts.size, fresh, top }
}
