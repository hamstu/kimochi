/**
 * Kimochi in the Steam library (`steam_library_status`, `steam_library_add`; COMMANDS.md → Steam
 * library), shared by every component in a window: the welcome guide's step, its last step and
 * Settings → General.
 *
 * The status is fetched once per window (and again after an add). `offered` remembers that the
 * welcome step applied when the guide started, so the step stays in the flow (and Back reaches
 * it) after Kimochi has been added.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { nativeError } from './tauri'

export interface SteamLibraryStatus {
  /** Linux; false elsewhere, and everything below is false/null. */
  supported: boolean
  steamDeck: boolean
  steamOs: boolean
  steamInstalled: boolean
  steamRunning: boolean
  /** Running inside Gaming Mode (gamescope) now. */
  gamingMode: boolean
  /** Kimochi's entry is in the signed-in user's library. */
  added: boolean
  appId: number | null
  /** That entry has all of Kimochi's library art. */
  artwork: boolean
  /** The gaming-mode launcher points at this copy of Kimochi. */
  launcher: boolean
  reason: string | null
}

export type SteamAddState = 'added' | 'pending' | 'steamNotRunning' | 'failed' | 'unsupported'

export interface SteamAddResult {
  state: SteamAddState
  message: string
  appId: number | null
  status?: SteamLibraryStatus
}

/** The step is for a Steam Deck / SteamOS in Desktop Mode with Steam, and Kimochi not yet added. */
export const offersSteamStep = (status: SteamLibraryStatus | null): boolean =>
  Boolean(
    status?.supported &&
      (status.steamDeck || status.steamOs) &&
      status.steamInstalled &&
      !status.gamingMode &&
      !status.added
  )

interface Store {
  /** undefined: not asked yet; null: no answer (an older backend, or no backend). */
  status: SteamLibraryStatus | null | undefined
  offered: boolean
  adding: boolean
  result: SteamAddResult | null
}

let store: Store = { status: undefined, offered: false, adding: false, result: null }
const subscribers = new Set<() => void>()
let loading: Promise<void> | null = null

function set(patch: Partial<Store>): void {
  store = { ...store, ...patch }
  if (patch.status !== undefined && offersSteamStep(store.status ?? null)) store.offered = true
  for (const notify of subscribers) notify()
}

export function refreshSteamLibrary(): Promise<void> {
  loading ??= invoke<SteamLibraryStatus>('steam_library_status')
    .then((status) => set({ status }))
    .catch(() => set({ status: null }))
    .finally(() => {
      loading = null
    })
  return loading
}

export async function addToSteam(): Promise<SteamAddResult> {
  set({ adding: true, result: null })
  try {
    const result = await invoke<SteamAddResult>('steam_library_add')
    set({ adding: false, result, ...(result.status ? { status: result.status } : {}) })
    return result
  } catch (error) {
    const result: SteamAddResult = {
      state: 'failed',
      message: nativeError(error).message,
      appId: null
    }
    set({ adding: false, result })
    return result
  }
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => subscribers.delete(notify)
}

export function useSteamLibrary(): Store & { add: () => Promise<SteamAddResult> } {
  useEffect(() => {
    if (store.status === undefined) void refreshSteamLibrary()
  }, [])
  const snapshot = useSyncExternalStore(
    subscribe,
    () => store,
    () => store
  )
  const add = useCallback(() => addToSteam(), [])
  return { ...snapshot, add }
}
