import { StableLineGate } from './stable-line-gate.js'
import { currentLines, confirmedCurrentLines, annotationsInLines } from './current-lines.js'
/**
 * Automatic OCR: deciding when an expensive recognition is actually justified.
 *
 * Ported from src/renderer/src/windows/background/background.ts and then
 * rewritten around a local first-pass observer, following the architecture of
 * GameSentenceMiner's controller (see GSM_AUTO_OCR_RESEARCH.md) rather than its
 * code. The shape is: capture cheaply and often, read the text locally, wait for
 * it to stop moving, and only then spend the accurate recogniser on it.
 *
 * What the old two-gate version got wrong, and this is written to fix:
 *
 *  - Gate 1 compared the whole crop, so anything animating behind the dialogue
 *    read as "the text changed". Text is compared now, not pixels.
 *  - A gate failure fell through to the expensive call, so the four recorded
 *    `Load failed` errors became four cloud requests. Nothing here turns a broken
 *    observer into a request; a failing observer backs off and says so, and a
 *    platform with no observer reports automatic mode unavailable instead of
 *    quietly uploading every frame.
 *  - Deduplication happened after the request, which protected the history but
 *    not the request count. It happens twice now: `lastSubmittedKey` before
 *    spending a request, `lastPublishedKey` before writing to the history.
 *  - There was no candidate. A half-drawn line was recognised, then the next
 *    character arrived and it was recognised again. A candidate now has to be
 *    observed unchanged `stableObservations` times before it is worth anything.
 *
 * Everything here is deterministic: the clock, capture, the observer and the
 * recogniser are all injected, so the whole policy is exercised by tests with no
 * app, no screen, no timer and no network.
 */

import {
  classify,
  identityKey,
  layoutSignature,
  sameLayout,
  stabilityKey,
  type Observation,
  type ObservedLine,
  type Relation
} from './observation.js'
import { hammingDistance } from './dhash.js'

/**
 * Which local signal decides that the screen has settled.
 *
 * `text` is the real answer and the default: the observer reads the words, so
 * animation behind them is irrelevant. `image` compares the native perceptual
 * hash instead, and exists only as a deliberate user choice for a machine whose
 * observer cannot run — it cannot tell a moving background from new dialogue,
 * which is why nothing selects it automatically. A failing observer is reported
 * as a failure, never silently downgraded into this.
 */
export type ObserverMode = 'text' | 'image'

export interface AutoScanSettings {
  /**
   * Which generation of defaults this object was written against.
   *
   * Absent or lower than `SETTINGS_VERSION` means a stored file from before the
   * cadence was retuned, and the retune is applied to the fields the user never
   * touched. Without a marker there is no way to tell "500ms, because that was
   * the default" from "500ms, because I chose it".
   */
  version: number
  /** Base cadence between observations, in milliseconds. */
  pollInterval: number
  adaptivePollingEnabled: boolean
  adaptivePollMin: number
  adaptivePollMax: number

  /** Which local signal settles a candidate. */
  observerMode: ObserverMode
  /** Consecutive identical observations before a candidate may be recognised. */
  stableObservations: number
  /** Longest a still-moving candidate may be held before it is sent anyway. */
  maxCandidateAgeMs: number
  /** Floor on the gap between two accurate recognitions, however settled. */
  minRequestSpacingMs: number
  /** Consecutive blank observations before repeated dialogue may return. */
  emptyObservationsToClear: number
  /** Pixel slack when two observations are called the same layout. */
  boxTolerancePx: number
  /** First error backoff; doubles per consecutive error up to the maximum. */
  errorBackoffMs: number
  maxErrorBackoffMs: number
  /** Consecutive errors before automatic scanning suspends itself. */
  maxConsecutiveErrors: number

  /**
   * Image-mode hash slack, also used by the legacy full-local-OCR paths. A
   * hamming distance at or below this is "the same picture".
   */
  imageHashThreshold: number
  /**
   * Retained so a settings object written by an older build still round-trips,
   * and because the Settings panel's local-OCR controls read them. Neither takes
   * part in the decision below: the local gate is the observer now, and it is
   * chosen by `observerMode`. A stored `localOCRGateEnabled: false` must not
   * leave a user with no gate at all, which is exactly what it used to mean.
   */
  localOCRGateEnabled: boolean
  localOCRSimilarityThreshold: number
}

/** Bumped whenever a default changes in a way stored settings should inherit. */
export const SETTINGS_VERSION = 2

/**
 * The cadence defaults version 1 shipped with.
 *
 * Kept so migration can tell an untouched value from a chosen one. These were
 * inherited from Electron, where the first pass was a whole-crop image hash and
 * looking often was genuinely expensive. The local observer costs a fraction of
 * that — around 33ms warm on fixtures — so the reason for being slow is gone,
 * while the cost of being slow is exactly what the reader feels: at 5s between
 * observations a new line waited up to 6.1s to be noticed.
 */
const LEGACY_CADENCE = { pollInterval: 2000, adaptivePollMin: 500, adaptivePollMax: 5000 }

export const DEFAULT_AUTO_OCR_SETTINGS: AutoScanSettings = {
  version: SETTINGS_VERSION,
  // Fast enough that a line is noticed within a frame or two of appearing, and
  // still cheap: the observer reads a frame in tens of milliseconds.
  pollInterval: 500,
  adaptivePollingEnabled: true,
  // While the screen is moving, look often; when it settles, ease off only as
  // far as half a second. The old ceiling of five seconds is what made a still
  // reader wait seconds for the next line.
  adaptivePollMin: 250,
  adaptivePollMax: 500,

  observerMode: 'text',
  // Two is the minimum that means anything: one observation is a sighting, two
  // consecutive identical ones are a screen that has stopped.
  stableObservations: 2,
  maxCandidateAgeMs: 4000,
  minRequestSpacingMs: 1200,
  emptyObservationsToClear: 3,
  boxTolerancePx: 3,
  errorBackoffMs: 2000,
  maxErrorBackoffMs: 30000,
  maxConsecutiveErrors: 5,

  imageHashThreshold: 5,
  localOCRGateEnabled: false,
  localOCRSimilarityThreshold: 0.85
}

/**
 * Bring a stored `autoOCRSettings` forward.
 *
 * The one behaviour change a user must not have to discover: automatic mode used
 * to be gated by `localOCRGateEnabled`, which shipped `false`, so every existing
 * installation has it stored as `false`. That key no longer selects the local
 * gate — `observerMode` does, and it defaults to `text` — so those users get the
 * observer without finding a hidden switch. Their stored value is preserved for
 * the Settings panel's own local-OCR controls.
 */
export function migrateAutoScanSettings(stored: unknown): AutoScanSettings {
  const source = stored && typeof stored === 'object' ? (stored as Partial<AutoScanSettings>) : {}
  const merged = { ...DEFAULT_AUTO_OCR_SETTINGS, ...source }
  // A stored file from before observer mode existed has no opinion about it.
  if (merged.observerMode !== 'text' && merged.observerMode !== 'image') {
    merged.observerMode = DEFAULT_AUTO_OCR_SETTINGS.observerMode
  }

  // Inherit a retuned cadence, but only where the stored value is the old
  // default. Somebody who set five seconds on purpose keeps five seconds;
  // somebody who simply never opened the panel gets the faster loop rather than
  // being left on a cadence chosen for a gate that no longer exists.
  const version = typeof source.version === 'number' ? source.version : 0
  if (version < SETTINGS_VERSION) {
    for (const key of ['pollInterval', 'adaptivePollMin', 'adaptivePollMax'] as const) {
      if (source[key] === LEGACY_CADENCE[key]) merged[key] = DEFAULT_AUTO_OCR_SETTINGS[key]
    }
    merged.version = SETTINGS_VERSION
  }
  merged.stableObservations = Math.max(2, Math.floor(merged.stableObservations) || 2)
  merged.minRequestSpacingMs = Math.max(0, merged.minRequestSpacingMs)
  merged.maxCandidateAgeMs = Math.max(merged.pollInterval, merged.maxCandidateAgeMs)
  return merged
}

