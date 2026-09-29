/**
 * ADAPTED from `src/renderer/src/components/AudioPlayer.tsx`.
 *
 * Deltas:
 *  - the TTS POST goes through the bridge (`bridge/tts.ts`), because the WebView origin cannot
 *    reach the TTS host directly;
 *  - failures now surface in the button's tooltip instead of only reaching the console, since a
 *    silent speaker button is indistinguishable from a broken one;
 *  - the `window.playAudio` global is gone: the `playAudio` hotkey is handled by the overlay
 *    against the newest history entry, exactly as Electron's hidden AudioPlayer did.
 *
 * The icon, variant, disabled behaviour and tooltip are unchanged; the button is now the kit's
 * small ghost icon button (it was Radix Themes' size-1 ghost IconButton).
 */
import { useState, type JSX } from 'react'
import { IconButton, Tooltip } from '@kit'
import { Volume2 } from 'lucide-react'
import { DEFAULT_SERVER_MODE } from '../vendor/shared-constants'
import type { AudioSettings, ServerSettings } from '../bridge/types'
import { DEFAULT_VOICE_ID } from '../bridge/settings'
import { useSetting } from '../bridge/useSetting'
import { speak } from '../bridge/tts'

interface AudioPlayerProps {
  text: string
  disabled?: boolean
  onPlay?: (voiceId: string) => void
}

export function AudioPlayer({ text, disabled = false, onPlay }: AudioPlayerProps): JSX.Element {
  const [isPlaying, setIsPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [audioSettings] = useSetting<AudioSettings>('audioSettings', { voiceId: DEFAULT_VOICE_ID })
  const [serverSettings] = useSetting<ServerSettings>('serverSettings', {
    mode: DEFAULT_SERVER_MODE
  })

  const playAudio = async (selectedVoiceId: string): Promise<void> => {
    if (!text || isPlaying) return
    setIsPlaying(true)
    setError(null)
    onPlay?.(selectedVoiceId)
    try {
      await speak(text, selectedVoiceId, serverSettings.mode)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      console.error('TTS failed:', message)
      setError(message)
    } finally {
      setIsPlaying(false)
    }
  }

  const isDisabled = disabled || isPlaying

  return (
    <Tooltip content={error ? `Play audio failed: ${error}` : 'Play audio'}>
      <IconButton
        size="sm"
        label="Play audio"
        title={undefined}
        disabled={isDisabled}
        style={error ? { color: 'var(--k-danger-text)' } : undefined}
        onClick={() => {
          if (!isDisabled) void playAudio(audioSettings.voiceId)
        }}
      >
        <Volume2 />
      </IconButton>
    </Tooltip>
  )
}

export default AudioPlayer
