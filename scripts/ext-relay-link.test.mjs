import assert from 'node:assert/strict'
import test from 'node:test'
import { BRIDGE_PATH, bridgeUrl, installRelayLink, servesBridge } from '../host/ext/relay-link.js'

const loopback = { protocol: 'http:', hostname: '127.0.0.1', port: '27631', host: '127.0.0.1:27631' }

test('link addresses go to the same origin bridge, everything else is left alone', () => {
  assert.equal(
    bridgeUrl('ws://127.0.0.1:8771/link', loopback),
    `ws://127.0.0.1:27631${BRIDGE_PATH}?to=127.0.0.1%3A8771`
  )
  assert.equal(
    bridgeUrl('ws://192.168.1.20:8771/link', loopback),
    `ws://127.0.0.1:27631${BRIDGE_PATH}?to=192.168.1.20%3A8771`
  )
  assert.equal(bridgeUrl('ws://desk.local/link', loopback), `ws://127.0.0.1:27631${BRIDGE_PATH}?to=desk.local%3A80`)
  assert.equal(
    bridgeUrl('ws://[::1]:8771/link', loopback),
    `ws://127.0.0.1:27631${BRIDGE_PATH}?to=%5B%3A%3A1%5D%3A8771`
  )
  assert.equal(bridgeUrl('ws://127.0.0.1:8771/host', loopback), null)
  assert.equal(bridgeUrl('wss://relay.example/link', loopback), null)
  assert.equal(bridgeUrl('ws://127.0.0.1:6677/', loopback), null)
  assert.equal(bridgeUrl('ws://me:pw@127.0.0.1:8771/link', loopback), null)
  assert.equal(bridgeUrl('not a url', loopback), null)
})

test('only the loopback origin serves the bridge', () => {
  assert.equal(servesBridge(loopback), true)
  assert.equal(servesBridge({ protocol: 'hachidori:', hostname: 'localhost', port: '' }), false)
  assert.equal(servesBridge({ protocol: 'http:', hostname: 'hachidori.localhost', port: '' }), false)
  assert.equal(servesBridge(undefined), false)
})

function fakeWindow(location = loopback) {
  class NativeWebSocket {
    static OPEN = 1
    constructor(url, protocols) {
      this.url = url
      this.opened = { url, protocols }
    }
  }
  return { WebSocket: NativeWebSocket, location, NativeWebSocket }
}

test('the background page opens links through the bridge with its native WebSocket', () => {
  const win = fakeWindow()
  assert.equal(installRelayLink(win), true)
  assert.equal(installRelayLink(win), false, 'a second copy of the host stands down')
  const link = new win.WebSocket('ws://127.0.0.1:8771/link')
  assert.ok(link instanceof win.NativeWebSocket)
  assert.equal(link.opened.url, `ws://127.0.0.1:27631${BRIDGE_PATH}?to=127.0.0.1%3A8771`)
  assert.equal(link.url, 'ws://127.0.0.1:8771/link')
  assert.equal(win.WebSocket.OPEN, 1)
  const other = new win.WebSocket('ws://localhost:6677', ['chat'])
  assert.deepEqual(other.opened, { url: 'ws://localhost:6677', protocols: ['chat'] })
})

test('the scheme origin keeps the native WebSocket', () => {
  const win = fakeWindow({ protocol: 'hachidori:', hostname: 'localhost', port: '', host: 'localhost' })
  assert.equal(installRelayLink(win), false)
  assert.equal(win.WebSocket, win.NativeWebSocket)
})
