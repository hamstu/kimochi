/**
 * Settings → Sources: where the Log's lines come from, how sessions follow the source, and where
 * OCR scans are also sent. The same input choice is the main window's source menu.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Aperture, Camera, Check, Clipboard, ExternalLink, FolderOpen, Globe, Plug, Radio } from 'lucide-react'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import {
  Button,
  Input,
  Select,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  StatusDot,
  Switch
} from '@kit'
import { updateSettings } from '@texthooker/lib/settings'
import type { Settings } from '@texthooker/lib/types'
import { useSetting } from '../../bridge/useSetting'
import { browserExtensionFolder, useBrowserBridge } from '../../bridge/browserBridge'
import { accessibilityStatus, openScreenCapturePreferences, requestAccessibility } from '../../bridge/tauri'
import { useCapabilities } from '../../bridge/capabilities'
import { useHasScreenRecordingPermission } from '../../welcome/useHasScreenRecordingPermission'
import { WithReaderSettings } from './ReaderSettingsProvider'
import { OutputSections } from './OutputSections'
import { openTextHookerSettings } from '../../main/hookGames'

type InputSource = Settings['inputSource']
/** The texthooker's inputs, with OCR split into Screen and Quick Shot. */
type Mode = InputSource | 'quickshot'

const INPUT_SOURCES = [
  {
    value: 'ocr',
    label: 'Screen',
    icon: <Camera />,
    detail: 'Scan the window or screen chosen in the source menu with OCR.'
  },
  {
    value: 'quickshot',
    label: 'Quick Shot',
    icon: <Aperture />,
    detail: 'No source, just hit the button or shortcut to grab and scan.'
  },
  {
    value: 'clipboard',
    label: 'Clipboard',
    icon: <Clipboard />,
    detail: 'Picks up text copied to the clipboard. (E.g., from a text hooker.)'
  },
  {
    value: 'websocket',
    label: 'WebSocket',
    icon: <Radio />,
    detail: 'Receives plain-text messages from a text source on your network.'
  },
  {
    value: 'hook',
    label: 'Text Hooker',
    icon: <Plug />,
    detail: "Hooks a game's text from inside it. Choose the game in the source menu. (Windows)"
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
        <PermissionStatus
          granted={accessibility}
          onAllow={() => void requestAccessibility().catch(() => undefined)}
        />
      </SettingsRow>
    </SettingsSection>
  )
}

/**
 * The Kimochi browser extension: its connection (src-tauri/src/browser_bridge.rs) and how to
 * install it. Until it is in the browsers' stores, it is loaded from its folder.
 */
function BrowserExtensionSection(): ReactNode {
  const [enabled, setEnabled] = useSetting<boolean>('browserExtension.enabled', true)
  const status = useBrowserBridge()
  const [folderError, setFolderError] = useState<string | null>(null)
  const connected = status.connected ?? 0
  const state = !enabled
    ? { tone: 'neutral' as const, text: 'Off' }
    : status.error
      ? { tone: 'danger' as const, text: status.error }
      : connected
        ? { tone: 'ok' as const, text: `Connected: ${[...new Set(status.browsers ?? [])].join(', ') || 'your browser'}` }
        : { tone: 'neutral' as const, text: 'Waiting for the extension' }
  return (
    <SettingsSection title="Browser extension">
      <SettingsRow
        label="Connect to the browser extension"
        controlId="browser-extension-enabled"
        description="Pick a picture on any web page (a manga page, a screenshot) and Kimochi reads it with your OCR engine. The text lands on top of the picture in the page, for your browser's own dictionary pop-up (Yomitan, 10ten and the like), and in the Log."
      >
        <Switch id="browser-extension-enabled" checked={enabled} onCheckedChange={(value) => void setEnabled(value)} />
      </SettingsRow>
      {enabled ? (
        <>
          <SettingsRow label="Status">
            <span className="settings-status">
              <StatusDot tone={state.tone} />
              {state.text}
            </span>
          </SettingsRow>
          <SettingsRow
            label="Install the extension"
            description="In Chrome, Edge or Brave: open the extensions page (chrome://extensions), turn on Developer mode, choose Load unpacked, and pick this folder. Then click Kimochi in the toolbar (or press Alt+K) and click a picture."
          >
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setFolderError(null)
                void browserExtensionFolder().catch((error: unknown) => setFolderError(String(error)))
              }}
            >
              <FolderOpen />
              Show folder
            </Button>
          </SettingsRow>
          {folderError ? <p className="settings-note">{folderError}</p> : null}
        </>
      ) : null}
    </SettingsSection>
  )
}

