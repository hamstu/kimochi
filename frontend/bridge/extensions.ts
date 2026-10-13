/**
 * The dictionary-engine downloads (`extension_status`, `extension_download_*`, `extension_delete`,
 * the `extension-download` event and `dictionary_engine_effective`; see COMMANDS.md → Dictionary
 * engine downloads), shared by every component in a window. The download runs in Rust and outlives
 * any window. The twin of `models.ts`.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  normalizeExtensionStatus,
  type ExtensionEngine,
  type ExtensionStatus
} from '@ui/extension-download'
import type { ModelAction } from '@ui/model-download'
import { nativeError, onEvent } from './tauri'

export type { ExtensionEngine, ExtensionStatus }

const statuses = new Map<ExtensionEngine, ExtensionStatus>()
const subscribers = new Set<() => void>()
let watching = false

function set(status: ExtensionStatus | null): void {
  if (!status) return
  statuses.set(status.engine, status)
  for (const notify of subscribers) notify()
}

function watch(): void {
  if (watching) return
  watching = true
  try {
    onEvent<unknown>('extension-download', (payload) => set(normalizeExtensionStatus(payload))).catch(
      () => undefined
    )
  } catch {
    // No event bridge (a plain browser): the fetched status stands.
  }
}

const reply = (call: Promise<unknown>): Promise<ExtensionStatus | null> =>
  call.then((raw) => {
    const status = normalizeExtensionStatus(raw)
    set(status)
    return status
  })

export const extensionStatus = (engine: ExtensionEngine): Promise<ExtensionStatus | null> =>
  reply(invoke('extension_status', { engine }))

/** Run one download action. Rejects with the native error string. */
export function extensionAction(engine: ExtensionEngine, action: ModelAction): Promise<ExtensionStatus | null> {
  const command = {
    download: 'extension_download_start',
    pause: 'extension_download_pause',
    resume: 'extension_download_resume',
    retry: 'extension_download_retry',
    cancel: 'extension_download_cancel',
    delete: 'extension_delete'
  }[action]
  return reply(invoke(command, { engine }))
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => subscribers.delete(notify)
}

/** The live status of `engine` (null for Kimochi's pop-up, or until native answers). */
export function useExtensionStatus(engine: ExtensionEngine | null): ExtensionStatus | null {
  useEffect(() => {
    if (!engine) return
    watch()
    extensionStatus(engine).catch(() => undefined)
  }, [engine])
  return useSyncExternalStore(
    subscribe,
    () => (engine ? (statuses.get(engine) ?? null) : null),
    () => null
  )
}

/** One engine's download: its live status, the action under way and the last error. */
export interface ExtensionControls {
  engine: ExtensionEngine | null
  status: ExtensionStatus | null
  pending: ModelAction | null
  error: string | null
  run: (action: ModelAction) => void
}

export function useExtensionControls(engine: ExtensionEngine | null): ExtensionControls {
  const live = useExtensionStatus(engine)
  const status = engine && live?.engine === engine ? live : null
  const [pending, setPending] = useState<ModelAction | null>(null)
  const [error, setError] = useState<{ engine: ExtensionEngine; message: string } | null>(null)
  const run = useCallback(
    (action: ModelAction): void => {
      if (!engine) return
      setPending(action)
      setError(null)
      extensionAction(engine, action)
        .catch((e) => setError({ engine, message: nativeError(e).message }))
        .finally(() => setPending(null))
    },
    [engine]
  )
  return { engine, status, pending, error: error?.engine === engine ? error.message : null, run }
}

/** Native's view of the engine: the setting's host engine, the one the windows run, and readiness. */
export interface EffectiveEngine {
  selected: string
  effective: string
  ready: Partial<Record<ExtensionEngine, boolean>>
}

export const effectiveEngine = (): Promise<EffectiveEngine> => invoke('dictionary_engine_effective')
