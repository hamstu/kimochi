/* audio.ts — turn base64 audio bytes from Yomitan's /ankiFields into playable
   blob URLs, with a small in-memory LRU so re-hovering a recent term replays
   instantly. URLs are revoked on eviction + on app shutdown. */

import type { AnkiMediaItem, YomitanAnkiFields } from "./types";

const CACHE_LIMIT = 20;

interface CacheEntry {
  url: string;
  filename: string;
}

const cache = new Map<string, CacheEntry>();

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function mimeForFilename(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
  if (lower.endsWith(".opus")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a") || lower.endsWith(".aac")) return "audio/aac";
  return "audio/mpeg";
}

function buildBlobUrl(item: AnkiMediaItem): string {
  const bytes = base64ToBytes(item.contentBase64);
  const blob = new Blob([new Uint8Array(bytes)], {
    type: mimeForFilename(item.ankiFilename),
  });
  return URL.createObjectURL(blob);
}

/**
 * Get a blob URL for one media item, keyed by its ankiFilename (a content
 * hash), so re-hovering replays without re-decoding. One looked-up term can
 * carry several audio files now — one per matched entry.
 */
export function getOrCacheAudio(item: AnkiMediaItem): string {
  const existing = cache.get(item.ankiFilename);
  if (existing) {
    // Refresh LRU order.
    cache.delete(item.ankiFilename);
    cache.set(item.ankiFilename, existing);
    return existing.url;
  }
  const url = buildBlobUrl(item);
  cache.set(item.ankiFilename, { url, filename: item.ankiFilename });
  while (cache.size > CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cache.get(oldestKey);
    if (oldest) URL.revokeObjectURL(oldest.url);
    cache.delete(oldestKey);
  }
  return url;
}

/**
 * The audio media item a single /ankiFields entry refers to, or null. The
 * entry's `audio` marker renders as "[sound:yomitan_audio_<hash>.mp3]"; the
 * bundled audioMedia array holds the bytes for every entry of the lookup.
 */
export function audioItemForEntry(
  fields: YomitanAnkiFields,
  audioMedia: AnkiMediaItem[],
): AnkiMediaItem | null {
  const m = /\[sound:([^\]]+)\]/.exec(fields.audio ?? "");
  if (!m) return null;
  return audioMedia.find((item) => item.ankiFilename === m[1]) ?? null;
}

/**
 * Subset of `media` actually referenced by this entry's field values (audio
 * [sound:] tags, glossary <img> srcs). Lets an Anki add for entry N store only
 * entry N's files instead of every sibling entry's.
 */
export function mediaForFields(
  fields: YomitanAnkiFields,
  media: AnkiMediaItem[],
): AnkiMediaItem[] {
  const values = Object.values(fields).filter(
    (v): v is string => typeof v === "string",
  );
  return media.filter((item) =>
    values.some((v) => v.includes(item.ankiFilename)),
  );
}

export function clearAudioCache() {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
  cache.clear();
}

/** Fire-and-forget audio playback. Swallows autoplay-policy rejections. */
export async function playAudio(url: string, volume: number): Promise<void> {
  try {
    const a = new Audio(url);
    a.volume = Math.max(0, Math.min(1, volume));
    await a.play();
  } catch (err) {
    console.warn("audio play failed", err);
  }
}
