/**
 * The Stats tab: what has been read, from the reading history. A year of reading days leads (the
 * heatmap, with the current streak), then today, this week and all time, then the range's charts
 * (per day, speed, time of day), its sessions and the kanji met in it. Its footer's session picker
 * chooses which sessions count: every one by default.
 */
import { useEffect, useMemo, useState, type JSX } from 'react'
import { Bar, BarSpacer, EmptyState, Segmented, Spinner } from '@kit'
import { getManifest, subscribeSessions } from '@texthooker/lib/sessions'
import { formatReadingTime } from '@texthooker/lib/sessionSummary'
import { readingDay } from '@texthooker/lib/readingTime'
import { StatsSessionMenu, type StatsSessionOption } from '../SessionMenu'
import { DailyChart, HoursChart, SpeedChart, type Metric } from './Charts'
import { Heatmap } from './Heatmap'
import { compact, formatShortDay, formatSpeed, plural } from './format'
import { setStatsSessions, useStatsSessions } from './selection'
import {
  computeKanji,
  computeStats,
  speed,
  type Range,
  type ReadLine,
  type SessionStats,
  type Totals
} from './statsModel'
import { useReadingHistory } from './useReadingHistory'
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

/** The time now, moved on each minute so "today" turns over at 4 am with the tab open. */
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
        {primary ? plural(totals.lines, 'line') : `${formatReadingTime(totals.ms)} · ${plural(totals.lines, 'line')}`}
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
                {formatShortDay(readingDay(s.last), today)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function KanjiSection({ lines, range, now }: { lines: ReadLine[]; range: Range; now: number }): JSX.Element {
  const kanji = useMemo(() => computeKanji(lines, { range, now }), [lines, range, now])
  const max = kanji.top[0]?.count ?? 1
  return (
    <section className="stats-section">
      <header className="stats-chart-head">
        <h3>Kanji</h3>
        <span className="stats-readout k-num">
          <span>{kanji.distinct.toLocaleString()} kanji met</span>
          {range !== 'all' && kanji.distinct > 0 && <span>{kanji.fresh.toLocaleString()} for the first time</span>}
        </span>
      </header>
      {kanji.top.length === 0 ? (
        <p className="stats-quiet">No kanji in this range.</p>
      ) : (
        <ol className="stats-kanji" aria-label="Most read kanji">
          {kanji.top.map((k) => (
            <li
              key={k.kanji}
              title={`${k.kanji}: read ${plural(k.count, 'time')}${k.fresh && range !== 'all' ? ', first met in this range' : ''}`}
              data-level={Math.ceil((k.count / max) * 4)}
              data-fresh={(k.fresh && range !== 'all') || undefined}
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

export function StatsPanel(): JSX.Element {
  const state = useReadingHistory()
  const selected = useStatsSessions()
  const [range, setRange] = useState<Range>('month')
  const [metric, setMetric] = useState<Metric>('chars')
  const [manifest, setManifest] = useState(getManifest)
  useEffect(() => subscribeSessions(setManifest), [])
  const now = useNow()
  const today = readingDay(now)

  const history = state.status === 'ready' ? state.history : null
  // Every session in the list, then the deleted ones the history still has.
  const options = useMemo<StatsSessionOption[]>(() => {
    const out: StatsSessionOption[] = manifest.sessions.map((s) => ({ id: s.id, name: s.name }))
    const listed = new Set(out.map((o) => o.id))
    for (const [id, name] of history?.names ?? []) if (!listed.has(id)) out.push({ id, name, deleted: true })
    return out
  }, [manifest, history])
  const names = useMemo(() => new Map(options.map((o) => [o.id, o.name])), [options])
  const picked = useMemo(() => (selected ? new Set(selected) : null), [selected])
  const lines = useMemo(
    () => (history ? (picked ? history.lines.filter((l) => picked.has(l.session)) : history.lines) : []),
    [history, picked]
  )
  const stats = useMemo(() => computeStats(lines, { sessions: null, range, now, names }), [lines, range, now, names])

  let body: JSX.Element
  if (state.status === 'loading') {
    body = (
      <div className="stats-center">
        <Spinner label="Loading stats" />
      </div>
    )
  } else if (state.status === 'error') {
    body = (
      <div className="stats-center">
        <EmptyState title="Couldn't read the reading history">{state.error}</EmptyState>
      </div>
    )
  } else if (history && history.lines.length === 0) {
    body = (
      <div className="stats-center">
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
    body = (
      <div className="stats-page">
        <Heatmap days={stats.days} streaks={stats.streaks} today={today} />
        <div className="stats-figures">
          <Figure label="Today" totals={stats.today} />
          <Figure label="This week" totals={stats.week} />
          <Figure label="All time" totals={stats.all} />
          <Figure label="Speed" totals={stats.all} primary={formatSpeed(speed(stats.all))} />
        </div>
        <div className="stats-range">
          <h2>{RANGE_TITLE[range]}</h2>
          <span className="stats-range-totals k-num">
            {plural(stats.range.chars, 'character')} · {formatReadingTime(stats.range.ms)}
          </span>
          <Segmented value={range} onValueChange={setRange} options={RANGES} aria-label="Range" />
        </div>
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
        <div className="stats-pair">
          <SpeedChart series={stats.series} today={today} />
          <HoursChart hours={stats.hours} />
        </div>
        <SessionTable sessions={stats.sessions} today={today} />
        <KanjiSection lines={lines} range={range} now={now} />
      </div>
    )
  }

  const first = lines[0]
  return (
    <div className="stats-view">
      <div className="stats-scroll">{body}</div>
      <Bar position="bottom" className="stats-foot">
        {lines.length > 0 && (
          <span className="log-stats k-num">
            <span className="log-stat">
              <span className="log-stat-value">{lines.length.toLocaleString()}</span>
              <span>{lines.length === 1 ? 'line' : 'lines'}</span>
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
