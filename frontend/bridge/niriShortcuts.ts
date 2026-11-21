/**
 * Global shortcuts on niri without a shortcuts portal: Kimochi writes its binds to
 * `~/.config/niri/kimochi.kdl`, and niri's config has to include that file
 * (`platform/linux/shortcuts/niri.rs`, the `niri_shortcuts` command).
 */
import { useCallback, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { NiriShortcutSetup } from '@ui/capabilities'
import { useCapabilities } from './capabilities'

export type { NiriShortcutSetup }

/** The setup while niri's binds file is the shortcut backend; null anywhere else. */
export function useNiriShortcuts(): NiriShortcutSetup | null {
  const capabilities = useCapabilities()
  const report = capabilities.input.globalShortcutReport
  if (capabilities.os !== 'linux' || report?.backend !== 'niri') return null
  return report.niri ?? null
}

/** Read again whether niri's config includes the binds (the reader may have added the line). */
export function refreshNiriShortcuts(): Promise<NiriShortcutSetup> {
  return invoke<NiriShortcutSetup>('niri_shortcuts', { operation: 'status' })
}

/**
 * Append the include line to niri's config, after a backup; put back as it was if niri rejects
 * the result. Rejects with the reason it didn't.
 */
export function addNiriInclude(): Promise<NiriShortcutSetup> {
  return invoke<NiriShortcutSetup>('niri_shortcuts', { operation: 'append' })
}

/** A native error's text without its `invalid:`/`native:` prefix. */
export function niriErrorText(error: unknown): string {
  return String(error).replace(/^(invalid|native|busy|gone|not applicable):\s*/, '')
}

/** Adding the line: busy while it runs, the reason when it didn't. */
export function useNiriInclude(): { busy: boolean; error: string | null; add: () => void } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = useCallback(() => {
    setBusy(true)
    setError(null)
    addNiriInclude()
      .catch((caught: unknown) => setError(niriErrorText(caught)))
      .finally(() => setBusy(false))
  }, [])
  return { busy, error, add }
}
