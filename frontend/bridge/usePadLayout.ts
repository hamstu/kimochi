/**
 * The active controller's button layout (ui/pad-layout.js), for anything that names buttons with
 * `getButtonName`: it re-renders when a PlayStation pad takes over from an Xbox-style one, or back.
 * Listens to the native `gamepad` state itself, so a window without `useGamepad` still follows it.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { activePadLayout, onPadLayout, padLayout, setPadLayout, type PadLayout } from '../../ui/pad-layout.js'
import type { GamepadState } from './types'
import { onEvent } from './tauri'

export function usePadLayout(): PadLayout {
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    onEvent<GamepadState>('gamepad', (payload) => setPadLayout(activePadLayout(payload)))
      .then((stop) => {
        if (cancelled) stop()
        else unlisten = stop
      })
      .catch(() => {
        /* No native gamepad source (browser preview): the layout stays as it is. */
      })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
  return useSyncExternalStore(onPadLayout, padLayout, padLayout)
}
