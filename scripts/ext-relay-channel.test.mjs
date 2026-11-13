import assert from 'node:assert/strict'
import test from 'node:test'
import { listenRelay, relaySeqWindow } from '../host/ext/primitives.js'

test('streamed and fallback relays share address checks and sequence deduplication', async () => {
  const listeners = new Map()
  const received = []
  let receiver
  const tauri = {
    core: {
      Channel: class {
        constructor(onmessage) {
          this.onmessage = onmessage
        }
      },
      invoke: async (command, { channel }) => {
        assert.equal(command, 'ext_relay_listen')
        receiver = channel
      }
    },
    event: { listen: async (name, callback) => listeners.set(name, callback) }
  }
  await listenRelay(tauri, 'log', (payload) => received.push(payload))
  const message = { from: 'overlay', to: 'log', seq: 1, payload: { result: '日本語' } }
  receiver.onmessage(message)
  listeners.get('ext-relay:log')({ payload: message })
  receiver.onmessage({ ...message, to: 'dictionary', seq: 2 })
  listeners.get('ext-relay')({ payload: { ...message, to: null, seq: 3, payload: 'broadcast' } })
  assert.deepEqual(received, [{ result: '日本語' }, 'broadcast'])
  assert.deepEqual([...listeners.keys()], ['ext-relay', 'ext-relay:log'])
})

test('a message that arrives after a later one is delivered, and only a seq received twice is dropped', async () => {
  // Hachidori's first storage read reached the background after a later message (event and
  // channel delivery do not keep order between them) and was dropped as a duplicate.
  const listeners = new Map()
  const received = []
  const duplicates = []
  const reordered = []
  const tauri = { event: { listen: async (name, callback) => listeners.set(name, callback) } }
  await listenRelay(
    tauri,
    'ext-hachidori',
    (payload) => received.push(payload),
    (from, seq) => duplicates.push(seq),
    (from, seq, highest) => reordered.push([seq, highest])
  )
  const send = (seq, payload) =>
    listeners.get('ext-relay:ext-hachidori')({ payload: { from: 'overlay', to: 'ext-hachidori', seq, payload } })
  send(42, 'a')
  send(44, 'c')
  send(43, 'b')
  send(43, 'b')
  send(44, 'c')
  assert.deepEqual(received, ['a', 'c', 'b'])
  assert.deepEqual(duplicates, [43, 44])
  assert.deepEqual(reordered, [[43, 44]])
})

test('the seq window stays bounded and still drops what it can no longer tell apart', () => {
  const window = relaySeqWindow(4)
  for (let seq = 1; seq <= 20; seq++) assert.equal(window.accept(seq), true)
  assert.equal(window.accept(20), false)
  assert.equal(window.accept(1), false)
  assert.equal(window.accept(22), true)
  assert.equal(window.accept(21), true)
})
