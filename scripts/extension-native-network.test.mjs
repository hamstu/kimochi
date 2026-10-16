import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const built = await build({
  entryPoints: [fileURLToPath(new URL('../host/ext/network.js', import.meta.url))],
  bundle: true, write: false, format: 'iife', globalName: 'network',
  plugins: [{ name: 'http-transport', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, () => ({ path: 'http', namespace: 'stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const fetch = (...args) => { pluginCalls.push(args); return Promise.resolve({remote:true}) }' }))
  } }]
})

test('Windows extension backgrounds keep native IPC outside the HTTP plugin, without losing remote Anki requests', async () => {
  const nativeCalls = [], pluginCalls = []
  const context = vm.createContext({ URL, nativeCalls, pluginCalls })
  vm.runInContext(`window = globalThis; location = {href:'http://hachidori.localhost/__kimochi/ext-background.html',origin:'http://hachidori.localhost'};
    document = {baseURI:location.href}; __TAURI_INTERNALS__ = {}; __KIMOCHI_PLATFORM__ = {os:'windows'};
    fetch = (...args) => { nativeCalls.push(args); return Promise.resolve({local:true}) };`, context)
  vm.runInContext(built.outputFiles[0].text, context)
  await vm.runInContext(`(async () => {
    network.installDirectNetwork(window, {denied:[],report:()=>{}});
    await fetch('http://ipc.localhost/ext_relay', {method:'POST',body:'{}'});
    await fetch(new URL('http://capture.localhost/live/1'));
    await fetch('http://192.0.2.42:8765/', {method:'POST',body:'{"action":"version","version":6}'});
  })()`, context)
  assert.deepEqual(nativeCalls.map(([url]) => String(url)), ['http://ipc.localhost/ext_relay', 'http://capture.localhost/live/1'])
  assert.equal(pluginCalls.length, 1)
  assert.equal(pluginCalls[0][0], 'http://192.0.2.42:8765/')
  assert.equal(pluginCalls[0][1].method, 'POST')
})

test('Windows extension frames also leave IPC and capture on native fetch', async () => {
  const nativeCalls = []
  const context = vm.createContext({ URL, nativeCalls })
  vm.runInContext(`window = globalThis; location = {href:'http://hachidori.localhost/offscreen.html',origin:'http://hachidori.localhost'};
    __KIMOCHI_PLATFORM__ = {os:'windows'}; fetch = (...args) => { nativeCalls.push(args); return Promise.resolve({local:true}) };`, context)
  vm.runInContext(built.outputFiles[0].text, context)
  await vm.runInContext(`(async () => {
    network.installFrameNetwork(window, {upstream:{post:()=>{throw Error('native IPC must not be relayed')}},denied:[],report:()=>{}});
    await fetch('http://ipc.localhost/ext_relay', {method:'POST',body:'{}'});
    await fetch('http://capture.localhost/live/1');
  })()`, context)
  assert.deepEqual(nativeCalls.map(([url]) => String(url)), ['http://ipc.localhost/ext_relay', 'http://capture.localhost/live/1'])
})
