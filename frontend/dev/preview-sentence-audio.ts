/**
 * DEV-ONLY: sentence audio's commands for the browser preview (`preview-setup.ts`).
 *
 * The demo's spoken lines always have their voices (demo-voices.ts: real speech, to play in the
 * studio and the site's demo); `?sentenceAudio=0` leaves every line without.
 *
 *   ?sentenceAudio=1   also the Log's other newest lines have voices (one has none, as a short
 *                      tone), Settings → Anki shows the recording with the speech model loaded,
 *                      and Diagnostics → Sentence audio the listener's view of them.
 */
import { snapshotLines } from '@texthooker/core/store'
import { demoVoice } from './demo-voices'

const FLAG = new URLSearchParams(location.search).get('sentenceAudio')
const ON = FLAG === '1'
const VOICES = FLAG !== '0'

/** Bytes of a 64 kbps MP3 per millisecond. */
const MP3_BYTES_PER_MS = 8
const durations = new Map<string, number>()

/** A demo voice's length, from its size (fetched once). */
async function voiceMs(url: string): Promise<number> {
  if (!durations.has(url)) {
    const bytes = await fetch(url).then((r) => r.arrayBuffer(), () => null)
    durations.set(url, bytes ? bytes.byteLength / MP3_BYTES_PER_MS : 2000)
  }
  return durations.get(url)!
}

async function base64Of(url: string): Promise<string> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

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

const status = () => ({
    state: ON ? 'recording' : 'off',
    source: 'Everything this Mac plays',
    excludesOwnAudio: true,
    platform: 'macos',
    held: ON ? 30 : 0,
    level: ON ? 0.35 : 0,
    recogniser: { state: ON ? 'ready' : 'absent' },
    last: null
  })

/** The listener's view of a few lines (a scan with a name box among them), as
    `sentence_audio_debug` gives it. */
function debug(): unknown {
  if (!ON) return { status: status(), clips: 0, listener: null }
  const now = Date.now()
  const line = (
    uid: string,
    text: string,
    ago: number,
    outcome: string,
    note: string,
    extra: Record<string, unknown> = {}
  ) => ({
    uid, text, ts: now - ago, appeared: null, scan: null, outcome, how: null, score: null, heard: null,
    clip: null, provisional: false, window: null, decidedAt: now - ago + 2000, changes: 1, note, ...extra
  })
  const matched = (ago: number, heard: string, score: number, from: number, to: number) => ({
    how: 'matched', score, heard, clip: [now - ago - from, now - ago + to]
  })
  const lines = [
    line('a6', 'フリッツ先生、このお店ですか？', 2_000, 'waiting', 'waiting: speech is under way', { scan: 's3' }),
    line('a5', 'シーア', 2_000, 'waiting', 'waiting: speech is under way', { scan: 's3' }),
    line('a4', 'うん。地図を描いてもらったからここで間違いないはずだよ。', 14_000, 'voiced',
      'matched 94% by its words: heard “うん地図を描いてもらったからここで間違いないはずだよ”',
      { scan: 's2', ...matched(14_000, 'うん地図を描いてもらったからここで間違いないはずだよ', 0.94, 6_100, 400) }),
    line('a3', 'フリッツ', 14_000, 'silent', 'a name box: never voiced', { scan: 's2' }),
    line('a2', '……っ', 24_000, 'silent', 'no match in “あ”', { changes: 2 }),
    line('a1', 'はいっ！', 31_000, 'voiced', 'matched 100% by its words: heard “はい”',
      matched(31_000, 'はい', 1, 1_900, 300))
  ]
  return {
    status: status(),
    clips: 5,
    listener: {
      heardUntil: now - 120,
      transcribedUntil: now - 1_400,
      speaking: true,
      speechDetection: true,
      recogniser: true,
      lines,
      heard: [
        { startMs: now - 33_000, endMs: now - 30_500, text: 'はい' },
        { startMs: now - 25_000, endMs: now - 23_800, text: 'あ' },
        { startMs: now - 20_200, endMs: now - 13_600, text: 'うん地図を描いてもらったからここで間違いないはずだよ' }
      ]
    }
  }
}

export const SENTENCE_AUDIO_HANDLERS: Record<string, (args: Record<string, unknown> | undefined) => unknown> = {
  sentence_audio_status: status,
  sentence_audio_debug: debug,
  sentence_audio_forget: () => null,
  sentence_audio_line: () => null,
  sentence_audio_lines: async () => {
    const lines = snapshotLines().filter((line) => line.uid)
    const voiced = VOICES
      ? await Promise.all(
          lines.flatMap((line) => {
            const url = demoVoice(line.text)
            return url
              ? [voiceMs(url).then((durationMs) => ({ uid: line.uid, state: 'voiced', durationMs, how: 'matched' }))]
              : []
          })
        )
      : []
    const toned = ON
      ? lines
          .slice(-6)
          .filter((line) => !demoVoice(line.text))
          .map((line, i) => ({
            uid: line.uid,
            state: i === 3 ? 'silent' : 'voiced',
            durationMs: 1800 + line.text.length * 110,
            how: 'matched'
          }))
      : []
    return [...voiced, ...toned]
  },
  sentence_audio_clip: async (args) => {
    const line = snapshotLines().find((l) => l.uid === args?.uid)
    const url = VOICES && line ? demoVoice(line.text) : undefined
    if (url) return base64Of(url)
    return ON ? tone() : null
  },
  sentence_audio_attach: () => null
}

/** The site's demo added `text` (scan `scan`) to the Log: once it is there, its voice (when it is
    a spoken line) and its screenshot are announced, as native would. */
export function demoLineAdded(
  text: string,
  scan: string,
  emit: (event: string, payload: unknown) => unknown,
  shot: ((scan: string, at: number, texts: string[]) => unknown) | null
): void {
  const announce = async (tries: number): Promise<void> => {
    const line = snapshotLines().find((l) => l.text === text && l.ocr?.scanId === scan)
    if (!line?.uid) {
      if (tries > 0) setTimeout(() => void announce(tries - 1), 150)
      return
    }
    if (shot) void emit('screenshot-added', shot(scan, line.ts, [text]))
    const url = VOICES ? demoVoice(text) : undefined
    if (url) void emit('sentence-audio-line', { uid: line.uid, state: 'voiced', durationMs: await voiceMs(url), how: 'matched' })
  }
  setTimeout(() => void announce(20), 150)
}
