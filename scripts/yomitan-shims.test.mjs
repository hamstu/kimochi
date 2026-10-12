/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node regression harness. */
/**
 * The overlay's Yomitan host (`dist/spike/shim.js`, built from host/yomitan/overlay.js on the
 * shared primitives, DICTIONARY_ENGINES.md §11.4): routing, storage and the callback forms, run
 * from the real bundle in `node:vm` with one top window and one same-origin backend frame.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { yomitanShimSource } from './yomitan-shims.mjs'

const overlayShim = await yomitanShimSource('shim.js')
const panelShim = await yomitanShimSource('panel-shim.js', { network: 'Promise.resolve()' })

const PRELUDE = (href, pathname) => `
  window = globalThis;
  location = {href:'${href}',origin:'tauri://localhost',protocol:'tauri:',pathname:'${pathname}'};
  navigator = {language:'en',platform:'MacIntel'};
  document = {createElement: () => ({}), head: {append(){}}};
  addEventListener = () => {}; dispatchEvent = () => {};
  CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail } };
  fetch = async () => ({json: async () => ({})});
  MessageChannel = class {
    constructor() {
      const make = () => ({onmessage: null, close(){}, postMessage(data){ this.peer?.onmessage?.({data}) }});
      this.port1 = make(); this.port2 = make();
      this.port1.peer = this.port2; this.port2.peer = this.port1;
    }
  };
`

function overlay() {
  const globals = () => ({ URL, console, structuredClone, Promise, TextEncoder, setTimeout, clearTimeout })
  const top = vm.createContext(globals())
  vm.runInContext(PRELUDE('tauri://localhost/ui/overlay.html', '/ui/overlay.html'), top)
  vm.runInContext(`top = window; saved = []; __TAURI__ = {core: {invoke: async (cmd, args) => { if (cmd === 'storage_save') saved.push(JSON.parse(JSON.stringify(args.value))) }}}`, top)
  vm.runInContext(overlayShim, top)
  const frame = vm.createContext(globals())
  vm.runInContext(PRELUDE('tauri://localhost/spike/background.html', '/spike/background.html'), frame)
  frame.top = top
  vm.runInContext(overlayShim, frame)
  return { top, frame }
}

test('the overlay bundle installs once per frame and the backend frame is the background context', () => {
  const { top, frame } = overlay()
  assert.equal(vm.runInContext('__yomitanShim', top), true)
  assert.equal(vm.runInContext('__yomitanShim', frame), true)
  const hub = top.__extensionHost
  assert.deepEqual([...hub.contexts.values()].map((c) => c.background), [false, true])
  assert.equal(frame.__extensionHost, undefined, 'the frame uses the top window\'s hub')
})

test('runtime.sendMessage goes frontend → backend and back, with the first answer winning', async () => {
  const { top, frame } = overlay()
  vm.runInContext(`chrome.runtime.onMessage.addListener((m, sender, reply) => { reply({got: m.action, frameId: sender.frameId, tab: sender.tab.id}) })`, frame)
  vm.runInContext(`chrome.runtime.onMessage.addListener((m, s, reply) => { reply('the frontend must not answer itself') })`, top)
  const answer = await vm.runInContext(`chrome.runtime.sendMessage({action: 'termsFind'})`, top)
  assert.deepEqual({ ...answer }, { got: 'termsFind', frameId: 0, tab: 1 })
  // Nobody listening: undefined, not a hang.
  const backendToNobody = await vm.runInContext(`chrome.tabs.sendMessage(1, {action: 'x'}, {frameId: 42})`, frame)
  assert.equal(backendToNobody, undefined)
})

test('storage.local persists through storage_save and reports Chrome-shaped changes to every context', async () => {
  const { top, frame } = overlay()
  vm.runInContext(`changes = []; chrome.storage.onChanged.addListener((c, area) => changes.push([JSON.parse(JSON.stringify(c)), area]))`, frame)
  await vm.runInContext(`chrome.storage.local.set({options: {v: 1}})`, top)
  await vm.runInContext(`chrome.storage.local.remove('options')`, top)
  assert.deepEqual(JSON.parse(JSON.stringify(top.saved)), [{ options: { v: 1 } }, {}])
  assert.deepEqual(JSON.parse(JSON.stringify(frame.changes)), [
    [{ options: { newValue: { v: 1 } } }, 'local'],
    [{ options: { oldValue: { v: 1 } } }, 'local']
  ])
  await vm.runInContext(`chrome.storage.session.set({a: 1})`, frame)
  const got = await vm.runInContext(`chrome.storage.session.get({a: 0, b: 2})`, top)
  assert.deepEqual({ ...got }, { a: 1, b: 2 })
  assert.equal(top.saved.length, 2, 'session storage is never persisted')
})

test('callback forms set chrome.runtime.lastError only for the callback', async () => {
  const { top } = overlay()
  const seen = await vm.runInContext(
    `new Promise(resolve => chrome.tabs.remove(1, () => resolve(chrome.runtime.lastError?.message)))`,
    top
  )
  assert.match(seen, /tabs\.remove is not implemented/)
  assert.equal(vm.runInContext('chrome.runtime.lastError', top), undefined)
})

test('the panel bundle drops a relayed payload it has already seen from the same sender', async () => {
  const context = vm.createContext({ URL, console, structuredClone, Promise, setTimeout, clearTimeout })
  vm.runInContext(PRELUDE('tauri://localhost/app/panel.html', '/app/panel.html'), context)
  vm.runInContext(
    `top = window; XMLHttpRequest = class {}; __kimochiPanelLabel = 'log'; reports = [];
     __TAURI__ = {
       core: {invoke: async (cmd, args) => { if (cmd === 'report') reports.push(args.value) }},
       event: {listen: async (name, f) => { relay = f }}
     };`,
    context
  )
  vm.runInContext(panelShim, context)
  await vm.runInContext('__extensionHost.ready', context)
  vm.runInContext(`seen = []; chrome.storage.onChanged.addListener((c) => seen.push(Object.keys(c)[0]))`, context)
  const send = (seq, key, to = 'log') =>
    vm.runInContext(`relay({payload: {from: 'overlay', to: '${to}', seq: ${seq}, payload: {kind: 'storage-changed', area: 'local', changes: {${key}: {}}}}})`, context)
  send(1, 'a')
  send(1, 'again')
  send(2, 'b', 'dictionary')
  send(3, 'c')
  assert.deepEqual([...context.seen], ['a', 'c'])
  assert.ok(context.reports.some((r) => r.check === 'relay-duplicate' && r.seq === 1))
})
