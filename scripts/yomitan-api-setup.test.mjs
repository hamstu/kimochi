/**
 * The Yomitan API setup's model (ui/yomitan-api-setup.ts): the API address, the wording of what is
 * installed, and the wizard's steps. Installed and reachable are separate facts; these pin that a
 * closed browser never reads as a broken install, and an answering API always counts as installed.
 * The manifest classification itself is Rust's (src-tauri/src/reader/yomitan_host.rs, cargo test).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const outDir = await mkdtemp(path.join(tmpdir(), 'kimochi-yomitan-api-setup-'))
const outfile = path.join(outDir, 'setup.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../ui/yomitan-api-setup.ts', import.meta.url))],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022'
})
const setup = await import(pathToFileURL(outfile).href)
test.after(() => rm(outDir, { recursive: true, force: true }))

const browser = (name, method, hostExists = true) => ({
  browser: name.toLowerCase(),
  browserName: name,
  manifestPath: `/m/${name}/yomitan_api.json`,
  hostPath: `/m/${name}/host`,
  method,
  hostExists,
  problem: hostExists ? null : 'The program this manifest names is missing.'
})
const host = (method, browsers) => ({ os: 'macos', installed: method !== null, method, browsers })
const api = (server, yomitan, version = null) => ({
  url: setup.DEFAULT_YOMITAN_API_URL,
  server,
  yomitan,
  yomitanVersion: version,
  latencyMs: server ? 2 : null,
  error: null
})

const NOTHING = host(null, [])
const KIMOCHI = host('kimochi', [browser('Chrome', 'kimochi'), browser('Brave', 'kimochi'), browser('Firefox', 'kimochi')])
const OFFICIAL = host('official', [browser('Chrome', 'official')])
const BROKEN = host(null, [browser('Chrome', 'kimochi', false)])

test('an empty address is the helper default', () => {
  assert.equal(setup.resolveYomitanApiUrl(''), 'http://127.0.0.1:19633')
  assert.equal(setup.resolveYomitanApiUrl('   '), 'http://127.0.0.1:19633')
  assert.equal(setup.resolveYomitanApiUrl(undefined), 'http://127.0.0.1:19633')
  assert.equal(setup.resolveYomitanApiUrl(' http://192.168.1.4:19633 '), 'http://192.168.1.4:19633')
})

test('what is installed, in words', () => {
  assert.equal(setup.describeHost(null), 'Checking this computer…')
  assert.equal(setup.describeHost(NOTHING), 'Not installed.')
  assert.match(setup.describeHost(BROKEN), /program is missing/)
  assert.equal(setup.describeHost(KIMOCHI), "Kimochi's helper, for Chrome, Brave and Firefox.")
  assert.equal(setup.describeHost(OFFICIAL), 'The official Yomitan API helper, for Chrome.')
  assert.deepEqual(setup.brokenBrowsers(BROKEN).map((b) => b.browserName), ['Chrome'])
  assert.deepEqual(setup.workingBrowsers(BROKEN), [])
})

test('installed and reachable stay separate', () => {
  assert.equal(setup.connectionState(null, null), 'checking')
  assert.equal(setup.connectionState(KIMOCHI, null), 'checking')
  // Installed, nothing answering: the browser is closed or the setting is off, not a broken install.
  assert.equal(setup.connectionState(KIMOCHI, api(false, false)), 'unreachable')
  assert.equal(setup.connectionState(NOTHING, api(false, false)), 'not-installed')
  // The helper answers without Yomitan behind it.
  assert.equal(setup.connectionState(KIMOCHI, api(true, false)), 'yomitan-silent')
  // An answering API wins even where no manifest was found (a helper somewhere unusual).
  assert.equal(setup.connectionState(NOTHING, api(true, true)), 'ready')
  assert.equal(setup.describeConnection('ready', api(true, true, '26.9.8.0')), 'Connected to Yomitan 26.9.8.0.')
  assert.match(setup.describeConnection('unreachable', api(false, false)), /open it/)
})

test('the wizard opens on the first step with something to do', () => {
  assert.equal(setup.initialStep(NOTHING, api(false, false)), 'helper')
  assert.equal(setup.initialStep(BROKEN, api(false, false)), 'helper')
  assert.equal(setup.initialStep(OFFICIAL, api(false, false)), 'enable')
  assert.equal(setup.initialStep(KIMOCHI, api(true, false)), 'connect')
  assert.equal(setup.initialStep(NOTHING, api(true, true)), 'connect')
})

test('steps tick off from what is true now', () => {
  const done = (h, a) => setup.SETUP_STEPS.filter((s) => setup.stepDone(s, h, a))
  assert.deepEqual(done(NOTHING, api(false, false)), [])
  assert.deepEqual(done(KIMOCHI, api(false, false)), ['helper'])
  assert.deepEqual(done(KIMOCHI, api(true, false)), ['helper', 'enable'])
  assert.deepEqual(done(NOTHING, api(true, true)), ['helper', 'enable', 'connect'])
})

test('lists read naturally', () => {
  assert.equal(setup.listNames([]), '')
  assert.equal(setup.listNames(['Chrome']), 'Chrome')
  assert.equal(setup.listNames(['Chrome', 'Firefox']), 'Chrome and Firefox')
  assert.equal(setup.listNames(['Chrome', 'Brave', 'Firefox']), 'Chrome, Brave and Firefox')
})
