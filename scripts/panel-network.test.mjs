/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node regression harness. */
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

import { YOMITAN_SHIMS, yomitanShimSource } from './yomitan-shims.mjs'

const shimSource = await yomitanShimSource('panel-shim.js')
const shim = await yomitanShimSource('panel-shim.js', { network: '__loadNetwork()' })
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../host/network-entry.js', import.meta.url))],
  bundle: true,
  write: false,
  format: 'iife',
  plugins: [
    {
      name: 'transport-boundaries',
      setup(build) {
        build.onResolve({ filter: /^(\.\/observe\.js|@tauri-apps\/plugin-http)$/ }, (args) => ({
          path: args.path,
          namespace: 'stub'
        }))
        build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: args.path.includes('observe')
            ? 'export const observeFrame = () => {}'
            : 'export const fetch = async (...args) => { globalThis.remoteCalls.push(args); return {remote:true} }'
        }))
      }
    }
  ]
})
const adapter = outputFiles[0].text

test('Windows IPC and capture use native fetch while external URLs use the scoped HTTP plugin', () => {
  const context = vm.createContext(
    { URL, EventTarget, Event, console, structuredClone },
    { microtaskMode: 'afterEvaluate' }
  )
  vm.runInContext(`
    window = globalThis; top = window;
    location = {href:'http://tauri.localhost/app/panel.html',origin:'http://tauri.localhost'};
    __KIMOCHI_PLATFORM__ = {os:'windows',arch:'x86_64'};
    __extensionHost = {};
    XMLHttpRequest = class {};
    localCalls = []; remoteCalls = [];
    fetch = async (input) => { localCalls.push(input); return {local:true} };
  `, context)
  vm.runInContext(adapter, context)
  vm.runInContext(`
    __extensionHost.installNetwork(window);
    fetch('http://ipc.localhost/settings_all');
    fetch('http://capture.localhost/live/1');
    fetch('https://example.test/dictionary.zip');
  `, context, { timeout: 500 })
  assert.deepEqual(Array.from(context.localCalls), [
    'http://ipc.localhost/settings_all', 'http://capture.localhost/live/1'
  ])
  assert.equal(context.remoteCalls.length, 1)
  assert.equal(context.remoteCalls[0][0], 'https://example.test/dictionary.zip')
})

test('panel startup keeps native local fetch when the deferred network adapter installs', () => {
  const context = vm.createContext(
    { URL, EventTarget, Event, console, structuredClone },
    { microtaskMode: 'afterEvaluate' }
  )
  vm.runInContext(
    `
    window = globalThis; top = window;
    location = {href:'tauri://localhost/app/panel.html',origin:'tauri://localhost',protocol:'tauri:',pathname:'/app/panel.html'};
    navigator = {language:'en'};
    document = {};
    addEventListener = () => {};
    XMLHttpRequest = class {};
    localCalls = []; remoteCalls = [];
    fetch = async (input) => { localCalls.push(input); return {json:async () => ({})} };
    __TAURI__ = {core:{invoke:async () => {}},event:{listen:async () => {}}};
    __loadNetwork = () => new Promise(resolve => { finishNetwork = resolve });
  `,
    context
  )
  vm.runInContext(shim, context)
  vm.runInContext(adapter, context)
  vm.runInContext(`finishNetwork();`, context, { timeout: 500 })
  // This used to recurse indefinitely: the installed wrapper captured the deferred
  // wrapper, which called the installed wrapper again for every local resource.
  vm.runInContext(`fetch('/manifest.json').then(() => { localDone = true });`, context, {
    timeout: 500
  })
  assert.equal(context.localDone, true)
  assert.equal(context.localCalls.filter((x) => x === '/manifest.json').length, 2)
  vm.runInContext(
    `fetch('https://example.test/dictionary.zip').then(() => { remoteDone = true });`,
    context,
    { timeout: 500 }
  )
  assert.equal(context.remoteDone, true)
  assert.equal(context.remoteCalls.length, 1)
})

/**
 * Native injects these files as document-start scripts for every frame, which is the
 * only way the popup's own iframe can have `chrome.*` before its first script runs.
 * An injected script has no module URL, so a root-relative dynamic import has nothing
 * to resolve against and throws before the request is made — which silently left the
 * original network adapter uninstalled in exactly the windows that download
 * dictionaries. Resolving against the document is what makes both deliveries work.
 */
test('host scripts that native injects resolve their own dynamic imports absolutely', async () => {
  const sources = [...new Set(Object.values(YOMITAN_SHIMS).concat('host/yomitan/common.js'))]
  for (const path of sources) {
    const source = (await readFile(new URL(`../${path}`, import.meta.url), 'utf8'))
      // The rule is about code, and the files explain it in prose above the fix.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    const rootRelative = [...source.matchAll(/\bimport\s*\(\s*['"](\/[^'"]*)['"]/g)].map(
      (match) => match[1]
    )
    assert.deepEqual(
      rootRelative,
      [],
      `${path} is injected without a module URL, so ${rootRelative.join(', ')} cannot resolve`
    )
  }
  // The bundles are what native injects; esbuild must not have turned an import into one.
  for (const name of Object.keys(YOMITAN_SHIMS)) {
    const bundle = await yomitanShimSource(name)
    assert.doesNotMatch(bundle, /\bimport\s*\(\s*['"]\//, `dist/spike/${name}`)
    assert.doesNotMatch(bundle, /\bimport\.meta\b|^\s*(import|export)\s/m, `dist/spike/${name} must be a classic script`)
  }
})

test('the replacement the harness relies on still matches the shim', () => {
  assert.notEqual(shim, shimSource, 'the network import was not stubbed; this harness tests nothing')
})
