/**
 * Settings → Sources: where the Log's lines come from, how sessions follow the source, and where
 * OCR scans are also sent. The same input choice is the main window's source menu.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Aperture, Camera, Check, Clipboard, ExternalLink, Globe, Radio } from 'lucide-react'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { Button, Input, Select, SettingsPage, SettingsRow, SettingsSection, StatusDot, Switch } from '@kit'
import { updateSettings } from '@texthooker/lib/settings'
import type { Settings } from '@texthooker/lib/types'
import { useSetting } from '../../bridge/useSetting'
import { accessibilityStatus, openScreenCapturePreferences, requestAccessibility } from '../../bridge/tauri'
import { useCapabilities } from '../../bridge/capabilities'
import { useHasScreenRecordingPermission } from '../../welcome/useHasScreenRecordingPermission'
import { WithReaderSettings } from './ReaderSettingsProvider'
import { OutputSections } from './OutputSections'
import { showSettingsTab } from './showSettingsTab'
import { openTextHookerSettings } from '../../main/hookGames'

type InputSource = Settings['inputSource']
/**
 * The texthooker's inputs, with OCR split into a window or screen and Quick Shot. A hooked game
 * (`hook`) is a window too: its Text hooking switch is under its card in the sidebar.
 */
type Mode = Exclude<InputSource, 'hook'> | 'quickshot'

const INPUT_SOURCES = [
  {
    value: 'ocr',
    label: 'Window or screen',
    icon: <Camera />,
    detail: 'Reads the window or screen chosen in the source menu: with OCR, or from inside a game with Text hooking.'
  },
  {
    value: 'quickshot',
    label: 'Quick Shot',
    icon: <Aperture />,
    detail: 'No source: press the button or shortcut to grab and scan.'
  },
  {
    value: 'clipboard',
    label: 'Clipboard',
    icon: <Clipboard />,
    detail: 'Picks up text copied to the clipboard, e.g. by a text hooker.'
  },
  {
    value: 'websocket',
    label: 'WebSocket',
    icon: <Radio />,
    detail: 'Receives plain-text messages from a text source on your network.'
  },
  {
    value: 'browser',
    label: 'Browser',
    icon: <Globe />,
    detail: 'Reads pictures you pick on web pages with the Kimochi browser extension.'
  }
] as const satisfies readonly {
  value: Mode
  label: string
  icon: ReactNode
  detail: string
}[]

const CLIPBOARD_POLL = [
  { value: '100', label: '100 ms' },
  { value: '200', label: '200 ms' },
  { value: '500', label: '500 ms' },
  { value: '1000', label: '1 s' }
]

/** A permission's state: Allowed, or a way to allow it. */
function PermissionStatus({ granted, onAllow }: { granted: boolean; onAllow: () => void }): ReactNode {
  return granted ? (
    <span className="settings-status">
      <StatusDot tone="ok" />
      Allowed
    </span>
  ) : (
    <Button size="sm" variant="secondary" onClick={onAllow}>
      Allow
      <ExternalLink />
    </Button>
  )
}

/**
 * The macOS permissions onboarding asks for (Screen Recording, Accessibility), in case one was
 * skipped or later turned off. Nothing on platforms without them: `accessibility_status` is null
 * there.
 */
