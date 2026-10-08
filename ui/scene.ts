/**
 * Scene memory: the text on screen, line by line, and the best reading of each line.
 *
 * Automatic OCR used to treat the screen as one string. That is where its flakiness came
 * from: a blinking "next" arrow beside the dialogue made the whole string flip between two
 * values, every flip read as new text, and every new text replaced what was drawn with the
 * newest recognition, even when that recognition had lost half the characters of the one
 * before it.
 *
 * This keeps a spatial memory instead. Every line the cheap local observer sees becomes a
 * *track*, identified by where it is rather than by what it says, and followed from frame to
 * frame on its own:
 *
 *  - **Lines are independent.** A change in one line says nothing about the others, so a
 *    blinking arrow, a ticking clock or a name plate never disturbs the dialogue beside it.
 *  - **Change needs confirming.** A different reading must be seen twice before it counts
 *    (a shorter one three times: the observer losing the last glyph is commoner than text
 *    losing it). One noisy frame changes nothing.
 *  - **Contents are remembered.** A track remembers what it has shown before. Text that comes
 *    back — the arrow blinking, a menu toggling, A/B alternating — returns to the reading it
 *    already has instead of costing another recognition and another chance to read worse.
 *  - **Behaviour is learned.** A track that keeps reappearing with the same text is
 *    *blinking*; one whose text keeps being replaced outright is *volatile* (timers, counters,
 *    scrolling backgrounds). Neither holds up nor triggers recognition of anything else, and
 *    neither is written to the history.
 *  - **Readings never get worse.** A recognition is cut up by geometry and each piece is
 *    filed against the lines it covers and the version of their text it was made from. A
 *    reading of the same text only replaces the one already held if it scores better against
 *    what the observer has seen there; a reading of an older version is filed for that version
 *    and not shown. A partial result can no longer wipe a complete one.
 *  - **Doubt earns a second look.** A reading that agrees poorly with the observer is
 *    recognised once more from a later frame, and the better of the two is kept and published.
 *
 * Text the observer cannot see at all (a font Live Text cannot read) still gets in: pieces of
 * a recognition that cover no track become *orphans*, matched from one recognition to the next
 * by position, and dropped when two recognitions in a row no longer find them.
 *
 * Pure: no clock, no capture, no recogniser. All coordinates are capture pixels.
 */

import { classify, identityKey, stabilityKey, type ObservedLine, type TextBox } from './observation.js'
import { getBoundingBox, type Annotation } from './annotations.js'
import { normalizeOcrResult, type OcrGroup, type OcrResult } from './ocr-result.js'

export interface SceneOptions {
  /** Consecutive identical sightings before a line counts as settled. */
  stableObservations: number
  /** Sightings of a different text before the line's content is replaced. */
  confirmChange: number
  /** Sightings of a shorter text (a dropped tail) before it is believed. */
  confirmShrink: number
  /** Consecutive misses before a line is gone. A blank observation is believed at once. */
  missesToVanish: number
  /** A line that comes back unchanged this many times within the window is blinking. */
  blinkReturns: number
  blinkWindowMs: number
  /** Longest line that can be called blinking. */
  blinkMaxChars: number
  /**
   * A line whose content churns this many times within the window is volatile: its numbers
   * keep changing, or its text keeps being replaced before it could be read.
   */
  volatileChanges: number
  volatileWindowMs: number
  /** Content replaced sooner than this after it appeared counts towards volatility. */
  churnMs: number
  /** How long a line that has gone is remembered, so it can come back. */
  forgetAfterMs: number
  maxTracks: number
  /** Earlier contents remembered per line. */
  rememberVersions: number
  /** Recognitions spent on one version of a line before it is left as it is. */
  maxAttempts: number
  /** Agreement below which a reading is doubted and a second one is asked for. */
  doubtfulQuality: number
  /**
   * A reading shorter than this share of what the observer saw is doubted: characters were
   * missed, worth a second look. One that is merely different is not — with a pixel font the
   * observer is often the one that is wrong.
   */
  doubtfulLength: number
  /** How long a published passage is remembered for spotting a re-read of it. */
  passageMemoryMs: number
  /** How long a doubted reading waits for its second opinion before it is published anyway. */
  publishGraceMs: number
  /** A passage with a line that never stops moving is published anyway after this long. */
  publishHoldMs: number
  /** Readings a whole recognition must miss in a row before an orphan is dropped. */
  orphanMisses: number
  /** Change in a cell's ink, in brightness levels, that means the line is still drawing in. */
  inkStill: number
  /** Ink that never stops moving this long is an animated backdrop, not text arriving. */
  inkNoisyMs: number
  /** Re-reads of one version of a line after its ink changed under an earlier reading. */
  maxRefreshes: number
}

export const DEFAULT_SCENE_OPTIONS: SceneOptions = {
  stableObservations: 2,
  confirmChange: 2,
  confirmShrink: 3,
  missesToVanish: 2,
  blinkReturns: 2,
  blinkWindowMs: 8000,
  blinkMaxChars: 4,
  volatileChanges: 3,
  volatileWindowMs: 8000,
  churnMs: 1000,
  forgetAfterMs: 20000,
  maxTracks: 64,
  rememberVersions: 8,
  maxAttempts: 2,
  doubtfulQuality: 0.8,
  doubtfulLength: 0.85,
  passageMemoryMs: 30000,
  publishGraceMs: 1500,
  publishHoldMs: 4000,
  orphanMisses: 2,
  inkStill: 8,
  inkNoisyMs: 2500,
  maxRefreshes: 2
}

