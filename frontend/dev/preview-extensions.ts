/**
 * DEV-ONLY: the dictionary-engine download commands for the browser preview (`preview-setup.ts`),
 * with a simulated download that emits `extension-download` like
 * `src-tauri/src/extension_store.rs` does. The twin of `preview-models.ts`.
 *
 *   ?ext=absent|downloading|paused|failed|verifying|ready  the starting state of every engine
 *                                                          (default: all absent, a first run;
 *                                                          ready when embedded in the site's demo)
 *   ?ext=updating|update-failed                            after an app update: every engine
 *        ready on an earlier release, its new one downloading in the background (or failed, with
 *        a retry scheduled), as `ExtensionStatus.update`
 *
 * Download, Pause, Resume, Retry and Cancel all work; a download takes about 5 s, an update about
 * 10 s.
 */
import { emit } from '@tauri-apps/api/event'
import type { ExtensionEngine, ExtensionStatus, ExtensionUpdate } from '@ui/extension-download'

const ENGINES: Record<
  ExtensionEngine,
  { name: string; version: string; previous: string; total: number; file: string }
> = {
  yomitan: { name: 'Yomitan', version: '26.10.22.0', previous: '26.8.24.0', total: 15_412_388, file: 'yomitan-chrome.zip' },
  hachidori: { name: 'Hachidori', version: '0.3.0', previous: '0.2.1', total: 5_238_012, file: 'hachidori-chrome.zip' },
  tenten: { name: '10ten Japanese Reader', version: '1.28.0', previous: '1.27.2', total: 18_022_441, file: '10ten-ja-reader-chrome.zip' }
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
    update: null,
    ...patch
  }
}

/** Ready on the earlier release, with the new one's download as `update`. */
function updating(engine: ExtensionEngine, patch: Partial<ExtensionUpdate>): ExtensionStatus {
  const { previous, total } = ENGINES[engine]
  return status(engine, {
    state: 'ready',
    source: 'downloaded',
    overallReceived: total,
    update: {
      from: previous,
      state: 'absent',
      file: null,
      receivedBytes: null,
      totalBytes: null,
      overallReceived: 0,
      overallTotal: total,
      message: null,
      retryAt: null,
      ...patch
    }
  })
}

const search = new URLSearchParams(location.search)
// The marketing site's demo (?embed=1) shows the app in use, every engine already downloaded.
const seeded = search.get('ext') ?? (search.get('embed') === '1' ? 'ready' : null)
const states = new Map<ExtensionEngine, ExtensionStatus>(
  (Object.keys(ENGINES) as ExtensionEngine[]).map((engine) => {
    const { total, file } = ENGINES[engine]
    const part = Math.round(total * 0.38)
    if (seeded === 'updating')
      return [engine, updating(engine, { state: 'downloading', file, overallReceived: part, receivedBytes: part, totalBytes: total })]
    if (seeded === 'update-failed')
      return [
        engine,
        updating(engine, {
          state: 'failed',
          overallReceived: part,
          message: 'network error: error sending request for url (https://github.com/…)',
          retryAt: Math.round(Date.now() / 1000) + 5 * 60
        })
      ]
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

/** An update's download: slower than a first one, so its progress block can be looked at. */
function startUpdate(engine: ExtensionEngine): ExtensionStatus {
  const current = states.get(engine)!
  if (timers.has(engine) || !current.update) return current
  const { total, file } = ENGINES[engine]
  let received = current.update.overallReceived
  const tick = (): ExtensionStatus =>
    publish(updating(engine, { state: 'downloading', file, receivedBytes: received, totalBytes: total, overallReceived: received }))
  timers.set(
    engine,
    setInterval(() => {
      received = Math.min(total, received + total / 40)
      if (received < total) {
        tick()
        return
      }
      stop(engine)
      publish(updating(engine, { state: 'verifying', file, overallReceived: total }))
      setTimeout(() => publish(status(engine, { state: 'ready', source: 'downloaded', overallReceived: total })), 900)
    }, 250)
  )
  return tick()
}

function start(engine: ExtensionEngine): ExtensionStatus {
  const current = states.get(engine)!
  if (current.update) return startUpdate(engine)
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
  if (seeded === 'downloading' || seeded === 'updating') for (const engine of states.keys()) start(engine)
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
    if (current.update) return publish(updating(engine, { ...current.update, state: 'paused' }))
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
