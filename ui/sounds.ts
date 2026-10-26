/**
 * Sound effects for scanning: a pluck when the reader asks for a scan, a chime when lines reach
 * the Log, a buzz when a scan fails. And for the interface: one soft click for every control, and
 * a whoosh for showing and hiding the sidebar (see `controlSound`).
 *
 * Settings → General has a switch for all of them (`soundEffects`) and, under it, one for each
 * kind (`soundEffectsScans`, `soundEffectsClicks`; see `soundKindOn`). While sentence audio
 * records what the computer plays (`sentenceAudio.enabled`), none of them plays at all: they
 * would end up in the lines' clips.
 *
 * The overlay decides when; this module decides whether, and plays. Which outcome earns which
 * sound is read off the activity post the overlay already makes for it (scan-activity.ts), so the
 * ticker and the sound cannot disagree about how a scan ended.
 *
 * The automatic loop can fail on every tick (an engine that is down stays down), so its errors
 * ring at most once per `AUTO_ERROR_INTERVAL_MS`, counted from the last error sound of either
 * kind. A scan the reader asked for always answers.
 *
 * Playback is Web Audio (`createBufferPlayer`): every sound is decoded once per window, ahead of
 * its first use, and starts at its first audible sample, so it lands with the press rather than
 * a beat after. An `<audio>` element goes through the media pipeline on every play, which is
 * audibly late; it remains the fallback until the buffers are ready or where Web Audio is absent.
 */
import type { ActivityPost } from './activity.js'

export type ScanSound = 'scan-start' | 'scan-done' | 'scan-error'

/** Interface sounds, synthesized with Earshot (see ui/sounds/LICENSE.txt). */
export type InterfaceSound = 'click' | 'sidebar-show' | 'sidebar-hide'

export type SoundName = ScanSound | InterfaceSound

export const INTERFACE_SOUNDS: readonly InterfaceSound[] = ['click', 'sidebar-show', 'sidebar-hide']

/**
 * `data-sound="sound-on"` marks the control that turns sound effects back on: it clicks although
 * sound effects are off, so turning them on is heard.
 */
export const SOUND_ON = 'sound-on'

/** Which setting under `soundEffects` a sound belongs to. */
export function soundKind(name: SoundName): 'scans' | 'clicks' {
  return name === 'scan-start' || name === 'scan-done' || name === 'scan-error' ? 'scans' : 'clicks'
}

/** The sound settings, as stored; anything but an explicit `false` is on (the defaults, and a store that predates a key). */
export interface SoundSettings {
  soundEffects?: unknown
  soundEffectsScans?: unknown
  soundEffectsClicks?: unknown
  /** The `sentenceAudio` setting: while it records, no sound effect plays (`recordingAudio`). */
  sentenceAudio?: unknown
}

/** Whether sentence audio is recording what the computer plays (its setting is on). */
export function recordingAudio(sentenceAudio: unknown): boolean {
  return (sentenceAudio as { enabled?: unknown } | null | undefined)?.enabled === true
}

/** Whether a kind of sound plays: sound effects on, and that kind on under them, and sentence audio not recording. */
export function soundKindOn(settings: SoundSettings, kind: 'scans' | 'clicks'): boolean {
  if (recordingAudio(settings.sentenceAudio)) return false
  if (settings.soundEffects === false) return false
  return (kind === 'scans' ? settings.soundEffectsScans : settings.soundEffectsClicks) !== false
}

export const SOUND_NAMES: readonly SoundName[] = [
  'scan-start',
  'scan-done',
  'scan-error',
  ...INTERFACE_SOUNDS
]

/**
 * The default volume (the `soundEffectsVolume` setting, 0–1): under the system's alert level, as
 * these accompany reading and should not interrupt it.
 */
export const SOUND_VOLUME = 0.5

/** This window's sound volume, 0–1: the setting, as the window last read it (`setSoundVolume`). */
let soundVolume = SOUND_VOLUME

/** The `soundEffectsVolume` setting as a volume: 0–1, the default for anything else. */
export function volumeOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : SOUND_VOLUME
}

/** Sets the volume every later sound in this window plays at. */
export function setSoundVolume(value: unknown): void {
  soundVolume = volumeOf(value)
}

