import { toHiragana } from "wanakana";
import {
  attachImage,
  createPerson,
  getNotebook,
  updateEntry,
} from "./notebook";
import { fetchVndbImageBlob, type VndbCharacter } from "./vndb";
import type { PersonEntry } from "./types";

export interface ImportResult {
  /** VNDB id (e.g. "c547") of the character we imported. */
  vndbId: string;
  /** Status: "created" = new entry, "updated" = refreshed an existing entry,
   *  "unchanged" = matched an entry but nothing needed updating. */
  status: "created" | "updated" | "unchanged";
  /** Entry id we touched. */
  entryId: string;
  /** Whether we attached an image as part of this import. */
  imageAttached: boolean;
}

/* ── Name splitting ────────────────────────────────────────────────────── */

/** Japanese VNDB `original` strings typically look like "山田 太郎" (family,
 *  given) separated by a half- or full-width space. If we can't find a space,
 *  return the whole thing as family. */
export function splitJapaneseName(original: string): {
  family: string;
  given: string;
} {
  const trimmed = original.trim();
  if (!trimmed) return { family: "", given: "" };
  // Try common separators: ASCII space, full-width space, middle dot.
  const sepMatch = trimmed.match(/^(.+?)[\s\u3000](.+)$/);
  if (sepMatch) {
    return { family: sepMatch[1].trim(), given: sepMatch[2].trim() };
  }
  return { family: trimmed, given: "" };
}

/** Western names from VNDB are usually "Given Family". For names with middle
 *  parts ("Gilbert dis Balstein") we treat the last whitespace-delimited token
 *  as family and the rest as given. */
export function splitWesternName(name: string): {
  family: string;
  given: string;
} {
  const trimmed = name.trim();
  if (!trimmed) return { family: "", given: "" };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { family: parts[0], given: "" };
  const family = parts[parts.length - 1];
  const given = parts.slice(0, -1).join(" ");
  return { family, given };
}

/* ── Name readings ─────────────────────────────────────────────────────── */

/** Convert a VNDB romanized name fragment to hiragana. VNDB uses wapuro-style
 *  romanization ("Ryougo", "Touko"), which wanakana handles directly; macrons
 *  are normalized first as a best effort. Returns undefined unless the result
 *  is pure kana — garbage-in (non-Japanese names) safely yields nothing. */
export function romajiToHiragana(s: string): string | undefined {
  const trimmed = s.trim().toLowerCase();
  if (!trimmed) return undefined;
  const demacroned = trimmed
    .replace(/ā/g, "aa")
    .replace(/ī/g, "ii")
    .replace(/ū/g, "uu")
    .replace(/ē/g, "ee")
    .replace(/ō/g, "ou");
  const kana = toHiragana(demacroned);
  return /^[ぁ-ゖー]+$/.test(kana) ? kana : undefined;
}

/** Derive familyReading/givenReading from the romanized `name`, aligned with
 *  how family/given are populated from `original`. VNDB romanizes Japanese
 *  names in original order (family first), so tokens map positionally. Only
 *  applies when `original` exists — without it the entry's name fields ARE the
 *  romanized name and a "reading" would be meaningless. */
export function deriveReadings(c: VndbCharacter): {
  familyReading?: string;
  givenReading?: string;
} {
  if (!c.original || !c.name?.trim()) return {};
  const { given: jaGiven } = splitJapaneseName(c.original);
  const parts = c.name.trim().split(/\s+/);
  if (jaGiven) {
    // Two-part original → need at least two romanized tokens to align.
    if (parts.length < 2) return {};
    return {
      familyReading: romajiToHiragana(parts[0]),
      givenReading: romajiToHiragana(parts.slice(1).join("")),
    };
  }
  // Single-part original lands in `family`, so its reading does too.
  return { familyReading: romajiToHiragana(parts.join("")) };
}

/* ── BBCode stripping ──────────────────────────────────────────────────── */

const BBCODE_URL = /\[url=[^\]]+\]([^[]*)\[\/url\]/gi;
const BBCODE_BARE = /\[(\w+)(?:=[^\]]+)?\]([^[]*)\[\/\1\]/g;
const BBCODE_RAW_TAG = /\[\/?\w+(?:=[^\]]+)?\]/g;

export function stripBBCode(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(BBCODE_URL, "$1")
    .replace(BBCODE_BARE, "$2")
    .replace(BBCODE_RAW_TAG, "")
    .trim();
}

/* ── Match lookup ──────────────────────────────────────────────────────── */

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function personFullJa(p: PersonEntry): string {
  return `${(p.family ?? "").trim()}${(p.given ?? "").trim() ? " " + p.given.trim() : ""}`.trim();
}

/** Find an existing PersonEntry for the VNDB character. A stored vndbId wins
 *  outright (exact, survives renames); otherwise we fall back to name matching:
 *  the Japanese original first (most reliable), then the English name, against
 *  both joined and space-separated forms. Returns null if none match. */
export function findExistingPerson(c: VndbCharacter): PersonEntry | null {
  const nb = getNotebook();
  const people = nb.entries.filter(
    (e): e is PersonEntry => e.kind === "person",
  );
  if (people.length === 0) return null;

  const byId = people.find((p) => p.vndbId === c.id);
  if (byId) return byId;

  const candidates: string[] = [];
  if (c.original) {
    const { family: jf, given: jg } = splitJapaneseName(c.original);
    candidates.push(`${jf}${jg}`, `${jf} ${jg}`.trim(), jf);
  }
  if (c.name) {
    const { family: ef, given: eg } = splitWesternName(c.name);
    candidates.push(c.name, `${eg} ${ef}`.trim(), `${ef} ${eg}`.trim());
  }
  for (const alias of c.aliases ?? []) candidates.push(alias);

  const normCandidates = new Set(
    candidates.map(normalizeName).filter((s) => s.length > 0),
  );
  if (normCandidates.size === 0) return null;

  for (const p of people) {
    const forms = [
      `${p.family ?? ""}${p.given ?? ""}`,
      personFullJa(p),
      ...(p.aliases ?? []),
    ];
    for (const f of forms) {
      if (normCandidates.has(normalizeName(f))) return p;
    }
  }
  return null;
}

