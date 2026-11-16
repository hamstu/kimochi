/**
 * The onboarding window's side effects, which were Electron IPC sends.
 * Each failure is logged with the native message rather than being swallowed.
 */
import { nativeError, panel } from '../bridge/tauri'
import { setSetting } from '../bridge/settings'

const report = (what: string) => (error: unknown) => console.error(`${what} failed:`, nativeError(error).message)

/**
 * Electron's `yomitan-settings-backup`: opens the active dictionary engine's settings in their own
 * panel window (the `dictionary` window, which follows the engine).
 */
export const openYomitanBackup = (): Promise<void> =>
  panel('dictionary', 'show')
    .then(() => undefined)
    .catch(report('Open dictionary settings'))

/**
 * Electron's `complete-onboarding`: record it, show the main window, close onboarding.
 *
 * Keep the guide open if saving or opening the main window fails. Concurrent callers (including
 * Strict Mode's effect replay) share one handoff; a settled attempt can be retried after failure.
 */
let completing: Promise<void> | null = null

export function completeOnboarding(): Promise<void> {
  completing ??= finishOnboarding().finally(() => {
    completing = null
  })
  return completing
}

async function finishOnboarding(): Promise<void> {
  try {
    await setSetting('hasCompletedOnboarding', true)
  } catch (error) {
    report('Complete onboarding')(error)
    throw new Error(`Couldn't save your setup: ${nativeError(error).message}. Try again.`)
  }
  try {
    await panel('log', 'show')
  } catch (error) {
    report('Show Kimochi')(error)
    throw new Error(`Your setup was saved, but Kimochi couldn't open: ${nativeError(error).message}. Try again.`)
  }
  try {
    await panel('welcome', 'hide')
  } catch (error) {
    report('Close onboarding')(error)
    throw new Error(`Kimochi is open, but this guide couldn't close: ${nativeError(error).message}. Try again.`)
  }
}
