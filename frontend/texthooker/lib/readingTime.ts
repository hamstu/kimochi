/**
 * How reading time, skipping and days are counted, everywhere Kimochi shows reading stats: the
 * Log's footer (core/stats.ts, live), the session list (sessionSummary.ts) and the Stats tab, and
 * natively the reading history's exports (`with_read_time` in src-tauri/src/reading_history.rs,
 * the same rule; scripts/fixtures/reading-time.json holds the cases both are tested with).
 *
 * **Time on a line** is the time until the next line, but never more than the line could take:
 * 2.5 × the time a line of its length takes you, at your slower pace (the slower quarter of your
 * recent lines in that session), between 2 seconds and the longest one line may count (Settings →
 * Log, `afkThresholdSec`). A longer gap is a break: the line keeps its share and the rest is not
 * reading. Before a session has 5 measured lines, a character is allowed 3 seconds. This is the
 * rule GameSentenceMiner and Rubi arrived at (Rubi measured it closest to the truth of the rules
 * the trackers have used); it needs no tuning, a short line after a long break counts seconds,
 * not minutes, and a long line read slowly with lookups keeps its time.
 *
 * **Skipping** (Settings → Log, `skipFastLines`, on by default): three or more lines of 12+
 * characters, each less than a second after the last, were skipped, not read: they count no
 * characters, lines or time.
 *
 * **Days** start at `dayStartHour` (4 am by default), so a late night's reading belongs to the day
 * it began.
 */

/** The most a cap allows, as a multiple of the line's expected time. */
export const CAP_FACTOR = 2.5
/** The least a line with any characters may count. */
export const CAP_FLOOR_MS = 2_000
/** A character's allowance before the pace is known. */
export const FALLBACK_MS_PER_CHAR = 3_000
/** Lines measured before the pace is used. */
export const PACE_MIN_SAMPLES = 5
/** Only lines this long, with a gap in this range, teach the pace. */
export const PACE_MIN_CHARS = 5
export const PACE_MIN_GAP_MS = 1_000
export const PACE_MAX_GAP_MS = 300_000
/** Recent lines the pace follows, per session. */
export const PACE_WINDOW = 200
/** The pace's percentile of characters a second: the slower quarter. */
export const PACE_PERCENTILE = 0.25
/** Skipping: lines this long, this close together, this many in a row. */
export const SKIP_MIN_CHARS = 12
export const SKIP_MAX_GAP_MS = 1_000
export const SKIP_MIN_RUN = 3
/** A reading day starts at this local hour unless the person chose another (`dayStartHour`). */
export const DAY_START_HOUR = 4
/** Reading speed is shown once this many lines are counted. */
export const MIN_LINES_FOR_SPEED = 5

/** A session's pace: characters a second of its recent measured lines. */
export class Pace {
  private samples: number[] = []

  /** Learn from a line of `chars` characters followed `gapMs` later by the next. */
  learn(chars: number, gapMs: number): void {
    if (chars < PACE_MIN_CHARS || gapMs < PACE_MIN_GAP_MS || gapMs > PACE_MAX_GAP_MS) return
    this.samples.push(chars / (gapMs / 1000))
    if (this.samples.length > PACE_WINDOW) this.samples.shift()
  }

  /** Characters a second, or null until enough lines are measured. */
  charsPerSecond(): number | null {
    if (this.samples.length < PACE_MIN_SAMPLES) return null
    const sorted = [...this.samples].sort((a, b) => a - b)
    return sorted[Math.floor(PACE_PERCENTILE * (sorted.length - 1))]
  }

  /** The most a line of `chars` characters may count, at most `ceilingMs`. */
  capMs(chars: number, ceilingMs: number): number {
    if (chars <= 0) return 0
    const pace = this.charsPerSecond()
    const expected = pace ? CAP_FACTOR * (chars / pace) * 1000 : chars * FALLBACK_MS_PER_CHAR
    return Math.min(ceilingMs, Math.max(CAP_FLOOR_MS, expected))
  }
}

/** A line as the rule needs it. */
export interface TimedLine {
  /** When it was read, epoch ms. */
  ts: number
  /** Its characters (charCount.ts). */
  chars: number
  /** Its session: each has its own pace. */
  session?: string
}

export interface Credit {
  /** Reading time credited to the line. */
  ms: number
  /** Skipped, not read: no characters, line or time. */
  skipped: boolean
}

/** Which of `lines` (oldest first) were skipped. */
export function skippedLines(lines: readonly TimedLine[]): boolean[] {
  const skipped = lines.map(() => false)
  let start = 0
  for (let i = 1; i <= lines.length; i++) {
    const fast =
      i < lines.length &&
      lines[i].ts - lines[i - 1].ts < SKIP_MAX_GAP_MS &&
      lines[i].chars >= SKIP_MIN_CHARS &&
      lines[i - 1].chars >= SKIP_MIN_CHARS
    if (fast) continue
    if (i - start >= SKIP_MIN_RUN) for (let j = start; j < i; j++) skipped[j] = true
    start = i
  }
  return skipped
}

/**
 * The time each of `lines` (oldest first) counts, by the rule above, with `ceilingMs` the most one
 * line may count and `skipFast` whether skipping counts nothing. The last line has no next line:
 * it counts its cap.
 */
export function creditLines(lines: readonly TimedLine[], ceilingMs: number, skipFast = true): Credit[] {
  const skipped = skipFast ? skippedLines(lines) : lines.map(() => false)
  const paces = new Map<string, Pace>()
  return lines.map((line, i) => {
    if (skipped[i]) return { ms: 0, skipped: true }
    const key = line.session ?? ''
    let pace = paces.get(key)
    if (!pace) paces.set(key, (pace = new Pace()))
    const cap = pace.capMs(line.chars, ceilingMs)
    const next = lines[i + 1]
    if (!next) return { ms: cap, skipped: false }
    const gap = Math.max(0, next.ts - line.ts)
    if (!skipped[i + 1]) pace.learn(line.chars, gap)
    return { ms: Math.min(gap, cap), skipped: false }
  })
}

/**
 * The reading day of `ts` (epoch ms), `YYYY-MM-DD`: the local date `startHour` hours earlier.
 * `tzMinutes` (east of UTC) is where it was read; this computer's zone when omitted.
 */
export function readingDay(
  ts: number,
  tzMinutes = -new Date(ts).getTimezoneOffset(),
  startHour = DAY_START_HOUR
): string {
  return new Date(ts + tzMinutes * 60_000 - startHour * 3_600_000).toISOString().slice(0, 10)
}
