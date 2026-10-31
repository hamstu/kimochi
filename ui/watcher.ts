/**
 * Which local engine watches the screen for Auto OCR.
 *
 * Auto OCR reads frames with a fast local engine (the watcher), waits for its text to stop
 * changing, and then lets the selected engine read the settled frame. The watcher decides what
 * the overlay keeps on screen in between, so it has to be at least as good as the reader:
 *
 *  - A local engine that can keep up (PaddleOCR, MeikiOCR, Apple Live Text, OneOCR) watches for
 *    itself. A second model would only add memory and, being worse, erase lines the reader
 *    found. The watcher setting does not apply.
 *  - An online engine, or Manga OCR (too slow to watch), gets the best watcher this machine has:
 *    PaddleOCR on a graphics card, then the engine built into the OS (Live Text, OneOCR), then
 *    PaddleOCR on the CPU, then MeikiOCR. Only engines that are already here count: choosing a
 *    watcher never starts a download.
 *  - With none of those (a new Linux install), image comparison: a change of picture rather
 *    than of text, which a moving background also trips, but which needs nothing installed.
 *
 * A watcher the user picked in Settings is used whenever it is available here.
 */
import type { OcrEngineCapability, OcrEngineKey } from './capabilities.js'

/** The engines that can watch, as `capture_frame`'s `observerEngine` names them. */
export type WatcherEngine = 'ppocr' | 'livetext' | 'oneocr' | 'meikiocr'
/** The Settings choice: automatic, one engine, or image comparison. */
export type WatcherChoice = 'auto' | WatcherEngine | 'image'

export type Watcher =
  | { kind: 'text'; engine: WatcherEngine; because: 'selected' | 'chosen' | 'best' }
  | { kind: 'image'; because: 'chosen' | 'none' }

export const WATCHER_ENGINES: readonly WatcherEngine[] = ['ppocr', 'livetext', 'oneocr', 'meikiocr']

type Engines = Partial<Record<OcrEngineKey, OcrEngineCapability>>

const isWatcherEngine = (key: string): key is WatcherEngine =>
  (WATCHER_ENGINES as readonly string[]).includes(key)

const available = (engines: Engines, key: WatcherEngine): boolean => engines[key]?.available === true

/** PaddleOCR on an accelerator: fast enough to watch at full cadence. */
const paddleOnGpu = (engines: Engines): boolean =>
  available(engines, 'ppocr') && !!engines.ppocr?.accelerator && engines.ppocr.accelerator !== 'cpu'

/** The best watcher here, in the order the module docs give. */
export function bestWatcher(engines: Engines): WatcherEngine | null {
  if (paddleOnGpu(engines)) return 'ppocr'
  for (const engine of ['livetext', 'oneocr', 'ppocr', 'meikiocr'] as const) {
    if (available(engines, engine)) return engine
  }
  return null
}

/** The watcher for `ocrMode` on a machine with `engines`, honouring the Settings `choice`. */
export function resolveWatcher(
  ocrMode: string,
  engines: Engines,
  choice: WatcherChoice = 'auto'
): Watcher {
  if (isWatcherEngine(ocrMode) && available(engines, ocrMode)) {
    return { kind: 'text', engine: ocrMode, because: 'selected' }
  }
  if (choice === 'image') return { kind: 'image', because: 'chosen' }
  if (choice !== 'auto' && isWatcherEngine(choice) && available(engines, choice)) {
    return { kind: 'text', engine: choice, because: 'chosen' }
  }
  const best = bestWatcher(engines)
  return best ? { kind: 'text', engine: best, because: 'best' } : { kind: 'image', because: 'none' }
}

/** Whether the Settings choice matters for `ocrMode` (it does not when the engine watches itself). */
export function watcherChoiceApplies(ocrMode: string, engines: Engines): boolean {
  return resolveWatcher(ocrMode, engines).because !== 'selected'
}

/** The overlay's `observerMode` for a watcher: image comparison, or reading text. */
export function observerModeOf(watcher: Watcher): 'text' | 'image' {
  return watcher.kind === 'image' ? 'image' : 'text'
}
