/**
 * The native settings window: a rail of categories and one page per category.
 *
 * Originally a fork of the Electron app's `SettingsDialog.tsx`. The pages follow the path text
 * takes through Kimochi: where it comes from (Sources, OCR), how the Log shows and keeps it (Log),
 * looking it up (Dictionary, with the Anki setup of Kimochi's pop-up), help with it (Translation &
 * AI), and how Kimochi is driven (Shortcuts & Controls). Deltas from Electron that still hold:
 *  1. There is no Source tab: choosing a window or screen and editing its crop are in the source
 *     picker, and the input kind is on the Sources page and in the sidebar's source menu.
 *  2. Transport: `window.yomitan.*` -> the bridge, `close-app` IPC -> `quitApp()`.
 *  3. Additions, all honest about what is not proven yet (see PARITY_GAPS.md): the OCR engine
 *     selector (`ocrMode`), failed global-shortcut registrations, and the unverified-gamepad
 *     warning.
 *  4. Each category is its own component in `./settings/` and owns its settings and handlers. The
 *     pages that edit the Log's settings share one connection, `ReaderSettingsProvider`.
 */
import { useEffect, type JSX } from 'react'
import { listen } from '@tauri-apps/api/event'
import { SettingsShell, SettingsTab } from './settings/SettingsShell'
import { SettingsPageFor } from './settings/SettingsPageFor'
import { SETTINGS_NAV, settingsTabOf } from './settings/settingsNav'
import { ReaderSettingsProvider } from './settings/ReaderSettingsProvider'
import { useSetting } from '../bridge/useSetting'
import './settings-panel.css'

function SettingsPanel(): JSX.Element {
  const [stored, setActiveTab] = useSetting<string>('settingsActiveTab', 'general')
  const activeTab = settingsTabOf(stored)
  useEffect(() => {
    const pending = listen('reader:open-settings', () => setActiveTab('log'))
    return () => {
      void pending.then((off) => off())
    }
  }, [setActiveTab])

  return (
    <div style={{ height: '100%' }}>
      <ReaderSettingsProvider>
        <SettingsShell value={activeTab} onValueChange={setActiveTab} items={SETTINGS_NAV}>
          {SETTINGS_NAV.map((item) => (
            <SettingsTab key={item.value} value={item.value}>
              <SettingsPageFor tab={item.value} />
            </SettingsTab>
          ))}
        </SettingsShell>
      </ReaderSettingsProvider>
    </div>
  )
}

export default SettingsPanel
