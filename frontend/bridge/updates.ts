/**
 * Self-updates (`update_status`, `update_check`, `update_download`, `update_cancel`,
 * `update_install`, `update_retry`, `update_dismiss`, and the `update-status` event; see
 * COMMANDS.md → App updates), shared by every component in a window. The check and the download
 * run in Rust and outlive any panel; this only mirrors their status and sends the commands.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { normalizeUpdateStatus, type UpdateAction, type UpdateStatus } from '@ui/update'
import { nativeError, onEvent } from './tauri'

export type { UpdateAction, UpdateStatus }

let current: UpdateStatus | null = null
const subscribers = new Set<() => void>()
let watching = false

function set(status: UpdateStatus | null): void {
  if (!status) return
  current = status
  for (const notify of subscribers) notify()
}

/** Follow the `update-status` events. */
function watch(): void {
  if (watching) return
  watching = true
  try {
    onEvent<unknown>('update-status', (payload) => set(normalizeUpdateStatus(payload))).catch(
      () => undefined
    )
  } catch {
    // No event bridge (a plain browser): the fetched status stands.
  }
}

const reply = (call: Promise<unknown>): Promise<UpdateStatus | null> =>
  call.then((raw) => {
    const status = normalizeUpdateStatus(raw)
    set(status)
    return status
  })

/** The current status; null on a backend without self-updates. */
export const updateStatus = (): Promise<UpdateStatus | null> => reply(invoke('update_status'))

/** Run one of the actions. Rejects with the native error string. */
export function updateAction(action: UpdateAction): Promise<UpdateStatus | null> {
  switch (action) {
    case 'check':
      return reply(invoke('update_check'))
    case 'download':
      return reply(invoke('update_download'))
    case 'cancel':
      return reply(invoke('update_cancel'))
    case 'install':
      return reply(invoke('update_install'))
    case 'retry':
      return reply(invoke('update_retry'))
    case 'dismiss':
      return reply(invoke('update_dismiss'))
  }
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => subscribers.delete(notify)
}

/** The live status (null on a backend without self-updates, or until native answers). */
export function useUpdateStatus(): UpdateStatus | null {
  useEffect(() => {
    watch()
    updateStatus().catch(() => undefined)
  }, [])
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  )
}

/** The status, the action under way and the last error, for a surface with buttons. */
export interface UpdateControls {
  status: UpdateStatus | null
  pending: UpdateAction | null
  error: string | null
  run: (action: UpdateAction) => void
}

export function useUpdateControls(): UpdateControls {
  const status = useUpdateStatus()
  const [pending, setPending] = useState<UpdateAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback((action: UpdateAction): void => {
    setPending(action)
    setError(null)
    updateAction(action)
      .catch((e) => setError(nativeError(e).message))
      .finally(() => setPending(null))
  }, [])
  return { status, pending, error, run }
}
