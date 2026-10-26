/**
 * Settings → Anki → Sentence audio: recording what this computer plays, so each new card gets the
 * audio of the line it was mined from (src-tauri/src/sentence_audio). For every engine that adds
 * cards: the dictionary extensions' cards through the AnkiConnect relay, the Yomitan API pop-up's
 * through `sentence_audio_attach`. `sentenceAudio` is this computer's setting, never synced.
 *
 * While it is on, the recording state is read every second (`sentence_audio_status`), with a
 * level meter, so a user can see it hears the game before mining. What it can do differs by OS
 * (the status's `platform`): macOS needs Screen Recording; Windows leaves Kimochi's sounds out
 * from 10 2004 on; Linux needs PipeWire and records Kimochi's sounds too.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Callout, Input, SettingsRow, SettingsSection, StatusDot, Switch, type Tone } from '@kit'
import { SETTINGS_DEFAULTS, type SentenceAudioSettings } from '@ui/settings'
import { sentenceAudioStatus, type SentenceAudioStatus } from '@texthooker/lib/sentenceAudio'
import { useSetting } from '../../bridge/useSetting'
import { requestPermission } from '../../bridge/tauri'
import { NumberField } from './fields'

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

export function SentenceAudioSection({ popupMapping }: { popupMapping: boolean }): ReactNode {
  const [stored, save] = useSetting<SentenceAudioSettings>('sentenceAudio', DEFAULTS)
  const config = { ...DEFAULTS, ...stored }
  const update = (patch: Partial<SentenceAudioSettings>): void => {
    void save({ ...config, ...patch })
  }
  const status = useStatus(config.enabled)
  const text = describe(status)
  const [fieldDraft, setFieldDraft] = useState(config.field)
  const [seenField, setSeenField] = useState(config.field)
  if (seenField !== config.field) {
    setSeenField(config.field)
    setFieldDraft(config.field)
  }
  const saveField = (value: string): void => {
    const field = value.trim()
    if (field && field !== config.field) update({ field })
    else setFieldDraft(config.field)
  }

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
            label="Audio field"
            controlId="sentence-audio-field"
            description={
              popupMapping
                ? 'The note field the audio goes in. A field mapped to (sentence audio) below is used first. A card without the field, or with it already filled, is left as it is.'
                : 'The note field the audio goes in, in the note type your dictionary adds cards with. A card without the field, or with it already filled, is left as it is.'
            }
          >
            <Input
              id="sentence-audio-field"
              mono
              className="settings-field"
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={(e) => saveField(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveField(e.currentTarget.value)
              }}
              placeholder={DEFAULTS.field}
            />
          </SettingsRow>
          <SettingsRow
            label="Seconds kept"
            controlId="sentence-audio-seconds"
            description="A card gets audio only for a line that arrived within this time."
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
            description="Cuts the clip down to the speech in it. Off keeps everything from the line's arrival to the next line's."
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
            description="Milliseconds added to the clip's start. Negative starts it earlier."
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
            description="Milliseconds added to the clip's end. Negative ends it earlier."
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
