/**
 * The platform capabilities (`platform_capabilities`, re-sent as `platform-capabilities`), loaded
 * once per window and shared by every component in it.
 *
 * Never throws and never leaves a caller without an answer: until native replies, and for ever on
 * a backend that predates the command, the value is the macOS default (`DEFAULT_CAPABILITIES_MACOS`
 * in `ui/capabilities.ts`, the one place it is written down).
 */
import { useEffect, useSyncExternalStore } from 'react'
import {
  DEFAULT_CAPABILITIES_MACOS,
  fallbackCapabilities,
  normalizeCapabilities,
  type PlatformCapabilities
} from '@ui/capabilities'
import { onEvent, platformCapabilities } from './tauri'

export { DEFAULT_CAPABILITIES_MACOS }
export type { PlatformCapabilities }

let current: PlatformCapabilities = fallbackCapabilities()
const subscribers = new Set<() => void>()
let loading: Promise<PlatformCapabilities> | null = null
let watching = false
/** Set once a re-emit has arrived: it is newer than any reply still in flight. */
let pushed = false

function set(next: PlatformCapabilities): void {
  current = next
  for (const notify of subscribers) notify()
}

/** The value right now: the loaded capabilities, or the default while they are unknown. */
export const currentCapabilities = (): PlatformCapabilities => current

/** Follow `platform-capabilities` re-emits (a permission granted, a session change). */
function watch(): void {
  if (watching) return
  watching = true
  try {
    onEvent<unknown>('platform-capabilities', (payload) => {
      pushed = true
      set(normalizeCapabilities(payload))
    }).catch(() => undefined)
  } catch {
    // No event bridge (a plain browser): the first answer stands.
  }
}

/** Ask native once; later calls share the answer. Resolves to the default if the command is absent. */
export function loadCapabilities(): Promise<PlatformCapabilities> {
  watch()
  loading ??= (async () => {
    try {
      const reply = normalizeCapabilities(await platformCapabilities())
      if (!pushed) set(reply)
    } catch {
      // An older backend without the command, or no backend at all: keep today's macOS default.
    }
    return current
  })()
  return loading
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => subscribers.delete(notify)
}

/** Steam Deck Gaming Mode (Gamescope): one app on screen at a time, so a picture of the
 * screen is a picture of Kimochi. */
export const isGamingMode = (capabilities: PlatformCapabilities): boolean =>
  capabilities.os === 'linux' && capabilities.session?.compositor?.toLowerCase() === 'gamescope'

/** The capabilities, re-rendering when native reports a change. Starts on the macOS default. */
export function useCapabilities(): PlatformCapabilities {
  useEffect(() => {
    void loadCapabilities()
  }, [])
  return useSyncExternalStore(subscribe, currentCapabilities, currentCapabilities)
}
