/**
 * The OCR model downloads (`model_status`, `model_download_*`, `model_delete`, and the
 * `model-download` event; see COMMANDS.md → OCR model downloads), shared by every component in a
 * window. The download itself runs in Rust and outlives any panel.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  normalizeModelStatus,
  type ModelAction,
  type ModelEngine,
  type ModelStatus
} from '@ui/model-download'
import { nativeError, onEvent } from './tauri'

export type { ModelAction, ModelEngine, ModelStatus }

const statuses = new Map<ModelEngine, ModelStatus>()
const subscribers = new Set<() => void>()
let watching = false

function set(status: ModelStatus | null): void {
  if (!status) return
  statuses.set(status.engine, status)
  for (const notify of subscribers) notify()
}

/** Follow the `model-download` progress and state events. */
function watch(): void {
  if (watching) return
  watching = true
  try {
    onEvent<unknown>('model-download', (payload) => set(normalizeModelStatus(payload))).catch(
      () => undefined
    )
  } catch {
    // No event bridge (a plain browser): the fetched status stands.
  }
}

const reply = (call: Promise<unknown>): Promise<ModelStatus | null> =>
  call.then((raw) => {
    const status = normalizeModelStatus(raw)
    set(status)
    return status
  })

/** The engine's current status; null on a backend without model downloads. */
export const modelStatus = (engine: ModelEngine): Promise<ModelStatus | null> =>
  reply(invoke('model_status', { engine }))

/** Run one of the card's actions. Rejects with the native error string. */
export function modelAction(engine: ModelEngine, action: ModelAction): Promise<ModelStatus | null> {
  switch (action) {
    case 'download':
      return reply(invoke('model_download_start', { engine }))
    case 'pause':
      return reply(invoke('model_download_pause', { engine }))
    case 'resume':
      return reply(invoke('model_download_resume', { engine }))
    case 'retry':
      return reply(invoke('model_download_retry', { engine }))
    case 'cancel':
      return reply(invoke('model_download_cancel', { engine }))
    case 'delete':
      return reply(invoke('model_delete', { engine }))
  }
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => subscribers.delete(notify)
}

/** The live status of `engine` (null for a non-local engine, or until native answers). */
export function useModelStatus(engine: ModelEngine | null): ModelStatus | null {
  useEffect(() => {
    if (!engine) return
    watch()
    modelStatus(engine).catch(() => undefined)
  }, [engine])
  return useSyncExternalStore(
    subscribe,
    () => (engine ? (statuses.get(engine) ?? null) : null),
    () => null
  )
}

/**
 * One engine's model: its live status, the action under way and the last error, shared by the
 * download block and the panel's "Remove downloaded model…" menu item.
 */
export interface ModelControls {
  /** Null for an engine without a downloadable model. */
  engine: ModelEngine | null
  /** Null for such an engine, on a backend without model downloads, or until native answers. */
  status: ModelStatus | null
  pending: ModelAction | null
  error: string | null
  run: (action: ModelAction) => void
}

export function useModelControls(engine: ModelEngine | null): ModelControls {
  const live = useModelStatus(engine)
  const status = engine && live?.engine === engine ? live : null
  const [pending, setPending] = useState<ModelAction | null>(null)
  const [error, setError] = useState<{ engine: ModelEngine; message: string } | null>(null)
  const run = useCallback(
    (action: ModelAction): void => {
      if (!engine) return
      setPending(action)
      setError(null)
      modelAction(engine, action)
        .catch((e) => setError({ engine, message: nativeError(e).message }))
        .finally(() => setPending(null))
    },
    [engine]
  )
  // An error belongs to the engine it came from, not whichever one is shown next.
  return { engine, status, pending, error: error?.engine === engine ? error.message : null, run }
}
