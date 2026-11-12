/**
 * Automatic OCR on a scene memory.
 *
 * The loop is the same shape as before — capture cheaply and often, read the frame locally,
 * spend the accurate recogniser only when it is justified — but what it reasons about is
 * different. `AutoScanner` compared one string per frame, so anything moving anywhere on
 * screen restarted everything, and whatever the recogniser said last replaced what was drawn.
 * This hands every observation to a `SceneMemory` (see scene.ts), which follows each line on
 * its own, learns which lines blink or churn, and keeps the best reading of each version of
 * each line. The loop's job shrinks to timing:
 *
 *  - **When to look.** Often while any line is still moving, easing off when nothing is.
 *  - **When to recognise.** When the memory says a passage has settled with a line nobody has
 *    read yet, or has a doubted reading worth a second opinion, or a passage has been moving
 *    for longer than anyone will wait. Lines already being recognised are not asked for twice.
 *  - **What to rescue.** A line that disappears before it was ever read is recognised from the
 *    last frame that showed it, so fast-forwarded dialogue still reaches the history.
 *  - **When the observer is blind.** A screen the observer reads nothing on, whose pixels have
 *    changed and then held still, is recognised once — text in a font the observer cannot read
 *    still gets drawn. Screens that keep yielding nothing are tried less and less often.
 *
 * What is drawn changes only through the memory, and every change goes out through
 * `onScene`: lines that went are taken off the moment the observer stops seeing them, new
 * readings are added as they land, and text appears in the history once, when it is new.
 *
 * The plumbing — frame pins, the shared lock with manual scans, error backoff, holds while the
 * reader is looking something up — is the same as `AutoScanner`'s, and so is the dependency
 * contract, so the overlay drives either one.
 */

import {
  FrameKeeper,
  migrateAutoScanSettings,
  isSourceOutOfView,
  DEFAULT_AUTO_OCR_SETTINGS,
  type AutoScanDeps,
  type AutoScanEvent,
  type AutoScanSettings,
  type AutoScanState,
  type CaptureSample,
  type TickOutcome
} from './autoscan.js'
import { SceneMemory, type Passage, type SceneSnapshot, type SceneStats } from './scene.js'
import type { ObservedLine } from './observation.js'
import type { OcrResult } from './ocr-result.js'
import { hammingDistance } from './dhash.js'

/** What the overlay should now draw, and what, if anything, is new enough to publish. */
export interface SceneUpdate<Frame> {
  /** Every reading currently shown, as one result. */
  result: OcrResult
  /**
   * Passages for the history, clipboard and texthooker, each once it has finished arriving.
   * One with `replaces` is a better or fuller reading of a passage already published: its
   * history entry should be replaced rather than added to.
   */
  publish: Passage[]
  /** The frame of the recognition behind this update; null when only the drawing changed. */
  frame: Frame | null
  reason: string
  generation: number
}

export type SceneScanEvent =
  | AutoScanEvent
  | ({ type: 'scene'; reason: string } & SceneStats)

export interface SceneScanDeps<Frame> extends Omit<AutoScanDeps<Frame>, 'onResult' | 'onEvent' | 'onDiagnostic'> {
  onScene(update: SceneUpdate<Frame>): void | Promise<void>
  onEvent?(event: SceneScanEvent): void
  onDiagnostic?(
    event: SceneScanEvent,
    frame: Frame | undefined,
    counters: SceneCounters,
    context: { intervalMs: number; holdMs: number; generation: number; tick: number; confirming: boolean }
  ): void
}

export interface SceneCounters {
  ticks: number
  captures: number
  observations: number
  emptyObservations: number
  observerErrors: number
  requests: number
  settledRequests: number
  maxWaitRequests: number
  secondOpinions: number
  rescues: number
  blindRequests: number
  requestErrors: number
  captureErrors: number
  emptyResults: number
  readingsFiled: number
  readingsImproved: number
  readingsRejected: number
  staleReadings: number
  published: number
  redraws: number
  heldSkips: number
  spacingDeferrals: number
  lockedSkips: number
  backoffSkips: number
  staleDiscarded: number
  fingerprintSuppressed: number
  pinFailures: number
  /** Looks whose read was skipped because the pixels were still moving. */
  stillSkips: number
}

