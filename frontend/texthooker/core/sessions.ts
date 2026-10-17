import { writeTextFile } from "./files";
import { inProfile, writesPaused } from "./profile";
import { invoke } from "@tauri-apps/api/core";
import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  remove,
  rename,
} from "@tauri-apps/plugin-fs";
import {
  defaultSessionName,
  NOTEBOOK_EMPTY,
  type NotebookFile,
  type SessionMeta,
  type SessionsManifest,
} from "../lib/types";
import {
  flushLines as flushLinesInStore,
  onActiveSessionChanged as onStoreSessionChanged,
} from "./store";
import {
  flushNotebook,
  onActiveSessionChanged as onNotebookSessionChanged,
} from "./notebook";

const DIR = BaseDirectory.AppLocalData;
const MANIFEST_FILE = "sessions.json";
const LEGACY_LINES_FILE = "lines.json";
const LEGACY_BACKUP_FILE = "lines.json.bak";
const DEBOUNCE_MS = 200;

type Sub = (m: SessionsManifest) => void;

let manifest: SessionsManifest | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
const subs = new Set<Sub>();

function emit() {
  if (!manifest) return;
  const snapshot = cloneManifest(manifest);
  for (const fn of subs) {
    try {
      fn(snapshot);
    } catch (err) {
      console.error(err);
    }
  }
}

function cloneManifest(m: SessionsManifest): SessionsManifest {
  return { ...m, sessions: m.sessions.map((s) => ({ ...s })) };
}

function newId(): string {
  return crypto.randomUUID();
}

function sessionLinesPath(sid: string): string {
  return inProfile(`sessions/${sid}/lines.json`);
}

function sessionNotebookPath(sid: string): string {
  return inProfile(`sessions/${sid}/notebook.json`);
}

async function ensureSessionDirs(sid: string) {
  await mkdir(inProfile(`sessions/${sid}/images`), { baseDir: DIR, recursive: true });
}

async function writeEmptyLines(sid: string) {
  await writeTextFile(
    sessionLinesPath(sid),
    JSON.stringify({ version: 1, lines: [] }),
    { baseDir: DIR },
  );
}

async function writeEmptyNotebook(sid: string) {
  const body: NotebookFile = { ...NOTEBOOK_EMPTY };
  await writeTextFile(sessionNotebookPath(sid), JSON.stringify(body), {
    baseDir: DIR,
  });
}

async function persistNow(throwOnError = true) {
  if (!manifest) return;
  if (writesPaused()) {
    // Sync is merging into the files; the manifest is reloaded afterwards.
    dirty = true;
    return;
  }
  dirty = false;
  try {
    await writeTextFile(inProfile(MANIFEST_FILE), JSON.stringify(manifest), {
      baseDir: DIR,
    });
  } catch (err) {
    console.error("persist sessions.json failed", err);
    dirty = true;
    if (throwOnError) throw err;
  }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (dirty) void persistNow();
  }, DEBOUNCE_MS);
}

export async function migrateIfNeeded(): Promise<void> {
  try {
    if (!(await exists(inProfile(""), { baseDir: DIR }))) {
      await mkdir(inProfile(""), { baseDir: DIR, recursive: true });
    }
  } catch {
    // best-effort
  }

  if (await exists(inProfile(MANIFEST_FILE), { baseDir: DIR })) return;

  const now = Date.now();
  const sid = newId();
  await ensureSessionDirs(sid);

  // Archive any existing top-level lines.json — per plan, "Archive and start fresh".
  if (await exists(inProfile(LEGACY_LINES_FILE), { baseDir: DIR })) {
    try {
      // If a prior backup exists, leave it alone and just remove the current file by overwriting nothing.
      // plugin-fs rename overwrites a non-directory target.
      await rename(inProfile(LEGACY_LINES_FILE), inProfile(LEGACY_BACKUP_FILE), {
        oldPathBaseDir: DIR,
        newPathBaseDir: DIR,
      });
    } catch (err) {
      console.warn("migrate: rename legacy lines.json failed", err);
    }
  }

  await writeEmptyLines(sid);
  await writeEmptyNotebook(sid);

  const first: SessionMeta = {
    id: sid,
    name: defaultSessionName(now),
    description: "",
    createdAt: now,
    updatedAt: now,
  };
  manifest = { version: 1, activeId: sid, sessions: [first] };
  await persistNow();
}

