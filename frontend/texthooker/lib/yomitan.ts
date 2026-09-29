import { invoke } from "@tauri-apps/api/core";
import type {
  AnkiMediaItem,
  Token,
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

/* Tokenize: build linear coverage of input string from dictionary anchors. */

interface YomitanHeadwordSource {
  originalText?: string;
}
interface YomitanHeadword {
  term?: string;
  sources?: YomitanHeadwordSource[];
}
interface YomitanGroupEntry {
  text?: string;
  reading?: string;
  headwords?: YomitanHeadword[][];
}
interface YomitanTokenizeChunk {
  content?: Array<Array<YomitanGroupEntry>>;
}

/**
 * Yomitan's scanning-parser anchors at the kanji where it found a dictionary match,
 * but the real matched span (e.g. an inflected form like 書き込み) is buried in
 * headwords[*][*].sources[0].originalText. We greedy-pick the longest originalText
 * that actually starts with the anchor `text` so we colour the whole inflected word
 * as one clickable token.
 */
function widenAnchor(entry: YomitanGroupEntry): {
  text: string;
  base: string;
  reading: string;
} {
  const baseText = entry.text ?? "";
  const baseReading = entry.reading ?? "";
  if (!baseText)
    return { text: baseText, base: baseText, reading: baseReading };

  let widest = baseText;
  const hwGroups = entry.headwords;
  if (Array.isArray(hwGroups)) {
    for (const group of hwGroups) {
      if (!Array.isArray(group)) continue;
      for (const hw of group) {
        // Only originalText is a literal span of the input; hw.term is the
        // dictionary form, which may not appear in the text at all (覚えろ has
        // term 覚える — same length, different final kana — and widening to it
        // made the anchor unfindable, dropping the token entirely).
        const candidates: string[] = [];
        if (Array.isArray(hw?.sources)) {
          for (const s of hw.sources) {
            if (s?.originalText) candidates.push(s.originalText);
          }
        }
        for (const c of candidates) {
          if (c.length > widest.length && c.startsWith(baseText)) {
            widest = c;
          }
        }
      }
    }
  }

  return { text: widest, base: baseText, reading: baseReading };
}

/* Scan-mode cache: maps the cursor-anchored window text → the matched term at the
   start of that window (or '' if no match). Session-only. */
const scanCache = new Map<string, string>();

/* In-flight scan requests, keyed like scanCache. Concurrent lookups for the
   same window share one request instead of each hitting the API. */
const scanInflight = new Map<string, Promise<string | null>>();

export function clearScanCache() {
  scanCache.clear();
}

/**
 * Look at a short window of text starting at the cursor and return the longest
 * dictionary term that begins there, or null if Yomitan didn't anchor at offset 0.
 * Used by scan mode (shift+hover).
 */
export function scanFromWindow(
  baseUrl: string,
  windowText: string,
): Promise<string | null> {
  if (!windowText) return Promise.resolve(null);
  const cacheKey = `${baseUrl}::${windowText}`;
  const cached = scanCache.get(cacheKey);
  if (cached !== undefined) return Promise.resolve(cached || null);

  const inflight = scanInflight.get(cacheKey);
  if (inflight) return inflight;

  const p = scanRequest(baseUrl, windowText, cacheKey).finally(() => {
    scanInflight.delete(cacheKey);
  });
  scanInflight.set(cacheKey, p);
  return p;
}

async function scanRequest(
  baseUrl: string,
  windowText: string,
  cacheKey: string,
): Promise<string | null> {
  let raw: unknown;
  try {
    raw = await invoke<unknown>("yomitan_tokenize", {
      baseUrl,
      body: { text: windowText, scan_length: Math.min(16, windowText.length) },
    });
  } catch (err) {
    console.warn("yomitan_tokenize (scan) failed", err);
    setStatus("err");
    return null;
  }
  setStatus("ok");

  const chunks = Array.isArray(raw) ? (raw as YomitanTokenizeChunk[]) : [];

  // Find the first anchor whose base text is at the very start of the window.
  for (const chunk of chunks) {
    const groups = Array.isArray(chunk.content) ? chunk.content : [];
    for (const group of groups) {
      if (Array.isArray(group) && group.length && group[0]?.text) {
        const widened = widenAnchor(group[0]);
        if (windowText.startsWith(widened.text)) {
          scanCache.set(cacheKey, widened.text);
          return widened.text;
        }
        if (widened.base && windowText.startsWith(widened.base)) {
          // Widened span isn't literal window text (defensive) — the base
          // anchor still marks a real dictionary match at the cursor.
          scanCache.set(cacheKey, widened.base);
          return widened.base;
        }
        // No match at offset 0 — Yomitan returns anchors in order, so once
        // the first anchor isn't at the start we give up (the character under
        // cursor isn't the start of any dictionary word).
        scanCache.set(cacheKey, "");
        return null;
      }
    }
  }

  scanCache.set(cacheKey, "");
  return null;
}

export async function tokenize(
  baseUrl: string,
  text: string,
): Promise<Token[] | null> {
  if (!text.trim()) return [];
  let raw: unknown;
  try {
    raw = await invoke<unknown>("yomitan_tokenize", {
      baseUrl,
      body: { text, scan_length: 10 },
    });
  } catch (err) {
    console.warn("yomitan_tokenize failed", err);
    setStatus("err");
    return null;
  }

  setStatus("ok");

  // The local host returns an array of chunks.
  const chunks = Array.isArray(raw) ? (raw as YomitanTokenizeChunk[]) : [];

  const anchors: { text: string; base: string; reading: string }[] = [];
  for (const chunk of chunks) {
    const groups = Array.isArray(chunk.content) ? chunk.content : [];
    for (const group of groups) {
      if (Array.isArray(group) && group.length && group[0]?.text) {
        anchors.push(widenAnchor(group[0]));
      }
    }
  }

  // Walk the input, attaching anchors in order; emit non-anchored runs as plain.
  // If a widened anchor would overlap the next anchor's start, fall back to the
  // anchor's base text so we don't eat a downstream token.
  const tokens: Token[] = [];
  let cursor = 0;
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    let anchorText = anchor.text;
    let found = text.indexOf(anchorText, cursor);
    if (found === -1 && anchor.base && anchor.base !== anchorText) {
      // The widened span isn't literal text (shouldn't happen now that we only
      // widen via originalText, but stay defensive) — fall back to the base
      // anchor so the word stays clickable instead of silently going grey.
      anchorText = anchor.base;
      found = text.indexOf(anchorText, cursor);
    }
    if (found === -1) continue;

    // If the next anchor would start before this widened anchor ends, shrink to its
    // base length-1 char (mirrors Yomitan's actual scan anchor) — extremely rare in
    // practice because Yomitan's scanner already doesn't emit overlapping anchors.
    let end = found + anchorText.length;
    if (i + 1 < anchors.length) {
      const nextStart = text.indexOf(anchors[i + 1].text, end);
      if (nextStart !== -1 && nextStart < end) {
        // Conflict — fall back to the shortest safe extent: the original 1-char anchor.
        end = found + 1;
      }
    }

    if (found > cursor) {
      tokens.push({
        text: text.slice(cursor, found),
        reading: "",
        clickable: false,
      });
    }
    tokens.push({
      text: text.slice(found, end),
      reading: anchor.reading,
      clickable: true,
    });
    cursor = end;
  }

  if (cursor < text.length) {
    tokens.push({ text: text.slice(cursor), reading: "", clickable: false });
  }

  return tokens;
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
): Promise<YomitanAllEntriesResult> {
  const key = `${baseUrl}::${term}::${includeMedia ? "m" : "x"}`;
  const cached = allEntriesCache.get(key);
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
