/**
 * The reading-time rule (frontend/texthooker/lib/readingTime.ts) against the cases in
 * scripts/fixtures/reading-time.json, which the native exports (`with_read_time` in
 * src-tauri/src/reading_history.rs) are tested with too.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const built = await build({
  entryPoints: [fileURLToPath(new URL('../frontend/texthooker/lib/readingTime.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node'
})
const rule = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const fixture = JSON.parse(readFileSync(new URL('./fixtures/reading-time.json', import.meta.url), 'utf8'))

for (const c of fixture.cases) {
  test(c.name, () => {
    assert.deepEqual(rule.creditLines(c.lines, c.ceilingMs), c.credits)
  })
}

test('a reading day starts at 4 am where it was read', () => {
  for (const d of fixture.days) assert.equal(rule.readingDay(d.ts, d.tz), d.day, d.why)
})
