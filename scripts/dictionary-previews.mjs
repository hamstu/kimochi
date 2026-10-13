/**
 * What the dictionary preview capture (scripts/capture-dictionary-previews.mjs) shows and the data
 * it feeds the engines, kept apart from the browser driving so it can be tested offline
 * (scripts/dictionary-previews.test.mjs).
 *
 * - `SCENE`: the line of dialogue and the word looked up in it (also in frontend/dev/dictionary-preview.html).
 * - `buildExcerpt`: a small Yomitan dictionary cut from a full one (JMdict), holding only the
 *   entries a lookup of that word can reach. Built at capture time from the owner's own files and
 *   never committed: the screenshots are the only dictionary-derived thing in the repository.
 * - `writeZip`: the excerpt as a zip, the format Yomitan and Hachidori import.
 * - `apiPayload`: a Yomitan API `/ankiFields` answer as the `popover:show` payload native emits
 *   (src-tauri/src/reader/popover.rs), limited to the dictionaries a screenshot may show.
 */
import zlib from "node:zlib";
import { readZip } from "./sync-extension.mjs";

export const SCENE = {
  line: "あの日は怖くて、何も食べられなかったんだ。",
  word: "食べられなかった",
  /** The dictionary forms a lookup of `word` deinflects to (Yomitan, Hachidori). */
  lemmas: ["食べる", "食べられる"],
};

/** Every term a lookup starting at `word` in `line` may try: each prefix of the rest of the line, and the lemmas. */
export function lookupTerms({ line, word, lemmas } = SCENE) {
  const rest = line.slice(line.indexOf(word));
  const terms = new Set(lemmas);
  for (let end = 1; end <= rest.length; end++) terms.add(rest.slice(0, end));
  return terms;
}

const BANK = /^(term|term_meta|tag)_bank_\d+\.json$/;

/**
 * A Yomitan dictionary holding only the entries for `terms` (by expression or reading), with the
 * source's index (title, revision, attribution) and every tag. Returns the files to zip, or null
 * when nothing in the source matches.
 */
export function buildExcerpt(zipBuffer, terms) {
  const files = new Map();
  let index = null;
  let matched = 0;
  for (const entry of readZip(zipBuffer)) {
    if (entry.directory) continue;
    if (entry.name === "index.json") {
      index = entry.data;
      continue;
    }
    const kind = BANK.exec(entry.name)?.[1];
    if (!kind) continue;
    const rows = JSON.parse(entry.data.toString("utf8"));
    if (kind === "tag") {
      files.set(entry.name, entry.data);
      continue;
    }
    const kept = rows.filter(
      (row) => terms.has(row[0]) || (kind === "term" && terms.has(row[1])),
    );
    if (kept.length === 0) continue;
    matched += kept.length;
    files.set(entry.name, Buffer.from(JSON.stringify(kept)));
  }
  if (!index) throw Error("Not a Yomitan dictionary (no index.json)");
  if (matched === 0) return null;
  return new Map([["index.json", index], ...files]);
}

/** The title in a Yomitan dictionary zip's index.json. */
export function dictionaryTitle(zipBuffer) {
  const index = readZip(zipBuffer).find((entry) => entry.name === "index.json");
  return index ? JSON.parse(index.data.toString("utf8")).title : null;
}

/** A deflated zip of `files` (name → Buffer), readable by `readZip`, Yomitan and Hachidori. */
export function writeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt32LE(0, 10); // time, date
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(header, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += header.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The fields native asks the Yomitan API for (src-tauri/src/reader/yomitan.rs `ankifields_value`). */
export const ANKI_FIELDS_REQUEST = {
  markers: [
    "expression",
    "reading",
    "glossary",
    "dictionary",
    "frequencies",
    "pitch-accents",
    "part-of-speech",
    "tags",
    "conjugation",
    "audio",
    "sentence",
    "sentence-furigana",
  ],
  maxEntries: 32,
  type: "term",
  includeMedia: false,
};

/**
 * Keeps, in a Yomitan glossary or frequency list, only the items from dictionaries `allowed`
 * accepts: `<li data-dictionary="…">` items (with the `<style>` Yomitan puts after each) and
 * frequency items `<li>Name: value</li>`. Anything else in the HTML is kept as it is.
 */
export function limitDictionaries(html, allowed) {
  if (!html) return html;
  return html
    .replace(
      /<li data-dictionary="([^"]*)">[\s\S]*?<\/li>(\s*<style>[\s\S]*?<\/style>)?(?=\s*(<li data-dictionary=|<\/ol>))/g,
      (item, name) => (allowed(name) ? item : ""),
    )
    .replace(/<li>([^<:]+):[^<]*<\/li>/g, (item, name) =>
      allowed(name.trim()) ? item : "",
    );
}

/**
 * The `popover:show` payload for one `/ankiFields` answer, as native emits it on a lookup
 * (`ShowPayload::Loaded`, fields only), with entries and glossary items from dictionaries
 * `allowed` does not accept left out.
 */
export function apiPayload(
  response,
  { term, sentence, baseUrl, allowed = () => true },
) {
  const entries = (response?.fields ?? [])
    .filter((entry) => allowed(entry.dictionary ?? ""))
    .map((entry) => ({
      ...entry,
      glossary: limitDictionaries(entry.glossary, allowed),
      frequencies: limitDictionaries(entry.frequencies, allowed),
    }));
  return {
    kind: "loaded",
    term,
    entries,
    audioMedia: [],
    dictionaryMedia: [],
    sentence,
    audioAutoplay: false,
    audioVolume: 0.9,
    ankiConfig: null,
    baseUrl,
  };
}