function emptyCounters(): SceneCounters {
  return {
    ticks: 0,
    captures: 0,
    observations: 0,
    emptyObservations: 0,
    observerErrors: 0,
    requests: 0,
    settledRequests: 0,
    maxWaitRequests: 0,
    secondOpinions: 0,
    rescues: 0,
    blindRequests: 0,
    requestErrors: 0,
    captureErrors: 0,
    emptyResults: 0,
    readingsFiled: 0,
    readingsImproved: 0,
    readingsRejected: 0,
    staleReadings: 0,
    published: 0,
    redraws: 0,
    heldSkips: 0,
    spacingDeferrals: 0,
    lockedSkips: 0,
    backoffSkips: 0,
    staleDiscarded: 0,
    fingerprintSuppressed: 0,
    pinFailures: 0,
    stillSkips: 0
  }
}

type Mode = 'auto' | 'blind'

interface Job<Frame> {
  frame: Frame
  snapshot: SceneSnapshot
  generation: number
  reason: string
  mode: Mode
}

/** Longest gap between looks while anything on screen is moving or being read. */
const ACTIVE_POLL_MS = 100

/**
 * Looks are at least this many watcher reads apart. A watcher on a GPU reads a frame in
 * 10-40 ms and is unaffected; PaddleOCR on a CPU (90-250 ms) would otherwise spend most of
 * the processor watching while the game runs.
 */
const WATCH_COST_FACTOR = 3
/**
 * The same budget while a line nobody has read yet waits for the look that confirms it has
 * stopped (`SceneMemory.awaitingConfirmation`). That look is what the reader is waiting on:
 * three reads apart, a CPU watcher at 350 ms a read made a line that had finished typing wait
 * over two seconds for its confirmation. The hurry lasts only until the line is read.
 */
const CONFIRM_COST_FACTOR = 0.5
/** However slow the watcher, look at least this often. */
const WATCH_COST_MAX_GAP_MS = 2000

/**
 * When nothing on screen is moving, looks are paced by what they actually cost, not by what a
 * read costs. A look at unchanged pixels is a capture and a fingerprint (the watcher's cache
 * answers), a few milliseconds on a fast machine; a look at changed pixels is a read. Spending
 * at most 1/IDLE_COST_FACTOR of a core on looking, a fast machine notices a new line within a
 * tenth of a second, while a slow one (or a busy one: contention shows up as slower looks)
 * backs off on its own, up to `adaptivePollMax`.
 */
const IDLE_COST_FACTOR = 10
/** Fastest idle cadence: below this, looks are mostly scheduling overhead. */
const IDLE_MIN_GAP_MS = 100
/** Looks the typical look cost is the median of. */
const LOOK_COST_WINDOW = 9

/**
 * A watcher this slow reads only pixels that have held still since the last look.
 *
 * Settling a line takes a read that finds it and a look that confirms it. With a slow watcher
 * (OneOCR or Screen AI on a modest CPU: 300-500 ms) the read lands while the line is still
 * typing or fading in, so it is read again, and again; each costs a read, and the confirming
 * look waits behind them. Asking the watcher to read only a frame identical to the previous
 * look's (`readIfStill`) costs one cheap look and saves those reads: nothing is read while the
 * line moves, the first still frame is read once, and the next look confirms it from the
 * watcher's cache. A fast watcher reads at once, where waiting would cost more than it saves.
 */
const STILL_GATE_READ_MS = 250
/**
 * The gate needs a screen that holds still between lines. One whose pixels have not matched
 * from one look to the next for this long is animating (a background behind the text), where
 * waiting for stillness only delays reads: the gate stays off until the screen holds still.
 */
const STILL_GATE_ANIMATED_MS = 3000
/**
 * Pixels that never hold still (a background animating behind the text) would starve the gate:
 * after moving this long, or three reads' worth if longer, the next look reads anyway.
 */
const STILL_GATE_MAX_WAIT_MS = 600
/** Gated looks are at least this many looks' cost apart (a fifth of a core, at most). */
const GATED_LOOK_FACTOR = 5

/** Shortest wait between two recognitions of a screen the observer reads nothing on. */
const BLIND_GAP_MS = 1500
const BLIND_MAX_GAP_MS = 30000

export class SceneScanner<Frame = unknown> {
  private settings: AutoScanSettings
  private readonly keeper: FrameKeeper<Frame>
  private readonly scene = new SceneMemory()

