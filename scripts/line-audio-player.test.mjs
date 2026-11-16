import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { createLineAudioPlayer } = await load('../frontend/texthooker/lib/lineAudioPlayer.ts')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture() {
  const requests = []
  const clips = []
  let changes = 0
  const player = createLineAudioPlayer(
    (uid) => {
      const request = { uid, ...deferred() }
      requests.push(request)
      return request.promise
    },
    (base64) => {
      const clip = {
        base64,
        paused: false,
        started: false,
        currentTime: 1,
        duration: 2,
        listeners: {},
        pause() {
          this.paused = true
        },
        async play() {
          this.started = true
        },
        addEventListener(event, listener) {
          this.listeners[event] = listener
        }
      }
      clips.push(clip)
      return clip
    },
    () => changes++
  )
  return { player, requests, clips, changes: () => changes }
}

test('newer requests win even when the old audio arrives last', async () => {
  const { player, requests, clips } = fixture()
  const first = player.toggle('first')
  const second = player.toggle('second')
  requests[1].resolve('second clip')
  assert.equal(await second, 'playing')
  requests[0].resolve('first clip')
  assert.equal(await first, 'cancelled')
  assert.equal(clips.length, 1)
  assert.equal(clips[0].base64, 'second clip')
  assert.equal(player.isPlaying('second'), true)
})

test('closing or navigating cancels pending audio before it creates an audio element', async () => {
  const { player, requests, clips } = fixture()
  const pending = player.toggle('sentence')
  player.stop('sentence')
  requests[0].resolve('late clip')
  assert.equal(await pending, 'cancelled')
  assert.equal(clips.length, 0)
})

test('toggling a pending clip stops it instead of starting a second request', async () => {
  const { player, requests, clips } = fixture()
  const pending = player.toggle('sentence')
  assert.equal(await player.toggle('sentence'), 'stopped')
  requests[0].resolve('late clip')
  assert.equal(await pending, 'cancelled')
  assert.equal(requests.length, 1)
  assert.equal(clips.length, 0)
})

test('stopping an old prompt cannot stop a newer prompt', async () => {
  const { player, requests, clips } = fixture()
  const pending = player.toggle('new')
  player.stop('old')
  requests[0].resolve('new clip')
  await pending
  player.stop('old')
  assert.equal(player.isPlaying('new'), true)
  assert.equal(clips[0].paused, false)
})

test('playback stops on toggle, end and error, and old events cannot stop a newer clip', async () => {
  const { player, requests, clips } = fixture()
  const first = player.toggle('first')
  requests[0].resolve('first')
  await first
  assert.equal(player.progress('first'), 0.5)
  const second = player.toggle('second')
  assert.equal(clips[0].paused, true)
  requests[1].resolve('second')
  await second
  clips[0].listeners.ended()
  assert.equal(player.isPlaying('second'), true)
  clips[1].listeners.error()
  assert.equal(player.isPlaying('second'), false)
  assert.equal(player.progress('second'), null)
  const third = player.toggle('third')
  requests[2].resolve('third')
  await third
  assert.equal(await player.toggle('third'), 'stopped')
  assert.equal(clips[2].paused, true)
})

test('missing and rejected clips report failures and a later retry still works', async () => {
  const { player, requests } = fixture()
  const missing = player.toggle('missing')
  requests[0].resolve(null)
  assert.equal(await missing, 'unavailable')
  const failed = player.toggle('failed')
  requests[1].reject(new Error('Offline'))
  await assert.rejects(failed, /Offline/)
  const retried = player.toggle('failed')
  requests[2].resolve('retry')
  assert.equal(await retried, 'playing')
})

test('a rejection from an abandoned fetch is cancellation, not an unhandled failure', async () => {
  const { player, requests } = fixture()
  const pending = player.toggle('old')
  player.stop()
  requests[0].reject(new Error('Gone'))
  assert.equal(await pending, 'cancelled')
})

test('browser playback rejection clears playing state and is retryable', async () => {
  let fail = true
  const player = createLineAudioPlayer(
    async () => 'bytes',
    () => ({
      pause() {},
      addEventListener() {},
      currentTime: 0,
      duration: NaN,
      async play() {
        if (fail) throw new Error('Blocked')
      }
    }),
    () => {}
  )
  await assert.rejects(player.toggle('line'), /Blocked/)
  assert.equal(player.isPlaying('line'), false)
  fail = false
  assert.equal(await player.toggle('line'), 'playing')
  assert.equal(player.progress('line'), 0)
})

test('leaving while browser play is pending pauses it, and a late rejection stays cancelled', async () => {
  const playback = deferred()
  let paused = false
  const player = createLineAudioPlayer(
    async () => 'bytes',
    () => ({
      pause() {
        paused = true
      },
      addEventListener() {},
      currentTime: 0,
      duration: 1,
      play() {
        return playback.promise
      }
    }),
    () => {}
  )
  const pending = player.toggle('line')
  await Promise.resolve()
  assert.equal(player.isPlaying('line'), true)
  player.stop('line')
  assert.equal(paused, true)
  playback.reject(new Error('Playback interrupted'))
  assert.equal(await pending, 'cancelled')
  assert.equal(player.isPlaying('line'), false)
})
