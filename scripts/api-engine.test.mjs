/**
 * The Yomitan API engine stands on its own: it downloads nothing, installs no extension host, and
 * the overlay starts its lookups (Shift-hover and click over the text) without any of Built-in
 * Yomitan's files, splitting words through the browser's Yomitan over its API.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { build } from 'esbuild'

const outDir = await mkdtemp(path.join(tmpdir(), 'kimochi-api-engine-'))

async function bundle(entry, name, external = []) {
  const outfile = path.join(outDir, name)
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external
  })
  return import(pathToFileURL(outfile).href)
}

test('choosing the Yomitan API downloads nothing; every other engine downloads itself', async () => {
  const { downloadEngineFor } = await bundle('../ui/extension-download.ts', 'extension-download.mjs')
  assert.equal(downloadEngineFor('custom-api'), null)
  for (const engine of ['yomitan', 'hachidori', 'tenten']) assert.equal(downloadEngineFor(engine), engine)
})

test("the API lookup installs without Yomitan's files and splits words through the browser's API", async () => {
  // `/spike/…` is served only with Built-in Yomitan downloaded: left unresolved here, an import of
  // it would throw.
  const { installApiLookup, apiTokenize } = await bundle('../ui/api-lookup.js', 'api-lookup.mjs', ['/spike/*'])
  const calls = []
  const settings = { yomitanSettings: { popupType: 'custom-api', customApiUrl: '' }, superTexthooker: {} }
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async (command, args) => {
          calls.push([command, args])
          if (command === 'settings_get') return settings[args.key]
          if (command === 'yomitan_tokenize') return [{ text: '日本語' }]
          return null
        }
      },
      event: { listen: async () => () => {} }
    },
    addEventListener() {}
  }
  globalThis.document = { addEventListener() {} }
  try {
    await installApiLookup({ embedded: false })
    assert.deepEqual(await apiTokenize('日本語'), [{ text: '日本語' }])
    const tokenize = calls.find(([command]) => command === 'yomitan_tokenize')
    assert.equal(tokenize[1].baseUrl, 'http://127.0.0.1:19633', "the helper's default address")
    assert.equal(tokenize[1].body.text, '日本語')
  } finally {
    delete globalThis.window
    delete globalThis.document
  }
})

test('the overlay starts the Yomitan API on its own, as a ready dictionary', async () => {
  const source = await readFile(new URL('../ui/overlay.js', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('overlay.js', source, ts.ScriptTarget.Latest, true)
  const start = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'startApiEngine')
  assert.ok(start, 'overlay.js has startApiEngine')
  const installs = []
  const logged = []
  let settled = 0
  const apiPopupVisible = () => {}
  const context = vm.createContext({
    installApiLookup: async (options) => installs.push(options),
    apiPopupVisible,
    state: { yomitan: { ready: false } },
    settleBackend: () => settled++,
    log: (entry) => logged.push(entry.check)
  })
  vm.runInContext(`${start.getText(ast)}\nglobalThis.run = startApiEngine`, context)
  await context.run()
  assert.equal(JSON.stringify(installs), JSON.stringify([{ embedded: false }]), "no Yomitan frontend to switch")
  assert.equal(installs[0].onVisibilityChange, apiPopupVisible, 'its pop-up holds automatic OCR still while read')
  assert.equal(context.state.yomitan.ready, true, 'the pointer replay and the controller see a dictionary')
  assert.equal(settled, 1)
  assert.equal(logged.join(), "dictionary-api-ready")
  // And it is the path taken for the Yomitan API, ahead of "no engine downloaded".
  assert.match(source, /hostedEngine === NO_ENGINE && dictionaryEngineOf\(setting\('yomitanSettings'\)\?\.popupType\) === 'custom-api'/)
  assert.match(source, /\(apiEngine\s*\?\s*startApiEngine\(\)/)
})
