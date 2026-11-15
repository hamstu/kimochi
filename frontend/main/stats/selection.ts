/**
 * Which sessions the Stats tab looks at: every session (null, the default) or the ones ticked in
 * its session picker. Kept for the life of the window, apart from the Log's open session, which
 * the rest of the app follows.
 */
import { useSyncExternalStore } from 'react'

let selected: readonly string[] | null = null
const listeners = new Set<() => void>()

export function getStatsSessions(): readonly string[] | null {
  return selected
}

/** Look at `ids`, or every session with null. */
export function setStatsSessions(ids: readonly string[] | null): void {
  selected = ids
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useStatsSessions(): readonly string[] | null {
  return useSyncExternalStore(subscribe, getStatsSessions)
}
