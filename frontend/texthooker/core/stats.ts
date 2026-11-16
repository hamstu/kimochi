import { writeTextFile } from './files'
import { inProfile } from './profile'
import { BaseDirectory, exists, mkdir, readTextFile } from '@tauri-apps/plugin-fs'
import { getSettings, onSettingsChange } from '../lib/settings'
import { STATS_DEFAULTS, type Stats } from '../lib/types'
import { Pace, SKIP_MAX_GAP_MS, SKIP_MIN_CHARS, SKIP_MIN_RUN } from '../lib/readingTime'

const FILE = 'stats.json'
const DIR = BaseDirectory.AppLocalData
const DEBOUNCE_MS = 3000

type StatsListener = (s: Stats, runningSince: number | null) => void

let current: Stats = { ...STATS_DEFAULTS }
let runningSince: number | null = null
/** When the running interval last saw a line: it counts up to here, plus at most `lastCapMs`. */
let lastActive = 0
/** The most the last line may count (lib/readingTime.ts): the running interval stops there. */
let lastCapMs = 0
/** Each session's pace, learned from the lines read since the Log started. */
const paces = new Map<string, Pace>()
/** The last lines counted, newest last, for the pace and for skipping. */
interface Seen {
  at: number
  chars: number
  words?: number
  session: string
  skipped: boolean
}
let recent: Seen[] = []
/** Lines in the current run of fast, long lines (skipping, when it reaches SKIP_MIN_RUN). */
let fastRun = 0
let afkTimer: ReturnType<typeof setTimeout> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let dirty = false
const subs = new Set<StatsListener>()

function emit() {
  for (const fn of subs) {
    try {
      fn(current, runningSince)
    } catch (e) {
      console.error(e)
    }
  }
}

export function subscribeStats(fn: StatsListener): () => void {
  subs.add(fn)
  fn(current, runningSince)
  return () => {
    subs.delete(fn)
  }
}

async function ensureDir() {
  try {
    if (!(await exists(inProfile(''), { baseDir: DIR }))) {
      await mkdir(inProfile(''), { baseDir: DIR, recursive: true })
    }
  } catch {
    /* best-effort */
  }
}

export async function loadStats(): Promise<Stats> {
  await ensureDir()
  try {
    const present = await exists(inProfile(FILE), { baseDir: DIR })
    if (present) {
      const raw = await readTextFile(inProfile(FILE), { baseDir: DIR })
      const parsed = JSON.parse(raw) as Partial<Stats>
      current = {
        ...STATS_DEFAULTS,
        ...parsed,
        version: 1
      }
    }
  } catch (err) {
    console.warn('loadStats failed', err)
    current = { ...STATS_DEFAULTS }
  }
  emit()
  return current
}

function scheduleSave() {
  dirty = true
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (dirty) void flushStats()
  }, DEBOUNCE_MS)
}

export async function flushStats(): Promise<void> {
  if (!dirty) return
  dirty = false
  try {
    await writeTextFile(inProfile(FILE), JSON.stringify(current), { baseDir: DIR })
  } catch (err) {
    console.error('flushStats failed', err)
    dirty = true
    throw err
  }
}

/**
 * How long the running interval has lasted at `now`: from its first line to now, but never past
 * what its last line may count (lib/readingTime.ts), so time away (or a laptop asleep before the
 * timer could fire) isn't counted as reading.
 */
function runningMs(now: number): number {
  if (runningSince === null) return 0
  return Math.max(0, Math.min(now, runningUntil()) - runningSince)
}

/** The most one line may count: the Log's setting (`afkThresholdSec`). */
function ceilingMs(): number {
  return Math.max(10, getSettings().afkThresholdSec) * 1000
}

/** The latest the running interval can count to: what its last line may count. */
function runningUntil(): number {
  return lastActive + lastCapMs
}

function paceOf(session: string): Pace {
  let pace = paces.get(session)
  if (!pace) paces.set(session, (pace = new Pace()))
  return pace
}

/**
 * A line or edit at `now`: it continues the running interval, or, once that has gone past what its
 * last line may count (the timer had no chance to fire: the computer slept, or a hidden window's
 * timers were held back), ends it and starts a new one. `capMs`: what this line may count.
 */
function noteActivity(now: number, capMs: number) {
  if (runningSince !== null && now > runningUntil()) commitRunning(now)
  if (runningSince === null) runningSince = now
  lastActive = now
  lastCapMs = capMs
}

/** Fold the running interval into totalMs. */
function commitRunning(now: number) {
  if (runningSince === null) return
  current.totalMs += runningMs(now)
  runningSince = null
}

