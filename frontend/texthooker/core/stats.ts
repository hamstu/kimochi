import { writeTextFile } from "./files";
import { inProfile } from "./profile";
import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
} from "@tauri-apps/plugin-fs";
import { getSettings, onSettingsChange } from "../lib/settings";
import { STATS_DEFAULTS, type Stats } from "../lib/types";

const FILE = "stats.json";
const DIR = BaseDirectory.AppLocalData;
const DEBOUNCE_MS = 3000;

type StatsListener = (s: Stats, runningSince: number | null) => void;

let current: Stats = { ...STATS_DEFAULTS };
let runningSince: number | null = null;
/** When the running interval last saw a line: it counts up to here, plus at most the AFK threshold. */
let lastActive = 0;
let afkTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
const subs = new Set<StatsListener>();

function emit() {
  for (const fn of subs) {
    try {
      fn(current, runningSince);
    } catch (e) {
      console.error(e);
    }
  }
}

export function subscribeStats(fn: StatsListener): () => void {
  subs.add(fn);
  fn(current, runningSince);
  return () => {
    subs.delete(fn);
  };
}

async function ensureDir() {
  try {
    if (!(await exists(inProfile(""), { baseDir: DIR }))) {
      await mkdir(inProfile(""), { baseDir: DIR, recursive: true });
    }
  } catch {
    /* best-effort */
  }
}

export async function loadStats(): Promise<Stats> {
  await ensureDir();
  try {
    const present = await exists(inProfile(FILE), { baseDir: DIR });
    if (present) {
      const raw = await readTextFile(inProfile(FILE), { baseDir: DIR });
      const parsed = JSON.parse(raw) as Partial<Stats>;
      current = {
        ...STATS_DEFAULTS,
        ...parsed,
        version: 1,
      };
    }
  } catch (err) {
    console.warn("loadStats failed", err);
    current = { ...STATS_DEFAULTS };
  }
  emit();
  return current;
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (dirty) void flushStats();
  }, DEBOUNCE_MS);
}

export async function flushStats(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  try {
    await writeTextFile(inProfile(FILE), JSON.stringify(current), { baseDir: DIR });
  } catch (err) {
    console.error("flushStats failed", err);
    dirty = true;
    throw err;
  }
}

/**
 * How long the running interval has lasted at `now`: from its first line to now, but never past
 * the AFK threshold after its last line, so time away (or a laptop asleep before the AFK timer
 * could fire) isn't counted as reading.
 */
function runningMs(now: number): number {
  if (runningSince === null) return 0;
  return Math.max(0, Math.min(now, runningUntil()) - runningSince);
}

/** The latest the running interval can count to: the AFK threshold after its last line. */
function runningUntil(): number {
  return lastActive + Math.max(10, getSettings().afkThresholdSec) * 1000;
}

/**
 * A line or edit at `now`: it continues the running interval, or, once that has been idle past the
 * AFK threshold (the timer had no chance to fire: the computer slept, or a hidden window's timers
 * were held back), ends it and starts a new one.
 */
function noteActivity(now: number) {
  if (runningSince !== null && now > runningUntil()) commitRunning(now);
  if (runningSince === null) runningSince = now;
  lastActive = now;
}

/** Fold the running interval into totalMs. */
function commitRunning(now: number) {
  if (runningSince === null) return;
  current.totalMs += runningMs(now);
  runningSince = null;
}

function armAfkTimer() {
  if (afkTimer) clearTimeout(afkTimer);
  const afkMs = Math.max(10, getSettings().afkThresholdSec) * 1000;
  afkTimer = setTimeout(() => {
    commitRunning(Date.now());
    emit();
    scheduleSave();
  }, afkMs);
  // Under Node (the integration tests) a pending minute-long timer would keep the process alive
  // past the test timeout; the browser's timer handle has no such method.
  if (typeof afkTimer === "object" && afkTimer !== null && "unref" in afkTimer)
    afkTimer.unref();
}

/** Called by useIngest for every successful append. `words`: its words, counted only in a
    language that spaces them (wordCount.ts); otherwise undefined and `totalWords` is untouched. */
export function recordLine(textLen: number, words?: number) {
  const now = Date.now();
  noteActivity(now);
  current.totalChars += textLen;
  if (words !== undefined) current.totalWords = (current.totalWords ?? 0) + words;
  current.totalLines += 1;
  current.lastUpdateTs = now;
  armAfkTimer();
  emit();
  scheduleSave();
}

/** Called when a line gets start-merged (replacing the previous line). `wordDelta` as
    recordLine's `words`. */
export function recordCharDelta(delta: number, wordDelta?: number) {
  if (delta === 0 && !wordDelta) return;
  const now = Date.now();
  noteActivity(now);
  current.totalChars = Math.max(0, current.totalChars + delta);
  if (wordDelta !== undefined)
    current.totalWords = Math.max(0, (current.totalWords ?? 0) + wordDelta);
  current.lastUpdateTs = now;
  armAfkTimer();
  emit();
  scheduleSave();
}

/**
 * Live snapshot for the footer. Caller does its own ticking. `runningLeftMs` is how much longer the
 * running interval can grow without another line, so a window ticking a copy of this (lib/stats.ts)
 * stops where this module would.
 */
export function snapshotStats(): { stats: Stats; elapsedMs: number; runningLeftMs: number } {
  const now = Date.now();
  const runningLeftMs = runningSince === null ? 0 : Math.max(0, runningUntil() - now);
  return { stats: current, elapsedMs: current.totalMs + runningMs(now), runningLeftMs };
}

export function isRunning(): boolean {
  return runningSince !== null;
}

export function resetStats() {
  if (afkTimer) {
    clearTimeout(afkTimer);
    afkTimer = null;
  }
  runningSince = null;
  current = { ...STATS_DEFAULTS };
  dirty = true;
  emit();
  void flushStats();
}

// If AFK threshold changes mid-session, re-arm the timer so the new value
// applies from now.
onSettingsChange(() => {
  if (runningSince !== null) armAfkTimer();
});
