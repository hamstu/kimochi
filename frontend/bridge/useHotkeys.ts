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
import { hotkeysLoad, hotkeysReapply, hotkeysSave, nativeError } from './tauri'

export interface HotkeyFailure {
  name: string
  accelerator: string
  error: string
}

export function useHotkeys(): [
  HotkeysSettings,
  (hotkeys: HotkeysSettings) => Promise<void>,
  HotkeyFailure[]
] {
  const [hotkeys, setHotkeys] = useState<HotkeysSettings>(() => mergeHotkeysWithOverrides({}))
  const [failures, setFailures] = useState<HotkeyFailure[]>([])

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
      setFailures(result?.failed ?? [])
    } catch (error) {
      console.error('Failed to save hotkeys:', nativeError(error).message)
    }
  }, [])

  return [hotkeys, save, failures]
}
