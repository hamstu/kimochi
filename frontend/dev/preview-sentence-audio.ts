/**
 * DEV-ONLY: sentence audio's commands for the browser preview (`preview-setup.ts`).
 *
 *   ?sentenceAudio=1   the Log's newest lines have voices (one "no voice"), and Settings → Anki
 *                      shows the recording with the speech model loaded. Otherwise no line has
 *                      audio, so the site's demo and screenshots are unchanged.
 *
 * Clips are a short tone, so the play button can be tried.
 */
import { snapshotLines } from '@texthooker/core/store'

const ON = new URLSearchParams(location.search).get('sentenceAudio') === '1'

/** A quarter second of a quiet 440 Hz tone, as a base64 WAV. */
function tone(): string {
  const rate = 16_000
  const samples = rate / 4
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, s: string): void => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++) {
    view.setInt16(44 + i * 2, Math.sin((i * 440 * 2 * Math.PI) / rate) * 3000, true)
  }
  return btoa(String.fromCharCode(...bytes))
}

export const SENTENCE_AUDIO_HANDLERS: Record<string, (args: Record<string, unknown> | undefined) => unknown> = {
  sentence_audio_status: () => ({
    state: ON ? 'recording' : 'off',
    source: 'Everything this Mac plays',
    excludesOwnAudio: true,
    platform: 'macos',
    held: ON ? 30 : 0,
    level: ON ? 0.35 : 0,
    recogniser: { state: ON ? 'ready' : 'absent' },
    last: null
  }),
  sentence_audio_line: () => null,
  sentence_audio_lines: () =>
    ON
      ? snapshotLines()
          .slice(-6)
          .filter((line) => line.uid)
          .map((line, i) => ({
            uid: line.uid,
            state: i === 3 ? 'silent' : 'voiced',
            durationMs: 1800 + line.text.length * 110,
            how: 'matched'
          }))
      : [],
  sentence_audio_clip: () => (ON ? tone() : null),
  sentence_audio_attach: () => null
}