/** One content of one line. */
interface Version {
  id: number
  key: string
  text: string
  since: number
  /** Recognitions that have included this version. */
  attempts: number
  /** Observer readings seen while this version was current, by stability key. */
  votes: Map<string, number>
  /** The words stayed the same but the ink changed after this was read: read it again. */
  inkChanged: boolean
  refreshes: number
}

interface Track {
  id: number
  box: TextBox
  version: Version
  /** Earlier contents, oldest first. */
  history: Version[]
  /** Consecutive sightings with the current content and no disagreement. */
  stable: number
  /** A different reading waiting to be confirmed. */
  pending: { key: string; text: string; count: number } | null
  /** When the line last started moving, for the longest wait; null while it is settled. */
  moving: number | null
  present: boolean
  misses: number
  firstSeen: number
  lastSeen: number
  /** When the line came back showing what it showed before it went. */
  returns: number[]
  /** When its content was replaced by something it had not shown before. */
  bumps: number[]
  /** The ink signature last seen, and since when it has been changing. */
  ink: number[] | null
  /** Recent ink signatures: returning to one is flicker, not drawing in. */
  inks: number[][]
  inkMoving: number | null
  /** Learned: the ink here never holds still (an animated backdrop), so it is ignored. */
  inkNoisy: boolean
}

/** A reading: part of one recognition, filed against the lines it covers. */
interface Unit {
  id: number
  /** Track id to the version id it was read from. Empty for an orphan. */
  versions: Map<number, number>
  annotations: Annotation[]
  groups: OcrGroup[]
  engine: string
  text: string
  key: string
  box: TextBox
  vertical: boolean
  quality: number
  /** Clearly shorter than what the observer saw there: characters were missed. */
  doubtful: boolean
  at: number
  published: boolean
  /** Doubted readings wait for a second opinion until then. */
  publishAfter: number
  misses: number
  blinking: boolean
}

/** A passage for the history, and the text of the entry it corrects, if any. */
export interface Passage {
  result: OcrResult
  replaces: string | null
}

interface PublishedPassage {
  text: string
  identity: string
  keys: Map<number, string>
  at: number
}

/** Which version of which line a captured frame showed. */
export interface SceneSnapshot {
  at: number
  tracks: { id: number; version: number; key: string; box: TextBox }[]
}

/** Why the scene wants a recognition now, and of what. */
export interface Readiness {
  reason: 'settled' | 'max-wait' | 'second-opinion' | 'refresh' | 'forced'
  tracks: number[]
}

export interface ObserveOutcome {
  /** What is drawn should change: a line went, came back, or its content moved on. */
  displayChanged: boolean
  /** Lines that went before any reading of their current content: owed the previous frame. */
  lostUnread: number[]
  present: number
}

export interface ApplyOutcome {
  /** Readings filed. */
  filed: number
  /** Readings that replaced a worse one of the same text. */
  improved: number
  /** Readings kept out because the one already held was better. */
  rejected: number
  /** Pieces of the recognition for a version the line has since moved past. */
  stale: number
  displayChanged: boolean
}

export interface SceneStats {
  tracks: number
  present: number
  blinking: number
  volatile: number
  units: number
  shown: number
  orphans: number
}

// --- geometry ------------------------------------------------------------------

function area(box: TextBox): number {
  return Math.max(0, box.width) * Math.max(0, box.height)
}

function intersection(a: TextBox, b: TextBox): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** How much the smaller of two boxes lies inside the larger: 1 is contained, 0 is apart. */
export function containment(a: TextBox, b: TextBox): number {
  const smaller = Math.min(area(a), area(b))
  return smaller > 0 ? intersection(a, b) / smaller : 0
}

function union(boxes: TextBox[]): TextBox {
  const left = Math.min(...boxes.map((b) => b.x))
  const top = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.width))
  const bottom = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function annotationBox(annotation: Annotation): TextBox {
  const b = getBoundingBox(annotation)
  return { x: b.minX, y: b.minY, width: b.width, height: b.height }
}

/** Close enough to read as one passage: within about a glyph of each other. */
function neighbours(a: TextBox, b: TextBox): boolean {
  const em = Math.max(4, Math.min(a.width, a.height, b.width, b.height))
  const reach = em * 1.2
  return (
    a.x - reach < b.x + b.width &&
    b.x - reach < a.x + a.width &&
    a.y - reach < b.y + b.height &&
    b.y - reach < a.y + a.height
  )
}

// --- text ------------------------------------------------------------------------

/** Edit distance, for scoring a reading against what the observer saw. */
export function editDistance(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  if (!x.length) return y.length
  if (!y.length) return x.length
  let row = Array.from({ length: y.length + 1 }, (_, i) => i)
  for (let i = 1; i <= x.length; i++) {
    const next = [i]
    for (let j = 1; j <= y.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
    }
    row = next
  }
  return row[y.length]
}

/** 1 for the same text, 0 for nothing in common. */
export function agreement(a: string, b: string): number {
  const longest = Math.max([...a].length, [...b].length)
  return longest ? 1 - editDistance(a, b) / longest : 1
}

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u

