/**
 * Settings → Overlay: what Kimochi draws over your source and how it behaves (overlay mode,
 * grouping, the furigana and language filters, click-through, hiding it from recordings), how it
 * looks (`OverlayLook`, and the dictionary pop-up's opacity, `DictionaryOpacityRow`), the Text Hooker's card as it looks over
 * a game, set in Settings → Text Hooker (`TextHookerCardSection`, Windows and Linux), the radial menu
 * (`RadialMenuSection`, as in Shortcuts & Controls), and Game Mode, how Read along shows the dictionary
 * (`GameModeSection`). Choosing the OCR engine and Auto OCR are on Settings → OCR.
 */
import type { ReactNode } from 'react'
import { SettingsPage, SettingsRow, SettingsSection, Switch } from '@kit'
import { isGamingMode, useCapabilities } from '../../bridge/capabilities'
import type { TextOverlayGroupingSettings } from '../../vendor/shared-types'
import { useSetting } from '../../bridge/useSetting'
import { clickThroughLocked } from '@ui/settings'
import { JapaneseFilterRow } from './JapaneseFilterRow'
import { OverlayLook } from './OverlayLook'
import { SmallTextFilter } from './SmallTextFilter'
import { GameModeSection } from './GameModeSection'
import { TextHookerCardSection } from './TextHookerCardSection'
import { GamePauseRow } from './GamePauseRow'
import { DictionaryOpacityRow } from './DictionaryOpacityRow'
import { RadialMenuSection } from './RadialMenuSection'
import { HoverLookupRow } from './HoverLookupRow'

export function OverlayTab(): ReactNode {
  const [liveOverlayEnabled, setLiveOverlayEnabled] = useSetting<boolean>('liveOverlayEnabled', false)
  // Gaming Mode always draws the overlay (ui/overlay.js `overlayTextOn`): nothing to switch.
  const capabilities = useCapabilities()
  const gaming = isGamingMode(capabilities)
  const [lookupCursor, setLookupCursor] = useSetting<boolean>('overlayLookupCursor', false)
  const [excludeFromCapture, setExcludeFromCapture] = useSetting<boolean>('excludeOverlayFromCapture', true)
  const [clickThrough, setClickThrough] = useSetting<boolean>('overlayClickThrough', true)
  // Text drawn Transparent always lets clicks through (ui/settings.ts `clickThroughLocked`).
  const [overlayStyle] = useSetting<unknown>('overlayStyle', null)
  const locked = clickThroughLocked(overlayStyle, 'words')
  const cardLocked = clickThroughLocked(overlayStyle, 'card')
  const [matchOutline, setMatchOutline] = useSetting<boolean>('overlayMatchOutline', true)
  const [textOverlayGrouping, setTextOverlayGrouping] = useSetting<TextOverlayGroupingSettings>('textOverlayGrouping', {
    enabled: false,
    proximityThreshold: 50,
    filterSmallText: true,
    filterSmallTextThreshold: 0.75
  })
  const filterSmallText = textOverlayGrouping.filterSmallText ?? true

  return (
    <SettingsPage title="Overlay" description="What Kimochi draws over your source, and how it looks.">
      <SettingsSection title="Overlay">
        {!gaming && (
          <SettingsRow
            label="Overlay enabled"
            controlId="ocr-live-overlay"
            description="Draws scanned text over your source, to look its words up where they are."
          >
            <Switch
              id="ocr-live-overlay"
              checked={liveOverlayEnabled}
              onCheckedChange={(checked) => void setLiveOverlayEnabled(checked)}
            />
          </SettingsRow>
        )}
        <SettingsRow
          label="Group text into regions"
          controlId="ocr-grouping"
          description="Marks nearby lines with one shared box to hover, instead of a box for each line."
        >
          <Switch
            id="ocr-grouping"
            checked={textOverlayGrouping.enabled}
            onCheckedChange={(enabled) => void setTextOverlayGrouping({ ...textOverlayGrouping, enabled })}
          />
        </SettingsRow>
        <HoverLookupRow />
        <SmallTextFilter
          enabled={filterSmallText}
          threshold={textOverlayGrouping.filterSmallTextThreshold ?? 0.75}
          onEnabledChange={(checked) =>
            void setTextOverlayGrouping({ ...textOverlayGrouping, filterSmallText: checked })
          }
          onThresholdChange={(value) =>
            void setTextOverlayGrouping({ ...textOverlayGrouping, filterSmallTextThreshold: value })
          }
        />
        <SettingsRow
          label="Click through text to the game"
          controlId="ocr-click-through"
          disabled={locked}
          description={
            locked
              ? 'Always on while Hover card appearance is Transparent: you can’t see the text, so it never takes your clicks. Hold Shift to look words up.'
              : (clickThrough
                  ? 'Clicks on scanned text go to the game. Hold Shift to light up text, look words up and click them.'
                  : 'Scanned text lights up as you hover it and takes your clicks. Hold Shift to look words up.') +
                (cardLocked ? ' The Text Hooker’s card lets clicks through while its look is Transparent.' : '')
          }
        >
          <Switch
            id="ocr-click-through"
            checked={clickThrough || locked}
            disabled={locked}
            onCheckedChange={(checked) => void setClickThrough(checked)}
          />
        </SettingsRow>
        <SettingsRow
          label="Exclude overlay from screen recording"
          controlId="ocr-exclude-capture"
          description="Hides the overlay and pop-ups from captures, so Kimochi doesn't read its own text."
        >
          <Switch
            id="ocr-exclude-capture"
            checked={excludeFromCapture}
            onCheckedChange={(checked) => void setExcludeFromCapture(checked)}
          />
        </SettingsRow>
        {capabilities.os === 'windows' && (
          <SettingsRow
            label="Show a cursor while looking up"
            controlId="overlay-lookup-cursor"
            description="While holding the lookup key. A visual aid only: it does not release a pointer locked by the game."
          >
            <Switch
              id="overlay-lookup-cursor"
              checked={lookupCursor}
              onCheckedChange={(checked) => void setLookupCursor(checked)}
            />
          </SettingsRow>
        )}
        <GamePauseRow />
        <JapaneseFilterRow />
      </SettingsSection>

      <SettingsSection
        title="Overlay appearance"
        description="How scanned text is marked on your source, the card it turns into when you hover it, and the dictionary pop-up."
      >
        <OverlayLook />
        {(locked || cardLocked) && (
          <SettingsRow
            label="Outline the word being looked up"
            controlId="ocr-match-outline"
            description="Only for Transparent: shows a faint outline over the word being looked up, as Read along does."
          >
            <Switch
              id="ocr-match-outline"
              checked={matchOutline !== false}
              onCheckedChange={(checked) => void setMatchOutline(checked)}
            />
          </SettingsRow>
        )}
        <DictionaryOpacityRow />
      </SettingsSection>

      <TextHookerCardSection />

      <RadialMenuSection withShortcut />

      <GameModeSection />
    </SettingsPage>
  )
}
