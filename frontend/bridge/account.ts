/**
 * The Kimochi account (`account_status` and the other `account_*` commands, the `account-changed`,
 * `account-link` and `account-backup` events; see COMMANDS.md → Kimochi account), shared by every
 * component in a window. Linking, backup and restore run in Rust; this only mirrors their state
 * and sends the commands. The token never reaches a webview.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  normalizeStatus,
  SIGNED_OUT,
  type AccountServer,
  type AccountStatus,
  type BackupEvent,
  type LinkEvent
} from '@ui/account'
import { onEvent } from './tauri'

export type { AccountServer, AccountStatus, BackupEvent, LinkEvent }

let current: AccountStatus = SIGNED_OUT
let loaded = false
let lastLink: LinkEvent | null = null
let lastBackup: BackupEvent | null = null
const subscribers = new Set<() => void>()
let watching = false
let loading: Promise<AccountStatus> | null = null

function notify(): void {
  for (const fn of subscribers) fn()
}

function set(status: AccountStatus): void {
  current = status
  loaded = true
  notify()
}

function watch(): void {
  if (watching) return
  watching = true
  try {
    onEvent<unknown>('account-changed', (payload) => set(normalizeStatus(payload))).catch(() => undefined)
    onEvent<LinkEvent>('account-link', (payload) => {
      lastLink = payload
      notify()
    }).catch(() => undefined)
    onEvent<BackupEvent>('account-backup', (payload) => {
      lastBackup = payload
      notify()
    }).catch(() => undefined)
  } catch {
    // No event bridge (a plain browser): the fetched status stands.
  }
}

/** Ask native once; later calls share the answer. Never rejects: signed out on failure. */
export function loadAccount(): Promise<AccountStatus> {
  watch()
  loading ??= invoke<unknown>('account_status')
    .then((raw) => {
      set(normalizeStatus(raw))
      return current
    })
    .catch(() => current)
  // Later changes arrive as events: answer with the latest, not the first reply.
  return loading.then(() => current)
}

export const currentAccount = (): AccountStatus => current
export const accountLoaded = (): boolean => loaded

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/** The account, re-rendering on every change. Starts signed out until native answers. */
export function useAccount(): AccountStatus {
  useEffect(() => {
    void loadAccount()
  }, [])
  return useSyncExternalStore(subscribe, currentAccount, currentAccount)
}

/** The last `account-link` update (a sign-in denied, expired or failed), for its message. */
export function useLinkEvent(): LinkEvent | null {
  return useSyncExternalStore(subscribe, () => lastLink, () => lastLink)
}

/** The last `account-backup` progress event. */
export function useBackupEvent(): BackupEvent | null {
  return useSyncExternalStore(subscribe, () => lastBackup, () => lastBackup)
}

export function clearAccountEvents(): void {
  lastLink = null
  lastBackup = null
  notify()
}

const withStatus = (call: Promise<unknown>): Promise<AccountStatus> =>
  call.then((raw) => {
    if (raw && typeof raw === 'object') set(normalizeStatus(raw))
    return current
  })

/** Start signing in: opens the browser and returns the code to show. */
export const accountLinkStart = async (): Promise<{ code: string; verifyUrl: string; expiresIn: number }> => {
  lastLink = null
  const reply = await invoke<{ code: string; verifyUrl: string; expiresIn: number }>('account_link_start')
  await withStatus(invoke('account_status'))
  return reply
}
export const accountLinkCancel = (): Promise<AccountStatus> => withStatus(invoke('account_link_cancel'))
export const accountLinkOpen = (): Promise<void> => invoke('account_link_open')
export const accountSignOut = (): Promise<AccountStatus> => withStatus(invoke('account_sign_out'))
export const accountRefresh = (): Promise<AccountStatus> => withStatus(invoke('account_refresh'))
export const accountOpenWeb = (): Promise<void> => invoke('account_open_web')
export const accountBackupNow = (): Promise<AccountStatus> => {
  lastBackup = null
  return withStatus(invoke('account_backup_now'))
}
/**
 * Development builds only: switch Kimochi's server at once (no restart). Each server has its own
 * sign-in; `account-changed` follows with the new server's account.
 */
export const accountSetServer = (mode: 'cloud' | 'local'): Promise<AccountStatus> => {
  lastLink = null
  lastBackup = null
  return withStatus(invoke('account_set_server', { mode }))
}
/** Downloads the backup and restarts Kimochi to put it in place. */
export const accountRestore = (prefs: boolean, sessions: boolean): Promise<void> => {
  lastBackup = null
  return invoke('account_restore', { prefs, sessions })
}
