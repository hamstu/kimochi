/**
 * A dictionary-engine switch waiting for its download ("Use when downloaded"), which native owns
 * (`src-tauri/src/dictionary_switch.rs`; COMMANDS.md → Dictionary engine downloads). The pending
 * engine is the machine setting `dictionaryEnginePending`, so every window follows it; native
 * starts its download, makes the switch once the download is ready (whatever window is open, or
 * none, and across a restart), and drops it when the download is cancelled.
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isExtensionEngine, type ExtensionEngine } from '@ui/extension-download'
import { useSetting } from './useSetting'
import { onEvent } from './tauri'

/** The setting native keeps the pending engine in. */
export const PENDING_SWITCH_KEY = 'dictionaryEnginePending'
/** The event native sends when it makes the switch, just before the reader windows reload. */
export const SWITCH_EVENT = 'dictionary-switch'

export interface DictionarySwitchState {
  pending: ExtensionEngine | null
  /** The last switch native made this session, epoch ms. */
  switched: { engine: ExtensionEngine; at: number } | null
}

function normalizeState(raw: unknown): DictionarySwitchState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const switched = (r.switched && typeof r.switched === 'object' ? r.switched : null) as Record<string, unknown> | null
  return {
    pending: isExtensionEngine(r.pending) ? r.pending : null,
    switched:
      switched && isExtensionEngine(switched.engine) && typeof switched.at === 'number'
        ? { engine: switched.engine, at: switched.at }
        : null
  }
}

/**
 * Records `engine` as the switch that waits for its download and starts (resumes, retries) that
 * download; one already ready is switched to at once. Null clears it, leaving the download alone.
 */
export const queueDictionarySwitch = (engine: ExtensionEngine | null): Promise<DictionarySwitchState> =>
  invoke('dictionary_switch_queue', { engine }).then(normalizeState)

export const dictionarySwitchState = (): Promise<DictionarySwitchState> =>
  invoke('dictionary_switch_state').then(normalizeState)

/** The engine waiting for its download, live (null when none). */
export function usePendingSwitch(): ExtensionEngine | null {
  const [value] = useSetting<unknown>(PENDING_SWITCH_KEY, null)
  return isExtensionEngine(value) ? value : null
}

/**
 * The engine native switched to within the last `withinMs`: announced as it happens
 * (`dictionary-switch`), and asked for once on mount, for a window the switch just reloaded.
 */
export function useBackgroundSwitch(withinMs: number): ExtensionEngine | null {
  const [switched, setSwitched] = useState<ExtensionEngine | null>(null)
  useEffect(() => {
    let alive = true
    let unlisten: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    // Shown until `withinMs` after it happened.
    const show = (engine: ExtensionEngine, at: number): void => {
      const left = at + withinMs - Date.now()
      if (!alive || left <= 0) return
      clearTimeout(timer)
      setSwitched(engine)
      timer = setTimeout(() => setSwitched(null), left)
    }
    dictionarySwitchState().then(
      (state) => state.switched && show(state.switched.engine, state.switched.at),
      () => undefined
    )
    try {
      onEvent<unknown>(SWITCH_EVENT, (payload) => {
        const engine = (payload as { engine?: unknown } | null)?.engine
        if (isExtensionEngine(engine)) show(engine, Date.now())
      })
        .then((stop) => (alive ? (unlisten = stop) : stop()))
        .catch(() => undefined)
    } catch {
      // No event bridge (a plain browser).
    }
    return () => {
      alive = false
      clearTimeout(timer)
      unlisten?.()
    }
  }, [withinMs])
  return switched
}
