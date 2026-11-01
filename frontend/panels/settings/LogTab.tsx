/**
 * Settings → Log & Sessions: how the transcript reads, which incoming lines it keeps, the text
 * replacements applied on arrival, the reading timer, and the sessions themselves (the same list
 * as the Log's "Manage sessions" dialog). Clearing a session's lines and resetting its stats are in
 * the session menu and the Log's ⋯ menu, next to the lines they act on.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import {
  Button,
  Select,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSubgroup,
  Switch
} from '@kit'
import { ReplacementsEditor } from '@texthooker/components/ReplacementsEditor'
import { SessionList } from '@texthooker/components/SessionList'
import { createSession, getManifest, subscribeSessions } from '@texthooker/lib/sessions'
import { updateSettings } from '@texthooker/lib/settings'
import type { AudioSettings } from '../../vendor/shared-types'
import { DEFAULT_VOICE_ID } from '../../vendor/shared-constants'
import { AVAILABLE_VOICES } from '../../vendor/voices'
import { useSetting } from '../../bridge/useSetting'
import { useCapabilities } from '../../bridge/capabilities'
import { WithReaderSettings } from './ReaderSettingsProvider'
import { JapaneseOnlyRows } from './JapaneseOnlyRows'
import { NumberField } from './fields'

const VOICE_OPTIONS = AVAILABLE_VOICES.map((voice) => ({ value: voice.id, label: voice.name }))
// The ElevenLabs speech models Kimochi's server accepts (`TTS_MODELS` in src-tauri/src/cloud.rs).
const MODEL_OPTIONS = [
  { value: 'eleven_v3', label: 'Eleven v3' },
  { value: 'eleven_v4', label: 'Eleven v4' },
  { value: 'eleven_v4_turbo', label: 'Eleven v4 Turbo' }
]

export function LogTab(): ReactNode {
  const [audioSettings, setAudioSettings] = useSetting<AudioSettings>('audioSettings', {
    voiceId: DEFAULT_VOICE_ID
  })
  // Read aloud runs on Kimochi cloud, which needs a signed-in Kimochi account; without one its
  // voice is moot.
  const { cloudAccess } = useCapabilities()

  return (
    <SettingsPage
      title="Log & Sessions"
      description="How the transcript reads, which lines it keeps, and your sessions."
    >
      <WithReaderSettings>
        {(settings) => (
          <div className="texthooker">
            <SettingsSection title="Reading">
              <SettingsRow
                label="Text size"
                controlId="log-font-size"
                description="In pixels, 12 to 48. Also A− and A+ in the Log's footer."
              >
                <NumberField
                  id="log-font-size"
                  value={settings.fontSizePx}
                  min={12}
                  max={48}
                  step={1}
                  fallback={22}
                  onCommit={(v) => void updateSettings({ fontSizePx: v })}
                />
              </SettingsRow>
              {cloudAccess && (
                <SettingsRow label="Read-aloud voice" description="The voice that reads lines aloud.">
                  <Select
                    aria-label="Read-aloud voice"
                    value={audioSettings.voiceId}
                    onValueChange={(voiceId) => void setAudioSettings({ ...audioSettings, voiceId })}
                    options={VOICE_OPTIONS}
                  />
                </SettingsRow>
              )}
              {cloudAccess && (
                <SettingsRow
                  label="Voice model"
                  description="Eleven v4 is newer and more expressive; v4 Turbo answers faster."
                >
                  <Select
                    aria-label="Voice model"
                    value={audioSettings.model ?? 'eleven_v3'}
                    onValueChange={(model) => void setAudioSettings({ ...audioSettings, model })}
                    options={MODEL_OPTIONS}
                  />
                </SettingsRow>
              )}
            </SettingsSection>

            <SettingsSection title="Incoming lines">
              <JapaneseOnlyRows idPrefix="log" />
              <SettingsRow
                label="Skip repeats"
                controlId="log-dedupe"
                description="Drop a line that matches any of the last N lines."
              >
                <NumberField
                  id="log-dedupe"
                  value={settings.dedupeDepth}
                  min={1}
                  max={20}
                  step={1}
                  fallback={1}
                  onCommit={(v) => void updateSettings({ dedupeDepth: v })}
                />
              </SettingsRow>
              <SettingsRow
                label="Merge streamed lines"
                controlId="log-merge"
                description="Replace the previous line when a new one starts with the same characters."
              >
                <Switch
                  id="log-merge"
                  checked={settings.startMergeEnabled}
                  onCheckedChange={(v) => void updateSettings({ startMergeEnabled: v })}
                />
              </SettingsRow>
              {settings.startMergeEnabled ? (
                <SettingsSubgroup>
                  <SettingsRow
                    label="Characters to compare"
                    controlId="log-merge-len"
                    description="How many leading characters must match."
                  >
                    <NumberField
                      id="log-merge-len"
                      value={settings.startMergePrefixLen}
                      min={1}
                      max={20}
                      step={1}
                      fallback={4}
                      onCommit={(v) => void updateSettings({ startMergePrefixLen: v })}
                    />
                  </SettingsRow>
                </SettingsSubgroup>
              ) : null}
              <SettingsRow
                label="Keep at most"
                controlId="log-max-lines"
                description="Lines per session. The oldest are dropped past this."
              >
                <NumberField
                  id="log-max-lines"
                  value={settings.maxLines}
                  min={100}
                  max={50000}
                  step={100}
                  fallback={5000}
                  onCommit={(v) => void updateSettings({ maxLines: v })}
                />
              </SettingsRow>
            </SettingsSection>

            <ReplacementsEditor />

            <SettingsSection
              title="Reading timer"
              footnote="Choose which stats the footer shows from the Log's ⋯ menu."
            >
              <SettingsRow
                label="Pause when idle for"
                controlId="log-afk"
                description="Seconds without a new line before the timer pauses."
              >
                <NumberField
                  id="log-afk"
                  value={settings.afkThresholdSec}
                  min={10}
                  max={600}
                  step={5}
                  fallback={60}
                  onCommit={(v) => void updateSettings({ afkThresholdSec: v })}
                />
              </SettingsRow>
            </SettingsSection>

            <SessionsSection />
          </div>
        )}
      </WithReaderSettings>
    </SettingsPage>
  )
}

/** Every session, in the Log's order: reorder, rename, switch, delete, or start a new one. */
function SessionsSection(): ReactNode {
  // Rendered inside WithReaderSettings, so the Log's snapshot (and its sessions) is here.
  const [manifest, setManifest] = useState(getManifest)
  const [error, setError] = useState<string | null>(null)
  // A copy each time: where the Log runs in the same page (the browser preview), the snapshot is
  // its live manifest, changed in place.
  useEffect(() => subscribeSessions((next) => setManifest({ ...next, sessions: [...next.sessions] })), [])

  const create = async (): Promise<void> => {
    setError(null)
    try {
      await createSession()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't create a session.")
    }
  }

  return (
    <SettingsSection
      title="Sessions"
      description="Drag to reorder. Click a name to rename it."
      actions={
        <Button variant="ghost" size="sm" onClick={() => void create()}>
          <Plus /> New session
        </Button>
      }
      footnote={error ?? undefined}
    >
      <SessionList
        activeId={manifest.activeId}
        sessions={manifest.sessions}
        switchable
        className="settings-sessions"
      />
    </SettingsSection>
  )
}
