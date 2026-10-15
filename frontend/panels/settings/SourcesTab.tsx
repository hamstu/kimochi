/**
 * Settings → Sources: where the Log's lines come from, how sessions follow the source, and where
 * OCR scans are also sent. The same input choice is the main window's source menu.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Aperture, Camera, Check, Clipboard, ExternalLink, Radio } from 'lucide-react'
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
import { accessibilityStatus, requestAccessibility } from '../../bridge/tauri'
import { WithReaderSettings } from './ReaderSettingsProvider'
import { OutputSections } from './OutputSections'

type InputSource = Settings['inputSource']
/** The texthooker's inputs, with OCR split into Screen and Quick Shot. */
type Mode = InputSource | 'quickshot'

const INPUT_SOURCES = [
  {
    value: 'ocr',
    label: 'Screen',
    icon: <Camera />,
    detail: 'Reads the window or screen chosen in the source menu, with OCR.'
  },
  {
    value: 'quickshot',
    label: 'Quick Shot',
    icon: <Aperture />,
    detail:
      'No source to choose: the scan shortcut asks you to draw an area on the screen, then reads it.'
  },
  {
    value: 'clipboard',
    label: 'Clipboard',
    icon: <Clipboard />,
    detail: 'Picks up text copied to the clipboard, for example by a text hooker.'
  },
  {
    value: 'websocket',
    label: 'WebSocket',
    icon: <Radio />,
    detail: 'Receives plain-text messages from a text source on your network.'
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

/**
 * Accessibility on macOS, where onboarding offers it once: what lets a click on the source
 * bring that exact window forward. Nothing on platforms without the permission.
 */
function AccessibilitySection(): ReactNode {
  const [granted, setGranted] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    const check = (): void => {
      void accessibilityStatus()
        .then((next) => alive && setGranted(next))
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
  if (granted === null) return null
  return (
    <SettingsSection title="Windows">
      <SettingsRow
        label="Accessibility"
        description="Lets a click on your source bring that exact window to the front, even a game in full screen on a Space of its own. Without it, Kimochi brings the application forward instead."
      >
        {granted ? (
          <span className="settings-status">
            <StatusDot tone="ok" />
            Allowed
          </span>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => void requestAccessibility().catch(() => undefined)}>
            Open System Settings
            <ExternalLink />
          </Button>
        )}
      </SettingsRow>
    </SettingsSection>
  )
}

export function SourcesTab(): ReactNode {
  const [quickShot, setQuickShot] = useSetting<boolean>('quickShotEnabled', false)
  const choose = (next: Mode): void => {
    void updateSettings({ inputSource: next === 'quickshot' ? 'ocr' : next })
    if ((next === 'quickshot') !== quickShot) void setQuickShot(next === 'quickshot')
  }
  return (
    <SettingsPage
      title="Sources"
      description="Where the Log's lines come from. The source menu at the top of the main window switches between them too."
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
                  {INPUT_SOURCES.map((option) => (
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
                  label="Switch sessions by window name"
                  controlId="sources-auto-match"
                  description="With screen input, each window you read gets its own session, created the first time. Also in the session menu."
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
      <AccessibilitySection />
      <OutputSections />
    </SettingsPage>
  )
}
