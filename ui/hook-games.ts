/**
 * The Text Hooker's settings: defaults for every game (`textHookerDefaults`) and each game's own
 * (`textHookerGames`, keyed by the game's exe path, lowercased). A game's record holds what the
 * reader changed for it, which overrides the default, and what Kimochi learned about it (where its
 * text is, its session); a setting the game leaves out follows the default.
 *
 * Read by the overlay (ui/overlay.js), the main window (the source panel, Settings → Text Hooker)
 * and natively (src-tauri/src/text_hook `GameConfig`, which reads `flushMs`, `repeats`,
 * `joinLines`, `stripCodes`, `hookCodes` and `replacements`).
 */

/** How a game's repeated characters are undone: `ここここ` → `こ`. */
export type Repeats = 'auto' | 'off' | 2 | 3 | 4

/** A find-and-replace rule for one game's hooked text. */
export interface HookReplacement {
  find: string
  replace: string
  /** `find` is a regular expression rather than plain text. */
  regex?: boolean
  enabled?: boolean
}

/** The settings a game can change from the defaults. */
export interface HookSettings {
  /** Hook the game when it starts, if the Text Hooker is the Log's input. */
  autoHook: boolean
  /** How long a line may pause before it counts as finished, in ms. */
  flushMs: number
  repeats: Repeats
  /** A line the game sends a row at a time is joined back up (text_hook/clean.rs `continues`). */
  joinLines: boolean
  /** Script codes (asset and label names such as `chr00chr01`, `$fx_shake_fa`) are taken out. */
  stripCodes: boolean
  /** Speakers' names apart from what they say, on the game's nameplate (hook-match.ts). */
  speakerNames: boolean
  /** The card follows the game's text, found by OCR. */
  autoAlign: boolean
  /** The card's background opacity. */
  opacity: number
  /** The card's text size before Auto align measures it, as a fraction of the window's height. */
  textSize: number
}

export const HOOK_DEFAULTS: HookSettings = {
  autoHook: true,
  flushMs: 300,
  repeats: 'auto',
  joinLines: true,
  stripCodes: true,
  speakerNames: true,
  autoAlign: true,
  opacity: 1,
  textSize: 0.034
}

/**
 * The defaults for the language being read, as native applies them (text_hook/clean.rs
 * `GameConfig`): script codes are kept in a language that spaces its words (`Level10`, `user_name`
 * and `mp3player` are words there). A value the reader stored still wins.
 */
export function hookDefaultsFor(language: { spaces: boolean }): HookSettings {
  return language.spaces ? { ...HOOK_DEFAULTS, stripCodes: false } : HOOK_DEFAULTS
}

export const HOOK_SETTING_KEYS = Object.keys(HOOK_DEFAULTS) as (keyof HookSettings)[]

/** A text box for the card, as fractions of the game window (ui/overlay.js). */
export interface HookBox {
  x: number
  y: number
  width: number
  height?: number
}

/** One game's record. */
export interface HookGame extends Partial<Omit<HookSettings, 'textSize'>> {
  /** The exe path as the system spells it, for its icon. */
  exe?: string
  /** What the game is called when it has no session (its session's name otherwise). */
  name?: string
  /** The Log session the game's lines go to. */
  sessionId?: string
  /** When it was first and last hooked (ms since the epoch). */
  addedAt?: number
  hookedAt?: number
  /**
   * The reader's Text hooking switch for the game (under its card in the source panel): on, its
   * window is read from inside the game; off, with OCR. Left out, a game hooked before is on.
   */
  textHook?: boolean
  /** H-codes inserted each time the game is hooked. */
  hookCodes?: string[]
  replacements?: HookReplacement[]
  /** The text's size, a fraction of the window's height: Auto align's measure, or the reader's. */
  text?: number
  leading?: number
  /** Where the reader left the card. */
  box?: HookBox
  /** Where Auto align last put it. */
  ocrBox?: HookBox
  surface?: unknown
  /** The game shows speakers' names apart, and where the last one was. */
  namesApart?: boolean
  nameBox?: [number, number, number, number]
  /** The switches Auto align replaced. */
  placeWithOcr?: boolean
  ocr?: string
}

