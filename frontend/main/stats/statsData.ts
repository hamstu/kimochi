/**
 * Where the Stats tab's data comes from. Native does the work (`reading_history_stats` and
 * `reading_history_kanji`, both off the UI thread); this keeps the last answers, so the tab opens
 * on them at once and refreshes behind them. Pointing at the Stats tab starts the first load
 * (`prefetchStats`), so it is usually ready by the click.
 *
 * Reloaded when the Log adds lines (a little later: it hands them to the history in batches) and
 * when a setting the rule follows changes (Settings → Log).
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getSnapshot, subscribe } from '@texthooker/bridge'
import { getSettings, onSettingsChange } from '@texthooker/lib/settings'
import type { KanjiStats, StatsSource } from './statsModel'

export type Loaded<T> =
  | { status: 'loading'; data?: undefined }
  | { status: 'error'; error: string; data?: undefined }
  | { status: 'ready'; data: T }

/** The rule's settings and this computer's zone, as both commands take them. */
function rules(): Record<string, unknown> {
  const s = getSettings()
  return {
    idleSec: s.afkThresholdSec,
    skipFastLines: s.skipFastLines,
    dayStartHour: s.dayStartHour,
    tz: -new Date().getTimezoneOffset()
  }
}
const rulesKey = (): string => JSON.stringify(rules())

// ------------------------------------------------------------------ stats

let source: Loaded<StatsSource> = { status: 'loading' }
let inflight: Promise<void> | null = null
let again = false
const listeners = new Set<() => void>()
const publish = (next: Loaded<StatsSource>): void => {
  source = next
  for (const listener of listeners) listener()
}

/** Ask native for the stats (once at a time; a call while one runs asks again after it). */
export function prefetchStats(): void {
  if (inflight) {
    again = true
    return
  }
  inflight = invoke<StatsSource>('reading_history_stats', rules())
    .then(
      (data) => publish({ status: 'ready', data }),
      (error: unknown) => {
        // A failed refresh keeps what is shown.
        if (source.status !== 'ready') publish({ status: 'error', error: String(error) })
      }
    )
    .finally(() => {
      inflight = null
      if (again) {
        again = false
        prefetchStats()
      }
    })
}

const RELOAD_AFTER_MS = 4_000

/** The stats, cached across visits to the tab, refreshed while it shows. */
export function useStatsSource(): Loaded<StatsSource> {
  const [state, setState] = useState(source)
  useEffect(() => {
    const update = (): void => setState(source)
    listeners.add(update)
    update()
    prefetchStats()
    let timer: ReturnType<typeof setTimeout> | null = null
    let seen: unknown = null
    try {
      seen = getSnapshot().lines
    } catch {
      // The Log is still loading: its first snapshot reloads once.
    }
    const stopLog = subscribe((snapshot) => {
      if (snapshot.lines === seen) return
      seen = snapshot.lines
      timer ??= setTimeout(() => {
        timer = null
        prefetchStats()
        kanjiCache.clear()
        kanjiVersion++
      }, RELOAD_AFTER_MS)
    })
    let ruleNow = rulesKey()
    const stopSettings = onSettingsChange(() => {
      if (rulesKey() === ruleNow) return
      ruleNow = rulesKey()
      kanjiCache.clear()
      kanjiVersion++
      prefetchStats()
    })
    return () => {
      listeners.delete(update)
      if (timer) clearTimeout(timer)
      stopLog()
      stopSettings()
    }
  }, [])
  return state
}

// ------------------------------------------------------------------ kanji

const kanjiCache = new Map<string, KanjiStats>()
/** Bumped when the history or the rule changes, so the hook asks again. */
let kanjiVersion = 0

/**
 * The kanji for `sessions` (all when null) since reading day `since` (all time when null), from
 * the cache when asked before. While a new answer is coming the last one stays, marked `stale`.
 */
export function useKanji(
  sessions: readonly string[] | null,
  since: string | null
): { state: Loaded<KanjiStats>; stale: boolean } {
  // `kanjiVersion` moves on with the history; the stats' reload re-renders the tab to see it.
  const key = JSON.stringify([sessions, since, kanjiVersion])
  const [last, setLast] = useState<{ key: string; loaded: Loaded<KanjiStats> } | null>(null)
  const hit = kanjiCache.get(key)
  useEffect(() => {
    if (kanjiCache.has(key)) return
    let alive = true
    invoke<KanjiStats>('reading_history_kanji', { ...rules(), sessions, since }).then(
      (data) => {
        kanjiCache.set(key, data)
        if (alive) setLast({ key, loaded: { status: 'ready', data } })
      },
      (error: unknown) => {
        if (alive) setLast({ key, loaded: { status: 'error', error: String(error) } })
      }
    )
    return () => {
      alive = false
    }
  }, [key, sessions, since])
  if (hit) return { state: { status: 'ready', data: hit }, stale: false }
  if (last?.key === key) return { state: last.loaded, stale: false }
  // Still coming: the last answer stays, dimmed, rather than the page jumping to a skeleton.
  if (last?.loaded.status === 'ready') return { state: last.loaded, stale: true }
  return { state: { status: 'loading' }, stale: false }
}

/** When a reading day starts (Settings → Log, `dayStartHour`). */
export function useDayStartHour(): number {
  const [hour, setHour] = useState(() => getSettings().dayStartHour)
  useEffect(() => onSettingsChange((next) => setHour(next.dayStartHour)), [])
  return hour
}
