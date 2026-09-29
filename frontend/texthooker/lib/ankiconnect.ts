/* ankiconnect.ts — TS wrapper around the Rust AnkiConnect commands +
   a sendCardForTerm orchestrator. Status pub/sub mirrors yomitan.ts. */

import { invoke } from "@tauri-apps/api/core";
import type {
  AnkiFieldMapping,
  AnkiMediaItem,
  AnkiStatus,
  YomitanAnkiFields,
} from "./types";

/* ---------------- status pub/sub ---------------- */

type StatusSub = (s: AnkiStatus) => void;
const subs = new Set<StatusSub>();
let current: AnkiStatus = "unknown";

function setStatus(next: AnkiStatus) {
  if (next === current) return;
  current = next;
  for (const fn of subs) {
    try {
      fn(next);
    } catch (e) {
      console.error(e);
    }
  }
}

export function onAnkiStatus(fn: StatusSub): () => void {
  subs.add(fn);
  fn(current);
  return () => {
    subs.delete(fn);
  };
}

export function getAnkiStatus(): AnkiStatus {
  return current;
}

/* ---------------- thin invoke wrappers ---------------- */

export async function probeAnki(
  url: string,
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  try {
    const ms = await invoke<number>("anki_probe", { url });
    setStatus("ok");
    return { ok: true, latencyMs: ms };
  } catch (err) {
    setStatus("err");
    return { ok: false, error: String(err) };
  }
}

export async function listDecks(url: string): Promise<string[]> {
  return invoke<string[]>("anki_deck_names", { url });
}

export async function listModels(url: string): Promise<string[]> {
  return invoke<string[]>("anki_model_names", { url });
}

export async function listModelFields(
  url: string,
  model: string,
): Promise<string[]> {
  return invoke<string[]>("anki_model_field_names", {
    url,
    modelName: model,
  });
}

export async function findNotesByQuery(
  url: string,
  query: string,
): Promise<number[]> {
  return invoke<number[]>("anki_find_notes", { url, query });
}

export async function openInAnkiBrowser(
  url: string,
  query: string,
): Promise<void> {
  await invoke<number[]>("anki_gui_browse", { url, query });
}

export async function storeMedia(
  url: string,
  filename: string,
  base64: string,
): Promise<void> {
  await invoke<string>("anki_store_media_file", {
    url,
    filename,
    dataBase64: base64,
  });
}

/** Add a note. Returns { id, duplicate }. Catches the "duplicate" error and
 *  recovers the existing note id via findNotes when possible. */
export async function addNote(
  url: string,
  deck: string,
  model: string,
  fields: Record<string, string>,
  tags: string[],
  expressionFieldName: string,
  expressionValue: string,
): Promise<{ id: number; duplicate: boolean }> {
  try {
    const id = await invoke<number>("anki_add_note", {
      url,
      deck,
      model,
      fields,
      tags,
      allowDuplicate: false,
    });
    return { id, duplicate: false };
  } catch (err) {
    const msg = String(err);
    if (!/duplicate/i.test(msg)) throw err;
    // Try to find the existing note by the expression field's exact value.
    const safe = expressionValue.replace(/"/g, '\\"');
    const query = `"${expressionFieldName}:${safe}"`;
    let ids: number[] = [];
    try {
      ids = await findNotesByQuery(url, query);
    } catch {
      // ignore — fall through to original error if recovery fails
    }
    if (ids.length > 0) {
      return { id: ids[0], duplicate: true };
    }
    throw err;
  }
}

/* ---------------- mining orchestrator ---------------- */

export interface SendCardOpts {
  ankiUrl: string;
  deck: string;
  model: string;
  modelFields: string[];
  mappings: AnkiFieldMapping[];
  tags: string[];
  yomitan: {
    fields: YomitanAnkiFields;
    audioMedia: AnkiMediaItem[];
    dictionaryMedia: AnkiMediaItem[];
  };
  sentence: string | null;
}

export interface SendCardResult {
  noteId: number;
  duplicate: boolean;
}

/** The field Anki/AnkiConnect dedups on: the first field of the note type.
 *  Returns the field name and the value it would hold for this term, so a
 *  pre-add existence check and the actual add agree on the dedup key. */
export function resolveExpressionField(
  modelFields: string[],
  mappings: AnkiFieldMapping[],
  fields: YomitanAnkiFields,
  sentence: string | null,
): { name: string; value: string } {
  const name = modelFields[0] ?? "Expression";
  const mapping = mappings.find((m) => m.ankiField === name);
  const value = mapping ? resolveFieldValue(mapping, fields, sentence) : "";
  return { name, value };
}

/** True if a note with this expression already exists in the deck. Used to
 *  show a "already added" state before offering to add. Throws on transport
 *  errors so callers can distinguish "not present" from "couldn't check". */
export async function noteExistsForTerm(
  url: string,
  deck: string,
  expressionFieldName: string,
  expressionValue: string,
): Promise<number | null> {
  if (!expressionValue.trim()) return null;
  const safeField = expressionFieldName.replace(/"/g, '\\"');
  const safeValue = expressionValue.replace(/"/g, '\\"');
  const safeDeck = deck.replace(/"/g, '\\"');
  const query = `"deck:${safeDeck}" "${safeField}:${safeValue}"`;
  const ids = await findNotesByQuery(url, query);
  return ids.length > 0 ? ids[0] : null;
}

function resolveFieldValue(
  mapping: AnkiFieldMapping,
  yomitan: YomitanAnkiFields,
  sentence: string | null,
): string {
  switch (mapping.mappingType) {
    case "marker": {
      if (!mapping.marker) return "";
      const v = (yomitan as Record<string, string | undefined>)[mapping.marker];
      return typeof v === "string" ? v : "";
    }
    case "sentence":
      return sentence ?? "";
    case "literal":
      return mapping.literal ?? "";
    case "empty":
      return "";
    default:
      return "";
  }
}

/** Send the current popover term as an Anki card.
 *  1. storeMedia for each audio + dictionary media item
 *  2. resolve field mappings → record
 *  3. addNote (with duplicate detection)
 */
export async function sendCardForTerm(
  opts: SendCardOpts,
): Promise<SendCardResult> {
  const {
    ankiUrl,
    deck,
    model,
    modelFields,
    mappings,
    tags,
    yomitan,
    sentence,
  } = opts;

  // 1. Store any media bundled with the term.
  for (const item of yomitan.audioMedia) {
    await storeMedia(ankiUrl, item.ankiFilename, item.contentBase64);
  }
  for (const item of yomitan.dictionaryMedia) {
    await storeMedia(ankiUrl, item.ankiFilename, item.contentBase64);
  }

  // 2. Build the fields record. Skip Anki fields with no mapping (default empty).
  const fields: Record<string, string> = {};
  const mappingByField = new Map(mappings.map((m) => [m.ankiField, m]));
  for (const f of modelFields) {
    const m = mappingByField.get(f);
    if (m) {
      fields[f] = resolveFieldValue(m, yomitan.fields, sentence);
    } else {
      fields[f] = "";
    }
  }

  // 3. Add note. For duplicate recovery we use the first Anki field as the
  //    dedup key (Anki/AnkiConnect's default duplicate check looks there).
  const { name: expressionFieldName, value: expressionValue } =
    resolveExpressionField(modelFields, mappings, yomitan.fields, sentence);
  const { id, duplicate } = await addNote(
    ankiUrl,
    deck,
    model,
    fields,
    tags,
    expressionFieldName,
    expressionValue,
  );
  return { noteId: id, duplicate };
}
