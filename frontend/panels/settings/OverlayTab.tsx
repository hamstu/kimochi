/**
 * Settings → Overlay: what Kimochi draws over your source and how it behaves (overlay mode,
 * grouping, the furigana and language filters, click-through, hiding it from recordings), how it
 * looks (`OverlayLook`), the Text Hooker's card as it looks over a game, set in Settings → Text
 * Hooker (`TextHookerCardSection`, Windows and Linux), and Game Mode, how Read along shows the dictionary
 * (`GameModeSection`). Choosing the OCR engine and Auto OCR are on Settings → OCR.
 */
import type { ReactNode } from 'react'
import { SettingsPage, SettingsRow, SettingsSection, Select, Switch } from '@kit'
import { isGamingMode, useCapabilities } from '../../bridge/capabilities'
import type { TextOverlayGroupingSettings } from '../../vendor/shared-types'
import { useSetting } from '../../bridge/useSetting'
import { JapaneseFilterRow } from './JapaneseFilterRow'
import { OverlayLook } from './OverlayLook'
import { SmallTextFilter } from './SmallTextFilter'
import { GameModeSection } from './GameModeSection'
import { TextHookerCardSection } from './TextHookerCardSection'

export function OverlayTab(): ReactNode {
  const [liveOverlayEnabled, setLiveOverlayEnabled] = useSetting<boolean>('liveOverlayEnabled', false)
  // Gaming Mode always draws the overlay (ui/overlay.js `overlayTextOn`): nothing to switch.
  const capabilities = useCapabilities()
  const gaming = isGamingMode(capabilities)
  const [excludeFromCapture, setExcludeFromCapture] = useSetting<boolean>('excludeOverlayFromCapture', true)
  const [invisible, setInvisible] = useSetting<boolean>('overlayInvisible', false)
  const [popupDelay, setPopupDelay] = useSetting<number>('overlayPopupDismissDelay', 1000)
  const [hover, setHover] = useSetting<boolean>('overlayHoverLookup', false)
  const hoverTakesClicks = capabilities.os === 'linux' && capabilities.session?.backend === 'wayland' && hover
  const [clickThrough, setClickThrough] = useSetting<boolean>('overlayClickThrough', true)
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
        <SettingsRow
          label="Invisible overlay"
          controlId="overlay-invisible"
          description="Look up words over the original game text, without backgrounds, highlights or redrawn characters. For hooked text, leave Auto align on to position the lookup text."
        >
          <Switch
            id="overlay-invisible"
            checked={invisible}
            onCheckedChange={(checked) => void setInvisible(checked)}
          />
        </SettingsRow>
        {!gaming && (
          <SettingsRow
            label="Look up on hover"
            controlId="overlay-hover"
            description="Look up words without holding a key. Turn off to use the lookup key set in Shortcuts & Controls. On Wayland, hover lookup takes clicks on text."
          >
            <Switch id="overlay-hover" checked={hover} onCheckedChange={(checked) => void setHover(checked)} />
          </SettingsRow>
        )}
        {!gaming && (
          <SettingsRow
            label="Overlay mode"
            controlId="ocr-live-overlay"
            description="Hover scanned text on your source to see its definition."
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
        <JapaneseFilterRow />
        <SettingsRow
          label="Click through text to the game"
          controlId="ocr-click-through"
          description={
            hoverTakesClicks
              ? 'Hover lookup on Wayland receives clicks on text so it can detect the pointer without a key.'
              : clickThrough
                ? 'Clicks on scanned text go to the game. Hold Shift to light up text, look words up and click them.'
                : 'Scanned text lights up as you hover it and takes your clicks. Hold Shift to look words up.'
          }
        >
          <Switch
            id="ocr-click-through"
            disabled={hoverTakesClicks}
            checked={clickThrough && !hoverTakesClicks}
            onCheckedChange={(checked) => void setClickThrough(checked)}
          />
        </SettingsRow>
        {!gaming && (capabilities.os === 'windows' || capabilities.session?.backend === 'wayland') && (
          <SettingsRow
            label="Pop-up dismissal delay"
            description="Time to cross from game text into the dictionary. Entering the pop-up keeps it open. On Windows, applies when click-through is off."
          >
            <Select
              aria-label="Pop-up dismissal delay"
              value={String(popupDelay)}
              onValueChange={(value) => void setPopupDelay(Number(value))}
              options={[
                { value: '300', label: '0.3 seconds' },
                { value: '600', label: '0.6 seconds' },
                { value: '1000', label: '1 second' },
                { value: '1500', label: '1.5 seconds' },
                { value: '3000', label: '3 seconds' },
                { value: '0', label: 'Until dismissed' }
              ]}
            />
          </SettingsRow>
        )}
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
      </SettingsSection>

      <SettingsSection
        title="Overlay appearance"
        description={
          invisible
            ? 'Used when Invisible overlay is off. The preview stays visible so you can adjust the appearance.'
            : 'How scanned text is marked on your source, and the card it turns into when you hover it.'
        }
      >
        <OverlayLook />
      </SettingsSection>

      <TextHookerCardSection />

      <GameModeSection />
    </SettingsPage>
  )
}
