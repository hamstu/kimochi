/** Settings → Shortcuts & Controls: keyboard shortcuts and the gamepad, which can trigger the same actions. */
import type { ReactNode } from 'react'
import { SettingsPage } from '@kit'
import { ShortcutsSections } from './ShortcutsSections'
import { GamepadSections } from './GamepadSections'
import { RadialMenuSection } from './RadialMenuSection'

export function ControlsTab(): ReactNode {
  return (
    <SettingsPage title="Shortcuts & Controls" description="Keyboard shortcuts and a game controller.">
      <ShortcutsSections />
      {/* Below the shortcut that opens the controller menu. */}
      <RadialMenuSection />
      <GamepadSections />
    </SettingsPage>
  )
}
