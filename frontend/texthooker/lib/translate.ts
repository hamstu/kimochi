import { getActiveSession } from "./sessions";
/* DeepL translation for lines. The HTTP call happens Rust-side
   (src-tauri/src/translate.rs); the key comes from settings at call time. */

import { invoke } from "@tauri-apps/api/core";
import { getSettings } from "./settings";
import { setLineTranslation, setLineTranslationVisible } from "./store";
import type { Line } from "./types";

/* Transient per-line translate status (NOT persisted — lives only for the
   session). Drives the inline "translating…" state in LineRow so both the
   T hotkey and the context menu give immediate feedback. */

export type TranslateStatus =
  { state: "loading" } | { state: "error"; message: string };

const statuses = new Map<number, TranslateStatus>();
const errorTimers = new Map<number, ReturnType<typeof setTimeout>>();
const subs = new Set<() => void>();

const ERROR_AUTOCLEAR_MS = 5000;

function notify() {
  for (const fn of subs) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}

function setStatus(id: number, status: TranslateStatus | null) {
  const timer = errorTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    errorTimers.delete(id);
  }
  if (status === null) {
    if (!statuses.delete(id)) return;
  } else {
    statuses.set(id, status);
    if (status.state === "error") {
      errorTimers.set(
        id,
        setTimeout(() => {
          errorTimers.delete(id);
          if (statuses.get(id)?.state === "error") {
            statuses.delete(id);
            notify();
          }
        }, ERROR_AUTOCLEAR_MS),
      );
    }
  }
  notify();
}

/** For useSyncExternalStore. The returned object is referentially stable
    until the status actually changes. */
export function getTranslateStatus(id: number): TranslateStatus | null {
  return statuses.get(id) ?? null;
}

export function subscribeTranslateStatus(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** Switch a line to its English translation, hitting DeepL only on the first
    request — afterwards the cached copy on the Line is reused. Never rejects:
    failures surface as a transient inline error status on the line. */
export async function showTranslation(line: Line): Promise<void> {
  if (line.translation) {
    setLineTranslationVisible(line.id, true);
    return;
  }
  if (statuses.get(line.id)?.state === "loading") return; // already in flight
  setStatus(line.id, { state: "loading" });
  try {
    const apiKey = getSettings().deeplApiKey.trim();
    if (!apiKey) throw new Error("DeepL API key is not set");
    const sessionId = getActiveSession().id;
    const translated = await invoke<string>("deepl_translate", {
      text: line.text,
      apiKey,
    });
    setStatus(line.id, null);
    if (getActiveSession().id === sessionId)
      await setLineTranslation(line.id, translated, true);
  } catch (err) {
    console.warn("translate failed", err);
    const message = err instanceof Error ? err.message : String(err);
    setStatus(line.id, { state: "error", message });
  }
}

/** Swap a translated row back to the original Japanese rendering. */
export function showOriginal(lineId: number): void {
  setLineTranslationVisible(lineId, false);
}

/** Hotkey entry point: T on a hovered line. Translated → back to original;
    otherwise translate (or just re-show the cached translation). */
export function toggleTranslation(line: Line): void {
  if (line.showTranslation && line.translation) {
    showOriginal(line.id);
  } else {
    void showTranslation(line);
  }
}