  private running = false
  private paused = false
  private suspended = false
  private unavailable = false
  private unavailableReason = ''
  private tickInFlight = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private interval: number
  /** The watcher's recent read time (moving average), which paces the looks. */
  private watchCostMs = 0
  /**
   * What a look typically costs from start to finish, cache hits included: the median of the
   * last few. A median, not an average: one read among cache hits (a window repainting, a
   * cursor blinking) should not slow every look after it, while a screen where every look is a
   * read (a background animating under the text) makes the median a read, and keeps the pace
   * that protects the CPU.
   */
  private lookCostMs = 0
  private recentLooks: number[] = []
  private coldLook = true
  /** The last look's pixel fingerprint, read or not, for `readIfStill`. */
  private seenFingerprint: string | null = null
  /** When the pixels started moving, while reads wait for them to hold still. */
  private movingSince: number | null = null
  /** When two looks in a row last saw identical pixels. */
  private stillAt = Number.NEGATIVE_INFINITY
  /** The current interval was shortened for a line waiting to be confirmed. */
  private confirming = false
  private quietStreak = 0
  private epoch = 0

  private generation: number | null = null
  /** The newest frame and what it showed, pinned until the next one, for rescues. */
  private latest: { frame: Frame; snapshot: SceneSnapshot } | null = null
  private lastLines: ObservedLine[] | null = null
  private lastFingerprint: string | null = null

  private inFlight: Job<Frame> | null = null
  private inFlightPromise: Promise<void> | null = null
  private runToken = 0
  /** A rescue that could not run at once: its text is gone from the screen, so it waits. */
  private pending: Job<Frame> | null = null
  private lastRequestAt = Number.NEGATIVE_INFINITY
  private requestHold = 0
  /** The next tick recognises whatever is owed without waiting for it to settle. */
  private forceNext = false

  private errorStreak = 0
  private errorStage: string | null = null
  private backoffUntil = 0

  /** Blind mode: the screen's hash, how long it has held, and what was last recognised. */
  private blindHash: string | null = null
  private blindSteady = 0
  private blindRead: string | null = null
  private blindAt = Number.NEGATIVE_INFINITY
  private blindEmpty = 0

  private counters = emptyCounters()

  constructor(
    private deps: SceneScanDeps<Frame>,
    settings: AutoScanSettings = DEFAULT_AUTO_OCR_SETTINGS
  ) {
    this.settings = migrateAutoScanSettings(settings)
    this.configureScene()
    this.interval = this.settings.pollInterval
    this.keeper = new FrameKeeper(
      deps.retainFrame?.bind(deps),
      deps.releaseFrame?.bind(deps),
      (operation, error) => {
        this.counters.pinFailures++
        this.emit({
          type: 'error',
          stage: `pin-${operation}`,
          message: typeof error === 'string' ? error : String((error as Error)?.message ?? error),
          backoffMs: 0
        })
      }
    )
  }

  // --- inspection ----------------------------------------------------------------------

  get isRunning(): boolean {
    return this.running
  }
  get isPaused(): boolean {
    return this.paused
  }
  get currentInterval(): number {
    return this.interval
  }
  get state(): AutoScanState {
    if (this.unavailable) return 'unavailable'
    if (this.suspended) return 'suspended'
    if (this.paused) return 'paused'
    return this.running ? 'running' : 'idle'
  }
  get stateReason(): string {
    return this.unavailableReason
  }
  get retainedFrames(): number {
    return this.keeper.held
  }
  get requestsHeld(): boolean {
    return this.now() < this.requestHold
  }
  stats(): SceneCounters & { scene: SceneStats } {
    return { ...this.counters, scene: this.scene.stats(this.now()) }
  }
  /** What is shown now, as one result. */
  composite(): OcrResult {
    return this.scene.composite()
  }
  pinsSettled(): Promise<void> {
    return this.keeper.settled()
  }
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

  private emit(event: SceneScanEvent, frame?: Frame): void {
    this.deps.onEvent?.(event)
    try {
      this.deps.onDiagnostic?.(event, frame, { ...this.counters }, {
        intervalMs: this.interval,
        holdMs: Math.max(0, this.requestHold - this.now()),
        generation: this.deps.generation?.() ?? 0,
        tick: this.counters.ticks,
        confirming: this.confirming
      })
    } catch {
      /* Diagnostics cannot change recognition behaviour. */
    }
  }

  // --- lifecycle -----------------------------------------------------------------------

  private configureScene(): void {
    this.scene.configure({ stableObservations: this.settings.stableObservations })
  }

  updateSettings(settings: AutoScanSettings): void {
    this.settings = migrateAutoScanSettings(settings)
    this.configureScene()
    this.interval = this.settings.adaptivePollingEnabled
      ? Math.min(Math.max(this.interval, this.settings.adaptivePollMin), this.settings.adaptivePollMax)
      : this.settings.pollInterval
  }

