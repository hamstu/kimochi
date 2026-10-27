/* ankiDetect.ts — Settings → Anki's Detect for the Yomitan API pop-up: the note type and deck
   someone already mines into, read from Anki, and which of its fields take which Yomitan marker.

   The same rules as Hachidori's setup (its anki-setup.js), so both find the same deck:
   - Only the mining note types made for Yomitan qualify: Lapis, Kiku and Senren, by a name that
     starts with the family ("Lapis", "Kiku v2", not "My Kiku"), with the family's core fields.
     Pre-made decks' note types (Kaishi, Tango, …) can hold more notes than someone's own mining,
     so they are never candidates.
   - The candidate with the most notes wins; a tie is left to the person.
   - Its deck is the one holding most of its notes, counted per deck (not with subdecks), leaving
     out filtered decks; again a tie is left to the person.
   Only reads: note types, their fields, decks and note searches. */

import type { AnkiFieldMapping } from "./types";

/** The AnkiConnect reads Detect needs (ankiconnect.ts's wrappers, or a stand-in in tests). */
export interface AnkiReader {
  models(): Promise<string[]>;
  fields(model: string): Promise<string[]>;
  decks(): Promise<string[]>;
  findNotes(query: string): Promise<number[]>;
}

export type DetectedSetup =
  | {
      ok: true;
      modelName: string;
      deckName: string;
      /** Notes of the note type, and how many of them are in the deck. */
      modelNotes: number;
      deckNotes: number;
      fieldMappings: AnkiFieldMapping[];
    }
  | { ok: false; reason: string };

type Family = "lapis" | "kiku" | "senren";

/** The family a note type's name starts with, ending at a word boundary. */
const FAMILY_PATTERN = /^(senren|lapis|kiku)(?![\p{L}\p{N}])/iu;

export function noteFamily(model: string): Family | null {
  const match = FAMILY_PATTERN.exec(model.trim());
  return match ? (match[1].toLowerCase() as Family) : null;
}

/** "(sentence)" is the pop-up's sentence; anything else a Yomitan marker. */
type Source = string;

/** Each family's fields that Kimochi's markers can fill. Kiku is Lapis's successor and shares
    its fields. MainDefinition takes the whole glossary: the Yomitan API has no single-dictionary
    marker, and Lapis shows MainDefinition first. */
const LAPIS: Record<string, Source> = {
  Expression: "expression",
  ExpressionReading: "reading",
  ExpressionAudio: "audio",
  MainDefinition: "glossary",
  Sentence: "(sentence)",
  SentenceFurigana: "sentence-furigana",
  Frequency: "frequencies",
};
const SENREN: Record<string, Source> = {
  word: "expression",
  reading: "reading",
  wordAudio: "audio",
  definition: "glossary",
  sentence: "(sentence)",
  sentenceFurigana: "sentence-furigana",
  pitchAccents: "pitch-accents",
  frequencies: "frequencies",
};
const PRESETS: Record<Family, Record<string, Source>> = { lapis: LAPIS, kiku: LAPIS, senren: SENREN };

/** The fields a note type of the family must have to count as one. */
const CORE: Record<Family, string[]> = {
  lapis: ["Expression", "ExpressionReading", "MainDefinition", "Sentence"],
  kiku: ["Expression", "ExpressionReading", "MainDefinition", "Sentence"],
  senren: ["word", "reading", "definition", "sentence"],
};

/** The family's mappings onto `fields` (Anki compares field names without case), in Anki's
    order, or null when a core field is missing. */
export function familyMappings(family: Family, fields: string[]): AnkiFieldMapping[] | null {
  const byName = new Map(fields.map((f) => [f.toLowerCase(), f]));
  if (!CORE[family].every((f) => byName.has(f.toLowerCase()))) return null;
  const mappings: AnkiFieldMapping[] = [];
  for (const [name, source] of Object.entries(PRESETS[family])) {
    const ankiField = byName.get(name.toLowerCase());
    if (!ankiField) continue;
    mappings.push(
      source === "(sentence)"
        ? { ankiField, mappingType: "sentence" }
        : { ankiField, mappingType: "marker", marker: source },
    );
  }
  return mappings.sort((a, b) => fields.indexOf(a.ankiField) - fields.indexOf(b.ankiField));
}

/** A name for an Anki search term in double quotes: `"` and `\` escaped, and the wildcards `*`
    and `_` taken literally. */
