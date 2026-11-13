/**
 * Gaming Mode controls (Steam Deck): Kimochi's own windows are used by touch (or the trackpad as a
 * mouse), and the controller belongs to the game and the game menu over it.
 *
 * - The focused control window renews its input heartbeat (`panel_controller_input`), which keeps
 *   native's record of which control window has the input current (gamescope.rs).
 * - A controller button pressed while one of these windows is in front gets a short note instead of
 *   doing nothing silently. The game-menu buttons are left out: they open the menu as anywhere else.
 *
 * Elsewhere this does nothing.
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isGamingMode, useCapabilities } from '../bridge/capabilities'
import { hotkeysLoad, onEvent, onSettingsChanged } from '../bridge/tauri'
import type { GamepadState } from '../bridge/types'

/** How long the note stays up after the last press. */
const NOTE_MS = 5000

export const CONTROLLER_NOTE = 'Tap the screen to use Kimochi. Your controller works in your game.'

/** The buttons newly pressed in `next` (rising edges), by index. */
export function newlyPressed(previous: readonly boolean[], next: readonly boolean[]): number[] {
  return next.flatMap((down, index) => (down && !previous[index] ? [index] : []))
}

export function useGamingControls(label: string): string | null {
  const gaming = isGamingMode(useCapabilities())
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (!gaming) return
    const renew = (): void => {
      if (!document.hasFocus() || document.visibilityState === 'hidden') return
      void invoke('panel_controller_input', { label }).catch((error: unknown) => {
        console.warn('Gaming Mode controls input heartbeat failed', error)
      })
    }
    renew()
    const timer = window.setInterval(renew, 500)
    return () => window.clearInterval(timer)
  }, [gaming, label])

  useEffect(() => {
    if (!gaming) return
    let menuChord: number[] = []
    let previous: boolean[] = []
    let hide: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const loadChord = (): void => {
      void hotkeysLoad()
        .then((hotkeys) => {
          const binding = hotkeys.openControllerMenu
          menuChord =
            binding?.enabled === false
              ? []
              : (binding?.gamepadButtons ??
                (Number.isInteger(binding?.gamepadButton) ? [binding.gamepadButton as number] : []))
        })
        .catch(() => undefined)
    }
    loadChord()
    const subscriptions = [
      onSettingsChanged((key) => {
        if (key === 'hotkeys' || key.startsWith('hotkeys.')) loadChord()
      }),
      onEvent<GamepadState & { controlsInputOwner?: boolean; overlayNavigation?: boolean }>('gamepad', (payload) => {
        const buttons = payload.buttonStates ?? []
        const pressed = newlyPressed(previous, buttons)
        previous = buttons
        if (!pressed.length || !document.hasFocus() || payload.overlayNavigation) return
        if (payload.controlsInputOwner === false) return
        if (pressed.every((button) => menuChord.includes(button))) return
        setNote(CONTROLLER_NOTE)
        clearTimeout(hide)
        hide = setTimeout(() => setNote(null), NOTE_MS)
      })
    ]
    const stops: (() => void)[] = []
    for (const pending of subscriptions) {
      void pending
        .then((stop) => {
          if (disposed) stop()
          else stops.push(stop)
        })
        .catch(() => undefined)
    }
    return () => {
      disposed = true
      clearTimeout(hide)
      stops.forEach((stop) => stop())
    }
  }, [gaming])

  return note
}
