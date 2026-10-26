/**
 * Settings → Anki → Sentence audio: recording what this computer plays, so each Log line gets the
 * clip of its voice (a play button in the Log) and each new card its line's audio
 * (src-tauri/src/sentence_audio). For every engine that adds cards: the dictionary extensions'
 * cards through the AnkiConnect relay, the Yomitan API pop-up's through `sentence_audio_attach`.
 * `sentenceAudio` is this computer's setting, never synced.
 *
 * Without the speech model, lines are placed by timing alone; with it (downloaded here, like an
 * OCR engine's model), the listener hears what was said and finds each line in it, which is what
 * makes OCR'd lines, lines read without a pause and word audio work. While it is on, the
 * recording state is read every second (`sentence_audio_status`), with a level meter, so a user
 * can see it hears the game before mining. What it can do differs by OS (the status's
 * `platform`): macOS needs Screen Recording; Windows leaves Kimochi's sounds out from 10 2004 on;
 * Linux needs PipeWire and records Kimochi's sounds too.
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
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
import { canRemoveModel } from '@ui/model-download'
import { sentenceAudioStatus, type SentenceAudioStatus } from '@texthooker/lib/sentenceAudio'
import { useSetting } from '../../bridge/useSetting'
import { requestPermission } from '../../bridge/tauri'
import { useModelControls } from '../../bridge/models'
import { NumberField } from './fields'
import { ModelDownload, RemoveModelDialog } from './ModelDownload'

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

function describe(status: SentenceAudioStatus | null): { tone: Tone; title: string; detail: string } {
  switch (status?.state) {
    case 'recording':
      return {
        tone: 'ok',
        title: 'Recording',
        detail: `${status.source}: the last ${Math.round(status.held)} seconds, in memory only. ${
          status.excludesOwnAudio
            ? "Kimochi's own sounds are left out."
            : "Kimochi's own sounds are recorded too, so keep sound effects off while you mine."
        }`
      }
    case 'starting':
      return { tone: 'neutral', title: 'Starting…', detail: '' }
    case 'noPermission':
      return {
        tone: 'warn',
        title: 'Needs Screen Recording',
        detail:
          'macOS records system audio under the Screen Recording permission. Allow Kimochi, then quit and reopen it.'
      }
    case 'unavailable':
      return { tone: 'warn', title: 'Not available', detail: `${status.message} Kimochi checks again every 30 seconds.` }
    case 'unsupported':
      return { tone: 'neutral', title: 'Not available', detail: status.message }
    case 'error':
      return { tone: 'danger', title: 'Not recording', detail: `${status.message} Trying again shortly.` }
    default:
      return { tone: 'neutral', title: 'Off', detail: 'Nothing is recorded.' }
  }
}

/** What turning it on means on this computer. */
function switchDescription(seconds: number, platform: string | undefined): string {
  const kept = `Kimochi keeps the last ${seconds} seconds of audio in memory, and tries to match the sentence.`
  switch (platform) {
    case 'macos':
      return `${kept} Kimochi's own sounds are left out. macOS shows its screen-recording indicator while this is on.`
    case 'windows':
      return `${kept} On Windows 10 (2004) and later, Kimochi's own sounds are left out.`
    case 'linux':
      return `${kept} Needs PipeWire, as SteamOS and most desktops have. Kimochi's own sounds are recorded too.`
    default:
      return kept
  }
}

/** How lines are being found, once the speech model is downloaded. */
function matchingLine(status: SentenceAudioStatus | null): string {
  switch (status?.recogniser.state) {
    case 'loading':
      return 'Loading the speech model…'
    case 'failed':
      return `The speech model did not load: ${status.recogniser.message} Lines are placed by timing.`
    default:
      return 'Lines are matched to their voice by what is said.'
  }
}

