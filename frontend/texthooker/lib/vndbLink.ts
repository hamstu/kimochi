/**
 * Links a hooked game to its VNDB entry when it is hooked (#223): the hook database's id if it has
 * one, else a search for the game's names that takes only a sure match (ui/vndb-link.ts decides).
 * Runs in the background after the game is hooked and never holds anything up; a failed search
 * (offline, VNDB busy) is simply tried again the next time the game is hooked.
 *
 * The link is kept in the game's record (`textHookerGames[exe].vndb`), shown and changed on the
 * game's page in Settings → Text Hooker.
 */
import { invoke } from '@tauri-apps/api/core'
import { getSetting, setSetting } from '../../bridge/settings'
import { gameKey, type HookGame, type HookGames, type HookVndbLink } from '../../../ui/hook-games'
import { confidentMatch, titleCandidates, vndbPlan } from '../../../ui/vndb-link'
import { bestJapaneseTitle, searchVndbVns, type VndbVn } from './vndb'

/** The hook database's entry for a game (`texthook_db_lookup`). */
export interface HookDbEntry {
  exe: string
  dir?: string
  exeSize?: number
  codes: string[]
  title?: string
  vndb?: string
}

export const hookDbLookup = (exe: string): Promise<HookDbEntry | null> =>
  invoke<HookDbEntry | null>('texthook_db_lookup', { exe })

/** At most this many names are searched for per game: VNDB allows 200 requests in 5 minutes. */
const MAX_SEARCHES = 3

/** Changes the game's record as it is stored now (the overlay may have written it a moment ago). */
async function updateGame(exe: string, change: (game: HookGame) => HookGame): Promise<void> {
  const games = { ...((await getSetting<HookGames>('textHookerGames', {})) ?? {}) }
  const key = gameKey(exe)
  if (!games[key]) return
  games[key] = change(games[key])
  await setSetting('textHookerGames', games)
}

/** The link to store for a VNDB result. */
export const linkFor = (vn: VndbVn, by: HookVndbLink['by']): HookVndbLink => ({
  id: vn.id,
  title: bestJapaneseTitle(vn),
  by
})

/** Links the game at `exe`, hooked from a window titled `windowTitle`, if it is not linked yet. */
export async function autoLinkVndb(exe: string, windowTitle: string | null | undefined): Promise<void> {
  const games = (await getSetting<HookGames>('textHookerGames', {})) ?? {}
  const database = await hookDbLookup(exe).catch(() => null)
  const plan = vndbPlan(games[gameKey(exe)], database, Date.now())
  if (plan.kind === 'none') return
  if (plan.kind === 'link') {
    await updateGame(exe, (game) => ({ ...game, vndb: { id: plan.id, title: plan.title, by: 'database' } }))
    return
  }
  for (const name of titleCandidates(windowTitle, exe).slice(0, MAX_SEARCHES)) {
    let results: VndbVn[]
    try {
      results = await searchVndbVns(name)
    } catch {
      // Offline or VNDB unavailable: tried again the next time the game is hooked.
      return
    }
    const match = confidentMatch(name, results)
    if (match) {
      const vn = results.find((result) => result.id === match.id)!
      await updateGame(exe, (game) => (game.vndb === undefined ? { ...game, vndb: linkFor(vn, 'search') } : game))
      return
    }
  }
  await updateGame(exe, (game) => ({ ...game, vndbSearchedAt: Date.now() }))
}