export function SourcesTab(): ReactNode {
  const [quickShot, setQuickShot] = useSetting<boolean>('quickShotEnabled', false)
  // Text hooking reads Windows games: on Windows, and on Linux through Proton or Wine.
  const os = useCapabilities().os
  const hookable = os === 'windows' || os === 'linux'
  const choose = (next: Mode): void => {
    void updateSettings({ inputSource: next === 'quickshot' ? 'ocr' : next })
    if ((next === 'quickshot') !== quickShot) void setQuickShot(next === 'quickshot')
  }
  return (
    <SettingsPage
      title="Sources"
      description="Choose where Kimochi gets its text."
    >
      <WithReaderSettings>
        {(settings) => {
          const mode: Mode =
            settings.inputSource === 'ocr' && quickShot ? 'quickshot' : settings.inputSource
          return (
            <div className="texthooker">
              <SettingsSection title="Input">
                <ToggleGroup.Root
                  type="single"
                  value={mode}
                  onValueChange={(value) => value && choose(value as Mode)}
                  className="input-source-list"
                  aria-label="Input"
                >
                  {INPUT_SOURCES.filter((option) => option.value !== 'hook' || hookable).map((option) => (
                    <ToggleGroup.Item
                      key={option.value}
                      value={option.value}
                      className="input-source-row"
                    >
                      <span className="input-source-icon" aria-hidden>
                        {option.icon}
                      </span>
                      <span className="input-source-text">
                        <span className="input-source-label">{option.label}</span>
                        <span className="input-source-detail">{option.detail}</span>
                      </span>
                      {mode === option.value ? (
                        <Check className="input-source-check" aria-hidden />
                      ) : null}
                    </ToggleGroup.Item>
                  ))}
                </ToggleGroup.Root>
                {settings.inputSource === 'clipboard' ? (
                  <SettingsRow
                    label="Poll interval"
                    description="How often the clipboard is checked."
                  >
                    <Select
                      aria-label="Poll interval"
                      value={String(settings.clipboardPollMs)}
                      onValueChange={(v) => void updateSettings({ clipboardPollMs: Number(v) })}
                      options={CLIPBOARD_POLL}
                    />
                  </SettingsRow>
                ) : null}
                {settings.inputSource === 'hook' ? (
                  <SettingsRow
                    label="Text Hooker settings"
                    description="Defaults for every game, and each game's own."
                  >
                    <Button size="sm" onClick={() => void openTextHookerSettings()}>
                      Open
                    </Button>
                  </SettingsRow>
                ) : null}
                {settings.inputSource === 'websocket' ? (
                  <SettingsRow
                    label="WebSocket URL"
                    controlId="sources-ws-url"
                    description="The address of the text source."
                  >
                    <Input
                      id="sources-ws-url"
                      type="url"
                      mono
                      className="settings-field"
                      value={settings.websocketUrl}
                      onChange={(event) =>
                        void updateSettings({ websocketUrl: event.target.value })
                      }
                      placeholder="ws://localhost:6677"
                    />
                  </SettingsRow>
                ) : null}
              </SettingsSection>

              <SettingsSection title="Sessions">
                <SettingsRow
                  label="Auto switch sessions by window name"
                  controlId="sources-auto-match"
                  description="Kimochi will try to auto-load a session based on the source window name."
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
      <BrowserExtensionSection />
      <MacPermissionsSection />
      <OutputSections />
    </SettingsPage>
  )
}
