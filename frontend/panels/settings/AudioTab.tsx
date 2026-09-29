/** Settings → Audio: the text-to-speech voice. */
import type { ReactNode } from 'react'
import { Select, SettingsPage, SettingsRow, SettingsSection } from '@kit'
import type { AudioSettings } from '../../vendor/shared-types'
import { DEFAULT_VOICE_ID } from '../../vendor/shared-constants'
import { AVAILABLE_VOICES } from '../../vendor/voices'
import { useSetting } from '../../bridge/useSetting'

const VOICE_OPTIONS = AVAILABLE_VOICES.map((voice) => ({ value: voice.id, label: voice.name }))

export function AudioTab(): ReactNode {
  const [audioSettings, setAudioSettings] = useSetting<AudioSettings>('audioSettings', {
    voiceId: DEFAULT_VOICE_ID
  })

  return (
    <SettingsPage title="Audio" description="How lines are read aloud.">
      <SettingsSection>
        <SettingsRow label="Text-to-speech voice" description="The voice used for text-to-speech playback.">
          <Select
            aria-label="Text-to-speech voice"
            value={audioSettings.voiceId}
            onValueChange={(voiceId) => void setAudioSettings({ ...audioSettings, voiceId })}
            options={VOICE_OPTIONS}
          />
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  )
}
