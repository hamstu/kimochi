/**
 * The Stats tab: what has been read, from the reading history. A year of reading days leads (the
 * heatmap, with the current streak), then today, this week and all time, then the range's charts
 * (per day, speed, time of day), its sessions and the kanji met in it. Its footer's session picker
 * chooses which sessions count: every one by default.
 */
import { useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react'
import { Bar, BarSpacer, EmptyState, Segmented } from '@kit'
import { getManifest, subscribeSessions } from '@texthooker/lib/sessions'
import { formatReadingTime } from '@texthooker/lib/sessionSummary'
import { readingDay } from '@texthooker/lib/readingTime'
import { StatsSessionMenu, type StatsSessionOption } from '../SessionMenu'
import { DailyChart, HoursChart, SpeedChart, type Metric } from './Charts'
import { Heatmap } from './Heatmap'
import { compact, formatShortDay, formatSpeed, plural } from './format'
import { setStatsSessions, useStatsSessions } from './selection'
import { computeStats, rangeStart, speed, type Range, type SessionStats, type Totals } from './statsModel'
import { useDayStartHour, useKanji, useStatsSource } from './statsData'
import './stats.css'

const RANGES: { value: Range; label: string }[] = [
  { value: 'week', label: '7 days' },
  { value: 'month', label: '30 days' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All time' }
]
const RANGE_TITLE: Record<Range, string> = {
  week: 'The last 7 days',
  month: 'The last 30 days',
  year: 'The last year',
  all: 'All time'
}

/** The time now, moved on each minute so "today" turns over with the tab open. */
function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}

function Figure({ label, totals, primary }: { label: string; totals: Totals; primary?: string }): JSX.Element {
  return (
    <div className="stats-figure">
      <span className="stats-figure-label">{label}</span>
      <span className="stats-figure-value k-num">{primary ?? totals.chars.toLocaleString()}</span>
      <span className="stats-figure-detail k-num">
        {primary ? 'characters an hour, all time' : `${formatReadingTime(totals.ms)} · ${plural(totals.lines, 'line')}`}
      </span>
    </div>
  )
}

function SessionTable({ sessions, today }: { sessions: SessionStats[]; today: string }): JSX.Element {
  const max = Math.max(1, ...sessions.map((s) => s.chars))
  return (
    <section className="stats-section">
      <header className="stats-chart-head">
        <h3>Sessions</h3>
        <span className="stats-readout">{plural(sessions.length, 'session')}</span>
      </header>
      {sessions.length === 0 ? (
        <p className="stats-quiet">Nothing read in this range.</p>
      ) : (
        <div className="stats-table" role="table" aria-label="Reading by session">
          <div className="stats-table-row stats-table-head" role="row">
            <span role="columnheader">Session</span>
            <span role="columnheader">Characters</span>
            <span role="columnheader">Time</span>
            <span role="columnheader">Speed</span>
            <span role="columnheader">Last read</span>
          </div>
          {sessions.map((s) => (
            <div key={s.id} className="stats-table-row" role="row">
              <span role="cell" className="stats-table-name">
                <span className="stats-table-label">{s.name}</span>
                <span className="stats-table-share" aria-hidden>
                  <span style={{ width: `${(s.chars / max) * 100}%` }} />
                </span>
              </span>
              <span role="cell" className="k-num">
                {s.chars.toLocaleString()}
              </span>
              <span role="cell" className="k-num">
                {formatReadingTime(s.ms)}
              </span>
              <span role="cell" className="k-num">
                {formatSpeed(speed(s))}
              </span>
              <span role="cell" className="k-num stats-table-faint">
                {formatShortDay(s.lastDay, today)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function KanjiSection({
  sessions,
  range,
  today
}: {
  sessions: readonly string[] | null
  range: Range
  today: string
}): JSX.Element {
  const since = range === 'all' ? null : rangeStart(range, today, undefined)
  const { state, stale } = useKanji(sessions, since)
  const kanji = state.data
  const max = kanji?.top[0]?.count ?? 1
  // "First met" says something only when some of the range's kanji were met before it.
  const showFresh = Boolean(kanji && range !== 'all' && kanji.fresh < kanji.distinct)
  return (
    <section className="stats-section" aria-busy={state.status === 'loading' || stale}>
      <header className="stats-chart-head">
        <h3>Kanji</h3>
        {kanji && (
          <span className="stats-readout k-num stats-fade-in">
            <span>{kanji.distinct.toLocaleString()} kanji met</span>
            {showFresh && <span>{kanji.fresh.toLocaleString()} for the first time</span>}
          </span>
        )}
      </header>
      {state.status === 'loading' ? (
        <ol className="stats-kanji" aria-hidden>
          {Array.from({ length: 30 }, (_, i) => (
            <li key={i} className="stats-skeleton-tile" style={{ '--i': i } as CSSProperties} />
          ))}
        </ol>
      ) : state.status === 'error' ? (
        <p className="stats-quiet">{state.error}</p>
      ) : kanji && kanji.top.length === 0 ? (
        <p className="stats-quiet">No kanji in this range.</p>
      ) : (
        <ol className="stats-kanji stats-fade-in" aria-label="Most read kanji" data-stale={stale || undefined}>
          {kanji?.top.map((k) => (
            <li
              key={k.kanji}
              title={`${k.kanji}: read ${plural(k.count, 'time')}${k.fresh && showFresh ? ', first met in this range' : ''}`}
              data-level={Math.ceil((k.count / max) * 4)}
              data-fresh={(k.fresh && showFresh) || undefined}
            >
              <span className="stats-kanji-glyph" lang="ja">
                {k.kanji}
              </span>
              <span className="stats-kanji-count k-num">{compact(k.count)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** The page's shape while the first numbers come: the heatmap's squares in a slow wave, quiet bars. */
function StatsSkeleton(): JSX.Element {
  return (
    <div className="stats-page stats-skeleton" role="status" aria-label="Loading stats">
      <section className="stats-heatmap">
        <header className="stats-heatmap-head">
          <span className="stats-skeleton-bar" style={{ width: '8rem', height: 'var(--k-leading-xl)' }} />
          <span className="stats-skeleton-bar" style={{ width: '11rem' }} />
        </header>
        <div className="stats-skeleton-grid">
          {Array.from({ length: 53 * 7 }, (_, i) => (
            <span key={i} style={{ '--w': Math.floor(i / 7) } as CSSProperties} />
          ))}
        </div>
      </section>
      <div className="stats-figures">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="stats-figure">
            <span className="stats-skeleton-bar" style={{ width: '3rem' }} />
            <span className="stats-skeleton-bar" style={{ width: '5.5rem', height: 'var(--k-leading-xl)' }} />
            <span className="stats-skeleton-bar" style={{ width: '7rem' }} />
          </div>
        ))}
      </div>
      <div className="stats-skeleton-chart" />
    </div>
  )
}

export function StatsPanel(): JSX.Element {
  const state = useStatsSource()
  // The first numbers fade in over the skeleton; numbers kept from a visit before show at once.
  const [reveal] = useState(() => state.status !== 'ready')
  const selected = useStatsSessions()
  const [range, setRange] = useState<Range>('month')
  const [metric, setMetric] = useState<Metric>('chars')
  const [manifest, setManifest] = useState(getManifest)
  useEffect(() => subscribeSessions(setManifest), [])
  const now = useNow()
  const today = readingDay(now, undefined, useDayStartHour())

  const source = state.status === 'ready' ? state.data : null
  // Every session in the list, then the deleted ones the history still has.
  const options = useMemo<StatsSessionOption[]>(() => {
    const out: StatsSessionOption[] = manifest.sessions.map((s) => ({ id: s.id, name: s.name }))
    const listed = new Set(out.map((o) => o.id))
    for (const { id, name } of source?.sessions ?? []) if (!listed.has(id)) out.push({ id, name, deleted: true })
    return out
  }, [manifest, source])
  const names = useMemo(() => new Map(options.map((o) => [o.id, o.name])), [options])
  const buckets = useMemo(() => {
    if (!source) return []
    if (!selected) return source.buckets
    const picked = new Set(selected)
    return source.buckets.filter((b) => picked.has(b.session))
  }, [source, selected])
  const stats = useMemo(() => computeStats(buckets, { range, today, names }), [buckets, range, today, names])

  let body: JSX.Element
  if (state.status === 'loading') {
    body = <StatsSkeleton />
  } else if (state.status === 'error') {
    body = (
      <div className="stats-center">
        <EmptyState title="Couldn't read the reading history">{state.error}</EmptyState>
      </div>
    )
  } else if (source && source.buckets.length === 0) {
    body = (
      <div className="stats-center stats-fade-in">
        <EmptyState title="No reading yet">
          Lines you read in the Log are counted here: days, streaks, speed and more.
        </EmptyState>
      </div>
    )
  } else if (selected && selected.length === 0) {
    body = (
      <div className="stats-center">
        <EmptyState title="No sessions counted">Choose sessions in the menu at the bottom right.</EmptyState>
      </div>
    )
  } else {
    const step = (i: number): CSSProperties => ({ '--i': i }) as CSSProperties
    body = (
      <div className="stats-page" data-reveal={reveal || undefined}>
        <div style={step(0)}>
          <Heatmap days={stats.days} streaks={stats.streaks} today={today} />
        </div>
        <div className="stats-figures" style={step(1)}>
          <Figure label="Today" totals={stats.today} />
          <Figure label="This week" totals={stats.week} />
          <Figure label="All time" totals={stats.all} />
          <Figure label="Speed" totals={stats.all} primary={formatSpeed(speed(stats.all))} />
        </div>
        <div className="stats-range" style={step(2)}>
          <h2>{RANGE_TITLE[range]}</h2>
          <span className="stats-range-totals k-num">
            {plural(stats.range.chars, 'character')} · {formatReadingTime(stats.range.ms)}
          </span>
          <Segmented value={range} onValueChange={setRange} options={RANGES} aria-label="Range" />
        </div>
        <div style={step(3)}>
          <DailyChart
            series={stats.series}
            metric={metric}
            today={today}
            title={
              <span className="stats-metric">
                <Segmented
                  value={metric}
                  onValueChange={setMetric}
                  options={[
                    { value: 'chars', label: 'Characters' },
                    { value: 'ms', label: 'Time' }
                  ]}
                  aria-label="Show"
                />
                <span>{stats.series[0]?.span === 7 ? 'per week' : 'per day'}</span>
              </span>
            }
          />
        </div>
        <div className="stats-pair" style={step(4)}>
          <SpeedChart series={stats.series} today={today} />
          <HoursChart hours={stats.hours} />
        </div>
        <div style={step(5)}>
          <SessionTable sessions={stats.sessions} today={today} />
        </div>
        <div style={step(6)}>
          <KanjiSection sessions={selected} range={range} today={today} />
        </div>
      </div>
    )
  }

  const first = buckets[0]
  return (
    <div className="stats-view">
      <div className="stats-scroll">{body}</div>
      <Bar position="bottom" className="stats-foot">
        {stats.all.lines > 0 && (
          <span className="log-stats k-num stats-fade-in">
            <span className="log-stat">
              <span className="log-stat-value">{stats.all.lines.toLocaleString()}</span>
              <span>{stats.all.lines === 1 ? 'line' : 'lines'}</span>
            </span>
            {first && (
              <span className="log-stat">
                <span>since</span>
                <span className="log-stat-value">{formatShortDay(first.day, today)}</span>
              </span>
            )}
          </span>
        )}
        <BarSpacer />
        <StatsSessionMenu options={options} selected={selected} onSelect={setStatsSessions} />
      </Bar>
    </div>
  )
}