export interface OcrResult {
  fullText: string
  textAnnotations: unknown[]
  [key: string]: unknown
}

/** One capture, plus whatever the local observer made of the same bytes. */
export interface CaptureSample<Frame = unknown> {
  frame: Frame
  /**
   * Perceptual hash of the same pixels, computed natively beside the capture.
   *
   * Reported and counted, and the settling key in `image` mode. In `text` mode
   * it decides nothing: a screen whose pixels have not changed still owes the
   * candidate the observation that settles it, so hashing must never be allowed
   * to skip one.
   */
  hash?: string | null
  /** What the local observer read. `null` when it could not run. */
  observation?: Observation | null
  /** Why the observer produced nothing this time. */
  observerError?: string | null
  /** This platform has no local observer at all. */
  observerUnsupported?: boolean
  /**
   * Exact digest of the captured pixels, from native.
   *
   * Byte-identical pixels cannot have different words on them, so a reading that
   * differs while this does not is the recogniser disagreeing with itself rather
   * than the screen changing. Used only to suppress that — never to suppress a
   * change, because two frames whose pixels differ may differ by exactly the one
   * glyph that matters. Absent when native does not supply one.
   */
  contentFingerprint?: string | null
  /** Name of the engine that produced `observation`, for logs. */
  observerEngine?: string | null
  /** Selection generation these pixels belong to. */
  generation?: number
}

/** What `onResult` is being asked to do with a recognised frame. */
export interface ResultInfo {
  /**
   * Write this to the history, the texthooker and TTS.
   *
   * `false` means the accurate recogniser returned text already on screen: the
   * overlay should still redraw, because the boxes may have moved, but nothing
   * should be published again. Keeping these separate is what stops a stationary
   * dialogue box from filling the history with the same line.
   */
  publish: boolean
  /** Why this recognition happened: 'settled', 'max-wait', 'disappeared'. */
  reason: string
  generation: number
}

export type SkipReason =
  | 'held'
  | 'superseded'
  | 'unpinned'
  | 'locked'
  | 'backoff'
  | 'unavailable'
  | 'suspended'
  | 'duplicate-submission'
  | 'stale-generation'
  | 'empty-result'
  | 'spacing'
  | 'in-flight'

export type AutoScanState = 'idle' | 'running' | 'paused' | 'suspended' | 'unavailable'

/**
 * Diagnostics. Nothing here carries recognised text, pixels, a key or a URL —
 * only lengths, counts, reasons and coarse geometry, so the log stays safe to
 * read and to send.
 */
/**
 * Why what is currently drawn stopped describing the screen.
 *
 * `empty` — the observer read nothing where there was text.
 * `changed` — the text is different from the text the drawing belongs to.
 * `source` — the selection moved, so the drawing belongs to another window.
 */
export type InvalidationReason = 'empty' | 'changed' | 'source'

export type AutoScanEvent =
  | { type: 'observation'; relation: Relation; stable: number; chars: number; layout: string }
  /**
   * What is on screen no longer matches what is drawn over it.
   *
   * Emitted from the observation path, at the first observation that proves it,
   * and deliberately not gated by anything to do with requests: not by settling,
   * not by the minimum spacing, not by a queued job, and not by an endpoint that
   * is failing or backed off. Word boxes drawn over text that has gone are wrong
   * immediately, and staying wrong until a replacement result happens to arrive
   * is the worst of both — the boxes were stale the whole time and the reader was
   * clicking on them.
   *
   * Fires once per transition, not on every quiet tick.
   */
  | {
      type: 'visual-invalidated'
      reason: InvalidationReason
      chars: number
      keepBoxes?: import('./observation.js').TextBox[]
    }
  | { type: 'skip'; reason: SkipReason; detail?: string }
  | {
      type: 'candidate'
      action: 'new' | 'evolving' | 'settled' | 'expired' | 'dropped'
      ageMs: number
    }
  | { type: 'request'; reason: string; queued: boolean; replaced: boolean }
  | { type: 'result'; published: boolean; reason: string; chars: number }
  | { type: 'error'; stage: string; message: string; backoffMs: number }
  | { type: 'status'; state: AutoScanState; message: string }

export interface AutoScanDeps<Frame = unknown> {
  /** Injected so tests never wait on a real clock. */
  now?(): number
  /** Capture and locally observe in one round trip. */
  captureFrame(): Promise<CaptureSample<Frame>>
  /** The accurate second pass, on a frame that has already been captured. */
  recognize(frame: Frame): Promise<OcrResult | null>
  /**
   * Keep this frame alive. The native store holds the newest frame and the
   * published one, so a candidate waiting to settle — or queued behind a
   * request — would otherwise be evicted by the next probe.
   */
  retainFrame?(frame: Frame): void | Promise<void>
  releaseFrame?(frame: Frame): void | Promise<void>
  onResult(result: OcrResult, frame: Frame, info: ResultInfo): void | Promise<void>
  onScanStart?(): void
  onScanEnd?(): void
  onEvent?(event: AutoScanEvent): void
  /** Diagnostic observer; must never participate in scheduling decisions. */
  onDiagnostic?(
    event: AutoScanEvent,
    frame: Frame | undefined,
    counters: AutoScanCounters,
    context: { intervalMs: number; holdMs: number; generation: number; tick: number }
  ): void
  /** The manual pipeline's lock: held by someone else means skip this tick. */
  isBusy?(): boolean
  /**
   * Take the lock the manual path uses, or report that it is held.
   *
   * The two paths drive one native capture mutex and one recogniser, so they
   * have to contend for the same lock rather than each keeping a private
   * in-flight flag — which is what let an automatic request and a hand-triggered
   * scan overlap. A refused lock puts the candidate back in the pending slot;
   * the loop comes round again in well under a second.
   */
  tryAcquire?(): boolean
  releaseLock?(): void
  /** Current selection generation, shared with the manual path. */
  generation?(): number
}

export type TickOutcome =
  'paused' | 'busy' | 'backoff' | 'unavailable' | 'observed' | 'requested' | 'queued' | 'error'

interface Candidate<Frame> {
  /** `stabilityKey` of the observed text: what settling compares. */
  key: string
  /** The observed text as read, which `identityKey` is taken from on submit. */
  text: string
  lines: ObservedLine[] | null
  frame: Frame
  generation: number
  /** Consecutive identical observations, including the one that created this. */
  count: number
  /** When the current run of related observations began: the max-wait clock. */
  runStartedAt: number
  layout: string
  /**
   * This exact reading has already been handed to the recogniser.
   *
   * The candidate is kept rather than discarded once it has been sent, so that
   * the observations which follow it still read as `identical`. Clearing it
   * would make the next look at an unchanged screen a first sighting, and a
   * screen that is always newly sighted never backs off and never settles.
   */
  submitted: boolean
}

export interface AutoScanCounters {
  ticks: number
  captures: number
  observations: number
  emptyObservations: number
  observerErrors: number
  observerUnsupported: number
  candidates: number
  settled: number
  maxWaitFlushes: number
  disappearanceFlushes: number
  requests: number
  requestErrors: number
  captureErrors: number
  published: number
  refreshedWithoutPublishing: number
  emptyResults: number
  suppressedDuplicateSubmission: number
  suppressedDuplicatePublication: number
  partialResults: number
  replacedPending: number
  spacingDeferrals: number
  backoffSkips: number
  lockedSkips: number
  staleDiscarded: number
  hashUnchanged: number
  /** Native frame pin operations the native side refused. */
  pinFailures: number
  /** Settled candidates dropped because their frame was never pinned. */
  unpinnedDiscards: number
  /** Times the overlay was told that what it is drawing no longer applies. */
  invalidations: number
  /** Readings that changed while the pixels behind them did not. */
  fingerprintSuppressed: number
  /** Results dropped because the screen had moved on before they landed. */
  supersededResults: number
  /**
   * Replacements that arrived in the same place as the line before them.
   *
   * The count exists to be asserted on. GSM's detection-only path suppresses a
   * crop whose coordinates match the last one it processed, so a visual novel
   * writing its next sentence into the same dialogue box is dropped; this
   * pipeline must recognise every one of these, and a non-zero count next to a
   * matching number of requests is the evidence that it does.
   */
  sameLayoutReplacements: number
}

