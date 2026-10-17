/**
 * Kimochi accounts (`account_status` and the other `account_*` commands, the `account-changed` and
 * `account-link` events; see COMMANDS.md → Kimochi account), shared by every component in a
 * window. Linking, switching and signing out run in Rust; this only mirrors their state and sends
 * the commands. A token never reaches a webview.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  normalizeStatus,
  SIGNED_OUT,
  type AccountServer,
  type AccountStatus,
  type AccountSummary,
  type LinkEvent
} from '@ui/account'
import { onEvent } from './tauri'

export type { AccountServer, AccountStatus, AccountSummary, LinkEvent }

let current: AccountStatus = SIGNED_OUT
let loaded = false
let lastLink: LinkEvent | null = null
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

export function clearAccountEvents(): void {
  lastLink = null
  notify()
}

const withStatus = (call: Promise<unknown>): Promise<AccountStatus> =>
  call.then((raw) => {
    if (raw && typeof raw === 'object') set(normalizeStatus(raw))
    return current
  })

/** Add an account: opens the browser and returns the code to show. */
export const accountLinkStart = async (): Promise<{ code: string; verifyUrl: string; expiresIn: number }> => {
  lastLink = null
  const reply = await invoke<{ code: string; verifyUrl: string; expiresIn: number }>('account_link_start')
  await withStatus(invoke('account_status'))
  return reply
}
export const accountLinkCancel = (): Promise<AccountStatus> => withStatus(invoke('account_link_cancel'))
export const accountLinkOpen = (): Promise<void> => invoke('account_link_open')
/** Sign out of an account (default: the one in use); its data stays on this computer. */
export const accountSignOut = (key?: string): Promise<AccountStatus> =>
  withStatus(invoke('account_sign_out', { key: key ?? null }))
/** Sign out and delete that account's data from this computer (it stays on the server). */
export const accountRemove = (key: string): Promise<AccountStatus> => withStatus(invoke('account_remove', { key }))
/**
 * Switch to an account's profile (`null`: the Local profile). The windows showing the Log reload
 * once it is in place.
 */
export const accountSwitch = (key: string | null): Promise<AccountStatus> =>
  withStatus(invoke('account_switch', { key }))
export const accountRefresh = (): Promise<AccountStatus> => withStatus(invoke('account_refresh'))
export const accountOpenWeb = (): Promise<void> => invoke('account_open_web')
/**
 * Development builds only: the server "Add account" signs in to (and, signed out, the server in
 * use). Accounts keep their own server.
 */
export const accountSetServer = (mode: 'cloud' | 'local'): Promise<AccountStatus> => {
  lastLink = null
  return withStatus(invoke('account_set_server', { mode }))
}
