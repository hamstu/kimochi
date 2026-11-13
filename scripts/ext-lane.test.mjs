/**
 * The fast lane between an engine's windows (host/ext/lane.js) and the relay's use of it
 * (host/ext/links.js `serveRelay`, `connectRelay`): BroadcastChannels on the extension origin,
 * opened directly there and through a hidden frame from an app origin, with `ext_relay` as the
 * fallback wherever they cannot be opened.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, afterEach, test } from 'node:test'
import { build } from 'esbuild'

// links.js reaches the engine table, which imports the extensions' manifests as JSON: bundled, as
// the app's host is (scripts/prepare.mjs).
const bundleDir = await mkdtemp(path.join(os.tmpdir(), 'kimochi-lane-'))
const bundle = path.join(bundleDir, 'links.mjs')
const { outputFiles } = await build({
  stdin: {
    contents: "export * from './host/ext/lane.js'; export { connectRelay, serveRelay } from './host/ext/links.js'",
    resolveDir: path.resolve('.')
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false
})
await writeFile(bundle, outputFiles[0].text)
const { LANE_PATH, installLaneFrame, openLane, connectRelay, serveRelay } = await import(pathToFileURL(bundle).href)
after(() => rm(bundleDir, { recursive: true, force: true }))

const EXT = 'http://127.0.0.1:27632'
const APP = 'http://127.0.0.1:1430'
const ENGINE = 'hachidori'

// Every channel and port the tests open, closed afterwards (open ones keep node running).
const opened = []
class Channel extends BroadcastChannel {
  constructor(name) {
    super(name)
    opened.push(this)
  }
}
class Ports extends MessageChannel {
  constructor() {
    super()
    opened.push(this.port1, this.port2)
  }
}
afterEach(() => {
  for (const channel of opened.splice(0)) channel.close()
})

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, what) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return
    await tick(5)
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** A bare window: `origin`, its own `addEventListener`, channels unless `channels` is false. */
function fakeWindow(origin, { channels = true, parent = null } = {}) {
  const listeners = new Map()
  const win = {
    location: { origin, pathname: '/' },
    BroadcastChannel: channels ? Channel : undefined,
    MessageChannel: Ports,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(listener)
    },
    fire(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event)
    }
  }
  win.top = parent ? parent.top : win
  win.parent = parent ?? win
  return win
}

/**
 * An app window whose document can frame the extension origin: appending the lane frame loads a
 * frame window running `installLaneFrame`, as `/__kimochi/lane.html` does.
 */
function appWindow({ frameChannels = true } = {}) {
  const win = fakeWindow(APP)
  const frames = []
  win.document = {
    body: {
      append(frame) {
        frames.push(frame)
        const inner = fakeWindow(EXT, { channels: frameChannels, parent: win })
        inner.location.pathname = new URL(frame.src).pathname
        installLaneFrame(inner)
        frame.contentWindow = {
          postMessage(data, targetOrigin, ports) {
            assert.equal(targetOrigin, EXT)
            setTimeout(() => inner.fire('message', { source: win, data, ports }))
          }
        }
        setTimeout(() => frame.fire('load'))
      }
    },
    createElement(tag) {
      assert.equal(tag, 'iframe')
      const handlers = {}
      return {
        style: {},
        setAttribute() {},
        addEventListener(type, listener) {
          handlers[type] = listener
        },
        fire(type) {
          handlers[type]?.()
        }
      }
    }
  }
  return { win, frames }
}

test("windows on the extension's origin reach each other by label, saying who they are", async () => {
  const a = openLane(fakeWindow(EXT), { engine: ENGINE, origin: EXT, label: 'ext-hachidori' })
  const b = openLane(fakeWindow(EXT), { engine: ENGINE, origin: EXT, label: 'overlay' })
  assert.equal(await a.ready, true)
  const got = []
  b.listen((payload, from) => got.push([from, payload]))
  a.listen(() => assert.fail('a window never hears what it sends to another'))
  assert.equal(a.send('overlay', { kind: 'ext', n: 1 }), true)
  // Another engine's windows share no channel with these.
  openLane(fakeWindow(EXT), { engine: 'tenten', origin: EXT, label: 'x' }).send('overlay', { kind: 'ext', n: 2 })
  await until(() => got.length === 1, 'the message')
  await tick(20)
  assert.deepEqual(got, [['ext-hachidori', { kind: 'ext', n: 1 }]])
})

test('an app window reaches the lane through a hidden frame on the extension origin', async () => {
  const { win, frames } = appWindow()
  const lane = openLane(win, { engine: ENGINE, origin: EXT, label: 'log' })
  // One per window, whoever asks.
  assert.equal(openLane(win, { engine: ENGINE, origin: EXT, label: 'log' }), lane)
  assert.equal(await lane.ready, true)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].src, `${EXT}${LANE_PATH}`)
  const ext = openLane(fakeWindow(EXT), { engine: ENGINE, origin: EXT, label: 'ext-hachidori' })
  const atExt = []
  const atLog = []
  ext.listen((payload, from) => atExt.push([from, payload]))
  lane.listen((payload, from) => atLog.push([from, payload]))
  lane.send('ext-hachidori', { kind: 'ext', hello: true })
  ext.send('log', { kind: 'ext', big: 'あ'.repeat(100000) })
  await until(() => atExt.length && atLog.length, 'both directions')
  assert.deepEqual(atExt, [['log', { kind: 'ext', hello: true }]])
  assert.equal(atLog[0][0], 'ext-hachidori')
  assert.equal(atLog[0][1].big.length, 100000)
})

