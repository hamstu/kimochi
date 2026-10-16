import assert from 'node:assert/strict'
import test from 'node:test'
import { listenRelay } from '../host/ext/primitives.js'

test('streamed and fallback relays share address checks and sequence deduplication', async () => {
  const listeners = new Map()
  const received = []
  let receiver
  const tauri = {
    core: {
      Channel: class { constructor(onmessage) { this.onmessage = onmessage } },
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
