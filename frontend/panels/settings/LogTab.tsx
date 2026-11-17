/**
 * Settings → Log & Sessions: how the transcript reads, which incoming lines it keeps, the text
 * replacements applied on arrival, the reading timer, and the sessions themselves (the same list
 * as the Log's "Manage sessions" dialog). Clearing a session's lines and resetting its stats are in
 * the session menu and the Log's ⋯ menu, next to the lines they act on.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { Button, Select, SettingsPage, SettingsRow, SettingsSection, SettingsSubgroup, Switch } from '@kit'
import { ReplacementsEditor } from '@texthooker/components/ReplacementsEditor'
import { SessionList } from '@texthooker/components/SessionList'
import { createSession, getManifest, subscribeSessions } from '@texthooker/lib/sessions'
import { updateSettings } from '@texthooker/lib/settings'
import type { AudioSettings } from '../../vendor/shared-types'
import { DEFAULT_VOICE_ID } from '../../vendor/shared-constants'
import { AVAILABLE_VOICES } from '../../vendor/voices'
import { SETTINGS_DEFAULTS, type CardScreenshotSettings, type SentenceAudioSettings } from '@ui/settings'
import { useSetting } from '../../bridge/useSetting'
import { useCapabilities } from '../../bridge/capabilities'
import { useLanguage } from '../../bridge/useLanguage'
import { ACTIVITY_TICKER_SECTION, SESSIONS_SECTION, useSettingsTarget } from '../../bridge/settingsTarget'
import { WithReaderSettings } from './ReaderSettingsProvider'
import { JapaneseFilterRow } from './JapaneseFilterRow'
import { NumberField } from './fields'

/** When a reading day starts (lib/readingTime.ts `readingDay`). */
const DAY_START_OPTIONS = [0, 1, 2, 3, 4, 5, 6].map((hour) => ({
  value: String(hour),
  label: hour === 0 ? 'Midnight' : `${hour} am`
}))
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
  const [storedShot, saveShot] = useSetting<CardScreenshotSettings>('cardScreenshot', SETTINGS_DEFAULTS.cardScreenshot)
  const [storedAudio, saveAudio] = useSetting<SentenceAudioSettings>('sentenceAudio', SETTINGS_DEFAULTS.sentenceAudio)
  const shot = { ...SETTINGS_DEFAULTS.cardScreenshot, ...storedShot }
  const audio = { ...SETTINGS_DEFAULTS.sentenceAudio, ...storedAudio }
  // Read aloud runs on Kimochi cloud, which needs a signed-in Kimochi account; without one its
  // voice is moot.
  const { cloudAccess } = useCapabilities()
  // The voices are Japanese, so read aloud (and its settings) is for Japanese only for now.
  const [language] = useLanguage()
  const readAloud = cloudAccess && language.code === 'ja'
  // The activity ticker's cog opens this page at its section.
  useSettingsTarget()

  return (
    <SettingsPage
      title="Log & Sessions"
      description="How the transcript reads, which lines it keeps, and your sessions."
    >
      <WithReaderSettings>
        {(settings) => (
          <div className="texthooker">
            <SettingsSection title="Reading">
              <SettingsRow label="Text size" controlId="log-font-size" description="In pixels, 12 to 48.">
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
              {readAloud && (
                <SettingsRow label="Read-aloud voice">
                  <Select
                    aria-label="Read-aloud voice"
                    value={audioSettings.voiceId}
                    onValueChange={(voiceId) => void setAudioSettings({ ...audioSettings, voiceId })}
                    options={VOICE_OPTIONS}
                  />
                </SettingsRow>
              )}
              {readAloud && (
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
              <JapaneseFilterRow />
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
              <SettingsRow
                label="Images to retain"
                controlId="log-images-kept"
                description="Screenshots of the newest scans for the Log and Anki. Set to 0 to stop saving images."
              >
                <NumberField
                  id="log-images-kept"
                  value={shot.kept}
                  min={0}
                  max={500}
                  step={1}
                  fallback={SETTINGS_DEFAULTS.cardScreenshot.kept}
                  onCommit={(kept) => void saveShot({ ...shot, kept })}
                />
              </SettingsRow>
              <SettingsRow
                label="Audio clips to retain"
                controlId="log-audio-clips"
                description="Clips of the newest lines for the Log and Anki. Set to 0 to stop saving clips."
              >
                <NumberField
                  id="log-audio-clips"
                  value={audio.clips}
                  min={0}
                  max={100}
                  step={1}
                  fallback={SETTINGS_DEFAULTS.sentenceAudio.clips}
                  onCommit={(clips) => void saveAudio({ ...audio, clips })}
                />
              </SettingsRow>
            </SettingsSection>

            <ReplacementsEditor />

            <SettingsSection
              id={ACTIVITY_TICKER_SECTION}
              title="Activity ticker"
              description="A small bubble at the bottom of the Log."
            >
              <SettingsRow
                label="Show activity ticker"
                controlId="log-activity-ticker"
                description="Small notices when images are scanned, and other status events."
              >
                <Switch
                  id="log-activity-ticker"
                  checked={settings.showActivityTicker}
                  onCheckedChange={(v) => void updateSettings({ showActivityTicker: v })}
                />
              </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Stats" footnote="Choose which stats the footer shows from the Log's ⋯ menu.">
              <SettingsRow
                label="Max time per line"
                controlId="log-afk"
                description="The maximum amount of time Kimochi will count for you reading a single line."
              >
                <NumberField
                  id="log-afk"
                  value={settings.afkThresholdSec}
                  min={10}
                  max={600}
                  step={5}
                  fallback={300}
                  onCommit={(v) => void updateSettings({ afkThresholdSec: v })}
                />
              </SettingsRow>
              <SettingsRow
                label="Ignore skipped lines"
                controlId="log-skip-fast"
                description="Lines that flash by under a second apart don't count."
              >
                <Switch
                  id="log-skip-fast"
                  checked={settings.skipFastLines}
                  onCheckedChange={(v) => void updateSettings({ skipFastLines: v })}
                />
              </SettingsRow>
              <SettingsRow label="Day starts at" description="Reading before this hour counts toward the day before.">
                <Select
                  aria-label="Day starts at"
                  value={String(settings.dayStartHour)}
                  onValueChange={(hour) => void updateSettings({ dayStartHour: Number(hour) })}
                  options={DAY_START_OPTIONS}
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

/** Every session, in the Log's order: reorder, rename, describe, switch, clear, delete, or start a new one. */
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
      id={SESSIONS_SECTION}
      title="Sessions"
      description="Click a name to rename it; drag a handle to reorder. Tick sessions to clear or delete them together."
      actions={
        <Button variant="ghost" size="sm" onClick={() => void create()}>
          <Plus /> New session
        </Button>
      }
      footnote={error ?? undefined}
    >
      <SessionList activeId={manifest.activeId} sessions={manifest.sessions} className="settings-sessions" />
    </SettingsSection>
  )
}
