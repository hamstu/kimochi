/**
 * The Stats tab's small charts, drawn in HTML and SVG from the kit's roles: reading per day (or
 * week), speed over the same days, and reading by hour of day. Pointing at a bar shows its numbers
 * in the chart's readout line instead of a tooltip.
 */
import { useState, type JSX, type ReactNode } from 'react'
import { formatReadingTime } from '@texthooker/lib/sessionSummary'
import { addDays, speed, type DayPoint, type Totals } from './statsModel'
import { compact, formatDay, formatShortDay, formatSpeed, plural } from './format'

export type Metric = 'chars' | 'ms'

const value = (totals: Totals, metric: Metric): number => (metric === 'chars' ? totals.chars : totals.ms)
const describe = (totals: Totals, metric: Metric): string =>
  metric === 'chars' ? plural(totals.chars, 'character') : formatReadingTime(totals.ms)
const axis = (n: number, metric: Metric): string => (metric === 'chars' ? compact(n) : formatReadingTime(n))

function pointLabel(point: DayPoint, today: string): string {
  if (point.span === 1) return formatDay(point.day)
  const end = addDays(point.day, point.span - 1)
  return `${formatShortDay(point.day, today)} – ${formatShortDay(end > today ? today : end, today)}`
}

function ChartFrame({
  title,
  readout,
  children,
  className
}: {
  title: ReactNode
  readout: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section className={`stats-chart ${className ?? ''}`}>
      <header className="stats-chart-head">
        <h3>{title}</h3>
        <span className="stats-readout k-num" aria-live="polite">
          {readout}
        </span>
      </header>
      {children}
    </section>
  )
}

/** Reading per day (or per week, for a long range), characters or time. */
export function DailyChart({
  series,
  metric,
  today,
  title
}: {
  series: DayPoint[]
  metric: Metric
  today: string
  title: ReactNode
}): JSX.Element {
  const [hovered, setHovered] = useState<number | null>(null)
  const max = Math.max(1, ...series.map((p) => value(p, metric)))
  const read = series.filter((p) => p.lines > 0)
  const average = read.length ? read.reduce((sum, p) => sum + value(p, metric), 0) / read.length : 0
  const per = series[0]?.span === 7 ? 'week' : 'day'
  const point = hovered === null ? null : series[hovered]
  return (
    <ChartFrame
      title={title}
      readout={
        point ? (
          <>
            <strong>{pointLabel(point, today)}</strong>
            <span>{describe(point, metric)}</span>
          </>
        ) : (
          <span>
            {read.length ? `${axis(average, metric)} a ${per} on ${per}s read` : `Nothing read in this range`}
          </span>
        )
      }
    >
      <div className="stats-plot">
        <span className="stats-plot-max k-num" aria-hidden>
          {axis(max, metric)}
        </span>
        <div
          className="stats-bars"
          data-dense={series.length > 60 || undefined}
          onPointerLeave={() => setHovered(null)}
          role="img"
          aria-label={`${title}: ${series.length} ${per}s`}
        >
          {series.map((p, i) => (
            <span
              key={p.day}
              className="stats-bar"
              data-hovered={i === hovered || undefined}
              data-current={i === series.length - 1 || undefined}
              onPointerEnter={() => setHovered(i)}
            >
              <span style={{ height: `${(value(p, metric) / max) * 100}%` }} />
            </span>
          ))}
        </div>
      </div>
      <div className="stats-axis k-num" aria-hidden>
        <span>{series.length ? formatShortDay(series[0].day, today) : ''}</span>
        <span>{per === 'week' ? 'This week' : 'Today'}</span>
      </div>
    </ChartFrame>
  )
}