function emptyCounters(): AutoScanCounters {
  return {
    ticks: 0,
    captures: 0,
    observations: 0,
    emptyObservations: 0,
    observerErrors: 0,
    observerUnsupported: 0,
    candidates: 0,
    settled: 0,
    maxWaitFlushes: 0,
    disappearanceFlushes: 0,
    requests: 0,
    requestErrors: 0,
    captureErrors: 0,
    published: 0,
    refreshedWithoutPublishing: 0,
    emptyResults: 0,
    suppressedDuplicateSubmission: 0,
    suppressedDuplicatePublication: 0,
    partialResults: 0,
    replacedPending: 0,
    spacingDeferrals: 0,
    backoffSkips: 0,
    lockedSkips: 0,
    staleDiscarded: 0,
    hashUnchanged: 0,
    pinFailures: 0,
    unpinnedDiscards: 0,
    invalidations: 0,
    fingerprintSuppressed: 0,
    supersededResults: 0,
    sameLayoutReplacements: 0
  }
}

/**
 * Reference-counted native frame pins, applied in order.
 *
 * A frame can be held at once by the candidate, by the pending slot and by the
 * request in flight, and the rule that matters is that a frame under OCR is never
 * released out from under it. Counting is how a candidate promoted to pending and
 * then to in-flight is pinned exactly once and released exactly once, rather than
 * being unpinned by whichever handoff finished first.
 *
 * Pinning is a native round trip, so the counting alone is not enough. Two things
 * follow from that and both are handled here rather than hoped for:
 *
 *  - **Order.** Every operation goes through one promise chain, so a release can
 *    never overtake the retain it belongs to and leave a frame pinned for good,
 *    or arrive first and unpin something that was never pinned. `settled()` lets
 *    the caller wait for the queue to drain — which the scan loop does before
 *    finishing a tick, so the next capture cannot evict a candidate whose pin has
 *    not landed yet.
 *  - **Failure.** A pin that the native side refuses is a frame that is *not*
 *    held, and pretending otherwise would mean a later release against nothing
 *    and a recognition against an evicted image. A failed retain is counted,
 *    reported, and remembered, so its matching release is skipped instead of
 *    being sent for a frame that was never pinned.
 */
export class FrameKeeper<Frame> {
  private counts = new Map<Frame, number>()
  /** Frames whose retain the native side refused: nothing to release later. */
  private unpinned = new Set<Frame>()
  /** Per-frame outcome of the retain that pinned it, for callers that must wait. */
  private pins = new Map<Frame, Promise<boolean>>()
  private chain: Promise<void> = Promise.resolve()
  private failures = 0

  constructor(
    private retainFrame?: (frame: Frame) => void | Promise<void>,
    private releaseFrame?: (frame: Frame) => void | Promise<void>,
    private onFailure?: (operation: 'retain' | 'release', error: unknown) => void
  ) {}

  retain(frame: Frame): void {
    const held = this.counts.get(frame) ?? 0
    this.counts.set(frame, held + 1)
    if (held > 0) return
    const apply = this.retainFrame
    if (!apply) {
      // Nothing to pin against, so nothing can evict it either.
      this.pins.set(frame, Promise.resolve(true))
      return
    }
    const applied = this.chain.then(async () => {
      try {
        await apply(frame)
        this.unpinned.delete(frame)
        return true
      } catch (error) {
        this.failures++
        this.unpinned.add(frame)
        this.onFailure?.('retain', error)
        return false
      }
    })
    this.chain = applied.then(() => {})
    this.pins.set(frame, applied)
  }

  release(frame: Frame): void {
    const held = this.counts.get(frame)
    if (!held) return
    if (held > 1) {
      this.counts.set(frame, held - 1)
      return
    }
    this.counts.delete(frame)
    this.enqueueRelease(frame)
  }

  /**
   * Unpin, deciding whether there is anything to unpin *when the turn comes*.
   *
   * The check cannot happen at enqueue time. A retain queued ahead of this one
   * may still be in flight, and if it then fails, an unpin decided earlier would
   * already be committed and would run against a frame the native store never
   * pinned. Asking inside the serialized operation is the only point at which the
   * answer is settled.
   */
  private enqueueRelease(frame: Frame): void {
    const apply = this.releaseFrame
    this.chain = this.chain.then(async () => {
      this.pins.delete(frame)
      if (this.unpinned.delete(frame)) return
      if (!apply) return
      try {
        await apply(frame)
      } catch (error) {
        this.failures++
        this.onFailure?.('release', error)
      }
    })
  }

  /**
   * Drop every pin except, optionally, one.
   *
   * `keep` is the frame a recognition is running against. Stopping or resetting
   * must not unpin that one: the request is already out, the result still has to
   * be matched to the image it came from, and the native store would be free to
   * evict it the moment the next probe lands. Its pin is reduced to a single
   * reference and released by the request itself, in `run`'s `finally`.
   */
  releaseAll(keep?: Frame): void {
    for (const frame of [...this.counts.keys()]) {
      if (keep !== undefined && frame === keep) {
        this.counts.set(frame, 1)
        continue
      }
      this.counts.delete(frame)
      this.enqueueRelease(frame)
    }
  }

  /**
   * Whether this frame is actually pinned natively.
   *
   * Resolves once the retain that was meant to pin it has been applied, so a
   * caller about to spend a recognition on the frame can find out whether the
   * native store is still holding it. A frame with no pending or completed retain
   * is reported by whether it is known to have failed.
   */
  pinned(frame: Frame): Promise<boolean> {
    return this.pins.get(frame) ?? Promise.resolve(!this.unpinned.has(frame))
  }

  /** Resolve once every queued pin operation has actually been applied. */
  settled(): Promise<void> {
    return this.chain
  }

  /** Distinct frames this believes are pinned. */
  get held(): number {
    return this.counts.size
  }

  /** Native pin operations that failed. */
  get pinFailures(): number {
    return this.failures
  }
}

export class AutoScanner<Frame = unknown> {
  private settings: AutoScanSettings
  private readonly keeper: FrameKeeper<Frame>

  private candidate: Candidate<Frame> | null = null
  /** A settled candidate waiting for the request in flight. At most one. */
  private pending: Candidate<Frame> | null = null
  private inFlight: Candidate<Frame> | null = null
  /** The recognition currently running, so shutdown and tests can await it. */
  private inFlightPromise: Promise<void> | null = null
  /**
   * Identifies the run that owns `inFlightPromise`.
   *
   * Without it, a finishing run clears the slot a newer run has already claimed,
   * and `idle()` reports quiet while a request is out.
   */
  private runToken = 0
  /** A consecutive run of a shorter reading, which may yet replace the candidate. */
  private shrink: { key: string; sample: Candidate<Frame>; count: number } | null = null

  private lastSubmittedKey = ''
  private lastPublishedKey = ''
  private lastRequestAt = Number.NEGATIVE_INFINITY
  /**
   * Recognition is deferred until this moment. Observation is not.
   *
   * Zero when nothing is held. See `holdRequestsUntil`.
   */
  private requestHold = 0
  private emptyStreak = 0
  /** Consecutive observations that said nothing new; drives the back-off. */
  private quietStreak = 0
  private errorStreak = 0
  /**
   * Which stage the current backoff belongs to.
   *
   * Observing and recognising fail for unrelated reasons, and a working observer
   * says nothing about a reachable endpoint. Without this, every successful
   * observation cleared the backoff from a failed recognition, and a dead
   * endpoint was retried on every other tick for as long as the screen was
   * readable.
   */
  private errorStage: string | null = null
  private backoffUntil = 0
  private lastHash: string | null = null
  /** The previous observation, for layout comparison only. */
  private lastKey: string | null = null
  private lastText = ''
  private lastLines: ObservedLine[] | null = null
  /**
   * The exact pixel digest of the previous observation, when native supplies one.
   *
   * Only ever used to discount a *changed* reading of unchanged pixels.
   */
  private lastFingerprint: string | null = null
  /** The selection generation the last observation belonged to. */
  private generation: number | null = null
  /**
   * The stability key of the text the overlay is currently drawing, or `null`
   * when it is drawing nothing.
   *
   * This is what invalidation is measured against — not the candidate, which
   * moves ahead of the screen, and not the last published text, which is a
   * different question. It is also what `accept` checks a late result against.
   */
  private shownKey: string | null = null
  private shownLines: ObservedLine[] | null = null
  private lineMisses = new Map<ObservedLine, number>()
  private lineGate = new StableLineGate()

