/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Native bridge regression harness. */
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

for (const file of ['shim.js', 'panel-shim.js']) {
  const source = (await readFile(new URL(`../host/${file}`, import.meta.url), 'utf8'))
    .replace("import(asset('/spike/network-bundle.js'))", 'Promise.resolve()')
  test(`${file} preserves WebView2 IPC while providing the Windows extension API`, async () => {
    const sent = []
    const nativeWebview = { postMessage: (message) => sent.push(message) }
    const context = vm.createContext({ URL, EventTarget, Event, console, structuredClone, Promise, nativeWebview })
    vm.runInContext(`
      window = globalThis; top = window;
      location = {href:'http://tauri.localhost/app/panel.html',origin:'http://tauri.localhost',protocol:'http:',pathname:'/app/panel.html'};
      navigator = {language:'en',platform:'Win32'};
      __KIMOCHI_PLATFORM__ = {os:'windows',arch:'x86_64'};
      document = {createElement: () => ({}), head: {append(){}}};
      addEventListener = () => {}; dispatchEvent = () => {};
      XMLHttpRequest = class {};
      fetch = async () => ({json: async () => ({})});
      __kimochiPanelLabel = 'log';
      chrome = {webview:nativeWebview};
      ipc = {postMessage: message => window.chrome.webview.postMessage(message)};
      __TAURI__ = {core:{invoke:async () => ({})},event:{listen:async () => {}}};
    `, context)
    vm.runInContext(source, context)
    assert.equal(context.chrome.webview, nativeWebview)
    vm.runInContext(`ipc.postMessage('native IPC still works')`, context)
    assert.deepEqual(sent, ['native IPC still works'])
    const platform = await vm.runInContext('chrome.runtime.getPlatformInfo()', context)
    assert.equal(platform.os, 'win')
    assert.equal(platform.arch, 'x86-64')
  })
}
