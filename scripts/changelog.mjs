// CHANGELOG.md, read and rewritten for releases. The file is Keep a Changelog
// (https://keepachangelog.com/en/1.1.0/): a free-form preamble, then one `## [Unreleased]` section
// and one `## [x.y.z] - YYYY-MM-DD` section per release, newest first, each holding `- ` bullets,
// optionally under `### Added` / `### Changed` / `### Fixed` / `### Removed`.
//
//   node scripts/changelog.mjs section <x.y.z>
//       Prints that version's section (the markdown under its heading). CI's plan job uses it as
//       the GitHub release's notes, which the manifest job then copies into latest.json, so the
//       app's "What's new" and the release page say the same thing.
//
//   node scripts/changelog.mjs promote <x.y.z> [--date YYYY-MM-DD]
//       Moves everything under Unreleased into a new `## [x.y.z] - <date>` section (today, local
//       time, by default) and leaves an empty Unreleased above it. scripts/cut-release.mjs does
//       this as part of `npm run release -- <x.y.z>`; run it alone only to preview or repair.
//
// Link reference definitions at the end of the file (`[0.2.0]: https://...`) are kept apart
// from the last section's body. When an `[Unreleased]: <repo>/compare/<tag>...HEAD` link is
// there, a promotion points it at the new tag and adds the new version's link below it.
//
// Text in, text out: the helpers never reformat what they do not move, so a promotion's diff is
// exactly the new heading (and the links, when the file has them).
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url))

// Only the versions the release tooling produces: plain x.y.z, no pre-release suffix (the
// manifest job and cut-release.mjs accept nothing else either).
const VERSION = /^\d+\.\d+\.\d+$/
const HEADING = /^## \[(Unreleased|\d+\.\d+\.\d+)\](?: - (\d{4}-\d{2}-\d{2}))?[ \t]*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const LINK = /^\[[^\]]+\]:\s*\S+/
const UNRELEASED_LINK = /^\[Unreleased\]:[ \t]*(\S+?)\/compare\/\S+\.\.\.HEAD[ \t]*$/m

/**
 * Splits the changelog at its `## [...]` headings. `body` is the section's markdown, trimmed;
 * `links` is the block of link reference definitions that ends the file, if any.
 * A `## ` heading of any other shape is an error rather than silently part of the section above:
 * a typo in a version heading would otherwise hide that release's notes.
 */
export function parseChangelog(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const sections = []
  const preamble = []
  let current = null
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const m = HEADING.exec(line)
      if (!m) throw new Error(`unrecognised changelog heading: ${line}`)
      if (m[1] !== 'Unreleased' && !m[2]) throw new Error(`release heading without a date: ${line}`)
      if (sections.some((s) => s.version === m[1])) throw new Error(`two changelog sections for ${m[1]}`)
      current = { version: m[1], date: m[2] ?? null, lines: [] }
      sections.push(current)
    } else if (current) {
      current.lines.push(line)
    } else {
      preamble.push(line)
    }
  }
  // Peel the trailing link definitions off whatever came last.
  const tail = sections.length ? sections[sections.length - 1].lines : preamble
  const links = []
  while (tail.length && (!tail[tail.length - 1].trim() || LINK.test(tail[tail.length - 1]))) {
    const line = tail.pop()
    if (line.trim()) links.unshift(line.trimEnd())
  }
  return {
    preamble: preamble.join('\n').trim(),
    sections: sections.map(({ version, date, lines }) => ({ version, date, body: lines.join('\n').trim() })),
    links: links.join('\n')
  }
}

/** The markdown under a version's heading (`Unreleased` works too). Throws if there is none. */
export function sectionFor(text, version) {
  const section = parseChangelog(text).sections.find((s) => s.version === version)
  if (!section) throw new Error(`CHANGELOG.md has no section for ${version}`)
  return section.body
}

/** Whether a section body lists anything: subsection headings alone are not entries. */
export const hasEntries = (body) => /^- /m.test(body)

/**
 * The changelog with Unreleased's entries moved under `## [version] - date`, and an empty
 * Unreleased left at the top for the next round. Everything else is kept byte for byte.
 */
export function promoteUnreleased(text, version, date) {
  if (!VERSION.test(version)) throw new Error(`not a version (x.y.z): ${version}`)
  if (!DATE.test(date)) throw new Error(`not a date (YYYY-MM-DD): ${date}`)
  const { sections } = parseChangelog(text)
  if (sections.some((s) => s.version === version)) throw new Error(`CHANGELOG.md already has a section for ${version}`)
  const unreleased = sections.find((s) => s.version === 'Unreleased')
  if (!unreleased) throw new Error('CHANGELOG.md has no ## [Unreleased] section')
  if (!hasEntries(unreleased.body)) {
    throw new Error('CHANGELOG.md has nothing under Unreleased: add a "- " line for what this release changes first')
  }
  // Insert the new heading right after Unreleased's, so the entries (and the blank lines around
  // them) stay where they are and now sit under the version.
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const heading = /^## \[Unreleased\][ \t]*$/m.exec(text)
  const end = heading.index + heading[0].length
  const promoted = `${text.slice(0, end)}${newline}${newline}## [${version}] - ${date}${text.slice(end)}`
  return promoted.replace(
    UNRELEASED_LINK,
    (_, base) => `[Unreleased]: ${base}/compare/v${version}...HEAD${newline}[${version}]: ${base}/releases/tag/v${version}`
  )
}

/** Today in local time as YYYY-MM-DD: the date the person cutting the release sees. */
export function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const [command, version, ...rest] = process.argv.slice(2)
  try {
    if (command === 'section' && version) {
      const body = sectionFor(readFileSync(file, 'utf8'), version)
      // An empty section would publish a release with no notes; fail the job instead.
      if (!hasEntries(body)) throw new Error(`CHANGELOG.md's section for ${version} lists nothing`)
      process.stdout.write(`${body}\n`)
    } else if (command === 'promote' && version) {
      const at = rest.indexOf('--date')
      const date = at >= 0 ? rest[at + 1] : today()
      writeFileSync(file, promoteUnreleased(readFileSync(file, 'utf8'), version, date))
      console.log(`CHANGELOG.md: Unreleased is now ${version} (${date})`)
    } else {
      console.error('Usage: node scripts/changelog.mjs section <x.y.z>\n       node scripts/changelog.mjs promote <x.y.z> [--date YYYY-MM-DD]')
      process.exit(2)
    }
  } catch (error) {
    console.error(error.message ?? error)
    process.exit(1)
  }
}