  private interval: number
  private running = false
  private paused = false
  private suspended = false
  private unavailable = false
  private unavailableReason = ''
  private tickInFlight = false
  /**
   * Bumped by `stop` and `reset`. A request started before the bump is still
   * finished — it has already been sent, and dropping the bookkeeping would not
   * un-send it — but its result belongs to a session the user has ended, so it
   * is discarded rather than drawn over whatever they are looking at now.
   */
  private epoch = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private counters = emptyCounters()

  constructor(
    private deps: AutoScanDeps<Frame>,
    settings: AutoScanSettings = DEFAULT_AUTO_OCR_SETTINGS
  ) {
    this.settings = migrateAutoScanSettings(settings)
    this.interval = this.settings.pollInterval
    this.keeper = new FrameKeeper(
      deps.retainFrame?.bind(deps),
      deps.releaseFrame?.bind(deps),
      (operation, error) => {
        this.counters.pinFailures++
        // Surfaced rather than swallowed: a refused retain means the frame a
        // candidate is settling on is not protected, and the recognition that
        // follows will fail against an evicted image. That failure is real and
        // the backoff should see it.
        this.emit({
          type: 'error',
          stage: `pin-${operation}`,
          message: typeof error === 'string' ? error : String((error as Error)?.message ?? error),
          backoffMs: 0
        })
      }
    )
  }

  // --- inspection ----------------------------------------------------------

  get currentInterval(): number {
    return this.interval
  }
  get isRunning(): boolean {
    return this.running
  }
  get isPaused(): boolean {
    return this.paused
  }
  get state(): AutoScanState {
    if (this.unavailable) return 'unavailable'
    if (this.suspended) return 'suspended'
    if (this.paused) return 'paused'
    return this.running ? 'running' : 'idle'
  }
  /** Why automatic scanning is unavailable or suspended; '' when it is neither. */
  get stateReason(): string {
    return this.unavailableReason
  }
  /** Distinct frames currently pinned. Zero once stopped. */
  get retainedFrames(): number {
    return this.keeper.held
  }

  /** Resolve once every queued native pin operation has been applied. */
  pinsSettled(): Promise<void> {
    return this.keeper.settled()
  }
  stats(): AutoScanCounters {
    return { ...this.counters }
  }

  /**
   * Resolve once no recognition is running.
   *
   * A request outlives the tick that started it — deliberately, so a slow
   * endpoint cannot stop the loop from watching the screen — so "is it finished"
   * is a real question for a caller shutting down, and for a test that wants to
   * look at what a request did.
   */
  async idle(): Promise<void> {
    while (this.inFlightPromise) {
      const current = this.inFlightPromise
      await current
      if (this.inFlightPromise === current) this.inFlightPromise = null
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }
  private emit(event: AutoScanEvent, frame?: Frame): void {
    this.deps.onEvent?.(event)
    try {
      this.deps.onDiagnostic?.(event, frame, this.stats(), {
        intervalMs: this.interval,
        holdMs: Math.max(0, this.requestsHeldUntil - this.now()),
        generation: this.deps.generation?.() ?? 0,
        tick: this.counters.ticks
      })
    } catch {
      /* Diagnostics cannot change recognition behavior. */
    }
  }

  /**
   * Tell the overlay that what it is drawing no longer describes the screen.
   *
   * Idempotent per transition: `shownKey` is what is on screen, so once it has
   * been cleared there is nothing left to invalidate and a screen that stays
   * blank says so once rather than every tick.
   */
  private invalidate(reason: InvalidationReason): void {
    if (this.shownKey === null) return
    const chars = this.shownKey.length
    this.shownKey = null
    this.shownLines = null
    this.lineMisses.clear()
    this.counters.invalidations++
    this.emit({ type: 'visual-invalidated', reason, chars })
  }

  // --- lifecycle -----------------------------------------------------------

  updateSettings(settings: AutoScanSettings): void {
    this.settings = migrateAutoScanSettings(settings)
    this.interval = this.settings.adaptivePollingEnabled
      ? Math.min(
          Math.max(this.interval, this.settings.adaptivePollMin),
          this.settings.adaptivePollMax
        )
      : this.settings.pollInterval
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.suspended = false
    this.unavailable = false
    this.unavailableReason = ''
    this.errorStreak = 0
    this.errorStage = null
    this.backoffUntil = 0
    this.quietStreak = 0
    this.interval = this.settings.pollInterval
    this.emit({ type: 'status', state: 'running', message: 'Automatic scanning started.' })
    this.schedule()
  }

  /**
   * Stop, and let go of everything.
   *
   * The candidate, the pending slot and any pinned frames all go; an in-flight
   * request is left to finish, because cancelling it would not un-send it, but
   * its result is discarded rather than published.
   */
  stop(): void {
    this.running = false
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.candidate = null
    this.pending = null
    this.shrink = null
    this.epoch++
    this.lineGate.reset()
    this.keeper.releaseAll(this.inFlight?.frame)
    this.emit({ type: 'status', state: 'idle', message: 'Automatic scanning stopped.' })
  }

  /**
   * Defer expensive recognition until `at`, and nothing else.
   *
   * For the times when spending on the endpoint would be rude but looking is
   * still essential: the reader is hovering a word, the dictionary is open, a
   * lookup is in flight. Observation carries on at full cadence, so the boxes
   * still get invalidated the instant the text under them changes or goes —
   * which is exactly when a reader with the dictionary open needs it, because
   * stale boxes are what they are pointing at.
   *
   * Idempotent and monotonic: call it repeatedly with `now + n` from an activity
   * handler and the hold simply extends. A shorter deadline never shortens a
   * longer one that is already in force; use `resumeRequests` for that.
   *
   * This is deliberately not `pause`. `pause` stops the loop dead, blank
   * detection included, which is what made hovering a word freeze the overlay's
   * idea of the screen for as long as the pointer kept moving.
   */
  holdRequestsUntil(at: number): void {
    if (at > this.requestHold) this.requestHold = at
  }

  /** `holdRequestsUntil`, measured from now. */
  pauseRecognitionFor(ms: number): void {
    this.holdRequestsUntil(this.now() + Math.max(0, ms))
  }

  /** Lift any hold immediately. */
  resumeRequests(): void {
    this.requestHold = 0
  }

  /** The moment recognition is held until; 0 when none was ever asked for. */
  get requestsHeldUntil(): number {
    return this.requestHold
  }

  /** Whether recognition is being held right now. */
  get requestsHeld(): boolean {
    return this.now() < this.requestHold
  }

  /**
   * Stop the loop entirely, observation included.
   *
   * Kept for callers that genuinely want nothing to happen. Anything that only
   * wants to stop *spending* should use `holdRequestsUntil`.
   */
  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    this.suspended = false
    this.requestHold = 0
    this.errorStreak = 0
    this.errorStage = null
    this.backoffUntil = 0
    if (this.unavailable) {
      // Re-probe: a machine can become supported between runs, and the honest
      // way to find out is to look rather than to stay latched off.
      this.unavailable = false
      this.unavailableReason = ''
    }
  }

  /**
   * The reader cleared their log: the text last sent there is no longer in it, so the same
   * text read again is sent again. The candidate on screen keeps its `submitted` mark, so an
   * unchanged screen still costs nothing and is not written straight back into the log.
   */
  forgetPublished(): void {
    this.lastSubmittedKey = ''
    this.lastPublishedKey = ''
  }

