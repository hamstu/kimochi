import { writeTextFile } from "./files";
import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
} from "@tauri-apps/plugin-fs";
import { getSettings, onSettingsChange } from "../lib/settings";
import { currentLinesPath } from "./sessions";
import type { Line, LineSource, Token } from "../lib/types";

const DIR = BaseDirectory.AppLocalData;
const DEBOUNCE_MS = 2000;

function maxLinesNow(): number {
  const v = getSettings().maxLines;
  return Math.max(100, Math.min(50000, v || 5000));
}

type StoreEvent =
  | { type: "load"; lines: Line[] }
  | { type: "append"; line: Line }
  | { type: "update"; line: Line }
  | { type: "remove"; id: number }
  | { type: "trim"; dropped: number }
  | { type: "clear" };

type Sub = (e: StoreEvent) => void;

let lines: Line[] = [];
let nextId = 1;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<Sub>();

function emit(e: StoreEvent) {
  for (const fn of subs) {
    try {
      fn(e);
    } catch (err) {
      console.error(err);
    }
  }
}

export function subscribe(fn: Sub): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

async function ensureSessionDir() {
  // The active session's directory must exist before we write its lines.json.
  try {
    const path = currentLinesPath();
    const parent = path.substring(0, path.lastIndexOf("/"));
    if (parent && !(await exists(parent, { baseDir: DIR }))) {
      await mkdir(parent, { baseDir: DIR, recursive: true });
    }
  } catch {
    // Best-effort.
  }
}

export async function loadLines(): Promise<Line[]> {
  await ensureSessionDir();
  const file = currentLinesPath();
  try {
    const present = await exists(file, { baseDir: DIR });
    if (!present) {
      lines = [];
      nextId = 1;
      emit({ type: "load", lines: [] });
      return lines;
    }
    const raw = await readTextFile(file, { baseDir: DIR });
    const parsed = JSON.parse(raw) as { lines?: Line[] };
    if (parsed && Array.isArray(parsed.lines)) {
      lines = parsed.lines.filter(
        (l) => l && typeof l.text === "string",
      ) as Line[];
      nextId = lines.reduce((m, l) => Math.max(m, l.id || 0), 0) + 1;
    } else {
      throw new Error(
        "Invalid session transcript; existing data has been left untouched",
      );
    }
  } catch (err) {
    console.warn("loadLines failed", err);
    throw err;
  }
  emit({ type: "load", lines: lines.slice() });
  return lines.slice();
}

/** Called by sessions.ts when the user switches sessions. Resets in-memory
 *  state and reloads from the new session's lines.json. The caller is expected
 *  to have flushed the prior session's lines BEFORE invoking this. */
export async function onActiveSessionChanged(): Promise<void> {
  // Cancel any pending debounced save — it would now target the wrong path.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirty = false;
  lines = [];
  nextId = 1;
  await loadLines();
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (dirty) void flushLines();
  }, DEBOUNCE_MS);
}

export async function flushLines(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  try {
    const file = currentLinesPath();
    const body = JSON.stringify({ version: 1, lines });
    await ensureSessionDir();
    await writeTextFile(file, body, { baseDir: DIR });
  } catch (err) {
    console.error("flushLines failed", err);
    dirty = true;
    throw err;
  }
}

export function appendLine(opts: {
  text: string;
  source: LineSource;
  ts?: number;
  tokens?: Token[] | null;
}): Line | null {
  const text = opts.text;
  if (!text || !text.trim()) return null;
  const line: Line = {
    id: nextId++,
    text,
    tokens: opts.tokens ?? null,
    source: opts.source,
    ts: opts.ts ?? Date.now(),
  };
  lines.push(line);
  const cap = maxLinesNow();
  if (lines.length > cap) {
    const dropped = lines.length - cap;
    lines.splice(0, dropped);
    emit({ type: "trim", dropped });
  }
  emit({ type: "append", line });
  scheduleSave();
  return line;
}

export function updateLineTokens(id: number, tokens: Token[]) {
  const idx = lines.findIndex((l) => l.id === id);
  if (idx === -1) return;
  // Replace with a fresh object so React.memo sees a new reference.
  const updated: Line = { ...lines[idx], tokens };
  lines[idx] = updated;
  emit({ type: "update", line: updated });
  scheduleSave();
}

/** Replace the last line's text (used by start-merge). Clears tokens so the
 *  caller can re-tokenize with the new text. */
export function replaceLastLineText(text: string): Line | null {
  if (lines.length === 0) return null;
  const idx = lines.length - 1;
  const updated: Line = { ...lines[idx], text, tokens: null };
  lines[idx] = updated;
  emit({ type: "update", line: updated });
  scheduleSave();
  return updated;
}

/** Cache a translation on a line and (by default) switch the row to it. */
export function setLineTranslation(
  id: number,
  translation: string,
  show = true,
) {
  const idx = lines.findIndex((l) => l.id === id);
  if (idx === -1) return;
  const updated: Line = { ...lines[idx], translation, showTranslation: show };
  lines[idx] = updated;
  emit({ type: "update", line: updated });
  scheduleSave();
}

/** Cache an LLM explanation (markdown) on a line. */
export function setLineExplanation(id: number, explanation: string) {
  const idx = lines.findIndex((l) => l.id === id);
  if (idx === -1) return;
  const updated: Line = { ...lines[idx], explanation };
  lines[idx] = updated;
  emit({ type: "update", line: updated });
  scheduleSave();
}

export function setLineTranslationVisible(id: number, visible: boolean) {
  const idx = lines.findIndex((l) => l.id === id);
  if (idx === -1) return;
  const updated: Line = { ...lines[idx], showTranslation: visible };
  lines[idx] = updated;
  emit({ type: "update", line: updated });
  scheduleSave();
}

export function deleteLine(id: number) {
  const idx = lines.findIndex((l) => l.id === id);
  if (idx === -1) return;
  lines.splice(idx, 1);
  emit({ type: "remove", id });
  scheduleSave();
}

export function clearLines() {
  lines = [];
  nextId = 1;
  dirty = true;
  emit({ type: "clear" });
  // Flush immediately so the cleared state hits disk even if the app quits
  // before the debounce fires.
  void flushLines();
}

export function snapshotLines(): Line[] {
  return lines.slice();
}

export function lineCount(): number {
  return lines.length;
}

export function lastLineText(): string | null {
  return lines.length ? lines[lines.length - 1].text : null;
}

/** Exact-match dedupe over the last `depth` lines. */
export function isDuplicateInRecent(text: string, depth: number): boolean {
  if (depth <= 0) return false;
  const start = Math.max(0, lines.length - depth);
  for (let i = lines.length - 1; i >= start; i--) {
    if (lines[i].text === text) return true;
  }
  return false;
}

// Eagerly trim the buffer when the maxLines setting drops.
onSettingsChange(() => {
  const cap = maxLinesNow();
  if (lines.length > cap) {
    const dropped = lines.length - cap;
    lines.splice(0, dropped);
    emit({ type: "trim", dropped });
    scheduleSave();
  }
});
