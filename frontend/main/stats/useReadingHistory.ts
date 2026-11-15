/**
 * The reading history for the Stats tab (`reading_history_lines`), credited once by the
 * reading-time rule. Loaded when the tab opens, and again a little after the Log adds lines while
 * it is open (the Log hands its lines to the history in batches a second apart).
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getSnapshot, subscribe } from '@texthooker/bridge'
import { getSettings } from '@texthooker/lib/settings'
import { readLines, STATS_FIELDS, type HistoryLine, type ReadLine } from './statsModel'

export interface ReadingHistory {
  lines: ReadLine[]
  /** Every session the history has, by id: the name it was last read under. */
  names: Map<string, string>
}

export type HistoryState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; history: ReadingHistory }

const RELOAD_AFTER_MS = 4_000

export async function loadReadingHistory(): Promise<ReadingHistory> {
  const raw = await invoke<HistoryLine[]>('reading_history_lines', { fields: STATS_FIELDS })
  const names = new Map<string, string>()
  for (const line of raw) names.set(line.session, line.sessionName)
  const ceilingMs = Math.max(10, getSettings().afkThresholdSec) * 1000
  return { lines: readLines(raw, ceilingMs), names }
}

export function useReadingHistory(): HistoryState {
  const [state, setState] = useState<HistoryState>({ status: 'loading' })
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = (): void => {
      loadReadingHistory().then(
        (history) => alive && setState({ status: 'ready', history }),
        (error: unknown) =>
          alive && setState((s) => (s.status === 'ready' ? s : { status: 'error', error: String(error) }))
      )
    }
    load()
    // A new or changed line changes the Log's lines; the notebook and settings don't count.
    let seen: unknown = null
    try {
      seen = getSnapshot().lines
    } catch {
      // The Log is still loading: its first snapshot reloads once.
    }
    const stop = subscribe((snapshot) => {
      if (snapshot.lines === seen) return
      seen = snapshot.lines
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        load()
      }, RELOAD_AFTER_MS)
    })
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      stop()
    }
  }, [])
  return state
}
