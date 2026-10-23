import { invoke } from "@tauri-apps/api/core";
import type {
  AnkiMediaItem,
  YomitanAllEntriesResult,
  YomitanAnkiFieldsResponse,
  YomitanStatus,
  YomitanTermResult,
} from "./types";

/* Status pub/sub. */

type StatusSub = (s: YomitanStatus) => void;
const statusSubs = new Set<StatusSub>();
let currentStatus: YomitanStatus = "unknown";

function setStatus(next: YomitanStatus) {
  if (next === currentStatus) return;
  currentStatus = next;
  for (const fn of statusSubs) {
    try {
      fn(next);
    } catch (e) {
      console.error(e);
    }
  }
}

export function onYomitanStatus(fn: StatusSub): () => void {
  statusSubs.add(fn);
  fn(currentStatus);
  return () => {
    statusSubs.delete(fn);
  };
}

export function getYomitanStatus(): YomitanStatus {
  return currentStatus;
}

/* In-memory term cache (key: `${baseUrl}::${term}`). */
const termCache = new Map<string, YomitanTermResult>();

export function clearYomitanCache() {
  termCache.clear();
  allEntriesCache.clear();
}


/* termEntries via /ankiFields. */

// /ankiFields returns media items as { ankiFilename, content } (raw base64).
// Normalize to our { ankiFilename, contentBase64 } shape so the popover path
// matches the Rust-emitted MediaItem shape used in ShowPayload::Loaded.
function normalizeMedia(raw: unknown): AnkiMediaItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const o = item as Record<string, unknown>;
      const filename =
        typeof o.ankiFilename === "string" ? o.ankiFilename : null;
      const content =
        typeof o.contentBase64 === "string"
          ? o.contentBase64
          : typeof o.content === "string"
            ? o.content
            : null;
      if (!filename || !content) return null;
      return { ankiFilename: filename, contentBase64: content };
    })
    .filter((x): x is AnkiMediaItem => x !== null);
}

export async function termEntries(
  baseUrl: string,
  term: string,
  includeMedia = false,
): Promise<YomitanTermResult> {
  const key = `${baseUrl}::${term}::${includeMedia ? "m" : "x"}`;
  const cached = termCache.get(key);
  if (cached) return cached;

  let raw: unknown;
  try {
    raw = await invoke<unknown>("yomitan_ankifields", {
      baseUrl,
      text: term,
      includeMedia,
    });
  } catch (err) {
    console.warn("yomitan_ankifields failed", err);
    setStatus("err");
    // Deliberately NOT cached — a transient failure shouldn't pin this term
    // to an empty result for the rest of the session.
    return {
      fields: null,
      audioMedia: [],
      dictionaryMedia: [],
    };
  }
  setStatus("ok");

  const resp = raw as YomitanAnkiFieldsResponse;
  const first =
    Array.isArray(resp?.fields) && resp.fields.length > 0
      ? resp.fields[0]
      : null;
  const result: YomitanTermResult = {
    fields: first,
    audioMedia: normalizeMedia(resp?.audioMedia),
    dictionaryMedia: normalizeMedia(resp?.dictionaryMedia),
  };
  termCache.set(key, result);
  return result;
}

/* All-entries cache (key includes media flag), keeping every matched entry. */
const allEntriesCache = new Map<string, YomitanAllEntriesResult>();

/**
 * Like termEntries but returns every matched entry (longest match first), the
 * same shape the popover renders. Used when following a glossary
 * cross-reference link so the swapped-in content shows all senses.
 */
export async function termAllEntries(
  baseUrl: string,
  term: string,
  includeMedia = false,
  /** Only the first entries: with media, Yomitan fetches each returned entry's audio in turn. */
  maxEntries?: number,
): Promise<YomitanAllEntriesResult> {
  const key = `${baseUrl}::${term}::${includeMedia ? "m" : "x"}::${maxEntries ?? "all"}`;
  const cached = allEntriesCache.get(key);
  if (cached) return cached;

  let raw: unknown;
  try {
    raw = await invoke<unknown>("yomitan_ankifields", {
      baseUrl,
      text: term,
      includeMedia,
      maxEntries: maxEntries ?? null,
    });
  } catch (err) {
    console.warn("yomitan_ankifields failed", err);
    setStatus("err");
    return { entries: [], audioMedia: [], dictionaryMedia: [] };
  }
  setStatus("ok");

  const resp = raw as YomitanAnkiFieldsResponse;
  const result: YomitanAllEntriesResult = {
    entries: Array.isArray(resp?.fields) ? resp.fields : [],
    audioMedia: normalizeMedia(resp?.audioMedia),
    dictionaryMedia: normalizeMedia(resp?.dictionaryMedia),
  };
  allEntriesCache.set(key, result);
  return result;
}

/** Quick test for the settings panel — returns latency in ms or an error string. */
export async function probe(
  baseUrl: string,
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  try {
    const ms = await invoke<number>("yomitan_probe", { baseUrl });
    setStatus("ok");
    return { ok: true, latencyMs: ms };
  } catch (err) {
    setStatus("err");
    return { ok: false, error: String(err) };
  }
}