export function currentSoundVolume(): number {
  return soundVolume
}

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
  /**
   * Whether this sound may play now: the sound settings, read at each sound so a change in
   * Settings applies at once. A boolean (or anything but `false`) answers for every sound.
   */
  enabled: (name: SoundName) => unknown
  /** The `soundEffectsVolume` setting, read at each sound like `enabled`; omitted, the window's volume stays as it is. */
  volume?: () => unknown
  play?: (name: SoundName) => void
  now?: () => number
}

export type SoundPlayer = (name: SoundName | null, options?: { auto?: boolean }) => boolean

/** A player that honours the setting and the error throttle; returns whether it played. */
export function createSoundPlayer({
  enabled,
  volume,
  play = playAudio,
  now = Date.now
}: SoundPlayerOptions): SoundPlayer {
  let lastErrorAt: number | null = null
  // Decoded now, so the first sound already plays from a buffer.
  if (play === playAudio) preloadSounds()
  return (name, { auto = false } = {}) => {
    // Anything but an explicit `false` is on: the default, and a store that predates the key.
    if (!name || enabled(name) === false) return false
    if (name === 'scan-error') {
      const at = now()
      if (!errorMayRing(lastErrorAt, at, auto)) return false
      lastErrorAt = at
    }
    if (volume) setSoundVolume(volume())
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
  source: (name: SoundName) => string,
  volume: () => number = currentSoundVolume
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
        audio.preload = 'auto'
        if (pool.length < POOL_SIZE) pool.push(audio)
      }
      // At each play, so a change of the volume setting applies to the next sound.
      audio.volume = volume()
      void audio.play()?.catch(() => undefined)
      return audio
    } catch {
      // As above: no sound rather than a failed scan.
      return null
    }
  }
}

/** What a clicked control is, as far as its sound goes; read before the click changes it. */
export interface ControlFacts {
  /** `data-sound` on the control or around it: a sound name, `sound-on`, or `none` for silence. */
  explicit?: string | null
  /** Its ARIA role, or `button` / `link` for the plain elements. */
  role: string | null
  /** `aria-checked` before the click. */
  checked?: string | null
  /** What it opens (`aria-haspopup`: menu, listbox, dialog…; a select's is a listbox), if anything. */
  popup?: string | null
  /** `aria-expanded` before the click. */
  expanded?: boolean
  /** `aria-disabled="true"`: it takes the click but does nothing. */
  disabled?: boolean
}

/** A control's sound: a sound name, or `sound-on` (a click that plays with sound effects off). */
export type ControlSound = SoundName | typeof SOUND_ON

/**
 * The sound a click on a control calls for: a click, whatever the control. `data-sound` overrides
 * it, for the sidebar's whoosh, the control that turns sound back on, and controls that already
 * make a sound of their own (Scan: `none`).
 */
export function controlSound(facts: ControlFacts | null): ControlSound | null {
  if (!facts?.role || facts.disabled) return null
  if (facts.explicit) {
    return facts.explicit === SOUND_ON || (SOUND_NAMES as readonly string[]).includes(facts.explicit)
      ? (facts.explicit as ControlSound)
      : null
  }
  return 'click'
}

const CONTROLS = [
  'button',
  'a[href]',
  'summary',
  ...[
    'button',
    'link',
    'switch',
    'checkbox',
    'radio',
    'tab',
    'combobox',
    'option',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio'
  ].map((role) => `[role="${role}"]`)
].join(', ')

/** The control an event landed in, or null if it is not in one. */
export function controlOf(target: EventTarget | null): Element | null {
  const element = target as Element | null
  if (!element || typeof element.closest !== 'function') return null
  return element.closest(CONTROLS)
}

