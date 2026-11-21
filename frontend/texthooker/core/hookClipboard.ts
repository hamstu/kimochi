import { getSetting, type Settings } from '../../bridge/settings'
import { writeTextSelf } from '../lib/clipboardWrite'

/** Copies run one after another, so lines reach the clipboard in the order they came in. */
let queue: Promise<void> = Promise.resolve()

/**
 * A line the Log just took in from the Text Hooker (after its filter, replacements and dedupe):
 * copied to the clipboard when Settings → Sources → Output → Copy hooked lines to clipboard is on,
 * as OCR scans are with Copy scans to clipboard. A line the game's typewriter carried on is copied
 * again whole. The write is marked as Kimochi's own (lib/clipboardWrite.ts), so the Clipboard
 * input never reads it back as a new line.
 */
export function copyHookedLine(text: string): void {
  queue = queue
    .then(async () => {
      const output = await getSetting<Settings['texthookerSettings']>('texthookerSettings')
      if (output?.copyHookedLines) await writeTextSelf(text)
    })
    .catch((error: unknown) => console.warn('copy hooked line failed', error))
}
