/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node regression harness. */
/**
 * host/ext/migrate.js: the one-time copy of Hachidori's storage from its scheme origin to its
 * loopback origin (src-tauri/src/loopback.rs). The value encoding and the wire format are pure;
 * the export → import round trip runs against a small in-memory IndexedDB with the shape of
 * Emscripten's IDBFS mount (`/dicts`, store FILE_DATA, out-of-line string keys, a `timestamp`
 * index), the database Hachidori keeps its dictionaries in.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeValue, encodeValue, exportStorage, importStorage, packPart, unpackPart } from '../host/ext/migrate.js'

const later = (fn) => setTimeout(fn, 0)
function req(result, error = null) {
  const r = { result: undefined, error: null }
  later(() => {
    if (error) {
      r.error = error
      r.onerror?.()
    } else {
      r.result = typeof result === 'function' ? result() : result
      r.onsuccess?.()
    }
  })
  return r
}

/** Just enough of IndexedDB for migrate.js; values are kept by reference like structured clone would copy them. */
function fakeIndexedDB() {
  const dbs = new Map()
  const handle = (db) => ({
    get version() { return db.version },
    objectStoreNames: { [Symbol.iterator]: () => db.stores.keys() },
    createObjectStore(name, options = {}) {
      const store = { keyPath: options.keyPath ?? null, autoIncrement: Boolean(options.autoIncrement), indexes: new Map(), records: new Map() }
      db.stores.set(name, store)
      return { createIndex: (n, keyPath, o = {}) => store.indexes.set(n, { keyPath, unique: Boolean(o.unique), multiEntry: Boolean(o.multiEntry) }) }
    },
    transaction(name) {
      return {
        objectStore() {
          const store = db.stores.get(name)
          return {
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexNames: { [Symbol.iterator]: () => store.indexes.keys() },
            index: (n) => store.indexes.get(n),
            getAllKeys: () => req(() => [...store.records.keys()].sort()),
            get: (key) => req(() => store.records.get(key)),
            put: (value, key) => req(() => {
              store.records.set(key ?? value[store.keyPath], value)
              return key
            })
          }
        }
      }
    },
    close() {}
  })
  return {
    dbs,
    databases: async () => [...dbs.keys()].map((name) => ({ name, version: dbs.get(name).version })),
    deleteDatabase: (name) => req(() => dbs.delete(name)),
    open(name, version) {
      const r = { result: undefined }
      later(() => {
        let db = dbs.get(name)
        const upgrade = !db || (version !== undefined && version > db.version)
        if (!db) {
          db = { version: version ?? 1, stores: new Map() }
          dbs.set(name, db)
        }
        if (version !== undefined) db.version = version
        r.result = handle(db)
        if (upgrade) r.onupgradeneeded?.()
        r.onsuccess?.()
      })
      return r
    }
  }
}

function fakeStorage(entries = []) {
  const map = new Map(entries)
  return {
    get length() { return map.size },
    key: (i) => [...map.keys()][i],
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    clear: () => map.clear(),
    map
  }
}

test('stored values survive encoding: bytes, Blobs, Dates, nested objects', async () => {
  const value = {
    timestamp: new Date(1792794000000),
    mode: 33206,
    contents: new Uint8Array([1, 2, 3, 250]),
    blob: new Blob([new Uint8Array([9, 8, 7])], { type: 'application/octet-stream' }),
    list: [1, 'two', null, undefined, { deep: new Float32Array([1.5]) }],
    odd: [NaN, -0, Infinity]
  }
  const { meta, parts } = await encodeValue(value)
  const back = decodeValue(JSON.parse(JSON.stringify(meta)), parts)
  assert.deepEqual(back.timestamp, value.timestamp)
  assert.equal(back.mode, 33206)
  assert.deepEqual([...back.contents], [1, 2, 3, 250])
  assert.ok(back.contents instanceof Uint8Array)
  assert.deepEqual([...new Uint8Array(await back.blob.arrayBuffer())], [9, 8, 7])
  assert.equal(back.blob.type, 'application/octet-stream')
  assert.deepEqual(back.list.slice(0, 4), [1, 'two', null, undefined])
  assert.equal(back.list[4].deep[0], 1.5)
  assert.ok(Number.isNaN(back.odd[0]))
  assert.ok(Object.is(back.odd[1], -0))
  assert.equal(back.odd[2], Infinity)
  await assert.rejects(encodeValue({ re: /x/ }), /cannot be copied/)
})

test('a part keeps its header and binary parts byte for byte', () => {
  const packed = packPart({ kind: 'record', key: { $v: '/dicts/a' } }, [new Uint8Array([1, 2]), new Uint8Array(0), new Uint8Array([3])])
  const { header, parts } = unpackPart(packed.buffer)
  assert.equal(header.kind, 'record')
  assert.deepEqual(header.sizes, [2, 0, 1])
  assert.deepEqual(parts.map((p) => [...p]), [[1, 2], [], [3]])
  assert.throws(() => unpackPart(packed.slice(0, packed.length - 1)), /wrong length/)
})

