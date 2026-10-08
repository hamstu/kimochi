import { installApiLookup, lookupTerm } from './api-lookup.js'
import { createController } from './controller.js'
/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The overlay window: Yomitan host, text renderer and scan orchestrator.
 *
 * This is the only window that is always open, so it carries two jobs Electron
 * split between a hidden background window and the overlay renderer: hosting the
 * original Yomitan extension — backend, scanner, popup, importer and IndexedDB,
 * as the single owner of the dictionary database — and running the scan pipeline
 * that draws recognised text, detects change and publishes results.
 *
 * Native owns capture, the cloud endpoint, settings, window placement, global
 * shortcuts, the gamepad and action dispatch. This file must never repeat an
 * action native has already performed, so the `hotkey` handler below deliberately
 * ignores every action whose effect Rust applied before emitting it.
 *
 * Startup order matters: the scan pipeline is wired up first and the Yomitan host
 * is brought up behind it, without blocking. A dictionary or backend failure then
 * costs lookups and says so, instead of leaving the user with no OCR at all.
 */

import { sourceDisplay, toOverlayLocal } from './geometry.js'
import { scanPointerInit } from './scan-input.js'
import { visibleAnnotations } from './annotations.js'
import { AutoScanner } from './autoscan.js'
import { SceneScanner } from './scene-scanner.js'
import { ScanTrace } from './scan-trace.js'
import { annotationsInLines } from './current-lines.js'
import { TextOverlayRenderer } from './render.js'
import { HoverOverlay, HoverPreview } from './hover.js'
import { forgetFrame } from './frames.js'
import { recognize } from './ocr.js'
import { normalizeOcrResult } from './ocr-result.js'
import { publishOcrResult, listHistory } from './output.js'
import { speak } from './tts.js'
import { ForegroundTracker, shouldShowScannedText } from './foreground.js'
import { parseSourceId } from './source-id.js'
import { isOverlayTextVisible, nextOverlayToggle, overlayTextChange } from './settings.js'
import { popupHitRects } from './regions.js'
import { Generation, PipelineLock } from './pipeline.js'
import * as native from './native.js'

let waylandDisabled = false
let waylandLayer = false

const hub = window.__extensionHost
const log = (value) => {
  if (hub?.log) hub.log(value)
  else void native.report(value)
}

const scanTrace = new ScanTrace((records) => native.writeScanTrace(records))
const trace = (kind, data) => {
  try {
    scanTrace.record(kind, data)
  } catch {
    /* diagnostic only */
  }
}
trace('session', { instrumentation: 'first-pass-v1' })

const wordsContainer = document.querySelector('#words')
const hoverContainer = document.querySelector('#hover')
const pagesSection = document.querySelector('.pages')
const foreground = new ForegroundTracker()

const state = {
  revision: -1,
  dismiss: -1,
  dictionaryOpen: false,
  scanning: false,
  origin: null,
  info: null,
  annotations: [],
  geometry: true,
  scannedApp: null,
  source: null,
  /** The selection as the shared view describes it (`{sourceId, type, ...}`). */
  viewSource: null,
  /** The native scan id already rendered and already published. */
  appliedScanId: null,
  // Session view flags live on the shared native view, so the controller and the
  // overlay can never disagree about what is switched on.
  flags: {
    autoOcrEnabled: false,
    textOverlayVisible: true,
    overlayVisible: true,
    debugOverlayVisible: false
  },
  /** Live bounds of the captured source, tracked natively between scans. */
  sourceBounds: null,
  /**
   * Whether the captured window is still in front and still there, from native.
   * Null until the first answer arrives; unknown shows text rather than hiding it.
   */
  sourceFocus: null,
  crop: null,
  hover: { selectRegion: false, source: false, isWindow: false },
  /** While true the overlay claims the whole display so a drag can be seen. */
  regionSelecting: false,
  /**
   * The text on screen came from a Quick Shot: a display region, not the chosen source. It stays
   * where it was captured instead of following the source window around.
   */
  detached: false,
  yomitan: { ready: false, error: null }
}

const setting = (key) => native.getSetting(key)

/**
 * Quick Shot is the Log reading OCR with no chosen source. The flag alone is not enough: the
 * sidebar shows Quick Shot only while the input is OCR, so the scan shortcut follows the same
 * rule rather than drawing a region under a Clipboard or WebSocket source.
 */
const isQuickShot = () =>
  Boolean(setting('quickShotEnabled')) &&
  (setting('superTexthooker')?.inputSource ?? 'ocr') === 'ocr'

// ---------------------------------------------------------------------------
// 1. Rendering
// ---------------------------------------------------------------------------

const hover = new HoverOverlay(hoverContainer)
// A picture of the hovered window inside its outline, so it can be recognised
// even when other windows cover it. Silent on failure, like the outline itself:
// `busy:` (a scan is capturing) and a closed window both just mean no picture.
let hoverCopyFailed = false
// The picture is kept as an object url: the `capture:` hover slot holds only the newest
// capture (the region editor's refresh replaces it too), so its url cannot be shown again later.
const hoverPreview = new HoverPreview({
  capture: async ({ reusable, show }) => {
    const sourceId = await native.selectedSource()
    if (!sourceId) return null
    const recent = reusable(sourceId)
    if (recent) return { key: sourceId, url: recent, reused: true }
    // The last picture now; the fresh one replaces it when it lands.
    show(sourceId)
    const preview = await native.sourceHoverPreview(sourceId)
    if (!preview?.url) return null
    try {
      const response = await fetch(preview.url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return { key: sourceId, url: URL.createObjectURL(await response.blob()) }
    } catch (error) {
      // Without a copy the picture still shows now; it just cannot be shown again later.
      if (!hoverCopyFailed) {
        hoverCopyFailed = true
        log({ check: 'hover-preview-copy-failed', error: String(error?.message ?? error) })
      }
      return { key: sourceId, url: preview.url }
    }
  },
  onChange: () => drawHover(),
  // Revoked late: an image fading out may still be drawing it.
  release: (url) => {
    if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 2000)
  }
})

const renderer = new TextOverlayRenderer(wordsContainer, {
  // Keep cloud requests from disrupting lookup, while local observations still
  // notice when the game removes the words underneath the pointer. Touching the text with the
  // mouse also takes word mode back from the controller.
  onActivity: () => {
    holdAutoScan()
    controller?.mouseActivity()
  },
  onLookupStart: () => {
    holdAutoScan()
    controller?.mouseUsed()
  }
})

/**
 * Controller mode: the radial menu and word-by-word dictionary navigation. It holds the scan's
 * text on screen while it steps through it, even once native has moved focus off the game,
 * which would otherwise hide the text as belonging to an app that is no longer in front.
 */
let controller = null
controller = createController({
  host: document.querySelector('#controller'),
  words: wordsContainer,
  native,
  status: () => {
    const origin = state.origin
    const bounds = state.sourceBounds ?? state.info?.source_bounds ?? null
    const area =
      origin && bounds
        ? { x: bounds.x - origin.x, y: bounds.y - origin.y, width: bounds.width, height: bounds.height }
        : null
    return {
      hasText: state.annotations.length > 0 && Boolean(state.geometry),
      autoOcr: Boolean(state.flags.autoOcrEnabled),
      autoAvailable: !isQuickShot(),
      textVisible: isOverlayTextVisible(setting('liveOverlayEnabled'), state.flags.textOverlayVisible),
      origin,
      area,
      scanId: state.appliedScanId,
      center: area ? { x: area.x + area.width / 2, y: area.y + area.height / 2 } : null
    }
  },
  run: (id) => {
    if (id === 'auto') return void onAction('toggleAutoOcr')
  },
  // With automatic OCR on, Scan catches the loop up at once instead of a separate scan;
  // either way it resolves once the text on screen is current.
  scan: async () => {
    if (scanner === sceneScanner && scanner.isRunning) return sceneScanner.refresh()
    await onAction('triggerScan')
    return false
  },
  popupControl: (control) => controlPopup(control),
  redraw: () => draw(),
  dictionary: () => extensionApi,
  popupType: () => setting('yomitanSettings')?.popupType ?? 'builtin',
  buttons: () => setting('controllerButtons'),
  lookupRange: async (range) => (await import('/spike/frontend-mode.js')).lookupRange(range),
  lookupTerm,
  charRects: (element) => (renderer.mode === 'words' ? renderer.charRects(element) : null),
  quietText: (quiet) => renderer.setQuiet(quiet),
  setText: (visible) => setOverlayText(visible),
  nearText: (x, y) => {
    const reach = 32
    for (const element of wordsContainer.children) {
      const rect = element.getBoundingClientRect()
      if (
        x >= rect.left - reach &&
        x <= rect.right + reach &&
        y >= rect.top - reach &&
        y <= rect.bottom + reach
      )
        return true
    }
    return false
  },
  dismiss: () => {
    dismissPopup()
    void native.optional('hide_popover')
  },
  log: (record) => log(record),
  modeChanged: (mode) => holdForController(mode !== 'idle')
})
/** The scan the controller last saw drawn, so it can follow a new one in word mode. */
let controllerScanId = null

/**
 * Automatic OCR stands still while the controller menu is open or the reader is stepping
 * through words: nothing is captured, nothing new is drawn under the cursor, and a recognition
 * already out is set aside rather than applied. Leaving controller mode picks it straight back
 * up, with a fresh look at the screen.
 */
let controllerHold = false
function holdForController(hold) {
  if (hold === controllerHold) return
  controllerHold = hold
  if (hold) scanner.pause()
  else scanner.resume()
  log({ check: 'auto-scan-controller-hold', hold, running: scanner.isRunning })
}

function holdAutoScan() {
  if (!scanner.isRunning) return
  scanner.pauseRecognitionFor(3000)
}

let gnomeOverlay = null
let gnomeControllerWords = false
let lastVisibilityTrace = null
function draw() {
  if (waylandDisabled) { renderer.clear(); void gnomeOverlay?.update(); return }
  // Layer-shell provides an output-local surface, not another window's position.
  // Do not draw a portal window frame at a fabricated desktop location.
  if (waylandLayer && state.info?.source_id?.startsWith('portal:window:')) {
    renderer.clear()
    return
  }
  const visible =
    controller.holdsText ||
    (isOverlayTextVisible(setting('liveOverlayEnabled'), state.flags.textOverlayVisible) &&
      (waylandLayer ||
        shouldShowScannedText(state.source, state.sourceFocus, foreground.current, state.scannedApp)))

  const reason = !isOverlayTextVisible(
    setting('liveOverlayEnabled'),
    state.flags.textOverlayVisible
  )
    ? 'disabled'
    : !visible
      ? 'source-inactive'
      : !state.geometry
        ? 'no-geometry'
        : state.annotations.length
          ? 'visible'
          : 'no-text'
  const visibility = { reason, annotations: state.annotations.length, frameId: state.appliedScanId }
  const signature = JSON.stringify(visibility)
  if (signature !== lastVisibilityTrace) {
    lastVisibilityTrace = signature
    trace('overlay-visibility', visibility)
  }

  if (!visible || !state.geometry) {
    // Clearing takes the click targets with it: `hitRects` reads the rendered
    // elements, so text that is not on screen cannot still be catching the mouse.
    renderer.clear()
    return
  }
  let readerBounds = null
  if ((waylandLayer) && state.info) {
    const scale = Math.min(
      innerWidth / state.info.full_width,
      innerHeight / state.info.full_height
    )
    readerBounds = {
      x: (innerWidth - state.info.full_width * scale) / 2,
      y: (innerHeight - state.info.full_height * scale) / 2,
      width: state.info.full_width * scale,
      height: state.info.full_height * scale
    }
  }
  const renderChange = renderer.render({
    annotations: state.annotations,
    info: state.info,
    origin: state.origin,
    // Where the source is now, not where it was when the frame was captured, so
    // text follows a window that has since moved or been resized.
    bounds: readerBounds ?? (state.detached
      ? (state.info?.source_bounds ?? null)
      : (state.sourceBounds ?? state.info?.source_bounds ?? null)),
    grouping: setting('textOverlayGrouping'),
    opacity: setting('overlayOpacity'),
    scanning: state.scanning
  })
  if (renderChange && (renderChange.created || renderChange.removed))
    trace('overlay-dom-change', renderChange)
  if (state.appliedScanId !== controllerScanId) {
    controllerScanId = state.appliedScanId
    controller.scanChanged(state.annotations.length > 0)
  }
}

