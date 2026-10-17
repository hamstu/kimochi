/**
 * Sync (`sync_status` and the other `sync_*` commands, the `sync-status` and `sync-log` events;
 * see COMMANDS.md → Sync), shared by every component in a window. Sync runs in Rust; this mirrors
 * its state and sends the commands.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { normalizeSyncStatus, SYNC_OFF, type SyncLogEntry, type SyncStatus } from '@ui/sync'
import { onEvent } from './tauri'

export type { SyncConflict, SyncLogEntry, SyncStatus } from '@ui/sync'

let current: SyncStatus = SYNC_OFF
const subscribers = new Set<() => void>()
let watching = false
let loading: Promise<SyncStatus> | null = null

function set(status: SyncStatus): void {
  current = status
  for (const fn of subscribers) fn()
}

function watch(): void {
  if (watching) return
  watching = true
  try {
    onEvent<unknown>('sync-status', (payload) => set(normalizeSyncStatus(payload))).catch(() => undefined)
  } catch {
    // No event bridge (a plain browser): the fetched status stands.
  }
}

export function loadSync(): Promise<SyncStatus> {
  watch()
  loading ??= invoke<unknown>('sync_status')
    .then((raw) => {
      set(normalizeSyncStatus(raw))
      return current
    })
    .catch(() => current)
  return loading.then(() => current)
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

const read = (): SyncStatus => current

/** Sync's status, re-rendering on every change. */
export function useSync(): SyncStatus {
  useEffect(() => {
    void loadSync()
  }, [])
  return useSyncExternalStore(subscribe, read, read)
}

/** Ask native again (after the account changed, say). */
export const refreshSync = (): Promise<SyncStatus> =>
  invoke<unknown>('sync_status').then((raw) => {
    set(normalizeSyncStatus(raw))
    return current
  })

export const syncNow = (): Promise<SyncStatus> =>
  invoke<unknown>('sync_now').then((raw) => {
    set(normalizeSyncStatus(raw))
    return current
  })

export const resolveConflict = (id: string, action: 'restore' | 'dismiss'): Promise<SyncStatus> =>
  invoke<unknown>('sync_conflict_resolve', { id, action }).then((raw) => {
    set(normalizeSyncStatus(raw))
    return current
  })

/** Save the account's synced data (a ZIP from the server) to `path`; returns its size in bytes. */
export const exportSyncedData = (path: string): Promise<number> => invoke<number>('sync_export', { path })

export const readSyncLog = (): Promise<SyncLogEntry[]> => invoke<SyncLogEntry[]>('sync_log')
export const clearSyncLog = (): Promise<void> => invoke('sync_log_clear')
