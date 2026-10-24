import { writeTextFile } from "./files";
import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
} from "@tauri-apps/plugin-fs";
import { getSettings, onSettingsChange } from "../lib/settings";
import { currentLinesPath, getManifest } from "./sessions";
import { writesPaused } from "./profile";
import { reportLine } from "../lib/sentenceAudio";
import type { Line, LineSource } from "../lib/types";

const DIR = BaseDirectory.AppLocalData;
const DEBOUNCE_MS = 2000;
/** The deletions `lines.json` remembers for Sync (oldest dropped first). */
const MAX_DELETED = 5000;

function maxLinesNow(): number {
  const v = getSettings().maxLines;
  return Math.max(100, Math.min(50000, v || 5000));
}

type StoreEvent =
  | { type: "load"; lines: Line[] }
  /** Sync merged another computer's lines into the file: the same session, reloaded. */
  | { type: "sync"; lines: Line[] }
  | { type: "append"; line: Line }
  | { type: "update"; line: Line }
  | { type: "remove"; id: number }
  | { type: "trim"; dropped: number }
  | { type: "clear" };

type Sub = (e: StoreEvent) => void;

/** A line deleted on purpose (not trimmed by the line limit): Sync deletes it everywhere. */
interface DeletedLine {
  uid: string;
  at: number;
}

let lines: Line[] = [];
let deleted: DeletedLine[] = [];
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

const FNV_OFFSET = BigInt("0xcbf29ce484222325");
const FNV_PRIME = BigInt("0x100000001b3");
const MASK = BigInt("0xffffffffffffffff");

/** FNV-1a, 64-bit, over UTF-8: the same function as `sync_core::fnv64` in Rust. */
export function fnv64(text: string): bigint {
  let h = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK;
  }
  return h;
}

/**
 * The uid of a line written before lines had one: derived from what identifies it in its session,
 * exactly as Sync derives it for sessions the Log has not opened (`derived_line_uid`).
 */
export function derivedLineUid(sid: string, line: Pick<Line, "id" | "ts" | "text">): string {
  return `l${fnv64(`${sid}\n${line.id}\n${line.ts}\n${line.text}`).toString(16).padStart(16, "0")}`;
}

function newUid(): string {
  return crypto.randomUUID();
}

function activeSessionId(): string {
  try {
    return getManifest().activeId;
  } catch {
    return "";
  }
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

async function readLinesFile(): Promise<{ lines: Line[]; deleted: DeletedLine[]; backfilled: boolean }> {
  const file = currentLinesPath();
  if (!(await exists(file, { baseDir: DIR }))) return { lines: [], deleted: [], backfilled: false };
  const raw = await readTextFile(file, { baseDir: DIR });
  const parsed = JSON.parse(raw) as { lines?: Line[]; deleted?: DeletedLine[] };
  if (!parsed || !Array.isArray(parsed.lines)) {
    throw new Error(
      "Invalid session transcript; existing data has been left untouched",
    );
  }
  const sid = activeSessionId();
  let backfilled = false;
  const loaded = parsed.lines
    .filter((l) => l && typeof l.text === "string")
    .map((l) => {
      if (typeof l.uid === "string" && l.uid) return l;
      backfilled = true;
      return { ...l, uid: derivedLineUid(sid, l) };
    });
  const gone = Array.isArray(parsed.deleted)
    ? parsed.deleted.filter((d) => d && typeof d.uid === "string")
    : [];
  return { lines: loaded, deleted: gone, backfilled };
}

export async function loadLines(): Promise<Line[]> {
  await ensureSessionDir();
  try {
    const read = await readLinesFile();
    lines = read.lines;
    deleted = read.deleted;
    nextId = lines.reduce((m, l) => Math.max(m, l.id || 0), 0) + 1;
    // Lines from before uids get theirs written once, so they never change afterwards.
    if (read.backfilled) scheduleSave();
  } catch (err) {
    console.warn("loadLines failed", err);
    throw err;
  }
  emit({ type: "load", lines: lines.slice() });
  return lines.slice();
}

/** After Sync merged into the active session's file: the merged lines, in place of ours. */
export async function reloadLines(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirty = false;
  const read = await readLinesFile();
  lines = read.lines;
  deleted = read.deleted;
  nextId = lines.reduce((m, l) => Math.max(m, l.id || 0), 0) + 1;
  if (read.backfilled) scheduleSave();
  emit({ type: "sync", lines: lines.slice() });
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
  deleted = [];
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

/** Lines written since the last flush, for Sync to notice. */
type FlushListener = () => void;
const flushListeners = new Set<FlushListener>();
export function onLinesFlushed(fn: FlushListener): () => void {
  flushListeners.add(fn);
  return () => flushListeners.delete(fn);
}

export async function flushLines(): Promise<void> {
  if (!dirty) return;
  // Sync is merging into the file: this window writes after it reloads.
  if (writesPaused()) return;
  dirty = false;
  try {
    const file = currentLinesPath();
    const body = JSON.stringify({ version: 1, lines, deleted });
    await ensureSessionDir();
    await writeTextFile(file, body, { baseDir: DIR });
  } catch (err) {
    console.error("flushLines failed", err);
    dirty = true;
    throw err;
  }
  for (const fn of flushListeners) fn();
}

function rememberDeleted(removed: Line[]) {
  const at = Date.now();
  for (const line of removed) if (line.uid) deleted.push({ uid: line.uid, at });
  if (deleted.length > MAX_DELETED) deleted.splice(0, deleted.length - MAX_DELETED);
}

export function appendLine(opts: {
  ocr?: Line["ocr"];
  text: string;
  source: LineSource;
  ts?: number;
}): Line | null {
  const text = opts.text;
  if (!text || !text.trim()) return null;
  const line: Line = {
    id: nextId++,
    uid: newUid(),
    text,
    source: opts.source,
    ...(opts.ocr ? { ocr: opts.ocr } : {}),
    ts: opts.ts ?? Date.now(),
  };
  lines.push(line);
  const cap = maxLinesNow();
  if (lines.length > cap) {
    // Trimmed, not deleted: other computers keep these lines.
    const dropped = lines.length - cap;
    lines.splice(0, dropped);
    emit({ type: "trim", dropped });
  }
  emit({ type: "append", line });
  reportLine(line);
  scheduleSave();
  return line;
}

/** Replace the last line's text (used by start-merge). */
export function replaceLastLineText(text: string): Line | null {
  if (lines.length === 0) return null;
  const idx = lines.length - 1;
  const updated: Line = { ...lines[idx], text };
  lines[idx] = updated;
  emit({ type: "update", line: updated });
  reportLine(updated);
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
  rememberDeleted(lines.splice(idx, 1));
  emit({ type: "remove", id });
  scheduleSave();
}

export function clearLines() {
  rememberDeleted(lines);
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
