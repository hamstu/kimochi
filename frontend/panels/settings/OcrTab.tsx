/**
 * Settings → OCR & Overlay: the engine chooser (`EngineChooser`: the engines, what each is good
 * for, its model or server), then overlay behaviour, auto-scan and Auto OCR (the main window's
 * switch, with change detection's tuning behind an Advanced options disclosure). The page
 * keeps the `ocr` value, so deep links and `onSettingsTab('ocr')` still land here.
 */
import { useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  IconButton,
  Select,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSubgroup,
  Switch,
  cn
} from '@kit'
import { DEFAULT_AUTO_OCR_SETTINGS } from '../../../ui/autoscan'
import {
  resolveWatcher,
  watcherChoiceApplies,
  WATCHER_ENGINES,
  type Watcher,
  type WatcherChoice
} from '../../../ui/watcher'
import { OCR_MODES, type OcrMode } from '../../bridge/settings'
import { useCapabilities } from '../../bridge/capabilities'
import type {
  AutoOCRSettings,
  AutoScanSettings,
  TextOverlayGroupingSettings
} from '../../vendor/shared-types'
import { useSetting } from '../../bridge/useSetting'
import { useViewState } from '../../bridge/state'
import { triggerAction } from '../../bridge/tauri'
import { GamepadButtonCapture } from '../../components/GamepadButtonCapture'
import { JapaneseOnlyRows } from './JapaneseOnlyRows'
import { EngineChooser } from './EngineChooser'
import { OverlayLook } from './OverlayLook'
import { SmallTextFilter } from './SmallTextFilter'
import './ocr-tab.css'

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

/** What a watcher is called in Settings. */
function watcherName(watcher: Watcher): string {
  return watcher.kind === 'image' ? 'image comparison' : OCR_MODES[watcher.engine].name
}

/** The Auto OCR row's description: what watches, and what reads. */
function autoOcrDescription(ocrMode: OcrMode, watcher: Watcher): string {
  const reader = OCR_MODES[ocrMode]?.name ?? 'the selected engine'
  if (watcher.kind === 'text' && watcher.because === 'selected') {
    return `Reads the screen again whenever its text changes. ${reader} watches for new text and reads it.`
  }
  if (watcher.kind === 'image') {
    return `Reads the screen again whenever it changes. With no local text engine here, Kimochi watches for the picture changing, then ${reader} reads it. Download PaddleOCR in the engine list above for smarter watching.`
  }
  return `Reads the screen again whenever its text changes. ${watcherName(watcher)} watches for new text on this computer, then ${reader} reads it once it settles.`
}

export function OcrTab(): ReactNode {
  const [liveOverlayEnabled, setLiveOverlayEnabled] = useSetting<boolean>('liveOverlayEnabled', false)
  const [excludeFromCapture, setExcludeFromCapture] = useSetting<boolean>('excludeOverlayFromCapture', true)
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
  const [ocrMode] = useSetting<OcrMode>('ocrMode', 'googlelens')
  const engines = useCapabilities().ocrEngines
  const watcherChoice: WatcherChoice = autoOCRSettings.watcher ?? 'auto'
  const watcher = resolveWatcher(ocrMode, engines, watcherChoice)
  const best = resolveWatcher(ocrMode, engines, 'auto')
  const watcherOptions = [
    { value: 'auto', label: 'Automatic', detail: watcherName(best) },
    ...WATCHER_ENGINES.filter((engine) => engines[engine]?.available).map((engine) => ({
      value: engine,
      label: OCR_MODES[engine].name
    })),
    { value: 'image', label: 'Image comparison', detail: 'Any change of picture' }
  ]
  const filterSmallText = textOverlayGrouping.filterSmallText ?? true
  // Auto OCR is the overlay's live flag, the same one the main window's Auto OCR row flips.
  const autoOcrEnabled = Boolean(useViewState().state.autoOcrEnabled)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const advancedPanel = useId()

  const updateAutoOCR = (patch: Partial<AutoOCRSettings>): void =>
    void setAutoOCRSettings({ ...autoOCRSettings, ...patch })

  return (
    <SettingsPage
      title="OCR & Overlay"
      description="Which engine reads the screen, and what is drawn over your source."
    >
      <SettingsSection title="Engine" grouped={false}>
        <EngineChooser />
      </SettingsSection>

      <SettingsSection title="Overlay">
        <SettingsRow
          label="Overlay mode"
          controlId="ocr-live-overlay"
          description="Hover scanned text on your source to see its definition. Look for the faint highlights."
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
        <JapaneseOnlyRows idPrefix="ocr" />
        <SettingsRow
          label="Exclude overlay from screen recording"
          controlId="ocr-exclude-capture"
          description="Keeps the overlay and dictionary pop-ups out of screenshots and recordings, so Kimochi never reads its own text back. Turn it off to show them; with a whole screen as your source, Kimochi may then scan its own pop-ups."
        >
          <Switch
            id="ocr-exclude-capture"
            checked={excludeFromCapture}
            onCheckedChange={(checked) => void setExcludeFromCapture(checked)}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Overlay look"
        description="How scanned text is marked on your source, and the card it turns into when you hover it."
      >
        <OverlayLook />
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

      <SettingsSection title="Auto OCR">
        <SettingsRow
          label="Auto OCR"
          controlId="ocr-auto"
          description={autoOcrDescription(ocrMode, watcher)}
        >
          <Switch
            id="ocr-auto"
            checked={autoOcrEnabled}
            onCheckedChange={(checked) => {
              if (checked !== autoOcrEnabled) void triggerAction('toggleAutoOcr').catch(() => undefined)
            }}
          />
        </SettingsRow>
        <SettingsRow label="Advanced options" controlId="ocr-auto-advanced">
          <IconButton
            id="ocr-auto-advanced"
            label={advancedOpen ? 'Hide advanced options' : 'Advanced options'}
            size="sm"
            className={cn('ocr-disclosure', advancedOpen && 'ocr-disclosure-open')}
            aria-expanded={advancedOpen}
            aria-controls={advancedPanel}
            onClick={() => setAdvancedOpen(!advancedOpen)}
          >
            <ChevronDown />
          </IconButton>
        </SettingsRow>
        {advancedOpen && (
          <SettingsSubgroup>
            <div id={advancedPanel}>
              {watcherChoiceApplies(ocrMode, engines) && (
                <SettingsRow
                  label="Watch the screen with"
                  description="The local engine that notices new text before the selected engine reads it. Automatic picks the best one on this computer."
                >
                  <Select
                    aria-label="Watch the screen with"
                    value={watcherOptions.some((o) => o.value === watcherChoice) ? watcherChoice : 'auto'}
                    onValueChange={(value) => updateAutoOCR({ watcher: value as WatcherChoice })}
                    options={watcherOptions}
                  />
                </SettingsRow>
              )}
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
                description="Identical readings in a row before the text is recognised."
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
                description="Text that never stops animating is recognised anyway after this long."
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
                description="A floor on how often the OCR engine is called. Only the latest line is kept."
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
            </div>
          </SettingsSubgroup>
        )}
      </SettingsSection>

    </SettingsPage>
  )
}
