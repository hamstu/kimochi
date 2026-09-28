import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const {
  groupMediaRequests,
  mediaTargets,
  indexMedia,
  mediaFromReply,
  mediaKey,
  base64ToBytes,
  isVectorMedia,
  missingMedia
} = await load('media.ts')

test('media relay unwraps the original runtime API response envelope', () => {
  const records = [{ path: 'cat.png', dictionary: 'fixture', content: 'YQ==' }]
  assert.deepEqual(mediaFromReply({ result: records }), records)
  assert.throws(
    () => mediaFromReply({ error: { message: 'Database unavailable' } }),
    /Database unavailable/
  )
  assert.throws(() => mediaFromReply(records), /Invalid dictionary media response/)
})

const request = (path, dictionary, canvasIndex, canvasWidth = 64, canvasHeight = 64) => ({
  path,
  dictionary,
  canvasIndex,
  canvasWidth,
  canvasHeight,
  generation: 7
})

test('requests for the same image are merged into one lookup', () => {
  // The same glyph shown three times is three canvases but one image.
  const groups = groupMediaRequests([
    request('img/cat.png', 'JMdict', 0),
    request('img/dog.png', 'JMdict', 1),
    request('img/cat.png', 'JMdict', 2)
  ])

  assert.equal(groups.length, 2)
  const cat = groups.find((g) => g.path === 'img/cat.png')
  assert.deepEqual(cat.canvasIndexes, [0, 2])
  assert.equal(cat.generation, 7)
  assert.deepEqual(groups.find((g) => g.path === 'img/dog.png').canvasIndexes, [1])
})

test('the same path in two dictionaries is two different images', () => {
  const groups = groupMediaRequests([
    request('img/cat.png', 'JMdict', 0),
    request('img/cat.png', 'Daijirin', 1)
  ])
  assert.equal(groups.length, 2)
  assert.notEqual(mediaKey(groups[0]), mediaKey(groups[1]))
})

test('a group carries the canvas size the protocol can express', () => {
  // Only one size travels per message, so the first request in a group fixes it
  // — the same limitation the real database worker has.
  const groups = groupMediaRequests([
    request('img/cat.png', 'JMdict', 0, 32, 48),
    request('img/cat.png', 'JMdict', 1, 999, 999)
  ])
  assert.equal(groups.length, 1)
  assert.deepEqual([groups[0].canvasWidth, groups[0].canvasHeight], [32, 48])
})

test('lookup targets are the distinct path and dictionary pairs', () => {
  const groups = groupMediaRequests([
    request('img/cat.png', 'JMdict', 0),
    request('img/cat.png', 'JMdict', 1),
    request('img/dog.png', 'JMdict', 2)
  ])
  assert.deepEqual(mediaTargets(groups), [
    { path: 'img/cat.png', dictionary: 'JMdict' },
    { path: 'img/dog.png', dictionary: 'JMdict' }
  ])
})

test('no requests means no lookup', () => {
  assert.deepEqual(groupMediaRequests([]), [])
  assert.deepEqual(mediaTargets([]), [])
})

test('records are matched back to their group by path and dictionary', () => {
  const records = [
    { path: 'img/cat.png', dictionary: 'JMdict', content: '', mediaType: 'image/png' },
    { path: 'img/cat.png', dictionary: 'Daijirin', content: '', mediaType: 'image/png' }
  ]
  const index = indexMedia(records)
  assert.equal(index.get(mediaKey(records[0])).dictionary, 'JMdict')
  assert.equal(index.get(mediaKey(records[1])).dictionary, 'Daijirin')
})

test('a dictionary referencing media it does not contain is reported, not fatal', () => {
  const groups = groupMediaRequests([
    request('img/cat.png', 'JMdict', 0),
    request('img/missing.png', 'JMdict', 1)
  ])
  const records = [
    { path: 'img/cat.png', dictionary: 'JMdict', content: '', mediaType: 'image/png' }
  ]
  assert.deepEqual(
    missingMedia(groups, records).map((g) => g.path),
    ['img/missing.png']
  )
})

test('base64 content decodes back to the original bytes', () => {
  // `getMedia` base64-encodes because its results cross a message boundary.
  const original = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])
  const encoded = Buffer.from(original).toString('base64')
  const decoded = base64ToBytes(encoded, (value) => Buffer.from(value, 'base64').toString('binary'))
  assert.deepEqual([...decoded], [...original])
})

test('an empty payload decodes to no bytes', () => {
  assert.equal(base64ToBytes('', () => '').length, 0)
})

test('vector media is recognised, since it has no intrinsic pixel size', () => {
  assert.equal(isVectorMedia('image/svg+xml'), true)
  assert.equal(isVectorMedia('image/png'), false)
  assert.equal(isVectorMedia('image/jpeg'), false)
})