function drawHover() {
  hover.update({
    visible: state.hover.selectRegion || state.hover.source,
    showWindowOutline: state.hover.source && state.hover.isWindow,
    showCropRegion: state.hover.selectRegion,
    windowImage: state.hover.source && state.hover.isWindow ? hoverPreview.url : null,
    bounds: state.sourceBounds,
    crop: state.crop,
    origin: state.origin
  })
}

/**
 * Reflect scan progress locally and on the shared view.
 *
 * The controller lives in another window and reads `isScanning` and `status`
 * from the native view, so a scan driven from here has to publish both or the
 * controller shows nothing happening while an OCR request is in flight. A
 * failure to publish must never fail the scan, so it is reported and swallowed.
 */
function setScanning(scanning, status) {
  if (state.scanning !== scanning) {
    state.scanning = scanning
    draw()
  }
  publish({ scanning, ...(status === undefined ? {} : { status }) })
}

/** Publishing must never fail a scan, so a failure is reported and swallowed. */
function publish(update) {
  void native
    .publishScanState(update)
    .catch((error) => log({ check: 'scan-state-error', error: String(error?.message ?? error) }))
}

/**
 * Publish an accepted result to the shared view.
 *
 * Called only once the staleness guard has passed, so the shared view — and with
 * it the capture and debug panels and the controller's status — never shows a
 * result belonging to a source the user has already moved away from. Native
 * dedupes by frame id, so a cloud frame that `ocr_frame` already published is
 * not published twice; that call only clears the busy flag.
 */
function publishAccepted(frame, result) {
  if (!frame?.id) return
  state.appliedScanId = frame.id
  return native.publishScanState({
    publish: true,
    scanning: false,
    scan: {
      id: frame.id,
      info: frame.info ?? null,
      ocr: {
        groups: result.groups ?? [],
        engine: result.engine,
        schemaVersion: 1,
        fullText: result.fullText ?? '',
        textAnnotations: result.geometry ? (result.textAnnotations ?? []) : [],
        geometry: result.geometry !== false
      }
    },
    // Local and WebSocket OCR return no geometry, and the status line is where
    // that is explained rather than letting it look like a scan that found
    // nothing.
    ...(result.geometry
      ? {}
      : {
          status: result.fullText
            ? 'Scan ready \u00b7 text only, this engine returns no positions'
            : 'Scan ready \u00b7 no text recognized'
        })
  })
}

/**
 * Frames whose results were rejected as stale.
 *
 * `ocr_frame` publishes its result to the shared view before this window judges
 * it, so a late cloud result from a source the user has left would arrive back
 * as a view update and be rendered after all. Remembering the rejected ids stops
 * that echo, alongside asking native to stop self-publishing from `ocr_frame`.
 */
const rejectedFrameIds = new Set()
function rejectFrame(id) {
  if (id === null || id === undefined) return
  rejectedFrameIds.add(id)
  // Ids increase monotonically, so only the newest few can still be echoed.
  if (rejectedFrameIds.size > 32) {
    rejectedFrameIds.delete(rejectedFrameIds.values().next().value)
  }
}

// ---------------------------------------------------------------------------
// 2. The scan pipeline
// ---------------------------------------------------------------------------

const generation = new Generation()
const pipeline = new PipelineLock()

/**
 * Snapshot everything a scan depends on, once, before any await.
 *
 * The source descriptor and crop are captured here rather than read back after
 * the endpoint answers, so a result is always attributed to the selection that
 * produced it even if the user picks a different window mid-request.
 */
async function beginJob() {
  const sourceId = await native.selectedSource()
  if (!sourceId) return null
  const prefs = await native.preferences().catch(() => null)
  return {
    generation: generation.current,
    sourceId,
    source: prefs?.source ?? null,
    request: { source_id: sourceId, crop: prefs?.crop ?? null }
  }
}

/**
 * Keep native tracking whichever source is selected.
 *
 * `watch_source` polls the window's bounds natively and emits `source-bounds`,
 * which is what lets the overlay follow a source that moves or changes display
 * between scans — Electron did this with its window-position watcher.
 */
let watchedSourceId = null
async function followSource(source) {
  const id = source?.sourceId ?? source?.id ?? null
  if (id === watchedSourceId) return
  watchedSourceId = id
  state.sourceBounds = null
  await native.watchSource(id ?? null)
}

/** Place the overlay over the display that holds the captured source. */
async function positionFor(info) {
  // Unsupported Wayland desktops still publish capture/OCR to the reader.
  // They have neither an annotation surface nor a portable desktop catalogue.
  if (waylandDisabled) return state.origin
  if (waylandLayer) return { x: 0, y: 0, width: innerWidth, height: innerHeight }
  if (!info?.source_bounds) return state.origin
  const origin = sourceDisplay(info.source_bounds, await native.desktop())
  const moved =
    !state.origin ||
    state.origin.x !== origin.x ||
    state.origin.y !== origin.y ||
    state.origin.width !== origin.width ||
    state.origin.height !== origin.height
  if (moved) await native.placeOverlay(origin)
  return origin
}

/**
 * Apply one OCR result: reposition, redraw, publish.
 *
 * The published string is the filtered reading-order text, not the endpoint's
 * `fullText`, so history, clipboard, texthooker and TTS all agree with what the
 * overlay actually shows.
 */
async function applyResult(result, frame, job, outcome = { publish: true }) {
  // The selection moved on while this was in flight: these pixels describe a
  // source the user is no longer looking at, so they must not be rendered and
  // must not reach the history, the clipboard or the texthooker.
  if (!job || generation.isStale(job)) {
    const staleId = result.nativeScanId ?? frame?.id ?? null
    rejectFrame(staleId)
    log({
      check: 'overlay-scan-discarded',
      reason: 'selection changed while the scan was in flight',
      frameId: staleId,
      jobGeneration: job?.generation ?? null,
      current: generation.current
    })
    publish({ scanning: false, status: 'Scan discarded: the source changed while it was running.' })
    return ''
  }

  const info = frame?.info ?? null
  state.info = info
  state.detached = !!job.detached
  state.geometry = result.geometry !== false
  state.annotations = state.geometry ? (result.textAnnotations ?? []) : []
  state.source = job.source
  const kind = state.source?.kind ?? state.source?.type
  state.scannedApp =
    kind === 'window' ? (state.source.app ?? state.source.appName ?? null) : foreground.current
  // Whichever native scan produced this is now accounted for, so the poll loop
  // does not treat its revision as new work and publish the same text twice.
  state.appliedScanId = result.nativeScanId ?? frame?.id ?? null

  // The native published owner must exist before AutoScanner releases its pin.
  await publishAccepted(frame, result)

  if (state.geometry && info) state.origin = await positionFor(info)
  draw()

  const grouping = setting('textOverlayGrouping')
  // Redrawing and publishing are separate. The accurate recogniser returning the
  // same sentence again — because the reader has not moved on, and the box has
  // only shifted a little — must still move the word boxes, and must not put a
  // second copy in the history, the clipboard and the texthooker.
  const published =
    outcome.publish === false
      ? ''
      : await publishOcrResult(outcome.publishResult ?? result, {
          detached: !!job.detached,
          grouping,
          // A scan of text that is already in the history does not add it again.
          merge: true
        })

  log({
    check: 'overlay-scan-applied',
    mode: setting('ocrMode'),
    geometry: state.geometry,
    words: state.geometry ? visibleAnnotations(state.annotations, grouping).length : 0,
    published: published.length,
    refreshedOnly: outcome.publish === false
  })
  return published
}

/**
 * A manual scan: capture, recognise, apply. Skipped while the loop holds the lock.
 *
 * `explicit` is a ready-made job (a Quick Shot's display region) to run instead of the chosen
 * source's.
 */
async function performScan(explicit = null) {
  trace('manual-scan', { generation: generation.current })
  const ran = await pipeline.run(async () => {
    setScanning(true, 'Capturing\u2026')
    try {
      const job = explicit ?? (await beginJob())
      if (!job) {
        log({ check: 'overlay-scan-skipped', reason: 'no source selected' })
        setScanning(false, 'Choose a source before scanning.')
        return
      }
      forgetFrame()
      const frame = await native.captureFrame(
        job.request,
        scanner.isRunning,
        setting('autoOCRSettings').observerMode
      )
      const result = await recognize(frame, {
        ocrMode: setting('ocrMode'),
        owocrWebSocketUrl: setting('owocrWebSocketUrl')
      })
      if (!result) {
        setScanning(false, 'No result from the OCR engine.')
        return
      }
      const published = await applyResult(result, frame, job)
      // Keep the auto loop from immediately republishing what we just showed —
      // but only if the result was actually accepted.
      // Tell the loop what has just been spent and shown, so it does not
      // immediately make the same request again — and so its minimum spacing
      // starts from this scan, not from its own last one.
      if (published !== '' || !generation.isStale(job))
        scanner.noteExternalScan(result.fullText, observationFrom(frame)?.lines, result)
    } catch (error) {
      // Capture permission, a stale source and an unreachable endpoint all land
      // here, and the user's only view of them is the controller's status line.
      const message = String(error?.message ?? error)
      log({ check: 'overlay-scan-error', error: message })
      state.scanning = false
      draw()
      publish({ scanning: false, status: message })
      return
    } finally {
      if (state.scanning) setScanning(false)
    }
  })
  if (ran === null) log({ check: 'overlay-scan-skipped', reason: 'a scan is already running' })
  return ran !== null
}

/**
 * The automatic loop.
 *
 * Every dependency is injected, which is what lets `scripts/autoscan.test.mjs`
 * exercise the whole policy with a fake clock and no app. What this file supplies
 * is the real versions: one native call that captures, hashes and locally reads a
 * frame; the configured accurate recogniser; the shared pipeline lock; and the
 * same `applyResult` the manual path uses, so a result reaches the overlay by one
 * route whichever path produced it.
 */
/**
 * The job the most recent automatic capture belongs to.
 *
 * Only used as a fallback. A recognition outlives the tick that started it, so by
 * the time a result lands this may already describe a later capture — which is
 * why each frame carries its own job below, and why the result is attributed to
 * that one rather than to whatever the loop is looking at now.
 */
