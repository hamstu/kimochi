/**
 * FORK of `src/renderer/src/components/SettingsDialog.tsx` for the native settings window.
 *
 * Deltas:
 *  1. The **Source** tab is removed (source selection and crop editing moved to the source picker),
 *     so the default tab is now **OCR**. Every other tab is byte-for-byte the original markup.
 *  2. Transport: `window.yomitan.*` -> the bridge, `close-app` IPC -> `quitApp()`, "Open Yomitan
 *     Settings" -> `dictionary({open:true})` because the real Yomitan UI lives in the overlay
 *     WebView where its backend and IndexedDB are.
 *  3. Additions, all honest about what is not proven yet (see PARITY_GAPS.md):
 *     - **OCR engine** selector for the new `ocrMode` setting, stating that the local and
 *       WebSocket engines return plain text with no geometry, so they feed the log, texthooker and
 *       audio but draw no overlay boxes;
 *     - a note on **Trigger Keys** that the key hook needs macOS Accessibility;
 *     - failed global-shortcut registrations are listed instead of failing silently;
 *     - the Gamepad tab says plainly that gamepad input is not yet verified in this build.
 *  4. The dialog's open/close opacity wrapper is gone: this is a real window now.
 */
import { DEFAULT_AUTO_OCR_SETTINGS } from '../../ui/autoscan'
import { useState, useEffect, useCallback, type JSX } from 'react'
import {
  YomitanSettings,
  PopupType,
  AudioSettings,
  AutoScanSettings,
  TextOverlayGroupingSettings,
  ServerSettings,
  AutoOCRSettings,
  TexthookerSettings
} from '../vendor/shared-types'
import {
  Flex,
  Text,
  Dialog,
  Select,
  Button,
  Checkbox,
  Tabs,
  Badge,
  TextField,
  Slider,
  Callout
} from '@radix-ui/themes'
import { Gamepad2, TriangleAlert } from 'lucide-react'
import WindowFrame from '../components/WindowFrame'
import { Z_INDEX_MODAL } from '../vendor/zIndex'
import { useGamepad, getButtonName } from '../bridge/useGamepad'
import { GamepadButtonCapture } from '../components/GamepadButtonCapture'
import { AVAILABLE_VOICES } from '../vendor/voices'
import {
  API_URLS,
  DEFAULT_VOICE_ID,
  DEFAULT_SERVER_MODE,
  SERVER_URLS,
  ServerMode
} from '../vendor/shared-constants'
import { OCR_MODES, type OcrMode } from '../bridge/settings'
import { useSetting } from '../bridge/useSetting'
import { useHotkeys } from '../bridge/useHotkeys'
import {
  openAccessibilityPreferences,
  openDictionary,
  panel,
  quitApp,
  nativeError
} from '../bridge/tauri'
import { useViewState } from '../bridge/state'
import { describeUrlRestriction, testApiConnection } from '../bridge/yomitan'

