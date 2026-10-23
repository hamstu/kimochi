/**
 * DEV-ONLY: the dictionary-engine download commands for the browser preview (`preview-setup.ts`),
 * with a simulated download that emits `extension-download` like
 * `src-tauri/src/extension_store.rs` does. The twin of `preview-models.ts`.
 *
 *   ?ext=absent|downloading|paused|failed|verifying|ready  the starting state of every engine
 *                                                          (default: all absent, a first run)
 *
 * Download, Pause, Resume, Retry and Cancel all work; a download takes about 5 s.
 */
import { emit } from '@tauri-apps/api/event'
import type { ExtensionEngine, ExtensionStatus } from '@ui/extension-download'

const ENGINES: Record<ExtensionEngine, { name: string; version: string; total: number; file: string }> = {
  yomitan: { name: 'Yomitan', version: '26.10.22.0', total: 15_412_388, file: 'yomitan-chrome.zip' },
  hachidori: { name: 'Hachidori', version: '0.3.0', total: 5_238_012, file: 'hachidori-chrome.zip' },
  tenten: { name: '10ten Japanese Reader', version: '1.28.0', total: 18_022_441, file: '10ten-ja-reader-chrome.zip' }
}

function status(engine: ExtensionEngine, patch: Partial<ExtensionStatus>): ExtensionStatus {
  const info = ENGINES[engine]
  return {
    engine,
    name: info.name,
    version: info.version,
    state: 'absent',
    source: null,
    file: null,
    receivedBytes: null,
    totalBytes: null,
    overallReceived: 0,
    overallTotal: info.total,
    message: null,
    ...patch
  }
}

const seeded = new URLSearchParams(location.search).get('ext')
const states = new Map<ExtensionEngine, ExtensionStatus>(
  (Object.keys(ENGINES) as ExtensionEngine[]).map((engine) => {
    const { total, file } = ENGINES[engine]
    const part = Math.round(total * 0.38)
    const seed: Partial<ExtensionStatus> =
      seeded === 'downloading' || seeded === 'paused'
        ? { state: seeded, overallReceived: part, file, receivedBytes: part, totalBytes: total }
        : seeded === 'failed'
          ? {
              state: 'failed',
              overallReceived: part,
              message: 'network error: error sending request for url (https://github.com/…)'
            }
          : seeded === 'verifying'
            ? { state: 'verifying', overallReceived: total, file }
            : seeded === 'ready'
              ? { state: 'ready', source: 'downloaded', overallReceived: total }
              : {}
    return [engine, status(engine, seed)]
  })
)
const timers = new Map<ExtensionEngine, ReturnType<typeof setInterval>>()

function publish(next: ExtensionStatus): ExtensionStatus {
  states.set(next.engine, next)
  void emit('extension-download', next)
  return next
}

function stop(engine: ExtensionEngine): void {
  clearInterval(timers.get(engine))
  timers.delete(engine)
}

function start(engine: ExtensionEngine): ExtensionStatus {
  const current = states.get(engine)!
  if (timers.has(engine) || current.state === 'ready') return current
  const { total, file } = ENGINES[engine]
  let received = current.overallReceived
  const tick = (): ExtensionStatus =>
    publish(
      status(engine, { state: 'downloading', file, receivedBytes: received, totalBytes: total, overallReceived: received })
    )
  timers.set(
    engine,
    setInterval(() => {
      received = Math.min(total, received + total / 20)
      if (received < total) {
        tick()
        return
      }
      stop(engine)
      publish(status(engine, { state: 'verifying', file, overallReceived: total }))
      setTimeout(() => publish(status(engine, { state: 'ready', source: 'downloaded', overallReceived: total })), 900)
    }, 250)
  )
  return tick()
}

/** `?ext=downloading`: the seeded downloads keep moving, as real ones would. Once IPC is mocked. */
export function startSeededDownloads(): void {
  if (seeded === 'downloading') for (const engine of states.keys()) start(engine)
}

const engineOf = (args: Record<string, unknown> | undefined): ExtensionEngine =>
  args?.engine === 'hachidori' || args?.engine === 'tenten' ? args.engine : 'yomitan'

/** Merged into the preview's command table. */
export const EXTENSION_HANDLERS: Record<string, (args: Record<string, unknown> | undefined) => unknown> = {
  extension_status: (a) => states.get(engineOf(a)),
  extension_download_start: (a) => start(engineOf(a)),
  extension_download_resume: (a) => start(engineOf(a)),
  extension_download_retry: (a) => start(engineOf(a)),
  extension_download_pause: (a) => {
    const engine = engineOf(a)
    stop(engine)
    const current = states.get(engine)!
    return publish(status(engine, { state: 'paused', overallReceived: current.overallReceived }))
  },
  extension_download_cancel: (a) => {
    const engine = engineOf(a)
    stop(engine)
    return publish(status(engine, {}))
  },
  extension_delete: (a) => {
    const engine = engineOf(a)
    stop(engine)
    return publish(status(engine, {}))
  },
  dictionary_engine_effective: () => {
    const ready = Object.fromEntries([...states].map(([engine, s]) => [engine, s.state === 'ready']))
    return { selected: 'yomitan', effective: 'yomitan', ready }
  }
}
