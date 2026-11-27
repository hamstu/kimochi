import { invoke } from '@tauri-apps/api/core'
import { getSetting, type Settings } from '../../bridge/settings'
import { writeTextSelf } from '../lib/clipboardWrite'

/** Lines go out one after another, so they reach the clipboard and the WebSocket in the order they came in. */
let queue: Promise<void> = Promise.resolve()

/**
 * A line the Log just took in from the Text Hooker (after its filter, replacements and dedupe):
 * copied to the clipboard when Settings → Sources → Output → Copy hooked lines to clipboard is on,
 * as OCR scans are with Copy scans to clipboard, and sent to the texthooker WebSocket server when
 * Send hooked lines over WebSocket is on. A line the game's typewriter carried on goes out again
 * whole. The clipboard write is marked as Kimochi's own (lib/clipboardWrite.ts), so the Clipboard
 * input never reads it back as a new line.
 */
export function outputHookedLine(text: string): void {
  queue = queue
    .then(async () => {
      const output = await getSetting<Settings['texthookerSettings']>('texthookerSettings')
      if (output?.copyHookedLines) await writeTextSelf(text)
      if (output?.sendHookedLines) await invoke('texthooker_send', { text, hooked: true })
    })
    .catch((error: unknown) => console.warn('output hooked line failed', error))
}