function WebSocketUrlInput({
  value,
  onCommit
}: {
  value: string
  onCommit: (url: string) => void
}): JSX.Element {
  const [localValue, setLocalValue] = useState(value)

  useEffect(() => {
    // Verbatim from the Electron component: re-sync the draft when the stored value changes
    // elsewhere. Kept as-is so the input behaves identically.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalValue(value)
  }, [value])

  const commit = useCallback(() => {
    if (localValue !== value) {
      onCommit(localValue)
    }
  }, [localValue, value, onCommit])

  return (
    <TextField.Root
      value={localValue}
      onChange={(e) => setLocalValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      placeholder="ws://localhost:6677"
      style={{ width: '100%' }}
    />
  )
}

interface SettingsPanelProps {
  /** Kept so the Done button and the Yomitan handoff can close the native window. */
  onClose?: () => void
}

function SettingsPanel({ onClose }: SettingsPanelProps): JSX.Element {
  // Use the new hooks for settings management
  const [hotkeys, setHotkeys, hotkeyFailures] = useHotkeys()
  const [yomitanSettings, setYomitanSettings] = useSetting<YomitanSettings>('yomitanSettings', {
    popupType: 'builtin',
    customApiUrl: API_URLS.YOMITAN_FALLBACK
  })
  const [audioSettings, setAudioSettings] = useSetting<AudioSettings>('audioSettings', {
    voiceId: DEFAULT_VOICE_ID
  })
  const [liveOverlayEnabled, setLiveOverlayEnabled] = useSetting<boolean>(
    'liveOverlayEnabled',
    false
  )
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
  const [serverSettings, setServerSettings] = useSetting<ServerSettings>('serverSettings', {
    mode: DEFAULT_SERVER_MODE
  })
  const [autoOCRSettings, setAutoOCRSettings] = useSetting<AutoOCRSettings>(
    'autoOCRSettings',
    DEFAULT_AUTO_OCR_SETTINGS
  )
  const [ocrMode, setOcrMode] = useSetting<OcrMode>('ocrMode', 'cloud')
  // Watching keys inside another application needs macOS Accessibility; the backend reports
  // whether it has been granted, so the Trigger Keys field can say what is actually true.
  const { state: viewState } = useViewState()
  const accessibilityGranted = Boolean(viewState.accessibility)
  const [texthookerSettings, setTexthookerSettings] = useSetting<TexthookerSettings>(
    'texthookerSettings',
    {
      copyToClipboard: false,
      sendToWebSocket: false,
      webSocketUrl: 'ws://localhost:6677'
    }
  )

  // Gamepad hook
  const {
    state: gamepadState,
    settings: gamepadSettings,
    setEnabled: setGamepadEnabled,
    setPreferredGamepad,
    source: gamepadSource
  } = useGamepad()

  // Local UI state (not persisted)
  const [showRestartPrompt, setShowRestartPrompt] = useState(false)
  const [pendingServerMode, setPendingServerMode] = useState<ServerMode | null>(null)
  const [apiTestStatus, setApiTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>(
    'idle'
  )

  const updateHotkeyField = useCallback(
    (
      name: string,
      field: 'accelerator' | 'enabled' | 'gamepadButton',
      value: string | boolean | number | undefined
    ): void => {
      const updated = {
        ...hotkeys,
        [name]: {
          ...hotkeys[name],
          [field]: value as never
        }
      }
      setHotkeys(updated)
    },
    [hotkeys, setHotkeys]
  )

  const handlePopupTypeChange = useCallback(
    (value: PopupType): void => {
      setYomitanSettings({ ...yomitanSettings, popupType: value })

      // Reset test status when changing popup type
      if (value === 'builtin') {
        setApiTestStatus('idle')
      }
    },
    [yomitanSettings, setYomitanSettings]
  )

  const handleApiUrlChange = useCallback(
    (value: string): void => {
      setYomitanSettings({ ...yomitanSettings, customApiUrl: value })
      setApiTestStatus('idle')
    },
    [yomitanSettings, setYomitanSettings]
  )

  const handleTestApiConnection = useCallback(async (): Promise<void> => {
    setApiTestStatus('testing')
    try {
      const result = await testApiConnection(yomitanSettings.customApiUrl)
      setApiTestStatus(result.success ? 'success' : 'error')
      if (!result.success) {
        console.error('API test failed:', result.error)
      }
    } catch (error) {
      console.error('Failed to test API connection:', error)
      setApiTestStatus('error')
    }
  }, [yomitanSettings.customApiUrl])

  const handleVoiceChange = useCallback(
    (voiceId: string): void => {
      setAudioSettings({ ...audioSettings, voiceId })
    },
    [audioSettings, setAudioSettings]
  )

  const handleAutoScanEnabledChange = useCallback(
    (enabled: boolean): void => {
      setAutoScanSettings({ ...autoScanSettings, enabled })
    },
    [autoScanSettings, setAutoScanSettings]
  )

  const handleAutoScanTriggerKeysChange = useCallback(
    (keys: string): void => {
      setAutoScanSettings({ ...autoScanSettings, triggerKeys: keys })
    },
    [autoScanSettings, setAutoScanSettings]
  )

  const handleAutoScanDelayChange = useCallback(
    (delay: string): void => {
      setAutoScanSettings({ ...autoScanSettings, scanDelay: parseInt(delay, 10) })
    },
    [autoScanSettings, setAutoScanSettings]
  )

  const handleTextOverlayGroupingEnabledChange = useCallback(
    (enabled: boolean): void => {
      setTextOverlayGrouping({ ...textOverlayGrouping, enabled })
    },
    [textOverlayGrouping, setTextOverlayGrouping]
  )

  const handleServerModeChange = useCallback(
    (mode: ServerMode): void => {
      if (mode !== serverSettings.mode) {
        setPendingServerMode(mode)
        setShowRestartPrompt(true)
      }
    },
    [serverSettings.mode]
  )

  const confirmServerModeChange = useCallback(async (): Promise<void> => {
    if (pendingServerMode) {
      await setServerSettings({ mode: pendingServerMode })
      setPendingServerMode(null)
      setShowRestartPrompt(false)
      // Request app quit
      quitApp().catch((error) => console.error('Quit failed:', nativeError(error).message))
    }
  }, [pendingServerMode, setServerSettings])

  const cancelServerModeChange = useCallback((): void => {
    setPendingServerMode(null)
    setShowRestartPrompt(false)
  }, [])

  const closePanel = useCallback((): void => {
    if (onClose) onClose()
    else panel('settings', 'hide').catch(() => undefined)
  }, [onClose])

  return (
    <div style={{ height: '100%' }}>
      <WindowFrame>
        <Flex direction="column" style={{ height: '100%', minHeight: 0, padding: '16px' }}>
          <Tabs.Root
            defaultValue="mode"
            style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
          >
            <Tabs.List style={{ flexShrink: 0, overflowX: 'auto' }}>
              <Tabs.Trigger value="mode">OCR</Tabs.Trigger>
              <Tabs.Trigger value="shortcuts">Shortcuts</Tabs.Trigger>
              <Tabs.Trigger value="gamepad">Gamepad</Tabs.Trigger>
              <Tabs.Trigger value="yomitan">Dictionary</Tabs.Trigger>
              <Tabs.Trigger value="audio">Audio</Tabs.Trigger>
              <Tabs.Trigger value="texthooker">Texthooker</Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value="mode" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <Flex direction="column" gap="4" mt="4">
                {/* OCR Engine Selection */}
                <Flex direction="column" gap="2">
                  <Text size="2" weight="bold">
                    OCR Engine
                  </Text>
                  <Select.Root
                    value={ocrMode}
                    onValueChange={(value) => setOcrMode(value as OcrMode)}
                  >
                    <Select.Trigger />
                    <Select.Content>
                      {Object.entries(OCR_MODES).map(([value, mode]) => (
                        <Select.Item key={value} value={value}>
                          {mode.label}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                  <Text size="1" color="gray">
                    {OCR_MODES[ocrMode]?.detail}
                    {OCR_MODES[ocrMode] && !OCR_MODES[ocrMode].geometry
                      ? ' This engine returns no text positions, so results appear in the log, the texthooker and audio, but nothing is drawn over your game.'
                      : ''}
                  </Text>
                </Flex>

                {/* OCR Server Selection */}
                <Flex direction="column" gap="2">
                  <Text size="2" weight="bold">
                    OCR Server
                  </Text>
                  <Select.Root value={serverSettings.mode} onValueChange={handleServerModeChange}>
                    <Select.Trigger />
                    <Select.Content>
                      <Select.Item value="cloud">Cloud Server (Recommended)</Select.Item>
                      <Select.Item value="local">Local Server (localhost:3000)</Select.Item>
                    </Select.Content>
                  </Select.Root>
                  <Text size="1" color="gray">
                    {serverSettings.mode === 'cloud'
                      ? `Using: ${SERVER_URLS.cloud}`
                      : `Using: ${SERVER_URLS.local}`}
                  </Text>
                </Flex>

                {/* Live Overlay Mode */}
                <Flex direction="column" gap="2">
                  <Flex align="center" gap="2">
                    <Checkbox
                      checked={liveOverlayEnabled}
                      onCheckedChange={(checked) => setLiveOverlayEnabled(Boolean(checked))}
                    />
                    <Text size="2" weight="bold">
                      Overlay Mode <Badge color="orange">Experimental</Badge>
                    </Text>
                  </Flex>
                  <Text size="1" color="gray">
                    When enabled, you will be able to view definitions for scanned text simply by
                    hovering over it. Look for the{' '}
                    <span
                      style={{
                        borderBottom: `3px solid hsla(210, 100%, 70%, 0.3)`,
                        paddingBottom: '2px'
                      }}
                    >
                      faint blue underlines
                    </span>{' '}
                    as you hover over the text in your game or application.
                  </Text>
                </Flex>

                {/* Auto-Scan After Button Press */}
                <Flex direction="column" gap="2">
                  <Flex align="center" gap="2">
                    <Checkbox
                      checked={autoScanSettings.enabled}
                      onCheckedChange={(checked) => handleAutoScanEnabledChange(Boolean(checked))}
                    />
                    <Text size="2" weight="bold">
                      Auto-scan After Button Press
                    </Text>
                  </Flex>
                  <Text size="1" color="gray">
                    Automatically trigger a scan after pressing specific keys in your game or
                    application.
                  </Text>

                  {/* Sub-settings shown when enabled */}
                  {autoScanSettings.enabled && (
                    <Flex direction="column" gap="3" ml="4" mt="2">
                      {/* Trigger Keys Input */}
                      <Flex direction="column" gap="1">
                        <Text size="2" weight="medium">
                          Trigger Keys
                        </Text>
                        <TextField.Root
                          value={autoScanSettings.triggerKeys}
                          onChange={(e) => handleAutoScanTriggerKeysChange(e.target.value)}
                          placeholder="e.g., space, enter, z"
                          style={{ width: '100%' }}
                        />
                        <Text size="1" color="gray">
                          Comma-separated list of keys that will trigger a scan
                        </Text>
                        {!accessibilityGranted && (
                          <Callout.Root size="1" color="amber" mt="1">
                            <Callout.Icon>
                              <TriangleAlert size={14} />
                            </Callout.Icon>
                            <Callout.Text>
                              Watching for key presses inside another application needs macOS
                              Accessibility permission for Kimochi. Until it is granted these keys
                              will not start a scan; the gamepad trigger below is unaffected.
                              <Button
                                size="1"
                                variant="soft"
                                ml="2"
                                onClick={() =>
                                  void openAccessibilityPreferences().catch((error) =>
                                    console.error(
                                      'Open Accessibility settings failed:',
                                      nativeError(error).message
                                    )
                                  )
                                }
                              >
                                Open Accessibility settings
                              </Button>
                            </Callout.Text>
                          </Callout.Root>
                        )}
                      </Flex>

                      {/* Scan Delay Dropdown */}
                      <Flex direction="column" gap="1">
                        <Text size="2" weight="medium">
                          Scan Delay
                        </Text>
                        <Select.Root
                          value={autoScanSettings.scanDelay.toString()}
                          onValueChange={handleAutoScanDelayChange}
                        >
                          <Select.Trigger style={{ width: '200px' }} />
                          <Select.Content>
                            <Select.Item value="100">100ms</Select.Item>
                            <Select.Item value="500">500ms</Select.Item>
                            <Select.Item value="1000">1s</Select.Item>
                            <Select.Item value="1500">1.5s</Select.Item>
                            <Select.Item value="2000">2s</Select.Item>
                            <Select.Item value="3000">3s</Select.Item>
                          </Select.Content>
                        </Select.Root>
                        <Text size="1" color="gray">
                          Delay before triggering the scan after key press
                        </Text>
                      </Flex>

                      {/* Gamepad Trigger Button */}
                      <Flex direction="column" gap="1">
                        <Text size="2" weight="medium">
                          Gamepad Trigger
                        </Text>
                        <GamepadButtonCapture
                          value={autoScanSettings.gamepadButton}
                          onChange={(btn) =>
                            setAutoScanSettings({ ...autoScanSettings, gamepadButton: btn })
                          }
                          size="2"
                        />
                        <Text size="1" color="gray">
                          Gamepad button that will trigger a scan
                        </Text>
                      </Flex>
                    </Flex>
                  )}
                </Flex>

                {/* Text Box Grouping */}
                <Flex direction="column" gap="2">
                  <Flex align="center" gap="2">
                    <Checkbox
                      checked={textOverlayGrouping.enabled}
                      onCheckedChange={(checked) =>
                        handleTextOverlayGroupingEnabledChange(Boolean(checked))
                      }
                    />
                    <Text size="2" weight="bold">
                      Group Overlay Text Into Regions
                    </Text>
                  </Flex>
                  <Text size="1" color="gray">
                    Groups nearby text boxes in the overlay into logical regions with a shared
                    background. Useful for organizing text from complex layouts.
                  </Text>
                </Flex>

                {/* Filter Small Text */}
                <Flex direction="column" gap="2">
                  <Flex align="center" gap="2">
                    <Checkbox
                      checked={textOverlayGrouping.filterSmallText ?? true}
                      onCheckedChange={(checked) =>
                        setTextOverlayGrouping({
                          ...textOverlayGrouping,
                          filterSmallText: Boolean(checked)
                        })
                      }
                    />
                    <Text size="2" weight="bold">
                      Filter Out Furigana and Small Text
                    </Text>
                  </Flex>
                  <Text size="1" color="gray">
                    Automatically removes text that is significantly smaller than the main text
                    (e.g., furigana reading aids above kanji).
                  </Text>

                  {/* Threshold slider - only show when filter is enabled */}
                  {(textOverlayGrouping.filterSmallText ?? true) && (
                    <Flex direction="column" gap="2" mt="2" ml="4">
                      <Flex align="center" justify="between">
                        <Text size="2">Size threshold</Text>
                        <Text size="2" color="gray">
                          {Math.round((textOverlayGrouping.filterSmallTextThreshold ?? 0.75) * 100)}
                          %
                        </Text>
                      </Flex>
                      <Slider
                        value={[(textOverlayGrouping.filterSmallTextThreshold ?? 0.75) * 100]}
                        onValueChange={(values) =>
                          setTextOverlayGrouping({
                            ...textOverlayGrouping,
                            filterSmallTextThreshold: values[0] / 100
                          })
                        }
                        min={50}
                        max={95}
                        step={5}
                        style={{ width: '200px' }}
                      />
                      <Text size="1" color="gray">
                        Text smaller than{' '}
                        {Math.round((textOverlayGrouping.filterSmallTextThreshold ?? 0.75) * 100)}%
                        of the median height will be filtered out. Lower values filter more
                        aggressively.
                      </Text>
                    </Flex>
                  )}
                </Flex>

                {/* Auto-OCR Change Detection Settings */}
                <Flex direction="column" gap="2">
                  <Text size="2" weight="bold">
                    Auto-OCR Change Detection
                  </Text>
                  <Text size="1" color="gray">
                    Automatic scanning reads the screen locally, several times a second, and only
                    spends a Cloud OCR request once the text has stopped changing. These settings
                    decide how patient it is.
                  </Text>

                  {/* Adaptive Polling Toggle */}
                  <Flex align="center" gap="2" mt="2">
                    <Checkbox
                      checked={autoOCRSettings.adaptivePollingEnabled}
                      onCheckedChange={(checked) =>
                        setAutoOCRSettings({
                          ...autoOCRSettings,
                          adaptivePollingEnabled: Boolean(checked)
                        })
                      }
                    />
                    <Text size="2">Adaptive Polling</Text>
                  </Flex>
                  <Text size="1" color="gray" ml="4">
                    Looks more often while the text is moving and backs off once it settles.
                  </Text>

                  {/* Settling */}
                  <Flex direction="column" gap="1" mt="3">
                    <Text size="2" weight="medium">
                      Settle After
                    </Text>
                    <Select.Root
                      value={autoOCRSettings.stableObservations.toString()}
                      onValueChange={(value) =>
                        setAutoOCRSettings({
                          ...autoOCRSettings,
                          stableObservations: parseInt(value, 10)
                        })
                      }
                    >
                      <Select.Trigger style={{ width: '200px' }} />
                      <Select.Content>
                        <Select.Item value="2">2 readings (default)</Select.Item>
                        <Select.Item value="3">3 readings</Select.Item>
                        <Select.Item value="4">4 readings</Select.Item>
                      </Select.Content>
                    </Select.Root>
                    <Text size="1" color="gray">
                      How many times in a row the same text must be read before it is worth
                      recognising properly. More readings means fewer requests and a longer wait
                      after a line finishes drawing.
                    </Text>
                  </Flex>

                  {/* Bounded wait */}
                  <Flex direction="column" gap="1" mt="3">
                    <Text size="2" weight="medium">
                      Give Up Waiting After
                    </Text>
                    <Select.Root
                      value={autoOCRSettings.maxCandidateAgeMs.toString()}
                      onValueChange={(value) =>
                        setAutoOCRSettings({
                          ...autoOCRSettings,
                          maxCandidateAgeMs: parseInt(value, 10)
                        })
                      }
                    >
                      <Select.Trigger style={{ width: '200px' }} />
                      <Select.Content>
                        <Select.Item value="2000">2 seconds</Select.Item>
                        <Select.Item value="4000">4 seconds (default)</Select.Item>
                        <Select.Item value="8000">8 seconds</Select.Item>
                      </Select.Content>
                    </Select.Root>
                    <Text size="1" color="gray">
                      Text that never stops animating is recognised anyway once this long has
                      passed, so a restless screen cannot starve you of a line.
                    </Text>
                  </Flex>

                  {/* Minimum spacing */}
                  <Flex direction="column" gap="1" mt="3">
                    <Text size="2" weight="medium">
                      Minimum Time Between Requests
                    </Text>
                    <Select.Root
                      value={autoOCRSettings.minRequestSpacingMs.toString()}
                      onValueChange={(value) =>
                        setAutoOCRSettings({
                          ...autoOCRSettings,
                          minRequestSpacingMs: parseInt(value, 10)
                        })
                      }
                    >
                      <Select.Trigger style={{ width: '200px' }} />
                      <Select.Content>
                        <Select.Item value="0">No limit</Select.Item>
                        <Select.Item value="800">0.8 seconds</Select.Item>
                        <Select.Item value="1200">1.2 seconds</Select.Item>
                        <Select.Item value="3000">3 seconds</Select.Item>
                      </Select.Content>
                    </Select.Root>
                    <Text size="1" color="gray">
                      A floor on how often Cloud OCR can be called, however fast the dialogue moves.
                      Lines that arrive during the wait are not queued up — only the most recent one
                      is kept.
                    </Text>
                  </Flex>

                  {/* Base Poll Interval */}
                  <Flex direction="column" gap="1" mt="3">
                    <Text size="2" weight="medium">
                      Base Poll Interval
                    </Text>
                    <Select.Root
                      value={autoOCRSettings.pollInterval.toString()}
                      onValueChange={(value) =>
                        setAutoOCRSettings({
                          ...autoOCRSettings,
                          pollInterval: parseInt(value, 10)
                        })
                      }
                    >
                      <Select.Trigger style={{ width: '200px' }} />
                      <Select.Content>
                        <Select.Item value="250">250 milliseconds</Select.Item>
                        <Select.Item value="500">500 milliseconds (default)</Select.Item>
                        <Select.Item value="1000">1 second</Select.Item>
                        <Select.Item value="2000">2 seconds</Select.Item>
                        <Select.Item value="3000">3 seconds</Select.Item>
                        <Select.Item value="5000">5 seconds</Select.Item>
                      </Select.Content>
                    </Select.Root>
                    <Text size="1" color="gray">
                      How often to check for screen changes. With adaptive polling, this is the
                      starting interval.
                    </Text>
                  </Flex>
                </Flex>
              </Flex>
            </Tabs.Content>

            <Tabs.Content value="shortcuts" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <Flex direction="column" gap="3" mt="4">
                {hotkeyFailures.length > 0 && (
                  <Callout.Root size="1" color="red">
                    <Callout.Icon>
                      <TriangleAlert size={14} />
                    </Callout.Icon>
                    <Callout.Text>
                      {hotkeyFailures.length === 1 ? 'This shortcut' : 'These shortcuts'} could not
                      be registered, usually because another application already owns the
                      combination:{' '}
                      {hotkeyFailures
                        .map((failure) => `${failure.name} (${failure.accelerator})`)
                        .join(', ')}
                    </Callout.Text>
                  </Callout.Root>
                )}
                {Object.keys(hotkeys).length === 0 && (
                  <Text size="2" color="gray">
                    No hotkeys configured.
                  </Text>
                )}

                {Object.entries(hotkeys).map(([name, def]) => (
                  <Flex
                    key={name}
                    align="center"
                    gap="3"
                    style={{
                      borderBottom: '1px solid var(--gray-a4)',
                      paddingBottom: '12px',
                      minHeight: '40px'
                    }}
                  >
                    {/* Enabled checkbox */}
                    <Checkbox
                      checked={def.enabled === true}
                      onCheckedChange={(checked) => {
                        updateHotkeyField(name, 'enabled', Boolean(checked))
                      }}
                    />

                    {/* Title and description */}
                    <Flex direction="column" gap="1" style={{ flex: 1 }}>
                      <Text size="2" weight="medium">
                        {def.name}
                      </Text>
                      {def.description && (
                        <Text size="1" color="gray">
                          {def.description}
                        </Text>
                      )}
                    </Flex>

                    {/* Hotkey input */}
                    <input
                      value={def.accelerator || ''}
                      onChange={(e) => updateHotkeyField(name, 'accelerator', e.target.value)}
                      placeholder="e.g. CommandOrControl+Shift+8"
                      style={{
                        width: '160px',
                        padding: '6px 8px',
                        borderRadius: 6,
                        border: '1px solid var(--gray-a5)',
                        background: 'var(--color-panel-solid)',
                        color: 'var(--gray-12)',
                        fontSize: '12px'
                      }}
                    />

                    {/* Gamepad button */}
                    <GamepadButtonCapture
                      value={def.gamepadButton}
                      onChange={(btn) => updateHotkeyField(name, 'gamepadButton', btn)}
                      size="1"
                    />
                  </Flex>
                ))}
              </Flex>
            </Tabs.Content>

            <Tabs.Content value="gamepad" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <Flex direction="column" gap="4" mt="4">
                {/* Enable/Disable Toggle */}
                <Flex direction="column" gap="2">
                  <Flex align="center" gap="2">
                    <Checkbox
                      checked={gamepadSettings.enabled}
                      onCheckedChange={(checked) => setGamepadEnabled(Boolean(checked))}
                    />
                    <Text size="2" weight="bold">
                      Enable Gamepad Support
                    </Text>
                  </Flex>
                  <Text size="1" color="gray">
                    Use a gamepad controller to trigger shortcuts and scans.
                  </Text>
                  {gamepadSettings.enabled && gamepadSource === 'none' && (
                    <Callout.Root size="1" color="amber">
                      <Callout.Icon>
                        <TriangleAlert size={14} />
                      </Callout.Icon>
                      <Callout.Text>
                        No gamepad input has been received yet in this build. Gamepad support has
                        not been verified on this platform, so treat the controls below as
                        unconfirmed until a button lights up in the test area.
                      </Callout.Text>
                    </Callout.Root>
                  )}
                </Flex>

                {/* Connected Gamepads */}
                {gamepadSettings.enabled && (
                  <Flex direction="column" gap="2">
                    <Text size="2" weight="bold">
                      Connected Gamepads
                    </Text>
                    {gamepadState.gamepads.length === 0 ? (
                      <Flex
                        align="center"
                        gap="2"
                        style={{
                          padding: '12px',
                          background: 'var(--gray-a2)',
                          borderRadius: '6px'
                        }}
                      >
                        <Gamepad2 size={18} style={{ opacity: 0.5 }} />
                        <Text size="2" color="gray">
                          No gamepads detected. Connect a controller and press any button.
                        </Text>
                      </Flex>
                    ) : (
                      <Flex direction="column" gap="2">
                        {gamepadState.gamepads.map((gp) => (
                          <Flex
                            key={gp.index}
                            align="center"
                            justify="between"
                            style={{
                              padding: '12px',
                              background:
                                gp.index === gamepadState.activeGamepadIndex
                                  ? 'var(--accent-a3)'
                                  : 'var(--gray-a2)',
                              borderRadius: '6px',
                              border:
                                gp.index === gamepadState.activeGamepadIndex
                                  ? '1px solid var(--accent-a6)'
                                  : '1px solid transparent'
                            }}
                          >
                            <Flex direction="column" gap="1">
                              <Flex align="center" gap="2">
                                <Gamepad2 size={16} />
                                <Text size="2" weight="medium">
                                  {gp.id.split('(')[0].trim() || `Gamepad ${gp.index + 1}`}
                                </Text>
                                {gp.index === gamepadState.activeGamepadIndex && (
                                  <Badge color="green" size="1">
                                    Active
                                  </Badge>
                                )}
                              </Flex>
                              <Text size="1" color="gray">
                                {gp.buttons} buttons, {gp.axes} axes
                              </Text>
                            </Flex>
                            {gp.index !== gamepadState.activeGamepadIndex && (
                              <Button
                                size="1"
                                variant="soft"
                                onClick={() => setPreferredGamepad(gp.index)}
                              >
                                Set as Primary
                              </Button>
                            )}
                          </Flex>
                        ))}
                      </Flex>
                    )}
                  </Flex>
                )}

                {/* Button Visualization */}
                {gamepadSettings.enabled && gamepadState.gamepads.length > 0 && (
                  <Flex direction="column" gap="2">
                    <Text size="2" weight="bold">
                      Button Test
                    </Text>
                    <Text size="1" color="gray">
                      Press buttons on your controller to see them light up.
                    </Text>
                    <Flex wrap="wrap" gap="2" style={{ marginTop: '8px' }}>
                      {gamepadState.buttonStates.map((pressed, index) => (
                        <Flex
                          key={index}
                          align="center"
                          justify="center"
                          style={{
                            width: '48px',
                            height: '36px',
                            borderRadius: '6px',
                            background: pressed ? 'var(--accent-9)' : 'var(--gray-a3)',
                            color: pressed ? 'white' : 'var(--gray-11)',
                            fontSize: '11px',
                            fontWeight: 500,
                            transition: 'all 0.1s ease'
                          }}
                        >
                          {getButtonName(index)}
                        </Flex>
                      ))}
                    </Flex>
                  </Flex>
                )}
              </Flex>
            </Tabs.Content>

            <Tabs.Content value="yomitan" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <Flex direction="column" gap="4" mt="4">
                {/* Popup Type Selection */}
                <Flex direction="column" gap="2">
                  <Text size="2" weight="bold">
                    Pop-up Type
                  </Text>
                  <Select.Root
                    value={yomitanSettings.popupType}
                    onValueChange={handlePopupTypeChange}
                  >
                    <Select.Trigger />
                    <Select.Content>
                      <Select.Item value="builtin">Built-in Yomitan</Select.Item>
                      <Select.Item value="custom-api">
                        Custom pop-up (Yomitan API) <Badge color="orange">Experimental</Badge>
                      </Select.Item>
                    </Select.Content>
                  </Select.Root>
                </Flex>

                {/* Built-in Yomitan Options */}
                {yomitanSettings.popupType === 'builtin' && (
                  <Flex direction="column" gap="2">
                    <Text size="2" weight="bold">
                      Yomitan Settings
                    </Text>
                    <Text size="2" color="gray">
                      Configure Yomitan extension settings and dictionaries.
                    </Text>
                    <Button
                      onClick={() => {
                        // The real Yomitan settings UI lives in the overlay WebView, where its
                        // backend and IndexedDB are; opening it takes over the screen there.
                        openDictionary(true).catch((error) =>
                          console.error('Open Yomitan settings failed:', nativeError(error).message)
                        )
                        closePanel()
                      }}
                    >
                      Open Yomitan Settings
                    </Button>
                  </Flex>
                )}

                {/* Custom API Options */}
                {yomitanSettings.popupType === 'custom-api' && (
                  <Flex direction="column" gap="2">
                    <Text size="2" weight="bold">
                      Yomitan API URL
                    </Text>
                    <Flex align="center" gap="2">
                      {/* Status Indicator */}
                      <div
                        style={{
                          width: '10px',
                          height: '10px',
                          borderRadius: '50%',
                          backgroundColor:
                            apiTestStatus === 'idle'
                              ? 'var(--gray-8)'
                              : apiTestStatus === 'testing'
                                ? 'var(--yellow-9)'
                                : apiTestStatus === 'success'
                                  ? 'var(--green-9)'
                                  : 'var(--red-9)',
                          flexShrink: 0
                        }}
                      />
                      {/* URL Input */}
                      <TextField.Root
                        value={yomitanSettings.customApiUrl}
                        onChange={(e) => handleApiUrlChange(e.target.value)}
                        placeholder={API_URLS.YOMITAN_FALLBACK}
                        style={{ flex: 1 }}
                      />
                      {/* Test Button */}
                      <Button
                        size="2"
                        onClick={handleTestApiConnection}
                        disabled={apiTestStatus === 'testing'}
                      >
                        {apiTestStatus === 'testing' ? 'Testing...' : 'Test'}
                      </Button>
                    </Flex>
                    <Text size="1" color="gray">
                      Enter the URL of your Yomitan API endpoint. Click &quot;Test&quot; to verify
                      the connection.
                    </Text>
                    {yomitanSettings.customApiUrl &&
                      describeUrlRestriction(yomitanSettings.customApiUrl) && (
                        <Callout.Root size="1" color="amber">
                          <Callout.Icon>
                            <TriangleAlert size={14} />
                          </Callout.Icon>
                          <Callout.Text>
                            {describeUrlRestriction(yomitanSettings.customApiUrl)}
                          </Callout.Text>
                        </Callout.Root>
                      )}
                  </Flex>
                )}
              </Flex>
            </Tabs.Content>

            <Tabs.Content value="audio" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <Flex direction="column" gap="4" mt="4">
                {/* TTS Voice Selection */}
                <Flex direction="column" gap="2">
                  <Text size="2" weight="bold">
                    Text-to-Speech Voice
                  </Text>
                  <Select.Root value={audioSettings.voiceId} onValueChange={handleVoiceChange}>
                    <Select.Trigger />
                    <Select.Content>
                      {AVAILABLE_VOICES.map((voice) => (
                        <Select.Item key={voice.id} value={voice.id}>
                          {voice.name}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                  <Text size="1" color="gray">
                    Select the voice to use for text-to-speech playback.
                  </Text>
                </Flex>
              </Flex>
            </Tabs.Content>

            <Tabs.Content value="texthooker" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <Flex direction="column" gap="4" mt="4">
                {/* Copy to Clipboard */}
                <Flex direction="column" gap="2">
                  <Flex align="center" gap="2">
                    <Checkbox
                      checked={texthookerSettings.copyToClipboard}
                      onCheckedChange={(checked) =>
                        setTexthookerSettings({
                          ...texthookerSettings,
                          copyToClipboard: Boolean(checked)
                        })
                      }
                    />
                    <Text size="2" weight="bold">
                      Copy to Clipboard
                    </Text>
                  </Flex>
                  <Text size="1" color="gray">
                    Automatically copy scanned text to the system clipboard after each scan.
                  </Text>
                </Flex>

                {/* Send to WebSocket */}
                <Flex direction="column" gap="2">
                  <Flex align="center" gap="2">
                    <Checkbox
                      checked={texthookerSettings.sendToWebSocket}
                      onCheckedChange={(checked) =>
                        setTexthookerSettings({
                          ...texthookerSettings,
                          sendToWebSocket: Boolean(checked)
                        })
                      }
                    />
                    <Text size="2" weight="bold">
                      Send to WebSocket
                    </Text>
                  </Flex>
                  <Text size="1" color="gray">
                    Send scanned text to a WebSocket server for use with texthooker pages like
                    texthooker-ui.
                  </Text>

                  {texthookerSettings.sendToWebSocket && (
                    <Flex direction="column" gap="1" ml="4" mt="2">
                      <Text size="2" weight="medium">
                        WebSocket URL
                      </Text>
                      <WebSocketUrlInput
                        value={texthookerSettings.webSocketUrl}
                        onCommit={(url) =>
                          setTexthookerSettings({
                            ...texthookerSettings,
                            webSocketUrl: url
                          })
                        }
                      />
                      <Text size="1" color="gray">
                        URL for the WebSocket server. Texthooker pages connect to this address.
                        Press Enter or click away to apply.
                      </Text>
                    </Flex>
                  )}
                </Flex>
              </Flex>
            </Tabs.Content>
          </Tabs.Root>

          <Flex justify="end" gap="3" mt="4" style={{ flexShrink: 0 }}>
            <Button onClick={closePanel}>Done</Button>
          </Flex>
        </Flex>
      </WindowFrame>

      {/* Restart Confirmation Dialog */}
      {showRestartPrompt && (
        <Dialog.Root open={showRestartPrompt} onOpenChange={setShowRestartPrompt}>
          <Dialog.Content style={{ maxWidth: '400px', zIndex: Z_INDEX_MODAL + 1 }}>
            <Dialog.Title>Restart Required</Dialog.Title>
            <Dialog.Description size="2" mb="4">
              Changing the OCR server requires restarting the application. The app will quit and
              you&apos;ll need to reopen it manually.
            </Dialog.Description>
            <Flex gap="3" justify="end">
              <Button variant="soft" color="gray" onClick={cancelServerModeChange}>
                Cancel
              </Button>
              <Button onClick={confirmServerModeChange}>Quit &amp; Apply</Button>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
      )}
    </div>
  )
}

export default SettingsPanel
