import assert from 'node:assert/strict'
import test from 'node:test'
import { createLookupQueue } from '../host/ext/lookup-queue.js'

test('a hover burst executes the current word and the newest waiting word only', async () => {
  const sent = []
  const replies = []
  const queue = createLookupQueue((request) => {
    sent.push(request)
    return new Promise((resolve, reject) => replies.push({ resolve, reject }))
  })
  const jobs = Array.from({ length: 100 }, (_, index) => queue.submit({ index, capture: `line-${index}` }))
  const settled = Promise.allSettled(jobs)
  assert.deepEqual(sent, [{ index: 0, capture: 'line-0' }])
  replies[0].resolve('first')
  assert.equal(await jobs[0], 'first')
  assert.deepEqual(sent, [{ index: 0, capture: 'line-0' }, { index: 99, capture: 'line-99' }])
  replies[1].resolve('last')
  const results = await settled
  assert.equal(results[99].value, 'last')
  assert.equal(results.filter((result) => result.status === 'rejected').length, 98)
  assert.match(results[1].reason.message, /superseded/)
})

test('an engine error releases the queue; disconnect drops waiting work', async () => {
  const replies = []
  const queue = createLookupQueue(() => new Promise((resolve, reject) => replies.push({ resolve, reject })))
  const first = queue.submit('first')
  const failed = assert.rejects(first, /engine failed/)
  const second = queue.submit('second')
  replies[0].reject(Error('engine failed'))
  await failed
  assert.equal(replies.length, 2)
  const waiting = queue.submit('waiting')
  const disconnected = assert.rejects(waiting, /disconnected/)
  queue.close()
  replies[1].resolve('second')
  assert.equal(await second, 'second')
  await disconnected
  await assert.rejects(queue.submit('later'), /disconnected/)
  assert.equal(replies.length, 2)
})