function armAfkTimer() {
  if (afkTimer) clearTimeout(afkTimer)
  afkTimer = setTimeout(
    () => {
      commitRunning(Date.now())
      emit()
      scheduleSave()
    },
    Math.max(0, runningUntil() - Date.now())
  )
  // Under Node (the integration tests) a pending minute-long timer would keep the process alive
  // past the test timeout; the browser's timer handle has no such method.
  if (typeof afkTimer === 'object' && afkTimer !== null && 'unref' in afkTimer) afkTimer.unref()
}

function count(chars: number, words: number | undefined, lines: number) {
  current.totalChars = Math.max(0, current.totalChars + chars)
  if (words !== undefined) current.totalWords = Math.max(0, (current.totalWords ?? 0) + words)
  current.totalLines = Math.max(0, current.totalLines + lines)
}

/**
 * Called by ingest for every line appended: `chars` its characters (charCount.ts), `words` its
 * words, counted only in a language that spaces them (wordCount.ts; otherwise undefined and
 * `totalWords` is untouched), `session` the session it went to (each has its own pace). A line
 * that makes a run of fast, long lines skipping (lib/readingTime.ts) un-counts the run's earlier
 * lines, and it and the rest of the run count nothing.
 */
export function recordLine(chars: number, words?: number, session = '') {
  const now = Date.now()
  const last = recent.at(-1)
  const fast =
    getSettings().skipFastLines !== false &&
    !!last &&
    now - last.at < SKIP_MAX_GAP_MS &&
    chars >= SKIP_MIN_CHARS &&
    last.chars >= SKIP_MIN_CHARS
  fastRun = fast ? fastRun + 1 : 1
  if (last && !last.skipped) paceOf(last.session).learn(last.chars, now - last.at)
  const skipped = fastRun >= SKIP_MIN_RUN
  if (fastRun === SKIP_MIN_RUN) {
    // The run's earlier lines were skipped too: take them back, and stop the clock.
    for (const line of recent.slice(-(SKIP_MIN_RUN - 1))) {
      if (line.skipped) continue
      line.skipped = true
      count(-line.chars, line.words === undefined ? undefined : -line.words, -1)
    }
    commitRunning(now)
  }
  recent = [...recent.slice(-(SKIP_MIN_RUN - 1)), { at: now, chars, words, session, skipped }]
  if (!skipped) {
    noteActivity(now, paceOf(session).capMs(chars, ceilingMs()))
    count(chars, words, 1)
    armAfkTimer()
  }
  current.lastUpdateTs = now
  emit()
  scheduleSave()
}

/** Called when the last line gets longer (start-merge) or is replaced by a fuller reading:
    `delta` characters and `wordDelta` words more (as recordLine's). */
export function recordCharDelta(delta: number, wordDelta?: number) {
  if (delta === 0 && !wordDelta) return
  const now = Date.now()
  const last = recent.at(-1)
  if (last) {
    last.chars = Math.max(0, last.chars + delta)
    if (wordDelta !== undefined) last.words = (last.words ?? 0) + wordDelta
    if (last.skipped) return
  }
  noteActivity(now, paceOf(last?.session ?? '').capMs(last?.chars ?? Math.max(0, delta), ceilingMs()))
  count(delta, wordDelta, 0)
  current.lastUpdateTs = now
  armAfkTimer()
  emit()
  scheduleSave()
}

/**
 * Live snapshot for the footer. Caller does its own ticking. `runningLeftMs` is how much longer the
 * running interval can grow without another line, so a window ticking a copy of this (lib/stats.ts)
 * stops where this module would.
 */
export function snapshotStats(): { stats: Stats; elapsedMs: number; runningLeftMs: number } {
  const now = Date.now()
  const runningLeftMs = runningSince === null ? 0 : Math.max(0, runningUntil() - now)
  return { stats: current, elapsedMs: current.totalMs + runningMs(now), runningLeftMs }
}

export function isRunning(): boolean {
  return runningSince !== null
}

export function resetStats() {
  if (afkTimer) {
    clearTimeout(afkTimer)
    afkTimer = null
  }
  runningSince = null
  lastCapMs = 0
  recent = []
  fastRun = 0
  current = { ...STATS_DEFAULTS }
  dirty = true
  emit()
  void flushStats()
}

// If AFK threshold changes mid-session, re-arm the timer so the new value
// applies from now.
onSettingsChange(() => {
  if (runningSince !== null) armAfkTimer()
})
