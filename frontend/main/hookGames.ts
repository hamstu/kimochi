/**
 * The Text Hooker's settings in the main window: the defaults and each game's own
 * (ui/hook-games.ts says what they are). Writes go through `updateHookGame`, which applies the
 * change to the freshest stored games, so a write here never undoes what the overlay learned a
 * moment before (where the game's text is).
 */
import { getSetting, setSetting } from '../bridge/settings'
import { useSetting } from '../bridge/useSetting'
import { openSettings } from '../bridge/tauri'
import { showSettingsTab } from '../panels/settings/showSettingsTab'
import { useLanguage } from '../bridge/useLanguage'
import {
  gameKey,
  hookDefaultsFor,
  hookSettings,
  type HookGame,
  type HookGames,
  type HookSettings
} from '../../ui/hook-games'

export * from '../../ui/hook-games'

/** The defaults, a change to them, one put back to how Kimochi ships, and how it ships them for
    the language being read (`hookDefaultsFor`). */
export function useHookDefaults(): [
  HookSettings,
  (change: Partial<HookSettings>) => Promise<void>,
  (key: keyof HookSettings) => Promise<void>,
  HookSettings
] {
  const [stored, setStored] = useSetting<Partial<HookSettings>>('textHookerDefaults', {})
  const [language] = useLanguage()
  const shipped = hookDefaultsFor(language)
  const defaults = { ...shipped, ...(stored ?? {}) }
  const reset = (key: keyof HookSettings): Promise<void> => {
    const next = { ...(stored ?? {}) }
    delete next[key]
    return setStored(next)
  }
  return [defaults, (change) => setStored({ ...(stored ?? {}), ...change }), reset, shipped]
}

export function useHookGames(): HookGames {
  const [games] = useSetting<HookGames>('textHookerGames', {})
  return games ?? {}
}

/** Changes a game's record: `change` returns the new record, or null to delete it. */
export async function updateHookGame(exe: string, change: (game: HookGame) => HookGame | null): Promise<void> {
  const key = gameKey(exe)
  const games = { ...((await getSetting<HookGames>('textHookerGames', {})) ?? {}) }
  const next = change(games[key] ?? {})
  if (next) games[key] = next
  else delete games[key]
  await setSetting('textHookerGames', games)
}

/** The hooked game's settings, with the defaults where it has none of its own. */
export function useHookSettings(exe: string | null | undefined): HookSettings {
  const [defaults] = useHookDefaults()
  const games = useHookGames()
  return hookSettings(defaults, exe ? games[gameKey(exe)] : null)
}

/** Opens Settings → Text Hooker, on the game at `exe` when given (else on the defaults). */
export async function openTextHookerSettings(exe?: string | null): Promise<void> {
  await setSetting('textHookerSettingsGame', exe ? gameKey(exe) : null)
  showSettingsTab('texthooker')
  await openSettings()
}
