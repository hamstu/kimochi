/**
 * Which local engine watches the screen for Auto OCR.
 *
 * Auto OCR reads frames with a fast local engine (the watcher), waits for its text to stop
 * changing, and then lets the selected engine read the settled frame. The watcher decides what
 * the overlay keeps on screen in between, so it has to be at least as good as the reader:
 *
 *  - A local engine that can keep up (PaddleOCR, MeikiOCR, Apple Live Text, OneOCR, VOCR6,
 *    Screen AI) watches for itself. A second model would only add memory and, being worse, erase
 *    lines the reader found. The watcher setting does not apply.
 *  - VOCR6 and Screen AI watch only for themselves. VOCR6 reads only horizontal dialogue boxes,
 *    so it would miss what another engine finds; Screen AI runs in a helper process that may not
 *    be on the computer, and is no faster than the engines below.
 *  - An online engine, or Manga OCR (too slow to watch), gets the best watcher this machine has:
 *    PaddleOCR on a graphics card, then the engine built into the OS (Live Text, OneOCR), then
 *    PaddleOCR on the CPU, then MeikiOCR. Only engines that are already here count: choosing a
 *    watcher never starts a download.
 *  - With none of those (a new Linux install), image comparison: a change of picture rather
 *    than of text, which a moving background also trips, but which needs nothing installed.
 *
 * A watcher the user picked in Settings is used whenever it is available here.
 *
 * Every choice is for the language being read (`language`, Japanese unless given): an engine whose
 * capability does not list it is passed over, and MeikiOCR, trained on Japanese, is the last
 * fallback only for Japanese.
 */
import { engineReadsLanguage, type OcrEngineCapability, type OcrEngineKey } from './capabilities.js'
import { DEFAULT_LANGUAGE, isJapanese } from './languages.js'

/** The engines that can watch for any reader, and that Settings offers as the watcher. */
export type WatcherEngine = 'ppocr' | 'livetext' | 'oneocr' | 'meikiocr'
/** The engines that watch only when they are the reader. */
export type SelfWatcherEngine = 'vocr' | 'screenai'
/** Every engine `capture_frame`'s `observerEngine` can name. */
export type ObserverEngine = WatcherEngine | SelfWatcherEngine
/** The Settings choice: automatic, one engine, or image comparison. */
export type WatcherChoice = 'auto' | WatcherEngine | 'image'

export type Watcher =
  | { kind: 'text'; engine: ObserverEngine; because: 'selected' | 'chosen' | 'best' }
  | { kind: 'image'; because: 'chosen' | 'none' }

export const WATCHER_ENGINES: readonly WatcherEngine[] = ['ppocr', 'livetext', 'oneocr', 'meikiocr']
export const SELF_WATCHER_ENGINES: readonly SelfWatcherEngine[] = ['vocr', 'screenai']

type Engines = Partial<Record<OcrEngineKey, OcrEngineCapability>>

const isWatcherEngine = (key: string): key is WatcherEngine => (WATCHER_ENGINES as readonly string[]).includes(key)

const watchesItself = (key: string): key is ObserverEngine =>
  isWatcherEngine(key) || (SELF_WATCHER_ENGINES as readonly string[]).includes(key)

/** Here, and able to read the language. */
const available = (engines: Engines, key: ObserverEngine, language: string = DEFAULT_LANGUAGE): boolean =>
  engines[key]?.available === true &&
  engineReadsLanguage(engines[key], language) &&
  (key !== 'meikiocr' || isJapanese(language))

/** Whether a watcher engine is here and reads the language: what Settings offers to pick. */
export const watcherOffered = (engines: Engines, engine: WatcherEngine, language: string = DEFAULT_LANGUAGE): boolean =>
  available(engines, engine, language)

/** PaddleOCR on an accelerator: fast enough to watch at full cadence. */
const paddleOnGpu = (engines: Engines, language: string): boolean =>
  available(engines, 'ppocr', language) && !!engines.ppocr?.accelerator && engines.ppocr.accelerator !== 'cpu'

/** The best watcher here for the language, in the order the module docs give. */
export function bestWatcher(engines: Engines, language: string = DEFAULT_LANGUAGE): WatcherEngine | null {
  if (paddleOnGpu(engines, language)) return 'ppocr'
  for (const engine of ['livetext', 'oneocr', 'ppocr', 'meikiocr'] as const) {
    if (available(engines, engine, language)) return engine
  }
  return null
}

/** The watcher for `ocrMode` on a machine with `engines`, honouring the Settings `choice`. */
export function resolveWatcher(
  ocrMode: string,
  engines: Engines,
  choice: WatcherChoice = 'auto',
  language: string = DEFAULT_LANGUAGE
): Watcher {
  if (watchesItself(ocrMode) && available(engines, ocrMode, language)) {
    return { kind: 'text', engine: ocrMode, because: 'selected' }
  }
  if (choice === 'image') return { kind: 'image', because: 'chosen' }
  if (choice !== 'auto' && isWatcherEngine(choice) && available(engines, choice, language)) {
    return { kind: 'text', engine: choice, because: 'chosen' }
  }
  const best = bestWatcher(engines, language)
  return best ? { kind: 'text', engine: best, because: 'best' } : { kind: 'image', because: 'none' }
}

/** Whether the Settings choice matters for `ocrMode` (it does not when the engine watches itself). */
export function watcherChoiceApplies(ocrMode: string, engines: Engines, language: string = DEFAULT_LANGUAGE): boolean {
  return resolveWatcher(ocrMode, engines, 'auto', language).because !== 'selected'
}

/** The overlay's `observerMode` for a watcher: image comparison, or reading text. */
export function observerModeOf(watcher: Watcher): 'text' | 'image' {
  return watcher.kind === 'image' ? 'image' : 'text'
}