  /**
   * Forget everything observed, so the next tick starts from nothing.
   * Used after a source change, a sleep/wake, or a crop commit.
   */
  reset(): void {
    this.candidate = null
    this.pending = null
    this.shrink = null
    // `inFlight` is deliberately left alone. The request has already been made
    // and cancelling the bookkeeping would not un-make it; its result is
    // discarded by the generation check, and its frame stays pinned until it
    // returns.
    this.epoch++
    this.lineGate.reset()
    this.keeper.releaseAll(this.inFlight?.frame)
    this.lastSubmittedKey = ''
    this.lastPublishedKey = ''
    this.lastHash = null
    this.lastKey = null
    this.lastText = ''
    this.lastLines = null
    this.lastFingerprint = null
    this.generation = null
    this.shownKey = null
    this.shownLines = null
    this.lineMisses.clear()
    this.emptyStreak = 0
    this.quietStreak = 0
    this.errorStreak = 0
    this.errorStage = null
    this.backoffUntil = 0
    this.lastRequestAt = Number.NEGATIVE_INFINITY
    this.requestHold = 0
    this.interval = this.settings.pollInterval
    this.counters = emptyCounters()
  }

  /**
   * Adopt a result that reached the overlay by another route.
   *
   * A manual scan, or the scan that switching the overlay's text on performs,
   * has already spent a request on this text and already published it. Both
   * deduplication keys are set from it, and the request clock is moved on, so
   * the automatic loop does not immediately make the same request again — which
   * is what "coordinated state" has to mean if the two paths are to share one
   * recogniser without doubling its cost.
   */
  noteExternalScan(text: string, lines?: ObservedLine[]): void {
    const key = identityKey(text ?? '')
    if (key === '') return
    this.lastSubmittedKey = key
    this.lastPublishedKey = key
    this.lastRequestAt = this.now()
    // The overlay is now drawing this, so it is what invalidation is measured
    // against. Without it a hand-triggered scan leaves boxes the loop does not
    // know about, and the blank that follows clears nothing.
    // A manually accepted frame belongs to the current selection already.
    // The first automatic observation must not treat it as an old source.
    this.generation = this.deps.generation?.() ?? this.generation
    this.lineMisses.clear()
    this.lineGate.reset()
    this.lineGate.cover(lines ?? null)
    this.shownLines = lines ?? null
    this.shownKey = stabilityKey(lines ? lines.map((line) => line.text).join('') : (text ?? ''))
    this.dropCandidate()
  }

  /** Kept for callers that only know the published string. */
  noteExternalText(text: string): void {
    this.noteExternalScan(text)
  }

