/**
 * Debug info for bug reports (`debug_report`, `debug_bundle_save`, `debug_verbose_set`; COMMANDS.md
 * → Debug info). The Markdown is `ui/debug-report.ts`'s.
 */
import { invoke } from '@tauri-apps/api/core'
import type { DebugReport } from '@ui/debug-report'

export type { DebugReport }

/** Everything a remote bug report needs, already redacted. */
export const debugReport = (): Promise<DebugReport> => invoke<DebugReport>('debug_report')

/** Asks where to save, then writes the zip; `saved: false` when the dialog was cancelled. */
export const saveDebugBundle = (markdown: string): Promise<{ saved: boolean; path?: string }> =>
  invoke('debug_bundle_save', { markdown })

/** Turns verbose logging on or off for this run; with no argument, whether it is on. */
export const verboseLogging = (enabled?: boolean): Promise<boolean> =>
  invoke<boolean>('debug_verbose_set', enabled === undefined ? {} : { enabled })