/** Worth writing to the history: something a reader of Japanese would look up. */
export function isJapanese(text: string): boolean {
  return JAPANESE.test(text)
}

/**
 * The same line with a decoration added or lost: a key that is the other with at most two
 * characters more at either end. A blinking ▼ read onto the end of a line is this, and so is
 * a recogniser catching a closing bracket one time and not the next. A changed character in the
 * middle never is, at any length.
 */
export function decoratedVariant(a: string, b: string): boolean {
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (!short || long.length - short.length > 2) return false
  return long.startsWith(short) || long.endsWith(short)
}

/**
 * The same text with only decoration added or lost: `decoratedVariant`, where what differs
 * has no Japanese in it — an arrow, a closing bracket, a full stop. A typewriter's last
 * kana arriving late is content, and is not this.
 */
export function decorationOnly(a: string, b: string): boolean {
  if (!decoratedVariant(a, b)) return false
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  const extra = long.startsWith(short) ? long.slice(short.length) : long.slice(0, long.length - short.length)
  return !isJapanese(extra)
}

function readingOrder(boxes: { box: TextBox }[], vertical: boolean): void {
  boxes.sort((a, b) => {
    const p = a.box
    const q = b.box
    if (vertical) {
      const overlap = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x)
      return overlap > Math.min(p.width, q.width) * 0.5 ? p.y - q.y : q.x + q.width - (p.x + p.width)
    }
    const overlap = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y)
    return overlap > Math.min(p.height, q.height) * 0.5 ? p.x - q.x : p.y - q.y
  })
}

function confidenceOf(annotations: Annotation[]): number | null {
  const values = annotations
    .map((a) => (a as Annotation & { confidence?: unknown }).confidence)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (!values.length) return null
  return Math.max(0, Math.min(1, values.reduce((sum, value) => sum + value, 0) / values.length))
}

// --- the memory --------------------------------------------------------------------

export class SceneMemory {
  private options: SceneOptions
  private tracks: Track[] = []
  private units: Unit[] = []
  private nextTrack = 1
  private nextVersion = 1
  private nextUnit = 1
  /** Identity keys published since the screen was last blank, newest last. */
  private published: string[] = []
  /** The passage each line was last published in. */
  private passageOf = new Map<number, PublishedPassage>()
  /** Passages published since the screen was last blank, newest last. */
  private recent: PublishedPassage[] = []
  private engine: string | null = null

  constructor(options: Partial<SceneOptions> = {}) {
    this.options = { ...DEFAULT_SCENE_OPTIONS, ...options }
  }

  configure(options: Partial<SceneOptions>): void {
    this.options = { ...this.options, ...options }
  }

  /**
   * The reader cleared their log, so a passage published earlier is no longer there to repeat:
   * shown again, it is published again. What is on screen now stays published (`passageOf`),
   * so clearing the log does not immediately write the lines still showing back into it.
   */
  forgetPublished(): void {
    this.published = []
    this.recent = []
  }

  reset(): void {
    this.tracks = []
    this.units = []
    this.published = []
    this.recent = []
    this.passageOf.clear()
    this.engine = null
  }

  // --- observing ---------------------------------------------------------------------

  /**
   * One observation: every line the observer read in this frame.
   *
   * Lines are matched to tracks by position, the best overlaps first, including tracks that
   * have recently gone, so a line that comes back is the same line. Each track then decides on
   * its own whether its content has changed. `reading` is the versions a recognition is already
   * out for, which are not owed a rescue when they go. `force` takes the screen as it is now:
   * a changed line is believed on one sighting, for a reader who asked to catch up.
   */
  observe(
    lines: ObservedLine[],
    at: number,
    reading: Set<number> = new Set(),
    force = false
  ): ObserveOutcome {
    const o = this.options
    const shownBefore = this.shownSignature()
    const lostUnread: number[] = []
    const hadText = this.tracks.some((t) => t.present)
    const readable =lines.filter((line) => stabilityKey(line.text) !== '' && area(line.box) > 0)

    const pairs: { line: number; track: Track; score: number }[] = []
    readable.forEach((line, index) => {
      for (const track of this.tracks) {
        const score = containment(line.box, track.box)
        if (score >= 0.5) pairs.push({ line: index, track, score: score + (track.present ? 0.01 : 0) })
      }
    })
    pairs.sort((a, b) => b.score - a.score)
    const matched = new Map<number, Track>()
    const taken = new Set<Track>()
    for (const pair of pairs) {
      if (matched.has(pair.line) || taken.has(pair.track)) continue
      matched.set(pair.line, pair.track)
      taken.add(pair.track)
    }

    readable.forEach((line, index) => {
      const track = matched.get(index)
      if (track) this.sight(track, line, at, force)
      else this.tracks.push(this.create(line, at))
    })

    for (const track of this.tracks) {
      if (taken.has(track) || track.lastSeen === at) continue
      track.misses++
      track.pending = null
      if (track.present && (force || track.misses >= o.missesToVanish)) {
        track.present = false
        track.stable = 0
        if (
          !this.readingFor(track) &&
          track.version.attempts === 0 &&
          !reading.has(track.version.id) &&
          track.lastSeen > track.firstSeen
        ) {
          lostUnread.push(track.id)
        }
      }
    }

    // Forget lines long gone, and keep the memory bounded.
    this.tracks = this.tracks.filter((track) => track.present || at - track.lastSeen < o.forgetAfterMs)
    if (this.tracks.length > o.maxTracks) {
      const absent = this.tracks.filter((t) => !t.present).sort((a, b) => a.lastSeen - b.lastSeen)
      const drop = new Set(absent.slice(0, this.tracks.length - o.maxTracks))
      this.tracks = this.tracks.filter((t) => !drop.has(t))
    }
    const alive = new Set(this.tracks.map((t) => t.id))
    for (const id of this.passageOf.keys()) if (!alive.has(id)) this.passageOf.delete(id)
    this.units = this.units.filter((unit) => [...unit.versions.keys()].every((id) => alive.has(id)))

    // A blank screen ends a passage: what follows may repeat a line and still be new. Text only
    // the recogniser could see goes with everything else: the screen it was on has cleared.
    if (!this.tracks.some((t) => t.present && !this.blinking(t, at))) {
      this.published = []
      this.recent = []
    }
    if (readable.length === 0 && hadText) this.units = this.units.filter((u) => u.versions.size > 0)

    return {
      displayChanged: this.shownSignature() !== shownBefore,
      lostUnread,
      present: this.tracks.filter((t) => t.present).length
    }
  }

