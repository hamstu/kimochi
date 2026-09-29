/** One session/notebook writer (the always-loaded Log window); settings are clients. */
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  Line,
  SessionsManifest,
  NotebookFile,
  Stats,
  PresetsFile,
  Replacement,
} from "./lib/types";
export interface ReaderSnapshot {
  sessions: SessionsManifest;
  lines: Line[];
  notebook: NotebookFile;
  stats: { stats: Stats; elapsedMs: number };
  running: boolean;
  presets: PresetsFile;
  replacements: Replacement[];
  dirtyPreset: boolean;
}
let snapshot: ReaderSnapshot | null = null;
let receivedAt = 0;
export const snapshotAge = (): number => Math.max(0, Date.now() - receivedAt);
const subs = new Set<(value: ReaderSnapshot) => void>();
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let ready: Promise<void> | null = null;
export const isOwner = (): boolean => getCurrentWindow().label === "log";
export function acceptSnapshot(value: ReaderSnapshot): void {
  snapshot = value;
  receivedAt = Date.now();
  for (const fn of subs) fn(value);
}
export function getSnapshot(): ReaderSnapshot {
  if (!snapshot) throw new Error("Texthooker is still loading");
  return snapshot;
}
export function subscribe(fn: (value: ReaderSnapshot) => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
async function connect(): Promise<void> {
  if (!ready)
    ready = (async () => {
      await listen<ReaderSnapshot>("reader:snapshot", (e) =>
        acceptSnapshot(e.payload),
      );
      await listen<{ id: string; value?: unknown; error?: string }>(
        "reader:response",
        (e) => {
          const item = pending.get(e.payload.id);
          if (!item) return;
          pending.delete(e.payload.id);
          if (e.payload.error) item.reject(new Error(e.payload.error));
          else item.resolve(e.payload.value);
        },
      );
    })();
  return ready;
}
export async function call<T>(
  module: string,
  method: string,
  args: unknown[] = [],
  timeoutMs = 60000,
): Promise<T> {
  await connect();
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error("Texthooker did not respond. Open the Log window and retry."),
      );
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value as T);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    void emit("reader:request", {
      id,
      module,
      method,
      args,
      sessionId: snapshot?.sessions.activeId,
    }).catch((error) => {
      clearTimeout(timeout);
      pending.delete(id);
      reject(error);
    });
  });
}
export async function initializeClient(): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      acceptSnapshot(await call<ReaderSnapshot>("host", "snapshot", [], 2000));
      return;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}
