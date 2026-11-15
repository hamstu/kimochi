/* sentenceAudio.ts — the Log's side of sentence audio (src-tauri/src/sentence_audio): each line
   it adds is reported with its arrival time (and its OCR scan: a scan's lines, a name box and the
   dialogue, are decided together), and each it deletes is forgotten; the listener decides what
   each line's voice was and says so (`sentence-audio-line`), which the Log shows as a play
   button; and the pop-up's cards ask for their audio once added. Nothing is sent while the
   setting is off. */

import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getSetting, onSettingsChange } from '../../bridge/settings'
import type { SentenceAudioSettings } from '@ui/settings'
import type { Line } from './types'
import { createLineAudioPlayer } from './lineAudioPlayer'

/** What Settings → Anki shows about the recording (`sentence_audio_status`). */
export type SentenceAudioStatus = (
  | { state: 'off' }
  | { state: 'needsModel' }
  | { state: 'starting' }
  | {
      state: 'recording'
      /** What is recorded ("Speakers (Realtek Audio)", "Everything this Mac plays"). */
      source: string
      /** Kimochi's own sounds are left out of the recording. */
      excludesOwnAudio: boolean
    }
  | { state: 'noPermission'; message: string }
  /** This computer cannot record its audio now (no PipeWire, no output); tried again later. */
  | { state: 'unavailable'; message: string }
  | { state: 'unsupported'; message: string }
  | { state: 'error'; message: string }
) & {
  platform: 'macos' | 'windows' | 'linux' | string
  /** Seconds of audio held. */
  held: number
  /** Loudness of the last half second, 0..1. */
  level: number
  /** Whether lines are matched by their words: the speech model in the listener. */
  recogniser:
    | { state: 'absent' }
    /** The language being read is not one the model is used for (Japanese only for now). */
    | { state: 'otherLanguage' }
    | { state: 'loading' }
    | { state: 'ready' }
    | { state: 'failed'; message: string }
  last: { at: number; ok: boolean; message: string } | null
}

/** A line's audio, as the listener decided it (`sentence-audio-line`). */
export interface LineAudio {
  uid: string
  /** `voiced`: a clip to play. `silent`: no voice was found. `missed`: its audio was gone. */
  state: 'voiced' | 'silent' | 'missed'
  durationMs?: number
  /** `matched` (found by its words), `timed` (placed by timing) or `hooked` (the game's own clip, marked with a sparkle in the Log: LineMedia.tsx). */
  how?: 'matched' | 'timed' | 'hooked'
  message?: string
}

let enabled = false
let watching = false

function watch(): void {
  if (watching) return
  watching = true
  const apply = (value: unknown): void => {
    enabled = Boolean((value as Partial<SentenceAudioSettings> | null)?.enabled)
  }
  void getSetting<SentenceAudioSettings>('sentenceAudio').then(apply, () => {})
  onSettingsChange((key, value) => {
    if (key === 'sentenceAudio') apply(value)
  })
}

/** The Log added `line`, or changed its text (a start-merge keeps its uid and arrival). */
export function reportLine(line: Line): void {
  watch()
  if (!enabled || !line.uid) return
  invoke('sentence_audio_line', {
    uid: line.uid,
    text: line.text,
    ts: line.ts,
    source: line.source,
    scan: line.ocr?.scanId ?? null
  }).catch(() => {})
}

/** The Log deleted these lines (or a fuller reading of the same text replaced them). */
export function forgetLines(removed: readonly Line[]): void {
  watch()
  const uids = removed.flatMap((line) => (line.uid ? [line.uid] : []))
  if (!enabled || uids.length === 0) return
  invoke('sentence_audio_forget', { uids }).catch(() => {})
}

/** The pop-up added note `noteId` from `sentence` for `word`: its audio follows in the
    background, into `field` (the field mapped to (sentence audio)) or the one in Settings → Anki,
    and the word's into `wordField` (mapped to (word audio)) or the one in Settings; `reading`
    finds the word when the line spells it in kana (今日は said as こんにちは). */
export function attachSentenceAudio(
  url: string,
  noteId: number,
  sentence: string | null,
  field: string | null,
  word: string | null = null,
  wordField: string | null = null,
  reading: string | null = null
): void {
  invoke('sentence_audio_attach', {
    url,
    noteId,
    sentence,
    field,
    word,
    wordField,
    reading
  }).catch(() => {})
}

export function sentenceAudioStatus(): Promise<SentenceAudioStatus> {
  return invoke<SentenceAudioStatus>('sentence_audio_status')
}

// ---------------------------------------------------------------- the Log's line audio

const lines = new Map<string, LineAudio>()
const subscribers = new Set<() => void>()
let following = false

function set(line: LineAudio): void {
  lines.set(line.uid, line)
  for (const notify of subscribers) notify()
}

/** Follow the listener's decisions, starting from what it already knows. */
function follow(): void {
  if (following) return
  following = true
  try {
    listen<LineAudio>('sentence-audio-line', (event) => set(event.payload)).catch(() => {})
    invoke<LineAudio[]>('sentence_audio_lines').then(
      (known) => {
        // Publish the initial inventory once. A live decision received while it was loading wins.
        for (const line of known) if (!lines.has(line.uid)) lines.set(line.uid, line)
        for (const notify of subscribers) notify()
      },
      () => {}
    )
  } catch {
    // No native bridge (a plain browser): no line has audio.
  }
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => subscribers.delete(notify)
}

/** What is known about line `uid`'s audio: undefined until the listener has decided it. */
export function useLineAudio(uid: string | undefined): LineAudio | undefined {
  follow()
  return useSyncExternalStore(
    subscribe,
    () => (uid ? lines.get(uid) : undefined),
    () => undefined
  )
}

const playListeners = new Set<() => void>()
const player = createLineAudioPlayer(
  (uid) => invoke<string | null>('sentence_audio_clip', { uid }),
  (base64) => new Audio(`data:audio/mpeg;base64,${base64}`),
  () => {
    for (const notify of playListeners) notify()
  }
)

/** Play or stop a clip. A newer request cancels earlier requests, including pending fetches. */
export const toggleLineAudio = player.toggle

/** How far this clip has played, 0..1; null while it is not playing. */
export const lineProgress = player.progress

/** Whether line `uid`'s clip is playing. */
export function useLinePlaying(uid: string | undefined): boolean {
  return useSyncExternalStore(
    (notify) => {
      playListeners.add(notify)
      return () => playListeners.delete(notify)
    },
    () => player.isPlaying(uid),
    () => false
  )
}
