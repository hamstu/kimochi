/**
 * The release `npm run dev`'s server serves an engine from (scripts/ext-dev-server.mjs
 * `engineServing`) must be the one native serves and names in Settings → Dictionary
 * (extension_store.rs `serving_files`): the pinned download, else the earlier release an app
 * update left in use while the new one downloads, else the developer cache. When it was not, an
 * earlier Built-in Yomitan in use during a background update answered 404 for /settings.html and
 * /popup.html in dev, and the reader said "Yomitan could not start".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { engineServing, engineTree } from './ext-dev-server.mjs'

const root = await mkdtemp(path.join(tmpdir(), 'kimochi-dev-serving-'))
test.after(() => rm(root, { recursive: true, force: true }))

/** A pin of `yomitan` at 2.0 with two earlier releases, an empty store and no developer cache. */
async function setup(name) {
  const extensions = path.join(root, name, 'extensions')
  const store = path.join(root, name, 'store')
  await mkdir(extensions, { recursive: true })
  await mkdir(store, { recursive: true })
  await writeFile(path.join(extensions, 'yomitan.source.json'), JSON.stringify({ version: '2.0' }))
  await writeFile(path.join(extensions, 'yomitan.sha256.json'), JSON.stringify({ 'settings.html': 'a', 'new.js': 'b' }))
  await writeFile(
    path.join(extensions, 'yomitan.previous.json'),
    JSON.stringify([
      { version: '1.5', files: { 'settings.html': 'c', 'old15.js': 'd' } },
      { version: '1.0', files: { 'settings.html': 'e', 'old10.js': 'f' } }
    ])
  )
  const install = (version) => mkdir(path.join(store, 'yomitan', version), { recursive: true })
  const cache = async () => {
    await mkdir(path.join(extensions, 'yomitan'), { recursive: true })
    await writeFile(path.join(extensions, 'yomitan', 'manifest.json'), '{}')
  }
  const serving = (env = {}) => engineServing('yomitan', { env, store, extensions })
  return { store, extensions, install, cache, serving }
}

test('the pinned download wins over everything', async () => {
  const s = await setup('pinned')
  await s.cache()
  await s.install('1.5')
  await s.install('2.0')
  const serving = await s.serving()
  assert.equal(serving.version, '2.0')
  assert.equal(serving.dir, path.join(s.store, 'yomitan', '2.0'))
  assert.equal(serving.source, 'downloaded')
  assert.deepEqual(Object.keys(serving.files).sort(), ['new.js', 'settings.html'])
})

test('during an update the newest earlier release on disk is served, with its own files, before the cache', async () => {
  const s = await setup('previous')
  await s.cache()
  await s.install('1.0')
  await s.install('1.5')
  const serving = await s.serving()
  assert.equal(serving.version, '1.5', 'the newest earlier release, as installed_previous picks')
  assert.equal(serving.dir, path.join(s.store, 'yomitan', '1.5'))
  assert.deepEqual(Object.keys(serving.files).sort(), ['old15.js', 'settings.html'], "that release's file map, not the pin's")
  // Also with the real download tested (no developer cache).
  assert.equal((await s.serving({ KIMOCHI_EXTENSIONS_NO_DEV_TREE: '1' })).version, '1.5')
  assert.equal(await engineTree('yomitan', { env: {}, store: s.store, extensions: s.extensions }), serving.dir)
})

test('with nothing downloaded: the developer cache under the pin, unless it is switched off', async () => {
  const s = await setup('cache')
  assert.equal(await s.serving(), null)
  await s.cache()
  const serving = await s.serving()
  assert.equal(serving.source, 'development')
  assert.equal(serving.version, '2.0')
  assert.equal(serving.dir, path.join(s.extensions, 'yomitan'))
  assert.equal(await s.serving({ KIMOCHI_EXTENSIONS_NO_DEV_TREE: '1' }), null)
})

test('a release too old to be in previous.json is never served', async () => {
  const s = await setup('stale')
  await s.install('0.9')
  assert.equal(await s.serving({ KIMOCHI_EXTENSIONS_NO_DEV_TREE: '1' }), null)
})

test("the app origin's Yomitan paths are the served release's, not the pin's", async () => {
  const { readFile } = await import('node:fs/promises')
  const config = await readFile(new URL('../vite.dev.config.ts', import.meta.url), 'utf8')
  assert.match(config, /engineServing\('yomitan'\)/)
  assert.match(config, /serving\.files/)
  assert.doesNotMatch(config, /yomitan\.sha256\.json/, "a fixed list of the pin's files would 404 an earlier release's own")
})
