/**
 * Settings → Overlay → Text Hooker card: how the hooked line's card looks over a game
 * (`HookCardPreview`, with the Text Hooker's defaults), and its look, apart from the overlay's
 * cards (`HookCardLookRow`, as on the Text Hooker page). Auto align, text size and opacity are the
 * Text Hooker's, so the button opens Settings → Text Hooker at its defaults' Card style. Shown where games can be hooked (Windows, and Linux through
 * Proton or Wine), as the Text Hooker page is.
 */
import type { ReactNode } from 'react'
import { Button, SettingsRow, SettingsSection } from '@kit'
import { useCapabilities } from '../../bridge/capabilities'
import { setSetting } from '../../bridge/settings'
import { HOOK_CARD_SECTION, requestSettingsSection } from '../../bridge/settingsTarget'
import { useHookCardLocksAutoAlign, useHookDefaults } from '../../main/hookGames'
import { HookCardPreview } from './HookCardPreview'
import { HookCardLookRow } from './CardLook'
import { showSettingsTab } from './showSettingsTab'

export function TextHookerCardSection(): ReactNode {
  const { os } = useCapabilities()
  const [defaults] = useHookDefaults()
  const alignLocked = useHookCardLocksAutoAlign()
  if (os !== 'windows' && os !== 'linux' && os !== 'macos') return null
  // With the card never shown over games by default (Text Hooker → Card), it has no look to set.
  if (defaults.showCard === 'never') return null

  const open = (): void => {
    // The defaults' Card style, not a game's page left open there.
    void setSetting('textHookerSettingsGame', null)
    requestSettingsSection(HOOK_CARD_SECTION)
    showSettingsTab('texthooker')
  }

  return (
    <SettingsSection title="Text Hooker card" description="The hooked line, shown over the game.">
      <HookCardPreview
        autoAlign={alignLocked || defaults.autoAlign}
        textSize={defaults.textSize}
        opacity={defaults.opacity}
      />
      <HookCardLookRow />
      {/* A Transparent card has nothing more to set (Text Hooker → Card style hides it too). */}
      {!alignLocked && (
        <SettingsRow label="Auto align, text size and opacity are set in Text Hooker settings">
          <Button size="sm" onClick={open}>
            Text Hooker settings
          </Button>
        </SettingsRow>
      )}
    </SettingsSection>
  )
}
