import { writeTextFile } from "./files";
import {
  BaseDirectory,
  exists,
  mkdir,
  readFile,
  readTextFile,
  remove,
  writeFile,
} from "@tauri-apps/plugin-fs";
import {
  NOTEBOOK_EMPTY,
  type Line,
  type NotebookEntry,
  type NotebookFile,
  type NotebookImage,
  type NotebookNote,
  type PersonEntry,
  type PlaceOrThingEntry,
  type SerializedNotebookEntry,
} from "../lib/types";
import { currentImagesDir, currentNotebookPath, getManifest } from "./sessions";
import { buildPatternsFor } from "../lib/nameMatch";

const DIR = BaseDirectory.AppLocalData;
const DEBOUNCE_MS = 1000;

type Sub = (n: NotebookFile) => void;

let state: NotebookFile = { ...NOTEBOOK_EMPTY };
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
const subs = new Set<Sub>();

function newId(): string {
  return crypto.randomUUID();
}

function cloneNotebook(n: NotebookFile): NotebookFile {
  return {
    version: n.version,
    cacheVersion: n.cacheVersion,
    entries: n.entries.map((e) => ({
      ...e,
      images: e.images.map((i) => ({ ...i })),
    })),
  };
}

function emit() {
  const snap = cloneNotebook(state);
  for (const fn of subs) {
    try {
      fn(snap);
    } catch (err) {
      console.error(err);
    }
  }
}

function bumpAndScheduleSave() {
  state = { ...state, cacheVersion: state.cacheVersion + 1 };
  dirty = true;
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) void flushNotebook();
    }, DEBOUNCE_MS);
  }
  emit();
}

async function ensureNotebookParent() {
  try {
    const path = currentNotebookPath();
    const parent = path.substring(0, path.lastIndexOf("/"));
    if (parent && !(await exists(parent, { baseDir: DIR }))) {
      await mkdir(parent, { baseDir: DIR, recursive: true });
    }
  } catch {
    // best-effort
  }
}

async function ensureImagesDir() {
  try {
    const dir = currentImagesDir();
    if (!(await exists(dir, { baseDir: DIR }))) {
      await mkdir(dir, { baseDir: DIR, recursive: true });
    }
  } catch {
    // best-effort
  }
}

/** v1 → v2: add the notes array and turn matchGivenAlone on for every person
    (new default). Also backfills notes on any entry missing it. */
function migrateNotebook(parsed: NotebookFile): NotebookFile {
  const fromV1 = parsed.version === 1;
  let changed = false;
  const entries = parsed.entries.map((e) => {
    let next = e;
    if (!Array.isArray(next.notes)) {
      next = { ...next, notes: [] };
      changed = true;
    }
    if (fromV1 && next.kind === "person" && !next.matchGivenAlone) {
      next = { ...next, matchGivenAlone: true };
      changed = true;
    }
    return next;
  });
  if (!fromV1 && !changed) return parsed;
  return { ...parsed, version: 2, entries };
}

export async function loadNotebook(): Promise<NotebookFile> {
  await ensureNotebookParent();
  const file = currentNotebookPath();
  try {
    if (await exists(file, { baseDir: DIR })) {
      const raw = await readTextFile(file, { baseDir: DIR });
      const parsed = JSON.parse(raw) as NotebookFile;
      if (
        parsed &&
        (parsed.version === 1 || parsed.version === 2) &&
        Array.isArray(parsed.entries) &&
        typeof parsed.cacheVersion === "number"
      ) {
        const migrated = migrateNotebook(parsed);
        state = migrated;
        if (migrated !== parsed) {
          dirty = true;
          await flushNotebook();
        }
      } else {
        throw new Error(
          "Invalid notebook; existing data has been left untouched",
        );
      }
    } else {
      state = { ...NOTEBOOK_EMPTY };
    }
  } catch (err) {
    console.warn("loadNotebook failed", err);
    throw err;
  }
  emit();
  return cloneNotebook(state);
}

export async function flushNotebook(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  try {
    await ensureNotebookParent();
    await writeTextFile(currentNotebookPath(), JSON.stringify(state), {
      baseDir: DIR,
    });
  } catch (err) {
    console.error("flushNotebook failed", err);
    dirty = true;
    throw err;
  }
}

export function getNotebook(): NotebookFile {
  return state;
}

export function getEntry(id: string): NotebookEntry | undefined {
  return state.entries.find((e) => e.id === id);
}

export function subscribeNotebook(fn: Sub): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export async function onActiveSessionChanged(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirty = false;
  state = { ...NOTEBOOK_EMPTY };
  await loadNotebook();
}

