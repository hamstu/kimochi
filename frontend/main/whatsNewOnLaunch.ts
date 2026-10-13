/**
 * When the main window opens What's new on its own: once, on the first launch of a new version
 * (WhatsNewDialog.tsx shows it). COMMANDS.md → App updates.
 */
import { useEffect, useState } from 'react'
import { launchAnnouncement } from '@ui/changelog'
import { getSetting, setSetting } from '../bridge/settings'
import { useUpdateStatus } from '../bridge/updates'

/** The setting that holds the version What's new was last shown (or silently recorded) for. */
const LAST_SEEN = 'lastSeenVersion'

/**
 * The version this window has already decided about, for this process. Module scope rather than
 * a ref: StrictMode runs effects twice, and the status can arrive (and change) many times; the
 * setting is read and written once per version either way.
 */
let decidedFor: string | null = null

/**
 * The main window's "after an update" rule, against the `lastSeenVersion` setting:
 * unset (a fresh install) → record the running version silently; a different version → open
 * What's new once and record it; the same → nothing. The running version comes from the update
 * status, which arrives asynchronously (and never on a backend without self-updates).
 *
 * `?whatsnew=1` (the browser preview) opens the dialog on load.
 */
export function useWhatsNewOnLaunch(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(
    () => new URLSearchParams(location.search).get('whatsnew') === '1'
  )
  const currentVersion = useUpdateStatus()?.currentVersion ?? null
  useEffect(() => {
    if (!currentVersion || decidedFor === currentVersion) return
    decidedFor = currentVersion
    // No cleanup that cancels: under StrictMode the first run's cleanup comes before the second
    // run, which the guard skips, so cancelling would lose the decision. setOpen on a component
    // that has since unmounted is a no-op.
    getSetting<unknown>(LAST_SEEN, null)
      .then((seen) => {
        const decision = launchAnnouncement(seen, currentVersion)
        if (decision === 'none') return
        if (decision === 'show') setOpen(true)
        return setSetting(LAST_SEEN, currentVersion)
      })
      .catch((error) => console.error('[whats-new] lastSeenVersion:', error))
  }, [currentVersion])
  return [open, setOpen]
}
