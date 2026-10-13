/**
 * What's new: the embedded `CHANGELOG.md` (the `changelog` command; COMMANDS.md → App updates),
 * parsed into its version sections, and the decisions the dialog and the main window make with it.
 *
 * The file follows Keep a Changelog: `## [Unreleased]`, then `## [0.2.0] - 2026-10-13` and older,
 * newest first, each with optional `### Added` / `### Changed` / `### Fixed` / `### Removed`
 * headings and `- ` bullets. Pure: no DOM, no IPC (unit-tested in scripts/changelog-ui.test.mjs).
 */
import type { UpdateStatus } from './update'

export interface ChangelogSection {
  /** `'Unreleased'` or a version (`'0.2.0'`, `'1.0.0-beta.1'`). */
  version: string
  /** The release date as written (`YYYY-MM-DD`), or null (Unreleased, or none given). */
  date: string | null
  /** The section's markdown below its heading, trimmed. */
  body: string
}

/** A section as the dialog shows it. */
export interface WhatsNewEntry extends ChangelogSection {
  /** The running build's version. */
  current: boolean
}

export const UNRELEASED = 'Unreleased'

/**
 * A version heading: `## [0.2.0] - 2026-10-13`, `## 0.2.0 (2026-10-13)`, `## [Unreleased]`.
 * Any other `## ` heading is not a version and stays in the body of the section it falls in.
 */
const HEADING =
  /^##\s+\[?(unreleased|v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\]?(?:\s*[-–—(]\s*(\d{4}-\d{2}-\d{2})\)?)?\s*$/i
/** A link reference definition (`[0.2.0]: https://…`), which Keep a Changelog puts at the end. */
const LINK_REFERENCE = /^\[[^\]]+\]:\s*\S+/

/**
 * Every version section, in file order (newest first: Unreleased, then the releases). Text above
 * the first version heading (the title and preamble) is not part of any section. A file with no
 * version headings, or no text at all, has no sections.
 */
export function parseChangelog(text: string | null | undefined): ChangelogSection[] {
  if (typeof text !== 'string') return []
  const sections: ChangelogSection[] = []
  let open: { version: string; date: string | null; lines: string[] } | null = null
  const close = (): void => {
    if (open) sections.push({ version: open.version, date: open.date, body: open.lines.join('\n').trim() })
  }
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = HEADING.exec(line.trim())
    if (heading) {
      close()
      const name = heading[1]
      open = {
        version: name.toLowerCase() === 'unreleased' ? UNRELEASED : name.replace(/^v/i, ''),
        date: heading[2] ?? null,
        lines: []
      }
    } else if (open && !LINK_REFERENCE.test(line.trim())) {
      open.lines.push(line)
    }
  }
  close()
  return sections
}

/** The released versions only, newest first (Unreleased dropped). */
export const releasedSections = (text: string | null | undefined): ChangelogSection[] =>
  parseChangelog(text).filter((section) => section.version !== UNRELEASED)

/**
 * What the dialog lists, newest first, with the running version marked.
 *
 * THE RULE: the released sections, when there are any. While the changelog has none (the first
 * release has not been cut: only Unreleased is written), the Unreleased section is shown instead,
 * titled by the running version and marked as it, so What's new is never empty. An Unreleased
 * section with nothing in it shows nothing either; then the list is empty.
 */
export function whatsNewEntries(text: string | null | undefined, currentVersion: string): WhatsNewEntry[] {
  const sections = parseChangelog(text)
  const released = sections.filter((section) => section.version !== UNRELEASED)
  if (released.length > 0)
    return released.map((section) => ({ ...section, current: section.version === currentVersion }))
  const unreleased = sections.find((section) => section.version === UNRELEASED)
  if (!unreleased || !unreleased.body) return []
  return [{ version: currentVersion, date: null, body: unreleased.body, current: true }]
}

/**
 * The offered release, while an update is offered: the version and its notes from the manifest
 * (markdown), for "Coming in Kimochi x.y.z" above the history. Null when nothing is offered, the
 * offer is the running version, or the manifest carried no notes.
 */
export function offeredRelease(status: UpdateStatus | null): { version: string; notes: string } | null {
  if (!status || !status.version || status.version === status.currentVersion) return null
  const offering =
    status.state === 'available' ||
    status.state === 'downloading' ||
    status.state === 'ready' ||
    status.state === 'failed'
  const notes = status.notes?.trim()
  return offering && notes ? { version: status.version, notes } : null
}

export const WHATS_NEW_TITLE = "What's new in Kimochi"

/** The offered release's heading. */
export const comingTitle = (version: string): string => `Coming in Kimochi ${version}`

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-10-13` as "13 Oct 2026"; anything else as written; null as null. */
export function releaseDate(date: string | null): string | null {
  if (!date) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return date
  const month = MONTHS[Number(match[2]) - 1]
  return month ? `${Number(match[3])} ${month} ${match[1]}` : date
}

/**
 * Whether the main window announces this version on launch, given the `lastSeenVersion` setting:
 * - `record`: never set (a fresh install, or the first build that keeps the setting): store the
 *   running version without a word.
 * - `show`: a different version was last seen (an update, or a downgrade): open What's new once
 *   and store the running version.
 * - `none`: already seen.
 */
export function launchAnnouncement(lastSeen: unknown, currentVersion: string): 'record' | 'show' | 'none' {
  if (typeof lastSeen !== 'string' || lastSeen.trim() === '') return 'record'
  return lastSeen.trim() === currentVersion ? 'none' : 'show'
}
