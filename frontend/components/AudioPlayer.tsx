/**
 * ADAPTED from `src/renderer/src/components/AudioPlayer.tsx`.
 *
 * Deltas:
 *  - the TTS POST goes through Rust (`bridge/tts.ts` → `tts_speak`), which holds the Kimochi
 *    account token; when signed out (`cloudAccess` false) the button is not rendered at all;
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
import type { AudioSettings } from '../bridge/types'
import { DEFAULT_VOICE_ID } from '../bridge/settings'
import { useSetting } from '../bridge/useSetting'
import { speak } from '../bridge/tts'
import { useCapabilities } from '../bridge/capabilities'

interface AudioPlayerProps {
  text: string
  disabled?: boolean
  onPlay?: (voiceId: string) => void
}

export function AudioPlayer({ text, disabled = false, onPlay }: AudioPlayerProps): JSX.Element | null {
  const { cloudAccess } = useCapabilities()
  const [isPlaying, setIsPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [audioSettings] = useSetting<AudioSettings>('audioSettings', { voiceId: DEFAULT_VOICE_ID })

  const playAudio = async (selectedVoiceId: string): Promise<void> => {
    if (!text || isPlaying) return
    setIsPlaying(true)
    setError(null)
    onPlay?.(selectedVoiceId)
    try {
      await speak(text, selectedVoiceId)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      console.error('TTS failed:', message)
      setError(message)
    } finally {
      setIsPlaying(false)
    }
  }

  const isDisabled = disabled || isPlaying
  // Text to speech runs on Kimochi cloud, which needs a signed-in Kimochi account.
  if (!cloudAccess) return null

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
