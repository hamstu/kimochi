/**
 * The OCR model downloads (`model_status`, `model_download_*`, `model_delete`, and the
 * `model-download` event; see COMMANDS.md → OCR model downloads), shared by every component in a
 * window. The download itself runs in Rust and outlives any panel.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  normalizeModelStatus,
  type ModelAction,
  type ModelEngine,
  type ModelStatus
} from '@ui/model-download'
import { onEvent } from './tauri'

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
