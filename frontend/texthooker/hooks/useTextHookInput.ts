import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getSettings } from '../lib/settings'
import { useIngest } from './useIngest'

/**
 * Text Hooker input: each sentence of the hooked game's chosen thread, as native sends it
 * (`texthook-line`, src-tauri/src/text_hook), taken in like a clipboard or WebSocket line.
 */
export function useTextHookInput(): void {
  const ingest = useIngest()
  useEffect(() => {
    let live = true
    const pending = listen<{ text: string; at?: number; id?: string; replaces?: string | null }>(
      'texthook-line',
      (event) => {
        if (!live || getSettings().inputSource !== 'hook') return
        const text = event.payload.text
        if (typeof text !== 'string' || !text.trim()) return
        // The id names the line's screenshot (lib/screenshots.ts `scanOf`). A line that carries on
        // the last one (its typewriter paused) replaces it.
        void ingest(text, 'hook', event.payload.at, event.payload.id, event.payload.replaces ?? undefined).catch(
          () => {}
        )
      }
    )
    return () => {
      live = false
      void pending.then((stop) => stop()).catch(() => {})
    }
  }, [ingest])
}
