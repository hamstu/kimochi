import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { parseSourceId, isWindowSourceId, isDisplaySourceId } = await load('source-id.ts')

// Mirrors the cases in capture-core/src/ids.rs.
test('reads the macOS wire format saved since the first build', () => {
  assert.deepEqual(parseSourceId('macos:display:1'), {
    platform: 'macos',
    kind: 'display',
    handle: '1',
    pid: null
  })
  assert.deepEqual(parseSourceId('macos:window:4321:987'), {
    platform: 'macos',
    kind: 'window',
    handle: '4321',
    pid: 987
  })
  assert.deepEqual(parseSourceId('macos:window:4321'), {
    platform: 'macos',
    kind: 'window',
    handle: '4321',
    pid: null
  })
})

test('handles stay strings, so pointer-sized Windows handles survive', () => {
  const parsed = parseSourceId('windows:window:0x1f2e3d4c5b6a7980:1234')
  assert.equal(parsed.platform, 'windows')
  assert.equal(parsed.handle, '0x1f2e3d4c5b6a7980')
  assert.equal(parsed.pid, 1234)
  assert.equal(parseSourceId('x11:display:0').platform, 'x11')
  assert.equal(parseSourceId('portal:window:57').kind, 'window')
})

test('anything malformed is unknown, never a display', () => {
  for (const id of [
    '',
    'macos',
    'macos:display',
    'macos:display:',
    'macos:display:1:2',
    'macos:window:',
    'macos:window:1:',
    'macos:window:1:abc',
    'macos:window:1:2:3',
    'macos:window:1:99999999999',
    'linux:display:1',
    'macos:screen:1',
    'display:1',
    null,
    undefined,
    42
  ]) {
    assert.equal(parseSourceId(id), null, String(id))
    assert.equal(isDisplaySourceId(id), false, String(id))
    assert.equal(isWindowSourceId(id), false, String(id))
  }
})

test('kind predicates', () => {
  assert.equal(isWindowSourceId('windows:window:abc:1'), true)
  assert.equal(isDisplaySourceId('windows:window:abc:1'), false)
  assert.equal(isDisplaySourceId('windows:display:\\\\.\\DISPLAY1'), true)
})
