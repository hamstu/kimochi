/**
 * The release history built into this binary (`changelog`; COMMANDS.md → App updates), for
 * What's new. It cannot change while the app runs, so the first answer is kept.
 */
import { invoke } from '@tauri-apps/api/core'

let pending: Promise<string> | null = null

/** `CHANGELOG.md` as embedded at build time. Rejects on a backend without the command. */
export function fetchChangelog(): Promise<string> {
  pending ??= invoke<string>('changelog').then((text) => (typeof text === 'string' ? text : ''))
  // A failure is not kept: the next opening asks again.
  pending.catch(() => {
    pending = null
  })
  return pending
}
