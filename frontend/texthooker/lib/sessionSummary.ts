/**
 * What the session list shows about each session: how many lines it holds, roughly how long was
 * spent reading them, and its newest lines. Worked out from the session's own lines (the reading
 * timer in `stats.json` covers every session at once), so it holds for sessions synced from
 * another computer too.
 */
import type { Line } from "./types";

export interface SessionSummary {
  id: string;
  lines: number;
  /** The time between consecutive lines, leaving out any pause longer than the idle threshold. */
  readingMs: number;
  /** The newest lines' text, oldest first. */
  recent: string[];
}

export const RECENT_LINES = 5;

export function summarizeLines(
  id: string,
  lines: readonly Pick<Line, "text" | "ts">[],
  idleMs: number,
): SessionSummary {
  const times = lines
    .map((line) => line.ts)
    .filter((ts) => Number.isFinite(ts))
    .sort((a, b) => a - b);
  let readingMs = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > 0 && gap <= idleMs) readingMs += gap;
  }
  const recent = lines
    .slice(-RECENT_LINES)
    .map((line) => line.text.trim())
    .filter(Boolean);
  return { id, lines: lines.length, readingMs, recent };
}

/** "2h 05m", "12m", "45s", or "0m" for nothing yet. */
export function formatReadingTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds > 0 ? `${seconds}s` : "0m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