export type HookGames = Record<string, HookGame>

export const gameKey = (exe: string): string => exe.toLowerCase()

/** Whether Text hooking is on for a game: the reader's switch, else on for a game hooked before. */
export const textHookOn = (game: HookGame | null | undefined): boolean => game?.textHook ?? Boolean(game?.hookedAt)

/**
 * When the hooked line's card is over the game (`textHookerShowCard`): `always`, `hold` (only while
 * the overlay's lookup key, `overlayLookupKey`, is held, where it can be read) or `never` (lines
 * still reach the Log). Stored as true / `'hold'` / false, so a setting from before `hold` existed
 * reads as it did.
 */
export type HookCardShow = 'always' | 'hold' | 'never'

export function hookCardShow(value: unknown): HookCardShow {
  if (value === false || value === 'never') return 'never'
  if (value === 'hold') return 'hold'
  return 'always'
}

/** A game's settings: its own where it has them, the defaults elsewhere. */
export function hookSettings(
  defaults: Partial<HookSettings> | null | undefined,
  game: HookGame | null | undefined
): HookSettings {
  const base = { ...HOOK_DEFAULTS, ...(defaults ?? {}) }
  const own = game ?? {}
  const autoAlign = own.autoAlign ?? own.placeWithOcr ?? (own.ocr === 'none' ? false : undefined)
  return {
    autoHook: own.autoHook ?? base.autoHook,
    flushMs: own.flushMs ?? base.flushMs,
    repeats: own.repeats ?? base.repeats,
    joinLines: own.joinLines ?? base.joinLines,
    stripCodes: own.stripCodes ?? base.stripCodes,
    speakerNames: own.speakerNames ?? base.speakerNames,
    autoAlign: autoAlign ?? base.autoAlign,
    opacity: own.opacity ?? base.opacity,
    textSize: own.text ?? base.textSize
  }
}

/** Whether a game stores its own `key` (which may happen to equal the default). */
function stores(game: HookGame, key: keyof HookSettings): boolean {
  if (key === 'textSize') return game.text !== undefined
  if (key === 'autoAlign')
    return game.autoAlign !== undefined || game.placeWithOcr !== undefined || game.ocr !== undefined
  return game[key] !== undefined
}

/**
 * Whether a game's `key` differs from the default. A value the game stores that equals the
 * current default is not a change: there is nothing to reset it to.
 */
export function overrides(
  game: HookGame | null | undefined,
  key: keyof HookSettings,
  defaults?: Partial<HookSettings> | null
): boolean {
  if (!game || !stores(game, key)) return false
  return hookSettings(defaults, game)[key] !== hookSettings(defaults, null)[key]
}

/**
 * The game with `key` set to `value`: its own value where that differs from the default, and
 * otherwise back on the default, so it follows the default when that changes.
 */
export function withSetting<K extends keyof HookSettings>(
  game: HookGame,
  key: K,
  value: HookSettings[K],
  defaults?: Partial<HookSettings> | null
): HookGame {
  if (hookSettings(defaults, null)[key] === value) return withoutOverride(game, key)
  // A size set by hand keeps the line spacing Auto align measured.
  if (key === 'textSize') return { ...game, text: value as number }
  return { ...withoutOverride(game, key), [key]: value }
}

/** The game with `key` back on the default. */
export function withoutOverride(game: HookGame, key: keyof HookSettings): HookGame {
  const next = { ...game }
  if (key === 'textSize') {
    delete next.text
    delete next.leading
  } else if (key === 'autoAlign') {
    delete next.autoAlign
    delete next.placeWithOcr
    delete next.ocr
  } else delete next[key]
  return next
}

/** The exe's file name without its extension: a name for a game before it has one. */
export function exeTitle(exe: string): string {
  const file = exe.split(/[\\/]/).pop() ?? exe
  return file.replace(/\.exe$/i, '')
}