let autoJob = null
const scanDeps = {
  generation: () => generation.current,
  // Held by the *other* path. The loop's own request takes this lock too, so it
  // cannot overlap a manual scan and a manual scan cannot overlap it.
  isBusy: () => pipeline.isHeld,
  tryAcquire: () => pipeline.acquire(),
  releaseLock: () => pipeline.release(),
  captureFrame: async () => {
    const selectionStarted = performance.now()
    autoJob = await beginJob()
    const selectionMs = performance.now() - selectionStarted
    if (!autoJob) throw new Error('No source selected')
    forgetFrame()
    const started = performance.now()
    trace('capture-start', { generation: autoJob.generation })
    let captured
    try {
      captured = await native.captureFrame(
        autoJob.request,
        true,
        setting('autoOCRSettings').observerMode
      )
    } catch (error) {
      trace('capture-failed', { durationMs: performance.now() - started })
      throw error
    }
    try {
      scanTrace.observation({
        frameId: captured.id,
        generation: autoJob.generation,
        fingerprint: captured.contentFingerprint ?? null,
        observation: observationFrom(captured),
        captureMs: captured.info?.total_ms,
        resolveMs: captured.info?.resolve_ms,
        acquisitionMs: captured.info?.acquisition_ms,
        pixelsMs: captured.info?.pixels_ms,
        observerMs: captured.observation?.duration_ms,
        roundTripMs: performance.now() - started,
        selectionMs,
        width: captured.info?.width,
        height: captured.info?.height
      })
    } catch {
      /* diagnostic only */
    }
    // The job travels with the frame. `applyResult` needs the source and the
    // generation *this* capture was made under, and a slow request can easily
    // outlive several later captures.
    const frame = { ...captured, job: autoJob }
    return {
      frame,
      generation: autoJob.generation,
      hash: captured?.hash ?? null,
      contentFingerprint: captured?.contentFingerprint ?? null,
      observation: observationFrom(captured),
      observerError: captured?.observerError ?? null,
      observerUnsupported: !!captured?.observerUnsupported
    }
  },
  recognize: async (frame) => {
    const started = performance.now()
    trace('second-pass-start', { frameId: frame.id, mode: setting('ocrMode') })
    try {
      const result = await recognize(frame, {
        ocrMode: setting('ocrMode'),
        owocrWebSocketUrl: setting('owocrWebSocketUrl')
      })
      try {
        scanTrace.result(frame.id, result?.fullText ?? '', performance.now() - started)
      } catch {
        /* diagnostic only */
      }
      return result
    } catch (error) {
      trace('second-pass-failed', { frameId: frame.id, durationMs: performance.now() - started })
      throw error
    }
  },
  retainFrame: (frame) => native.retainFrame(frame?.id, true),
  releaseFrame: (frame) => native.retainFrame(frame?.id, false),
  onDiagnostic: (event, frame, counters, context) => {
    // Free-form messages/details may carry service content. Keep only structured
    // decision fields; the existing operational error log remains separate.
    const safe = Object.fromEntries(
      Object.entries(event).filter(([key]) => !['message', 'detail', 'layout'].includes(key))
    )
    trace('decision', { event: safe, frameId: frame?.id ?? null, counters, ...context })
  },
  onScanStart: () => setScanning(true, 'Auto scan\u2026'),
  onScanEnd: () => setScanning(false),
  onEvent: onAutoScanEvent
}

/**
 * Image mode: the whole-crop hash decides, so the original single-candidate loop drives it.
 * Text mode — the default — runs on the scene memory instead; see scene-scanner.ts.
 */
const imageScanner = new AutoScanner({
  ...scanDeps,
  onResult: async (result, frame, outcome) => {
    const started = performance.now()
    trace('apply-start', { frameId: frame?.id, publish: outcome.publish })
    try {
      const applied = await applyResult(result, frame, frame?.job ?? autoJob, outcome)
      trace('apply-end', {
        frameId: frame?.id,
        durationMs: performance.now() - started,
        publishedChars: applied.length,
        geometry: result.geometry !== false
      })
      return applied
    } catch (error) {
      trace('apply-failed', { frameId: frame?.id, durationMs: performance.now() - started })
      throw error
    }
  }
})

const sceneScanner = new SceneScanner({ ...scanDeps, onScene: applyScene })

/** Whichever loop the observer mode calls for; `syncAutoScanner` keeps it current. */
let scanner = sceneScanner

/**
 * Draw what the scene memory holds, and publish what it says is new.
 *
 * An update with a frame comes from a recognition and goes through `applyResult` like any
 * scan, so the reader, the controller and the published scan state all see it. One without
 * is the drawing catching up with the screen — a line went, or came back with a reading the
 * memory already had — and only redraws.
 */
async function applyScene(update) {
  const grouping = setting('textOverlayGrouping')
  if (update.frame) {
    const started = performance.now()
    trace('apply-start', { frameId: update.frame.id, publish: update.publish.length })
    await applyResult(update.result, update.frame, update.frame.job ?? autoJob, { publish: false })
    trace('apply-end', {
      frameId: update.frame.id,
      durationMs: performance.now() - started,
      geometry: update.result.geometry !== false
    })
  } else {
    if (update.generation !== generation.current) return
    state.annotations = update.result.geometry ? update.result.textAnnotations : []
    if (state.annotations.length) state.geometry = true
    draw()
    void publishRegions()
  }
  let published = 0
  for (const passage of update.publish) {
    published += (await publishPassage(passage, grouping)).length
  }
  log({
    check: 'auto-scan-scene',
    reason: update.reason,
    annotations: Math.max(0, state.annotations.length - 1),
    passages: update.publish.length,
    corrections: update.publish.filter((passage) => passage.replaces).length,
    published
  })
}

/**
 * Publish one passage from automatic OCR. Merged into the history rather than appended: a
 * passage that is the same sentence as one just written, or a piece of it, adds nothing, and
 * one that completes an earlier fragment replaces it.
 */
async function publishPassage(passage, grouping) {
  return publishOcrResult(passage.result, { detached: state.detached, grouping, merge: true })
}

/**
 * Turn the native observation into the shape the policy compares.
 *
 * Line boxes arrive in the frame's own pixels with a top-left origin — see
 * `TextLine` in capture-core — which is the same space the box tolerance is
 * expressed in, so nothing is converted here.
 */
function observationFrom(frame) {
  const observation = frame?.observation
  if (!observation || typeof observation.text !== 'string') return null
  return {
    text: observation.text,
    lines: (observation.lines ?? []).map((line) => ({
      text: line.text ?? '',
      box: { x: line.x ?? 0, y: line.y ?? 0, width: line.width ?? 0, height: line.height ?? 0 },
      ...(Array.isArray(line.ink) ? { ink: line.ink } : {})
    }))
  }
}

/**
 * Report what the loop is doing, without ever reporting what it read.
 *
 * Every event carries counts, reasons, lengths and coarse geometry and no
 * recognised text, so the diagnostics stay safe to read and to send. `status` is
 * the one the user has to see: automatic scanning turning itself off, whether
 * because this platform has no observer or because it has failed too often, is
 * not something to leave in a log file.
 */
function onAutoScanEvent(event) {
  switch (event.type) {
    case 'visual-invalidated':
      // Local observation controls visual freshness; never wait for the cloud
      // to tell us that text which disappeared is no longer on screen.
      state.annotations = event.keepBoxes
        ? annotationsInLines(state.annotations, event.keepBoxes)
        : []
      draw()
      void publishRegions()
      log({
        check: 'auto-scan-visual-cleared',
        reason: event.reason,
        retained: state.annotations.length
      })
      return
    case 'status':
      if (event.state === 'running') {
        const settings = setting('autoOCRSettings')
        trace('auto-start', {
          mode: setting('ocrMode'),
          observerMode: settings.observerMode,
          settings: Object.fromEntries(
            Object.entries(settings).filter(
              ([, value]) => typeof value === 'number' || typeof value === 'boolean'
            )
          )
        })
      }
      if (event.state === 'idle') {
        trace('auto-stop')
        void scanTrace.flush()
      }
      log({ check: 'auto-scan-status', state: event.state, message: event.message })
      if (event.state === 'unavailable' || event.state === 'suspended') {
        state.scanning = false
        draw()
        publish({ scanning: false, status: event.message })
      }
      return
    case 'error':
      log({
        check: 'auto-scan-error',
        stage: event.stage,
        error: event.message,
        backoffMs: event.backoffMs
      })
      // A capture or endpoint failure belongs on the controller, not only in the
      // log; an observer that has simply not answered yet does not, because it
      // retries on its own and the status line would flicker.
      if (event.stage !== 'observer') publish({ scanning: false, status: event.message })
      return
    case 'skip':
      return log({ check: 'auto-scan-skip', reason: event.reason, detail: event.detail ?? null })
    case 'request':
      return log({
        check: 'auto-scan-request',
        reason: event.reason,
        queued: event.queued,
        replaced: event.replaced
      })
    case 'result':
      return log({
        check: 'auto-scan-result',
        published: event.published,
        reason: event.reason,
        chars: event.chars
      })
    default:
      return undefined
  }
}

/** Counters, for the debug panel and for answering "is it still scanning?". */
export function autoScanStats() {
  return { state: scanner.state, reason: scanner.stateReason, ...scanner.stats() }
}

function syncAutoScanner() {
  const settings = setting('autoOCRSettings')
  const wantedScanner = settings?.observerMode === 'image' ? imageScanner : sceneScanner
  if (wantedScanner !== scanner) {
    if (scanner.isRunning) scanner.stop()
    scanner.resume()
    scanner = wantedScanner
    if (controllerHold) scanner.pause()
  }
  scanner.updateSettings(settings)
  // Quick Shot has no source to watch, so there is nothing for the loop to scan. Nor while a
  // region is being edited: the old region is about to be replaced, and the loop's frame checks
  // run on this page, where they would stutter the drag.
  const wanted = state.flags.autoOcrEnabled && !isQuickShot() && !state.regionSelecting
  if (wanted && !scanner.isRunning) {
    scanner.reset()
    scanner.start()
  } else if (!wanted && scanner.isRunning) {
    scanner.stop()
  }
}

/**
 * Say once, at startup, whether automatic scanning can work here at all.
 *
 * Better than finding out one failed tick at a time, and much better than the
 * alternative it replaces: a platform with no local observer used to mean every
 * captured frame went to the remote recogniser.
 */
async function reportObserver() {
  const status = await native.observerStatus().catch(() => null)
  if (!status) return
  log({
    check: 'auto-scan-observer',
    engine: status.engine,
    supported: status.supported,
    privateApi: status.private_api ?? status.privateApi ?? false,
    minimumOs: status.minimum_os ?? status.minimumOs ?? '',
    detail: status.detail
  })
}

// ---------------------------------------------------------------------------
// 3. Actions
// ---------------------------------------------------------------------------

/**
 * Actions native dispatches to every window.
 *
 * `actions::dispatch` in Rust applies everything it owns before emitting: it
 * toggles and shows or hides the overlay window itself, and the source picker
 * owns crop editing and select-and-scan. Only the two actions whose work belongs
 * in this window are handled here — handling any other would apply it twice.
 */
async function onAction(name) {
  switch (name) {
    case 'triggerScan':
      if(window.__KIMOCHI_PLATFORM__?.os==='linux'&&gnomeOverlay&&controllerHold) {
        await window.__TAURI__.event.emit('gnome-controller-toggle')
        for(let attempt=0;attempt<20&&controllerHold;attempt++)await new Promise(resolve=>setTimeout(resolve,25))
        if(controllerHold)throw new Error('Close controller navigation before scanning')
      }
      return isQuickShot() ? quickShot() : performScan()
    case 'openControllerMenu':
      if(window.__KIMOCHI_PLATFORM__?.os==='linux'&&gnomeOverlay) {
        if(controllerHold)return window.__TAURI__.event.emit('gnome-controller-toggle')
        await native.panel('controller-host','show_inactive')
        // The lazy WebKit host acknowledges opening through the shared hold flag.
        for(let attempt=0;attempt<20&&!controllerHold;attempt++){
          await window.__TAURI__.event.emit('gnome-controller-open')
          await new Promise(resolve=>setTimeout(resolve,100))
        }
        return
      }
      return controller.toggle()
    case 'playAudio':
      return playLatest()
    // The controller reads these back from the shared view, so this window owns
    // the flip. Native must pass these names through without touching the flag,
    // or the switch would toggle twice and appear dead.
    // Both edit the current source's region over the source itself; see editSourceRegion.
    case 'selectAndScan':
    case 'setCropArea':
      return editSourceRegion()
    case 'toggleAutoOcr':
      return native.setViewFlags({ autoOcrEnabled: !state.flags.autoOcrEnabled })
    case 'toggleTextOverlay':
      return toggleOverlayText()
    case 'toggleDebugOverlay':
      return native.setViewFlags({ debugOverlayVisible: !state.flags.debugOverlayVisible })
    // Cosmetic, and deliberately silent about failure: a hover must never put an
    // error on screen.
    case 'hoverSelectRegionOn':
    case 'hoverSelectRegionOff':
      state.hover.selectRegion = name.endsWith('On')
      return drawHover()
    // The window was brought to the front: its markings dissipate instead of waiting for the
    // pointer to leave the card.
    case 'hoverSourceDismiss':
      state.hover.source = false
      hoverPreview.stop()
      hover.dissipate()
      return drawHover()
    case 'hoverSourceOn':
    case 'hoverSourceOff':
      state.hover.source = name.endsWith('On')
      if (state.hover.source && state.hover.isWindow) hoverPreview.start()
      else hoverPreview.stop()
      return drawHover()
    default:
      // Everything else native has already applied before emitting.
      return undefined
  }
}

