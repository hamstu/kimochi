/**
 * Settings → Anki → Card enhancement: sentence audio, recording what this computer plays so each
 * Log line gets the clip of its voice (a play button in the Log) and each new card its line's
 * audio (src-tauri/src/sentence_audio). For every engine that adds cards: the dictionary
 * extensions' cards through the AnkiConnect relay, the Yomitan API pop-up's through
 * `sentence_audio_attach`. `sentenceAudio` is this computer's setting, never synced.
 *
 * The speech model is required: turning it on starts its download (in Rust, so the sidebar's
 * switch does too), and nothing is recorded until it is there (`needsModel`). Its download is the
 * section's status while it runs; once recording, the section says nothing unless something is
 * wrong. The Audio field is found in Anki when it is turned on and when the Anki settings change
 * (`detectAudioField`). The word audio field is not offered (a saved `wordField` still works, as
 * does the Yomitan API's (word audio) mapping). What recording can do differs by OS (the status's
 * `platform`): macOS needs Screen Recording; Linux needs PipeWire.
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { ChevronDown, FlaskConical } from 'lucide-react'
import {
  Button,
  Callout,
  IconButton,
  Input,
  SettingsRow,
  SettingsSection,
  SettingsSubgroup,
  StatusDot,
  Switch,
  cn,
  type Tone
} from '@kit'
import { SETTINGS_DEFAULTS, type SentenceAudioSettings } from '@ui/settings'
import { sentenceAudioStatus, type SentenceAudioStatus } from '@texthooker/lib/sentenceAudio'
import { useSetting } from '../../bridge/useSetting'
import { requestPermission } from '../../bridge/tauri'
import { useModelControls } from '../../bridge/models'
import { NumberField } from './fields'
import { ModelDownload } from './ModelDownload'
import { useFieldDetection } from './fieldDetection'

const DEFAULTS = SETTINGS_DEFAULTS.sentenceAudio

function useStatus(enabled: boolean): SentenceAudioStatus | null {
  const [status, setStatus] = useState<SentenceAudioStatus | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void => {
      if (document.visibilityState !== 'visible') return
      sentenceAudioStatus().then(
        (next) => live && setStatus(next),
        () => live && setStatus(null)
      )
    }
    read()
    const timer = setInterval(read, enabled ? 1000 : 5000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [enabled])
  return status
}

/** What is wrong with recording, if anything: on and working says nothing. */
function problem(status: SentenceAudioStatus | null): { tone: Tone; title: string; detail: string } | null {
  switch (status?.state) {
    case 'noPermission':
      return {
        tone: 'warn',
        title: 'Needs Screen Recording',
        detail:
          'macOS records system audio under the Screen Recording permission. Allow Kimochi, then quit and reopen it.'
      }
    case 'unavailable':
      return { tone: 'warn', title: 'Not recording', detail: `${status.message} Kimochi checks again every 30 seconds.` }
    case 'unsupported':
      return { tone: 'neutral', title: 'Not available', detail: status.message }
    case 'error':
      return { tone: 'danger', title: 'Not recording', detail: `${status.message} Trying again shortly.` }
    default:
      return null
  }
}

/** What turning it on does. */
const SWITCH_DESCRIPTION =
  'Kimochi records system audio and tries to match the audio of each line it scans, which it adds to the new cards you make in Anki automatically.'

/** The speech model's state once downloaded, when there is something to say. */
function recogniserNote(status: SentenceAudioStatus | null): string | null {
  switch (status?.recogniser.state) {
    case 'loading':
      return 'Loading the speech model…'
    case 'failed':
      return `The speech model did not load: ${status.recogniser.message}`
    default:
      return null
  }
}

/** A text setting saved on blur or Enter; `optional` lets it be emptied. */
export function FieldInput({
  id,
  value,
  placeholder,
  optional,
  onSave
}: {
  id: string
  value: string
  placeholder: string
  optional?: boolean
  onSave: (value: string) => void
}): ReactNode {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }
  const save = (next: string): void => {
    const trimmed = next.trim()
    if ((trimmed || optional) && trimmed !== value) onSave(trimmed)
    else setDraft(value)
  }
  return (
    <Input
      id={id}
      mono
      className="settings-field"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => save(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save(e.currentTarget.value)
      }}
      placeholder={placeholder}
    />
  )
}

