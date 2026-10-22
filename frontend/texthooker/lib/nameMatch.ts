import type { Line, NotebookEntry, NotebookFile } from "./types";

export interface Pattern {
  entryId: string;
  text: string;
  /** Higher = preferred when multiple equal-length patterns match. */
  priority: number;
}

export interface Match {
  entryId: string;
  /** UTF-16 code-unit offsets into line.text. */
  start: number;
  end: number;
}

export interface Matcher {
  version: number;
  patterns: Pattern[];
  find(text: string): Match[];
}

const EMPTY_MATCHER: Matcher = {
  version: -1,
  patterns: [],
  find: () => [],
};

export function buildPatternsFor(entry: NotebookEntry): Pattern[] {
  const out: Pattern[] = [];
  if (entry.matchEnabled === false) return out;

  const push = (text: string | undefined, priority: number) => {
    if (!text) return;
    const t = text.trim();
    if (!t) return;
    out.push({ entryId: entry.id, text: t, priority });
  };

  if (entry.kind === "person") {
    const fam = entry.family.trim();
    const giv = entry.given.trim();
    if (fam && giv) {
      push(fam + giv, 100);
      push(fam + " " + giv, 100);
      push(fam + "　" + giv, 100);
    }
    if (fam) push(fam, 60);
    if (giv && entry.matchGivenAlone) push(giv, 40);
    for (const a of entry.aliases ?? []) push(a, 80);
  } else {
    push(entry.name, 100);
    for (const a of entry.aliases ?? []) push(a, 80);
  }
  return out;
}

function dedupePatterns(patterns: Pattern[]): Pattern[] {
  // If two entries register the same pattern text, the higher-priority (then earlier) wins.
  const byText = new Map<string, Pattern>();
  for (const p of patterns) {
    const existing = byText.get(p.text);
    if (!existing || p.priority > existing.priority) {
      byText.set(p.text, p);
    }
  }
  return Array.from(byText.values());
}

export function buildMatcher(nb: NotebookFile): Matcher {
  const all: Pattern[] = [];
  for (const entry of nb.entries) {
    for (const p of buildPatternsFor(entry)) all.push(p);
  }
  const patterns = dedupePatterns(all).sort(
    (a, b) => b.text.length - a.text.length || b.priority - a.priority,
  );

  if (patterns.length === 0) {
    return { ...EMPTY_MATCHER, version: nb.cacheVersion };
  }

  return {
    version: nb.cacheVersion,
    patterns,
    find(text: string): Match[] {
      const out: Match[] = [];
      let i = 0;
      while (i < text.length) {
        let hit: { p: Pattern; end: number } | null = null;
        for (const p of patterns) {
          if (i + p.text.length > text.length) continue;
          if (text.startsWith(p.text, i)) {
            hit = { p, end: i + p.text.length };
            break; // already longest by sort
          }
        }
        if (hit) {
          out.push({ entryId: hit.p.entryId, start: i, end: hit.end });
          i = hit.end;
        } else {
          i++;
        }
      }
      return out;
    },
  };
}

/* ── Memoization ───────────────────────────────────────────────────────── */

// Keyed by what decides a match, and nothing else. The matcher is the notebook's: `cacheVersion`
// alone cannot tell two notebooks apart, since every session's notebook counts its own (switching
// sessions can land on the same number). Each edit replaces the notebook object, so the object
// together with its version identifies its entries. A line's matches are its text's: line ids
// restart at 1 in each session and after a clear, and a merged reading changes a line's text but
// keeps its id, so a line cache keyed by id hands one line another's offsets.
let cachedNotebook: NotebookFile | null = null;
let cachedNotebookVersion = -1;
let cachedMatcher: Matcher = EMPTY_MATCHER;

const lineCache = new Map<string, Match[]>();
const LINE_CACHE_MAX = 10_000;

export function getMatcher(nb: NotebookFile): Matcher {
  if (cachedNotebook === nb && cachedNotebookVersion === nb.cacheVersion) {
    return cachedMatcher;
  }
  cachedMatcher = buildMatcher(nb);
  cachedNotebook = nb;
  cachedNotebookVersion = nb.cacheVersion;
  // Matches from another matcher are not this one's.
  lineCache.clear();
  return cachedMatcher;
}

export function matchLine(line: Line, matcher: Matcher): Match[] {
  if (matcher.patterns.length === 0) return [];
  // Only the current matcher's results are kept; one passed in from elsewhere is not cached.
  if (matcher !== cachedMatcher) return matcher.find(line.text);
  const key = line.text;
  const cached = lineCache.get(key);
  if (cached) return cached;
  const result = matcher.find(line.text);
  if (lineCache.size >= LINE_CACHE_MAX) {
    // Cheap bounded eviction: drop the oldest insertion-order entry.
    const firstKey = lineCache.keys().next().value;
    if (firstKey !== undefined) lineCache.delete(firstKey);
  }
  lineCache.set(key, result);
  return result;
}