/* ── Merge ─────────────────────────────────────────────────────────────── */

interface BuiltPersonPatch {
  patch: Partial<PersonEntry>;
  changedFields: string[];
}

function buildPatchFromCharacter(
  existing: PersonEntry | null,
  c: VndbCharacter,
): BuiltPersonPatch {
  const japanese = c.original ? splitJapaneseName(c.original) : null;
  const western = splitWesternName(c.name);

  // Prefer Japanese name when populating family/given; fall back to Western.
  const family = japanese?.family || western.family;
  const given = japanese?.given || western.given;

  const patch: Partial<PersonEntry> = {};
  const changed: string[] = [];

  const fillIfEmpty = <K extends keyof PersonEntry>(
    key: K,
    value: PersonEntry[K] | undefined,
  ) => {
    if (value === undefined || value === null) return;
    if (typeof value === "string" && value.trim() === "") {
      return;
    }
    const cur = existing ? (existing[key] as unknown) : undefined;
    const isEmpty =
      cur === undefined ||
      cur === null ||
      (typeof cur === "string" && cur.trim() === "");
    if (isEmpty) {
      patch[key] = value;
      changed.push(String(key));
    }
  };

  fillIfEmpty("family", family);
  fillIfEmpty("given", given);

  const readings = deriveReadings(c);
  fillIfEmpty("familyReading", readings.familyReading);
  fillIfEmpty("givenReading", readings.givenReading);

  // Description: take VNDB's text when the entry has none, or when the current
  // text is still exactly what a previous import wrote (not hand-edited).
  // importedDescription is bookkeeping, not a user-visible change.
  const desc = stripBBCode(c.description);
  if (desc) {
    const cur = (existing?.description ?? "").trim();
    const unedited =
      cur === "" || existing?.description === existing?.importedDescription;
    if (unedited) {
      if ((existing?.description ?? "") !== desc) {
        patch.description = desc;
        changed.push("description");
      }
      if (existing?.importedDescription !== desc) {
        patch.importedDescription = desc;
      }
    }
  }

  // Link the entry to its VNDB id so future imports update it in place.
  if (!existing || existing.vndbId !== c.id) {
    patch.vndbId = c.id;
  }

  // Imports enforce the match-given-alone default (toggle back off per entry
  // if you really want it off — re-importing will re-enable it).
  if (existing && existing.kind === "person" && !existing.matchGivenAlone) {
    patch.matchGivenAlone = true;
    changed.push("matchGivenAlone");
  }

  // Aliases: append VNDB aliases the user doesn't already have. This is purely
  // additive (no "only if empty" rule) since aliases are a list, not a single
  // field. Skip if no aliases on either side.
  const vndbAliases = (c.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  if (vndbAliases.length > 0) {
    const currentAliases = existing?.aliases ?? [];
    const merged = [...currentAliases];
    let added = false;
    for (const a of vndbAliases) {
      if (!merged.some((m) => m.toLowerCase() === a.toLowerCase())) {
        merged.push(a);
        added = true;
      }
    }
    if (added) {
      patch.aliases = merged;
      changed.push("aliases");
    }
  }

  return { patch, changedFields: changed };
}

/* ── Import ────────────────────────────────────────────────────────────── */

export async function importVndbCharacter(
  c: VndbCharacter,
): Promise<ImportResult> {
  const existing = findExistingPerson(c);

  if (existing) {
    const { patch, changedFields } = buildPatchFromCharacter(existing, c);
    let imageAttached = false;
    if (Object.keys(patch).length > 0) {
      await updateEntry(existing.id, patch);
    }
    // Image only if the entry has none yet AND VNDB has a non-sexual image.
    if (existing.images.length === 0 && c.image && c.image.sexual === 0) {
      const fetched = await fetchVndbImageBlob(c.image.url);
      if (fetched) {
        await attachImage(existing.id, fetched.blob, fetched.ext);
        imageAttached = true;
      }
    }
    return {
      vndbId: c.id,
      status:
        changedFields.length === 0 && !imageAttached ? "unchanged" : "updated",
      entryId: existing.id,
      imageAttached,
    };
  }

  // No match — create a fresh entry.
  const { patch } = buildPatchFromCharacter(null, c);
  const created = await createPerson({
    family: typeof patch.family === "string" ? patch.family : "",
    given: typeof patch.given === "string" ? patch.given : "",
    familyReading: patch.familyReading,
    givenReading: patch.givenReading,
    description: typeof patch.description === "string" ? patch.description : "",
    aliases: Array.isArray(patch.aliases) ? patch.aliases : [],
    vndbId: patch.vndbId,
    importedDescription: patch.importedDescription,
  });
  let imageAttached = false;
  if (c.image && c.image.sexual === 0) {
    const fetched = await fetchVndbImageBlob(c.image.url);
    if (fetched) {
      await attachImage(created.id, fetched.blob, fetched.ext);
      imageAttached = true;
    }
  }
  return {
    vndbId: c.id,
    status: "created",
    entryId: created.id,
    imageAttached,
  };
}
