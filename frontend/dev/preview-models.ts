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
import type { ModelEngine, ModelState, ModelStatus } from '@ui/model-download'

const FILES: Record<ModelEngine, { name: string; files: [string, number][] }> = {
  meikiocr: {
    name: 'MeikiOCR',
    files: [
      ['meiki.text.detect.v0.1.960x544.onnx', 14503825],
      ['meiki.text.rec.v0.960x32.onnx', 18593254],
      ['meiki.text.rec.v0.vertical.32x480.onnx', 12872961]
    ]
  },
  ppocr: {
    name: 'PaddleOCR',
    files: [
      ['PP-OCRv6_small_det.onnx', 9880512],
      ['PP-OCRv6_small_rec.onnx', 21159378],
      ['PP-OCRv6_small_rec.yml', 150579]
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
  screenai: {
    name: 'Screen AI',
    files: [['screen-ai-153.07-mac-arm64.zip', 78164700]]
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
  (['meikiocr', 'mangaocr', 'ppocr', 'screenai', 'sensevoice'] as ModelEngine[]).map((engine) => {
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
          : engine === 'screenai' && !seeded && new URLSearchParams(location.search).get('screenai') !== 'missing'
            ? // A browser's copy (`?screenai=missing` for none).
              { state: 'ready' as const, source: 'browser' as const, overallReceived: 0 }
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
/** A download the studio asked to fail: the fraction of it reached before it does. */
const failAt = new Map<ModelEngine, number>()
const FAILURE = 'the connection was interrupted while downloading'

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
      const failing = failAt.get(engine)
      if (failing !== undefined && received >= total(engine) * failing) {
        stop(engine)
        failAt.delete(engine)
        publish(status(engine, { state: 'failed', overallReceived: received, message: `${FAILURE} ${at(engine, received).file}` }))
        return
      }
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
  if (
    key !== 'ocrMode' ||
    (value !== 'meikiocr' && value !== 'mangaocr' && value !== 'ppocr' && value !== 'screenai')
  )
    return
  if (states.get(value)?.state === 'absent') start(value)
}

const engineOf = (args: Record<string, unknown> | undefined): ModelEngine =>
  args?.engine === 'mangaocr' ||
  args?.engine === 'ppocr' ||
  args?.engine === 'screenai' ||
  args?.engine === 'sensevoice'
    ? args.engine
    : 'meikiocr'

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

/**
 * The studio's handle on these downloads (`window.__kimochiPreview.model`, preview-control.ts):
 * put an engine in a state at once, or start its download from nothing, optionally failing at a
 * fraction of it.
 */
export const modelControl = {
  state: (engine: ModelEngine): ModelState => states.get(engine)!.state,
  set(engine: ModelEngine, state: ModelState): void {
    stop(engine)
    const t = total(engine)
    const part = Math.round(t * 0.32)
    publish(
      status(
        engine,
        state === 'ready'
          ? { state, source: 'downloaded', overallReceived: t }
          : state === 'absent'
            ? {}
            : state === 'failed'
              ? { state, overallReceived: part, message: `${FAILURE} ${at(engine, part).file}` }
              : { state, overallReceived: state === 'verifying' ? t : part }
      )
    )
  },
  /** Pause where it is, as the Pause button does. */
  pause(engine: ModelEngine): void {
    stop(engine)
    const current = states.get(engine)!
    publish(status(engine, { state: 'paused', overallReceived: current.overallReceived }))
  },
  start(engine: ModelEngine, options: { failAt?: number; fresh?: boolean } = {}): void {
    stop(engine)
    if (options.fresh !== false) publish(status(engine, {}))
    if (options.failAt !== undefined) failAt.set(engine, options.failAt)
    else failAt.delete(engine)
    start(engine)
  }
}