export async function loadSessions(): Promise<SessionsManifest> {
  if (!(await exists(inProfile(MANIFEST_FILE), { baseDir: DIR }))) {
    // Defensive — migrateIfNeeded should have already run.
    await migrateIfNeeded();
  }
  try {
    const raw = await readTextFile(inProfile(MANIFEST_FILE), { baseDir: DIR });
    const parsed = JSON.parse(raw) as SessionsManifest;
    if (
      parsed &&
      parsed.version === 1 &&
      Array.isArray(parsed.sessions) &&
      parsed.sessions.length > 0 &&
      typeof parsed.activeId === "string"
    ) {
      // Repair an active id that no longer references a known session.
      if (!parsed.sessions.some((s) => s.id === parsed.activeId)) {
        parsed.activeId = parsed.sessions[0].id;
      }
      manifest = parsed;
    } else {
      throw new Error(
        "Invalid sessions.json; existing session data has been left untouched",
      );
    }
  } catch (err) {
    console.warn("loadSessions failed", err);
    throw err;
  }
  if (!manifest) {
    // Last-resort: synthesize a single session.
    const now = Date.now();
    const sid = newId();
    await ensureSessionDirs(sid);
    await writeEmptyLines(sid);
    await writeEmptyNotebook(sid);
    manifest = {
      version: 1,
      activeId: sid,
      sessions: [
        {
          id: sid,
          name: defaultSessionName(now),
          description: "",
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    await persistNow();
  }
  emit();
  return cloneManifest(manifest);
}

export function getManifest(): SessionsManifest {
  if (!manifest) {
    throw new Error("sessions manifest not loaded — call loadSessions() first");
  }
  return manifest;
}

export function getActiveSession(): SessionMeta {
  const m = getManifest();
  const s = m.sessions.find((x) => x.id === m.activeId);
  if (!s) throw new Error("active session not found");
  return s;
}

export function listSessions(): SessionMeta[] {
  return getManifest().sessions.slice();
}

export function currentLinesPath(): string {
  return sessionLinesPath(getManifest().activeId);
}

export function currentNotebookPath(): string {
  return sessionNotebookPath(getManifest().activeId);
}

export function currentImagesDir(): string {
  return inProfile(`sessions/${getManifest().activeId}/images`);
}

export async function createSession(name?: string): Promise<SessionMeta> {
  if (!manifest) throw new Error("sessions not loaded");
  const now = Date.now();
  const sid = newId();
  await ensureSessionDirs(sid);
  await writeEmptyLines(sid);
  await writeEmptyNotebook(sid);
  const session: SessionMeta = {
    id: sid,
    name: name?.trim() || defaultSessionName(now),
    description: "",
    createdAt: now,
    updatedAt: now,
  };
  manifest.sessions.push(session);
  // Switch to the new session immediately.
  await switchSession(sid);
  return session;
}

export async function switchSession(id: string): Promise<SessionMeta> {
  if (!manifest) throw new Error("sessions not loaded");
  const target = manifest.sessions.find((s) => s.id === id);
  if (!target) throw new Error(`unknown session ${id}`);
  if (manifest.activeId === id) {
    emit();
    return { ...target };
  }

  // Defensive: dismiss any open popover so it can't reference an entry from the old session.
  try {
    await invoke("hide_popover");
  } catch {
    // best-effort
  }

  // Flush old session's lines to the OLD path before we swap.
  await flushLinesInStore();

  await flushNotebook();
  manifest.activeId = id;
  await persistNow();

  // Reload store + notebook for the new session.
  await onStoreSessionChanged();
  await onNotebookSessionChanged();
  emit();
  return { ...target };
}

export async function renameSession(id: string, name: string): Promise<void> {
  if (!manifest) throw new Error("sessions not loaded");
  const idx = manifest.sessions.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === manifest.sessions[idx].name) return;
  manifest.sessions[idx] = {
    ...manifest.sessions[idx],
    name: trimmed,
    updatedAt: Date.now(),
  };
  scheduleSave();
  emit();
}

export async function reorderSessions(ids: string[]): Promise<void> {
  if (!manifest) throw new Error("sessions not loaded");
  if (
    ids.length !== manifest.sessions.length ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error("session order must contain every session exactly once");
  }

  const byId = new Map(
    manifest.sessions.map((session) => [session.id, session]),
  );
  const reordered = ids.map((id) => byId.get(id));
  if (!reordered.every((session): session is SessionMeta => Boolean(session))) {
    throw new Error("session order contains an unknown session");
  }
  if (ids.every((id, index) => manifest!.sessions[index].id === id)) return;

  const previous = manifest.sessions;
  manifest.sessions = reordered;
  try {
    await persistNow(true);
  } catch (err) {
    manifest.sessions = previous;
    throw err;
  }
  emit();
}

export async function deleteSession(id: string): Promise<void> {
  if (!manifest) throw new Error("sessions not loaded");
  const index = manifest.sessions.findIndex((session) => session.id === id);
  if (index === -1) throw new Error("session not found");
  if (manifest.sessions.length === 1) {
    throw new Error("the last session cannot be deleted");
  }

  const deletingActiveSession = manifest.activeId === id;
  if (deletingActiveSession) {
    try {
      await invoke("hide_popover");
    } catch {
      // best-effort
    }
    try {
      await flushLinesInStore();
    } catch (err) {
      console.warn("flushLines before delete failed", err);
    }
    try {
      await flushNotebook();
    } catch (err) {
      console.warn("flushNotebook before delete failed", err);
    }
  }

  const previousSessions = manifest.sessions.slice();
  const previousActiveId = manifest.activeId;
  manifest.sessions.splice(index, 1);
  if (deletingActiveSession) {
    // Prefer the session that moved into the deleted row, then the prior row.
    manifest.activeId =
      manifest.sessions[Math.min(index, manifest.sessions.length - 1)].id;
  }
  try {
    await persistNow(true);
  } catch (err) {
    manifest.sessions = previousSessions;
    manifest.activeId = previousActiveId;
    throw err;
  }

  if (deletingActiveSession) {
    await onStoreSessionChanged();
    await onNotebookSessionChanged();
  }
  emit();

  try {
    await remove(inProfile(`sessions/${id}`), { baseDir: DIR, recursive: true });
  } catch (err) {
    // The session is already absent from the manifest. Leaving orphaned data is
    // safer than restoring a session whose files may only be partly removed.
    console.warn(`delete session directory ${id} failed`, err);
  }
}

export async function updateSessionDescription(
  id: string,
  description: string,
): Promise<void> {
  if (!manifest) throw new Error("sessions not loaded");
  const idx = manifest.sessions.findIndex((s) => s.id === id);
  if (idx === -1) return;
  if (manifest.sessions[idx].description === description) return;
  manifest.sessions[idx] = {
    ...manifest.sessions[idx],
    description,
    updatedAt: Date.now(),
  };
  scheduleSave();
  emit();
}

export function subscribeSessions(fn: Sub): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** Write a debounced rename or description now (before Sync holds the files). */
export async function flushSessions(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirty) await persistNow(false);
}

/**
 * Re-read `sessions.json` after Sync merged into it. Returns whether the active session changed
 * (it was deleted on another computer), so the caller reloads its lines and notebook.
 */
export async function reloadSessions(): Promise<boolean> {
  const previous = manifest?.activeId;
  try {
    const raw = await readTextFile(inProfile(MANIFEST_FILE), { baseDir: DIR });
    const parsed = JSON.parse(raw) as SessionsManifest;
    if (!parsed || !Array.isArray(parsed.sessions) || parsed.sessions.length === 0)
      return false;
    if (!parsed.sessions.some((s) => s.id === parsed.activeId))
      parsed.activeId = parsed.sessions[0].id;
    // This window's session stays chosen while it still exists.
    if (previous && parsed.sessions.some((s) => s.id === previous))
      parsed.activeId = previous;
    manifest = { ...parsed, version: 1 };
  } catch (err) {
    console.warn("reloadSessions failed", err);
    return false;
  }
  emit();
  return manifest.activeId !== previous;
}
