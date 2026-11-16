/**
 * The browser preview's `app_location`, `app_move_to_applications` and `app_location_dismiss`
 * (COMMANDS.md → App location), driven by `?movetoapps=<state>`:
 *
 *   downloads (default when set)  run from ~/Downloads, translocated, as after a first download
 *   dmg        run straight from the disk image: copied, and the image ejected
 *   replace    an older copy is already in /Applications (it goes to the Trash)
 *   admin      /Applications is not writable: macOS asks for a password
 *   fail       the move fails, showing the manual steps
 *
 * Without the parameter the app is in /Applications and nothing is offered. The move never
 * relaunches anything here: it stays on "Moving…" (or fails, for `fail`).
 */
const state = new URLSearchParams(location.search).get('movetoapps')

const base = {
  needsMove: false,
  path: '/Applications/Kimochi.app',
  translocated: false,
  copyOnly: false,
  diskImage: false,
  destination: null as string | null,
  replaces: false,
  needsAdmin: false,
  dismissed: false
}

function initial(): typeof base {
  if (!state) return base
  const away = {
    ...base,
    needsMove: true,
    destination: '/Applications/Kimochi.app'
  }
  const downloads = {
    ...away,
    path: '/Users/preview/Downloads/Kimochi.app',
    translocated: true
  }
  switch (state) {
    case 'dmg':
      return {
        ...away,
        path: '/Volumes/Kimochi/Kimochi.app',
        copyOnly: true,
        diskImage: true
      }
    case 'replace':
      return { ...downloads, replaces: true }
    case 'admin':
      return { ...downloads, needsAdmin: true }
    default:
      return downloads
  }
}

let current = initial()

export const APP_LOCATION_HANDLERS: Record<string, () => unknown> = {
  app_location: () => current,
  app_location_dismiss: () => (current = { ...current, dismissed: true }),
  app_move_to_applications: () =>
    new Promise((_, reject) => {
      if (state === 'fail')
        setTimeout(() => reject('“Kimochi.app” couldn’t be copied because you don’t have permission.'), 1200)
    })
}