/** How often the pointer is read while the region editor is up. */
const POINTER_POLL_MS = 30

/**
 * Feed the editor the pointer's position for as long as it is on screen, and, when `onDisplay` is
 * given, carry the overlay to whichever display the cursor moves to while the editor is idle (no
 * box, no drag) or still showing the box it opened with. A box the reader has drawn or touched
 * keeps the overlay where it is. `onDisplay` returns the box to open with on the new display.
 */
async function followPointer(selector, onDisplay) {
  while (selector.active) {
    // Mid-drag the editor has the pointer itself and nothing here can change; stay out of the
    // way of its frames.
    if (selector.dragging) {
      await new Promise((done) => setTimeout(done, POINTER_POLL_MS))
      continue
    }
    let at = null
    try {
      at = await native.pointerLocation()
    } catch {
      at = null
    }
    if (!selector.active) return
    const display = at?.display
    const movable = selector.idle || selector.pristine
    if (onDisplay && display?.bounds && movable && !sameRect(display.bounds, state.origin)) {
      try {
        await native.placeOverlay(display.bounds)
        state.origin = display.bounds
        draw()
        log({ check: 'region-display-moved', display: display.id })
        if (!selector.active) return
        // The box on the display left behind means nothing here; start with this one's own.
        selector.reset(onDisplay(display) ?? null)
      } catch (error) {
        log({ check: 'region-display-move-failed', error: String(error?.message ?? error) })
      }
      if (!selector.active) return
      selector.pointerAt({ x: at.x - state.origin.x, y: at.y - state.origin.y }, { snap: true })
    } else if (at && state.origin) {
      const local = { x: at.x - state.origin.x, y: at.y - state.origin.y }
      const inside =
        local.x >= 0 &&
        local.y >= 0 &&
        local.x < state.origin.width &&
        local.y < state.origin.height
      selector.pointerAt(inside ? local : null)
    }
    await new Promise((done) => setTimeout(done, POINTER_POLL_MS))
  }
}

/**
 * Run the region editor over the display the overlay covers and return what was confirmed.
 *
 * The editor itself is `ui/region-select.js`, shared by "Select region" and Quick Shot; it
 * reports a rectangle in this window's CSS points. What has to be right lives here: the overlay is
 * click-through by default, so it claims the whole display for the duration (`regionSelecting`
 * feeds `hitRects`). It never takes the keyboard — it cannot, and activating the app to get it
 * would bring every Kimochi window in front of the game — so Escape and Return arrive as global
 * shortcuts held for the editor's lifetime and are replayed to it as key presses.
 *
 * For the same reason it sees no hover events, so the pointer is polled natively to keep the
 * editor's cursor bubble beside the cursor. With `onDisplay` (Quick Shot), the overlay also follows
 * the cursor onto another display while nothing is drawn yet, and `onDisplay` is told where it went.
 *
 * `area`, `initial` and `picture` pass through to the editor (see ui/region-select.js); `onStart`
 * gets the running editor, for a caller that keeps its picture fresh.
 *
 * @param {string} confirmLabel
 * @param {{onDisplay?: (display: object) => object|null|void, area?: object, initial?: object,
 *   picture?: object, onStart?: (selector: object) => void}} [options]
 * @returns {Promise<{x:number,y:number,width:number,height:number}|null>}
 */
async function editRegion(confirmLabel, { onDisplay, area, initial, picture, onStart } = {}) {
  let RegionSelect
  try {
    ;({ RegionSelect } = await import('./region-select.js'))
  } catch (error) {
    log({
      check: 'region-editor-unavailable',
      error: String(error?.message ?? error),
      note: 'ui/region-select.js is missing from the build; the region drag cannot be shown.'
    })
    return null
  }

  state.regionSelecting = true
  syncAutoScanner()
  const stopKeys = await native.listen('region-key', ({ payload }) => {
    if (payload?.key)
      document.dispatchEvent(
        new KeyboardEvent(payload.type === 'keyup' ? 'keyup' : 'keydown', {
          key: payload.key,
          bubbles: true
        })
      )
  })
  try {
    await native.regionKeys(true)
    if (window.__KIMOCHI_PLATFORM__?.os === 'linux' && waylandLayer) await publishRegions()
    const appearance = setting('appearance')
    const theme =
      appearance === 'light' || appearance === 'dark'
        ? appearance
        : matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
    const selector = new RegionSelect({
      container: document.body,
      confirmLabel,
      theme,
      area,
      initial,
      picture
    })
    const running = selector.start()
    onStart?.(selector)
    void followPointer(selector, onDisplay)
    const result = await running.catch(() => null)
    selector.destroy()
    const rect = result?.local
    return rect && rect.width >= 1 && rect.height >= 1 ? rect : null
  } finally {
    // Whatever happened, the overlay must stop swallowing clicks, and the game gets its
    // Escape and Return back.
    state.regionSelecting = false
    syncAutoScanner()
    stopKeys()
    await native.regionKeys(false)
    if (window.__KIMOCHI_PLATFORM__?.os === 'linux' && waylandLayer) await publishRegions()
  }
}

/** Points in the overlay to capture pixels of a display or source with `bounds` at `scale`. */
function cropFor(rect, origin, bounds, scale) {
  return {
    x: Math.max(0, Math.round((rect.x + origin.x - bounds.x) * scale)),
    y: Math.max(0, Math.round((rect.y + origin.y - bounds.y) * scale)),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
    reference_width: Math.round(bounds.width * scale),
    reference_height: Math.round(bounds.height * scale)
  }
}

/** How often the window's picture is refreshed while its region is being edited. */
const REGION_PICTURE_MS = 1500

/**
 * A display's source id, as native minted it. The constructed form is only for a
 * backend that predates `source_id` on `DisplayInfo`, which was always macOS.
 */
const displaySourceId = (display) => display?.source_id ?? `macos:display:${display.id}`
const scaleOf = (display) => display?.scale_factor ?? display?.scaleFactor ?? 1

/** A saved crop (capture pixels of `bounds`) as a rectangle in overlay points over `origin`. */
function cropToLocal(crop, origin, bounds) {
  if (!crop?.reference_width || !crop?.reference_height) return null
  const sx = bounds.width / crop.reference_width
  const sy = bounds.height / crop.reference_height
  return {
    x: Math.round(bounds.x - origin.x + crop.x * sx),
    y: Math.round(bounds.y - origin.y + crop.y * sy),
    width: Math.round(crop.width * sx),
    height: Math.round(crop.height * sy)
  }
}

/** The display holding most of `bounds` (its centre), from `native.displays()`. */
function displayHolding(bounds, displays) {
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2
  return (
    displays.find(
      (d) =>
        cx >= d.bounds.x &&
        cy >= d.bounds.y &&
        cx < d.bounds.x + d.bounds.width &&
        cy < d.bounds.y + d.bounds.height
    ) ?? displays[0]
  )
}

async function placeOverlayOn(bounds) {
  if (sameRect(state.origin, bounds)) return
  await native.placeOverlay(bounds)
  state.origin = bounds
  // Text from an earlier scan was positioned for the display the overlay left.
  draw()
}

/**
 * Edit the current source's region over the source itself — the one region editor, shared with
 * Quick Shot — then save it, and scan it unless Auto OCR is already reading.
 *
 * A screen is edited in place and is not a fixed choice: the editor follows the cursor to any
 * display, and the display the region is drawn on becomes the source. A window is shown as its
 * latest screenshot, kept fresh, over a dimmed screen — the real window may be covered — and the
 * region is limited to it.
 */
