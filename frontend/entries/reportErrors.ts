/**
 * Kimochi's windows have no devtools open in ordinary use: an uncaught error (often a blank
 * window) goes to the app's diagnostics record (`report` → `evidence.jsonl`) as `panel-error`,
 * where Settings → About → Debug info picks it up for a bug report.
 */
import { invoke } from '@tauri-apps/api/core'

export function reportError(window: string, kind: string, error: unknown): void {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  void invoke('report', {
    value: { check: 'panel-error', window, kind, message: message.slice(0, 2000) }
  }).catch(() => undefined)
}

/** Reports this document's uncaught errors and unhandled rejections as `window`'s. */
export function reportUncaughtErrors(window: string): void {
  globalThis.addEventListener('error', (event) => reportError(window, 'error', event.error ?? event.message))
  globalThis.addEventListener('unhandledrejection', (event) => reportError(window, 'rejection', event.reason))
}