function MacPermissionsSection(): ReactNode {
  const [accessibility, setAccessibility] = useState<boolean | null>(null)
  const { authorization, restartAfterGrant } = useCapabilities().capture
  const screenRecording = useHasScreenRecordingPermission(accessibility !== null)
  useEffect(() => {
    let alive = true
    const check = (): void => {
      void accessibilityStatus()
        .then((next) => alive && setAccessibility(next))
        .catch(() => undefined)
    }
    check()
    // Granted in System Settings while this page is open: follow it.
    const timer = setInterval(check, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  if (accessibility === null) return null
  const recordingGranted = screenRecording || authorization === 'granted'
  return (
    <SettingsSection title="macOS permissions">
      <SettingsRow
        label="Screen Recording"
        description={
          !recordingGranted && restartAfterGrant
            ? 'Lets Kimochi read the window or screen you choose. Restart Kimochi after allowing.'
            : 'Lets Kimochi read the window or screen you choose.'
        }
      >
        <PermissionStatus
          granted={recordingGranted}
          onAllow={() => void openScreenCapturePreferences().catch(() => undefined)}
        />
      </SettingsRow>
      <SettingsRow label="Accessibility" description="Lets Kimochi bring your source's window to the front.">
        <PermissionStatus granted={accessibility} onAllow={() => void requestAccessibility().catch(() => undefined)} />
      </SettingsRow>
    </SettingsSection>
  )
}

export function SourcesTab(): ReactNode {
  const [quickShot, setQuickShot] = useSetting<boolean>('quickShotEnabled', false)
  // Text hooking reads Windows games: on Windows, and on Linux through Proton or Wine.
  const os = useCapabilities().os
  const hookable = os === 'windows' || os === 'linux'
  const choose = (next: Mode, current: InputSource): void => {
    // A hooked game is already a window: choosing the window keeps its Text hooking.
    if (!(next === 'ocr' && current === 'hook'))
      void updateSettings({ inputSource: next === 'quickshot' ? 'ocr' : next })
    if ((next === 'quickshot') !== quickShot) void setQuickShot(next === 'quickshot')
  }
  return (
    <SettingsPage title="Sources" description="Choose where Kimochi gets its text.">
      <WithReaderSettings>
        {(settings) => {
          const mode: Mode =
            settings.inputSource === 'hook'
              ? 'ocr'
              : settings.inputSource === 'ocr' && quickShot
                ? 'quickshot'
                : settings.inputSource
          return (
            <div className="texthooker">
              <SettingsSection title="Input">
                <ToggleGroup.Root
                  type="single"
                  value={mode}
                  onValueChange={(value) => value && choose(value as Mode, settings.inputSource)}
                  className="input-source-list"
                  aria-label="Input"
                >
                  {INPUT_SOURCES.map((option) => (
                    <ToggleGroup.Item key={option.value} value={option.value} className="input-source-row">
                      <span className="input-source-icon" aria-hidden>
                        {option.icon}
                      </span>
                      <span className="input-source-text">
                        <span className="input-source-label">{option.label}</span>
                        <span className="input-source-detail">{option.detail}</span>
                      </span>
                      {mode === option.value ? <Check className="input-source-check" aria-hidden /> : null}
                    </ToggleGroup.Item>
                  ))}
                </ToggleGroup.Root>
                {settings.inputSource === 'clipboard' ? (
                  <SettingsRow label="Poll interval" description="How often the clipboard is checked.">
                    <Select
                      aria-label="Poll interval"
                      value={String(settings.clipboardPollMs)}
                      onValueChange={(v) => void updateSettings({ clipboardPollMs: Number(v) })}
                      options={CLIPBOARD_POLL}
                    />
                  </SettingsRow>
                ) : null}
                {mode === 'ocr' && hookable ? (
                  <SettingsRow
                    label="Text hooking"
                    description="Turn it on for a game under its card in the sidebar. Here: the defaults for every game, and each game's own settings."
                  >
                    <Button size="sm" onClick={() => void openTextHookerSettings()}>
                      Open
                    </Button>
                  </SettingsRow>
                ) : null}
                {settings.inputSource === 'browser' ? (
                  <SettingsRow label="Browser extension" description="Install it and check its connection.">
                    <Button size="sm" onClick={() => showSettingsTab('browser')}>
                      Open
                    </Button>
                  </SettingsRow>
                ) : null}
                {settings.inputSource === 'websocket' ? (
                  <SettingsRow label="WebSocket URL" controlId="sources-ws-url">
                    <Input
                      id="sources-ws-url"
                      type="url"
                      mono
                      className="settings-field"
                      value={settings.websocketUrl}
                      onChange={(event) => void updateSettings({ websocketUrl: event.target.value })}
                      placeholder="ws://localhost:6677"
                    />
                  </SettingsRow>
                ) : null}
              </SettingsSection>

              <SettingsSection title="Sessions">
                <SettingsRow
                  label="Auto switch sessions by window name"
                  controlId="sources-auto-match"
                  description="Loads the session that matches the source window's name."
                >
                  <Switch
                    id="sources-auto-match"
                    checked={settings.autoMatchSource}
                    onCheckedChange={(value) => void updateSettings({ autoMatchSource: value })}
                  />
                </SettingsRow>
              </SettingsSection>
            </div>
          )
        }}
      </WithReaderSettings>
      <MacPermissionsSection />
      <OutputSections />
    </SettingsPage>
  )
}