/** The facts `controlSound` needs about the control a click landed in, or null if none. */
export function readControl(target: EventTarget | null): ControlFacts | null {
  const control = controlOf(target)
  if (!control) return null
  const role = control.getAttribute('role') ?? (control.tagName.toLowerCase() === 'a' ? 'link' : 'button')
  const popup = control.getAttribute('aria-haspopup')
  return {
    explicit: (target as Element).closest('[data-sound]')?.getAttribute('data-sound'),
    role,
    checked: control.getAttribute('aria-checked'),
    popup: popup !== null && popup !== 'false' ? popup : role === 'combobox' ? 'listbox' : null,
    expanded: control.getAttribute('aria-expanded') === 'true',
    disabled:
      control.getAttribute('aria-disabled') === 'true' || control.getAttribute('disabled') !== null
  }
}

/** Keys that open a closed menu or select from its trigger (Radix's), by what it opens. */
function opensOnKey(facts: ControlFacts, key: string): boolean {
  if (key === 'Enter' || key === ' ') return true
  if (key === 'ArrowDown') return facts.popup === 'menu' || facts.role === 'combobox'
  return key === 'ArrowUp' && facts.role === 'combobox'
}

/**
 * The sound a press (pointer down, or a key) calls for, before any click. A pointer press sounds
 * every control at once, as a physical button does, instead of a beat later when it is released.
 * A key sounds only a closed menu or select trigger that opens on it (the open menu takes the
 * keys, so no click comes); other keys wait for the click they make.
 */
export function pressSound(facts: ControlFacts | null, key?: string): ControlSound | null {
  if (key === undefined) return controlSound(facts)
  if (!facts?.popup || facts.expanded) return null
  if (!opensOnKey(facts, key)) return null
  return controlSound(facts)
}

/**
 * Click sounds for every control in a window, from capturing listeners on `root`, which run before
 * the control's own handlers so a switch and a menu trigger still show their old state. A pointer
 * press sounds its control (`pressSound`), and the click that follows on the same control stays
 * quiet; a click with no press before it (Enter, Space, a script) sounds on the click. `sound-on` is the one click that plays with sound effects off: it belongs to
 * the control that turns them back on, and only it carries it (unless `silenced`: sentence audio
 * is recording). Returns the uninstaller.
 */
export function installInteractionSounds(
  root: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  {
    enabled,
    play = playAudio,
    silenced = () => false
  }: Pick<SoundPlayerOptions, 'enabled' | 'play'> & { silenced?: () => boolean }
): () => void {
  const player = createSoundPlayer({ enabled, play })
  const sound = (name: ControlSound | null): void => {
    if (name === SOUND_ON) {
      if (!silenced()) play('click')
    } else player(name)
  }
  // The trigger whose press already sounded, so its own click (a popover's, or Enter's) does not.
  let pressed: Element | null = null
  const onPress = (event: Event, key?: string): void => {
    const name = pressSound(readControl(event.target), key)
    if (!name) return
    pressed = controlOf(event.target)
    sound(name)
  }
  const onPointerDown = (event: Event): void => {
    const { button, ctrlKey } = event as PointerEvent
    if (button === 0 && !ctrlKey) onPress(event)
  }
  const onKeyDown = (event: Event): void => {
    const { key, repeat } = event as KeyboardEvent
    if (!repeat) onPress(event, key)
  }
  const onClick = (event: Event): void => {
    const control = controlOf(event.target)
    const wasPressed = control !== null && control === pressed
    pressed = null
    if (!wasPressed) sound(controlSound(readControl(event.target)))
  }
  const listeners = [
    ['pointerdown', onPointerDown],
    ['keydown', onKeyDown],
    ['click', onClick]
  ] as const
  for (const [type, listener] of listeners) root.addEventListener(type, listener, true)
  return () => {
    for (const [type, listener] of listeners) root.removeEventListener(type, listener, true)
  }
}

/** Leading samples below this share of a sound's peak (-40 dB) are skipped: inaudible lead-in. */
export const LEAD_THRESHOLD = 0.01

/**
 * Where a sound becomes audible, in samples: the first sample on any channel at or above
 * `threshold` of the loudest. That skips the encoder's priming silence (an MP3 starts with about
 * 25 ms of it, which not every decoder trims) and any quiet lead-in in the recording. A silent
 * sound starts at 0.
 */
