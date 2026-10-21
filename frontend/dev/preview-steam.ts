/**
 * DEV-ONLY: `steam_library_status` / `steam_library_add` for the browser preview.
 *
 *   ?steam=deck        a Steam Deck in Desktop Mode, Steam running, Kimochi not in the library:
 *                      the welcome guide's Steam step shows; Add to Steam succeeds after 1.5 s
 *   ?steam=notrunning  the same, but Steam is not running (the add says so)
 *   ?steam=fail        the add fails (Steam refused the request)
 *   ?steam=pending     Steam took the request but no entry appeared
 *   ?steam=added       Kimochi is already in the library (Settings shows it; the step is skipped)
 *   ?steam=gaming      in Gaming Mode already (the step is skipped)
 *   (none)             no Steam: nothing shows
 *
 * Pair it with `?platform=linux` for the Linux capabilities.
 */
const mode = new URLSearchParams(location.search).get('steam')

const status = {
  supported: mode !== null,
  steamDeck: mode !== null,
  steamOs: mode !== null,
  steamInstalled: mode !== null,
  steamRunning: mode !== 'notrunning',
  gamingMode: mode === 'gaming',
  added: mode === 'added',
  appId: mode === 'added' ? 2_987_654_321 : null,
  artwork: mode === 'added',
  launcher: mode === 'added',
  reason: mode === null ? 'Steam is not installed for this user.' : null
}

const later = <T>(value: T, ms = 1500): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms))

export const STEAM_HANDLERS: Record<string, () => unknown> = {
  steam_library_status: () => ({ ...status }),
  steam_library_add: () => {
    switch (mode) {
      case 'notrunning':
        return later({
          state: 'steamNotRunning',
          message: 'Steam is not running. Open Steam, then try again, or add Kimochi by hand.',
          appId: null,
          status: { ...status }
        }, 600)
      case 'fail':
        return later({
          state: 'failed',
          message: 'Steam did not accept Kimochi: steamos-add-to-steam: Unsupported file type',
          appId: null,
          status: { ...status }
        })
      case 'pending':
        return later({
          state: 'pending',
          message:
            'Steam took the request, but Kimochi is not in its library yet. Check your library; Kimochi adds its artwork the next time it starts.',
          appId: null,
          status: { ...status }
        })
      default:
        Object.assign(status, { added: true, appId: 2_987_654_321, artwork: true, launcher: true })
        return later({
          state: 'added',
          message: 'Kimochi is in your Steam library.',
          appId: 2_987_654_321,
          status: { ...status }
        })
    }
  }
}
