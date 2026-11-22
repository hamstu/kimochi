import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ENGINES, MIRROR, manifestPath } from './texthook-package.mjs'

// The committed manifest is generated from the pins in texthook-package.mjs; a pin moved without
// running the script (or a hand edit of the manifest) shows up here, offline.
test('the text hooker manifest lists exactly the pinned files, upstream first, mirror second', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.deepEqual(Object.keys(manifest.engines).sort(), Object.keys(ENGINES).sort())
  for (const [id, engine] of Object.entries(ENGINES)) {
    const listed = manifest.engines[id]
    assert.equal(listed.version, engine.version, id)
    assert.deepEqual(
      listed.files.map((f) => f.name),
      Object.keys(engine.files),
      id
    )
    for (const file of listed.files) {
      const spec = engine.files[file.name]
      assert.match(file.sha256, /^[0-9a-f]{64}$/)
      assert.ok(file.size > 0)
      const [upstream, mirror] = file.sources
      if (spec.xz) {
        // Compressed upstream and on the mirror: the pin names both forms.
        assert.deepEqual(upstream, { url: spec.xz, xz: true })
        assert.deepEqual(mirror, { url: `${MIRROR}/${id}/${engine.version}/${file.name}.xz`, xz: true })
        assert.match(file.xz.sha256, /^[0-9a-f]{64}$/)
        assert.ok(file.xz.size > 0 && file.xz.size < file.size)
        continue
      }
      assert.equal(file.xz, undefined)
      if (spec.entry) assert.deepEqual(upstream, { url: engine.zip, zipEntry: spec.entry })
      else assert.deepEqual(upstream, { url: spec.url })
      assert.deepEqual(mirror, { url: `${MIRROR}/${id}/${engine.version}/${file.name}` })
      assert.ok(file.sources.every((s) => s.url.startsWith('https://')))
    }
  }
})

test('every engine ships its licence with the download', () => {
  for (const engine of Object.values(ENGINES)) assert.ok('LICENSE.txt' in engine.files)
})