export function leadingSilence(channels: readonly Float32Array[], threshold = LEAD_THRESHOLD): number {
  let peak = 0
  for (const samples of channels) for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  if (peak === 0) return 0
  const floor = peak * threshold
  let first = Infinity
  for (const samples of channels) {
    const limit = Math.min(first, samples.length)
    for (let i = 0; i < limit; i++) {
      if (Math.abs(samples[i]) >= floor) {
        first = i
        break
      }
    }
  }
  return Number.isFinite(first) ? first : 0
}

/** The part of the Web Audio API the buffer player uses. */
export interface AudioContextLike {
  readonly state: string
  readonly destination: unknown
  resume(): Promise<void>
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>
  createGain(): { gain: { value: number }; connect(to: unknown): unknown }
  createBufferSource(): {
    buffer: AudioBufferLike | null
    connect(to: unknown): unknown
    start(when?: number, offset?: number): void
  }
}

export interface AudioBufferLike {
  readonly numberOfChannels: number
  readonly sampleRate: number
  getChannelData(channel: number): Float32Array
}

/**
 * Plays decoded sounds through one context and gain. Each play is its own source node, so sounds
 * mix and a quick repeat never cuts the last one off. `play` returns false while a sound is not
 * decoded yet (or could not be), for the caller to fall back; `load` fetches and decodes every
 * sound once.
 */
export function createBufferPlayer(
  context: AudioContextLike,
  fetchSound: (name: SoundName) => Promise<ArrayBuffer>,
  volume: () => number = currentSoundVolume
): { load(): void; play(name: SoundName): boolean } {
  const gain = context.createGain()
  gain.gain.value = SOUND_VOLUME
  gain.connect(context.destination)
  const sounds = new Map<SoundName, { buffer: AudioBufferLike; offset: number }>()
  let loading = false
  return {
    load() {
      if (loading) return
      loading = true
      for (const name of SOUND_NAMES) {
        fetchSound(name)
          .then((data) => context.decodeAudioData(data))
          .then((buffer) => {
            const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
              buffer.getChannelData(i)
            )
            sounds.set(name, { buffer, offset: leadingSilence(channels) / buffer.sampleRate })
          })
          // Not decoded: that sound keeps the element fallback.
          .catch(() => undefined)
      }
    },
    play(name) {
      const sound = sounds.get(name)
      if (!sound) return false
      // A context made before the window's first gesture can start suspended.
      if (context.state === 'suspended') void context.resume().catch(() => undefined)
      gain.gain.value = volume()
      const source = context.createBufferSource()
      source.buffer = sound.buffer
      source.connect(gain)
      source.start(0, sound.offset)
      return true
    }
  }
}

let audioPlayer: ((name: SoundName) => AudioLike | null) | null = null
let bufferPlayer: ReturnType<typeof createBufferPlayer> | null | undefined

// Resolved from this module's own URL rather than the page's, so it finds dist/ui/sounds
// whichever page imports it; and lazily, so loading the module never touches the URL.
const soundUrl = (sound: SoundName): string => new URL(`./sounds/${sound}.mp3`, import.meta.url).href

/** This window's buffer player, made on first use; null where there is no Web Audio. */
function buffers(): ReturnType<typeof createBufferPlayer> | null {
  if (bufferPlayer !== undefined) return bufferPlayer
  bufferPlayer = null
  try {
    if (typeof AudioContext === 'undefined' || typeof fetch === 'undefined') return null
    bufferPlayer = createBufferPlayer(new AudioContext() as unknown as AudioContextLike, (name) =>
      fetch(soundUrl(name)).then((response) => {
        if (!response.ok) throw new Error(`${name}: ${response.status}`)
        return response.arrayBuffer()
      })
    )
    bufferPlayer.load()
  } catch {
    bufferPlayer = null
  }
  return bufferPlayer
}

/** Fetch and decode every sound in this window now, so none waits on its first play. */
export function preloadSounds(): void {
  buffers()
}

/** Play one sound from `ui/sounds/` in this window. */
export function playAudio(name: SoundName): void {
  try {
    if (buffers()?.play(name)) return
  } catch {
    // Fall through to the element: a sound effect is never worth an error.
  }
  if (typeof Audio === 'undefined') return
  audioPlayer ??= createAudioPlayer(Audio, soundUrl)
  audioPlayer(name)
}
