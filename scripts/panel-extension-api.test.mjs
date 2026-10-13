/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node regression harness. */
/**
 * The envelope a panel window's `chrome.runtime.sendMessage` has to return.
 *
 * `js/comm/api.js` reads `response.result`. A locally answered call that returned the
 * bare value therefore resolved to `undefined`, and the very first thing
 * `Application.main` does with it is destructure `{tabId, frameId}` — so the frontend
 * died before the scanner existed. `content-script-wrapper.js` starts the frontend in
 * a floating async IIFE, so nothing surfaced: the Log went on reporting the
 * dictionary as reachable, which it was, while no hover could ever look a word up.
 *
 * This runs the real `dist/spike/panel-shim.js` bundle (built from `host/yomitan/`), not a
 * description of it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { yomitanShimSource } from './yomitan-shims.mjs'

const shim = await yomitanShimSource('panel-shim.js', { network: 'Promise.resolve()' })

function panelWindow() {
  const context = vm.createContext({ URL, EventTarget, Event, console, structuredClone, Promise })
  vm.runInContext(
    `
    window = globalThis; top = window;
    location = {href:'tauri://localhost/app/panel.html',origin:'tauri://localhost',protocol:'tauri:',pathname:'/app/panel.html'};
    navigator = {language:'en',platform:'MacIntel'};
    document = {createElement: () => ({}), head: {append(){}}};
    addEventListener = () => {};
    XMLHttpRequest = class {};
    fetch = async () => ({json: async () => ({})});
    relayed = [];
    // A stand-in rather than node:worker_threads' MessageChannel, whose ports are
    // live libuv handles that keep the test runner from ever exiting.
    MessageChannel = class {
      constructor() {
        const make = () => ({onmessage: null, close(){}, postMessage(data){ this.peer?.onmessage?.({data}) }});
        this.port1 = make(); this.port2 = make();
        this.port1.peer = this.port2; this.port2.peer = this.port1;
      }
    };
    __kimochiPanelLabel = 'log';
    __TAURI__ = {
      core: {invoke: async (cmd, args) => { relayed.push([cmd, args]); }},
      event: {listen: async () => {}}
    };
  `,
    context
  )
  vm.runInContext(shim, context)
  return context
}

/** The shape the original API client actually reads, quoted from its own source. */
test('the original api client reads response.result, which is what the envelope is for', async () => {
  const api = await readFile(new URL('../extensions/yomitan/js/comm/api.js', import.meta.url), 'utf8')
  assert.match(api, /const \{result\}[\s\S]{0,200}resolve\(/)
  assert.match(api, /const \{error\}/)
})

test('a locally answered frameInformationGet arrives in the envelope api.js unwraps', async () => {
  const context = panelWindow()
  const response = await vm.runInContext(
    `chrome.runtime.sendMessage({action: 'frameInformationGet', params: {}})`,
    context
  )
  assert.ok(response && typeof response === 'object', 'a null response fails api.js outright')
  assert.ok('result' in response, 'without the envelope Application.main destructures undefined')
  assert.equal(typeof response.result.frameId, 'number')
  assert.equal(typeof response.result.tabId, 'number')
})

test('this window keeps a tab identity of its own, distinct from the overlay', async () => {
  const context = panelWindow()
  const { result } = await vm.runInContext(
    `chrome.runtime.sendMessage({action: 'frameInformationGet', params: {}})`,
    context
  )
  // 1 is the overlay's. Frame routing that cannot tell two windows apart delivers a
  // popup handshake to the wrong one.
  assert.notEqual(result.tabId, 1)
  assert.equal(result.frameId, 0, 'the top frame is frame 0, as the popup host expects')
})

test('the native label, not the shared panel pathname, decides that identity', async () => {
  const context = panelWindow()
  const withLabel = await vm.runInContext(`chrome.runtime.sendMessage({action:'frameInformationGet',params:{}})`, context)
  // Re-evaluating with a different label must land on a different tab id; every panel
  // shares one URL, so the pathname cannot be the discriminator.
  const second = vm.createContext({ URL, EventTarget, Event, console, structuredClone, Promise })
  vm.runInContext(
    `
    window = globalThis; top = window;
    location = {href:'tauri://localhost/app/panel.html',origin:'tauri://localhost',protocol:'tauri:',pathname:'/app/panel.html'};
    navigator = {language:'en',platform:'MacIntel'};
    document = {createElement: () => ({}), head: {append(){}}};
    addEventListener = () => {}; XMLHttpRequest = class {};
    fetch = async () => ({json: async () => ({})});
    __kimochiPanelLabel = 'settings';
    __TAURI__ = {core:{invoke: async () => {}}, event:{listen: async () => {}}};
  `,
    second
  )
  vm.runInContext(shim, second)
  const settings = await vm.runInContext(
    `chrome.runtime.sendMessage({action:'frameInformationGet',params:{}})`,
    second
  )
  assert.notEqual(withLabel.result.tabId, settings.result.tabId)
})

test('broadcastTab and sendMessageToFrame answer in the same envelope', async () => {
  const context = panelWindow()
  for (const action of ['broadcastTab', 'sendMessageToFrame']) {
    const response = await vm.runInContext(
      `chrome.runtime.sendMessage({action: ${JSON.stringify(action)}, params: {message: {action: 'x'}, frameId: 0}})`,
      context
    )
    // Cross-realm objects never match deepStrictEqual by prototype, so assert the
    // envelope's two facts directly.
    assert.ok(response && 'result' in response, action)
    assert.equal(response.result, true, action)
  }
})

test('the popup handshake actions stay local and never reach the overlay', async () => {
  const context = panelWindow()
  await vm.runInContext(
    `chrome.runtime.sendMessage({action: 'broadcastTab', params: {message: {action: 'frameEndpointReady'}}})`,
    context
  )
  const relayed = vm.runInContext('relayed.filter(([cmd]) => cmd === "ext_relay")', context)
  const requests = relayed.filter(([, args]) => args?.payload?.kind === 'request')
  assert.equal(
    requests.length,
    0,
    "relaying the handshake would ask the overlay about the overlay's own frames"
  )
})

/**
 * The port that makes a popup show anything at all.
 *
 * `Popup._invoke` reaches the `Display` in its own iframe over a CrossFrameAPI port,
 * and a port is opened by asking the backend to connect both ends. Relayed, that
 * reaches the overlay's backend, which reads `sender.frameId` off a sender that
 * crossed a window boundary and has none. `_injectSafe` rethrows, injection fails,
 * and the window ends up highlighting the scanned word with no popup behind it —
 * which is exactly what this looked like from the outside.
 */
test('a cross-frame port is connected inside this window, not asked of the overlay', async () => {
  const context = panelWindow()
  const connected = vm.runInContext(
    `
    globalThis.connections = [];
    const hub = window.__extensionHost;
    const other = {
      win: {location: {href: 'tauri://localhost/popup.html'}},
      events: {
        onMessage: {listeners: new Set(), addListener(){}, emit(){}},
        onConnect: {emit: (port) => connections.push(['popup-frame', port.name])},
        onChanged: {emit(){}}
      }
    };
    const registered = hub.register(other.win, other.events);
    Object.assign(registered, other);
    chrome.runtime.onConnect.addListener((port) => connections.push(['top', port.name]));
    registered.id;
  `,
    context
  )
  const response = await vm.runInContext(
    `chrome.runtime.sendMessage({action: 'openCrossFramePort', params: {targetTabId: window.__extensionHost.tabId, targetFrameId: ${connected}}})`,
    context
  )
  assert.equal(response.result, true)

  const connections = vm.runInContext('connections.map(([where, name]) => [where, name])', context)
  assert.equal(connections.length, 2, 'both ends must be connected, as the backend connects both')

  const byEnd = Object.fromEntries(connections.map(([where, name]) => [where, JSON.parse(name)]))
  assert.equal(byEnd.top.name, 'cross-frame-communication-port')
  assert.equal(byEnd['popup-frame'].name, 'cross-frame-communication-port')
  // Each end is named with the OTHER end's identity: that is what CrossFrameAPI
  // files the port under, and addressing it by its own id would never find it.
  assert.equal(byEnd.top.otherFrameId, connected)
  assert.equal(byEnd['popup-frame'].otherFrameId, 0)
  assert.equal(byEnd.top.otherTabId, byEnd['popup-frame'].otherTabId)

  const relayed = vm.runInContext(
    'relayed.filter(([cmd, args]) => cmd === "ext_relay" && args?.payload?.kind === "request").length',
    context
  )
  assert.equal(relayed, 0, 'the overlay backend cannot answer a question about this window\u2019s frames')
})

test('a port to a frame this window does not have is refused rather than silently dropped', async () => {
  const context = panelWindow()
  await assert.rejects(
    () =>
      vm.runInContext(
        `chrome.runtime.sendMessage({action:'openCrossFramePort',params:{targetTabId: window.__extensionHost.tabId, targetFrameId: 987}})`,
        context
      ),
    /Unknown frame 987/
  )
})
