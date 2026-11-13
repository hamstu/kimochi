/**
 * The activity ticker: what just happened, at the foot of the Log.
 *
 * A scan can take seconds to land and can end without a line (nothing read, a repeat, a
 * replaced frame, a model still downloading), and from the Log all of those used to look the
 * same: nothing. The ticker says which, then gets out of the way:
 *
 * - Scanning by hand, it is a toast: it shows when something happens and fades a few seconds
 *   after (longer while a scan is still busy). Hovering it, or opening its history (a click),
 *   keeps it; it fades again once the pointer leaves or the history closes.
 * - While Auto OCR runs, scans happen all the time, so it does not report each one: it stays as a
 *   small "Auto OCR is running" with a live dot, and shows only a warning or an error, for a few
 *   seconds, in place of that.
 *
 * Its dots animate only while the window is in front and showing. The cog at its end opens its
 * setting (Settings → Log & Sessions → Activity ticker), where it can be turned off.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Settings2 } from 'lucide-react'
import { Badge, IconButton, StatusDot, Tooltip, cn, type Tone } from '@kit'
import { relativeTime } from '@ui/activity'
import { useActivity, useNow, type ActivityEntry, type ActivityTone } from '../../bridge/activity'
import { openSettings } from '../../bridge/tauri'
import { ACTIVITY_TICKER_SECTION, requestSettingsSection } from '../../bridge/settingsTarget'
import '../activity.css'

/** How long a toast shows after its last change; a busy one (a scan running) waits longer. */
const TOAST_MS = 5000
const BUSY_MS = 30000

/** An entry's identity for showing: a repeat (its count) or a new tone wakes the toast again. */
const stampOf = (entry: ActivityEntry | null): string | null =>
  entry ? `${entry.id}:${entry.count}:${entry.lastAt}:${entry.tone}` : null

/** True while this window is in front and showing: the ticker's dots animate only then. */
function useWindowActive(visible: boolean): boolean {
  const read = (): boolean => document.hasFocus() && document.visibilityState === 'visible'
  const [active, setActive] = useState(read)
  useEffect(() => {
    const update = (): void => setActive(read())
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  return active && visible
}

const DOT_TONE: Record<ActivityTone, Tone> = {
  info: 'neutral',
  busy: 'accent',
  ok: 'ok',
  warn: 'warn',
  error: 'danger'
}

function ActivityDot({ tone }: { tone: ActivityTone }): ReactNode {
  return <StatusDot tone={DOT_TONE[tone]} className={cn('activity-dot', tone === 'busy' && 'activity-dot-busy')} />
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
            <li className="activity-instances-more">and {entry.count - entry.times.length} earlier</li>
          )}
        </ol>
      )}
    </li>
  )
}

export function ActivityTicker({ visible, auto }: { visible: boolean; auto: boolean }): ReactNode {
  const entries = useActivity()
  const latest = entries.at(-1) ?? null
  const active = useWindowActive(visible)
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const panelId = useId()
  // The newest time is the one that needs a fresh clock most; the rest ride along.
  const now = useNow(latest?.lastAt ?? null, visible && open)

  // The toast shows until its entry, unchanged, has been up long enough. What was there when the
  // Log opened has already been seen (or never mattered): it does not pop up.
  const stamp = stampOf(latest)
  const [settled, setSettled] = useState<string | null>(() => stamp)
  const fresh = stamp !== null && stamp !== settled
  useEffect(() => {
    if (!fresh || open || hovered) return
    const timer = window.setTimeout(() => setSettled(stamp), latest?.tone === 'busy' ? BUSY_MS : TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [fresh, open, hovered, stamp, latest?.tone])

  // With Auto OCR on, only a fresh warning or error takes the ticker's place.
  const alert = fresh && (latest?.tone === 'warn' || latest?.tone === 'error') ? latest : null
  const message = auto ? alert : fresh ? latest : null
  const shown = auto || open || message !== null

  // The text that was showing, kept for the length of its exit when a new one arrives.
  const key = message ? `m-${message.id}` : auto ? 'auto' : null
  const text = message ? message.text : 'Auto OCR is running'
  const [leaving, setLeaving] = useState<{ key: string; text: string } | null>(null)
  const [current, setCurrent] = useState<{ key: string | null; text: string }>({ key, text })
  if (current.key !== key) {
    setLeaving(current.key && key ? { key: current.key, text: current.text } : null)
    setCurrent({ key, text })
  } else if (current.text !== text) {
    setCurrent({ key, text })
  }

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
      // A synthetic pointer event from an injected host script can target `window` (not a Node),
      // which `contains` rejects with a TypeError. Anything that is not inside the panel closes it.
      const target = event.target
      if (!(target instanceof Node) || !root.current?.contains(target)) setOpen(false)
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

  if (!latest && !auto) return null
  const dot = message ? <ActivityDot tone={message.tone} /> : <span className="activity-live-dot" aria-hidden />
  return (
    <div
      ref={root}
      className="activity"
      data-open={open || undefined}
      data-mode={auto && !open ? 'auto' : 'toast'}
      data-hidden={shown ? undefined : ''}
      data-idle={active ? undefined : ''}
      aria-hidden={shown ? undefined : true}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <div className="activity-bar">
        <button
          ref={toggle}
          type="button"
          className="activity-ticker"
          tabIndex={shown ? undefined : -1}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${text}. ${open ? 'Hide' : 'Show'} recent activity`}
          onClick={() => setOpen(latest ? !open : false)}
        >
          {dot}
          <span className="activity-viewport">
            {leaving && (
              <span
                key={`out-${leaving.key}`}
                className="activity-text activity-text-out"
                aria-hidden
                onAnimationEnd={() => setLeaving(null)}
              >
                {leaving.text}
              </span>
            )}
            <span key={key ?? 'none'} className={cn('activity-text', leaving && 'activity-text-in')}>
              {text}
            </span>
          </span>
          {message ? <Count count={message.count} /> : null}
          {message && open ? <When at={message.lastAt} now={now} /> : null}
        </button>
        <Tooltip content="Activity ticker settings">
          <IconButton
            label="Activity ticker settings"
            size="sm"
            className="activity-cog"
            tabIndex={shown ? undefined : -1}
            onClick={() => {
              setOpen(false)
              requestSettingsSection(ACTIVITY_TICKER_SECTION)
              void openSettings('log')
            }}
          >
            <Settings2 />
          </IconButton>
        </Tooltip>
      </div>
      {message ? (
        <span role="status" className="sr-only">
          {message.text}
        </span>
      ) : null}
      {open && latest && (
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
