import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { hasEntries, parseChangelog, promoteUnreleased, sectionFor, today } from './changelog.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

const sample = `# Changelog

Preamble text.

## [Unreleased]

### Added

- A new thing,
  wrapped over two lines.

### Fixed

- A bug.

## [0.2.0] - 2026-10-13

- First public release.

## [0.1.0] - 2026-09-01

### Changed

- Something older.
`

test('a changelog splits into its preamble and sections, newest first', () => {
  const { preamble, sections } = parseChangelog(sample)
  assert.equal(preamble, '# Changelog\n\nPreamble text.')
  assert.deepEqual(
    sections.map(({ version, date }) => [version, date]),
    [
      ['Unreleased', null],
      ['0.2.0', '2026-10-13'],
      ['0.1.0', '2026-09-01']
    ]
  )
  assert.equal(sections[0].body, '### Added\n\n- A new thing,\n  wrapped over two lines.\n\n### Fixed\n\n- A bug.')
  assert.equal(sections[1].body, '- First public release.')
})

test('a malformed version heading is an error, not part of the section above', () => {
  assert.throws(() => parseChangelog('## [Unreleased]\n\n## 0.2.0\n'), /unrecognised changelog heading: ## 0.2.0/)
  assert.throws(() => parseChangelog('## [0.2.0]\n\n- x\n'), /without a date/)
  assert.throws(() => parseChangelog('## [0.2.0] - 2026-10-13\n## [0.2.0] - 2026-10-14\n'), /two changelog sections for 0.2.0/)
})

test("a version's section is its markdown, and a missing one throws", () => {
  assert.equal(sectionFor(sample, '0.1.0'), '### Changed\n\n- Something older.')
  assert.match(sectionFor(sample, 'Unreleased'), /^### Added/)
  assert.throws(() => sectionFor(sample, '0.3.0'), /no section for 0.3.0/)
})

test('promoting moves Unreleased under the version and leaves an empty Unreleased on top', () => {
  const next = promoteUnreleased(sample, '0.3.0', '2026-11-01')
  const { sections } = parseChangelog(next)
  assert.deepEqual(
    sections.map((s) => s.version),
    ['Unreleased', '0.3.0', '0.2.0', '0.1.0']
  )
  assert.equal(sections[0].body, '')
  assert.equal(sections[1].date, '2026-11-01')
  assert.equal(sections[1].body, parseChangelog(sample).sections[0].body)
  // Only the new heading is added; nothing else is reformatted.
  assert.equal(next, sample.replace('## [Unreleased]\n', '## [Unreleased]\n\n## [0.3.0] - 2026-11-01\n'))
})

test('promoting refuses an empty Unreleased, an existing version and malformed input', () => {
  const empty = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n## [0.2.0] - 2026-10-13\n\n- x\n'
  assert.equal(hasEntries(parseChangelog(empty).sections[0].body), false)
  assert.throws(() => promoteUnreleased(empty, '0.3.0', '2026-11-01'), /nothing under Unreleased/)
  assert.throws(() => promoteUnreleased(sample, '0.2.0', '2026-11-01'), /already has a section for 0.2.0/)
  assert.throws(() => promoteUnreleased('# Changelog\n', '0.3.0', '2026-11-01'), /no ## \[Unreleased\]/)
  assert.throws(() => promoteUnreleased(sample, 'v0.3.0', '2026-11-01'), /not a version/)
  assert.throws(() => promoteUnreleased(sample, '0.3.0', '1 Nov 2026'), /not a date/)
})

test('CRLF files keep their line endings', () => {
  const crlf = sample.replace(/\n/g, '\r\n')
  const next = promoteUnreleased(crlf, '0.3.0', '2026-11-01')
  assert.equal(next.replace(/\r\n/g, '').includes('\n'), false)
  assert.equal(sectionFor(next, '0.3.0'), sectionFor(sample, 'Unreleased'))
})

test('today is the local calendar date', () => {
  assert.equal(today(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
})

test('the repository changelog parses and has an Unreleased section', async () => {
  const text = await readFile(`${root}CHANGELOG.md`, 'utf8')
  assert.doesNotThrow(() => sectionFor(text, 'Unreleased'))
})

const linked = `# Changelog

## [Unreleased]

- Something on main.

## [0.2.0] - 2026-10-13

- First release.

[Unreleased]: https://github.com/hamstu/kimochi-tauri/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/hamstu/kimochi-tauri/releases/tag/v0.2.0
`

test('link definitions at the end are not part of the last section, and promotion extends them', () => {
  const { sections, links } = parseChangelog(linked)
  assert.equal(sections[1].body, '- First release.')
  assert.equal(links.split('\n').length, 2)
  const next = promoteUnreleased(linked, '0.3.0', '2026-11-01')
  assert.match(
    next,
    /\n\[Unreleased\]: https:\/\/github\.com\/hamstu\/kimochi-tauri\/compare\/v0\.3\.0\.\.\.HEAD\n\[0\.3\.0\]: https:\/\/github\.com\/hamstu\/kimochi-tauri\/releases\/tag\/v0\.3\.0\n\[0\.2\.0\]: /
  )
  assert.equal(sectionFor(next, '0.3.0'), '- Something on main.')
  assert.equal(parseChangelog(next).links.split('\n').length, 3)
})
