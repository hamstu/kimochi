/**
 * The onboarding window's three side effects, which were Electron IPC sends.
 * Each failure is logged with the native message rather than being swallowed.
 */
import { nativeError, panel } from '../bridge/tauri'
import { loadCapabilities } from '../bridge/capabilities'
import { setSetting } from '../bridge/settings'

const report = (what: string) => (error: unknown) =>
  console.error(`${what} failed:`, nativeError(error).message)

/** Electron's `resize-welcome-window`: same width and position, new height per step. */
export async function resizeWelcome(height: number): Promise<void> {
  try {
    if (
      (await loadCapabilities()).session?.compositor?.toLowerCase() ===
      'gamescope'
    )
      return
    const info = await panel('welcome', 'inspect')
    await panel('welcome', 'place', { ...info.bounds, height })
  } catch (error) {
    report('Resize welcome window')(error)
  }
}

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
 * If the flag cannot be persisted this throws instead of closing: silently hiding the window would
 * send the user back through onboarding on the next launch with no explanation.
 */
export async function completeOnboarding(): Promise<void> {
  try {
    await setSetting('hasCompletedOnboarding', true)
  } catch (error) {
    report('Complete onboarding')(error)
    throw new Error(
      `Could not save your setup: ${nativeError(error).message}. Nothing has been lost — try again.`
    )
  }
  await panel('log', 'show').catch(report('Show Kimochi'))
  await panel('welcome', 'hide').catch(report('Close onboarding'))
}