  private create(line: ObservedLine, at: number): Track {
    const key = stabilityKey(line.text)
    return {
      id: this.nextTrack++,
      box: { ...line.box },
      version: this.version(key, line.text, at),
      history: [],
      stable: 1,
      pending: null,
      moving: at,
      present: true,
      misses: 0,
      firstSeen: at,
      lastSeen: at,
      returns: [],
      bumps: [],
      ink: line.ink ?? null,
      inks: line.ink ? [line.ink] : [],
      inkMoving: null,
      inkNoisy: false
    }
  }

  private version(key: string, text: string, at: number): Version {
    return {
      id: this.nextVersion++,
      key,
      text,
      since: at,
      attempts: 0,
      votes: new Map([[key, 1]]),
      inkChanged: false,
      refreshes: 0
    }
  }

  private sight(track: Track, line: ObservedLine, at: number, force = false): void {
    const o = this.options
    const key = stabilityKey(line.text)
    const returning = !track.present
    const inkMoved = !returning && this.inkMoved(track, line, at)
    if (returning) track.ink = line.ink ?? null
    track.box = { ...line.box }
    track.lastSeen = at
    track.misses = 0
    track.present = true
    // Seen before while this content was current: a line flickering between two readings
    // (sprite flicker, an observer split it reads two ways) is not a line that is moving.
    const familiar = (track.version.votes.get(key) ?? 0) > 0 && track.pending?.key !== key
    track.version.votes.set(key, (track.version.votes.get(key) ?? 0) + 1)

    if (key === track.version.key) {
      track.pending = null
      if (returning) {
        track.returns.push(at)
        track.stable = 1
      } else if (inkMoved) {
        // The same words, still fading or drawing in: not settled yet, and anything read
        // from an earlier frame of this is owed a fresh look once it is.
        track.stable = 1
        track.moving ??= at
        if (this.readingFor(track)) track.version.inkChanged = true
      } else track.stable++
      if (track.stable >= o.stableObservations) track.moving = null
      return
    }
    track.moving ??= at

    // Something it showed before: go straight back to it, reading and all.
    const remembered = track.history.find((v) => v.key === key)
    if (remembered) {
      this.switchTo(track, remembered)
      if (returning) track.returns.push(at)
      return
    }
    // A line that went and came back with new text is simply the next line in that place.
    if (returning) {
      this.switchTo(track, this.version(key, line.text, at))
      return
    }

    const relation = classify(track.version.key, key)
    // Text being typed out: the reading of the shorter text stays true as far as it goes.
    if (relation === 'growth') {
      this.switchTo(track, this.version(key, line.text, at))
      return
    }
    const needed = force ? 1 : relation === 'shrink' ? o.confirmShrink : o.confirmChange
    const count = track.pending?.key === key ? track.pending.count + 1 : 1
    track.pending = { key, text: line.text, count }
    if (familiar && !force) {
      track.stable++
      track.pending = null
      if (track.stable >= o.stableObservations) track.moving = null
      return
    }
    track.stable = 0
    if (count >= needed) {
      const before = track.version
      this.switchTo(track, this.version(key, line.text, at))
      track.stable = count
      // Churn, not reading: only the numbers changed (a timer, a counter, a gauge), or the text
      // was replaced faster than anyone reads. A reader clicking through dialogue is neither.
      const digits = /[0-9０-９]/gu
      const numeric = before.key.replace(digits, '') === key.replace(digits, '')
      if (relation !== 'shrink' && (numeric || at - before.since < o.churnMs)) track.bumps.push(at)
    }
  }

  private switchTo(track: Track, next: Version): void {
    const o = this.options
    track.history = track.history.filter((v) => v !== next)
    track.history.push(track.version)
    if (track.history.length > o.rememberVersions) track.history.shift()
    track.version = next
    track.pending = null
    track.stable = 1
    // Readings of contents no longer remembered can never be shown again.
    const kept = new Set([next.id, ...track.history.map((v) => v.id)])
    this.units = this.units.filter((unit) => {
      const version = unit.versions.get(track.id)
      return version === undefined || kept.has(version)
    })
  }

