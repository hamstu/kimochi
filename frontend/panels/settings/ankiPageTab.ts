/**
 * Which tab Settings → Anki shows: AnkiConnect, Mining (adding cards) or Card enhancement
 * (sentence audio). Kept for the window's life, so a link elsewhere in the main window (the
 * sidebar's Enhance Anki cards cog) can choose it before Settings opens.
 */
import { useSyncExternalStore } from 'react'

export type AnkiTabName = 'connect' | 'mining' | 'enhance'

let current: AnkiTabName = 'connect'
const listeners = new Set<() => void>()

export function showAnkiTab(tab: AnkiTabName): void {
  if (tab === current) return
  current = tab
  for (const listener of listeners) listener()
}

export function useAnkiTab(): [AnkiTabName, (tab: AnkiTabName) => void] {
  const tab = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current
  )
  return [tab, showAnkiTab]
}
