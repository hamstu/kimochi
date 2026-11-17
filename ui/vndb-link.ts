/**
 * Linking a hooked game to its VNDB entry (#223), the part that decides: which names to search
 * VNDB for, and which result, if any, is the game.
 *
 * The names are LunaTranslator's (`guessmaybetitle`): the window's title, the exe's folder and the
 * exe's own name, with tags such as `(18禁ゲーム)`, `[RJ123456]` and dates taken out. Luna takes
 * VNDB's first result for the first name that finds anything; here a result is taken only when one
 * of its titles is the name searched for, once case, width, spaces and punctuation are set aside.
 * Anything less sure is left for the reader to choose (Settings → Text Hooker, the game's page).
 *
 * The searching itself is frontend/texthooker/lib/vndbLink.ts, through the native VNDB proxy.
 */

/** As much of a VNDB visual novel as linking needs (`vndb_search_vns`). */
export interface VndbCandidate {
  id: string
  title: string
  alttitle?: string | null
  titles?: { title: string; lang?: string }[]
}

/** How long before a game VNDB found nothing sure for is searched again. */
export const VNDB_SEARCH_AGAIN_MS = 7 * 24 * 60 * 60 * 1000

/** Names that say nothing about the game: an engine's exe, a launcher, a generic folder. */
const GENERIC = new Set([
  'game',
  'start',
  'launcher',
  'play',
  'main',
  'nw',
  'app',
  'bin',
  'data',
  'program files',
  'program files (x86)',
  'games',
  'steamapps',
  'common',
  'siglusengine',
  'bgi',
  'advhd',
  'malie',
  'cs2',
  'kirikiri',
  'krkr',
  'tvp',
  'rpg_rt',
  'nscripter',
  'nscr',
  'reallive',
  'ethornell',
  'unity',
  'renpy'
])

/** A title as compared: NFKC, lowercase, with spaces, punctuation and symbols taken out. */
export function normalizeTitle(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** A name cleaned of what stores and sharing sites add to it, as LunaTranslator cleans it. */
export function cleanTitle(text: string): string {
  return text
    .replace(/[（(](同人ゲーム|18禁ゲーム)[)）]/g, '')
    .replace(/\[RJ\d+\]/gi, '')
    .replace(/\[\d{4}-\d{2}-\d{2}\]/g, '')
    .replace(/\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const pureAscii = (text: string): boolean => [...text].every((c) => c.charCodeAt(0) < 0x80)

/**
 * The names to search VNDB for, best first: the window's title, then the exe's folder, then the
 * exe's name. A name that is generic, or ASCII and under 10 characters (an abbreviation, `sp`),
 * is left out, as is one already listed.
 */
export function titleCandidates(windowTitle: string | null | undefined, exe: string): string[] {
  const parts = exe.split(/[\\/]/).filter(Boolean)
  const file = (parts.at(-1) ?? '').replace(/\.exe$/i, '')
  const folder = parts.at(-2) ?? ''
  const out: string[] = []
  for (const raw of [windowTitle ?? '', folder, file]) {
    const name = cleanTitle(raw)
    const key = normalizeTitle(name)
    if (!key || GENERIC.has(name.toLowerCase())) continue
    if (pureAscii(name) && name.length < 10) continue
    if (out.some((seen) => normalizeTitle(seen) === key)) continue
    out.push(name)
  }
  return out
}

/** The result that is surely the game named `name`: one of its titles is that name. */
export function confidentMatch(name: string, results: VndbCandidate[]): VndbCandidate | null {
  const want = normalizeTitle(name)
  if (!want) return null
  return (
    results.find((vn) =>
      [vn.title, vn.alttitle, ...(vn.titles ?? []).map((t) => t.title)].some(
        (title) => typeof title === 'string' && normalizeTitle(title) === want
      )
    ) ?? null
  )
}

/** What to do about a game's VNDB link when it is hooked. */
export type VndbPlan = { kind: 'none' } | { kind: 'link'; id: string; title: string } | { kind: 'search' }

/**
 * Whether to link the game: nothing when it is linked, or was unlinked by the reader (`null`);
 * the hook database's id when it has one; else a search, unless one found nothing sure lately.
 */
export function vndbPlan(
  game: { vndb?: { id: string } | null; vndbSearchedAt?: number } | null | undefined,
  database: { vndb?: string | null; title?: string | null } | null | undefined,
  now: number
): VndbPlan {
  if (game?.vndb !== undefined) return { kind: 'none' }
  if (database?.vndb) return { kind: 'link', id: database.vndb, title: database.title || database.vndb }
  if (game?.vndbSearchedAt && now - game.vndbSearchedAt < VNDB_SEARCH_AGAIN_MS) return { kind: 'none' }
  return { kind: 'search' }
}

/** The game's page on VNDB. */
export const vndbUrl = (id: string): string => `https://vndb.org/${encodeURIComponent(id)}`
