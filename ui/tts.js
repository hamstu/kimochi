/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Text to speech, ported from src/renderer/src/components/AudioPlayer.tsx.
 *
 * The request is made in Rust (`tts_speak`), which holds the Kimochi account
 * token and never hands it to this window. When signed out the command refuses before sending
 * anything, and callers check `cloudAccess` first.
 */

import { DEFAULT_VOICE_ID } from './settings.js'
import { ttsSpeak } from './native.js'

export { DEFAULT_VOICE_ID }

let playing = null

export function isSpeaking() {
  return playing !== null
}

/** Stop whatever is playing; a new scan should not talk over the previous one. */
export function stop() {
  if (!playing) return
  playing.audio.pause()
  URL.revokeObjectURL(playing.url)
  playing = null
}

/**
 * Speak `text`, replacing anything already playing.
 *
 * Resolves when playback starts, not when it finishes, so a caller can keep
 * scanning while audio plays.
 */
export async function speak(text, settings) {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return false

  const voiceId = settings?.audioSettings?.voiceId ?? DEFAULT_VOICE_ID
  const bytes = await ttsSpeak(trimmed, voiceId)

  stop()
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
  const audio = new Audio(url)
  playing = { audio, url }
  const release = () => {
    if (playing?.audio === audio) {
      URL.revokeObjectURL(url)
      playing = null
    }
  }
  audio.onended = release
  audio.onerror = release
  await audio.play()
  return true
}
