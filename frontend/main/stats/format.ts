/** How the Stats tab writes its numbers and days. */

/** "1 day", "12 days", with the number grouped. */
export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${n === 1 ? word : `${word}s`}`
}

/** 950, 12.4k, 1.2M: for axes, where room is short. */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** A reading day (`YYYY-MM-DD`) as "Tue 12 Nov", or with `long` "Tuesday 12 November 2026". */
export function formatDay(day: string, long = false): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: long ? 'long' : 'short',
    day: 'numeric',
    month: long ? 'long' : 'short',
    ...(long ? { year: 'numeric' } : {})
  })
}

/** "12 Nov" or, in another year than `today`'s, "12 Nov 2025". */
export function formatShortDay(day: string, today: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {})
  })
}

/** Characters an hour, or an en dash with too little to say. */
export function formatSpeed(speed: number | null): string {
  return speed === null ? '–' : `${speed.toLocaleString()}/h`
}
