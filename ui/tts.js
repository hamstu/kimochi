/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Text to speech, ported from src/renderer/src/components/AudioPlayer.tsx.
 *
 * The request goes out through the host's remote-fetch adapter when one is
 * installed. Inside the overlay that means tauri-plugin-http, which performs the
 * request in Rust and so sidesteps CORS entirely — but it also means the TTS
 * host has to be in the app's HTTP capability scope, and a scope rejection is
 * reported as such rather than as a generic network failure.
 */

import { serverUrls, DEFAULT_VOICE_ID } from './settings.js'

export { DEFAULT_VOICE_ID }

let playing = null

function request(url, init) {
  const remote = globalThis.__extensionHost?.fetchRemote
  return remote ? remote(url, init) : fetch(url, init)
}

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
  const { tts } = serverUrls(settings?.serverSettings?.mode ?? 'cloud')

  const response = await request(tts, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: trimmed, voiceId })
  })
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? `Text to speech was refused (HTTP 403). Check that ${tts} is in the app's HTTP capability scope.`
        : `Text to speech failed (HTTP ${response.status})`
    )
  }

  stop()
  const url = URL.createObjectURL(await response.blob())
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
