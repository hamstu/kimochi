/**
 * The Stats tab's centrepiece: a year of reading days, a square a day, a column a week (Monday at
 * the top), as many weeks as the window fits. The darker the square, the more was read. The
 * current streak wears a ring, and pointing at any day rings its whole run of days in a row, so
 * streaks read at a glance.
 */
import { useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Flame } from 'lucide-react'
import { formatReadingTime } from '@texthooker/lib/sessionSummary'
import { addDays, daysBetween, type Streaks, type Totals } from './statsModel'
import { formatDay, plural } from './format'

const MAX_WEEKS = 53
const MIN_WEEKS = 12
/** The narrowest a square gets before weeks drop off the start, px at scale 1. */
const MIN_CELL_PX = 13

/** Monday-first weekday of `day` (0 = Monday). */
const weekday = (day: string): number => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7

/** A day's shade, 0 (nothing) to 4, by the quartiles of the days shown. */
function levels(values: number[]): (chars: number) => number {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (!sorted.length) return () => 0
  const q = (p: number): number => sorted[Math.floor(p * (sorted.length - 1))]
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)]
  return (chars) => (chars <= 0 ? 0 : chars <= q1 ? 1 : chars <= q2 ? 2 : chars <= q3 ? 3 : 4)
}

/** Each read day's run of days in a row: its first day, its length and where the day falls in it. */
function runs(days: ReadonlyMap<string, Totals>): Map<string, { start: string; length: number; index: number }> {
  const out = new Map<string, { start: string; length: number; index: number }>()
  const sorted = [...days.keys()].sort()
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && daysBetween(sorted[j], sorted[j + 1]) === 1) j++
    const run = { start: sorted[i], length: j - i + 1 }
    for (let k = i; k <= j; k++) out.set(sorted[k], { ...run, index: k - i + 1 })
    i = j + 1
  }
  return out
}

export function Heatmap({
  days,
  streaks,
  today
}: {
  days: ReadonlyMap<string, Totals>
  streaks: Streaks
  today: string
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const [weeks, setWeeks] = useState(MAX_WEEKS)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = (): void => {
      const scale = parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1
      const width = el.clientWidth
      setWeeks(Math.max(MIN_WEEKS, Math.min(MAX_WEEKS, Math.floor(width / (MIN_CELL_PX * scale)))))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // The last column is this week; the grid starts on the Monday `weeks` columns back.
  const first = addDays(today, -weekday(today) - (weeks - 1) * 7)
  const cells = useMemo(() => {
    const out: string[] = []
    for (let i = 0; i < weeks * 7; i++) out.push(addDays(first, i))
    return out
  }, [first, weeks])
  const shade = useMemo(() => levels(cells.map((day) => days.get(day)?.chars ?? 0)), [cells, days])
  const runOf = useMemo(() => runs(days), [days])
  const [hovered, setHovered] = useState<string | null>(null)

  const current = streaks.current > 0 ? (runOf.get(today) ?? runOf.get(addDays(today, -1))) : undefined
  const hoveredRun = hovered ? runOf.get(hovered) : undefined
  const inRun = (day: string, run: { start: string; length: number } | undefined): boolean =>
    Boolean(run && day >= run.start && daysBetween(run.start, day) < run.length)

  // A month's name over the first week that starts in it, if there's room.
  const months: { column: number; label: string }[] = []
  let lastLabel = -3
  for (let w = 0; w < weeks; w++) {
    const monday = cells[w * 7]
    const prev = w > 0 ? cells[(w - 1) * 7] : null
    if (prev && monday.slice(5, 7) === prev.slice(5, 7)) continue
    if (w - lastLabel < 3) continue
    if (w === 0 && Number(monday.slice(8)) > 20) continue
    months.push({
      column: w,
      label: new Date(`${monday}T00:00:00Z`).toLocaleString(undefined, { month: 'short', timeZone: 'UTC' })
    })
    lastLabel = w
  }

  const readDays = cells.filter((day) => day <= today && days.has(day)).length
  const hoveredTotals = hovered ? days.get(hovered) : undefined

  return (
    <section className="stats-heatmap" aria-label="Reading days">
      <header className="stats-heatmap-head">
        <div className="stats-streak">
          <Flame aria-hidden className="stats-streak-icon" data-on={streaks.current > 0 || undefined} />
          <span className="stats-streak-value k-num">{streaks.current.toLocaleString()}</span>
          <span className="stats-streak-label">day streak</span>
        </div>
        <dl className="stats-streak-facts k-num">
          <div>
            <dt>Longest</dt>
            <dd>{plural(streaks.longest, 'day')}</dd>
          </div>
          <div>
            <dt>Days read</dt>
            <dd>{streaks.daysRead.toLocaleString()}</dd>
          </div>
        </dl>
      </header>
      <div className="stats-heatmap-body">
        <div className="stats-heatmap-weekdays" aria-hidden>
          <span />
          <span>Mon</span>
          <span />
          <span>Wed</span>
          <span />
          <span>Fri</span>
          <span />
        </div>
        <div className="stats-heatmap-main" ref={box}>
          <div className="stats-heatmap-months" style={{ gridTemplateColumns: `repeat(${weeks}, 1fr)` }} aria-hidden>
            {months.map((m) => (
              <span key={m.column} style={{ gridColumn: `${m.column + 1} / span 3` }}>
                {m.label}
              </span>
            ))}
          </div>
          <div
            className="stats-heatmap-grid"
            style={{ gridTemplateColumns: `repeat(${weeks}, 1fr)` }}
            role="img"
            aria-label={`${plural(readDays, 'day')} read in the last ${weeks} weeks; current streak ${plural(streaks.current, 'day')}`}
            onPointerLeave={() => setHovered(null)}
          >
            {cells.map((day) => {
              const future = day > today
              return (
                <span
                  key={day}
                  className="stats-heatmap-cell"
                  data-level={future ? undefined : shade(days.get(day)?.chars ?? 0)}
                  data-future={future || undefined}
                  data-today={day === today || undefined}
                  data-streak={inRun(day, current) || undefined}
                  data-run={inRun(day, hoveredRun) || undefined}
                  data-hovered={day === hovered || undefined}
                  onPointerEnter={() => setHovered(future ? null : day)}
                />
              )
            })}
          </div>
        </div>
      </div>
      <footer className="stats-heatmap-foot">
        <span className="stats-readout k-num" aria-live="polite">
          {hovered ? (
            <>
              <strong>{formatDay(hovered, true)}</strong>
              {hoveredTotals ? (
                <>
                  <span>{plural(hoveredTotals.chars, 'character')}</span>
                  <span>{formatReadingTime(hoveredTotals.ms)}</span>
                  {hoveredRun && hoveredRun.length > 1 && (
                    <span>
                      day {hoveredRun.index} of {hoveredRun.length} in a row
                    </span>
                  )}
                </>
              ) : (
                <span>No reading</span>
              )}
            </>
          ) : (
            <span>
              {plural(readDays, 'day')} read in the last {weeks} weeks
            </span>
          )}
        </span>
        <span className="stats-legend" aria-hidden>
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className="stats-heatmap-cell" data-level={level} />
          ))}
          <span>More</span>
        </span>
      </footer>
    </section>
  )
}
