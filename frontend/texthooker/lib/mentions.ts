/**
 * @-mentions in a note: finding the "@query" being typed at the caret, and ranking the notebook's
 * entries against it. Pure, so the menu (hooks/useMentions.tsx) stays cheap on every
 * keystroke and this stays testable without a window.
 *
 * A mention inserts the entry's name as plain text (or the alias that was typed toward), which
 * the notebook's matcher then links in the rendered note like it does in any line.
 */
import type { NotebookEntry } from "./types";

export interface MentionQuery {
  /** Where the "@" is. */
  start: number;
  /** The caret: the mention is `text.slice(start, end)`. */
  end: number;
  /** What follows the "@", up to the caret. */
  query: string;
}

/** How far back from the caret an "@" still starts a mention. */
const MAX_QUERY = 32;
/** A Latin letter or digit (or `.` / `_`) just before the "@": an address, not a mention. */
const WORDY = /[A-Za-z0-9._]/;

/**
 * The mention being typed at `caret`, if any: an "@" (or the full-width "＠" a Japanese input
 * method gives) with no whitespace between it and the caret, at the start of the text, after
 * whitespace or punctuation, or after Japanese (which has no spaces).
 */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  for (let i = caret - 1; i >= 0 && caret - i <= MAX_QUERY + 1; i--) {
    const ch = text[i];
    if (ch === "@" || ch === "＠") {
      const before = i > 0 ? text[i - 1] : "";
      if (before && WORDY.test(before)) return null;
      return { start: i, end: caret, query: text.slice(i + 1, caret) };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

/** Case, width and kana folded: half-width ｶﾅ, ＡＢＣ and katakana all compare as their plain forms. */
export function fold(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

const JAPANESE = /[぀-ヿ㐀-鿿豈-﫿]/;

/** The name a mention writes: Japanese names whole (岡部倫太郎), others spaced (Okabe Rintaro). */
export function mentionName(entry: NotebookEntry): string {
  if (entry.kind !== "person") return entry.name.trim();
  const family = entry.family.trim();
  const given = entry.given.trim();
  if (!family || !given) return family || given;
  return JAPANESE.test(family + given) ? family + given : `${family} ${given}`;
}

function readingOf(entry: NotebookEntry): string {
  return entry.kind === "person"
    ? [entry.familyReading?.trim(), entry.givenReading?.trim()].filter(Boolean).join("")
    : (entry.reading?.trim() ?? "");
}

export interface MentionOption {
  entry: NotebookEntry;
  /** What the mention writes: the name, or the alias the query was typed toward. */
  insert: string;
}

/** How well `text` answers `query` (both folded): lower is better, null is no match. */
function score(text: string, query: string): number | null {
  if (!text) return null;
  if (!query) return 3;
  if (text === query) return 0;
  if (text.startsWith(query)) return 1;
  // The start of a later word: "rintaro" in "okabe rintaro".
  if (text.includes(` ${query}`)) return 2;
  if (text.includes(query)) return 3;
  return null;
}

const KIND_RANK = { person: 0, place: 1, thing: 2 } as const;

/**
 * The entries `query` can mention, best first: an exact or leading match on the name, its
 * reading, or an alias beats one in the middle; then characters, places, things; then by name.
 * Entries with no name, or that the Log is told not to link (`matchEnabled` off), are left out:
 * a mention of one would not be linked.
 */
export function rankMentions(
  entries: readonly NotebookEntry[],
  query: string,
  limit = 8,
): MentionOption[] {
  const q = fold(query.trim());
  const ranked: { option: MentionOption; score: number; name: string }[] = [];
  for (const entry of entries) {
    if (entry.matchEnabled === false) continue;
    const name = mentionName(entry);
    if (!name) continue;
    let best: number | null = null;
    let insert = name;
    const consider = (text: string, writes: string) => {
      const s = score(fold(text), q);
      if (s !== null && (best === null || s < best)) {
        best = s;
        insert = writes;
      }
    };
    consider(name, name);
    if (entry.kind === "person") {
      consider(`${entry.family} ${entry.given}`.trim(), name);
      if (entry.given.trim()) consider(entry.given, name);
    }
    consider(readingOf(entry), name);
    for (const alias of entry.aliases ?? []) consider(alias, alias.trim());
    if (best === null) continue;
    ranked.push({ option: { entry, insert }, score: best, name });
  }
  ranked.sort(
    (a, b) =>
      a.score - b.score ||
      KIND_RANK[a.option.entry.kind] - KIND_RANK[b.option.entry.kind] ||
      a.name.localeCompare(b.name, "ja"),
  );
  return ranked.slice(0, limit).map((r) => r.option);
}

/** `text` with the mention replaced by `insert`, and where the caret goes after it. */
export function applyMention(
  text: string,
  mention: MentionQuery,
  insert: string,
): { text: string; caret: number } {
  const next = text.slice(0, mention.start) + insert + text.slice(mention.end);
  return { text: next, caret: mention.start + insert.length };
}