  /**
   * Has the line's ink changed since it was last seen? Brightness spread per cell, compared
   * cell by cell, plus the box itself moving. Ink that never stops changing is learned as an
   * animated backdrop behind the text and ignored from then on, so it cannot hold the line
   * open for ever.
   */
  private inkMoved(track: Track, line: ObservedLine, at: number): boolean {
    const o = this.options
    const before = track.ink
    const now = line.ink ?? null
    const box = track.box
    track.ink = now
    if (track.inkNoisy || !before || !now || before.length !== now.length) return false
    const shifted =
      Math.abs(box.x - line.box.x) > 4 ||
      Math.abs(box.y - line.box.y) > 4 ||
      Math.abs(box.width - line.box.width) > 4 ||
      Math.abs(box.height - line.box.height) > 4
    const differs = (a: number[], b: number[]): boolean =>
      a.length !== b.length ||
      b.some((value, i) => Math.abs(value - a[i]) > Math.max(o.inkStill, a[i] * 0.15))
    // Drawing in only ever moves forward; ink that goes back to a state it was just in is
    // flicker (a game drawing text on alternate frames), and settles like still text.
    const flicker = track.inks.some((seen) => !differs(seen, now))
    track.inks = [...track.inks.slice(-3), now]
    const moved = (shifted || differs(before, now)) && !flicker
    if (!moved) {
      track.inkMoving = null
      return false
    }
    track.inkMoving ??= at
    if (at - track.inkMoving > o.inkNoisyMs) {
      track.inkNoisy = true
      return false
    }
    return true
  }

  // --- what the lines are doing ----------------------------------------------------------

  /**
   * A short line that keeps coming back unchanged: a "next" arrow, a cursor. Long lines are
   * never called blinking — a dialogue line the observer drops now and then is still dialogue.
   */
  private blinking(track: Track, at: number): boolean {
    const o = this.options
    if ([...track.version.key].length > o.blinkMaxChars) return false
    return track.returns.filter((t) => at - t <= o.blinkWindowMs).length >= o.blinkReturns
  }

  private volatile(track: Track, at: number): boolean {
    const o = this.options
    return track.bumps.filter((t) => at - t <= o.volatileWindowMs).length >= o.volatileChanges
  }

  /** The reading shown for this line's current content, if there is one. */
  private readingFor(track: Track): Unit | null {
    let best: Unit | null = null
    for (const unit of this.units) {
      if (unit.versions.get(track.id) !== track.version.id) continue
      if (!best || unit.quality > best.quality) best = unit
    }
    return best
  }

  /** The line is waiting for a reading of what it says now. */
  private owed(track: Track, at: number, inFlight: Set<number>): boolean {
    if (!track.present || inFlight.has(track.version.id)) return false
    const reading = this.readingFor(track)
    // Read while it was still drawing in: look again now that it has settled.
    if (reading && this.refreshDue(track)) return true
    if (track.version.attempts >= this.options.maxAttempts) return false
    if (!reading) return !this.volatile(track, at)
    // One second opinion for a reading that agrees poorly with what was seen.
    return reading.doubtful && track.version.attempts < 2
  }

  private refreshDue(track: Track): boolean {
    return track.version.inkChanged && track.version.refreshes < this.options.maxRefreshes
  }

