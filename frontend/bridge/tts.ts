/**
 * Text-to-speech, ADAPTED from `src/renderer/src/components/AudioPlayer.tsx`.
 * Delta: the POST happens in Rust (`tts_speak`), which holds the Kimochi account token and never
 * hands it to the webview; the returned audio is played through an object URL exactly as before.
 * When signed out the command refuses before sending anything, and the UI hides read-aloud
 * (`cloudAccess` in the platform capabilities).
 */
import { nativeError, ttsSpeak } from './tauri'

export async function speak(text: string, voiceId: string): Promise<void> {
  let audioUrl: string | null = null
  try {
    const audio = await ttsSpeak(text, voiceId)
    audioUrl = URL.createObjectURL(new Blob([audio], { type: 'audio/mpeg' }))
    const player = new Audio(audioUrl)
    await new Promise<void>((resolve, reject) => {
      player.onended = () => resolve()
      player.onerror = () => reject(new Error('Audio playback failed'))
      player.play().catch(reject)
    })
  } catch (error) {
    throw new Error(nativeError(error).message)
  } finally {
    if (audioUrl) URL.revokeObjectURL(audioUrl)
  }
}