/** A text setting saved on blur or Enter; `optional` lets it be emptied. */
function FieldInput({
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

export function SentenceAudioSection({ popupMapping }: { popupMapping: boolean }): ReactNode {
  const [stored, save] = useSetting<SentenceAudioSettings>('sentenceAudio', DEFAULTS)
  const config = { ...DEFAULTS, ...stored }
  const update = (patch: Partial<SentenceAudioSettings>): void => {
    void save({ ...config, ...patch })
  }
  const status = useStatus(config.enabled)
  const text = describe(status)
  const model = useModelControls('sensevoice')
  const modelReady = model.status?.state === 'ready'
  const [removing, setRemoving] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const advancedPanel = useId()

  return (
    <SettingsSection
      title="Sentence Audio"
      description="Automatically enhance your Anki cards with real sentence audio from your system."
    >
      <SettingsRow
        label="Record and attach sentence audio"
        controlId="sentence-audio-enabled"
        description={switchDescription(config.seconds, status?.platform)}
      >
        <Switch
          id="sentence-audio-enabled"
          checked={config.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </SettingsRow>
      {config.enabled && (
        <>
          <SettingsRow
            label={
              <span className="anki-connection-label">
                <StatusDot tone={text.tone} />
                {text.title}
              </span>
            }
            description={<span role="status">{text.detail}</span>}
          >
            {status?.state === 'recording' && <LevelMeter level={status.level} />}
            {status?.state === 'noPermission' && (
              <Button size="sm" onClick={() => void requestPermission()}>
                Allow…
              </Button>
            )}
          </SettingsRow>
          {status?.last && (
            <div className="settings-note">
              <Callout tone={status.last.ok ? 'neutral' : 'warn'}>
                Last card ({new Date(status.last.at).toLocaleTimeString()}): {status.last.message}
              </Callout>
            </div>
          )}
          <SettingsRow
            label="Speech model"
            description={
              modelReady
                ? matchingLine(status)
                : "Hears what was said, so each line gets exactly its own voice: lines read by OCR, lines spoken back to back, and the word you mined. Without it, lines are placed by when they arrived. SenseVoice-Small (FunASR), run on this computer."
            }
          >
            {modelReady && canRemoveModel(model.status) && (
              <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
                Remove…
              </Button>
            )}
          </SettingsRow>
          {model.status && !modelReady && (
            <div className="settings-note">
              <ModelDownload controls={model} emphasis />
            </div>
          )}
          <RemoveModelDialog controls={model} open={removing} onOpenChange={setRemoving} />
          <SettingsRow
            label="Audio field"
            controlId="sentence-audio-field"
            description={
              popupMapping
                ? "The note field the line's audio goes in. A field mapped to (sentence audio) below is used first. A card without the field, or with it already filled, is left as it is."
                : "The note field the line's audio goes in, in the note type your dictionary adds cards with. A card without the field, or with it already filled, is left as it is."
            }
          >
            <FieldInput
              id="sentence-audio-field"
              value={config.field}
              placeholder={DEFAULTS.field}
              onSave={(field) => update({ field })}
            />
          </SettingsRow>
          <SettingsRow
            label="Word audio field"
            controlId="sentence-audio-word-field"
            description={
              popupMapping
                ? "Optional: the note field the mined word's own audio goes in, cut out of its line (needs the speech model). A field mapped to (word audio) below is used first."
                : "Optional: the note field the mined word's own audio goes in, cut out of its line (needs the speech model)."
            }
          >
            <FieldInput
              id="sentence-audio-word-field"
              value={config.wordField}
              placeholder="WordAudio"
              optional
              onSave={(wordField) => update({ wordField })}
            />
          </SettingsRow>
          <SettingsRow
            label="Clips kept"
            controlId="sentence-audio-clips"
            description="The newest lines' clips stay on this computer, to play from the Log and to add to cards made later."
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
          <SettingsRow label="Fine-tuning" controlId="sentence-audio-advanced">
            <IconButton
              id="sentence-audio-advanced"
              label={advancedOpen ? 'Hide fine-tuning' : 'Fine-tuning'}
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
                  label="Seconds kept"
                  controlId="sentence-audio-seconds"
                  description="How much of the recording is held in memory. A line is only heard while its audio is held."
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
                  label="Trim to the voice"
                  controlId="sentence-audio-trim"
                  description="For a line placed by timing: cut the clip down to the speech in it. Off keeps everything from the line's arrival to the next line's."
                >
                  <Switch
                    id="sentence-audio-trim"
                    checked={config.trim}
                    onCheckedChange={(trim) => update({ trim })}
                  />
                </SettingsRow>
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
              </div>
            </SettingsSubgroup>
          )}
        </>
      )}
    </SettingsSection>
  )
}

/** How loud the last half second was: shows the recording hears the game. */
function LevelMeter({ level }: { level: number }): ReactNode {
  return (
    <span className="sentence-audio-meter" role="meter" aria-label="Level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level}>
      <span style={{ transform: `scaleX(${Math.min(1, Math.max(0, level))})` }} />
    </span>
  )
}
