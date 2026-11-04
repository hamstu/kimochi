/**
 * DEV-ONLY: Tauri's IPC mock for the browser preview (`preview-setup.ts`), installed before any
 * app module runs. Some listen to native events as they load (`texthooker/lib/settings.ts` for
 * `panel:state`), which needs `__TAURI_INTERNALS__` before `setupPreview` has its handlers. And
 * `mockIPC` keeps its event listeners per call, so it is called once, here, and answers through
 * whichever handler `setupPreview` sets.
 */
import { mockIPC } from '@tauri-apps/api/mocks'

type Handler = (cmd: string, args: unknown) => unknown

let handler: Handler = () => null

mockIPC((cmd, args) => handler(cmd, args), { shouldMockEvents: true })

/** Answers every command from now on with `next`. */
export function setPreviewIpc(next: Handler): void {
  handler = next
}
