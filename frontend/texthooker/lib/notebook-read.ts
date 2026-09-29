import { getEntry } from "./notebook";
import { buildPatternsFor } from "./nameMatch";
import { readFile, BaseDirectory } from "@tauri-apps/plugin-fs";
import type {
  NotebookImage,
  NotebookEntry,
  SerializedNotebookEntry,
  Line,
} from "./types";
const DIR = BaseDirectory.AppLocalData;
export async function readImageBytes(
  image: NotebookImage,
): Promise<Uint8Array> {
  return await readFile(image.path, { baseDir: DIR });
}

export async function readImageAsObjectURL(
  image: NotebookImage,
): Promise<string> {
  const bytes = await readImageBytes(image);
  const ext = image.path.split(".").pop() ?? "png";
  // Use a fresh ArrayBuffer copy to avoid SharedArrayBuffer typing issues.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return URL.createObjectURL(new Blob([ab], { type: mimeForExt(ext) }));
}

function uint8ToBase64(bytes: Uint8Array): string {
  // Chunked to avoid call-stack blowup for large images.
  const chunk = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    s += String.fromCharCode.apply(null, Array.from(slice) as number[]);
  }
  return btoa(s);
}

export function displayNameFor(entry: NotebookEntry): string {
  if (entry.kind === "person") {
    const fam = entry.family.trim();
    const giv = entry.given.trim();
    if (fam && giv) return `${fam} ${giv}`;
    return fam || giv || "(unnamed)";
  }
  return entry.name.trim() || "(unnamed)";
}

export function displayReadingFor(entry: NotebookEntry): string | undefined {
  if (entry.kind === "person") {
    const f = (entry.familyReading ?? "").trim();
    const g = (entry.givenReading ?? "").trim();
    if (f && g) return `${f} ${g}`;
    return f || g || undefined;
  }
  return entry.reading?.trim() || undefined;
}

/** Serialize an entry into a self-contained snapshot suitable for sending
 *  through a Tauri event (popover window cross-process). */
export async function serializeEntryForPopover(
  entry: NotebookEntry,
): Promise<SerializedNotebookEntry> {
  let imageDataUrl: string | null = null;
  const first = entry.images[0];
  if (first) {
    try {
      const bytes = await readImageBytes(first);
      const ext = first.path.split(".").pop() ?? "png";
      imageDataUrl = `data:${mimeForExt(ext)};base64,${uint8ToBase64(bytes)}`;
    } catch (err) {
      console.warn("serializeEntryForPopover image read failed", err);
    }
  }
  return {
    id: entry.id,
    kind: entry.kind,
    displayName: displayNameFor(entry),
    reading: displayReadingFor(entry),
    description: entry.description,
    aliases: entry.aliases ?? [],
    notes: (entry.notes ?? []).map((n) => n.text),
    imageDataUrl,
  };
}

/* ── Mentions (lazy backref) ───────────────────────────────────────────── */

export function computeMentions(entryId: string, lines: Line[]): number[] {
  const entry = getEntry(entryId);
  if (!entry || !entry.matchEnabled) return [];
  const patterns = buildPatternsFor(entry).map((p) => p.text);
  if (patterns.length === 0) return [];
  const out: number[] = [];
  for (const line of lines) {
    for (const p of patterns) {
      if (line.text.includes(p)) {
        out.push(line.id);
        break;
      }
    }
  }
  return out;
}

function mimeForExt(ext: string): string {
  const e = ext.replace(/^\./, "").toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "gif") return "image/gif";
  if (e === "webp") return "image/webp";
  if (e === "bmp") return "image/bmp";
  return "image/png";
}
