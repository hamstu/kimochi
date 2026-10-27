/**
 * ADAPTED from `src/shared/defaults.ts` in the Electron app.
 * Deltas: only Scan and the controller menu remain bindable (the radial menu reaches the
 * rest), and gamepad bindings are chords (`gamepadButtons`). Must match `default_hotkeys` and
 * `merged_hotkeys` in `src-tauri/src/settings.rs`, which is what the app actually loads.
 */
import { HotkeysSettings, HotkeyOverrides } from './shared-types'

export const DEFAULT_HOTKEYS: HotkeysSettings = {
  triggerScan: {
    name: 'Scan',
    accelerator: 'CommandOrControl+Shift+8',
    description: 'Trigger OCR scan on current source',
    enabled: true,
    gamepadButtons: []
  },
  openControllerMenu: {
    name: 'Controller menu',
    accelerator: 'CommandOrControl+Shift+Space',
    description: 'Open the radial menu over the game',
    enabled: true,
    // LS + RS: both stick clicks, which few games use together. A placeholder until the native
    // hotkeys load: on a Steam Deck the native default is the R4 back grip (settings.rs).
    gamepadButtons: [10, 11]
  }
}

/** A binding's chord: `gamepadButtons` when present (even null), else the legacy single button. */
export function gamepadChord(binding: {
  gamepadButtons?: number[] | null
  gamepadButton?: number
}): number[] {
  const buttons =
    binding.gamepadButtons !== undefined
      ? (binding.gamepadButtons ?? [])
      : binding.gamepadButton !== undefined
        ? [binding.gamepadButton]
        : []
  return [...new Set(buttons)].sort((a, b) => a - b)
}

// Merge default hotkeys with custom overrides. Unknown override keys are ignored, which retires
// the bindings of actions that are no longer bindable.
export function mergeHotkeysWithOverrides(overrides: HotkeyOverrides = {}): HotkeysSettings {
  const merged: HotkeysSettings = {}

  for (const [key, defaultHotkey] of Object.entries(DEFAULT_HOTKEYS)) {
    const override = overrides[key]
    const hasChord =
      override !== undefined &&
      (override.gamepadButtons !== undefined || override.gamepadButton !== undefined)
    merged[key] = {
      ...defaultHotkey,
      ...(override && {
        accelerator: override.accelerator ?? defaultHotkey.accelerator,
        enabled: override.enabled ?? defaultHotkey.enabled,
        gamepadButtons: hasChord ? gamepadChord(override) : defaultHotkey.gamepadButtons
      })
    }
  }

  return merged
}
