/** Settings → Shortcuts & Controls: keyboard shortcuts and the gamepad, which can trigger the same actions. */
import type { ReactNode } from 'react'
import { SettingsPage } from '@kit'
import { ShortcutsSections } from './ShortcutsSections'
import { GamepadSections } from './GamepadSections'
import { RadialMenuSection } from './RadialMenuSection'
import { useSettingsTarget } from '../../bridge/settingsTarget'

export function ControlsTab(): ReactNode {
  // Settings → Overlay → Radial menu's Configure button opens the Radial menu section.
  useSettingsTarget()
  return (
    <SettingsPage title="Shortcuts & Controls" description="Keyboard shortcuts and a game controller.">
      <ShortcutsSections />
      {/* Below the shortcut that opens the radial menu. */}
      <RadialMenuSection />
      <GamepadSections />
    </SettingsPage>
  )
}
