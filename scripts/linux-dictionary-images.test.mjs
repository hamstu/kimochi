import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linuxImageLoader, installLinuxDictionaryImages, dictionaryImageType } from '../host/linux-dictionary-images.js'

test('browser-supported AVIF preserves original content and avoids native conversion', async () => {
  const content = new Uint8Array([1, 2]).buffer
  const expected = { content, width: 20, height: 30 }
  const load = linuxImageLoader(async () => expected, () => assert.fail('native conversion'))
  assert.equal(await load(content, 'image/avif', []), expected)
})

test('unsupported AVIF converts then validates PNG with original receiver and transfer list', async () => {
  const content = new Uint8Array([1, 2]).buffer
  const transfer = []
  const receiver = {}
  let calls = 0
  const load = linuxImageLoader(async function (bytes, type, list) {
    assert.equal(this, receiver)
    assert.equal(list, transfer)
    calls++
    if (type === 'image/avif') throw Error('unsupported')
    assert.equal(type, 'image/png')
    assert.deepEqual([...new Uint8Array(bytes)], [137, 80, 78, 71])
    list.push(bytes)
    return { content: bytes, width: 294, height: 480 }
  }, async (command, args) => {
    assert.equal(command, 'linux_dictionary_image')
    assert.deepEqual(args.content, [1, 2])
    return [137, 80, 78, 71]
  })
  const result = await load.call(receiver, content, 'image/avif', transfer)
  assert.equal(calls, 2)
  assert.equal(result.width, 294)
  assert.equal(transfer[0], result.content)
})

test('other image errors retain their original failure', async () => {
  const error = Error('invalid JPEG')
  const load = linuxImageLoader(async () => { throw error }, () => assert.fail('native conversion'))
  await assert.rejects(load(new ArrayBuffer(0), 'image/jpeg'), e => e === error)
})

test('unavailable system decoder propagates its actionable error', async () => {
  const load = linuxImageLoader(async () => { throw Error('unsupported') }, async () => { throw Error('Install AVIF loader') })
  await assert.rejects(load(new ArrayBuffer(1), 'image/avif'), /Install AVIF loader/)
})

test('non-Linux shim does not import or patch the vendor image loader', async () => {
  await installLinuxDictionaryImages({ chrome: { runtime: { getPlatformInfo: async () => ({ os: 'mac' }) } } })
  await installLinuxDictionaryImages({ chrome: { runtime: { getPlatformInfo: async () => ({ os: 'win' }) } } })
})


test('converted media uses PNG MIME type without changing path or content', () => {
  const content = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer
  const media = { path: 'graphics/image.avif', mediaType: 'image/avif', content }
  assert.equal(dictionaryImageType(media), 'image/png')
  assert.equal(media.path, 'graphics/image.avif')
  assert.equal(media.content, content)
})

test('original AVIF and unrelated formats preserve their MIME type', () => {
  assert.equal(dictionaryImageType({ mediaType: 'image/avif', content: new Uint8Array([0, 0]).buffer }), 'image/avif')
  assert.equal(dictionaryImageType({ mediaType: 'image/jpeg', content: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer }), 'image/jpeg')
})