export function SentenceAudioSection(): ReactNode {
  const [stored, save] = useSetting<SentenceAudioSettings>('sentenceAudio', DEFAULTS)
  const config = { ...DEFAULTS, ...stored }
  const update = (patch: Partial<SentenceAudioSettings>): void => {
    void save({ ...config, ...patch })
  }
  const status = useStatus(config.enabled)
  const trouble = config.enabled ? problem(status) : null
  const model = useModelControls('sensevoice')
  const modelReady = model.status?.state === 'ready'
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const advancedPanel = useId()
  const detection = useFieldDetection(config.enabled)

  return (
    <SettingsSection>
      <SettingsRow
        label="Enhance with sentence audio"
        controlId="sentence-audio-enabled"
        description={SWITCH_DESCRIPTION}
      >
        <Switch
          id="sentence-audio-enabled"
          checked={config.enabled}
          onCheckedChange={(enabled) => {
            update({ enabled })
            if (enabled) detection.run()
          }}
        />
      </SettingsRow>
      {config.enabled && (
        <>
          <div className="settings-note">
            <Callout tone="warn" icon={<FlaskConical />}>
              Sentence audio is experimental, so a clip may not always be correct. Check the Anki tab in
              the main window to see which cards get enhanced.
            </Callout>
          </div>
          {model.status && !modelReady && (
            <div className="settings-note">
              <ModelDownload controls={model} emphasis label="Speech model" />
            </div>
          )}
          {!modelReady && (
            <div className="settings-note">
              <p className="k-description">
                Sentence audio needs this model to hear each line&apos;s words. It runs on this computer,
                and recording starts once it&apos;s downloaded.
              </p>
            </div>
          )}
          {modelReady && recogniserNote(status) && (
            <div className="settings-note">
              <Callout tone={status?.recogniser.state === 'failed' ? 'warn' : 'neutral'}>{recogniserNote(status)}</Callout>
            </div>
          )}
          {trouble && (
            <SettingsRow
              label={
                <span className="anki-connection-label">
                  <StatusDot tone={trouble.tone} />
                  {trouble.title}
                </span>
              }
              description={<span role="status">{trouble.detail}</span>}
            >
              {status?.state === 'noPermission' && (
                <Button size="sm" onClick={() => void requestPermission()}>
                  Allow…
                </Button>
              )}
            </SettingsRow>
          )}
          {status?.last && !status.last.ok && (
            <div className="settings-note">
              <Callout tone="warn">
                Last card ({new Date(status.last.at).toLocaleTimeString()}): {status.last.message}
              </Callout>
            </div>
          )}
          <SettingsRow
            label="Audio field"
            controlId="sentence-audio-field"
            description="The field in your note that gets the line's audio."
          >
            <FieldInput
              id="sentence-audio-field"
              value={config.field}
              placeholder={DEFAULTS.field}
              onSave={(field) => update({ field })}
            />
          </SettingsRow>
          {detection.note && (
            <div className="settings-note">
              <Callout tone="warn">{detection.note}</Callout>
            </div>
          )}
          <SettingsRow label="Advanced" controlId="sentence-audio-advanced">
            <IconButton
              id="sentence-audio-advanced"
              label={advancedOpen ? 'Hide advanced settings' : 'Advanced settings'}
              size="sm"
              className={cn('sentence-audio-disclosure', advancedOpen && 'sentence-audio-disclosure-open')}
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
                <SettingsRow
                  label="Start offset"
                  controlId="sentence-audio-start"
                  description="Milliseconds added to each clip's start. Negative starts it earlier."
                >
                  <NumberField
                    id="sentence-audio-start"
                    value={config.startOffsetMs}
                    min={-5000}
                    max={5000}
                    step={50}
                    fallback={0}
                    onCommit={(startOffsetMs) => update({ startOffsetMs })}
                  />
                </SettingsRow>
                <SettingsRow
                  label="End offset"
                  controlId="sentence-audio-end"
                  description="Milliseconds added to each clip's end. Negative ends it earlier."
                >
                  <NumberField
                    id="sentence-audio-end"
                    value={config.endOffsetMs}
                    min={-5000}
                    max={5000}
                    step={50}
                    fallback={0}
                    onCommit={(endOffsetMs) => update({ endOffsetMs })}
                  />
                </SettingsRow>
                <SettingsRow
                  label="Seconds kept"
                  controlId="sentence-audio-seconds"
                  description="How much audio is held in memory. A line's clip can only be cut while its audio is still held."
                >
                  <NumberField
                    id="sentence-audio-seconds"
                    value={config.seconds}
                    min={10}
                    max={120}
                    step={5}
                    fallback={DEFAULTS.seconds}
                    onCommit={(seconds) => update({ seconds })}
                  />
                </SettingsRow>
                <SettingsRow
                  label="Clips kept"
                  controlId="sentence-audio-clips"
                  description="The newest lines' clips stay on this computer, to play from the Log and to add to cards you make later."
                >
                  <NumberField
                    id="sentence-audio-clips"
                    value={config.clips}
                    min={5}
                    max={100}
                    step={5}
                    fallback={DEFAULTS.clips}
                    onCommit={(clips) => update({ clips })}
                  />
                </SettingsRow>
              </div>
            </SettingsSubgroup>
          )}
        </>
      )}
    </SettingsSection>
  )
}