/* ── CRUD ──────────────────────────────────────────────────────────────── */

function nowTs() {
  return Date.now();
}

export async function createPerson(
  partial: Partial<
    Omit<PersonEntry, "id" | "kind" | "createdAt" | "updatedAt" | "images">
  > = {},
): Promise<PersonEntry> {
  const now = nowTs();
  const entry: PersonEntry = {
    id: newId(),
    kind: "person",
    family: partial.family ?? "",
    given: partial.given ?? "",
    familyReading: partial.familyReading,
    givenReading: partial.givenReading,
    matchGivenAlone: partial.matchGivenAlone ?? true,
    aliases: partial.aliases ?? [],
    description: partial.description ?? "",
    notes: partial.notes ?? [],
    vndbId: partial.vndbId,
    importedDescription: partial.importedDescription,
    images: [],
    matchEnabled: partial.matchEnabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
  state = { ...state, entries: [...state.entries, entry] };
  bumpAndScheduleSave();
  return entry;
}

async function createPlaceOrThing(
  kind: "place" | "thing",
  partial: Partial<
    Omit<
      PlaceOrThingEntry,
      "id" | "kind" | "createdAt" | "updatedAt" | "images"
    >
  > = {},
): Promise<PlaceOrThingEntry> {
  const now = nowTs();
  const entry: PlaceOrThingEntry = {
    id: newId(),
    kind,
    name: partial.name ?? "",
    reading: partial.reading,
    aliases: partial.aliases ?? [],
    description: partial.description ?? "",
    notes: partial.notes ?? [],
    images: [],
    matchEnabled: partial.matchEnabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
  state = { ...state, entries: [...state.entries, entry] };
  bumpAndScheduleSave();
  return entry;
}

export function createPlace(
  partial: Partial<
    Omit<
      PlaceOrThingEntry,
      "id" | "kind" | "createdAt" | "updatedAt" | "images"
    >
  > = {},
) {
  return createPlaceOrThing("place", partial);
}

export function createThing(
  partial: Partial<
    Omit<
      PlaceOrThingEntry,
      "id" | "kind" | "createdAt" | "updatedAt" | "images"
    >
  > = {},
) {
  return createPlaceOrThing("thing", partial);
}

export async function updateEntry(
  id: string,
  patch: Partial<NotebookEntry>,
): Promise<void> {
  const idx = state.entries.findIndex((e) => e.id === id);
  if (idx === -1) return;
  const existing = state.entries[idx];
  // Disallow changing kind via patch.
  const merged = {
    ...existing,
    ...patch,
    kind: existing.kind,
    updatedAt: nowTs(),
  } as NotebookEntry;
  const entries = state.entries.slice();
  entries[idx] = merged;
  state = { ...state, entries };
  bumpAndScheduleSave();
}

export async function deleteEntry(id: string): Promise<void> {
  const idx = state.entries.findIndex((e) => e.id === id);
  if (idx === -1) return;
  // Best-effort: remove image files belonging to the entry.
  for (const img of state.entries[idx].images) {
    try {
      await remove(img.path, { baseDir: DIR });
    } catch {
      // best-effort
    }
  }
  state = { ...state, entries: state.entries.filter((e) => e.id !== id) };
  bumpAndScheduleSave();
}

/* ── Notes ─────────────────────────────────────────────────────────────── */

function patchNotes(
  entryId: string,
  fn: (notes: NotebookNote[]) => NotebookNote[],
): void {
  const entry = getEntry(entryId);
  if (!entry) return;
  void updateEntry(entryId, { notes: fn(entry.notes ?? []) });
}

export function addNote(entryId: string, text: string): void {
  const t = text.trim();
  if (!t) return;
  const now = nowTs();
  patchNotes(entryId, (notes) => [
    ...notes,
    { id: newId(), text: t, createdAt: now, updatedAt: now },
  ]);
}

export function updateNote(
  entryId: string,
  noteId: string,
  text: string,
): void {
  const t = text.trim();
  if (!t) return;
  patchNotes(entryId, (notes) =>
    notes.map((n) =>
      n.id === noteId ? { ...n, text: t, updatedAt: nowTs() } : n,
    ),
  );
}

export function deleteNote(entryId: string, noteId: string): void {
  patchNotes(entryId, (notes) => notes.filter((n) => n.id !== noteId));
}

/* ── Images ────────────────────────────────────────────────────────────── */

export async function attachImage(
  entryId: string,
  blob: Blob,
  ext: string,
): Promise<NotebookImage | null> {
  const idx = state.entries.findIndex((e) => e.id === entryId);
  if (idx === -1) return null;
  await ensureImagesDir();
  const sid = getManifest().activeId;
  const id = newId();
  const cleanExt =
    (ext || "png").replace(/^\./, "").toLowerCase().slice(0, 5) || "png";
  const path = `sessions/${sid}/images/${id}.${cleanExt}`;
  const buf = new Uint8Array(await blob.arrayBuffer());
  await writeFile(path, buf, { baseDir: DIR });
  const image: NotebookImage = { id, path, addedAt: nowTs() };
  const entries = state.entries.slice();
  entries[idx] = {
    ...entries[idx],
    images: [...entries[idx].images, image],
    updatedAt: nowTs(),
  } as NotebookEntry;
  state = { ...state, entries };
  bumpAndScheduleSave();
  return image;
}

export async function detachImage(
  entryId: string,
  imageId: string,
): Promise<void> {
  const idx = state.entries.findIndex((e) => e.id === entryId);
  if (idx === -1) return;
  const entry = state.entries[idx];
  const img = entry.images.find((i) => i.id === imageId);
  if (!img) return;
  try {
    await remove(img.path, { baseDir: DIR });
  } catch {
    // best-effort
  }
  const entries = state.entries.slice();
  entries[idx] = {
    ...entry,
    images: entry.images.filter((i) => i.id !== imageId),
    updatedAt: nowTs(),
  } as NotebookEntry;
  state = { ...state, entries };
  bumpAndScheduleSave();
}

function mimeForExt(ext: string): string {
  const e = ext.replace(/^\./, "").toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "gif") return "image/gif";
  if (e === "webp") return "image/webp";
  if (e === "bmp") return "image/bmp";
  return "image/png";
}

export async function readImageBytes(
  image: NotebookImage,
): Promise<Uint8Array> {
  return await readFile(image.path, { baseDir: DIR });
}

export async function readImageAsObjectURL(
  image: NotebookImage,
): Promise<string> {
  const bytes = await readImageBytes(image);
  const ext = image.path.split(".").pop() ?? "png";
  // Use a fresh ArrayBuffer copy to avoid SharedArrayBuffer typing issues.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return URL.createObjectURL(new Blob([ab], { type: mimeForExt(ext) }));
}

function uint8ToBase64(bytes: Uint8Array): string {
  // Chunked to avoid call-stack blowup for large images.
  const chunk = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    s += String.fromCharCode.apply(null, Array.from(slice) as number[]);
  }
  return btoa(s);
}

