/**
 * ADAPTED from `src/renderer/src/hooks/useHotkeys.ts`.
 * Deltas: persistence goes through the native `hotkeys_load` / `hotkeys_save` / `hotkeys_reapply`
 * commands instead of the `hotkeys` settings key plus a `reapply-global-shortcuts` IPC round trip.
 * The merge-with-defaults semantics and the "store only overrides" behaviour are unchanged, and
 * per-key registration failures are now surfaced instead of failing silently.
 */
import { useCallback, useEffect, useState } from 'react'
import type { HotkeysSettings } from './types'
import { mergeHotkeysWithOverrides } from '../vendor/shared-defaults'
import {
  hotkeysLoad,
  hotkeysReapply,
  hotkeysSave,
  hotkeysSuspend,
  nativeError,
  type HotkeysApplyResult
} from './tauri'

export interface HotkeyFailure {
  name: string
  accelerator: string
  error: string
}

// ------------------------------------------------------------------ suspension while recording

/**
 * How many recorders currently want the shortcuts paused. Counted rather than flagged so a
 * keyboard recorder and a gamepad capture open at once restore only when both have finished.
 */
let suspenders = 0
/** Native calls go out in order, so a quick start / stop cannot land as stop / start. */
let pending: Promise<unknown> = Promise.resolve()
const restoredListeners = new Set<(result: HotkeysApplyResult) => void>()

function sendSuspended(suspended: boolean): void {
  pending = pending
    .then(() => hotkeysSuspend(suspended))
    .then((result) => {
      if (!suspended && result && !result.suspended && !result.unchanged) {
        restoredListeners.forEach((listener) => listener(result))
      }
    })
    .catch((error) => console.error('Failed to suspend hotkeys:', nativeError(error).message))
}

function acquireSuspension(): () => void {
  suspenders += 1
  if (suspenders === 1) sendSuspended(true)
  let released = false
  return () => {
    if (released) return
    released = true
    suspenders = Math.max(0, suspenders - 1)
    if (suspenders === 0) sendSuspended(false)
  }
}

// A page that goes away mid-recording must not leave the shortcuts off. The native side also
// restores them when the Settings window closes and after a time limit.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (suspenders === 0) return
    suspenders = 0
    sendSuspended(false)
  })
}

/**
 * Pause every global shortcut and gamepad action while `active`, so pressing a combination that
 * is already bound is recorded instead of firing. Restored when `active` turns false or the
 * caller unmounts. Callers should also end recording on blur and when the page is hidden.
 */
export function useSuspendHotkeys(active: boolean): void {
  useEffect(() => {
    if (!active) return
    return acquireSuspension()
  }, [active])
}

export function useHotkeys(): [
  HotkeysSettings,
  (hotkeys: HotkeysSettings) => Promise<void>,
  HotkeyFailure[]
] {
  const [hotkeys, setHotkeys] = useState<HotkeysSettings>(() => mergeHotkeysWithOverrides({}))
  const [failures, setFailures] = useState<HotkeyFailure[]>([])

  // Saves made while recording are registered when the shortcuts are restored; report those.
  useEffect(() => {
    const listener = (result: HotkeysApplyResult): void => setFailures(result.failed ?? [])
    restoredListeners.add(listener)
    return () => {
      restoredListeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    let mounted = true
    hotkeysLoad()
      .then((loaded) => {
        if (mounted && loaded && Object.keys(loaded).length > 0) setHotkeys(loaded)
      })
      .catch((error) => console.error('Failed to load hotkeys:', nativeError(error).message))
    return () => {
      mounted = false
    }
  }, [])

  const save = useCallback(async (next: HotkeysSettings): Promise<void> => {
    setHotkeys(next)
    try {
      await hotkeysSave(next)
      const result = await hotkeysReapply()
      // While paused nothing was registered; the restore reports the real failures.
      if (!result?.suspended) setFailures(result?.failed ?? [])
    } catch (error) {
      console.error('Failed to save hotkeys:', nativeError(error).message)
    }
  }, [])

  return [hotkeys, save, failures]
}
