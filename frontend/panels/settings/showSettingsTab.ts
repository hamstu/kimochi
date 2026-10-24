/** Moves Settings to another page, from a link on one page to the page that holds a setting. */
import { setSetting } from '../../bridge/settings'
import { nativeError, type SettingsTabName } from '../../bridge/tauri'

export function showSettingsTab(tab: SettingsTabName): void {
  setSetting('settingsActiveTab', tab).catch((error) =>
    console.error(`Open Settings → ${tab} failed:`, nativeError(error).message)
  )
}
