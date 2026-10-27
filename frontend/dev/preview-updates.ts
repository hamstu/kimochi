/**
 * DEV-ONLY: the self-update commands for the browser preview (`preview-setup.ts`), with a
 * simulated check, download and install that emit `update-status` like `src-tauri/src/updater.rs`.
 *
 *   ?update=idle|none|available|downloading|ready|failed|checking   the starting state
 *                                                                   (default: none, up to date)
 *
 * `changelog` answers with a sample CHANGELOG.md (Unreleased, then 0.1.0, the running version, and
 * two older releases) for What's new; the offered 0.2.0's notes are the manifest's.
 *
 * Check for updates finds 0.2.0 unless the page started `none`, in which case it stays up to
 * date. The install cannot restart a browser tab: it ends in a failure after a moment, which is
 * the one state no other seed reaches.
 */
import { emit } from '@tauri-apps/api/event'
import type { UpdateStatus } from '@ui/update'

const CURRENT = '0.1.0'
const OFFERED = '0.2.0'
const SIZE = 91_300_000

/** The offered release's notes, as `latest.json` carries them: its CHANGELOG.md section. */
const OFFERED_NOTES = `### Added

- Kimochi updates itself. A found update appears above Settings in the sidebar, where you download
  it and choose when to restart.
- **What's new** shows what changed in each release, and opens once on its own after an update.

### Fixed

- The sidebar's source picker no longer flickers when a window is renamed.`

/** A CHANGELOG.md as the app embeds it (the \`changelog\` command). */
export const SAMPLE_CHANGELOG = `# Changelog

What changed in each release of Kimochi, newest first.

## [Unreleased]

### Added

- Kimochi updates itself.

## [0.1.0] - 2026-09-28

### Added

- Quick Shot: a single scan of the chosen region from anywhere, with \`⌘⇧J\`.
- Sessions can be renamed and given a description from the session menu.
- Hachidori and 10ten as dictionary engines, beside Yomitan. See the
  [dictionary guide](https://github.com/hamstu/kimochi#dictionaries).

### Changed

- The Log keeps its place while new lines arrive if you have scrolled up to read.
- Settings open in the main window instead of their own.

### Fixed

- OCR no longer misses the last line of a text box that touches the region's edge.
- The overlay follows a window that moves between displays.

## [0.0.2] - 2026-08-30

### Fixed

- Clipboard lines that repeat the previous one are no longer logged twice.
- The tray icon is legible on a light menu bar.

## [0.0.1] - 2026-08-14

- First release: OCR of a game window, a transcript of what was read, and dictionary lookups on
  hover.

[Unreleased]: https://github.com/hamstu/kimochi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hamstu/kimochi/releases/tag/v0.1.0
`

function status(patch: Partial<UpdateStatus>): UpdateStatus {
  return {
    state: 'none',
    currentVersion: CURRENT,
    version: null,
    notes: null,
    date: null,
    size: null,
    receivedBytes: null,
    totalBytes: null,
    message: null,
    stage: null,
    checkedAt: Date.now() - 4 * 60_000,
    dismissed: false,
    automatic: true,
    ...patch
  }
}

const offered = (patch: Partial<UpdateStatus>): UpdateStatus =>
  status({
    version: OFFERED,
    notes: OFFERED_NOTES,
    date: '2026-10-12T09:00:00Z',
    size: SIZE,
    ...patch
  })

const seeded = new URLSearchParams(location.search).get('update')
const upToDate = seeded === 'none' || seeded === null
let current: UpdateStatus = (() => {
  switch (seeded) {
    case 'idle':
      return status({ state: 'idle', checkedAt: null })
    case 'checking':
      return status({ state: 'checking' })
    case 'available':
      return offered({ state: 'available' })
    case 'downloading':
      return offered({ state: 'downloading', receivedBytes: Math.round(SIZE * 0.32), totalBytes: SIZE })
    case 'ready':
      return offered({ state: 'ready', receivedBytes: SIZE, totalBytes: SIZE })
    case 'failed':
      return offered({
        state: 'failed',
        stage: 'download',
        message: 'Could not reach GitHub. Check your connection and try again.'
      })
    default:
      return status({})
  }
})()
let timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null = null

function publish(next: UpdateStatus): UpdateStatus {
  current = next
  void emit('update-status', next)
  return next
}

function stop(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}

function check(): UpdateStatus {
  if (['checking', 'downloading', 'ready', 'installing'].includes(current.state)) return current
  stop()
  timer = setTimeout(() => {
    timer = null
    publish(upToDate ? status({ state: 'none', checkedAt: Date.now() }) : offered({ state: 'available', checkedAt: Date.now() }))
  }, 1200)
  return publish({ ...current, state: 'checking', message: null, stage: null })
}

function download(): UpdateStatus {
  if (current.state === 'downloading' || current.state === 'ready') return current
  if (!current.version) throw 'invalid: there is no update to download'
  stop()
  let received = current.state === 'failed' ? 0 : (current.receivedBytes ?? 0)
  const step = SIZE / 40
  timer = setInterval(() => {
    received = Math.min(SIZE, received + step)
    if (received >= SIZE) {
      stop()
      publish(offered({ state: 'ready', receivedBytes: SIZE, totalBytes: SIZE }))
      return
    }
    publish(offered({ state: 'downloading', receivedBytes: Math.round(received), totalBytes: SIZE }))
  }, 250)
  return publish(offered({ state: 'downloading', receivedBytes: Math.round(received), totalBytes: SIZE }))
}

function install(): UpdateStatus {
  if (current.state === 'installing') return current
  if (current.state !== 'ready') throw 'invalid: no update has been downloaded'
  stop()
  timer = setTimeout(() => {
    timer = null
    publish(
      offered({
        state: 'failed',
        stage: 'install',
        receivedBytes: SIZE,
        totalBytes: SIZE,
        message: 'The preview cannot restart Kimochi.'
      })
    )
  }, 2500)
  return publish(offered({ state: 'installing', receivedBytes: SIZE, totalBytes: SIZE }))
}

/** Merged into the preview's command table. */
export const UPDATE_HANDLERS: Record<string, () => unknown> = {
  changelog: () => SAMPLE_CHANGELOG,
  update_status: () => current,
  update_check: check,
  update_download: download,
  update_cancel: () => {
    if (current.state !== 'downloading') return current
    stop()
    return publish(offered({ state: 'available' }))
  },
  update_install: install,
  update_retry: () => {
    if (current.state !== 'failed') return current
    return current.stage === 'install' ? (publish(offered({ state: 'ready', receivedBytes: SIZE, totalBytes: SIZE })), install()) : current.stage === 'download' ? download() : check()
  },
  update_dismiss: () => publish({ ...current, dismissed: true })
}
