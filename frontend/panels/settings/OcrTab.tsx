/**
 * Settings → OCR & Overlay: the engine chooser (`EngineChooser`: the engines, what each is good
 * for, its model or server), then overlay behaviour, auto-scan and change detection. The page
 * keeps the `ocr` value, so deep links and `onSettingsTab('ocr')` still land here.
 */
import { type ReactNode } from 'react'
import {
  Badge,
  Select,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSubgroup,
  Slider,
  Switch
} from '@kit'
import { DEFAULT_AUTO_OCR_SETTINGS } from '../../../ui/autoscan'
import type {
  AutoOCRSettings,
  AutoScanSettings,
  TextOverlayGroupingSettings
} from '../../vendor/shared-types'
import { useSetting } from '../../bridge/useSetting'
import { GamepadButtonCapture } from '../../components/GamepadButtonCapture'
import { EngineChooser } from './EngineChooser'

const SCAN_DELAYS = [
  { value: '100', label: '100 ms' },
  { value: '500', label: '500 ms' },
  { value: '1000', label: '1 s' },
  { value: '1500', label: '1.5 s' },
  { value: '2000', label: '2 s' },
  { value: '3000', label: '3 s' }
]

const SETTLE_OPTIONS = [
  { value: '2', label: '2 readings', detail: 'Default' },
  { value: '3', label: '3 readings' },
  { value: '4', label: '4 readings' }
]

const MAX_WAIT_OPTIONS = [
  { value: '2000', label: '2 seconds' },
  { value: '4000', label: '4 seconds', detail: 'Default' },
  { value: '8000', label: '8 seconds' }
]

const MIN_SPACING_OPTIONS = [
  { value: '0', label: 'No limit' },
  { value: '800', label: '0.8 seconds' },
  { value: '1200', label: '1.2 seconds' },
  { value: '3000', label: '3 seconds' }
]

const POLL_OPTIONS = [
  { value: '250', label: '250 ms' },
  { value: '500', label: '500 ms', detail: 'Default' },
  { value: '1000', label: '1 second' },
  { value: '2000', label: '2 seconds' },
  { value: '3000', label: '3 seconds' },
  { value: '5000', label: '5 seconds' }
]