async function editSourceRegion() {
  if (state.regionSelecting) return
  const sourceId = await native.selectedSource()
  if (!sourceId) {
    log({ check: 'region-edit-skipped', reason: 'no source selected' })
    return
  }
  try {
    // The view's own description of the selection says what it is; the id is read
    // (never pattern-matched on a platform name) only when the view has not caught up.
    const described = state.viewSource?.sourceId === sourceId ? state.viewSource : null
    const kind = described?.kind ?? described?.type ?? parseSourceId(sourceId)?.kind
    const desktopCrop = window.__KIMOCHI_PLATFORM__?.os === 'linux' && waylandDisabled && await gnomeCropAvailable(sourceId)
    const saved = desktopCrop ? await editGnomeRegion(sourceId)
      : window.__KIMOCHI_PLATFORM__?.os === 'linux' && waylandDisabled
      ? await editLinuxSourceImage(sourceId)
      : window.__KIMOCHI_PLATFORM__?.os === 'linux' && waylandLayer
      ? await editPortalRegion(sourceId, kind)
      : kind === 'window'
        ? await editWindowRegion(sourceId)
        : await editScreenRegion(sourceId)
    if (!saved) {
      log({ check: 'region-edit-cancelled' })
      return
    }
    // Committing changes the selection, so anything in flight belongs to the old one.
    generation.bump()
    if (window.__KIMOCHI_PLATFORM__?.os === 'linux' && (waylandLayer || waylandDisabled)) {
      // Consume the committed crop before a scan snapshots its generation. The native
      // state event otherwise arrives during OCR and invalidates this very result.
      await processView(await native.snapshot())
      for (let attempt = 0; handling || pendingView; attempt++) {
        if (attempt >= 100) throw new Error('Committed crop did not synchronize with the reader.')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    if (!state.flags.autoOcrEnabled) await performScan()
  } catch (error) {
    log({ check: 'region-edit-error', error: String(error?.message ?? error) })
    publish({ status: `Editing the region failed: ${error?.message ?? error}` })
  }
}

/** A portal screen maps to the sole GNOME monitor; never infer a window origin. */
async function gnomeCropAvailable(sourceId = null) {
  if (!waylandDisabled || window.__KIMOCHI_PLATFORM__?.os !== 'linux') return false
  let status = await native.invoke('gnome_overlay', {operation:'status', payload:null})
  if (sourceId?.startsWith('portal:window:') && status.available && status.windowTracking && status.tracked?.sourceId !== sourceId) {
    const frame = await native.sourceHoverPreview(sourceId)
    if (frame?.width && frame?.height) {
      await native.invoke('gnome_overlay', {operation:'track', payload:{operation:'match',sourceId,width:frame.width,height:frame.height,name:state.viewSource?.name}})
      status = await native.invoke('gnome_overlay', {operation:'status', payload:null})
    }
  }
  return status.available && status.cropEditor && status.monitors?.length === 1 &&
    (!sourceId?.startsWith('portal:window:') || status.tracked?.sourceId === sourceId)
}

async function editGnomeRegion(sourceId, {quick = false} = {}) {
  if (!/^portal:(display|window):[0-9]+$/.test(sourceId)) throw new Error('Desktop crop requires a shared screen or linked window.')
  state.regionSelecting = true
  syncAutoScanner()
  let restoreLog = false
  let selected = false
  try {
    if (quick) {
      restoreLog = Boolean((await native.panel('log','inspect')).visible)
      if (restoreLog) await native.panel('log','hide')
    }
    await gnomeOverlay?.pause()
    const frame = await native.sourceHoverPreview(sourceId)
    if (!frame?.width || !frame?.height) throw new Error('No shared screen frame available. Choose a screen first.')
    const {selectGnomeCrop} = await import('./gnome-crop.js')
    const crop = await selectGnomeCrop(native, {sourceId, frame, initial:state.crop, quick, theme:setting('appearance') === 'light' ? 'light' : setting('appearance') === 'dark' ? 'dark' : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'})
    if (!crop) return false
    if (await native.selectedSource() !== sourceId) throw new Error('The shared screen changed while editing. Open the editor again.')
    if (quick) { selected = true; return crop }
    await native.commitSource(sourceId, crop)
    log({check:'region-saved', sourceId, crop, editor:'gnome-shell'})
    return true
  } finally {
    state.regionSelecting = false
    syncAutoScanner()
    void gnomeOverlay?.update()
    if (restoreLog && !selected) await native.panel('log','show').catch(() => {})
  }
}

/** A source-image editor in the main window when a native desktop layer is unavailable. */
async function editLinuxSourceImage(sourceId) {
  state.regionSelecting = true
  syncAutoScanner()
  const requestId = crypto.randomUUID()
  let stop = () => {}
  let timer
  try {
    // Shell targets sit above application windows; release them before editor input.
    await gnomeOverlay?.pause().catch(() => {})
    const frame = await native.invoke('source_preview', { sourceId })
    let finish
    const result = new Promise((resolve, reject) => {
      finish = resolve
      timer = setTimeout(() => reject(new Error('Crop editor timed out. Open it again to continue.')), 600000)
    })
    stop = await native.listen('linux:source-crop-result', ({ payload }) => {
      if (payload?.requestId === requestId) finish(Boolean(payload.saved))
    })
    // Register the reply listener before the main window can submit the editor.
    await native.panel('log', 'show')
    await window.__TAURI__.event.emit('linux:edit-source-crop', { requestId, sourceId, frame, crop: state.crop })
    const saved = await result
    if (saved) log({ check: 'region-saved', sourceId, editor: 'linux-source-image' })
    return saved
  } finally {
    clearTimeout(timer)
    stop()
    try {
      await window.__TAURI__.event.emit('linux:close-source-crop', { requestId })
    } finally {
      state.regionSelecting = false
      syncAutoScanner()
      void gnomeOverlay?.update()
    }
  }
}

/** Portal captures have pixel dimensions, but no desktop display catalogue or window origin. */
async function editPortalRegion(sourceId, kind, { quick = false } = {}) {
  const frame = await native.sourceHoverPreview(sourceId)
  if (!frame?.width || !frame?.height) {
    throw new Error('No portal frame available. Choose a source in the system picker first.')
  }
  // A hidden layer has not received its output-sized configure yet (initially 1×1).
  // Map it for the editor before reading its viewport, and unwind even if setup fails.
  state.regionSelecting = true
  state.origin = { x: 0, y: 0, width: Math.max(1, innerWidth), height: Math.max(1, innerHeight) }
  try {
    await native.regionKeys(true)
    await publishRegions()
    for (let attempt = 0; innerWidth <= 1 || innerHeight <= 1; attempt++) {
      if (attempt >= 100) throw new Error('Wayland crop surface did not receive its screen size.')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const origin = { x: 0, y: 0, width: innerWidth, height: innerHeight }
    state.origin = origin
    // Window streams are edited against their screenshot, never a fabricated screen position.
    const fit = kind === 'window'
      ? Math.min(origin.width / frame.width, origin.height / frame.height)
      : null
    const bounds = fit === null ? origin : {
      x: (origin.width - frame.width * fit) / 2,
      y: (origin.height - frame.height * fit) / 2,
      width: frame.width * fit,
      height: frame.height * fit
    }
    const rect = await editRegion(quick ? 'Scan' : 'Save', {
      area: bounds,
      initial: !quick && state.crop ? cropToLocal(state.crop, origin, bounds) : null,
      picture: kind === 'window' ? bounds : undefined,
      onStart: kind === 'window' ? (selector) => void selector.setPicture(frame.url) : undefined
    })
    if (!rect) return false
    const sx = frame.width / bounds.width
    const sy = frame.height / bounds.height
    const crop = {
      x: Math.max(0, Math.round((rect.x - bounds.x) * sx)),
      y: Math.max(0, Math.round((rect.y - bounds.y) * sy)),
      width: Math.round(rect.width * sx),
      height: Math.round(rect.height * sy),
      reference_width: frame.width,
      reference_height: frame.height
    }
    if (crop.width <= 0 || crop.height <= 0) return false
    if (quick) return crop
    await native.commitSource(sourceId, crop)
    log({ check: 'region-saved', kind, sourceId, crop, editor: 'wayland-layer' })
    return true
  } finally {
    state.regionSelecting = false
    syncAutoScanner()
    await native.regionKeys(false)
    await publishRegions()
  }
}

async function editScreenRegion(sourceId) {
  const displays = await native.displays()
  const current = displays.find((d) => displaySourceId(d) === sourceId) ?? null
  const start = (await native.pointerDisplay()) ?? current ?? displays[0]
  if (!start?.bounds) return false
  await placeOverlayOn(start.bounds)

  // The saved region shows on its own display only.
  const initialFor = (display) =>
    display && displaySourceId(display) === sourceId && state.crop
      ? cropToLocal(state.crop, display.bounds, display.bounds)
      : null
  let target = start
  const rect = await editRegion('Save', {
    initial: initialFor(start),
    onDisplay: (next) => {
      target = next
      return initialFor(next)
    }
  })
  if (!rect) return false
  const crop = cropFor(rect, target.bounds, target.bounds, scaleOf(target))
  if (crop.width <= 0 || crop.height <= 0) return false
  const chosen = displaySourceId(target)
  await native.commitSource(chosen, crop)
  log({ check: 'region-saved', kind: 'display', sourceId: chosen, switched: chosen !== sourceId, crop })
  return true
}

async function editWindowRegion(sourceId) {
  const bounds = state.sourceBounds ?? state.info?.source_bounds ?? null
  if (!bounds) {
    log({ check: 'region-edit-skipped', reason: 'window bounds unknown' })
    publish({ status: 'Could not find the window to edit its region. Try again in a moment.' })
    return false
  }
  const display = displayHolding(bounds, await native.displays())
  if (!display?.bounds) return false
  const origin = display.bounds
  await placeOverlayOn(origin)

  const picture = {
    x: bounds.x - origin.x,
    y: bounds.y - origin.y,
    width: bounds.width,
    height: bounds.height
  }
  // The part of the window on this display.
  const left = Math.max(0, picture.x)
  const top = Math.max(0, picture.y)
  const area = {
    x: left,
    y: top,
    width: Math.min(origin.width, picture.x + picture.width) - left,
    height: Math.min(origin.height, picture.y + picture.height) - top
  }
  if (area.width <= 0 || area.height <= 0) return false

  // The capture's own size, once known, is the crop's reference; until then, points × scale.
  let frame = null
  const refresh = async (selector) => {
    while (selector.active) {
      // A new picture is a full-size capture and decode: never while the box is being dragged.
      if (selector.dragging) {
        await new Promise((done) => setTimeout(done, 200))
        continue
      }
      try {
        const preview = await native.sourceHoverPreview(sourceId)
        if (!selector.active) return
        if (preview?.url && !selector.dragging) {
          frame = preview
          void selector.setPicture(preview.url)
        }
      } catch {
        // Busy behind a scan, or the window is briefly unavailable: keep the last picture.
      }
      await new Promise((done) => setTimeout(done, REGION_PICTURE_MS))
    }
  }

  const rect = await editRegion('Save', {
    area,
    picture,
    initial: state.crop ? cropToLocal(state.crop, origin, bounds) : null,
    onStart: (selector) => void refresh(selector)
  })
  if (!rect) return false
  const scale = frame?.width ? frame.width / bounds.width : scaleOf(display)
  const crop = cropFor(rect, origin, bounds, scale)
  if (frame?.width && frame?.height) {
    crop.reference_width = frame.width
    crop.reference_height = frame.height
  }
  if (crop.width <= 0 || crop.height <= 0) return false
  await native.commitSource(sourceId, crop)
  log({ check: 'region-saved', kind: 'window', sourceId, crop })
  return true
}

/**
 * Quick Shot: draw a region on the display under the pointer, scan it, show the Log.
 *
 * Nothing is chosen or saved: the region is captured from that display directly as a one-off job,
 * so the reader's chosen source and its crop are untouched, and the text is published detached
 * from them (no source name on the history entry, so no session switch).
 */
async function quickShot() {
  if (state.regionSelecting) return
  try {
    if (window.__KIMOCHI_PLATFORM__?.os === 'linux' && (await native.capabilities()).session.backend === 'wayland') {
      const { runWaylandQuickShot } = await import('./linux-quick-shot.js')
      await runWaylandQuickShot({
        available: waylandLayer || await gnomeCropAvailable(),
        catalog: () => native.invoke('enumerate'),
        pick: () => native.invoke('capture_pick_source', { fresh: true }),
        edit: (id) => waylandLayer ? editPortalRegion(id, 'display', { quick: true }) : editGnomeRegion(id, {quick:true}),
        scan: async (sourceId, crop) => {
          await processView(await native.snapshot())
          for (let attempt = 0; handling || pendingView; attempt++) {
            if (attempt >= 100) throw new Error('Screen share did not synchronize with the reader.')
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          log({ check: 'quick-shot', display: sourceId, crop, editor: waylandLayer ? 'wayland-layer' : 'gnome-shell' })
          try {
            return await performScan({ generation: generation.current, sourceId,
              source: { sourceId, kind: 'display', name: 'Quick Shot' },
              request: { source_id: sourceId, crop }, detached: true })
          } finally {
            await native.panel('log', 'show').catch(() => undefined)
          }
        },
        status: (status) => publish({ scanning: false, status }),
        log
      })
      return
    }
    const display = await native.pointerDisplay()
    if (!display?.bounds) {
      log({ check: 'quick-shot-skipped', reason: 'no display under the pointer' })
      return
    }
    const bounds = display.bounds
    if (!sameRect(state.origin, bounds)) {
      await native.placeOverlay(bounds)
      state.origin = bounds
      // Text from an earlier scan was positioned for the display the overlay left.
      draw()
    }

    // The overlay follows the cursor across displays until a box is drawn; read on the one used.
    let target = display
    const rect = await editRegion('Scan', {
      onDisplay: (next) => {
        target = next
      }
    })
    if (!rect) {
      log({ check: 'quick-shot-cancelled' })
      return
    }
    const crop = cropFor(rect, target.bounds, target.bounds, target.scale_factor ?? 1)
    const sourceId = displaySourceId(target)
    log({ check: 'quick-shot', display: target.id, crop })

    // The Log comes forward first, so the result is seen arriving.
    void native.panel('log', 'show').catch(() => undefined)
    await performScan({
      generation: generation.current,
      sourceId,
      source: { sourceId, kind: 'display', name: 'Quick Shot' },
      request: { source_id: sourceId, crop },
      detached: true
    })
  } catch (error) {
    log({ check: 'quick-shot-error', error: String(error?.message ?? error) })
    publish({ scanning: false, status: `Quick Shot failed: ${error?.message ?? error}` })
  }
}

/**
 * One control for "is the OCR overlay on".
 *
 * Both gates have to move together or the control is decorative: the persisted
 * `liveOverlayEnabled` defaults to off, so flipping only the session flag would
 * leave a switch that reads as on while nothing is drawn, and would send the
 * user hunting for a second switch in Settings. Turning off touches only the
 * session flag, leaving the persisted preference the Settings panel shows.
 */
async function toggleOverlayText() {
  const next = nextOverlayToggle({
    liveOverlayEnabled: setting('liveOverlayEnabled'),
    textOverlayVisible: state.flags.textOverlayVisible
  })
  if (next.liveOverlayEnabled !== setting('liveOverlayEnabled')) {
    await native.setSetting('liveOverlayEnabled', next.liveOverlayEnabled)
  }
  await native.setViewFlags({ textOverlayVisible: next.textOverlayVisible })
  // The view flag round-trips through the shared state event, but the local draw
  // must not wait for it: the user pressed a switch and expects the text now.
  state.flags = { ...state.flags, textOverlayVisible: next.textOverlayVisible }
  draw()
}

/**
 * Turn the overlay's text on or off, through the same switch the main window shows. On needs
 * both gates, as the toggle does; off only lowers the session flag, so the persisted setting
 * keeps the reader's choice.
 */
async function setOverlayText(visible) {
  if (visible && !setting('liveOverlayEnabled')) await native.setSetting('liveOverlayEnabled', true)
  if (state.flags.textOverlayVisible !== visible) await native.setViewFlags({ textOverlayVisible: visible })
  state.flags = { ...state.flags, textOverlayVisible: visible }
  draw()
}

async function playLatest() {
  const latest = listHistory()[0]?.text ?? ''
  if (!latest) return
  try {
    await speak(latest, {
      audioSettings: setting('audioSettings'),
      serverSettings: setting('serverSettings')
    })
  } catch (error) {
    log({ check: 'tts-error', error: String(error?.message ?? error) })
  }
}

// ---------------------------------------------------------------------------
// 4. Yomitan host, brought up without blocking the pipeline
// ---------------------------------------------------------------------------

const relayTargets = new Set()
let extensionApi = null
let openInIframe = null

/** Relayed windows share this window's extension storage rather than forking it. */
function relayStorage({ area, action, keys, values }) {
  const store = chrome.storage[area === 'session' ? 'session' : 'local']
  switch (action) {
    case 'get':
      return store.get(keys ?? null)
    case 'set':
      return store.set(values)
    case 'remove':
      return store.remove(keys)
    case 'clear':
      return store.clear()
    case 'getBytesInUse':
      return store.getBytesInUse()
    default:
      throw Error(`Unsupported storage action: ${action}`)
  }
}

/**
 * Answer extension messages for windows that have no backend of their own.
 *
 * The log panel and the Yomitan settings window run the original frontend but
 * must not stand up a second backend: two owners of one IndexedDB dictionary
 * database is a corruption risk. Only JSON crosses, which suffices because
 * Yomitan's dictionary API is entirely `sendMessage`-based.
 */
/**
 * Settles when the dictionary backend is up (or has failed to start). Windows come up in an
 * order nobody controls, so a relayed request that arrives while the backend is still starting
 * waits for it here instead of being rejected, which used to surface in the Log as "Dictionary
 * backend is not ready" on launch.
 */
let settleBackend
const backendSettled = new Promise((resolve) => (settleBackend = resolve))
/** Bounded like the startup itself: the backend signals readiness within 30s or fails. */
const BACKEND_WAIT_MS = 35000

async function whenBackendReady() {
  if (state.yomitan.ready) return
  if (!state.yomitan.error) {
    await Promise.race([
      backendSettled,
      new Promise((resolve) => setTimeout(resolve, BACKEND_WAIT_MS))
    ])
  }
  if (!state.yomitan.ready) throw Error(state.yomitan.error ?? 'Dictionary backend is not ready')
}

async function handleRelay(from, payload) {
  if (!payload || typeof payload !== 'object') return
  if (payload.kind === 'hello') {
    relayTargets.add(from)
    await native.relay(from, { kind: 'ready', backend: state.yomitan.ready })
    return
  }
  if (payload.kind === 'open') {
    void openYomitan(payload.url)
    return
  }
  if (payload.kind !== 'request') return
  relayTargets.add(from)
  try {
    await whenBackendReady()
    const result =
      payload.message?.action === '__storage'
        ? await relayStorage(payload.message.params)
        : await hub.message(
            { id: `relay:${from}`, win: window, events: { onMessage: { listeners: new Set() } } },
            [...hub.contexts.values()].filter((c) => c.background),
            payload.message
          )
    await native.relay(from, { kind: 'response', id: payload.id, result })
  } catch (error) {
    await native.relay(from, {
      kind: 'response',
      id: payload.id,
      error: String(error?.message ?? error)
    })
  }
}

/**
 * Prefer a real native settings window, as Electron has, and fall back to the
 * in-overlay iframe when that window does not exist. Either way the single
 * backend in this realm serves it.
 */
async function openYomitan(url) {
  try {
    await native.panel('yomitan', 'show')
    await native.relay('yomitan', { kind: 'navigate', url })
    return
  } catch {
    // No native window for the extension pages; present them here instead.
  }
  void native.setDictionaryOpen(true)
  openInIframe?.(url)
}

async function startYomitan() {
  if (!hub) throw Error('Extension host shim did not install')

  await import('/spike/network-bundle.js')
  hub.manifest = await fetch('/manifest.json').then((r) => r.json())
  hub.local = await native.invoke('storage_load')
  if (!hub.local.options) {
    const { OptionsUtil } = await import('/js/data/options-util.js')
    const util = new OptionsUtil()
    await util.prepare()
    const options = util.getDefault()
    options.profiles[0].options.general.showGuide = false
    await util.save(options)
  }

  const api = async (action, params) => {
    const response = await chrome.runtime.sendMessage({ action, params })
    if (response?.error) throw Error(JSON.stringify(response.error))
    return response?.result
  }

  const ready = new Promise((resolve, reject) => {
    const listener = (message) => {
      if (message.action !== 'applicationBackendReady') return
      chrome.runtime.onMessage.removeListener(listener)
      resolve()
    }
    chrome.runtime.onMessage.addListener(listener)
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener)
      reject(Error('Dictionary backend did not signal readiness within 30s'))
    }, 30000)
  })
  const backend = document.createElement('iframe')
  backend.id = 'backend'
  backend.src = '/spike/background.html'
  document.body.append(backend)
  await ready
  // Before the frontend exists, so no popup can be built without being seen.
  await capturePopups()
  await installApiLookup()
  await import('/js/app/content-script-wrapper.js')

  extensionApi = api
  window.pocApi = api
  openInIframe = hub.open.bind(hub)
  hub.open = (url) => {
    void openYomitan(url)
    return { id: 1, windowId: 1, url }
  }

  // Backend broadcasts (readiness, database updates) must reach relayed windows
  // too, or their frontends never finish starting up.
  chrome.runtime.onMessage.addListener((message) => {
    for (const target of relayTargets) void native.relay(target, { kind: 'broadcast', message })
  })

  // Extension storage changes are broadcast the same way. Relayed windows read
  // and write through this one store, so without this a profile or option
  // changed in the settings window would be invisible to code watching for it
  // in the log window.
  chrome.storage.onChanged.addListener((changes, area) => {
    for (const target of relayTargets) {
      void native.relay(target, { kind: 'storage-changed', changes, area })
    }
  })

  state.yomitan.ready = true
  settleBackend()
  log({
    check: 'yomitan-ready',
    dictionaries: (await api('getDictionaryInfo')).map((d) => d.title)
  })
}

/**
 * Import the authored three-entry fixture archive.
 *
 * Diagnostics only, never called during normal startup: a reader's dictionary
 * list belongs to them, and an app that silently installs a synthetic dictionary
 * on first run is doing something they did not ask for. `ui/checks.js` and manual
 * verification call this explicitly.
 */
async function importFixtureDictionary() {
  if (!extensionApi) throw Error('Dictionary backend is not ready')
  const title = 'Tauri Spike Fixture v2'
  const existing = await extensionApi('getDictionaryInfo')
  if (existing.some((d) => d.title === title)) return { alreadyInstalled: true, title }

  const { DictionaryWorker } = await import('/js/dictionary/dictionary-worker.js')
  const imported = await new DictionaryWorker().importDictionary(
    await fetch('/spike/fixture.zip').then((r) => r.arrayBuffer()),
    { prefixWildcardsSupported: false },
    null
  )
  if (imported.errors.length) throw Error(JSON.stringify(imported.errors))

  const options = await extensionApi('optionsGetFull')
  const profile = options.profiles[options.profileCurrent].options
  if (!profile.dictionaries.some((d) => d.name === title)) {
    profile.dictionaries.push({
      name: title,
      alias: '',
      partsOfSpeechFilter: true,
      useDeinflections: true,
      enabled: true,
      allowSecondarySearches: false,
      definitionsCollapsible: 'not-collapsible'
    })
    await extensionApi('setAllSettings', { value: options, source: 'kimochi-fixture' })
    await extensionApi('triggerDatabaseUpdated', { type: 'dictionary', cause: 'import' })
  }
  log({ check: 'fixture-dictionary-imported', summary: imported.result })
  return imported.result
}

/** Yomitan closes its popup on a pointerdown outside the popup's own frame. */
function dismissPopup() {
  window.dispatchEvent(
    new PointerEvent('pointerdown', { pointerType: 'mouse', button: 0, isPrimary: true })
  )
}

// ---------------------------------------------------------------------------
// 4b. Where the dictionary popup actually is
// ---------------------------------------------------------------------------

/**
 * The popups the original factory has built in this window.
 *
 * They cannot be found from the DOM — see host/popup-bridge.js — and without
 * their rectangles the overlay is click-through over its own dictionary.
 */
let livePopups = new Set()

async function capturePopups() {
  const { observePopups } = await import('/spike/popup-bridge.js')
  ;({ popups: livePopups } = await observePopups({
    log,
    window: 'overlay',
    // A popup opens and closes between two ticks of the region loop; 100 ms of
    // missing rectangle is 100 ms in which its first click is thrown away and
    // counted as a dismissal.
    onChange: () => void publishRegions()
  }))
}

/**
 * Scroll the open dictionary popup, or jump between its definitions, for the controller's right
 * stick and shoulder buttons.
 *
 * Yomitan's popup is a same-origin frame in this window, so it is scrolled directly: its
 * definitions are the per-dictionary `.definition-item`s, or whole `.entry`s when no entry
 * holds more than one. The Kimochi pop-up is its own window and is asked by event.
 */
function controlPopup(control) {
  if ((setting('yomitanSettings')?.popupType ?? 'builtin') === 'custom-api') {
    void globalThis.__TAURI__?.event?.emit('popover:control', control)
    return
  }
  const popup = [...(livePopups ?? [])].find((candidate) => candidate.isVisibleSync?.())
  let doc = null
  try {
    doc = popup?._frame?.contentDocument ?? null
  } catch {
    // A cross-origin frame: nothing to scroll from here. Reported below.
  }
  const scroller = doc?.getElementById('content-scroll')
  if (control.step || !scroller) {
    // Each jump, and any scroll that finds no popup, says how far it got: a jump that does
    // nothing visible is otherwise impossible to tell apart from one that never arrived.
    const report = {
      check: 'controller-popup-control',
      step: control.step ?? null,
      popups: livePopups?.size ?? 0,
      visible: Boolean(popup),
      frame: Boolean(popup?._frame),
      document: Boolean(doc),
      scroller: Boolean(scroller),
      scrollTop: scroller?.scrollTop ?? null,
      scrollHeight: scroller?.scrollHeight ?? null,
      clientHeight: scroller?.clientHeight ?? null
    }
    if (control.step || Date.now() - lastPopupReport > 2000) {
      lastPopupReport = Date.now()
      log(report)
    }
  }
  if (!scroller) return
  if (control.scroll) {
    if (jump) cancelAnimationFrame(jump.frame)
    jump = null
    scroller.scrollTop += control.scroll
  }
  if (control.step) void stepEntry(popup._frame, scroller, control.step)
}

/**
 * Move to the next or previous entry with Yomitan's own entry navigation — the `nextEntry` and
 * `previousEntry` hotkeys (Alt+↓ / Alt+↑ by default) — by sending the popup the keystroke the
 * reader's options bind to it. Yomitan then scrolls, marks the current entry and handles its
 * sticky header itself, exactly as it does from the keyboard. Only when no such hotkey is
 * bound does the overlay scroll the entries itself.
 */
async function stepEntry(frame, scroller, step) {
  const before = scroller.scrollTop
  const hotkey = await entryHotkey(step > 0 ? 'nextEntry' : 'previousEntry')
  const win = frame.contentWindow
  let handled = false
  if (hotkey && win) {
    const event = new win.KeyboardEvent('keydown', {
      key: hotkey.key.replace(/^Key/, '').toLowerCase(),
      code: hotkey.key,
      altKey: hotkey.modifiers.includes('alt'),
      ctrlKey: hotkey.modifiers.includes('ctrl'),
      shiftKey: hotkey.modifiers.includes('shift'),
      metaKey: hotkey.modifiers.includes('meta'),
      bubbles: true,
      cancelable: true
    })
    win.document.dispatchEvent(event)
    // Yomitan prevents the default of a keystroke it acted on.
    handled = event.defaultPrevented
  }
  if (!handled) {
    const doc = frame.contentDocument
    jumpDefinition(
      scroller,
      doc.getElementById('content-body') ?? scroller,
      [...doc.querySelectorAll('.entry')],
      step
    )
  }
  setTimeout(() => {
    log({
      check: 'controller-entry-step',
      step,
      hotkey: hotkey ? `${hotkey.modifiers.join('+')}+${hotkey.key}` : null,
      handled,
      before,
      after: scroller.scrollTop
    })
  }, 400)
}

/** The reader's popup hotkey for an entry action, from the current Yomitan profile. */
async function entryHotkey(action) {
  try {
    const options = await extensionApi?.('optionsGetFull')
    const profile = options?.profiles?.[options.profileCurrent]?.options
    const hotkey = profile?.inputs?.hotkeys?.find(
      (entry) =>
        entry.action === action &&
        entry.enabled !== false &&
        typeof entry.key === 'string' &&
        (entry.scopes ?? []).includes('popup')
    )
    return hotkey ? { key: hotkey.key, modifiers: hotkey.modifiers ?? [] } : null
  } catch {
    return null
  }
}
let lastPopupReport = 0

/** A definition jump in progress: where it is headed, so a quick second press continues from there. */
let jump = null
const JUMP_MS = 220

/**
 * Scroll `scroller` so the next (`step` 1) or previous (-1) of `targets` is at its top.
 *
 * Positions are measured against `body`, the scrolled content, the way Yomitan measures its own
 * entry navigation: the popup's content is scaled, so a rectangle and `scrollTop` are not in the
 * same units, and mixing them sent every jump the wrong way. The scroll is animated here rather
 * than with `scrollTo({behavior: 'smooth'})`, which the popup frame cut short after a few
 * points.
 */
function jumpDefinition(scroller, body, targets, step) {
  if (!targets.length) return
  const bodyTop = body.getBoundingClientRect().top
  const offsets = targets.map((target) => target.getBoundingClientRect().top - bodyTop)
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  // Where the popup is, or is about to be: a press during a jump counts from its destination.
  const from = jump?.scroller === scroller ? jump.to : scroller.scrollTop
  let current = 0
  offsets.forEach((offset, index) => {
    if (offset <= from + 8) current = index
  })
  // At the bottom, the last definitions cannot reach the top; step past whichever is showing.
  if (step > 0 && from >= max - 1) return
  const next = Math.max(0, Math.min(targets.length - 1, current + step))
  const to = Math.min(max, next === 0 ? 0 : Math.max(0, offsets[next] - 6))
  animateScroll(scroller, to)
  targets[next].animate?.(
    [{ backgroundColor: 'rgba(125, 211, 252, 0.2)' }, { backgroundColor: 'transparent' }],
    { duration: 700, easing: 'ease-out' }
  )
}

function animateScroll(scroller, to) {
  if (jump) cancelAnimationFrame(jump.frame)
  const start = performance.now()
  const from = scroller.scrollTop
  const current = { scroller, to, frame: 0 }
  jump = current
  const tick = (now) => {
    const t = Math.min(1, (now - start) / JUMP_MS)
    scroller.scrollTop = from + (to - from) * (1 - (1 - t) ** 3)
    if (t < 1 && jump === current) current.frame = requestAnimationFrame(tick)
    else if (jump === current) jump = null
  }
  current.frame = requestAnimationFrame(tick)
}

/** Desktop rectangles for the visible popup chain; see ui/regions.ts. */
const popupRects = () => popupHitRects(livePopups, state.origin)

// ---------------------------------------------------------------------------
// 5. Hit regions and the shared view
// ---------------------------------------------------------------------------

/**
 * The rectangles where this window takes the mouse, in desktop points.
 *
 * `focus` marks the ones that are worth taking the keyboard for, and scanned
 * words are not among them: the keyboard belongs to whatever the reader is
 * reading, and a lookup no longer needs it (see `feedScanner`). What is marked
 * is this window's own interface — the dictionary page and the extension frames
 * — which a reader has deliberately opened and has to be able to type into.
 */
function hitRects() {
  if (waylandDisabled) return []
  if (!state.origin) return []
  // Selecting a region needs every event on the display, not just the parts of
  // it that happen to have text under them.
  if (state.regionSelecting) return [{ ...state.origin, focus: false }]
  const rects = renderer.hitRects(state.origin)
  const add = (rect, focus) => {
    if (rect.width > 0 && rect.height > 0) {
      rects.push({
        x: state.origin.x + rect.x,
        y: state.origin.y + rect.y,
        width: rect.width,
        height: rect.height,
        focus
      })
    }
  }
  for (const frame of document.querySelectorAll('iframe')) {
    if (frame.id === 'backend') continue
    if (frame.id === 'extension-page' && !state.dictionaryOpen) continue
    add(frame.getBoundingClientRect(), true)
  }
  if (state.dictionaryOpen) add(pagesSection.getBoundingClientRect(), true)
  // The popup is not in the light DOM; see popupRects().
  rects.push(...popupRects())
  for (const rect of controller.hitRects()) add(rect, false)
  return rects
}

let handling = false
let lastSelection = null

/**
 * React to the shared native view.
 *
 * Driven by the `state` event, which native emits only when a fingerprint of the
 * view changes, with one snapshot at startup to establish the baseline. An event
 * arriving while the previous one is still being applied replaces the pending
 * one rather than queueing behind it — intermediate states are not worth
 * replaying, but the latest must never be dropped, or a missed transition would
 * persist until something else happened to change the view.
 */
let pendingView = null
async function processView(view) {
  if (!view) return
  if (handling) {
    pendingView = view
    return
  }
  handling = true
  try {
    // A native click outside any interactive region dismisses the popup.
    if (state.dismiss !== view.dismiss) {
      state.dismiss = view.dismiss
      dismissPopup()
    }

    if (view.revision !== state.revision) {
      state.revision = view.revision
      const scanId = view.scan?.id ?? null
      // Our own scans rendered and published on the way through; re-applying
      // here would duplicate the history entry and rewrite the clipboard.
      const alreadyApplied = scanId !== null && scanId === state.appliedScanId
      if (!alreadyApplied) {
        dismissPopup()
        window.getSelection()?.removeAllRanges()
        if (view.scan?.ocr) {
          const ocr = normalizeOcrResult(view.scan.ocr, view.scan.ocr.engine ?? setting('ocrMode'))
          await applyResult(
            { ...ocr, nativeScanId: scanId },
            view.scan,
            {
              generation: generation.current,
              sourceId: view.source?.sourceId ?? view.source?.id ?? null,
              source: view.source ?? null,
              request: { source_id: null, crop: view.crop ?? null }
            }
          )
          scanner.noteExternalScan(ocr.fullText ?? '', null, ocr)
        } else if (!view.scan && !pipeline.isHeld && !state.scanning) {
          // An explicit clear. A scan in flight has not produced its frame yet
          // and must not wipe what is currently readable.
          state.annotations = []
          state.info = null
          state.appliedScanId = null
          renderer.clear()
        }
      }
    }

    const flags = {
      autoOcrEnabled: view.autoOcrEnabled ?? state.flags.autoOcrEnabled,
      textOverlayVisible: view.textOverlayVisible ?? state.flags.textOverlayVisible,
      overlayVisible: view.overlayVisible ?? state.flags.overlayVisible,
      debugOverlayVisible: view.debugOverlayVisible ?? state.flags.debugOverlayVisible
    }
    const autoChanged = flags.autoOcrEnabled !== state.flags.autoOcrEnabled
    state.flags = flags
    if (autoChanged) syncAutoScanner()
    syncOverlayText()
    document.body.classList.toggle('debug', flags.debugOverlayVisible)

    if (typeof view.frontmostApp === 'string') foreground.note(view.frontmostApp)
    // Also carried on the view, so a window that starts up mid-session begins with the
    // current answer instead of waiting for the next change.
    if (view.sourceFocus) state.sourceFocus = view.sourceFocus

    // Crop and source identity come from the shared view, so a commit in the
    // picker reaches the hover markings without a scan in between.
    const selection = {
      sourceId: view.source?.sourceId ?? view.source?.id ?? null,
      crop: view.crop ?? null
    }
    if (generation.bumpIfChanged(lastSelection, selection)) {
      // A different source or crop invalidates anything in flight, and the
      // text on screen belongs to the previous selection.
      if (lastSelection !== null) {
        state.annotations = []
        state.info = null
        state.appliedScanId = null
        state.detached = false
        renderer.clear()
        scanner.reset()
      }
      lastSelection = selection
    }
    state.crop = view.crop ?? null
    state.viewSource = view.source ?? null
    const kind = view.source?.kind ?? view.source?.type
    state.hover.isWindow = kind === 'window'
    await followSource(view.source)
    drawHover()

    if (view.dictionary !== state.dictionaryOpen) {
      state.dictionaryOpen = view.dictionary
      pagesSection.hidden = !state.dictionaryOpen
      if (state.dictionaryOpen) {
        if (!state.origin) {
          state.origin = (await native.desktop())[0]
          await native.placeOverlay(state.origin)
        }
        if (!document.querySelector('#extension-page').getAttribute('src')) {
          openInIframe?.('/settings.html')
        }
        await native.panel('overlay', 'show')
      }
    }
  } catch (error) {
    log({ check: 'overlay-error', error: String(error?.message ?? error) })
  } finally {
    handling = false
    const next = pendingView
    pendingView = null
    if (next) void processView(next)
  }
}

/**
 * React to the overlay's text being switched on or off.
 *
 * Two inputs decide whether scanned text is drawn — a persisted preference and a
 * session flag — and they arrive on two different channels: a settings change and a
 * view broadcast. Both call this, and it compares the *combined* answer against the
 * last one, so flipping one input cannot look like two transitions and start two
 * scans.
 *
 * Switching it on scans, because otherwise it switches on to nothing: the overlay
 * draws the last scan, and if there was not one, or it belonged to a source that has
 * since changed, the reader gets an empty screen and has to ask for a scan by hand.
 * Switching it off never scans. The scan itself is the ordinary one — same capture,
 * same source, same generation and busy guards — so a scan already running satisfies
 * the transition and a failure is reported on the status line like any other.
 */
let overlayTextShown = null
function syncOverlayText() {
  const shown = isOverlayTextVisible(setting('liveOverlayEnabled'), state.flags.textOverlayVisible)
  const was = overlayTextShown
  overlayTextShown = shown
  draw()
  switch (overlayTextChange(was, shown, pipeline.isHeld || state.scanning)) {
    case 'scan':
      log({ check: 'overlay-enabled-scan' })
      void performScan()
      break
    case 'scan-pending':
      log({ check: 'overlay-enabled-scan-pending' })
      break
  }
}

/**
 * Publish the interactive rectangles on a timer rather than on view changes:
 * they move whenever the DOM does — a popup opening, a hover scaling a box —
 * which the native view knows nothing about.
 */
let publishing = false
let republish = false

async function publishRegions() {
  if (publishing) {
    // Coalesce: the next publish must reflect the DOM as it is when it runs, not
    // queue a stale snapshot behind the one in flight.
    republish = true
    return
  }
  publishing = true
  try {
    do {
      republish = false
      await native.setRegions(hitRects())
    } while (republish)
  } catch (error) {
    log({ check: 'overlay-regions-error', error: String(error?.message ?? error) })
  } finally {
    publishing = false
  }
}

function startRegionLoop() {
  setInterval(() => void publishRegions(), 100)
}

// ---------------------------------------------------------------------------
// 6. Startup
// ---------------------------------------------------------------------------

native.onCapabilityGap((command) =>
  log({
    check: 'native-capability-missing',
    command,
    note: 'Feature degraded; see PARITY_CONTRACT.md for the fallback.'
  })
)

await native.loadSettings()
await native.watchSettings((key) => {
  if (key === 'autoOCRSettings' || key === 'quickShotEnabled' || key === 'superTexthooker')
    syncAutoScanner()
  syncOverlayText()
})

// The raw name, ours included: "Kimochi is frontmost" and "no signal yet" are
// different states, and only the tracker may collapse them.
await native.listen('frontmost-app', ({ payload }) =>
  typeof payload === 'string'
    ? foreground.note(payload)
    : foreground.note(payload?.appName, typeof payload?.pid === 'number' ? payload.pid : null)
)
// Which pids and app names are ours, so our own windows are recognised by process
// where the platform can tell; the default names stand until it says.
await native.watchCapabilities(async (caps) => {
  if (window.__KIMOCHI_PLATFORM__?.os === 'linux' && caps.session.nativeLayerShell && !waylandLayer) {
    waylandLayer = true
    const { installLinuxScanInput } = await import('/spike/linux-scan-input.js')
    await installLinuxScanInput(window, { passive: true })
    window.addEventListener('resize', () => {
      state.origin = { x: 0, y: 0, width: innerWidth, height: innerHeight }
      draw()
    })
  }
  if (window.__KIMOCHI_PLATFORM__?.os === 'linux' && caps.session.backend === 'wayland' && !caps.session.nativeLayerShell) {
    waylandDisabled = true
    if (!gnomeOverlay && caps.session.compositor === 'GNOME') {
      const { installGnomeOverlay } = await import('./gnome-overlay.js')
      gnomeOverlay = await installGnomeOverlay(native, state, () => !state.regionSelecting && (gnomeControllerWords || isOverlayTextVisible(setting('liveOverlayEnabled'), state.flags.textOverlayVisible) && state.flags.overlayVisible), log)
    }
    renderer.clear()
    log({ check: caps.session.nativeGnomeShell ? 'overlay-native-gnome' : 'overlay-disabled', reason: caps.session.nativeGnomeShell ? 'GNOME Shell owns screen annotations; the WebKit OCR host stays hidden.' : 'Native layer-shell overlay is unavailable on this desktop. GNOME can use the optional Shell integration.' })
  }

  if (caps.os === 'windows')
    void import('/spike/windows-pointer.js').then(({ installWindowsPointer }) =>
      installWindowsPointer(window, () => livePopups)
    )
  foreground.configure({ pids: caps.ownPids, names: caps.ownAppNames })
})
await native.listen('hotkey', ({ payload }) => {
  if (payload?.name && !payload.name.startsWith('hover')) log({ check: 'overlay-action', name: payload.name })
  if (payload?.name) void onAction(payload.name)
})
/**
 * Follow the captured source as it moves.
 *
 * Two different things can change and they are independent. The overlay *window*
 * only has to move when the source crosses onto another display, because it is
 * placed over a whole display rather than over the source. The rendered *text*
 * has to move whenever the source moves at all, including within one display,
 * because each box is positioned from the source's current bounds.
 *
 * Getting only the first right is what left text stranded: the window stayed put
 * — correctly — and nothing redrew.
 */
await native.listen('source-bounds', async ({ payload }) => {
  if (!payload?.bounds) return
  // Bounds for a source we are no longer watching are stale by definition: a
  // late event from the previous window must not drag the current one's text.
  if (payload.sourceId && watchedSourceId && payload.sourceId !== watchedSourceId) return

  const previous = state.sourceBounds
  const bounds = payload.bounds
  if (previous && !movedOrResized(previous, bounds)) return
  state.sourceBounds = bounds
  // Quick Shot text belongs to the display region it was read from, not to this window.
  if (state.detached) return
  if (window.__KIMOCHI_PLATFORM__?.os === 'linux' && waylandDisabled) { draw(); return }

  try {
    const origin = sourceDisplay(bounds, await native.desktop())
    if (!sameRect(state.origin, origin)) {
      state.origin = origin
      await native.placeOverlay(origin)
    }
  } catch {
    // A source whose centre is off every display: leave the overlay where it is
    // and still redraw, so text tracks the part of the source that is visible.
  }
  draw()
  drawHover()

  // Recorded so a move can be checked without a screenshot: these windows are
  // capture-protected, so the rendered position is only observable as a number.
  if (state.annotations.length) {
    log({
      check: 'overlay-follow-source',
      bounds,
      origin: state.origin,
      first: renderer.firstBox()
    })
  }
})

function sameRect(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function movedOrResized(a, b) {
  return !sameRect(a, b)
}
// Gamepad input is polled natively (src-tauri/src/gamepad.rs) and dispatched
// through that same action path, so this window must not poll it as well.
await native.listen('ext-relay', ({ payload }) => {
  // A webview's JS listener takes every emit regardless of target, so the address in
  // the message is the only filter. Untargeted relays are still delivered to everyone
  // on purpose; nothing sends one today.
  if (!payload?.from || payload.from === 'overlay') return
  if (typeof payload.to === 'string' && payload.to !== 'overlay') return
  void handleRelay(payload.from, payload.payload)
})

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  dismissPopup()
  void native.setDictionaryOpen(false)
})
document.querySelector('#close').onclick = () => native.setDictionaryOpen(false)

// The captured window's focus, answered immediately rather than at the next view
// broadcast: text that belongs to a window the reader just left should go at once,
// and its click targets with it.
await native.listen('source-focus', ({ payload }) => {
  trace('source-focus', {
    focused: payload?.focused,
    present: payload?.present,
    held: payload?.held
  })
  if (!payload || typeof payload.focused !== 'boolean') return
  const was = state.sourceFocus
  state.sourceFocus = payload
  draw()
  // On change only. These windows are capture-protected, so whether the text went when
  // the reader left the captured window is otherwise unobservable.
  log({
    check: 'overlay-source-focus',
    focused: payload.focused,
    present: payload.present,
    held: payload.held ?? false,
    // Which two windows were compared. Ids only, never a title: an application can
    // order an auxiliary window in front of the one being read, and that is the only
    // thing that distinguishes it from the reader genuinely leaving.
    front: payload.frontWindow ?? payload.front_window ?? null,
    source: payload.sourceWindow ?? payload.source_window ?? null,
    words: renderer.hitRects(state.origin).length
  })
  // Not at the next tick of the region loop: an invisible rectangle that still takes
  // the mouse is worse than a visible one, so the click targets go with the text.
  void publishRegions()
  if (was && !(payload.focused && payload.present)) {
    // The words are gone; a dictionary popup about one of them has nothing left to
    // point at.
    dismissPopup()
  }
})

/**
 * The last pointer event this window received on its own.
 *
 * The overlay is click-through except over the words themselves, so real events
 * arrive only while the pointer is already on one and this window has the mouse.
 * When they do, they are the better source, and the native feed steps aside
 * rather than searching the same point twice.
 */
let lastRealPointer = -Infinity
window.addEventListener(
  'pointermove',
  (event) => {
    if (event.isTrusted) lastRealPointer = performance.now()
  },
  true
)

let notedModifier = false
let notedFeed = false
function noteScanFeed(payload, dispatched) {
  if (dispatched && !notedFeed) {
    notedFeed = true
    log({ check: 'overlay-scan-feed-started' })
  }
  const held = !!(payload.shift || payload.ctrl || payload.alt || payload.meta)
  if (!held || notedModifier) return
  notedModifier = true
  log({
    check: 'overlay-modifier-seen',
    shift: !!payload.shift,
    ctrl: !!payload.ctrl,
    alt: !!payload.alt,
    meta: !!payload.meta
  })
}

// The pointer, including where this window cannot see it: it drives the proximity
// effect on scanned words, and the scan itself. See ui/scan-input.ts for why the
// scan arrives this way rather than from an event addressed to this window.
await native.listen('pointer', ({ payload }) => {
  if (!state.origin || typeof payload?.x !== 'number') return
  const local = toOverlayLocal(payload, state.origin)
  if (payload.over === false || !local) {
    renderer.clearPointer()
    return
  }
  renderer.setPointer(local.x, local.y)
  controller.pointer(local.x, local.y)
  // While the controller is reading, the pointer must not steer Yomitan: an idle mouse resting
  // somewhere else would otherwise close the controller's popup.
  if (!state.yomitan.ready || controller.drivesLookups) return
  const init = scanPointerInit(payload, local, performance.now() - lastRealPointer)
  if (init) window.dispatchEvent(new PointerEvent('pointermove', init))
  // Once each, then never again. Whether a modifier can be read at all from a window
  // that does not have the keyboard is the one thing this window cannot find out for
  // itself, and "Shift does nothing" has two completely different causes depending on
  // the answer. Names of keys only.
  noteScanFeed(payload, init !== null)
})

await native.listen('state', ({ payload }) => void processView(payload))
// The reader cleared its log. Both loops forget what they published, so a line read again
// reaches the log again; native's history merge forgets it on the same signal.
await native.listen('history:merge-reset', () => {
  imageScanner.forgetPublished()
  sceneScanner.forgetPublished()
})

syncAutoScanner()
void reportObserver()
startRegionLoop()
// One baseline read, in case the first `state` event predates this listener.
void native.snapshot().then(processView)

// Scanning and rendering are live from here. The dictionary comes up behind them:
// if it fails, lookups are unavailable and say so, but OCR still works.
startYomitan().catch((error) => {
  state.yomitan.error = String(error?.message ?? error)
  settleBackend()
  log({
    check: 'yomitan-unavailable',
    error: state.yomitan.error,
    note: 'Scanning and text output still work; dictionary lookup does not.'
  })
})

log({
  check: 'overlay-ready',
  ocrMode: setting('ocrMode'),
  liveOverlay: setting('liveOverlayEnabled'),
  missingCommands: native.unavailableCommands()
})

// Exposed for ui/checks.js, which drives a scan and asserts against the result.
window.kimochiOverlay = {
  performScan,
  onAction,
  importFixtureDictionary,
  renderer,
  scanner,
  state
}

// GNOME hosts the unchanged controller UI in a bounded own window. The OCR
// coordinator still owns scanning, settings, and the one dictionary backend.
if(window.__KIMOCHI_PLATFORM__?.os==='linux') {
  await native.listen('gnome-controller-command',async({payload:p})=>{
    if(!gnomeOverlay)return
    let result,error
    try {
      switch(p.action) {
        case 'snapshot':result={hasText:state.annotations.length>0,autoOcr:Boolean(state.flags.autoOcrEnabled),autoAvailable:!isQuickShot(),scanId:state.appliedScanId,settings:{controllerButtons:setting('controllerButtons')}};break
        case 'scan':await onAction('triggerScan');result=true;break
        case 'action':if(p.name!=='toggleAutoOcr')throw new Error('Invalid controller action');await onAction(p.name);break
        case 'dictionary':if(p.apiAction!=='parseText')throw new Error('Invalid dictionary action');result=await extensionApi(p.apiAction,p.params);break
        case 'text':await setOverlayText(Boolean(p.visible));await gnomeOverlay.update();break
        case 'hold':gnomeControllerWords=Boolean(p.hold);holdForController(gnomeControllerWords);await gnomeOverlay.flush();break
        default:throw new Error('Unknown controller command')
      }
    }catch(e){error=String(e)}
    await window.__TAURI__.event.emit('gnome-controller-response',{id:p.id,result,error})
  })
}
