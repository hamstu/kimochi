/**
 * DEV-ONLY: the model download commands (OCR engines, the speech model) for the browser preview (`preview-setup.ts`), with a
 * simulated download that emits `model-download` like `src-tauri/src/model_store.rs` does.
 *
 *   ?model=absent|downloading|paused|failed|ready  the starting state of both local engines
 *                                                  (default: MeikiOCR ready, Manga OCR absent)
 *
 * Picking an `absent` engine in the sidebar or Settings → OCR & Overlay opens the download confirmation;
 * Download saves `ocrMode`, which starts the simulated download (`onModelSettingSet`).
 */
import { emit } from '@tauri-apps/api/event'
import type { ModelEngine, ModelStatus } from '@ui/model-download'

const FILES: Record<ModelEngine, { name: string; files: [string, number][] }> = {
  meikiocr: {
    name: 'MeikiOCR',
    files: [
      ['meiki.text.detect.v0.1.960x544.onnx', 14503825],
      ['meiki.text.rec.v0.960x32.onnx', 18593254],
      ['meiki.text.rec.v0.vertical.32x480.onnx', 12872961]
    ]
  },
  mangaocr: {
    name: 'Manga OCR',
    files: [
      ['config.json', 77546],
      ['vocab.txt', 24072],
      ['preprocessor_config.json', 228],
      ['comic-text-detector.onnx', 94669756],
      ['pytorch_model.bin', 444135475]
    ]
  },
  sensevoice: {
    name: 'SenseVoice speech',
    files: [
      ['model.int8.onnx', 239233841],
      ['tokens.txt', 315894]
    ]
  }
}

const total = (engine: ModelEngine): number =>
  FILES[engine].files.reduce((sum, [, size]) => sum + size, 0)

function status(engine: ModelEngine, patch: Partial<ModelStatus>): ModelStatus {
  return {
    engine,
    name: FILES[engine].name,
    state: 'absent',
    source: null,
    file: null,
    receivedBytes: null,
    totalBytes: null,
    overallReceived: 0,
    overallTotal: total(engine),
    message: null,
    ...patch
  }
}

/** Where `received` overall bytes fall: the file and the bytes of it. */
function at(engine: ModelEngine, received: number): { file: string; got: number; size: number } {
  let before = 0
  for (const [file, size] of FILES[engine].files) {
    if (received < before + size) return { file, got: received - before, size }
    before += size
  }
  const [file, size] = FILES[engine].files.at(-1)!
  return { file, got: size, size }
}

const seeded = new URLSearchParams(location.search).get('model')
const states = new Map<ModelEngine, ModelStatus>(
  (['meikiocr', 'mangaocr', 'sensevoice'] as ModelEngine[]).map((engine) => {
    const half = Math.round(total(engine) * 0.32)
    const seed =
      seeded === 'downloading' || seeded === 'paused'
        ? { state: seeded, overallReceived: half }
        : seeded === 'failed'
          ? {
              state: 'failed' as const,
              overallReceived: half,
              message: 'the connection was interrupted while downloading pytorch_model.bin'
            }
          : seeded === 'ready' || (!seeded && engine === 'meikiocr')
            ? {
                state: 'ready' as const,
                source: 'downloaded' as const,
                overallReceived: total(engine)
              }
            : {}
    return [engine, status(engine, seed as Partial<ModelStatus>)]
  })
)
const timers = new Map<ModelEngine, ReturnType<typeof setInterval>>()

function publish(next: ModelStatus): ModelStatus {
  states.set(next.engine, next)
  void emit('model-download', next)
  return next
}

function stop(engine: ModelEngine): void {
  clearInterval(timers.get(engine))
  timers.delete(engine)
}

function start(engine: ModelEngine): ModelStatus {
  const current = states.get(engine)!
  if (timers.has(engine) || current.state === 'ready') return current
  let received = current.overallReceived
  const step = total(engine) / 40
  timers.set(
    engine,
    setInterval(() => {
      received = Math.min(total(engine), received + step)
      if (received >= total(engine)) {
        stop(engine)
        publish(
          status(engine, {
            state: 'verifying',
            file: at(engine, received - 1).file,
            overallReceived: received
          })
        )
        setTimeout(
          () =>
            publish(
              status(engine, { state: 'ready', source: 'downloaded', overallReceived: received })
            ),
          800
        )
        return
      }
      const { file, got, size } = at(engine, received)
      publish(
        status(engine, {
          state: 'downloading',
          file,
          receivedBytes: got,
          totalBytes: size,
          overallReceived: received
        })
      )
    }, 250)
  )
  const { file, got, size } = at(engine, received)
  return publish(
    status(engine, {
      state: 'downloading',
      file,
      receivedBytes: got,
      totalBytes: size,
      overallReceived: received
    })
  )
}

/**
 * Like native `settings_set`: saving `ocrMode` as a local engine whose models are absent starts
 * their download (the pickers only save it after the download confirmation).
 */
export function onModelSettingSet(key: string, value: unknown): void {
  if (key !== 'ocrMode' || (value !== 'meikiocr' && value !== 'mangaocr')) return
  if (states.get(value)?.state === 'absent') start(value)
}

const engineOf = (args: Record<string, unknown> | undefined): ModelEngine =>
  args?.engine === 'mangaocr' || args?.engine === 'sensevoice' ? args.engine : 'meikiocr'

/** Merged into the preview's command table. */
export const MODEL_HANDLERS: Record<
  string,
  (args: Record<string, unknown> | undefined) => unknown
> = {
  model_status: (a) => states.get(engineOf(a)),
  model_download_start: (a) => start(engineOf(a)),
  model_download_resume: (a) => start(engineOf(a)),
  model_download_retry: (a) => start(engineOf(a)),
  model_download_pause: (a) => {
    const engine = engineOf(a)
    stop(engine)
    const current = states.get(engine)!
    return publish(status(engine, { state: 'paused', overallReceived: current.overallReceived }))
  },
  model_download_cancel: (a) => {
    const engine = engineOf(a)
    stop(engine)
    return publish(status(engine, {}))
  },
  model_delete: (a) => {
    const engine = engineOf(a)
    stop(engine)
    return publish(status(engine, {}))
  }
}