export function OcrTab(): ReactNode {
  const [liveOverlayEnabled, setLiveOverlayEnabled] = useSetting<boolean>('liveOverlayEnabled', false)
  const [autoScanSettings, setAutoScanSettings] = useSetting<AutoScanSettings>('autoScanSettings', {
    enabled: false,
    scanDelay: 500
  })
  const [textOverlayGrouping, setTextOverlayGrouping] = useSetting<TextOverlayGroupingSettings>(
    'textOverlayGrouping',
    {
      enabled: false,
      proximityThreshold: 50,
      filterSmallText: true,
      filterSmallTextThreshold: 0.75
    }
  )
  const [autoOCRSettings, setAutoOCRSettings] = useSetting<AutoOCRSettings>(
    'autoOCRSettings',
    DEFAULT_AUTO_OCR_SETTINGS
  )
  const filterSmallText = textOverlayGrouping.filterSmallText ?? true
  const threshold = Math.round((textOverlayGrouping.filterSmallTextThreshold ?? 0.75) * 100)

  const updateAutoOCR = (patch: Partial<AutoOCRSettings>): void =>
    void setAutoOCRSettings({ ...autoOCRSettings, ...patch })

  return (
    <SettingsPage
      title="OCR & Overlay"
      description="Which engine reads the screen, and what is drawn over your game."
    >
      <SettingsSection title="Engine" grouped={false}>
        <EngineChooser />
      </SettingsSection>

      <SettingsSection title="Overlay">
        <SettingsRow
          label="Overlay mode"
          badge={<Badge tone="warn">Experimental</Badge>}
          controlId="ocr-live-overlay"
          description="Hover scanned text in your game to see its definition. Look for the faint blue underlines."
        >
          <Switch
            id="ocr-live-overlay"
            checked={liveOverlayEnabled}
            onCheckedChange={(checked) => void setLiveOverlayEnabled(checked)}
          />
        </SettingsRow>
        <SettingsRow
          label="Group text into regions"
          controlId="ocr-grouping"
          description="Gives nearby text boxes a shared background. Useful for complex layouts."
        >
          <Switch
            id="ocr-grouping"
            checked={textOverlayGrouping.enabled}
            onCheckedChange={(enabled) => void setTextOverlayGrouping({ ...textOverlayGrouping, enabled })}
          />
        </SettingsRow>
        <SettingsRow
          label="Filter out furigana and small text"
          controlId="ocr-filter-small"
          description="Removes text much smaller than the main text, such as reading aids above kanji."
        >
          <Switch
            id="ocr-filter-small"
            checked={filterSmallText}
            onCheckedChange={(checked) =>
              void setTextOverlayGrouping({ ...textOverlayGrouping, filterSmallText: checked })
            }
          />
        </SettingsRow>
        {filterSmallText && (
          <SettingsSubgroup>
            <SettingsRow
              label="Size threshold"
              description={`Text under ${threshold}% of the median height is removed. Lower values filter more aggressively.`}
            >
              <div className="settings-slider">
                <Slider
                  aria-label="Size threshold"
                  value={[threshold]}
                  onValueChange={(values) =>
                    void setTextOverlayGrouping({
                      ...textOverlayGrouping,
                      filterSmallTextThreshold: values[0] / 100
                    })
                  }
                  min={50}
                  max={95}
                  step={5}
                />
                <span className="settings-slider-value k-num">{threshold}%</span>
              </div>
            </SettingsRow>
          </SettingsSubgroup>
        )}
      </SettingsSection>

      <SettingsSection title="Auto-scan">
        <SettingsRow
          label="Scan after a button press"
          controlId="ocr-autoscan"
          description="Scans automatically after you press a chosen gamepad button."
        >
          <Switch
            id="ocr-autoscan"
            checked={autoScanSettings.enabled}
            onCheckedChange={(enabled) => void setAutoScanSettings({ ...autoScanSettings, enabled })}
          />
        </SettingsRow>
        {autoScanSettings.enabled && (
          <SettingsSubgroup>
            <SettingsRow label="Scan delay" description="Wait after the button press before scanning.">
              <Select
                aria-label="Scan delay"
                value={autoScanSettings.scanDelay.toString()}
                onValueChange={(delay) =>
                  void setAutoScanSettings({ ...autoScanSettings, scanDelay: parseInt(delay, 10) })
                }
                options={SCAN_DELAYS}
              />
            </SettingsRow>
            <SettingsRow label="Gamepad trigger" description="A gamepad button that starts a scan.">
              <GamepadButtonCapture
                value={autoScanSettings.gamepadButton}
                onChange={(btn) => void setAutoScanSettings({ ...autoScanSettings, gamepadButton: btn })}
                size="1"
              />
            </SettingsRow>
          </SettingsSubgroup>
        )}
      </SettingsSection>

      <SettingsSection
        title="Change detection"
        description="Automatic scanning reads the screen locally several times a second and only spends a Cloud OCR request once the text stops changing."
      >
        <SettingsRow
          label="Adaptive polling"
          controlId="ocr-adaptive"
          description="Looks more often while text is moving and backs off once it settles."
        >
          <Switch
            id="ocr-adaptive"
            checked={autoOCRSettings.adaptivePollingEnabled}
            onCheckedChange={(checked) => updateAutoOCR({ adaptivePollingEnabled: checked })}
          />
        </SettingsRow>
        <SettingsRow
          label="Settle after"
          description="Identical readings in a row before the text is recognised. More means fewer requests and a longer wait after a line finishes drawing."
        >
          <Select
            aria-label="Settle after"
            value={autoOCRSettings.stableObservations.toString()}
            onValueChange={(value) => updateAutoOCR({ stableObservations: parseInt(value, 10) })}
            options={SETTLE_OPTIONS}
          />
        </SettingsRow>
        <SettingsRow
          label="Give up waiting after"
          description="Text that never stops animating is recognised anyway after this long, so a restless screen cannot starve you of a line."
        >
          <Select
            aria-label="Give up waiting after"
            value={autoOCRSettings.maxCandidateAgeMs.toString()}
            onValueChange={(value) => updateAutoOCR({ maxCandidateAgeMs: parseInt(value, 10) })}
            options={MAX_WAIT_OPTIONS}
          />
        </SettingsRow>
        <SettingsRow
          label="Minimum time between requests"
          description="A floor on how often Cloud OCR is called, however fast dialogue moves. Lines that arrive during the wait are not queued; only the latest is kept."
        >
          <Select
            aria-label="Minimum time between requests"
            value={autoOCRSettings.minRequestSpacingMs.toString()}
            onValueChange={(value) => updateAutoOCR({ minRequestSpacingMs: parseInt(value, 10) })}
            options={MIN_SPACING_OPTIONS}
          />
        </SettingsRow>
        <SettingsRow
          label="Base poll interval"
          description="How often to check for screen changes. With adaptive polling, the starting interval."
        >
          <Select
            aria-label="Base poll interval"
            value={autoOCRSettings.pollInterval.toString()}
            onValueChange={(value) => updateAutoOCR({ pollInterval: parseInt(value, 10) })}
            options={POLL_OPTIONS}
          />
        </SettingsRow>
      </SettingsSection>

    </SettingsPage>
  )
}
