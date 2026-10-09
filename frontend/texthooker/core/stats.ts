import { writeTextFile } from "./files";
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
    if (!(await exists("", { baseDir: DIR }))) {
      await mkdir("", { baseDir: DIR, recursive: true });
    }
  } catch {
    /* best-effort */
  }
}

export async function loadStats(): Promise<Stats> {
  await ensureDir();
  try {
    const present = await exists(FILE, { baseDir: DIR });
    if (present) {
      const raw = await readTextFile(FILE, { baseDir: DIR });
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
    await writeTextFile(FILE, JSON.stringify(current), { baseDir: DIR });
  } catch (err) {
    console.error("flushStats failed", err);
    dirty = true;
    throw err;
  }
}

/** Fold a running interval into totalMs, clamped against laptop-sleep
 *  inflation (cap at the AFK threshold). */
function commitRunning(now: number) {
  if (runningSince === null) return;
  const afkMs = Math.max(10, getSettings().afkThresholdSec) * 1000;
  const elapsed = Math.min(now - runningSince, afkMs);
  if (elapsed > 0) current.totalMs += elapsed;
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

/** Called by useIngest for every successful append. */
export function recordLine(textLen: number) {
  const now = Date.now();
  if (runningSince === null) {
    runningSince = now;
  }
  current.totalChars += textLen;
  current.totalLines += 1;
  current.lastUpdateTs = now;
  armAfkTimer();
  emit();
  scheduleSave();
}

/** Called when a line gets start-merged (replacing the previous line). */
export function recordCharDelta(delta: number) {
  if (delta === 0) return;
  const now = Date.now();
  if (runningSince === null) {
    runningSince = now;
  }
  current.totalChars = Math.max(0, current.totalChars + delta);
  current.lastUpdateTs = now;
  armAfkTimer();
  emit();
  scheduleSave();
}

/** Live snapshot for the footer. Caller does its own ticking. */
export function snapshotStats(): { stats: Stats; elapsedMs: number } {
  const elapsedMs =
    current.totalMs + (runningSince ? Date.now() - runningSince : 0);
  return { stats: current, elapsedMs };
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
