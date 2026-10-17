/**
 * Settings → Log: how the transcript reads, which incoming lines it keeps, the text replacements
 * applied on arrival, and the reading timer. Clearing a session's lines and resetting its stats
 * are in the session menu and the Log's ⋯ menu, next to the lines they act on.
 */
import { useState, type ReactNode } from 'react'
import {
  Button,
  ConfirmDialog,
  Select,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSubgroup,
  Switch
} from '@kit'
import { ReplacementsEditor } from '@texthooker/components/ReplacementsEditor'
import { resetSettings, updateSettings } from '@texthooker/lib/settings'
import type { AudioSettings } from '../../vendor/shared-types'
import { DEFAULT_VOICE_ID } from '../../vendor/shared-constants'
import { AVAILABLE_VOICES } from '../../vendor/voices'
import { useSetting } from '../../bridge/useSetting'
import { useCapabilities } from '../../bridge/capabilities'
import { WithReaderSettings } from './ReaderSettingsProvider'
import { NumberField } from './fields'

const VOICE_OPTIONS = AVAILABLE_VOICES.map((voice) => ({ value: voice.id, label: voice.name }))

export function LogTab(): ReactNode {
  const [audioSettings, setAudioSettings] = useSetting<AudioSettings>('audioSettings', {
    voiceId: DEFAULT_VOICE_ID
  })
  const [confirmReset, setConfirmReset] = useState(false)
  // Read aloud runs on Kimochi cloud, which needs a signed-in Kimochi account; without one its
  // voice is moot.
  const { cloudAccess } = useCapabilities()

  return (
    <SettingsPage title="Log" description="How the transcript reads and which lines it keeps.">
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
            </SettingsSection>

            <SettingsSection title="Incoming lines">
              <SettingsRow
                label="Japanese only"
                controlId="log-cjk"
                description="Drop lines with no Japanese characters."
              >
                <Switch
                  id="log-cjk"
                  checked={settings.cjkOnly}
                  onCheckedChange={(v) => void updateSettings({ cjkOnly: v })}
                />
              </SettingsRow>
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

            <SettingsSection title="Reset">
              <SettingsRow
                label="Reset Log settings"
                description="Restores the defaults here and on the Sources, Dictionary and AI pages. Sessions, lines and text replacements are kept."
              >
                <Button variant="danger" size="sm" onClick={() => setConfirmReset(true)}>
                  Reset…
                </Button>
              </SettingsRow>
            </SettingsSection>
            <ConfirmDialog
              open={confirmReset}
              onOpenChange={setConfirmReset}
              tone="danger"
              title="Reset Log settings?"
              description="Every option on the Sources, Log, Dictionary and AI pages returns to its default, including the DeepL key and the Anki setup. Sessions, lines and text replacements are kept. This can’t be undone."
              confirmLabel="Reset settings"
              onConfirm={() => {
                void resetSettings()
                setConfirmReset(false)
              }}
            />
          </div>
        )}
      </WithReaderSettings>
    </SettingsPage>
  )
}