test('an IDBFS mount and localStorage copy across origins and verify', async () => {
  const from = fakeIndexedDB()
  const open = await new Promise((resolve) => {
    const r = from.open('/dicts', 21)
    r.onupgradeneeded = () => r.result.createObjectStore('FILE_DATA').createIndex('timestamp', 'timestamp', { unique: false })
    r.onsuccess = () => resolve(r.result)
  })
  const files = {
    '/dicts': { timestamp: new Date(1), mode: 16877 },
    '/dicts/.hdw-generation-1/Jitendex': { timestamp: new Date(2), mode: 16877 },
    '/dicts/.hdw-generation-1/Jitendex/terms.bin': { timestamp: new Date(3), mode: 33206, contents: new Uint8Array(4096).fill(7) },
    '/dicts/.hdw-generation-1/Jitendex/index.bin': { timestamp: new Date(4), mode: 33206, contents: new Blob([new Uint8Array(2048).fill(3)]) }
  }
  for (const [key, value] of Object.entries(files)) {
    await new Promise((resolve) => { open.transaction('FILE_DATA').objectStore().put(value, key).onsuccess = resolve })
  }
  const staged = []
  const exported = await exportStorage({ idb: from, storage: fakeStorage([['kimochi.extensionStore', 'S123']]), put: async (bytes) => staged.push(bytes) })
  assert.deepEqual(exported, { records: 4, bytes: 4096 + 2048 })

  const to = fakeIndexedDB()
  // Left by an earlier, interrupted attempt: replaced, never merged.
  await new Promise((resolve) => { to.open('stale', 1).onsuccess = resolve })
  const storage = fakeStorage([['leftover', 'x']])
  const imported = await importStorage({ idb: to, storage, parts: staged.length, get: async (i) => staged[i].buffer })
  assert.deepEqual(imported, exported)
  assert.deepEqual([...to.dbs.keys()], ['/dicts'])
  assert.equal(to.dbs.get('/dicts').version, 21)
  const store = to.dbs.get('/dicts').stores.get('FILE_DATA')
  assert.equal(store.keyPath, null)
  assert.deepEqual(store.indexes.get('timestamp'), { keyPath: 'timestamp', unique: false, multiEntry: false })
  assert.deepEqual([...store.records.keys()].sort(), Object.keys(files).sort())
  assert.deepEqual([...store.records.get('/dicts/.hdw-generation-1/Jitendex/terms.bin').contents].slice(0, 3), [7, 7, 7])
  assert.deepEqual([...storage.map], [['kimochi.extensionStore', 'S123']])
})

test('a record that does not read back as written fails the copy', async () => {
  const from = fakeIndexedDB()
  const db = await new Promise((resolve) => {
    const r = from.open('/dicts', 21)
    r.onupgradeneeded = () => r.result.createObjectStore('FILE_DATA')
    r.onsuccess = () => resolve(r.result)
  })
  await new Promise((resolve) => { db.transaction('FILE_DATA').objectStore().put({ contents: new Uint8Array([1]) }, '/dicts/x').onsuccess = resolve })
  const staged = []
  await exportStorage({ idb: from, storage: fakeStorage(), put: async (bytes) => staged.push(bytes) })
  const to = fakeIndexedDB()
  const realOpen = to.open.bind(to)
  // A store that loses bytes on the way in.
  to.open = (name, version) => {
    const r = realOpen(name, version)
    const done = () => {
      const h = r.result
      const tx = h.transaction.bind(h)
      h.transaction = (n) => {
        const t = tx(n)
        return { objectStore: () => ({ ...t.objectStore(), put: (value, key) => t.objectStore().put({ ...value, contents: new Uint8Array([2]) }, key) }) }
      }
    }
    const wrap = { set onsuccess(fn) { r.onsuccess = () => { done(); fn() } }, set onupgradeneeded(fn) { r.onupgradeneeded = fn }, set onerror(fn) { r.onerror = fn }, set onblocked(fn) {}, get result() { return r.result } }
    return wrap
  }
  await assert.rejects(
    importStorage({ idb: to, storage: fakeStorage(), parts: staged.length, get: async (i) => staged[i].buffer }),
    /did not read back as written/
  )
})

test('on the loopback origin the extension window reaches its commands through kimochi-ext', async () => {
  const { extCommand, extTauri } = await import('../host/ext/primitives.js')
  const calls = []
  const tauri = { core: { invoke: async (...args) => calls.push(args), Channel: class {} }, event: { listen: async () => {} } }
  // Everywhere but Hachidori's loopback origin: untouched.
  assert.equal(extCommand({}, 'ext_relay'), 'ext_relay')
  assert.equal(extTauri({ __TAURI__: tauri }), tauri)
  const win = { __TAURI__: tauri, __kimochiExtCommandPrefix: 'plugin:kimochi-ext|' }
  assert.equal(extCommand(win, 'report'), 'plugin:kimochi-ext|report')
  const routed = extTauri(win)
  assert.equal(routed.core.Channel, tauri.core.Channel)
  assert.equal(routed.event, tauri.event)
  await routed.core.invoke('ext_relay_bytes', new Uint8Array([1]), { headers: { 'x-kimochi-target': 'overlay' } })
  assert.deepEqual(calls[0][0], 'plugin:kimochi-ext|ext_relay_bytes')
  assert.deepEqual(calls[0][2], { headers: { 'x-kimochi-target': 'overlay' } })
})