/** Characters an hour over the same days (or weeks), where enough was read to say. */
export function SpeedChart({ series, today }: { series: DayPoint[]; today: string }): JSX.Element {
  const [hovered, setHovered] = useState<number | null>(null)
  const speeds = series.map((p) => speed(p))
  const known = speeds.filter((s): s is number => s !== null)
  const lo = known.length ? Math.min(...known) : 0
  const hi = known.length ? Math.max(...known) : 1
  const pad = Math.max(1, (hi - lo) * 0.15)
  const [min, max] = [Math.max(0, lo - pad), hi + pad]
  const n = series.length
  const x = (i: number): number => (n <= 1 ? 50 : (i / (n - 1)) * 100)
  const y = (s: number): number => 100 - ((s - min) / (max - min || 1)) * 100

  // One line through the days with a speed (days without one are passed over); a lone day is a dash.
  const paths: string[] = []
  const run: string[] = []
  speeds.forEach((s, i) => {
    if (s === null) return
    run.push(`${run.length ? 'L' : 'M'}${x(i).toFixed(2)},${y(s).toFixed(2)}`)
  })
  if (run.length) paths.push(run.join(' '))
  const lone = paths.filter((p) => !p.includes('L'))
  const total = series.reduce(
    (sum, p) => ({ chars: sum.chars + p.chars, ms: sum.ms + p.ms, lines: sum.lines + p.lines }),
    { chars: 0, ms: 0, lines: 0 }
  )
  const point = hovered === null ? null : series[hovered]

  return (
    <ChartFrame
      title="Speed"
      className="stats-chart-half"
      readout={
        point ? (
          <>
            <strong>{pointLabel(point, today)}</strong>
            <span>{formatSpeed(speeds[hovered!])}</span>
          </>
        ) : (
          <span>{formatSpeed(speed(total))} overall</span>
        )
      }
    >
      <div className="stats-plot">
        <span className="stats-plot-max k-num" aria-hidden>
          {known.length ? compact(hi) : ''}
        </span>
        <div className="stats-line" onPointerLeave={() => setHovered(null)}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            {paths
              .filter((p) => p.includes('L'))
              .map((d) => (
                <path key={d} d={d} vectorEffect="non-scaling-stroke" />
              ))}
            {lone.map((d) => {
              const [px, py] = d.slice(1).split(',').map(Number)
              return <path key={d} d={`M${px - 0.6},${py} L${px + 0.6},${py}`} vectorEffect="non-scaling-stroke" />
            })}
            {hovered !== null && speeds[hovered] !== null && (
              <line
                className="stats-line-cursor"
                x1={x(hovered)}
                x2={x(hovered)}
                y1={0}
                y2={100}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          <div className="stats-line-hit">
            {series.map((p, i) => (
              <span key={p.day} onPointerEnter={() => setHovered(i)} />
            ))}
          </div>
          {!known.length && <span className="stats-line-empty">Read a few more lines to see your speed</span>}
        </div>
      </div>
      <div className="stats-axis k-num" aria-hidden>
        <span>{series.length ? formatShortDay(series[0].day, today) : ''}</span>
        <span>{series[0]?.span === 7 ? 'This week' : 'Today'}</span>
      </div>
    </ChartFrame>
  )
}

const hourLabel = (h: number): string => `${String(h).padStart(2, '0')}:00`

/** Reading time by hour of the day, where each line was read. */
export function HoursChart({ hours }: { hours: Totals[] }): JSX.Element {
  const [hovered, setHovered] = useState<number | null>(null)
  const max = Math.max(1, ...hours.map((h) => h.ms))
  const peak = hours.reduce((best, h, i) => (h.ms > hours[best].ms ? i : best), 0)
  const point = hovered === null ? null : hours[hovered]
  return (
    <ChartFrame
      title="Time of day"
      className="stats-chart-half"
      readout={
        point ? (
          <>
            <strong>
              {hourLabel(hovered!)}–{hourLabel((hovered! + 1) % 24)}
            </strong>
            <span>{formatReadingTime(point.ms)}</span>
          </>
        ) : hours[peak].ms > 0 ? (
          <span>Mostly around {hourLabel(peak)}</span>
        ) : (
          <span>Nothing read in this range</span>
        )
      }
    >
      <div className="stats-plot">
        <div
          className="stats-bars stats-bars-hours"
          onPointerLeave={() => setHovered(null)}
          role="img"
          aria-label="Reading time by hour of day"
        >
          {hours.map((h, i) => (
            <span
              key={i}
              className="stats-bar"
              data-hovered={i === hovered || undefined}
              onPointerEnter={() => setHovered(i)}
            >
              <span style={{ height: `${(h.ms / max) * 100}%` }} />
            </span>
          ))}
        </div>
      </div>
      <div className="stats-axis stats-axis-hours k-num" aria-hidden>
        <span>0</span>
        <span>6</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </ChartFrame>
  )
}
