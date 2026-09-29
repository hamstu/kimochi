/* yomitanImport.ts — parse a Yomitan settings JSON export and extract the
   first "term" Anki card format. Mirrors anki-remote-mining's YomitanImportModal
   logic, adapted to our AnkiFieldMapping shape. */

import type { AnkiFieldMapping } from "./types";

interface YomitanField {
  value: string;
}

interface YomitanCardFormat {
  name: string;
  type: string;
  deck: string;
  model: string;
  fields: Record<string, YomitanField>;
}

interface YomitanProfile {
  name: string;
  options: {
    anki: {
      tags: string[];
      cardFormats: YomitanCardFormat[];
    };
  };
}

interface YomitanSettings {
  options: {
    profiles: YomitanProfile[];
  };
}

export interface CardFormatOption {
  profileName: string;
  cardFormat: YomitanCardFormat;
  tags: string[];
}

export interface ImportedConfig {
  deckName: string;
  modelName: string;
  tags: string[];
  fieldMappings: AnkiFieldMapping[];
}

function validateYomitanSettings(data: unknown): data is YomitanSettings {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (!d.options || typeof d.options !== "object") return false;
  const opts = d.options as Record<string, unknown>;
  return Array.isArray(opts.profiles);
}

/** Parse a single `{marker}` (or sentence-cloze pattern) out of a Yomitan
    field-value template. Returns null when the field shouldn't be mapped. */
function parseFieldValue(
  ankiField: string,
  value: string,
): AnkiFieldMapping | null {
  if (!value || value.trim() === "") return null;

  // Sentence cloze recipe (Yomitan's default "Sentence (cloze)" card type).
  // We don't synthesize cloze fields ourselves, but we can map this to
  // "sentence" so the popover's sentence text fills the field.
  if (
    value.includes("{cloze-prefix}") &&
    value.includes("{cloze-body}") &&
    value.includes("{cloze-suffix}")
  ) {
    return { ankiField, mappingType: "sentence" };
  }

  // First {marker} reference in the value wins.
  const match = value.match(/\{([^}]+)\}/);
  if (match) {
    return { ankiField, mappingType: "marker", marker: match[1] };
  }

  return null;
}

export function findTermCardFormats(text: string): CardFormatOption[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON.");
  }
  if (!validateYomitanSettings(data)) {
    throw new Error(
      "Doesn't look like a Yomitan settings export (no options.profiles array).",
    );
  }
  const results: CardFormatOption[] = [];
  for (const profile of data.options.profiles) {
    if (!profile?.options?.anki?.cardFormats) continue;
    for (const cf of profile.options.anki.cardFormats) {
      if (cf.type === "term" && cf.deck && cf.model) {
        results.push({
          profileName: profile.name,
          cardFormat: cf,
          tags: profile.options.anki.tags ?? [],
        });
      }
    }
  }
  if (results.length === 0) {
    throw new Error(
      "No term card formats found. Make sure Yomitan has an Anki card format with deck + note type set.",
    );
  }
  return results;
}

export function extractConfigFromCardFormat(
  option: CardFormatOption,
): ImportedConfig {
  const fieldMappings: AnkiFieldMapping[] = [];
  for (const [field, entry] of Object.entries(option.cardFormat.fields)) {
    const mapping = parseFieldValue(field, entry.value);
    if (mapping) fieldMappings.push(mapping);
  }
  return {
    deckName: option.cardFormat.deck,
    modelName: option.cardFormat.model,
    tags: [...option.tags],
    fieldMappings,
  };
}
