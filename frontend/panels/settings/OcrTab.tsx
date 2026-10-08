/**
 * Settings → OCR: engine (and, in a local dev build with Cloud OCR chosen, its server), overlay
 * behaviour, auto-scan and change detection.
 */
import { useCallback, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Input,
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
  ServerSettings,
  TextOverlayGroupingSettings
} from '../../vendor/shared-types'
import { DEFAULT_SERVER_MODE, SERVER_URLS, type ServerMode } from '../../vendor/shared-constants'
import { OCR_MODES, type OcrMode } from '../../bridge/settings'
import { useSetting } from '../../bridge/useSetting'
import { useViewState } from '../../bridge/state'
import { useCapabilities, type PlatformCapabilities } from '../../bridge/capabilities'
import { nativeError, openAccessibilityPreferences, quitApp } from '../../bridge/tauri'
import { GamepadButtonCapture } from '../../components/GamepadButtonCapture'
import { ModelDownloadCard } from './ModelDownloadCard'

/** The engines, with those this machine cannot run disabled and the reason beside them. */
const ocrModeOptions = (
  engines: PlatformCapabilities['ocrEngines']
): { value: OcrMode; label: string; disabled?: boolean; detail?: string }[] =>
  (Object.keys(OCR_MODES) as OcrMode[]).map((value) => {
    const engine = engines[value]
    if (!engine || engine.available) return { value, label: OCR_MODES[value].label }
    // Held back only by its model: choosing it starts the download.
    if (engine.model) return { value, label: OCR_MODES[value].label, detail: engine.reason || undefined }
    return {
      value,
      label: OCR_MODES[value].label,
      disabled: true,
      detail: engine.reason || 'Not available on this computer'
    }
  })

/** The Trigger Keys warning on macOS when the backend gives no wording of its own. */
const MAC_KEY_TRIGGER_REASON =
  'Watching key presses in another application needs macOS Accessibility permission for Kimochi. Until it is granted these keys will not start a scan; the gamepad trigger is unaffected.'

/**
 * Whether this is a local development build. The frontend is always `vite build`-ed (even for
 * `tauri dev`), so `import.meta.env.DEV` only covers the Vite dev server; a debug native build
 * says so through `__KIMOCHI_PLATFORM__.debug` (`platform_prelude` in `src-tauri/src/platform`).
 */
const DEV_BUILD =
  import.meta.env.DEV ||
  (window as { __KIMOCHI_PLATFORM__?: { debug?: boolean } }).__KIMOCHI_PLATFORM__?.debug === true

