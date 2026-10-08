/**
 * The activity ticker: the last thing that happened, floating at the foot of the Log.
 *
 * A scan can take seconds to land and can end without a line (nothing read, a repeat, a
 * replaced frame, a model still downloading), and from the Log all of those used to look the
 * same: nothing. The ticker says which. It stays hidden until this window's first activity and
 * then always shows the newest entry; clicking it opens the recent history above it.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Badge, StatusDot, cn, type Tone } from '@kit'
import { relativeTime } from '@ui/activity'
import { useActivity, useNow, type ActivityEntry, type ActivityTone } from '../../bridge/activity'
import '../activity.css'

const DOT_TONE: Record<ActivityTone, Tone> = {
  info: 'neutral',
  busy: 'accent',
  ok: 'ok',
  warn: 'warn',
  error: 'danger'
}

function ActivityDot({ tone }: { tone: ActivityTone }): ReactNode {
  return (
    <StatusDot
      tone={DOT_TONE[tone]}
      className={cn('activity-dot', tone === 'busy' && 'activity-dot-busy')}
    />
  )
}

const Count = ({ count }: { count: number }): ReactNode =>
  count > 1 ? (
    <Badge className="activity-count k-num" aria-label={`${count} times`}>
      ×{count}
    </Badge>
  ) : null

function When({ at, now }: { at: number; now: number }): ReactNode {
  return (
    <time className="activity-time k-num" dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
      {relativeTime(at, now)}
    </time>
  )
}

function HistoryRow({ entry, now }: { entry: ActivityEntry; now: number }): ReactNode {
  const [open, setOpen] = useState(false)
  const instances = useId()
  const repeated = entry.count > 1
  return (
    <li className="activity-row" data-tone={entry.tone}>
      <div className="activity-row-main">
        {repeated ? (
          <button
            type="button"
            className="activity-disclosure"
            aria-expanded={open}
            aria-controls={instances}
            aria-label={open ? 'Hide each time' : 'Show each time'}
            onClick={() => setOpen(!open)}
          >
            <ChevronRight aria-hidden />
          </button>
        ) : (
          <span className="activity-disclosure-space" aria-hidden />
        )}
        <ActivityDot tone={entry.tone} />
        <span className="activity-row-text">{entry.text}</span>
        <Count count={entry.count} />
        <When at={entry.lastAt} now={now} />
      </div>
      {repeated && open && (
        <ol id={instances} className="activity-instances">
          {entry.times.map((at, index) => (
            <li key={index}>
              <When at={at} now={now} />
            </li>
          ))}
          {entry.count > entry.times.length && (
            <li className="activity-instances-more">
              and {entry.count - entry.times.length} earlier
            </li>
          )}
        </ol>
      )}
    </li>
  )
}

export function ActivityTicker({ visible }: { visible: boolean }): ReactNode {
  const entries = useActivity()
  const latest = entries.at(-1) ?? null
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const panelId = useId()
  // The newest time is the one that needs a fresh clock most; the rest ride along.
  const now = useNow(latest?.lastAt ?? null, visible)

  // The text that was showing, kept for the length of its exit when a new entry arrives.
  const [shown, setShown] = useState<{ id: number | null; leaving: ActivityEntry | null }>({
    id: null,
    leaving: null
  })
  const [previous, setPrevious] = useState<ActivityEntry | null>(null)
  if (latest && latest.id !== shown.id) {
    setShown({ id: latest.id, leaving: shown.id === null ? null : previous })
  }
  if (latest !== previous) setPrevious(latest)

  // Escape or a click anywhere else closes the history.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      toggle.current?.focus()
    }
    const onPointer = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onPointer, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onPointer, true)
    }
  }, [open])

  // Opened on the newest, which is at the bottom, next to the ticker.
  useLayoutEffect(() => {
    if (open && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [open, entries.length])

  if (!latest) return null
  return (
    <div ref={root} className="activity" data-open={open || undefined}>
      <button
        ref={toggle}
        type="button"
        className="activity-ticker"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${latest.text}. ${open ? 'Hide' : 'Show'} recent activity`}
        onClick={() => setOpen(!open)}
      >
        <ActivityDot tone={latest.tone} />
        <span className="activity-viewport">
          {shown.leaving && (
            <span
              key={`out-${shown.leaving.id}`}
              className="activity-text activity-text-out"
              aria-hidden
              onAnimationEnd={() => setShown((s) => ({ ...s, leaving: null }))}
            >
              {shown.leaving.text}
            </span>
          )}
          <span key={latest.id} className={cn('activity-text', shown.leaving && 'activity-text-in')}>
            {latest.text}
          </span>
        </span>
        <Count count={latest.count} />
        <When at={latest.lastAt} now={now} />
      </button>
      <span role="status" className="sr-only">
        {latest.text}
      </span>
      {open && (
        <div id={panelId} className="activity-panel" role="region" aria-label="Recent activity">
          <ol ref={list} className="activity-list">
            {entries.map((entry) => (
              <HistoryRow key={entry.id} entry={entry} now={now} />
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
