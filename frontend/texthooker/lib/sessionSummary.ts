/**
 * What the session list shows about each session: how many lines it holds, roughly how long was
 * spent reading them, and its newest lines. Worked out from the session's own lines (the reading
 * timer in `stats.json` covers every session at once), so it holds for sessions synced from
 * another computer too.
 */
import type { Line } from './types'
import { countChars } from '../core/charCount'
import { creditLines } from './readingTime'

export interface SessionSummary {
  id: string
  lines: number
  /** The reading time of its lines, by the rule every stat uses (readingTime.ts). */
  readingMs: number
  /** The newest lines' text, oldest first. */
  recent: string[]
}

export const RECENT_LINES = 5

export function summarizeLines(
  id: string,
  all: readonly Pick<Line, 'text' | 'ts' | 'source'>[],
  ceilingMs: number
): SessionSummary {
  // What was read: the person's notes are neither lines nor reading time.
  const lines = all.filter((line) => line.source !== 'note')
  const timed = lines
    .filter((line) => Number.isFinite(line.ts))
    .map((line) => ({ ts: line.ts, chars: countChars(line.text) }))
    .sort((a, b) => a.ts - b.ts)
  const readingMs = creditLines(timed, ceilingMs).reduce((sum, credit) => sum + credit.ms, 0)
  const recent = lines
    .slice(-RECENT_LINES)
    .map((line) => line.text.trim())
    .filter(Boolean)
  return { id, lines: lines.length, readingMs, recent }
}

/** "2h 05m", "12m", "45s", or "0m" for nothing yet. */
export function formatReadingTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return seconds > 0 ? `${seconds}s` : '0m'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}