  start(): void {
    if (this.running) return
    this.running = true
    // The first look after starting loads the engine (Live Text took 650 ms cold against 8 ms
    // warm): it says nothing about what looking costs, and would hold the next looks back.
    this.recentLooks = []
    this.coldLook = true
    this.seenFingerprint = null
    this.movingSince = null
    this.stillAt = Number.NEGATIVE_INFINITY
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

  /** Stop and let go of everything; a recognition already out finishes, and is discarded. */
  stop(): void {
    this.running = false
    this.stopTimer()
    this.epoch++
    this.forgetFrames()
    this.emit({ type: 'status', state: 'idle', message: 'Automatic scanning stopped.' })
  }

  /** The reader cleared their log: text published before may be published again. */
  forgetPublished(): void {
    this.scene.forgetPublished()
  }

  /** Forget the screen: a different source or crop, a wake from sleep. */
  reset(): void {
    this.epoch++
    this.forgetFrames()
    this.scene.reset()
    this.generation = null
    this.lastLines = null
    this.lastFingerprint = null
    this.lastRequestAt = Number.NEGATIVE_INFINITY
    this.requestHold = 0
    this.errorStreak = 0
    this.errorStage = null
    this.backoffUntil = 0
    this.quietStreak = 0
    this.resetBlind()
    this.interval = this.settings.pollInterval
    this.counters = emptyCounters()
  }

  private forgetFrames(): void {
    this.latest = null
    this.pending = null
    this.keeper.releaseAll(this.inFlight?.frame)
  }

  private resetBlind(): void {
    this.blindHash = null
    this.blindSteady = 0
    this.blindRead = null
    this.blindAt = Number.NEGATIVE_INFINITY
    this.blindEmpty = 0
  }

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
      this.unavailable = false
      this.unavailableReason = ''
    }
  }

  /**
   * Bring what is drawn up to date now: the menu's Scan while automatic OCR is on.
   *
   * Looks at the screen at once and recognises straight away whatever is owed — new text,
   * text read while still drawing in — without waiting for it to settle, past any hold or
   * spacing. When the memory already describes the screen, nothing is recognised and this
   * resolves at once: there is nothing to catch up on. Resolves to whether there is text.
   * `again` reads what is showing even if it has been read (`Scene.lookAgain`).
   */
  async refresh(again = false): Promise<boolean> {
    if (!this.running || this.paused || this.suspended || this.unavailable) return false
    await this.idle()
    for (let tries = 0; tries < 20 && this.tickInFlight; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (again) this.scene.lookAgain()
    this.forceNext = true
    await this.tick()
    this.forceNext = false
    await this.idle()
    return this.scene.composite().fullText.trim() !== ''
  }

  /** Defer recognition (not observation) while the reader is looking something up. */
  holdRequestsUntil(at: number): void {
    if (at > this.requestHold) this.requestHold = at
  }
  pauseRecognitionFor(ms: number): void {
    this.holdRequestsUntil(this.now() + Math.max(0, ms))
  }
  resumeRequests(): void {
    this.requestHold = 0
  }
  get requestsHeldUntil(): number {
    return this.requestHold
  }

  /**
   * A scan that reached the overlay another way: a manual scan, or one from another window.
   *
   * It is filed in the memory as the reader's own choice — it wins over what was held and is
   * already published — and the drawing is brought back in line with the memory. `lines` is
   * what the observer read on that frame, when it was asked to; without them the reading is
   * filed against the lines as last seen.
   */
  noteExternalScan(text: string, lines?: ObservedLine[] | null, result?: OcrResult | null): void {
    this.lastRequestAt = this.now()
    if (!result || !this.running) return
    const at = this.now()
    this.generation = this.deps.generation?.() ?? this.generation
    if (lines) this.scene.observe(lines, at)
    const outcome = this.scene.apply(result, this.scene.snapshot(at), at, 'manual')
    this.count(outcome)
    void text
    void this.redraw('manual', null)
  }

  noteExternalText(text: string): void {
    this.noteExternalScan(text)
  }

  private schedule(): void {
    if (!this.running) return
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule())
    }, this.interval)
  }

  private stopTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  // --- the loop ------------------------------------------------------------------------

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
      await this.keeper.settled()
      return outcome
    } finally {
      this.tickInFlight = false
    }
  }

  private async runTick(at: number): Promise<TickOutcome> {
    let sample: CaptureSample<Frame>
    const gate = this.stillGate(at)
    let cold = false
    try {
      const lookStarted = this.now()
      sample = gate ? await this.deps.captureFrame({ readIfStill: gate }) : await this.deps.captureFrame()
      // What this look cost: its round trip, or the watcher's own time if that is longer (a
      // read reports its time; a cache hit reports next to nothing).
      const observed = sample.observation?.durationMs
      const look = Math.max(this.now() - lookStarted, Number.isFinite(observed) ? (observed as number) : 0)
      cold = this.coldLook
      if (this.coldLook) this.coldLook = false
      else if (Number.isFinite(look) && look >= 0) {
        this.recentLooks.push(look)
        if (this.recentLooks.length > LOOK_COST_WINDOW) this.recentLooks.shift()
        const sorted = [...this.recentLooks].sort((a, b) => a - b)
        this.lookCostMs = sorted[Math.floor(sorted.length / 2)]
      }
      this.counters.captures++
    } catch (error) {
      if (isSourceOutOfView(error)) {
        // Text mode uses this loop, not AutoScanner. A minimised game must wait
        // here too, rather than silently suspending while the Auto OCR switch is on.
        this.backoffUntil = this.now() + this.settings.errorBackoffMs
        const message = typeof error === 'string' ? error : String((error as Error)?.message ?? error)
        this.emit({ type: 'skip', reason: 'hidden', detail: message.replace(/^gone:\s*hidden:\s*/, '') })
        return 'backoff'
      }
      this.counters.captureErrors++
      this.recordError('capture', error)
      return 'error'
    }

    // The reader may have entered text/a popup while this capture was out.
    // Leave scene state untouched; resume takes a fresh look at the source.
    if (this.paused) return 'paused'

    const generation = sample.generation ?? this.deps.generation?.() ?? 0
    if (this.generation !== generation) {
      const had = this.generation !== null
      this.generation = generation
      this.scene.reset()
      this.forgetFrames()
      this.lastLines = null
      this.lastFingerprint = null
      this.resetBlind()
      if (had) await this.redraw('source', null)
    }

    const fingerprintNow = sample.contentFingerprint ?? null
    if (fingerprintNow !== null && fingerprintNow === this.seenFingerprint) this.stillAt = at
    this.seenFingerprint = fingerprintNow
    if (sample.observerSkipped) {
      // Still moving: look again soon, cheaply. Nothing was read, so nothing else changes.
      this.counters.stillSkips++
      if (this.movingSince === null) this.movingSince = at
      this.adapt(true, false, true)
      return 'observed'
    }
    // A read of pixels that matched the last look, or one forced by pixels that never stop.
    this.movingSince = gate || !sample.observation ? null : this.movingSince === null ? null : at

    if (sample.observerUnsupported) {
      this.unavailable = true
      this.unavailableReason =
        sample.observerError ??
        "Automatic scanning isn't available on this platform yet."
      this.stopTimer()
      this.emit({ type: 'status', state: 'unavailable', message: this.unavailableReason })
      return 'unavailable'
    }
    if (!sample.observation && sample.observerBusy) {
      // Still reading an earlier frame (a cold engine loading, a large display on a slow CPU):
      // never counted (#41), and asked again about one read later rather than after a whole
      // error backoff, which held the first line after Auto OCR started for two seconds.
      const retry = this.watchCostMs > 0 ? Math.max(250, this.watchCostMs) : 500
      this.backoffUntil = this.now() + Math.min(this.settings.errorBackoffMs, retry)
      this.emit({ type: 'skip', reason: 'observer-busy', detail: sample.observerError ?? undefined })
      return 'backoff'
    }
    if (!sample.observation) {
      this.counters.observerErrors++
      this.recordError('observer', sample.observerError ?? 'the local text observer returned nothing')
      return 'error'
    }
    this.noteSuccess('observer')
    this.counters.observations++
    const cost = sample.observation.durationMs
    // Not the cold first read either: OneOCR's took 1.4 s against 500 ms warm, and three of
    // those held the next look back two seconds, losing the session's first lines.
    if (!cold && typeof cost === 'number' && Number.isFinite(cost) && cost > 0) {
      this.watchCostMs = this.watchCostMs ? this.watchCostMs * 0.7 + cost * 0.3 : cost
    }

    // Byte-identical pixels cannot carry different words: a reading that changed while they
    // did not is the observer disagreeing with itself, and the last reading stands.
    let lines = sample.observation.lines ?? []
    const fingerprint = sample.contentFingerprint ?? null
    if (fingerprint !== null && fingerprint === this.lastFingerprint && this.lastLines) {
      if (JSON.stringify(lines.map((l) => l.text)) !== JSON.stringify(this.lastLines.map((l) => l.text))) {
        this.counters.fingerprintSuppressed++
      }
      lines = this.lastLines
    }
    this.lastFingerprint = fingerprint
    this.lastLines = lines
    if (!lines.length) this.counters.emptyObservations++

    const previous = this.latest
    const busy = new Set([
      ...SceneMemory.versions(this.inFlight?.snapshot ?? null),
      ...SceneMemory.versions(this.pending?.snapshot ?? null)
    ])
    const forced = this.forceNext
    this.forceNext = false
    const observed = this.scene.observe(lines, at, busy, forced)
    const snapshot = this.scene.snapshot(at)
    this.keeper.retain(sample.frame)
    this.latest = { frame: sample.frame, snapshot }

    let outcome: TickOutcome = 'observed'
    // Lines that went before anyone read them: the frame before this one still shows them.
    if (observed.lostUnread.length && previous) {
      this.counters.rescues++
      const job: Job<Frame> = {
        frame: previous.frame,
        snapshot: previous.snapshot,
        generation,
        reason: 'disappeared',
        mode: 'auto'
      }
      outcome = this.request(job, at, true)
    }
    if (observed.displayChanged) await this.redraw('observed', null)

    for (const version of SceneMemory.versions(this.pending?.snapshot ?? null)) busy.add(version)
    const ready = this.scene.readiness(at, this.settings.maxCandidateAgeMs, busy, forced)
    if (ready) {
      const reason = ready.reason
      const result = this.request(
        { frame: sample.frame, snapshot, generation, reason, mode: 'auto' },
        at,
        false,
        forced
      )
      if (result === 'requested') {
        if (reason === 'settled') this.counters.settledRequests++
        else if (reason === 'max-wait') this.counters.maxWaitRequests++
        else this.counters.secondOpinions++
      }
      if (outcome === 'observed') outcome = result
    } else if (observed.present === 0) {
      const result = this.blind(sample, snapshot, generation, at)
      if (outcome === 'observed') outcome = result
    } else this.resetBlind()

    if (outcome === 'observed' && this.drain(at)) outcome = 'requested'

    // Passages that have finished arriving since the last recognition: the last line stopped
    // drawing in, or a doubted reading's grace ran out.
    if (!this.inFlight) {
      const publish = this.scene.takePublishable(at)
      if (publish.length) await this.redraw('settled', null, publish)
    }

    if (previous) this.keeper.release(previous.frame)
    this.adapt(
      observed.displayChanged || this.scene.unsettled || this.inFlight !== null,
      this.scene.awaitingConfirmation(at)
    )
    return outcome
  }

  /**
   * The observer sees nothing. If the picture has changed since it was last recognised and has
   * now held still, recognise it once: the text may be in a font the observer cannot read.
   */
  private blind(sample: CaptureSample<Frame>, snapshot: SceneSnapshot, generation: number, at: number): TickOutcome {
    const hash = sample.hash ?? null
    if (!hash) return 'observed'
    const near = (a: string | null, b: string): boolean =>
      a !== null && a.length === b.length && hammingDistance(a, b) <= this.settings.imageHashThreshold
    this.blindSteady = near(this.blindHash, hash) ? this.blindSteady + 1 : 1
    this.blindHash = hash
    if (this.blindSteady < this.settings.stableObservations) return 'observed'
    if (near(this.blindRead, hash)) return 'observed'
    const gap = Math.min(BLIND_MAX_GAP_MS, BLIND_GAP_MS * 2 ** this.blindEmpty)
    if (at - this.blindAt < gap) return 'observed'
    const outcome = this.request({ frame: sample.frame, snapshot, generation, reason: 'blind', mode: 'blind' }, at)
    if (outcome === 'requested') {
      this.counters.blindRequests++
      this.blindRead = hash
      this.blindAt = at
    }
    return outcome
  }

  // --- recognition -----------------------------------------------------------------------

  /**
   * Recognise this frame now if nothing stands in the way. Otherwise nothing is queued: the
   * memory still knows which lines are owed a reading, and the next tick asks again with a
   * fresher frame. Only a rescue — text already gone from the screen — waits in `pending`.
   */
  private request(job: Job<Frame>, at: number, rescue = false, forced = false): TickOutcome {
    const wait = (reason: 'held' | 'in-flight' | 'spacing' | 'locked'): TickOutcome => {
      if (reason === 'held') this.counters.heldSkips++
      if (reason === 'spacing') this.counters.spacingDeferrals++
      if (rescue) {
        this.keeper.retain(job.frame)
        if (this.pending) this.keeper.release(this.pending.frame)
        this.pending = job
        this.emit({ type: 'request', reason, queued: true, replaced: false }, job.frame)
        return 'queued'
      }
      // Waiting on the request already out is the normal case, not worth a log line.
      // Waiting while a lookup holds requests is the same: counted, not logged every tick.
      if (reason !== 'in-flight' && reason !== 'held') this.emit({ type: 'skip', reason })
      return 'observed'
    }
    // The pointer hold (`holdRequestsUntil`) spares the text being pointed at a redraw. A line
    // nobody has read yet, or one already gone (a rescue), is not that text: the line under the
    // pointer has changed. Holding it only left the overlay empty for up to three seconds while
    // the new line, already seen, waited (measured on a real game: 5-120 ms without the hold,
    // 0.6-3 s with it). Re-reads of text already shown still wait.
    const firstReading = job.reason === 'settled' || job.reason === 'disappeared'
    if (at < this.requestHold && !forced && !firstReading) return wait('held')
    if (this.inFlight) return wait('in-flight')
    if (at - this.lastRequestAt < this.settings.minRequestSpacingMs && !forced) return wait('spacing')
    if (this.deps.tryAcquire && !this.deps.tryAcquire()) {
      this.counters.lockedSkips++
      return wait('locked')
    }
    this.keeper.retain(job.frame)
    this.begin(job)
    return 'requested'
  }

  private drain(at: number): boolean {
    const job = this.pending
    // Only rescues wait here (text already gone), which the pointer hold does not delay.
    if (!job || this.inFlight) return false
    if (at - this.lastRequestAt < this.settings.minRequestSpacingMs) return false
    if (job.generation !== (this.deps.generation?.() ?? job.generation)) {
      this.counters.staleDiscarded++
      this.keeper.release(job.frame)
      this.pending = null
      return false
    }
    if (this.deps.tryAcquire && !this.deps.tryAcquire()) return false
    this.pending = null
    this.begin(job)
    return true
  }

  /** Start a recognition without waiting for it; the screen is still watched meanwhile. */
  private begin(job: Job<Frame>): void {
    this.inFlight = job
    this.lastRequestAt = this.now()
    this.counters.requests++
    this.deps.onScanStart?.()
    this.emit({ type: 'request', reason: job.reason, queued: false, replaced: false }, job.frame)
    const token = ++this.runToken
    this.inFlightPromise = this.run(job, this.epoch, token)
  }

  private async run(job: Job<Frame>, epoch: number, token: number): Promise<void> {
    try {
      if (!(await this.keeper.pinned(job.frame))) {
        this.emit({ type: 'skip', reason: 'unpinned' })
        this.recordError('pin', 'the captured frame could not be pinned, so it was not sent for recognition')
        return
      }
      if (!this.stillWanted(job, epoch)) {
        this.counters.staleDiscarded++
        this.emit({ type: 'skip', reason: 'stale-generation', detail: 'changed while pinning' })
        return
      }
      let result: OcrResult | null
      try {
        result = (await this.deps.recognize(job.frame)) as OcrResult | null
        this.noteSuccess('recognize')
      } catch (error) {
        this.counters.requestErrors++
        this.recordError('recognize', error)
        return
      }
      if (!this.stillWanted(job, epoch)) {
        this.counters.staleDiscarded++
        this.emit({ type: 'skip', reason: 'stale-generation' }, job.frame)
        return
      }
      // Paused while it was out (the reader opened the controller menu or is stepping through
      // words): nothing may change under them. Not filed, so its lines are still owed a reading
      // when the loop resumes and looks again.
      if (this.paused) {
        this.counters.staleDiscarded++
        this.emit({ type: 'skip', reason: 'held', detail: 'paused while recognising' }, job.frame)
        return
      }
      if (!result || !result.fullText?.trim()) {
        this.counters.emptyResults++
        if (job.mode === 'blind') this.blindEmpty++
      } else if (job.mode === 'blind') this.blindEmpty = 0

      const at = this.now()
      const outcome = this.scene.apply(
        result ?? { schemaVersion: 1, engine: '', fullText: '', textAnnotations: [], groups: [], geometry: false },
        job.snapshot,
        at,
        job.mode
      )
      this.count(outcome)
      const publish = this.scene.takePublishable(at)
      this.emit(
        {
          type: 'result',
          published: publish.length > 0,
          reason: job.reason,
          chars: [...(result?.fullText ?? '')].length
        },
        job.frame
      )
      if (outcome.displayChanged || publish.length) await this.redraw(job.reason, job.frame, publish)
    } catch (error) {
      this.recordError('publish', error)
    } finally {
      this.inFlight = null
      this.deps.releaseLock?.()
      this.deps.onScanEnd?.()
      this.keeper.release(job.frame)
      if (this.runToken === token) this.inFlightPromise = null
    }
  }

  private stillWanted(job: Job<Frame>, epoch: number): boolean {
    if (epoch !== this.epoch || this.suspended || this.unavailable) return false
    return (this.deps.generation?.() ?? job.generation) === job.generation
  }

  private count(outcome: { filed: number; improved: number; rejected: number; stale: number }): void {
    this.counters.readingsFiled += outcome.filed
    this.counters.readingsImproved += outcome.improved
    this.counters.readingsRejected += outcome.rejected
    this.counters.staleReadings += outcome.stale
  }

  /** Tell the overlay what to draw now, and what is new. */
  private async redraw(reason: string, frame: Frame | null, publish: Passage[] = []): Promise<void> {
    this.counters.redraws++
    this.counters.published += publish.length
    const at = this.now()
    this.emit({ type: 'scene', reason, ...this.scene.stats(at) }, frame ?? undefined)
    await this.deps.onScene({
      result: this.scene.composite(),
      publish,
      frame,
      reason,
      generation: this.generation ?? this.deps.generation?.() ?? 0
    })
  }

  // --- errors and pace -------------------------------------------------------------------

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
      this.unavailableReason = `Automatic scanning suspended after ${this.errorStreak} consecutive failures (${stage}).`
      this.stopTimer()
      this.emit({ type: 'status', state: 'suspended', message: this.unavailableReason })
    }
  }

  /**
   * Look often while anything is moving or being read; ease off when the screen is still.
   * Never more often than the watcher can afford (`WATCH_COST_FACTOR`), except that a line
   * waiting to be confirmed gets its next look sooner (`CONFIRM_COST_FACTOR`).
   */
  private adapt(active: boolean, confirming = false, skipped = false): void {
    this.adaptToScreen(active)
    this.confirming = confirming
    if (skipped || this.gating) {
      // With the gate on, a look at pixels that moved reads nothing, and pixels that held still
      // are read once (the next look is the watcher's cache): reads are bounded by the screen
      // and by the forced read in `stillGate`, so only what looks cost limits the pace.
      this.interval = Math.max(this.interval, Math.min(this.lookCostMs * GATED_LOOK_FACTOR, WATCH_COST_MAX_GAP_MS))
      return
    }
    // Reads pace the looks while something is moving (each look there is a read). On a still
    // screen what a look actually costs does: cache hits are cheap and barely constrain it,
    // while a background that animates under unchanged text makes every look a read, and
    // keeps the same protection as before.
    const cost = active || confirming ? this.watchCostMs : this.lookCostMs
    const factor = confirming ? CONFIRM_COST_FACTOR : WATCH_COST_FACTOR
    const floor = Math.min(cost * factor, WATCH_COST_MAX_GAP_MS)
    this.interval = Math.max(this.interval, floor)
  }

  /** Whether reads wait for still pixels: only for a watcher slow enough to be worth it. */
  private get gating(): boolean {
    // Without fingerprints there is nothing to compare pixels by, and the gate stays off.
    return (
      this.settings.observerMode === 'text' &&
      this.seenFingerprint !== null &&
      this.watchCostMs >= STILL_GATE_READ_MS &&
      this.now() - this.stillAt <= STILL_GATE_ANIMATED_MS
    )
  }

  /** The fingerprint to read only if still, or null to read whatever the look finds. */
  private stillGate(at: number): string | null {
    if (!this.gating || this.seenFingerprint === null || this.forceNext) return null
    const limit = Math.max(STILL_GATE_MAX_WAIT_MS, this.watchCostMs * WATCH_COST_FACTOR)
    if (this.movingSince !== null && at - this.movingSince >= limit) return null
    return this.seenFingerprint
  }

  private adaptToScreen(active: boolean): void {
    const { adaptivePollingEnabled, adaptivePollMin, adaptivePollMax, pollInterval } = this.settings
    if (!adaptivePollingEnabled) {
      this.interval = pollInterval
      return
    }
    if (active) {
      this.quietStreak = 0
      // Text arriving settles on two matching looks: look again soon, so a line that has
      // stopped is known to have stopped a fraction of a second later, not half a second.
      this.interval = Math.min(adaptivePollMin, ACTIVE_POLL_MS)
      return
    }
    this.quietStreak++
    // Idle: as often as the looks themselves can afford, never slower than the ceiling.
    if (this.lookCostMs > 0) {
      this.interval = Math.min(adaptivePollMax, Math.max(IDLE_MIN_GAP_MS, this.lookCostMs * IDLE_COST_FACTOR))
      return
    }
    if (this.quietStreak >= 5) this.interval = Math.min(this.interval * 1.5, adaptivePollMax)
    else this.interval = Math.max(adaptivePollMin, Math.min(pollInterval, this.interval))
  }
}
