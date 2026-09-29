/**
 * The native settings window: a rail of categories and one page per category.
 *
 * Originally a fork of the Electron app's `SettingsDialog.tsx`. Deltas that still hold:
 *  1. The **Source** tab is removed (source selection and crop editing moved to the source picker).
 *  2. Transport: `window.yomitan.*` -> the bridge, `close-app` IPC -> `quitApp()`, "Open Yomitan
 *     Settings" -> `openDictionary(true)` because the real Yomitan UI lives in the overlay WebView
 *     where its backend and IndexedDB are.
 *  3. Additions, all honest about what is not proven yet (see PARITY_GAPS.md): the OCR engine
 *     selector (`ocrMode`), the Accessibility note on trigger keys, failed global-shortcut
 *     registrations, and the unverified-gamepad warning.
 *  4. Each category is its own component in `./settings/` and owns its settings and handlers.
 */
import { useEffect, type JSX } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  BookOpen,
  Gamepad2,
  Keyboard,
  ScanText,
  ScrollText,
  SlidersHorizontal,
  Volume2
} from 'lucide-react'
import TexthookerSettingsTab from '../texthooker/SettingsTab'
import { SettingsShell, SettingsTab, type SettingsNavItem } from './settings/SettingsShell'
import { GeneralTab } from './settings/GeneralTab'
import { OcrTab } from './settings/OcrTab'
import { ShortcutsTab } from './settings/ShortcutsTab'
import { GamepadTab } from './settings/GamepadTab'
import { DictionaryTab } from './settings/DictionaryTab'
import { AudioTab } from './settings/AudioTab'
import { useSetting } from '../bridge/useSetting'
import './settings-panel.css'

const NAV: readonly SettingsNavItem[] = [
  { value: 'general', label: 'General', icon: <SlidersHorizontal /> },
  { value: 'mode', label: 'OCR', icon: <ScanText /> },
  { value: 'shortcuts', label: 'Shortcuts', icon: <Keyboard /> },
  { value: 'gamepad', label: 'Gamepad', icon: <Gamepad2 /> },
  { value: 'yomitan', label: 'Dictionary', icon: <BookOpen /> },
  { value: 'audio', label: 'Audio', icon: <Volume2 /> },
  { value: 'texthooker', label: 'Texthooker', icon: <ScrollText /> }
]

function SettingsPanel(): JSX.Element {
  const [activeTab, setActiveTab] = useSetting('settingsActiveTab', 'general')
  useEffect(() => {
    const pending = listen('reader:open-settings', () => setActiveTab('texthooker'))
    return () => {
      void pending.then((off) => off())
    }
  }, [setActiveTab])

  return (
    <div style={{ height: '100%' }}>
      <SettingsShell value={activeTab} onValueChange={setActiveTab} items={NAV}>
        <SettingsTab value="general">
          <GeneralTab />
        </SettingsTab>
        <SettingsTab value="mode">
          <OcrTab />
        </SettingsTab>
        <SettingsTab value="shortcuts">
          <ShortcutsTab />
        </SettingsTab>
        <SettingsTab value="gamepad">
          <GamepadTab />
        </SettingsTab>
        <SettingsTab value="yomitan">
          <DictionaryTab />
        </SettingsTab>
        <SettingsTab value="audio">
          <AudioTab />
        </SettingsTab>
        {/* Stays mounted so the texthooker client and its subscriptions survive tab switches. */}
        <SettingsTab value="texthooker" forceMount hidden={activeTab !== 'texthooker'}>
          <TexthookerSettingsTab />
        </SettingsTab>
      </SettingsShell>
    </div>
  )
}

export default SettingsPanel
