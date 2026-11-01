import {
  snapshotLines,
  appendLine,
  isDuplicateInRecent,
  lastLineText,
  replaceLastLineText,
} from "./store";
import { getSettings } from "@texthooker/lib/settings";
import { applyReplacements } from "./replacements";
import { recordCharDelta, recordLine } from "./stats";
import { dropsText, japaneseFilterOf } from "@ui/japanese-text";
import { acceptsInput } from "../input-source";
import type { Line, LineSource } from "@texthooker/lib/types";

/** Steps 1–4 below: the text a line would be stored with, or null when nothing is left. */
export function preparedText(text: string): string | null {
  const value = text.replace(/\r\n?/g, "\n").trim();
  if (!value) return null;
  return applyReplacements(value).text.trim() || null;
}

/**
 * Returns a stable ingest function that runs incoming text through the
 * processing pipeline and (optionally) triggers a background tokenize.
 *
 * Pipeline order (matches plan):
 *   1. normalize line endings
 *   2. trim
 *   3. applyReplacements
 *   4. trim again
 *   5. drop if empty
 *   6. drop if "Japanese only" drops it (ui/japanese-text.ts; the overlay applies the same)
 *   7. start-merge if enabled and prefix matches → replace last line
 *   8. drop if duplicate within last N
 *   9. append + stats
 *  10. tokenize with stale-text guard
 */
export const ingestText = async (
  text: string,
  source: LineSource,
  ts?: number,
  ingestId?: string,
  ocr?: Line["ocr"],
) => {
  const settings = getSettings();
  if (!acceptsInput(settings, source)) return;
  if (
    ingestId &&
    snapshotLines().some((line) => line.ingestIds?.includes(ingestId))
  )
    return;

  // 1–5
  const value = preparedText(text);
  if (!value) return;

  // 6 — CJK-only filter
  if (dropsText(value, japaneseFilterOf(settings))) return;

  // 7 — start-merge: streaming-VN-style continuation
  if (!ocr && settings.startMergeEnabled && lastLineText()) {
    const prev = lastLineText() as string;
    const len = Math.max(1, settings.startMergePrefixLen);
    if (value !== prev && value.slice(0, len) === prev.slice(0, len)) {
      const merged = replaceLastLineText(value);
      if (merged && ingestId)
        merged.ingestIds = [...(merged.ingestIds || []), ingestId];
      recordCharDelta(value.length - prev.length);
      return;
    }
  }

  // 8 — dedupe over last N
  if (!ocr && isDuplicateInRecent(value, settings.dedupeDepth)) return;

  // 9 — append + stats
  const line = appendLine({ text: value, source, ts, ocr });
  if (!line) return;
  if (ingestId) line.ingestIds = [ingestId];
  recordLine(value.length);
};