const SERVER_OPTIONS = [
  { value: 'cloud', label: 'Cloud (recommended)' },
  { value: 'local', label: 'Local (localhost:3000)' }
] as const

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
  const [ocrMode, setOcrMode] = useSetting<OcrMode>('ocrMode', 'cloud')
  const [serverSettings, setServerSettings] = useSetting<ServerSettings>('serverSettings', {
    mode: DEFAULT_SERVER_MODE
  })
  const [liveOverlayEnabled, setLiveOverlayEnabled] = useSetting<boolean>('liveOverlayEnabled', false)
  const [autoScanSettings, setAutoScanSettings] = useSetting<AutoScanSettings>('autoScanSettings', {
    enabled: false,
    triggerKeys: '',
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
  // Watching keys inside another application needs macOS Accessibility; the backend reports
  // whether it has been granted, so the Trigger Keys field can say what is actually true.
  // On macOS the view state's `accessibility` flag is live, so it decides; elsewhere (and before
  // the flag arrives) the platform capabilities' `input.keyTrigger` does.
  const { state: viewState } = useViewState()
  const capabilities = useCapabilities()
  const keyTrigger = capabilities.input.keyTrigger
  const keyTriggerPermission =
    capabilities.os === 'macos' && typeof viewState.accessibility === 'boolean'
      ? viewState.accessibility
        ? 'granted'
        : 'denied'
      : keyTrigger.permission
  const keyTriggerWarning = keyTriggerPermission !== 'granted' && keyTriggerPermission !== 'notRequired'
  const keyTriggerReason =
    keyTrigger.reason ||
    (capabilities.os === 'macos'
      ? MAC_KEY_TRIGGER_REASON
      : 'Watching key presses in another application is not available on this computer, so these keys will not start a scan; the gamepad trigger is unaffected.')
  const ocrModes = ocrModeOptions(capabilities.ocrEngines)

  // Changing the server needs a restart, so it is confirmed first (local UI state, not persisted).
  const [pendingServerMode, setPendingServerMode] = useState<ServerMode | null>(null)

  const handleServerModeChange = useCallback(
    (mode: ServerMode): void => {
      if (mode !== serverSettings.mode) setPendingServerMode(mode)
    },
    [serverSettings.mode]
  )

  const confirmServerModeChange = useCallback(async (): Promise<void> => {
    if (pendingServerMode) {
      await setServerSettings({ mode: pendingServerMode })
      setPendingServerMode(null)
      // Request app quit
      quitApp().catch((error) => console.error('Quit failed:', nativeError(error).message))
    }
  }, [pendingServerMode, setServerSettings])

  const mode = OCR_MODES[ocrMode]
  // The server is a developer's switch, and only Cloud OCR talks to it.
  const showServer = DEV_BUILD && ocrMode === 'cloud'
  const filterSmallText = textOverlayGrouping.filterSmallText ?? true
  const threshold = Math.round((textOverlayGrouping.filterSmallTextThreshold ?? 0.75) * 100)

  const updateAutoOCR = (patch: Partial<AutoOCRSettings>): void =>
    void setAutoOCRSettings({ ...autoOCRSettings, ...patch })

  return (
    <SettingsPage title="OCR" description="How the screen is read, and what is drawn over your game.">
      <SettingsSection title="Engine">
        <SettingsRow
          label="OCR engine"
          description={
            <>
              {mode?.detail}
              {mode && !mode.geometry
                ? ' Results appear in the log, texthooker and audio, but nothing is drawn over your game.'
                : ''}
            </>
          }
        >
          <Select
            aria-label="OCR engine"
            value={ocrMode}
            onValueChange={(value) => void setOcrMode(value)}
            options={ocrModes}
          />
        </SettingsRow>
        {showServer && (
          <SettingsRow
            label="OCR server"
            description={
              <>
                Using <span className="k-mono">{serverSettings.mode === 'cloud' ? SERVER_URLS.cloud : SERVER_URLS.local}</span>.
                Changing it restarts Kimochi.
              </>
            }
          >
            <Select
              aria-label="OCR server"
              value={serverSettings.mode}
              onValueChange={(value) => handleServerModeChange(value as ServerMode)}
              options={SERVER_OPTIONS}
            />
          </SettingsRow>
        )}
      </SettingsSection>

      {(ocrMode === 'meikiocr' || ocrMode === 'mangaocr') && <ModelDownloadCard engine={ocrMode} />}

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
          label="Scan after a key press"
          controlId="ocr-autoscan"
          description="Scans automatically after you press chosen keys in your game or application."
        >
          <Switch
            id="ocr-autoscan"
            checked={autoScanSettings.enabled}
            onCheckedChange={(enabled) => void setAutoScanSettings({ ...autoScanSettings, enabled })}
          />
        </SettingsRow>
        {autoScanSettings.enabled && (
          <SettingsSubgroup>
            <SettingsRow label="Trigger keys" controlId="ocr-trigger-keys" description="Comma-separated.">
              <Input
                id="ocr-trigger-keys"
                className="settings-field"
                value={autoScanSettings.triggerKeys}
                onChange={(e) =>
                  void setAutoScanSettings({ ...autoScanSettings, triggerKeys: e.target.value })
                }
                placeholder="e.g. space, enter, z"
              />
            </SettingsRow>
            {keyTriggerWarning && (
              <div className="settings-note">
                <Callout tone="warn">
                  <span>
                    {keyTriggerReason}
                    {keyTrigger.remediation ? ` ${keyTrigger.remediation}` : ''}
                  </span>
                  {capabilities.os === 'macos' && (
                    <Button
                      size="sm"
                      onClick={() =>
                        void openAccessibilityPreferences().catch((error) =>
                          console.error('Open Accessibility settings failed:', nativeError(error).message)
                        )
                      }
                    >
                      Open Accessibility settings
                    </Button>
                  )}
                </Callout>
              </div>
            )}
            <SettingsRow label="Scan delay" description="Wait after the key press before scanning.">
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

      <ConfirmDialog
        open={showServer && pendingServerMode !== null}
        onOpenChange={(open) => {
          if (!open) setPendingServerMode(null)
        }}
        title="Restart required"
        description="Changing the OCR server requires restarting Kimochi. The app will quit and you'll need to reopen it manually."
        confirmLabel="Quit & apply"
        onConfirm={() => void confirmServerModeChange()}
      />
    </SettingsPage>
  )
}
