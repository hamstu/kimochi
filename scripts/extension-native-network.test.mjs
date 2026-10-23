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

test('Windows extension backgrounds keep native IPC outside the HTTP plugin, and send AnkiConnect requests through Rust', async () => {
  const nativeCalls = [], pluginCalls = [], relayCalls = []
  const context = vm.createContext({ URL, Response, TextDecoder, nativeCalls, pluginCalls, relayCalls })
  vm.runInContext(`window = globalThis; location = {href:'http://hachidori.localhost/__kimochi/ext-background.html',origin:'http://hachidori.localhost'};
    document = {baseURI:location.href}; __KIMOCHI_PLATFORM__ = {os:'windows'};
    __TAURI_INTERNALS__ = {invoke: (command, args) => { relayCalls.push([command, args]); return Promise.resolve({status: 200, body: '{"result":6,"error":null}'}) }};
    fetch = (...args) => { nativeCalls.push(args); return Promise.resolve({local:true}) };`, context)
  vm.runInContext(built.outputFiles[0].text, context)
  const answer = await vm.runInContext(`(async () => {
    network.installDirectNetwork(window, {denied:[],report:()=>{}});
    await fetch('http://ipc.localhost/ext_relay', {method:'POST',body:'{}'});
    await fetch(new URL('http://capture.localhost/live/1'));
    await fetch('http://192.0.2.42:9000/upload', {method:'POST',body:'{"name":"x"}'});
    const anki = await fetch('http://127.0.0.1:8765/', {method:'POST',body:'{"action":"version","version":6,"key":"k"}'});
    return anki.json();
  })()`, context)
  assert.deepEqual(nativeCalls.map(([url]) => String(url)), ['http://ipc.localhost/ext_relay', 'http://capture.localhost/live/1'])
  assert.equal(pluginCalls.length, 1)
  assert.equal(pluginCalls[0][0], 'http://192.0.2.42:9000/upload')
  assert.equal(pluginCalls[0][1].method, 'POST')
  assert.deepEqual(JSON.parse(JSON.stringify(relayCalls)), [['anki_connect_relay', { url: 'http://127.0.0.1:8765/', body: '{"action":"version","version":6,"key":"k"}' }]])
  assert.equal(answer.result, 6)
})

test('AnkiConnect requests are told apart by their envelope', async () => {
  const relay = await build({
    entryPoints: [fileURLToPath(new URL('../host/anki-relay.js', import.meta.url))],
    bundle: true, write: false, format: 'iife', globalName: 'relay'
  })
  const context = vm.createContext({ URL, TextDecoder })
  vm.runInContext('window = globalThis', context)
  vm.runInContext(relay.outputFiles[0].text, context)
  const relayed = (method, body) => vm.runInContext(`relay.ankiConnectBody(${JSON.stringify(method)}, ${JSON.stringify(body)})`, context)
  // Yomitan (anki-connect.js `_invoke`) and Hachidori (anki.js) bodies.
  assert.ok(relayed('POST', '{"action":"deckNames","params":{},"version":2}'))
  assert.ok(relayed('post', '{"action":"multi","version":6,"params":{"actions":[]},"key":"k"}'))
  for (const [method, body] of [
    ['GET', '{"action":"version","version":6}'],
    ['POST', '{"action":"version"}'],
    ['POST', '{"action":"version","version":"6"}'],
    ['POST', '{"action":"version","version":6,"other":1}'],
    ['POST', '{"action":"version","version":6,"params":1}'],
    ['POST', '[{"action":"version","version":6}]'],
    ['POST', '{"jsonrpc":"2.0","method":"version","id":1}'],
    ['POST', 'action=version'],
    ['POST', null]
  ]) {
    assert.equal(relayed(method, body), null, `${method} ${body}`)
  }
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
