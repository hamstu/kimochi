/* ankiCards.ts — the Anki tab's model: the cards made in a session, as native records them
   (src-tauri/src/anki_cards.rs, `anki_cards_list` and `anki-cards:changed`). No React and no
   Tauri, so scripts/anki-cards.test.mjs can pin it. */

/** What Kimochi added to a card after it was made. */
export type AnkiEnhancement = "sentenceAudio" | "wordAudio";

/** One card made in a session: a reference to the Anki note, and what the tab shows of it. */
export interface AnkiCardRecord {
  noteId: number;
  term: string;
  reading?: string;
  deck?: string;
  /** Unix ms. */
  addedAt: number;
  /** `kimochi`: Kimochi's own pop-up; `extension`: a dictionary extension through the relay. */
  via: "kimochi" | "extension";
  /** `yomitan-api`, `yomitan`, `hachidori`, … */
  engine: string;
  enhanced: AnkiEnhancement[];
  /** Deleted from the tab: kept so Sync carries the deletion, never listed. */
  deleted?: boolean;
  updatedAt: number;
}

/** The `anki-cards:changed` payload. */
export interface AnkiCardsChanged {
  sessionId: string;
  card: AnkiCardRecord;
}

const ENHANCEMENT_LABELS: Record<AnkiEnhancement, string> = {
  sentenceAudio: "Sentence audio",
  wordAudio: "word audio",
};

/** "Sentence audio added by Kimochi", "Sentence audio and word audio added by Kimochi". */
export function enhancementLabel(enhanced: readonly string[]): string | null {
  const known = (["sentenceAudio", "wordAudio"] as const).filter((kind) =>
    enhanced.includes(kind),
  );
  if (known.length === 0) return null;
  const words = known.map((kind) => ENHANCEMENT_LABELS[kind]);
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return `${words.join(" and ")} added by Kimochi`;
}

/** Newest first; a card already there (by note id) is replaced, and a deleted one removed. */
export function upsertCard(
  cards: readonly AnkiCardRecord[],
  card: AnkiCardRecord,
): AnkiCardRecord[] {
  const rest = cards.filter((c) => c.noteId !== card.noteId);
  return card.deleted ? rest : sortNewestFirst([...rest, card]);
}

export function sortNewestFirst(
  cards: readonly AnkiCardRecord[],
): AnkiCardRecord[] {
  return [...cards].sort((a, b) => b.addedAt - a.addedAt);
}

/** Whether `card` matches the search: its term, reading or deck, any case, spaces ignored. */
export function cardMatches(card: AnkiCardRecord, query: string): boolean {
  const needle = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!needle) return true;
  return [card.term, card.reading ?? "", card.deck ?? ""].some((text) =>
    text.toLowerCase().replace(/\s+/g, "").includes(needle),
  );
}

export interface AnkiCardStats {
  total: number;
  /** Added since local midnight. */
  today: number;
  /** Given audio by Kimochi. */
  enhanced: number;
}

export function cardStats(
  cards: readonly AnkiCardRecord[],
  now: number = Date.now(),
): AnkiCardStats {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime();
  return {
    total: cards.length,
    today: cards.filter((c) => c.addedAt >= start && c.addedAt <= now).length,
    enhanced: cards.filter((c) => c.enhanced.length > 0).length,
  };
}

/** The Anki browser's search for the card. */
export const browseQuery = (card: Pick<AnkiCardRecord, "noteId">): string =>
  `nid:${card.noteId}`;

/** A record as native sent it, made safe to show (older or synced files may lack fields). */
export function normalizeCard(raw: unknown): AnkiCardRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.noteId !== "number") return null;
  const enhanced = Array.isArray(r.enhanced)
    ? r.enhanced.filter(
        (k): k is AnkiEnhancement => k === "sentenceAudio" || k === "wordAudio",
      )
    : [];
  return {
    noteId: r.noteId,
    term: typeof r.term === "string" ? r.term : "",
    reading: typeof r.reading === "string" && r.reading ? r.reading : undefined,
    deck: typeof r.deck === "string" && r.deck ? r.deck : undefined,
    addedAt: typeof r.addedAt === "number" ? r.addedAt : 0,
    via: r.via === "extension" ? "extension" : "kimochi",
    engine: typeof r.engine === "string" ? r.engine : "",
    enhanced,
    ...(r.deleted === true ? { deleted: true } : {}),
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}
