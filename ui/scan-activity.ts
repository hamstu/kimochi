/**
 * What the activity feed says about a scan, as pure functions of what the pipeline already knows.
 *
 * The overlay's scan path posts at its stage boundaries (triggered, captured, published or
 * failed) and the wording lives here so it can be tested without a window. Every scan message
 * carries the key `scan`, so "Scanning…" is always settled by its own outcome; see activity.ts.
 */
import type { ActivityPost } from './activity.js'
import { OCR_MODES, type OcrMode } from './settings.js'

export const SCAN_KEY = 'scan'

/** The engine's name as the settings show it; the retired `local` is MeikiOCR. */
export function engineName(mode: unknown): string {
  const key = mode === 'local' ? 'meikiocr' : mode
  return OCR_MODES[key as OcrMode]?.name ?? 'the OCR engine'
}

const scan = (text: string, tone: ActivityPost['tone']): ActivityPost => ({ text, tone, key: SCAN_KEY })

export const scanStarted = (): ActivityPost => scan('Scanning…', 'busy')
export const autoScanStarted = (): ActivityPost => scan('Screen settled, scanning…', 'busy')
export const recognising = (mode: unknown): ActivityPost => scan(`Recognising with ${engineName(mode)}…`, 'busy')
export const noSource = (): ActivityPost => scan('Choose a source before scanning', 'warn')
export const nothingRecognised = (): ActivityPost => scan('Nothing recognised', 'warn')
export const sourceChanged = (): ActivityPost =>
  scan('Scan discarded: the source changed while it was running', 'warn')

/** A manual scan that could not start because another one holds the pipeline. */
export const scanBusy = (): ActivityPost => ({
  text: 'Scan skipped: another scan is still running',
  tone: 'info'
})

export const linesAdded = (lines: number): string => (lines === 1 ? 'Added 1 line' : `Added ${lines} lines`)

/** How a publication went: `publishOcrResult`'s report. */
export interface Publication {
  /** Lines the Log gained. */
  lines: number
  /** The reading was already in the history (the same text again, or a piece of it). */
  duplicate: boolean
}

/**
 * The outcome of a scan that was recognised and applied. `publication` is null when nothing
 * reached the publisher at all, which is an empty reading.
 */
export function scanOutcome(publication: Publication | null, { auto = false } = {}): ActivityPost {
  if (publication && publication.lines > 0) return scan(linesAdded(publication.lines), 'ok')
  if (publication?.duplicate) return scan('Same text as before, not added', 'info')
  // The automatic loop reads whenever the screen settles, so a reading with nothing new in it
  // is the normal case there, not a warning.
  if (auto) return scan('No new text', 'info')
  return nothingRecognised()
}

/** Where a scan failed: getting the pixels, reading them, or handing the text on. */
export type ScanStage = 'capture' | 'recognise' | 'publish'

/** The native error prefixes (`sources::err`), and the tags that can follow one. */
const PREFIX = /^(busy|permission|gone|invalid|native):\s*(?:(pick-again|hidden):\s*)?/

/** An engine held back by its model: `<Engine> is not ready: <model_store::reason>`. */
function modelProblem(name: string, reason: string): ActivityPost | null {
  const downloading = reason.match(/^Downloading model… (\d+)%/)
  if (downloading) return scan(`${name} model is still downloading (${downloading[1]}%)`, 'warn')
  if (/^Verifying model/.test(reason)) return scan(`${name} model is still being verified`, 'warn')
  if (/^Model not downloaded/.test(reason)) return scan(`${name} model is not downloaded yet`, 'warn')
  if (/^Model download paused/.test(reason)) return scan(`${name} model download is paused`, 'warn')
  const failed = reason.match(/^Model download failed: (.*)$/)
  if (failed) return scan(`${name} model download failed: ${failed[1]}`, 'error')
  return null
}

/** A failed scan, in words: the error's machine prefix becomes the tone and the lead-in. */
export function scanFailed(error: unknown, stage: ScanStage, mode: unknown): ActivityPost {
  const raw = String((error as Error)?.message ?? error ?? '').trim()
  const match = raw.match(PREFIX)
  const kind = match?.[1] ?? null
  const hidden = match?.[2] === 'hidden'
  const message = raw.replace(PREFIX, '') || 'unknown error'

  if (kind === 'busy') return scan('Scan skipped: a capture is already running', 'info')
  if (kind === 'gone' && /replaced|evicted/.test(message))
    return scan('Scan discarded: the captured frame was replaced', 'warn')
  // The automatic loop's capture says this when nothing is chosen.
  if (/^No source selected/.test(message)) return noSource()

  if (stage === 'capture') {
    if (kind === 'permission') return scan(`Screen capture is not permitted: ${message}`, 'error')
    if (hidden) return scan(`The window is out of view: ${message}`, 'warn')
    if (kind === 'gone') return scan(`The source is gone: ${message}`, 'warn')
    return scan(`Capture failed: ${message}`, 'error')
  }
  if (stage === 'publish') return scan(`Could not add the text: ${message}`, 'error')

  const name = engineName(mode)
  const notReady = message.match(/^.+? is not ready: (.*)$/)
  if (notReady) {
    const model = modelProblem(name, notReady[1])
    if (model) return model
    return scan(`${name} is not available: ${notReady[1]}`, 'warn')
  }
  // Kimochi cloud while signed out (or signed out by the server): native already wrote the
  // sentence, which points at Settings → Account.
  if (/Settings → Account/.test(message)) return scan(message, 'warn')
  // "OneOCR is available on Windows only.": already the whole sentence.
  if (/is available on \w+ only/.test(message)) return scan(message.replace(/\.$/, ''), 'warn')
  return scan(`OCR failed: ${message}`, 'error')
}

/**
 * What the automatic loop says when a recognition it started ends without a result. Only the
 * skips that would otherwise look like nothing happened, and only inside a recognition; the
 * per-tick ones (locked, backoff, waiting) are its normal rhythm and stay in the diagnostics.
 */
export function autoScanSkipped(reason: string): ActivityPost | null {
  switch (reason) {
    case 'stale-generation':
      return sourceChanged()
    case 'superseded':
      return scan('Scan discarded: the text changed before it finished', 'info')
    case 'held':
      return scan('Scan discarded: paused while it was running', 'info')
    case 'unpinned':
      return scan('Scan discarded: the captured frame was replaced', 'warn')
    case 'empty-result':
      return scan('No new text', 'info')
    case 'hidden':
      return scan('Auto-scan waiting: the window is minimised or out of view', 'info')
    default:
      return null
  }
}

export const AUTO_KEY = 'auto-scan'

/** The loop turning on, off, or itself off. Pausing for the controller menu is not news. */
export function autoScanStatus(state: string, message: string): ActivityPost | null {
  switch (state) {
    case 'running':
      return { text: 'Auto-scan on', tone: 'info', key: AUTO_KEY }
    case 'idle':
      return { text: 'Auto-scan off', tone: 'info', key: AUTO_KEY }
    case 'suspended':
      return {
        text: 'Auto-scan paused: it failed several times in a row (manual scans still work)',
        tone: 'warn',
        key: AUTO_KEY
      }
    case 'unavailable':
      return { text: `Auto-scan unavailable: ${message}`, tone: 'warn', key: AUTO_KEY }
    default:
      return null
  }
}
