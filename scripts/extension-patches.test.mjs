/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node regression harness. */
/**
 * Kimochi's edits to the pinned extensions (host/ext/patches.json) still fit them. Runs against
 * the trees `npm test`'s pretest unpacks from the pins (scripts/sync-extension.mjs), so moving a
 * pin fails here first when upstream renamed or moved what a patch relies on. The behaviour the
 * patches give is checked in a real browser by `npm run test:engines`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { PATCHES, applyPatches, patchProblems } from './extension-patches.mjs'

const tree = (engine, file) => new URL(`../extensions/${engine}/${file}`, import.meta.url)

test('every patch names an engine file, a reason and what it relies on', () => {
  assert.ok(PATCHES.length > 0)
  const ids = new Set()
  for (const patch of PATCHES) {
    assert.ok(!ids.has(patch.id), `duplicate patch id ${patch.id}`)
    ids.add(patch.id)
    for (const key of ['engine', 'file', 'why', 'find', 'replace']) {
      assert.equal(typeof patch[key], 'string', `${patch.id}.${key}`)
      assert.ok(patch[key].length > 0, `${patch.id}.${key} is empty`)
    }
    assert.ok(Array.isArray(patch.requires) && patch.requires.length > 0, `${patch.id} lists what it requires`)
    assert.ok(patch.replace.includes(patch.find.replace(/\s*\}\);$/, '')), `${patch.id} keeps what it replaces`)
  }
})

for (const patch of PATCHES) {
  test(`${patch.id} applies to the pinned ${patch.engine}/${patch.file}, and the result still parses`, async () => {
    const source = await readFile(tree(patch.engine, patch.file), 'utf8')
    assert.deepEqual(patchProblems(patch, source), [])
    const { text, skipped } = applyPatches(patch.engine, patch.file, source)
    assert.deepEqual(skipped, [])
    assert.equal(text.split(patch.replace).length - 1, 1)
    // Compiles without running: a classic script, as the host injects content scripts.
    assert.doesNotThrow(() => new vm.Script(text, { filename: `${patch.engine}/${patch.file}` }))
  })
}

test('a file the find is missing from, or repeated in, is served as it is', () => {
  const [patch] = PATCHES
  const missing = applyPatches(patch.engine, patch.file, 'start();')
  assert.equal(missing.text, 'start();')
  assert.deepEqual(missing.skipped, [patch.id])
  const twice = `${patch.find}\n${patch.find}`
  assert.equal(applyPatches(patch.engine, patch.file, twice).text, twice)
  assert.equal(applyPatches(patch.engine, 'other.js', patch.find).text, patch.find)
  assert.match(patchProblems(patch, 'nothing here').join('\n'), /occurs 0 times/)
})
