import { invoke } from "@tauri-apps/api/core";

export interface VndbVnRef {
  id: string;
  title?: string;
  role?: "main" | "primary" | "side" | "appears";
}

export interface VndbTitle {
  lang: string;
  title: string;
  official?: boolean;
}

export interface VndbVn {
  id: string;
  title: string;
  alttitle: string | null;
  titles: VndbTitle[];
  image: { url: string; sexual: number } | null;
  released: string | null;
}

export interface VndbCharacter {
  id: string;
  name: string;
  original: string | null;
  aliases: string[];
  description: string | null;
  image: { url: string; sexual: number } | null;
  vns: VndbVnRef[];
}

interface ListResponse<T> {
  results: T[];
  more: boolean;
}

export async function searchVndbVns(query: string): Promise<VndbVn[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const res = (await invoke("vndb_search_vns", {
    query: trimmed,
  })) as ListResponse<VndbVn>;
  return res.results ?? [];
}

export async function getVndbCharactersForVn(
  vnId: string,
): Promise<VndbCharacter[]> {
  if (!vnId) return [];
  const res = (await invoke("vndb_characters_by_vn", {
    vnId,
  })) as ListResponse<VndbCharacter>;
  return res.results ?? [];
}

interface FetchedImage {
  base64: string;
  ext: string;
}

/** Fetch a VNDB image via the Rust proxy and return it as a Blob ready for
 *  attachImage(). Returns null if anything fails — the caller continues without
 *  an image. */
export async function fetchVndbImageBlob(
  url: string,
): Promise<{ blob: Blob; ext: string } | null> {
  try {
    const res = (await invoke("vndb_fetch_image", { url })) as FetchedImage;
    const bin = atob(res.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mime =
      res.ext === "png"
        ? "image/png"
        : res.ext === "webp"
          ? "image/webp"
          : res.ext === "gif"
            ? "image/gif"
            : "image/jpeg";
    return { blob: new Blob([bytes], { type: mime }), ext: res.ext };
  } catch (err) {
    console.warn("[vndb] image fetch failed", url, err);
    return null;
  }
}

/** Pick the best display title for a VN: the Japanese original (titles[lang=ja])
 *  when present, falling back to alttitle, then the romanized `title`. */
export function bestJapaneseTitle(vn: VndbVn): string {
  const ja = vn.titles?.find((t) => t.lang === "ja");
  if (ja?.title) return ja.title;
  if (vn.alttitle) return vn.alttitle;
  return vn.title;
}

export function romanizedTitle(vn: VndbVn): string {
  return vn.title;
}
