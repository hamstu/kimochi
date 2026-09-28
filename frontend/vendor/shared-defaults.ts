/**
 * VERBATIM COPY of `src/shared/defaults.ts` from the Electron app (do not hand-edit).
 * Kept byte-identical apart from this header and relative import paths.
 */
import { HotkeysSettings, HotkeyOverrides } from './shared-types'

export const DEFAULT_HOTKEYS: HotkeysSettings = {
  triggerScan: {
    name: 'Trigger Scan',
    accelerator: 'CommandOrControl+Shift+8',
    description: 'Trigger OCR scan on current source',
    enabled: true
  },
  toggleOverlay: {
    name: 'Toggle Overlay',
    accelerator: 'CommandOrControl+Shift+9',
    description: 'Show or hide the overlay window',
    enabled: true
  },
  setCropArea: {
    name: 'Set Crop Area',
    accelerator: 'CommandOrControl+Shift+0',
    description: 'Set a new crop area for the current source',
    enabled: true
  },
  playAudio: {
    name: 'Play Audio',
    accelerator: 'CommandOrControl+Shift+7',
    description: 'Play audio of scanned text',
    enabled: true
  },
  selectAndScan: {
    name: 'Select and Scan',
    accelerator: 'CommandOrControl+Shift+6',
    description: 'Select a screen region and scan immediately',
    enabled: true
  }
}

// Merge default hotkeys with custom overrides
export function mergeHotkeysWithOverrides(overrides: HotkeyOverrides = {}): HotkeysSettings {
  const merged: HotkeysSettings = {}

  // Start with all default hotkeys
  for (const [key, defaultHotkey] of Object.entries(DEFAULT_HOTKEYS)) {
    merged[key] = {
      ...defaultHotkey,
      // Override with custom accelerator, enabled state, and gamepad button if provided
      ...(overrides[key] && {
        accelerator: overrides[key].accelerator ?? defaultHotkey.accelerator,
        enabled: overrides[key].enabled ?? defaultHotkey.enabled,
        gamepadButton: overrides[key].gamepadButton
      })
    }
  }

  return merged
}