export function searchName(name: string): string {
  return name.replace(/[\\"*_]/g, (c) => `\\${c}`);
}

/** At most `limit` of `items` through `run` at once, in order. */
async function each<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const PARALLEL = 6;

/** The one entry with the highest `count` above zero; `tied` when two share it. */
function uniqueMost<T extends { count: number }>(entries: T[]): { best: T | null; tied: boolean } {
  let best: T | null = null;
  let tied = false;
  for (const e of entries) {
    if (e.count <= 0) continue;
    if (!best || e.count > best.count) {
      best = e;
      tied = false;
    } else if (e.count === best.count) tied = true;
  }
  return { best, tied };
}

const CHOOSE = "Choose the deck and note type below.";

export async function detectAnkiSetup(anki: AnkiReader): Promise<DetectedSetup> {
  const named = (await anki.models()).flatMap((model) => {
    const family = noteFamily(model);
    return family ? [{ model, family }] : [];
  });
  const candidates = (
    await each(named, PARALLEL, async (c) => ({ ...c, fieldMappings: familyMappings(c.family, await anki.fields(c.model)) }))
  ).filter((c): c is typeof c & { fieldMappings: AnkiFieldMapping[] } => c.fieldMappings !== null);
  if (candidates.length === 0) {
    return { ok: false, reason: `No Lapis, Kiku or Senren note type with its usual fields was found. ${CHOOSE}` };
  }

  const counted = await each(candidates, PARALLEL, async (c) => ({
    ...c,
    count: new Set(await anki.findNotes(`"note:${searchName(c.model)}"`)).size,
  }));
  const models = uniqueMost(counted);
  if (!models.best) {
    const names = candidates.map((c) => c.model);
    const which =
      names.length === 1
        ? `Your ${names[0]} note type has`
        : `Your ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} note types have`;
    return { ok: false, reason: `${which} no notes yet. ${CHOOSE}` };
  }
  if (models.tied) return { ok: false, reason: `Two note types have the most notes. ${CHOOSE}` };
  const model = models.best;

  const note = `"note:${searchName(model.model)}"`;
  const decks = await each(await anki.decks(), PARALLEL, async (deck) => {
    const name = searchName(deck);
    const query = `${note} "deck:${name}" -"deck:${name}::*" -deck:filtered`;
    return { deck, count: new Set(await anki.findNotes(query)).size };
  });
  const deck = uniqueMost(decks);
  if (!deck.best) return { ok: false, reason: `${model.model} has no notes outside filtered decks. ${CHOOSE}` };
  if (deck.tied) return { ok: false, reason: `Two decks have the most ${model.model} notes. ${CHOOSE}` };

  return {
    ok: true,
    modelName: model.model,
    deckName: deck.best.deck,
    modelNotes: model.count,
    deckNotes: deck.best.count,
    fieldMappings: model.fieldMappings,
  };
}

/** A sentence audio field's name: Lapis's and Kiku's SentenceAudio, Senren's sentenceAudio, and
    the same words spelled with a space, dash or underscore. */
const SENTENCE_AUDIO = /^sentence[\s_-]?audio$/i;

export type DetectedAudioField =
  | { ok: true; field: string; modelName: string }
  | { ok: false; reason: string };

/** Sentence audio's field, found when it is turned on and when the Anki settings change, for
    every engine: the sentence audio field of the note type someone mines with. `prefer` (the
    Yomitan API's chosen note type) wins when it has one; otherwise, of the note types that have
    one, the one with the most notes wins, and a tie between different field names is left to the
    person. Only reads. */
export async function detectSentenceAudioField(
  anki: Pick<AnkiReader, "models" | "fields" | "findNotes">,
  prefer?: string | null,
): Promise<DetectedAudioField> {
  if (prefer) {
    const field = (await anki.fields(prefer).catch(() => [] as string[])).find((f) => SENTENCE_AUDIO.test(f.trim()));
    if (field) return { ok: true, field, modelName: prefer };
  }
  const withField = (
    await each(await anki.models(), PARALLEL, async (model) => ({
      model,
      field: (await anki.fields(model)).find((f) => SENTENCE_AUDIO.test(f.trim())) ?? null,
    }))
  ).filter((c): c is { model: string; field: string } => c.field !== null);
  if (withField.length === 0) {
    return { ok: false, reason: "None of your note types has a sentence audio field. Type the field's name in Audio field." };
  }
  const counted = await each(withField, PARALLEL, async (c) => ({
    ...c,
    count: new Set(await anki.findNotes(`"note:${searchName(c.model)}"`)).size,
  }));
  const most = Math.max(...counted.map((c) => c.count));
  const best = most > 0 ? counted.filter((c) => c.count === most) : counted;
  if (new Set(best.map((c) => c.field)).size > 1) {
    return { ok: false, reason: `${best.map((c) => c.model).join(" and ")} name the field differently. Type the one you mine with.` };
  }
  return { ok: true, field: best[0].field, modelName: best[0].model };
}