  private schedule(): void {
    if (!this.running) return
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule())
    }, this.interval)
  }

  // --- the loop ------------------------------------------------------------

  /** One iteration, exposed so tests drive the machine rather than the clock. */
  async tick(): Promise<TickOutcome> {
    if (this.unavailable) {
      this.emit({ type: 'skip', reason: 'unavailable', detail: this.unavailableReason })
      return 'unavailable'
    }
    if (this.paused || this.suspended) {
      if (this.suspended) this.emit({ type: 'skip', reason: 'suspended' })
      return 'paused'
    }
    if (this.tickInFlight) return 'busy'
    // Our own recognition holds the shared lock; that is not a reason to stop
    // watching the screen.
    if (!this.inFlight && this.deps.isBusy?.()) {
      this.counters.lockedSkips++
      this.emit({ type: 'skip', reason: 'locked' })
      return 'busy'
    }
    const at = this.now()
    if (at < this.backoffUntil) {
      this.counters.backoffSkips++
      this.emit({ type: 'skip', reason: 'backoff', detail: `${this.backoffUntil - at}ms` })
      return 'backoff'
    }

    this.tickInFlight = true
    this.counters.ticks++
    try {
      const outcome = await this.runTick(at)
      // Every pin this tick queued must have actually been applied before the
      // loop is free to capture again: the next capture is what would evict a
      // candidate whose retain had not landed yet.
      await this.keeper.settled()
      return outcome
    } finally {
      this.tickInFlight = false
    }
  }

  /** One tick's work, with the guards and the pin drain left to `tick`. */
  private async runTick(at: number): Promise<TickOutcome> {
    // A queued job that the selection has already moved past is dropped before a
    // capture is spent on the tick that would have sent it.
    this.dropStalePending()

    let sample: CaptureSample<Frame>
    try {
      sample = await this.deps.captureFrame()
      this.counters.captures++
    } catch (error) {
      this.counters.captureErrors++
      this.recordError('capture', error)
      return 'error'
    }

    const generation = sample.generation ?? this.deps.generation?.() ?? 0
    this.invalidateOlderThan(generation)

    if (sample.observerUnsupported) {
      this.counters.observerUnsupported++
      // In image mode the user has chosen a signal that does not need it, so a
      // missing text observer is not an error and not a reason to stop.
      if (this.settings.observerMode === 'text') return this.observerUnavailable(sample)
    } else if (this.settings.observerMode === 'text' && !sample.observation) {
      return this.observerFailed(sample)
    }

    this.noteSuccess('observer')
    const outcome =
      this.settings.observerMode === 'image'
        ? await this.observeImage(sample, generation, at)
        : await this.observeText(sample, generation, at)

    // Only now is a queued job considered. Looking first is the point: the
    // screen may have emptied or moved on since the job was queued, in which
    // case it is obsolete and spending a request on it buys a result that would
    // be discarded on arrival anyway.
    if (outcome === 'observed' && this.drain()) return 'requested'
    this.adapt()
    return outcome
  }

  /**
   * Drop a queued job that no longer describes anything on screen.
   *
   * A pending job is by definition older than the latest observation — it is
   * waiting because the recogniser was busy or the spacing had not elapsed — so
   * the screen has had time to move past it.
   */
  private dropStalePending(): void {
    const pending = this.pending
    if (!pending) return
    const generation = this.deps.generation?.() ?? pending.generation
    const supersededByScreen = this.lastKey !== null && this.lastKey !== pending.key
    if (generation === pending.generation && !supersededByScreen) return
    this.counters.staleDiscarded++
    this.keeper.release(pending.frame)
    this.pending = null
    this.emit({
      type: 'skip',
      reason: 'stale-generation',
      detail: supersededByScreen ? 'the screen moved on before it ran' : 'the source changed'
    })
  }

  // --- observer health -----------------------------------------------------

  /**
   * No observer on this platform.
   *
   * Automatic mode goes explicitly unavailable rather than falling back to
   * sending every frame to the accurate recogniser. Manual scanning is
   * untouched, and `image` mode remains available if the user chooses it.
   */
  private observerUnavailable(sample: CaptureSample<Frame>): TickOutcome {
    this.unavailable = true
    this.unavailableReason =
      sample.observerError ??
      'Automatic scanning needs a local text observer, which this platform does not have yet. Manual scanning still works.'
    this.stopTimer()
    this.emit({ type: 'status', state: 'unavailable', message: this.unavailableReason })
    return 'unavailable'
  }

  /** The observer exists but did not answer: back off and retry, never upload. */
  private observerFailed(sample: CaptureSample<Frame>): TickOutcome {
    this.counters.observerErrors++
    this.recordError('observer', sample.observerError ?? 'the local text observer returned nothing')
    return 'error'
  }

  // --- text settling -------------------------------------------------------

  private async observeText(
    sample: CaptureSample<Frame>,
    generation: number,
    at: number
  ): Promise<TickOutcome> {
    const observation = sample.observation as Observation
    let text = observation.text ?? ''
    let key = stabilityKey(text)
    let lines = observation.lines ?? []

    if (sample.hash && this.lastHash === sample.hash) this.counters.hashUnchanged++
    this.lastHash = sample.hash ?? null
    this.counters.observations++

    // Byte-identical pixels cannot be showing different words. A reading that
    // changed while the digest did not is the observer disagreeing with itself,
    // and treating it as new text is what turns a still screen into a stream of
    // requests. The previous reading stands, and — crucially — it still counts as
    // an observation, so an unchanging screen still settles.
    //
    // Only ever applied in this direction. A different digest never suppresses
    // anything: two frames whose pixels differ may differ by the one glyph that
    // changes the sentence.
    const fingerprint = sample.contentFingerprint ?? null
    if (
      fingerprint !== null &&
      fingerprint === this.lastFingerprint &&
      this.lastKey !== null &&
      key !== this.lastKey
    ) {
      this.counters.fingerprintSuppressed++
      key = this.lastKey
      text = this.lastText
      lines = this.lastLines ?? []
    }
    this.lastFingerprint = fingerprint

    const lineReady = this.lineGate.observe(
      lines,
      this.settings.boxTolerancePx,
      this.settings.stableObservations
    )
    const layout = layoutSignature(lines)

    const relation = classify(this.candidate?.key ?? null, key)
    this.emit({
      type: 'observation',
      relation,
      stable: this.candidate?.count ?? 0,
      chars: key.length,
      layout
    })

    // Blank is checked first, and deliberately so. An empty screen also fails the
    // "still the same words" test below, so testing that first would report every
    // disappearance as `changed` and `empty` would never be emitted at all — and
    // the two are not interchangeable to a caller deciding what to tear down.
    if (relation === 'empty') return this.observeEmpty(at)

    // Otherwise: if the words on screen are not the words the overlay is drawing
    // over them, its boxes are wrong now, not when a replacement result
    // eventually arrives.
    if (this.shownKey !== null && (key !== this.shownKey || this.lineMisses.size > 0)) {
      const previousCount = this.shownLines?.length ?? 0
      const surviving = confirmedCurrentLines(
        this.shownLines,
        lines,
        this.settings.boxTolerancePx,
        this.lineMisses
      )
      if (surviving.length) {
        this.shownLines = surviving
        this.shownKey = key
        // A changed reading elsewhere should not even redraw the verified lines.
        if (surviving.length < previousCount) {
          this.counters.invalidations++
          this.emit({
            type: 'visual-invalidated',
            reason: 'changed',
            chars: key.length,
            keepBoxes: surviving.map((line) => line.box)
          })
        }
      } else this.invalidate('changed')
    }

    this.emptyStreak = 0
    if (relation === 'identical') this.quietStreak++
    else this.quietStreak = 0

    const fresh = (runStartedAt: number, count: number): Candidate<Frame> => ({
      key,
      text,
      lines,
      frame: sample.frame,
      generation,
      count,
      runStartedAt,
      layout,
      submitted: false
    })

    switch (relation) {
      case 'first':
      case 'replacement': {
        this.shrink = null
        this.adoptCandidate(fresh(at, 1))
        this.counters.candidates++
        this.emit({ type: 'candidate', action: 'new', ageMs: 0 })
        break
      }
      case 'identical': {
        this.shrink = null
        const previous = this.candidate as Candidate<Frame>
        this.adoptCandidate(
          previous.submitted
            ? // Already recognised: there is nothing left to send, so the frame
              // is left alone rather than re-pinned on every quiet tick.
              { ...previous, count: previous.count + 1, lines, layout }
            : // Still waiting to settle: keep the freshest frame, which is the
              // closest in time to the recognition about to happen and says the
              // same thing. Text and frame therefore always agree.
              fresh(previous.runStartedAt, previous.count + 1)
        )
        break
      }
      case 'shrink': {
        // A dropped tail is usually the observer losing the last glyph, not the
        // screen losing a character, so the longer reading is kept. But if the
        // shorter one repeats, the screen really did change and it takes over.
        const streak = this.shrink && this.shrink.key === key ? this.shrink.count + 1 : 1
        const held = this.candidate as Candidate<Frame>
        this.shrink = { key, sample: fresh(held.runStartedAt, streak), count: streak }
        if (streak >= this.settings.stableObservations) {
          this.adoptCandidate(this.shrink.sample)
          this.shrink = null
        } else {
          // The candidate stands, but it is no longer settled.
          this.candidate = { ...held, count: 0, submitted: false }
          this.emit({ type: 'candidate', action: 'evolving', ageMs: at - held.runStartedAt })
        }
        break
      }
      default: {
        // growth / evolving: the same line, still being drawn.
        this.shrink = null
        const previous = this.candidate as Candidate<Frame>
        const longer = key.length >= previous.key.length ? fresh(previous.runStartedAt, 1) : null
        this.adoptCandidate(longer ?? { ...previous, count: 1, submitted: false })
        this.emit({ type: 'candidate', action: 'evolving', ageMs: at - previous.runStartedAt })
        break
      }
    }

    // Remember the layout of this observation, whatever happens to the
    // candidate: a replacement drawn into the same box has to be recognisable as
    // such even when the line before it has already been sent.
    const previousKey = this.lastKey
    const previousLines = this.lastLines
    this.lastKey = key
    this.lastText = text
    this.lastLines = lines
    if (
      previousKey !== null &&
      previousKey !== key &&
      sameLayout(previousLines, lines, this.settings.boxTolerancePx)
    ) {
      this.counters.sameLayoutReplacements++
    }

    const candidate = this.candidate
    if (!candidate || candidate.submitted) return 'observed'
    // Whole-page ordering/noise cannot re-request a set of already covered lines.
    if (lines.length > 1 && !lineReady) return 'observed'

    if (lines.length > 1 && lineReady && candidate.count < this.settings.stableObservations) {
      this.counters.settled++
      this.emit({ type: 'candidate', action: 'settled', ageMs: at - candidate.runStartedAt })
      return this.submit('stable-line', at)
    }
    if (candidate.count >= this.settings.stableObservations) {
      this.counters.settled++
      this.emit({ type: 'candidate', action: 'settled', ageMs: at - candidate.runStartedAt })
      return this.submit('settled', at)
    }
    if (at - candidate.runStartedAt >= this.settings.maxCandidateAgeMs) {
      // Still moving after the bounded wait. Recognise the most complete reading
      // rather than starving the reader of a line that never stops animating.
      // The clock restarts, so text that animates forever costs one request per
      // bounded wait rather than one per frame.
      this.counters.maxWaitFlushes++
      this.emit({ type: 'candidate', action: 'expired', ageMs: at - candidate.runStartedAt })
      const outcome = await this.submit('max-wait', at)
      candidate.runStartedAt = at
      return outcome
    }
    return 'observed'
  }

  /**
   * The text went away.
   *
   * A candidate still being drawn when the screen clears is recognised anyway —
   * short-lived text is text the reader saw and wants. After
   * `emptyObservationsToClear` blank observations the deduplication keys are
   * cleared too, so the same line appearing again later is genuinely new.
   */
  private async observeEmpty(at: number): Promise<TickOutcome> {
    this.counters.emptyObservations++
    this.emptyStreak++
    this.quietStreak++
    this.shrink = null
    // The first blank observation is proof enough that the boxes are wrong. It
    // does not wait for the candidate to settle, for a request, or for an
    // endpoint that may be failing or backed off — the text is gone either way.
    this.invalidate('empty')
    this.lineGate.reset()

    this.lastKey = ''
    this.lastLines = null

    const candidate = this.candidate
    let outcome: TickOutcome = 'observed'
    if (candidate && !candidate.submitted) {
      this.counters.disappearanceFlushes++
      this.emit({ type: 'candidate', action: 'dropped', ageMs: at - candidate.runStartedAt })
      outcome = await this.submit('disappeared', at)
    }
    this.dropCandidate()

    if (this.emptyStreak >= this.settings.emptyObservationsToClear) {
      this.lastSubmittedKey = ''
      this.lastPublishedKey = ''
    }
    return outcome
  }

  // --- image settling (explicitly chosen, never a fallback) ----------------

  private async observeImage(
    sample: CaptureSample<Frame>,
    generation: number,
    at: number
  ): Promise<TickOutcome> {
    const hash = sample.hash ?? null
    if (!hash) {
      this.recordError('observer', 'image mode needs a native frame hash, which was not produced')
      return 'error'
    }
    this.counters.observations++
    const previous = this.candidate
    const same =
      previous !== null && hammingDistance(previous.key, hash) <= this.settings.imageHashThreshold
    if (same) this.counters.hashUnchanged++
    this.lastHash = hash

    const next: Candidate<Frame> = {
      key: hash,
      // Image mode has no text of its own, so submission cannot deduplicate on
      // meaning. Only the post-recognition publication check can.
      text: '',
      lines: null,
      frame: sample.frame,
      generation,
      count: same ? (previous as Candidate<Frame>).count + 1 : 1,
      runStartedAt: same ? (previous as Candidate<Frame>).runStartedAt : at,
      layout: 'image',
      submitted: same ? (previous as Candidate<Frame>).submitted : false
    }
    if (same) this.quietStreak++
    else {
      this.quietStreak = 0
      this.counters.candidates++
    }
    this.adoptCandidate(next)
    this.emit({
      type: 'observation',
      relation: same ? 'identical' : 'replacement',
      stable: next.count,
      chars: 0,
      layout: 'image'
    })

    if (next.count === this.settings.stableObservations) {
      this.counters.settled++
      return this.submit('settled', at)
    }
    return 'observed'
  }

  // --- candidate bookkeeping ----------------------------------------------

  /** Swap in a new candidate, pinning its frame before unpinning the old one. */
  private adoptCandidate(next: Candidate<Frame>): void {
    const previous = this.candidate
    this.keeper.retain(next.frame)
    this.candidate = next
    if (previous) this.keeper.release(previous.frame)
  }

  private dropCandidate(): void {
    const previous = this.candidate
    this.candidate = null
    this.shrink = null
    if (previous) this.keeper.release(previous.frame)
  }

  /** A selection change makes every frame older than it meaningless. */
  private invalidateOlderThan(generation: number): void {
    if (this.generation !== generation) {
      this.generation = generation
      this.lineGate.reset()
      // Whatever is drawn belongs to the window that was selected before.
      this.invalidate('source')
      this.lastKey = null
      this.lastText = ''
      this.lastLines = null
      this.lastFingerprint = null
    }
    if (this.candidate && this.candidate.generation !== generation) {
      this.counters.staleDiscarded++
      this.dropCandidate()
    }
    if (this.pending && this.pending.generation !== generation) {
      this.counters.staleDiscarded++
      this.keeper.release(this.pending.frame)
      this.pending = null
      this.emit({ type: 'skip', reason: 'stale-generation' })
    }
  }

  // --- submission ----------------------------------------------------------

  /**
   * Spend a recognition on the settled candidate, if it is worth spending.
   *
   * The candidate is marked rather than removed. It stays as the thing the next
   * observation is compared against, and the request gets its own reference to
   * the frame, so the two lifetimes are independent: a candidate replaced by new
   * dialogue cannot unpin an image a request is still using, and a finished
   * request cannot unpin the candidate still being watched.
   */
  private async submit(reason: string, at: number): Promise<TickOutcome> {
    const candidate = this.candidate
    if (!candidate || candidate.submitted) return 'observed'
    candidate.submitted = true

    const key = identityKey(candidate.text)
    if (key !== '' && key === this.lastSubmittedKey) {
      // The same sentence we already paid to recognise. This is the check that
      // makes a stationary dialogue box cost nothing at all.
      this.counters.suppressedDuplicateSubmission++
      this.emit({ type: 'skip', reason: 'duplicate-submission' })
      return 'observed'
    }

    const job: Candidate<Frame> = { ...candidate }
    this.keeper.retain(job.frame)

    if (at < this.requestHold) {
      // Held, not dropped: the reader is busy with this line, and it is still
      // the line they will want recognised when they are done with it.
      this.setPending(job, 'held')
      return 'queued'
    }
    if (this.inFlight) {
      this.setPending(job, 'in-flight')
      return 'queued'
    }
    if (at - this.lastRequestAt < this.settings.minRequestSpacingMs) {
      this.counters.spacingDeferrals++
      this.setPending(job, 'spacing')
      return 'queued'
    }

    this.begin(job, reason)
    return 'requested'
  }

  /**
   * Hold one job, and only the newest.
   *
   * A queue would let a burst of dialogue become a burst of requests arriving
   * after the reader has moved on. Replacing means the request that eventually
   * runs describes what is on screen now. The displaced job's frame is unpinned
   * here, which is the only place a frame that never reached the recogniser is
   * let go of.
   */
  private setPending(job: Candidate<Frame>, reason: SkipReason): void {
    const displaced = this.pending
    this.pending = job
    if (displaced) {
      this.counters.replacedPending++
      this.keeper.release(displaced.frame)
    }
    this.emit({ type: 'request', reason, queued: true, replaced: displaced !== null }, job.frame)
  }

  /** Start the pending job if it is due. True when one was started. */
  private drain(): boolean {
    if (!this.pending || this.inFlight || this.suspended || this.paused || this.unavailable) {
      return false
    }
    const at = this.now()
    if (at < this.requestHold) return false
    if (at - this.lastRequestAt < this.settings.minRequestSpacingMs) return false
    const generation = this.deps.generation?.() ?? this.pending.generation
    if (this.pending.generation !== generation) {
      this.counters.staleDiscarded++
      this.keeper.release(this.pending.frame)
      this.pending = null
      this.emit({ type: 'skip', reason: 'stale-generation' })
      return false
    }
    const next = this.pending
    this.pending = null
    return this.begin(next, 'pending')
  }

  /**
   * Start a recognition, without waiting for it.
   *
   * Deliberately not awaited by the tick that triggered it. The endpoint has a
   * 45-second timeout; blocking the loop on it would mean three quarters of a
   * minute in which the screen is not being watched at all, and the reader's
   * next line arriving during a slow request would simply be missed.
   */
  private begin(job: Candidate<Frame>, reason: string): boolean {
    if (this.deps.tryAcquire && !this.deps.tryAcquire()) {
      // A hand-triggered scan has the recogniser. Keep the job and try again on
      // the next tick rather than running two recognitions at once.
      this.counters.lockedSkips++
      this.emit({ type: 'skip', reason: 'locked' })
      this.setPending(job, 'locked')
      return false
    }
    this.inFlight = job
    this.lastRequestAt = this.now()
    this.deps.onScanStart?.()
    const token = ++this.runToken
    this.inFlightPromise = this.run(job, reason, this.epoch, token)
    return true
  }

  /**
   * Recognise one frame and apply its result, start to finish.
   *
   * Owns the shared lock and the in-flight slot for the whole of that, result
   * application included. Letting either go at the moment the endpoint answers
   * would leave a manual scan free to publish into the same overlay while this
   * one is still writing to it, and would let the next tick start a second
   * recognition before the first had finished being applied.
   *
   * It is still not awaited by the tick that started it, so observation carries
   * on throughout: what is serialised here is recognising and publishing, not
   * looking at the screen.
   */
  private async run(
    job: Candidate<Frame>,
    reason: string,
    epoch: number,
    token: number
  ): Promise<void> {
    try {
      // The frame has to be pinned before it is worth sending. `retain` is a
      // native round trip that may still be queued, or may have been refused
      // outright, and recognising an unpinned frame means recognising whatever
      // the store has evicted it for.
      if (!(await this.keeper.pinned(job.frame))) {
        this.counters.unpinnedDiscards++
        this.emit({ type: 'skip', reason: 'unpinned' })
        // The text was never recognised, so it is still owed a request: let the
        // candidate be settled again rather than leaving it marked as sent.
        this.allowRetry(job)
        this.recordError(
          'pin',
          'the captured frame could not be pinned, so it was not sent for recognition'
        )
        return
      }

      // Waiting for the pin is waiting, and the world moves while you wait. The
      // user can change source, re-crop, or switch automatic scanning off in that
      // window, and every one of those makes this frame something that must not
      // be uploaded. Checked here, after the await and before anything is spent.
      if (!this.stillWanted(job, epoch)) {
        this.counters.staleDiscarded++
        this.emit({ type: 'skip', reason: 'stale-generation', detail: 'changed while pinning' })
        return
      }

      this.lineGate.cover(job.lines)
      this.counters.requests++
      this.emit({ type: 'request', reason, queued: false, replaced: false }, job.frame)

      let result: OcrResult | null = null
      try {
        result = await this.deps.recognize(job.frame)
        this.noteSuccess('recognize')
      } catch (error) {
        this.counters.requestErrors++
        this.recordError('recognize', error)
        // The text was never actually recognised, so it is still owed a request.
        // Without this the candidate stays marked as sent and the same line is
        // never retried, even once the endpoint comes back. The error backoff,
        // not this flag, is what stops a failure from becoming a retry storm.
        this.allowRetry(job)
        return
      }

      if (this.paused) {
        // Paused while it was out: nothing may change under the reader. Still owed, so the
        // candidate settles again once the loop resumes.
        this.counters.staleDiscarded++
        this.emit({ type: 'skip', reason: 'held', detail: 'paused while recognising' }, job.frame)
        this.allowRetry(job)
        return
      }
      if (result) await this.accept(result, job, reason, epoch)
      else this.counters.emptyResults++
    } catch (error) {
      this.recordError('publish', error)
      this.allowRetry(job)
    } finally {
      // Everything is given up together, and only once the result has been
      // applied: the lock, the in-flight slot, and the frame's pin. The overlay
      // pins what it publishes, so letting go of the frame any earlier would let
      // the next probe evict the very image the published scan points at.
      this.inFlight = null
      this.deps.releaseLock?.()
      this.deps.onScanEnd?.()
      this.keeper.release(job.frame)
      // Only if no newer run has claimed the slot in the meantime.
      if (this.runToken === token) this.inFlightPromise = null
    }
  }

  /**
   * Is this job still worth spending a request on?
   *
   * Two ways it can stop being, and both are reachable from outside the loop
   * while a pin is in flight: the session ended (`stop` or `reset`, either of
   * which bumps the epoch), or the selection moved on. The suspended and
   * unavailable checks are defensive — a tick holds the pin queue, so nothing
   * inside the loop can reach those states in this window — and cost nothing.
   */
  private stillWanted(job: Candidate<Frame>, epoch: number): boolean {
    if (epoch !== this.epoch) return false
    if (this.suspended || this.unavailable) return false
    const generation = this.deps.generation?.() ?? job.generation
    return generation === job.generation
  }

  /**
   * Let the candidate this job came from settle again.
   *
   * A request that was never made leaves its text unrecognised, and the candidate
   * is still marked as sent. Clearing that is what lets the next identical
   * observation re-settle it, so a transient failure costs a delay rather than
   * the line.
   */
  private allowRetry(job: Candidate<Frame>): void {
    this.lineGate.cover(null)
    if (
      this.candidate &&
      this.candidate.key === job.key &&
      this.candidate.generation === job.generation
    ) {
      this.candidate.submitted = false
    }
  }

  private async accept(
    result: OcrResult,
    candidate: Candidate<Frame>,
    reason: string,
    epoch: number
  ): Promise<void> {
    if (epoch !== this.epoch) {
      this.counters.staleDiscarded++
      this.emit(
        { type: 'skip', reason: 'stale-generation', detail: 'session ended' },
        candidate.frame
      )
      return
    }
    // The live generation, not the one the tick started with: the selection can
    // change while a request is out, and drawing this would put the old window's
    // words over the new one's.
    const generation = this.deps.generation?.() ?? candidate.generation
    if (generation !== candidate.generation) {
      this.counters.staleDiscarded++
      this.emit({ type: 'skip', reason: 'stale-generation' }, candidate.frame)
      return
    }

    // And the screen itself may have moved on. A result describes the frame it
    // was made from; if the words on screen are no longer those words — because
    // the line advanced, or because the box emptied — then drawing it puts boxes
    // over text that is not there. The observation path has already invalidated
    // what was drawn; this stops the late result from putting it back.
    let partial = false
    let surviving = candidate.lines
    if (this.lastKey !== null && this.lastKey !== candidate.key) {
      surviving = currentLines(candidate.lines, this.lastLines, this.settings.boxTolerancePx)
      const annotations = annotationsInLines(
        result.textAnnotations,
        surviving.map((line) => line.box)
      )
      if (!annotations.length || result.geometry === false) {
        this.counters.supersededResults++
        this.lineGate.cover(null)
        this.emit({ type: 'skip', reason: 'superseded' }, candidate.frame)
        return
      }
      // The rest of the screen moved on, but these exact lines did not. Show
      // only their verified geometry; never publish a fragment to history.
      partial = true
      result = { ...result, textAnnotations: annotations, fullText: annotations[0].description }
    }
    // Only now, on a result that is actually ours: a failed or discarded request
    // must not mark this text as already spent.
    if (!partial && candidate.text !== '') this.lastSubmittedKey = identityKey(candidate.text)

    const key = identityKey(result.fullText ?? '')
    if (key === '') {
      this.counters.emptyResults++
      this.emit({ type: 'skip', reason: 'empty-result' }, candidate.frame)
      return
    }
    const publish = !partial && key !== this.lastPublishedKey
    if (publish) {
      this.lastPublishedKey = key
      this.counters.published++
    } else {
      if (partial) this.counters.partialResults++
      else this.counters.suppressedDuplicatePublication++
      this.counters.refreshedWithoutPublishing++
    }
    // What the overlay is about to draw. Invalidation is measured against this,
    // so it has to be the text the result describes — which is the candidate's
    // reading of the screen, not the recogniser's rendering of it.
    this.lineMisses.clear()
    this.shownKey = partial ? this.lastKey : candidate.key
    this.shownLines = surviving
    this.lineGate.cover(surviving)
    this.emit(
      {
        type: 'result',
        published: publish,
        reason: partial ? 'partial-current-lines' : reason,
        chars: key.length
      },
      candidate.frame
    )
    await this.deps.onResult(result, candidate.frame, { publish, reason, generation })
  }

  // --- errors --------------------------------------------------------------

  /** Clear the backoff, but only the one this stage is responsible for. */
  private noteSuccess(stage: string): void {
    if (this.errorStage !== null && this.errorStage !== stage) return
    this.errorStreak = 0
    this.errorStage = null
    this.backoffUntil = 0
  }

  private recordError(stage: string, error: unknown): void {
    this.errorStreak = this.errorStage === stage ? this.errorStreak + 1 : 1
    this.errorStage = stage
    const backoff = Math.min(
      this.settings.errorBackoffMs * 2 ** (this.errorStreak - 1),
      this.settings.maxErrorBackoffMs
    )
    this.backoffUntil = this.now() + backoff
    const message = typeof error === 'string' ? error : String((error as Error)?.message ?? error)
    this.emit({ type: 'error', stage, message, backoffMs: backoff })

    if (this.errorStreak >= this.settings.maxConsecutiveErrors) {
      this.suspended = true
      this.unavailableReason = `Automatic scanning suspended after ${this.errorStreak} consecutive failures (${stage}). Manual scanning still works.`
      this.stopTimer()
      this.emit({ type: 'status', state: 'suspended', message: this.unavailableReason })
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * Back off while nothing is happening, snap back the moment it is.
   *
   * Driven by observations rather than by results, which is the fix for the
   * cadence bug: punctuation jitter used to look like new text every tick and
   * hold the loop at 500 ms forever. It no longer survives `stabilityKey`, so a
   * frozen screen actually reads as frozen.
   */
  private adapt(): void {
    const { adaptivePollingEnabled, adaptivePollMin, adaptivePollMax, pollInterval } = this.settings
    if (!adaptivePollingEnabled) {
      this.interval = pollInterval
      return
    }
    if (this.quietStreak === 0) {
      // Something on screen is moving: watch it closely.
      this.interval = adaptivePollMin
      return
    }
    if (this.quietStreak >= 5) this.interval = Math.min(this.interval * 1.5, adaptivePollMax)
    else this.interval = Math.max(adaptivePollMin, Math.min(pollInterval, this.interval))
  }
}