test('where the frame cannot open channels, the lane says so at once and nothing is sent on it', async () => {
  const { win } = appWindow({ frameChannels: false })
  const lane = openLane(win, { engine: ENGINE, origin: EXT, label: 'log' })
  const started = Date.now()
  assert.equal(await lane.ready, false)
  assert.ok(Date.now() - started < 500, 'not after the deadline')
  assert.equal(lane.send('overlay', { kind: 'ext' }), false)
  // No channels at all, or turned off: no lane.
  assert.equal(
    await openLane(fakeWindow(APP, { channels: false }), { engine: ENGINE, origin: EXT, label: 'a' }).ready,
    false
  )
  const off = fakeWindow(EXT)
  off.__kimochiNoLane = true
  assert.equal(await openLane(off, { engine: ENGINE, origin: EXT, label: 'b' }).ready, false)
})

/** A Tauri whose `ext_relay` goes nowhere: whatever arrives came over the lane. */
const silentTauri = () => {
  const sent = []
  return {
    sent,
    core: { invoke: async (command, args) => void sent.push([command, args]) },
    event: { listen: async () => {} }
  }
}

test('a window whose hello the hub answers over the lane keeps to it, and the hub answers it that way', async () => {
  const hubWin = fakeWindow(EXT)
  const calls = []
  let link = null
  const hub = {
    win: hubWin,
    origin: EXT,
    async handle(from, op, args) {
      calls.push(op)
      link = from
      if (op === 'hello') return { hub: 'H1', ready: true, error: null }
      if (op === 'echo') {
        from.send(7, { type: 'deliver', id: 1 })
        return { echo: args.x }
      }
      return null
    }
  }
  const hubTauri = silentTauri()
  await serveRelay(hub, { tauri: hubTauri, label: 'overlay', engine: ENGINE, report: () => {} })

  const events = []
  const router = {
    win: fakeWindow(EXT),
    origin: EXT,
    upstream: null,
    setUpstream(upstream) {
      this.upstream = upstream
    },
    dispatch(ctx, event) {
      events.push([ctx, event])
    }
  }
  const reports = []
  const clientTauri = silentTauri()
  const relay = connectRelay(router, {
    tauri: clientTauri,
    label: 'ext-hachidori',
    engine: ENGINE,
    report: (r) => reports.push(r)
  })
  await until(() => router.upstream, 'the hub adopted')
  assert.equal(relay.status.lane, true)
  assert.deepEqual(reports, [{ check: 'ext-host-lane', window: 'ext-hachidori', lane: true }])
  assert.deepEqual(await router.upstream.call('echo', { x: 42 }), { echo: 42 })
  await until(() => events.length, 'the event')
  assert.deepEqual(events, [[7, { type: 'deliver', id: 1 }]])
  assert.equal(link.label, 'ext-hachidori')
  assert.deepEqual(calls, ['hello', 'echo'])
  // Neither side used the native relay for any of it.
  assert.deepEqual(
    clientTauri.sent.filter(([command]) => command.startsWith('ext_relay')),
    []
  )
  assert.deepEqual(
    hubTauri.sent.filter(([command]) => command.startsWith('ext_relay')),
    []
  )
})

test('with no lane the hello, and everything after it, goes over ext_relay as before', async () => {
  const router = {
    win: fakeWindow(APP, { channels: false }),
    origin: EXT,
    upstream: null,
    setUpstream(upstream) {
      this.upstream = upstream
    },
    dispatch() {}
  }
  // A hub on the relay: answers each call, stamped as main.rs `ext_relay` stamps it.
  let receive = null
  let seq = 0
  const sent = []
  const tauri = {
    core: {
      async invoke(command, { target, payload }) {
        sent.push([command, target, payload.op])
        const value = payload.op === 'hello' ? { hub: 'H1', ready: true, error: null } : { op: payload.op }
        const reply = { kind: 'ext', engine: ENGINE, type: 'reply', id: payload.id, ok: true, value }
        setTimeout(() => receive({ payload: { from: 'overlay', to: 'log', seq: ++seq, payload: reply } }))
      }
    },
    event: {
      async listen(_event, listener) {
        receive = listener
      }
    }
  }
  const relay = connectRelay(router, { tauri, label: 'log', engine: ENGINE, report: () => {} })
  await until(() => router.upstream, 'the hub adopted')
  assert.equal(relay.status.lane, false)
  assert.deepEqual(await router.upstream.call('register', {}), { op: 'register' })
  assert.deepEqual(sent, [
    ['ext_relay', 'overlay', 'hello'],
    ['ext_relay', 'overlay', 'register']
  ])
})
