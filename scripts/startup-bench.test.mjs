import assert from 'node:assert/strict'
import test from 'node:test'
import { dataDir, flatten, median, startupRecords, summarize } from './startup-bench.mjs'

test('reads only launch startup records, skipping partial lines and reloads', () => {
  const text = [
    '{"check":"window-focus","at":1}',
    '{"check":"startup","launch":true,"native":{"setup-start":20},"web":{"ready":900}}',
    '{"check":"startup","launch":false,"web":{"ready":50}}',
    '{"check":"startup","nat',
    '{"check":"startup","native":{"setup-start":30},"web":{"ready":1100}}'
  ].join('\n')
  const records = startupRecords(text)
  assert.equal(records.length, 2)
  assert.deepEqual(flatten(records[0]), { 'setup-start': 20, 'web:ready': 900 })
})

test('summarizes medians in the order the marks happen', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([1, 2, 3, 4]), 3)
  assert.equal(median([]), null)
  const summary = summarize([
    { 'web:ready': 900, 'setup-start': 20 },
    { 'web:ready': 1100, 'setup-start': 30 }
  ])
  assert.deepEqual(Object.keys(summary), ['setup-start', 'web:ready'])
  assert.equal(summary['web:ready'], 1000)
})

test('finds the app data directory on each OS', () => {
  const tail = (file) => file.split(/[\\/]/).slice(-2).join('/')
  assert.equal(
    tail(dataDir('win32', 'C:/Users/a', { APPDATA: 'C:/Users/a/AppData/Roaming' })),
    'Roaming/dev.kimochi.app'
  )
  assert.equal(tail(dataDir('darwin', '/Users/a', {})), 'Application Support/dev.kimochi.app')
  assert.equal(tail(dataDir('linux', '/home/a', {})), 'share/dev.kimochi.app')
})