  /** Passages: lines close enough to read together, by union of neighbours. */
  private clusters(tracks: Track[]): Track[][] {
    const parent = tracks.map((_, i) => i)
    const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])))
    for (let i = 0; i < tracks.length; i++)
      for (let j = i + 1; j < tracks.length; j++)
        if (neighbours(tracks[i].box, tracks[j].box)) parent[root(j)] = root(i)
    const groups = new Map<number, Track[]>()
    tracks.forEach((track, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), track]))
    return [...groups.values()]
  }

  /**
   * Whether a recognition is due, and why.
   *
   * A line is owed a reading when its current content has none yet (or only a doubted one).
   * It is recognised once every line in its passage has settled, so a dialogue box still
   * typing its second line is read once, whole, rather than a line at a time. Blinking and
   * volatile lines neither hold a passage up nor make one due. A passage that never settles
   * is read anyway after `maxWaitMs`.
   */
  readiness(
    at: number,
    maxWaitMs: number,
    inFlightVersions: Set<number> = new Set(),
    force = false
  ): Readiness | null {
    const o = this.options
    const present = this.tracks.filter((t) => t.present)
    let due: Readiness | null = null
    for (const cluster of this.clusters(present)) {
      const owed = cluster.filter((t) => this.owed(t, at, inFlightVersions))
      if (!owed.length) continue
      const steady = cluster.filter((t) => !this.blinking(t, at) && !this.volatile(t, at))
      const settled = force || steady.every((t) => t.stable >= o.stableObservations && !t.pending)
      const second = owed.every((t) => this.readingFor(t))
      if (settled) {
        const reason: Readiness['reason'] = force
          ? 'forced'
          : !second
            ? 'settled'
            : owed.some((t) => this.refreshDue(t))
              ? 'refresh'
              : 'second-opinion'
        // A first reading is worth more than a second opinion.
        if (!due || (due.reason !== 'settled' && reason === 'settled')) {
          due = { reason, tracks: owed.map((t) => t.id) }
        }
        continue
      }
      const waited = Math.max(...owed.map((t) => at - (t.moving ?? t.version.since)))
      if (waited >= maxWaitMs && !due) due = { reason: 'max-wait', tracks: owed.map((t) => t.id) }
    }
    return due
  }

  /** Lines still moving: the loop looks more often while there are any. */
  get unsettled(): boolean {
    return this.tracks.some((t) => t.present && (t.pending !== null || t.stable < this.options.stableObservations))
  }

  /** Which version of which line the current frame shows, to file a recognition of it against. */
  snapshot(at: number): SceneSnapshot {
    return {
      at,
      tracks: this.tracks
        .filter((t) => t.present)
        .map((t) => ({ id: t.id, version: t.version.id, key: t.version.key, box: { ...t.box } }))
    }
  }

  // --- readings ----------------------------------------------------------------------

  /**
   * File one recognition of the frame `snapshot` was taken from.
   *
   * The recognition is cut up by geometry: each piece goes with the lines it covers, and
   * pieces that share a line become one reading. Each reading is scored against what the
   * observer saw on those lines, and filed for the versions of them the frame showed. It is
   * kept only if nothing better is already held for exactly that text.
   *
   * `manual` is a scan the reader asked for: it wins outright and is already published.
   * `blind` is a recognition of a screen the observer could not read, which is the only
   * evidence there is about orphans, so one miss there is enough to drop one.
   */
  apply(
    result: OcrResult,
    snapshot: SceneSnapshot,
    at: number,
    mode: 'auto' | 'manual' | 'blind' = 'auto'
  ): ApplyOutcome {
    const o = this.options
    const manual = mode === 'manual'
    const outcome: ApplyOutcome = { filed: 0, improved: 0, rejected: 0, stale: 0, displayChanged: false }
    const shownBefore = this.shownSignature()
    if (this.engine !== null && result.engine && result.engine !== this.engine) this.units = []
    if (result.engine) this.engine = result.engine

    for (const entry of snapshot.tracks) {
      const track = this.tracks.find((t) => t.id === entry.id)
      const version = track && [track.version, ...track.history].find((v) => v.id === entry.version)
      if (!version) continue
      version.attempts++
      if (version.inkChanged) {
        version.inkChanged = false
        version.refreshes++
      }
    }

    const pieces = (result.geometry ? result.textAnnotations : []).filter(
      (a) => a.granularity !== 'aggregate' && a.description?.trim()
    )
    // Which snapshot lines each piece covers.
    const covers = pieces.map((piece) => {
      const box = annotationBox(piece)
      return snapshot.tracks
        .filter((t) => intersection(box, t.box) / Math.max(1, area(t.box)) >= 0.5 || containment(box, t.box) >= 0.6)
        .map((t) => t.id)
    })
    // Pieces sharing a line belong to one reading.
    const parent = pieces.map((_, i) => i)
    const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])))
    for (let i = 0; i < pieces.length; i++)
      for (let j = i + 1; j < pieces.length; j++)
        if (covers[i].some((id) => covers[j].includes(id))) parent[root(j)] = root(i)
    const readings = new Map<number, number[]>()
    pieces.forEach((_, i) => readings.set(root(i), [...(readings.get(root(i)) ?? []), i]))

    const fresh: Unit[] = []
    for (const indices of readings.values()) {
      const annotations = indices.map((i) => pieces[i])
      const ids = [...new Set(indices.flatMap((i) => covers[i]))]
      const lines = snapshot.tracks.filter((t) => ids.includes(t.id))
      const vertical = annotations.some((a) => a.isVertical || a.orientation === 'vertical')
      const ordered = annotations.map((a) => ({ a, box: annotationBox(a) }))
      readingOrder(ordered, vertical)
      const text = ordered.map(({ a }) => a.description).join('')
      const key = stabilityKey(text)
      if (!key) continue
      const seen = [...lines]
      readingOrder(seen, vertical)
      const observed = seen.map((t) => t.key).join('')
      const confidence = confidenceOf(annotations)
      // Agreement with the observer decides; the recogniser's own confidence breaks near-ties.
      const quality = lines.length
        ? agreement(key, observed) * 0.9 + (confidence ?? 0.5) * 0.1
        : 0.5 + Math.min(0.4, [...key].length / 100)
      // Only block engines' groups are bubbles to keep; line engines' groups are regrouped.
      const groupIds = new Set(
        annotations.filter((a) => a.granularity === 'block').map((a) => a.groupId)
      )
      fresh.push({
        id: this.nextUnit++,
        versions: new Map(lines.map((t) => [t.id, t.version])),
        annotations,
        groups: (result.groups ?? []).filter((g) => groupIds.has(g.id)),
        engine: result.engine,
        text,
        key,
        box: union(ordered.map(({ box }) => box)),
        vertical,
        quality: manual ? Math.max(quality, 1) : quality,
        doubtful: !manual && lines.length > 0 && [...key].length < [...observed].length * o.doubtfulLength,
        at,
        published: manual,
        publishAfter:
          !manual && lines.length > 0 && [...key].length < [...observed].length * o.doubtfulLength
            ? at + o.publishGraceMs
            : at,
        misses: 0,
        blinking: lines.some((line) => {
          const track = this.tracks.find((t) => t.id === line.id)
          return track ? this.blinking(track, at) : false
        })
      })
    }

    // Orphans this recognition did not find again move a step closer to being dropped.
    const orphans = this.units.filter((u) => u.versions.size === 0)
    for (const orphan of orphans) {
      const found = fresh.some((u) => u.versions.size === 0 && containment(u.box, orphan.box) >= 0.5)
      if (!found && ++orphan.misses >= (mode === 'auto' ? o.orphanMisses : 1)) this.units = this.units.filter((u) => u !== orphan)
    }

    for (const unit of fresh) {
      if (unit.versions.size === 0) {
        this.fileOrphan(unit, outcome)
        continue
      }
      // A piece of a line that has moved on is still a true reading of what it showed, and is
      // kept for when that comes back; it just is not what the line shows now.
      const current = [...unit.versions].every(([id, version]) => this.tracks.find((t) => t.id === id)?.version.id === version)
      if (!current) outcome.stale++
      const rivals = this.units.filter((u) =>
        [...unit.versions].some(([id, version]) => u.versions.get(id) === version)
      )
      const held = rivals.length
        ? rivals.reduce((sum, u) => sum + u.quality * [...u.key].length, 0) /
          Math.max(1, rivals.reduce((sum, u) => sum + [...u.key].length, 0))
        : -1
      // A reading of fewer lines than the ones it would displace has to be clearly better:
      // replacing them leaves the lines it does not cover with nothing.
      const narrower = rivals.some((r) => [...r.versions.keys()].some((id) => !unit.versions.has(id)))
      const margin = narrower ? 0.15 : 0.01
      // As good, and more of it: a reading taken once the text finished drawing in.
      const fuller =
        !narrower &&
        unit.quality >= held - 0.01 &&
        [...unit.key].length > Math.max(...rivals.map((r) => [...r.key].length))
      if (rivals.length && !manual && unit.quality <= held + margin && !fuller) {
        outcome.rejected++
        continue
      }
      if (rivals.length) {
        outcome.improved++
        // The first reading of this text may already be in the history; the better one is not
        // written again, it just takes its place on screen.
        if (rivals.some((r) => r.published)) unit.published = true
      }
      this.units = this.units.filter((u) => !rivals.includes(u))
      this.units.push(unit)
      outcome.filed++
    }
    outcome.displayChanged = this.shownSignature() !== shownBefore
    return outcome
  }

  private fileOrphan(unit: Unit, outcome: ApplyOutcome): void {
    const rival = this.units.find((u) => u.versions.size === 0 && containment(u.box, unit.box) >= 0.5)
    if (rival) {
      rival.misses = 0
      // Without an observer there is nothing to score against. The same text read more fully
      // wins; different text in the same place is the next line there.
      const same = agreement(rival.key, unit.key) >= 0.5
      if (same && [...unit.key].length <= [...rival.key].length) {
        outcome.rejected++
        return
      }
      if (same) unit.published = rival.published
      this.units = this.units.filter((u) => u !== rival)
      if (same) outcome.improved++
    }
    this.units.push(unit)
    outcome.filed++
  }

  // --- what is shown -----------------------------------------------------------------

  /**
   * The readings to draw now.
   *
   * A reading is shown while the lines it was read from show the same content — absent lines
   * do not veto a reading most of whose lines are still there, so a bubble the observer half
   * loses for a frame stays drawn. A line still being typed keeps showing the reading of its
   * shorter self until the full one lands.
   */
  shownUnits(): Unit[] {
    const shown: Unit[] = []
    const covered = new Set<number>()
    for (const unit of this.units) {
      if (unit.versions.size === 0) {
        shown.push(unit)
        continue
      }
      let present = 0
      let ok = true
      for (const [id, version] of unit.versions) {
        const track = this.tracks.find((t) => t.id === id)
        if (!track) {
          ok = false
          break
        }
        if (!track.present) continue
        if (track.version.id !== version) {
          ok = false
          break
        }
        present++
      }
      if (ok && present * 2 >= unit.versions.size && present > 0) {
        shown.push(unit)
        for (const id of unit.versions.keys()) covered.add(id)
      }
    }
    for (const track of this.tracks) {
      if (!track.present || covered.has(track.id)) continue
      // Typing in progress: the latest reading of a shorter version of this text, alone.
      const earlier = this.units
        .filter((u) => u.versions.size === 1 && u.versions.has(track.id))
        .map((u) => ({ u, v: track.history.find((v) => v.id === u.versions.get(track.id)) }))
        .filter(({ v }) => v && track.version.key.startsWith(v.key))
        .sort((a, b) => (b.v as Version).key.length - (a.v as Version).key.length)[0]
      if (earlier) shown.push(earlier.u)
    }
    return shown
  }

  private shownSignature(): string {
    return this.shownUnits()
      .map((u) => u.id)
      .sort((a, b) => a - b)
      .join(',')
  }

  /** Everything shown, as one OCR result in the shape the overlay draws. */
  composite(): OcrResult {
    return compose(this.shownUnits(), this.engine ?? '')
  }

  /**
   * Passages to write to the history: one entry per passage (a dialogue box, a bubble), once
   * it has finished arriving.
   *
   * A passage waits while any of its lines is still moving, still drawing in, or not read yet,
   * and while a doubted reading waits for its second opinion (up to `publishGraceMs`), so the
   * history gets whole passages in order rather than whichever line settled first. Blinking
   * and volatile lines are never part of one, and a passage with no Japanese is not written.
   *
   * If a passage that was already written grows or is read better — every line it had still
   * shows what it showed, or more of it — the new text comes with `replaces`, the text it
   * corrects, so the history entry is replaced rather than joined by a fragment. A passage
   * that matches one written since the screen was last blank, decorations aside, is skipped.
   */
  takePublishable(at: number): Passage[] {
    const o = this.options
    const out: Passage[] = []
    const shown = this.shownUnits()
    const steady = this.tracks.filter(
      (t) => t.present && !this.blinking(t, at) && !this.volatile(t, at)
    )
    for (const cluster of this.clusters(steady)) {
      const busy = cluster.some((t) => {
        const moving = t.pending !== null || t.stable < o.stableObservations
        const stuck = t.moving !== null && at - t.moving > o.publishHoldMs
        if (moving && !stuck) return true
        if (!this.readingFor(t) && t.version.attempts < o.maxAttempts) return true
        return this.refreshDue(t)
      })
      if (busy) continue
      const ids = new Set(cluster.map((t) => t.id))
      const units = shown.filter((u) => [...u.versions.keys()].some((id) => ids.has(id)))
      if (!units.length || units.some((u) => at < u.publishAfter)) continue
      const result = compose(units, this.engine ?? '')
      const text = result.fullText
      if (!isJapanese(text)) continue
      const identity = identityKey(text)
      const previous = [
        ...new Set(cluster.map((t) => this.passageOf.get(t.id)).filter((p): p is PublishedPassage => !!p))
      ]
      if (previous.some((p) => decorationOnly(p.identity, identity))) continue
      // The same lines, still showing what they showed or more of it: a better reading.
      let corrects =
        previous.length === 1 &&
        cluster.every((t) => {
          const before = previous[0].keys.get(t.id)
          return before === undefined || t.version.key.startsWith(before)
        })
          ? previous[0]
          : null
      if (!corrects) {
        // Or the same passage read again after the observer split its lines another way: close
        // to one published moments ago. Kept if it is no fuller; otherwise it takes its place.
        const similar = this.recent.find(
          (p) => at - p.at < o.passageMemoryMs && agreement(p.identity, identity) >= 0.8
        )
        if (similar && [...identity].length <= [...similar.identity].length) {
          for (const t of cluster) this.passageOf.set(t.id, similar)
          for (const unit of units) unit.published = true
          continue
        }
        if (similar) corrects = similar
        else if (this.published.some((key) => decoratedVariant(key, identity))) continue
      }
      const record: PublishedPassage = {
        text,
        identity,
        keys: new Map(cluster.map((t) => [t.id, t.version.key])),
        at
      }
      for (const t of cluster) this.passageOf.set(t.id, record)
      if (corrects) {
        const old = corrects
        this.published = this.published.filter((key) => key !== old.identity)
        this.recent = this.recent.filter((p) => p !== old)
      }
      this.published.push(identity)
      if (this.published.length > 64) this.published.shift()
      this.recent.push(record)
      if (this.recent.length > 20) this.recent.shift()
      for (const unit of units) unit.published = true
      out.push({ result, replaces: corrects ? corrects.text : null })
    }
    // Text only the recogniser saw has no lines to wait on: each piece goes once.
    for (const unit of shown) {
      if (unit.versions.size > 0 || unit.published || at < unit.publishAfter) continue
      unit.published = true
      const identity = identityKey(unit.text)
      if (!isJapanese(unit.text) || this.published.some((key) => decoratedVariant(key, identity))) continue
      this.published.push(identity)
      out.push({ result: compose([unit], this.engine ?? ''), replaces: null })
    }
    return out
  }

  stats(at: number): SceneStats {
    const shown = this.shownUnits()
    return {
      tracks: this.tracks.length,
      present: this.tracks.filter((t) => t.present).length,
      blinking: this.tracks.filter((t) => this.blinking(t, at)).length,
      volatile: this.tracks.filter((t) => this.volatile(t, at)).length,
      units: this.units.length,
      shown: shown.length,
      orphans: this.units.filter((u) => u.versions.size === 0).length
    }
  }

  /** Versions a snapshot covers, so lines already being read are not asked for twice. */
  static versions(snapshot: SceneSnapshot | null): Set<number> {
    return new Set(snapshot?.tracks.map((t) => t.version) ?? [])
  }
}

/**
 * Readings from any number of recognitions as one result.
 *
 * Block engines (Manga OCR) keep their bubbles as given. Line and word engines are grouped
 * again across all of them, so lines read in different recognitions still form one passage.
 */
export function compose(units: Unit[], engine: string): OcrResult {
  const ordered = [...units]
  readingOrder(ordered, ordered.some((u) => u.vertical))
  const blocks = ordered.flatMap((u) => u.groups.map((g) => ({ ...g, id: `u${u.id}-${g.id}` })))
  if (blocks.length) {
    return normalizeOcrResult({ groups: blocks, fullText: blocks.map((g) => g.text).join('\n') }, engine)
  }
  const words = ordered.flatMap((u) =>
    u.annotations.map((a) => {
      const copy = { ...a }
      delete copy.groupId
      return copy
    })
  )
  if (!words.length) return normalizeOcrResult({ fullText: '', textAnnotations: [] }, engine)
  return normalizeOcrResult(
    {
      fullText: ordered.map((u) => u.text).join('\n'),
      textAnnotations: [
        { description: '', granularity: 'aggregate', boundingPoly: words[0].boundingPoly },
        ...words
      ]
    },
    engine
  )
}
