import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { load } from './load.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

const {
  UNRELEASED,
  comingTitle,
  launchAnnouncement,
  offeredRelease,
  parseChangelog,
  releaseDate,
  releasedSections,
  whatsNewEntries
} = await load('changelog.ts')

const FULL = `# Changelog

What changed in each release, newest first.

## [Unreleased]

- Something on main.

## [0.2.0] - 2026-10-13

### Added

- Kimochi updates itself.
- A changelog.

### Fixed

- The sidebar no longer flickers.

## [0.1.0] - 2026-09-01

- First release.

[Unreleased]: https://github.com/hamstu/kimochi/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/hamstu/kimochi/releases/tag/v0.2.0
`

const ONLY_UNRELEASED = `# Changelog

Preamble.

## [Unreleased]

### Added

- Kimochi updates itself.
`

const status = (patch) => ({
  state: 'available',
  currentVersion: '0.1.0',
  version: '0.2.0',
  notes: '### Added\n\n- Self-updates',
  date: null,
  size: null,
  receivedBytes: null,
  totalBytes: null,
  message: null,
  stage: null,
  checkedAt: null,
  dismissed: false,
  automatic: true,
  ...patch
})

test('parseChangelog: sections in file order, preamble and link references left out', () => {
  const sections = parseChangelog(FULL)
  assert.deepEqual(
    sections.map((s) => [s.version, s.date]),
    [
      [UNRELEASED, null],
      ['0.2.0', '2026-10-13'],
      ['0.1.0', '2026-09-01']
    ]
  )
  assert.equal(sections[0].body, '- Something on main.')
  assert.equal(sections[2].body, '- First release.')
  assert.ok(!sections.some((s) => s.body.includes('https://')))
  assert.ok(!sections.some((s) => s.body.includes('Preamble') || s.body.includes('newest first')))
})

test('parseChangelog: a section keeps its ### subsections in its body', () => {
  const [, release] = parseChangelog(FULL)
  assert.equal(
    release.body,
    '### Added\n\n- Kimochi updates itself.\n- A changelog.\n\n### Fixed\n\n- The sidebar no longer flickers.'
  )
})

test('parseChangelog: heading variants', () => {
  const sections = parseChangelog(
    '## v1.0.0 (2027-01-02)\n- a\n## [1.0.0-beta.1] — 2026-12-01\n- b\n## Notes\n- still beta\n## unreleased\n- c\r\n'
  )
  assert.deepEqual(
    sections.map((s) => [s.version, s.date]),
    [
      ['1.0.0', '2027-01-02'],
      ['1.0.0-beta.1', '2026-12-01'],
      [UNRELEASED, null]
    ]
  )
  // A `## ` heading that is not a version stays in the section it falls in.
  assert.equal(sections[1].body, '- b\n## Notes\n- still beta')
  assert.equal(sections[2].body, '- c')
})

test('parseChangelog: a malformed file has no sections', () => {
  assert.deepEqual(parseChangelog('# Changelog\n\nNothing here yet.\n\n- stray bullet\n'), [])
  assert.deepEqual(parseChangelog(''), [])
  assert.deepEqual(parseChangelog(null), [])
  assert.deepEqual(parseChangelog(undefined), [])
  assert.deepEqual(releasedSections('just text'), [])
  assert.deepEqual(whatsNewEntries('just text', '0.1.0'), [])
})

test('releasedSections drops Unreleased', () => {
  assert.deepEqual(
    releasedSections(FULL).map((s) => s.version),
    ['0.2.0', '0.1.0']
  )
  assert.deepEqual(releasedSections(ONLY_UNRELEASED), [])
})

test('whatsNewEntries: the released versions, newest first, the running one marked', () => {
  const entries = whatsNewEntries(FULL, '0.2.0')
  assert.deepEqual(
    entries.map((e) => [e.version, e.current]),
    [
      ['0.2.0', true],
      ['0.1.0', false]
    ]
  )
  // A build that is not in the file (a dev build ahead of the last release) marks nothing.
  assert.ok(whatsNewEntries(FULL, '0.3.0').every((e) => !e.current))
})

test('whatsNewEntries: with no released section, Unreleased is shown as the running version', () => {
  const entries = whatsNewEntries(ONLY_UNRELEASED, '0.1.0')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].version, '0.1.0')
  assert.equal(entries[0].date, null)
  assert.equal(entries[0].current, true)
  assert.match(entries[0].body, /^### Added\n\n- Kimochi updates itself\.$/)
  // ...but an empty Unreleased shows nothing.
  assert.deepEqual(whatsNewEntries('## [Unreleased]\n\n', '0.1.0'), [])
})

test('whatsNewEntries: the repository CHANGELOG.md yields something to show once it lists anything', async () => {
  const text = await readFile(`${root}CHANGELOG.md`, 'utf8')
  // Before the first release the file may hold nothing but an empty Unreleased.
  if (!/^- /m.test(text)) return assert.deepEqual(whatsNewEntries(text, '0.0.0-test'), [])
  assert.ok(whatsNewEntries(text, '0.0.0-test').length > 0)
})

test('offeredRelease: only while an update with notes is offered', () => {
  assert.deepEqual(offeredRelease(status({})), { version: '0.2.0', notes: '### Added\n\n- Self-updates' })
  for (const state of ['downloading', 'ready', 'failed'])
    assert.equal(offeredRelease(status({ state }))?.version, '0.2.0', state)
  for (const state of ['idle', 'checking', 'none', 'installing'])
    assert.equal(offeredRelease(status({ state })), null, state)
  assert.equal(offeredRelease(status({ version: null })), null)
  assert.equal(offeredRelease(status({ version: '0.1.0' })), null)
  assert.equal(offeredRelease(status({ notes: '  ' })), null)
  assert.equal(offeredRelease(status({ notes: null })), null)
  assert.equal(offeredRelease(null), null)
})

test('wording', () => {
  assert.equal(comingTitle('0.2.0'), 'Coming in Kimochi 0.2.0')
  assert.equal(releaseDate('2026-10-13'), '13 Oct 2026')
  assert.equal(releaseDate('2026-01-05'), '5 Jan 2026')
  assert.equal(releaseDate('soon'), 'soon')
  assert.equal(releaseDate('2026-13-01'), '2026-13-01')
  assert.equal(releaseDate(null), null)
})

test('launchAnnouncement: record when unset, show when different, none when seen', () => {
  assert.equal(launchAnnouncement(null, '0.2.0'), 'record')
  assert.equal(launchAnnouncement(undefined, '0.2.0'), 'record')
  assert.equal(launchAnnouncement('', '0.2.0'), 'record')
  assert.equal(launchAnnouncement(42, '0.2.0'), 'record')
  assert.equal(launchAnnouncement('0.1.0', '0.2.0'), 'show')
  assert.equal(launchAnnouncement('0.3.0', '0.2.0'), 'show')
  assert.equal(launchAnnouncement('0.2.0', '0.2.0'), 'none')
})