export function displayNameFor(entry: NotebookEntry): string {
  if (entry.kind === "person") {
    const fam = entry.family.trim();
    const giv = entry.given.trim();
    if (fam && giv) return `${fam} ${giv}`;
    return fam || giv || "(unnamed)";
  }
  return entry.name.trim() || "(unnamed)";
}

export function displayReadingFor(entry: NotebookEntry): string | undefined {
  if (entry.kind === "person") {
    const f = (entry.familyReading ?? "").trim();
    const g = (entry.givenReading ?? "").trim();
    if (f && g) return `${f} ${g}`;
    return f || g || undefined;
  }
  return entry.reading?.trim() || undefined;
}

/** Serialize an entry into a self-contained snapshot suitable for sending
 *  through a Tauri event (popover window cross-process). */
export async function serializeEntryForPopover(
  entry: NotebookEntry,
): Promise<SerializedNotebookEntry> {
  let imageDataUrl: string | null = null;
  const first = entry.images[0];
  if (first) {
    try {
      const bytes = await readImageBytes(first);
      const ext = first.path.split(".").pop() ?? "png";
      imageDataUrl = `data:${mimeForExt(ext)};base64,${uint8ToBase64(bytes)}`;
    } catch (err) {
      console.warn("serializeEntryForPopover image read failed", err);
    }
  }
  return {
    id: entry.id,
    kind: entry.kind,
    displayName: displayNameFor(entry),
    reading: displayReadingFor(entry),
    description: entry.description,
    aliases: entry.aliases ?? [],
    notes: (entry.notes ?? []).map((n) => n.text),
    imageDataUrl,
  };
}

/* ── Mentions (lazy backref) ───────────────────────────────────────────── */

export function computeMentions(entryId: string, lines: Line[]): number[] {
  const entry = getEntry(entryId);
  if (!entry || !entry.matchEnabled) return [];
  const patterns = buildPatternsFor(entry).map((p) => p.text);
  if (patterns.length === 0) return [];
  const out: number[] = [];
  for (const line of lines) {
    for (const p of patterns) {
      if (line.text.includes(p)) {
        out.push(line.id);
        break;
      }
    }
  }
  return out;
}
