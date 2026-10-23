/**
 * Settings → Anki's "Open Built-in Yomitan Anki settings" (frontend/panels/dictionarySection.ts):
 * Yomitan's settings page lays itself out only once settings-main.js has set
 * `<html data-loaded="true">`, so a `#anki` fragment in the frame's first URL left the page at the
 * top. The section is scrolled to once the page says it has loaded, and not before.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const outDir = await mkdtemp(path.join(tmpdir(), 'kimochi-dictionary-section-'))
const outfile = path.join(outDir, 'section.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../frontend/panels/dictionarySection.ts', import.meta.url))],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022'
})
const { revealSectionWhenLoaded } = await import(pathToFileURL(outfile).href)
test.after(() => rm(outDir, { recursive: true, force: true }))

/** A settings page that finishes loading after `loadsAfter` looks, with the given sections. */
function page({ loadsAfter = 0, sections = ['anki'] } = {}) {
  const scrolled = []
  let looks = 0
  const doc = {
    documentElement: {
      dataset: new Proxy({}, { get: (_, key) => (key === 'loaded' && looks++ >= loadsAfter ? 'true' : undefined) })
    },
    getElementById: (id) =>
      sections.includes(id) ? { scrollIntoView: (options) => scrolled.push({ id, options, looks }) } : null
  }
  return { doc, scrolled, looks: () => looks }
}
const fast = { wait: async () => {}, nextFrame: async () => {}, intervalMs: 100 }

test('the section is scrolled to only after the page has loaded', async () => {
  const p = page({ loadsAfter: 3 })
  assert.equal(await revealSectionWhenLoaded(() => p.doc, 'anki', fast), true)
  assert.equal(p.scrolled.length, 1)
  assert.equal(p.scrolled[0].id, 'anki')
  assert.deepEqual(p.scrolled[0].options, { block: 'start' })
  assert.ok(p.scrolled[0].looks > 3, 'not before data-loaded was true')
})

test('an already loaded page (the window was open) scrolls at once', async () => {
  const p = page()
  let waits = 0
  assert.equal(await revealSectionWhenLoaded(() => p.doc, 'anki', { ...fast, wait: async () => void waits++ }), true)
  assert.equal(waits, 0)
})

test('the scroll waits for the new layout to paint', async () => {
  const p = page()
  const order = []
  await revealSectionWhenLoaded(() => p.doc, 'anki', {
    ...fast,
    nextFrame: async () => void order.push('frame')
  })
  order.push(...p.scrolled.map(() => 'scroll'))
  assert.deepEqual(order, ['frame', 'scroll'])
})

test('a page that never finishes, a missing section or no document gives up quietly', async () => {
  const never = page({ loadsAfter: Infinity })
  assert.equal(await revealSectionWhenLoaded(() => never.doc, 'anki', { ...fast, timeoutMs: 1000 }), false)
  assert.equal(never.scrolled.length, 0)
  assert.ok(never.looks() <= 12, 'bounded by the timeout')
  const other = page({ sections: [] })
  assert.equal(await revealSectionWhenLoaded(() => other.doc, 'anki', fast), false)
  assert.equal(await revealSectionWhenLoaded(() => null, 'anki', fast), false)
})

test('the dictionary window uses it for Built-in Yomitan on load, and leaves Hachidori to its own fragment', async () => {
  const panel = await readFile(new URL('../frontend/panels/DictionarySettingsPanel.tsx', import.meta.url), 'utf8')
  assert.match(panel, /engine === 'yomitan' \? first\.section : null/)
  assert.match(panel, /onLoad=\{\(\) => \{\s*setLoaded\(true\)\s*revealYomitanSection\(\)/)
  assert.match(panel, /revealSectionWhenLoaded\(\(\) => frameDocument\(frame\.current\), section\)/)
})
