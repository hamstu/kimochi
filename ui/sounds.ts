/**
 * Sound effects for scanning: a pluck when the reader asks for a scan, a chime when lines reach
 * the Log, a buzz when a scan fails.
 *
 * The overlay decides when; this module decides whether, and plays. Which outcome earns which
 * sound is read off the activity post the overlay already makes for it (scan-activity.ts), so the
 * ticker and the sound cannot disagree about how a scan ended.
 *
 * The automatic loop can fail on every tick (an engine that is down stays down), so its errors
 * ring at most once per `AUTO_ERROR_INTERVAL_MS`, counted from the last error sound of either
 * kind. A scan the reader asked for always answers.
 */
import type { ActivityPost } from './activity.js'

export type SoundName = 'scan-start' | 'scan-done' | 'scan-error'

export const SOUND_NAMES: readonly SoundName[] = ['scan-start', 'scan-done', 'scan-error']

/** Under the system's alert level: these accompany reading, they should not interrupt it. */
export const SOUND_VOLUME = 0.5

export const AUTO_ERROR_INTERVAL_MS = 10_000

/**
 * Outcomes that are not failures although the ticker marks them `warn`: a discarded scan was
 * overtaken by something the reader did, and an empty reading is an answer, not an error.
 */
const QUIET_WARNINGS = /^(Scan discarded|Nothing recognised)/

/**
 * The automatic loop with no source chosen is idle, not failing; the reader pressing scan with
 * none chosen did ask for something, and hears that it could not be done.
 */
const NO_SOURCE = /^Choose a source/

/** The sound a scan's outcome post calls for, or null for an outcome that should pass quietly. */
export function outcomeSound(
  post: ActivityPost | null | undefined,
  { auto = false } = {}
): SoundName | null {
  if (!post) return null
  if (post.tone === 'ok') return 'scan-done'
  if (post.tone === 'error') return 'scan-error'
  if (post.tone !== 'warn' || QUIET_WARNINGS.test(post.text)) return null
  return auto && NO_SOURCE.test(post.text) ? null : 'scan-error'
}

/**
 * Whether an error sound may ring now. `lastErrorAt` is when the previous one rang (null if none
 * has); only the automatic loop's errors are held back.
 */
export function errorMayRing(
  lastErrorAt: number | null,
  now: number,
  auto: boolean,
  interval = AUTO_ERROR_INTERVAL_MS
): boolean {
  return !auto || lastErrorAt === null || now - lastErrorAt >= interval
}

export interface SoundPlayerOptions {
  /** The `soundEffects` setting, read at each sound so a change in Settings applies at once. */
  enabled: () => unknown
  play?: (name: SoundName) => void
  now?: () => number
}

export type SoundPlayer = (name: SoundName | null, options?: { auto?: boolean }) => boolean

/** A player that honours the setting and the error throttle; returns whether it played. */
export function createSoundPlayer({
  enabled,
  play = playAudio,
  now = Date.now
}: SoundPlayerOptions): SoundPlayer {
  let lastErrorAt: number | null = null
  return (name, { auto = false } = {}) => {
    // Anything but an explicit `false` is on: the default, and a store that predates the key.
    if (!name || enabled() === false) return false
    if (name === 'scan-error') {
      const at = now()
      if (!errorMayRing(lastErrorAt, at, auto)) return false
      lastErrorAt = at
    }
    play(name)
    return true
  }
}

/** The part of `HTMLAudioElement` playback uses, so tests can stand in for it. */
export interface AudioLike {
  volume: number
  preload: string
  readonly ended: boolean
  play(): Promise<void> | undefined
}

export type AudioConstructor = new (src: string) => AudioLike

/** Idle elements kept per sound; past this a burst still plays, on elements that are not kept. */
export const POOL_SIZE = 3

/**
 * Plays sounds so that none ever cuts another off: two sounds mix, and so does a quick repeat
 * of one, which is what lets each reverb tail finish. Nothing is paused or rewound; a play takes
 * an element that has finished, or a new one. A refused play() (autoplay policy, no output
 * device) is dropped: a sound effect is never worth an error.
 */
export function createAudioPlayer(
  AudioCtor: AudioConstructor,
  source: (name: SoundName) => string
): (name: SoundName) => AudioLike | null {
  const pools = new Map<SoundName, AudioLike[]>()
  return (name) => {
    try {
      const pool = pools.get(name) ?? []
      pools.set(name, pool)
      // An ended element is at its end, not mid-tail; play() starts it again from the top.
      let audio = pool.find((candidate) => candidate.ended) ?? null
      if (!audio) {
        audio = new AudioCtor(source(name))
        // Modest, so two overlapping sounds (a start and a quick result) stay clear of clipping.
        audio.volume = SOUND_VOLUME
        audio.preload = 'auto'
        if (pool.length < POOL_SIZE) pool.push(audio)
      }
      void audio.play()?.catch(() => undefined)
      return audio
    } catch {
      // As above: no sound rather than a failed scan.
      return null
    }
  }
}

let audioPlayer: ((name: SoundName) => AudioLike | null) | null = null

/** Play one sound from `ui/sounds/` in this window. */
export function playAudio(name: SoundName): void {
  if (typeof Audio === 'undefined') return
  // Resolved from this module's own URL rather than the page's, so it finds dist/ui/sounds
  // whichever page imports it; and lazily, so loading the module never touches the URL.
  audioPlayer ??= createAudioPlayer(
    Audio,
    (sound) => new URL(`./sounds/${sound}.mp3`, import.meta.url).href
  )
  audioPlayer(name)
}
