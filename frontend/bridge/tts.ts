/**
 * Text-to-speech, ADAPTED from `src/renderer/src/components/AudioPlayer.tsx`.
 * Delta: the POST goes through the Tauri HTTP plugin (the WebView origin cannot reach the TTS host
 * directly) and the blob is played through an object URL exactly as before.
 */
import { getServerUrls, type ServerMode } from '../vendor/shared-constants'
import { describeFetchError, httpFetch } from './net'

export async function speak(text: string, voiceId: string, mode: ServerMode): Promise<void> {
  const url = getServerUrls(mode).TTS
  let audioUrl: string | null = null
  try {
    const response = await httpFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voiceId })
    })
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
    const blob = await response.blob()
    audioUrl = URL.createObjectURL(blob)
    const audio = new Audio(audioUrl)
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve()
      audio.onerror = () => reject(new Error('Audio playback failed'))
      audio.play().catch(reject)
    })
  } catch (error) {
    throw new Error(describeFetchError(error, url))
  } finally {
    if (audioUrl) URL.revokeObjectURL(audioUrl)
  }
}
