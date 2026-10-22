/**
 * ADAPTED from `src/renderer/src/hooks/useGamepad.ts`.
 *
 * Same exported shape (`state`, `settings`, `setEnabled`, `setPreferredGamepad`, `getButtonName`,
 * `GAMEPAD_BUTTON_NAMES`), so `GamepadButtonCapture` and the Settings gamepad tab are reused with
 * no changes.
 *
 * Delta: device state comes from a native `gamepad` event when the backend provides one, because
 * the Web Gamepad API is unreliable in an unfocused WKWebView and the feature exists to fire while
 * a *game* holds focus. Browser polling remains as a fallback so the button test still works while
 * a Kimochi window is focused. Which source is live is reported through `source`, and the UI must
 * not claim gamepad support works until one of them is verified running (PARITY_GAPS #3).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GamepadDevice, GamepadSettings, GamepadState } from './types'
import { useSetting } from './useSetting'
import { onEvent } from './tauri'

export const GAMEPAD_BUTTON_NAMES: string[] = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  // Delta: View and Menu, as the Steam Deck and Xbox pads print them (and as the overlay's hints
  // name them, ui/controller-input.js BUTTON_NAMES), so "Back" only ever means the action.
  'View',
  'Menu',
  'LS',
  'RS',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home'
]

export function getButtonName(index: number): string {
  return GAMEPAD_BUTTON_NAMES[index] || `Button ${index}`
}

interface UseGamepadOptions {
  onButtonPress?: (buttonIndex: number, gamepadIndex: number) => void
  onButtonRelease?: (buttonIndex: number, gamepadIndex: number) => void
  pollInterval?: number
}

interface UseGamepadReturn {
  state: GamepadState
  settings: GamepadSettings
  setEnabled: (enabled: boolean) => Promise<void>
  setPreferredGamepad: (index: number | undefined) => Promise<void>
  /** Which source produced the current state; `none` means nothing has reported yet. */
  source: 'native' | 'browser' | 'none'
}

const EMPTY: GamepadState = {
  gamepads: [],
  activeGamepadIndex: null,
  buttonStates: [],
  axisStates: []
}

function toDevice(gamepad: Gamepad): GamepadDevice {
  return {
    index: gamepad.index,
    id: gamepad.id,
    connected: gamepad.connected,
    mapping: gamepad.mapping,
    buttons: gamepad.buttons.length,
    axes: gamepad.axes.length,
    timestamp: gamepad.timestamp
  }
}

export function useGamepad(options: UseGamepadOptions = {}): UseGamepadReturn {
  const { onButtonPress, onButtonRelease, pollInterval = 16 } = options

  const [settings, setSettings] = useSetting<GamepadSettings>('gamepadSettings', {
    enabled: true,
    preferredGamepadIndex: undefined
  })
  const [state, setState] = useState<GamepadState>(EMPTY)
  const [source, setSource] = useState<'native' | 'browser' | 'none'>('none')

  const previousButtons = useRef<Map<number, boolean[]>>(new Map())
  const frameRef = useRef<number | null>(null)
  const lastPollRef = useRef(0)
  const pollRef = useRef<() => void>(() => {})
  const pressRef = useRef(onButtonPress)
  const releaseRef = useRef(onButtonRelease)
  const nativeRef = useRef(false)

  useEffect(() => {
    pressRef.current = onButtonPress
    releaseRef.current = onButtonRelease
  }, [onButtonPress, onButtonRelease])

  const emitEdges = useCallback((next: GamepadState) => {
    const index = next.activeGamepadIndex
    if (index === null) return
    const previous = previousButtons.current.get(index) ?? []
    next.buttonStates.forEach((pressed, button) => {
      const was = previous[button] ?? false
      if (pressed && !was) pressRef.current?.(button, index)
      else if (!pressed && was) releaseRef.current?.(button, index)
    })
    previousButtons.current.set(index, [...next.buttonStates])
  }, [])

  // Native source, when the backend emits it.
  useEffect(() => {
    if (!settings.enabled) return
    let unlisten: (() => void) | undefined
    let cancelled = false
    onEvent<GamepadState>('gamepad', (payload) => {
      nativeRef.current = true
      setSource('native')
      const next: GamepadState = {
        gamepads: payload.gamepads ?? [],
        activeGamepadIndex: payload.activeGamepadIndex ?? null,
        buttonStates: payload.buttonStates ?? [],
        axisStates: payload.axisStates ?? []
      }
      setState(next)
      emitEdges(next)
    })
      .then((stop) => {
        if (cancelled) stop()
        else unlisten = stop
      })
      .catch(() => {
        /* No native gamepad source; the browser fallback below stays in charge. */
      })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [settings.enabled, emitEdges])

  // Browser fallback: only drives state while no native event has been seen.
  const poll = useCallback(() => {
    const now = performance.now()
    if (now - lastPollRef.current < pollInterval) {
      frameRef.current = requestAnimationFrame(() => pollRef.current())
      return
    }
    lastPollRef.current = now

    if (!nativeRef.current) {
      const devices: GamepadDevice[] = []
      let active: Gamepad | null = null
      for (const gamepad of navigator.getGamepads?.() ?? []) {
        if (!gamepad?.connected) continue
        devices.push(toDevice(gamepad))
        if (
          settings.preferredGamepadIndex !== undefined &&
          gamepad.index === settings.preferredGamepadIndex
        ) {
          active = gamepad
        } else if (!active) {
          active = gamepad
        }
      }
      const next: GamepadState = {
        gamepads: devices,
        activeGamepadIndex: active ? active.index : null,
        buttonStates: active ? active.buttons.map((button) => button.pressed) : [],
        axisStates: active ? [...active.axes] : []
      }
      setState(next)
      if (devices.length > 0) setSource('browser')
      emitEdges(next)
    }
    frameRef.current = requestAnimationFrame(() => pollRef.current())
  }, [settings.preferredGamepadIndex, pollInterval, emitEdges])

  useEffect(() => {
    pollRef.current = poll
  }, [poll])

  useEffect(() => {
    if (!settings.enabled) {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      // Mirrors the Electron hook: turning gamepad support off clears the reported devices. This
      // is lifecycle synchronisation with an external device source, not derived render state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(EMPTY)
      setSource('none')
      return
    }
    frameRef.current = requestAnimationFrame(poll)
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [settings.enabled, poll])

  useEffect(() => {
    const disconnected = (event: GamepadEvent): void => {
      previousButtons.current.delete(event.gamepad.index)
    }
    window.addEventListener('gamepaddisconnected', disconnected)
    return () => window.removeEventListener('gamepaddisconnected', disconnected)
  }, [])

  const setEnabled = useCallback(
    async (enabled: boolean): Promise<void> => {
      await setSettings({ ...settings, enabled })
    },
    [settings, setSettings]
  )

  const setPreferredGamepad = useCallback(
    async (index: number | undefined): Promise<void> => {
      await setSettings({ ...settings, preferredGamepadIndex: index })
    },
    [settings, setSettings]
  )

  return { state, settings, setEnabled, setPreferredGamepad, source }
}
