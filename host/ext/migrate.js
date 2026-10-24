/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * Copies Hachidori's storage from its scheme origin to its loopback origin, once
 * (src-tauri/src/loopback.rs, docs/HACHIDORI_IMPORT_THREADS.md). Loaded as a module by
 * `/__kimochi/ext-migrate.html` in the hidden `ext-migrate-hachidori` window, as a top-level page
 * on each origin in turn, so each sees its origin's first-party storage:
 *
 * - `?step=export` on `hachidori://localhost`: every IndexedDB database (schema, then each record
 *   by key) and localStorage, each as one part sent to native (`ext_migration_put`), which stages
 *   them on disk; then the totals, and on to the loopback origin.
 * - `?step=import` on `http://127.0.0.1:<port>`: clears what an earlier attempt left there,
 *   rebuilds each database with the same version, stores and indexes, writes every record under
 *   its key, reads each back and compares it with what was exported (shape and SHA-256 of every
 *   binary part), and reports the totals and whether the page is cross-origin isolated.
 *
 * Nothing here is Hachidori-specific: whatever the engine keeps in IndexedDB (today its IDBFS
 * mount, the database `/dicts`) or localStorage (the host's store marker) is copied as it is.
 * The old origin is only read. Any error ends the copy (`ext_migration_failed`); native then keeps
 * Hachidori on its scheme origin.
 */

export const PAGE = '/__kimochi/ext-migrate.html'
const PLUGIN = 'plugin:kimochi-ext|'

// ------------------------------------------------------------------ value encoding

/**
 * A structured-clone value as JSON plus binary parts: `{meta, parts}`. Only the types IndexedDB
 * records hold in practice; anything else throws, which fails the copy rather than altering it.
 */
export async function encodeValue(value) {
  const parts = []
  const walk = async (v) => {
    if (v === undefined) return { $u: 1 }
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return { $v: v }
    if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0) ? { $v: v } : { $num: String(Object.is(v, -0) ? '-0' : v) }
    if (v instanceof Date) return { $date: v.getTime() }
    if (typeof Blob !== 'undefined' && v instanceof Blob) {
      parts.push(new Uint8Array(await v.arrayBuffer()))
      return { $blob: parts.length - 1, type: v.type }
    }
    if (v instanceof ArrayBuffer) {
      parts.push(new Uint8Array(v.slice(0)))
      return { $ab: parts.length - 1 }
    }
    if (ArrayBuffer.isView(v)) {
      parts.push(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)))
      return { $view: v.constructor.name, part: parts.length - 1 }
    }
    if (Array.isArray(v)) {
      const items = []
      for (const item of v) items.push(await walk(item))
      return { $arr: items }
    }
    if (v instanceof Map) {
      const items = []
      for (const [k, item] of v) items.push([await walk(k), await walk(item)])
      return { $map: items }
    }
    if (v instanceof Set) {
      const items = []
      for (const item of v) items.push(await walk(item))
      return { $set: items }
    }
    const proto = Object.getPrototypeOf(v)
    if (typeof v === 'object' && (proto === Object.prototype || proto === null)) {
      const out = {}
      for (const [k, item] of Object.entries(v)) out[k] = await walk(item)
      return { $obj: out }
    }
    throw new Error(`a stored value of type ${Object.prototype.toString.call(v)} cannot be copied`)
  }
  const meta = await walk(value)
  return { meta, parts }
}

const VIEWS = {
  Uint8Array, Int8Array, Uint8ClampedArray, Uint16Array, Int16Array, Uint32Array, Int32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView
}

/** The inverse of `encodeValue`. */
export function decodeValue(meta, parts, BlobImpl = globalThis.Blob) {
  const walk = (m) => {
    if ('$u' in m) return undefined
    if ('$v' in m) return m.$v
    if ('$num' in m) return m.$num === '-0' ? -0 : Number(m.$num)
    if ('$date' in m) return new Date(m.$date)
    if ('$blob' in m) return new BlobImpl([parts[m.$blob]], { type: m.type ?? '' })
    if ('$ab' in m) return parts[m.$ab].slice().buffer
    if ('$view' in m) {
      const View = VIEWS[m.$view]
      if (!View) throw new Error(`unknown typed array ${m.$view}`)
      const buffer = parts[m.part].slice().buffer
      return View === DataView ? new DataView(buffer) : new View(buffer)
    }
    if ('$arr' in m) return m.$arr.map(walk)
    if ('$map' in m) return new Map(m.$map.map(([k, v]) => [walk(k), walk(v)]))
    if ('$set' in m) return new Set(m.$set.map(walk))
    if ('$obj' in m) return Object.fromEntries(Object.entries(m.$obj).map(([k, v]) => [k, walk(v)]))
    throw new Error('an unreadable part')
  }
  return walk(meta)
}

/** One part on the wire: u32 LE length of the JSON header, the header, then the binary parts. */
export function packPart(header, parts = []) {
  const json = new TextEncoder().encode(JSON.stringify({ ...header, sizes: parts.map((p) => p.byteLength) }))
  const total = 4 + json.byteLength + parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  new DataView(out.buffer).setUint32(0, json.byteLength, true)
  out.set(json, 4)
  let at = 4 + json.byteLength
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

export function unpackPart(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)))
  const parts = []
  let at = 4 + length
  for (const size of header.sizes ?? []) {
    parts.push(bytes.slice(at, at + size))
    at += size
  }
  if (at !== bytes.byteLength) throw new Error('a staged part has the wrong length')
  return { header, parts }
}

async function digest(bytes, subtle = globalThis.crypto?.subtle) {
  const hash = new Uint8Array(await subtle.digest('SHA-256', bytes))
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** What a record is, for comparing an export with its read-back: shape and part digests. */
export async function fingerprintRecord(value) {
  const { meta, parts } = await encodeValue(value)
  const digests = []
  for (const part of parts) digests.push(await digest(part))
  return { meta: JSON.stringify(meta), digests, bytes: parts.reduce((n, p) => n + p.byteLength, 0) }
}

// -------------------------------------------------------------------- IndexedDB

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('an IndexedDB request failed'))
  })

function openDatabase(idb, name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? idb.open(name) : idb.open(name, version)
    req.onupgradeneeded = () => upgrade?.(req.result)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error(`could not open ${name}`))
    req.onblocked = () => reject(new Error(`${name} is open elsewhere`))
  })
}

const keyMeta = (key) => {
  if (typeof key === 'string' || typeof key === 'number') return { $v: key }
  if (key instanceof Date) return { $date: key.getTime() }
  if (Array.isArray(key)) return { $arr: key.map(keyMeta) }
  throw new Error('a binary IndexedDB key cannot be copied')
}

function schemaOf(db) {
  return [...db.objectStoreNames].map((name) => {
    const store = db.transaction(name, 'readonly').objectStore(name)
    return {
      name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      indexes: [...store.indexNames].map((indexName) => {
        const index = store.index(indexName)
        return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }
      })
    }
  })
}

/** Export: every database and localStorage, one part at a time through `put`. */
export async function exportStorage({ idb, storage, put }) {
  let records = 0
  let bytes = 0
  const entries = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    entries.push([key, storage.getItem(key)])
  }
  await put(packPart({ kind: 'localStorage', entries }))
  for (const { name } of await idb.databases()) {
    const db = await openDatabase(idb, name)
    try {
      const stores = schemaOf(db)
      await put(packPart({ kind: 'db', name, version: db.version, stores }))
      for (const store of stores) {
        // Keys first, then each record in a transaction of its own: a transaction would end
        // while a part is on its way to native.
        const keys = await request(db.transaction(store.name, 'readonly').objectStore(store.name).getAllKeys())
        for (const key of keys) {
          const value = await request(db.transaction(store.name, 'readonly').objectStore(store.name).get(key))
          const { meta, parts } = await encodeValue(value)
          const digests = []
          for (const part of parts) digests.push(await digest(part))
          await put(packPart({ kind: 'record', db: name, store: store.name, key: keyMeta(key), value: meta, digests }, parts))
          records++
          bytes += parts.reduce((n, p) => n + p.byteLength, 0)
        }
      }
    } finally {
      db.close()
    }
  }
  return { records, bytes }
}

/** Import: rebuild from the staged parts (`get(i)`), verifying each record as it is written. */
export async function importStorage({ idb, storage, parts, get }) {
  for (const { name } of await idb.databases()) await request(idb.deleteDatabase(name))
  storage.clear()
  let records = 0
  let bytes = 0
  const open = new Map()
  try {
    for (let i = 0; i < parts; i++) {
      const { header, parts: binary } = unpackPart(await get(i))
      if (header.kind === 'localStorage') {
        for (const [key, value] of header.entries) storage.setItem(key, value)
      } else if (header.kind === 'db') {
        const db = await openDatabase(idb, header.name, header.version, (created) => {
          for (const store of header.stores) {
            const options = { autoIncrement: store.autoIncrement }
            if (store.keyPath !== null) options.keyPath = store.keyPath
            const made = created.createObjectStore(store.name, options)
            for (const index of store.indexes) made.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry })
          }
        })
        open.set(header.name, { db, stores: new Map(header.stores.map((s) => [s.name, s])) })
      } else if (header.kind === 'record') {
        const target = open.get(header.db)
        if (!target) throw new Error(`a record of ${header.db} came before its database`)
        const inline = target.stores.get(header.store)?.keyPath !== null
        const key = decodeValue(header.key, [])
        const value = decodeValue(header.value, binary)
        const store = () => target.db.transaction(header.store, 'readwrite').objectStore(header.store)
        await request(inline ? store().put(value) : store().put(value, key))
        const back = await request(target.db.transaction(header.store, 'readonly').objectStore(header.store).get(key))
        const check = await fingerprintRecord(back)
        if (check.meta !== JSON.stringify(header.value) || JSON.stringify(check.digests) !== JSON.stringify(header.digests)) {
          throw new Error(`${header.db}/${header.store}: a record did not read back as written`)
        }
        records++
        bytes += check.bytes
      } else {
        throw new Error(`an unknown part (${header.kind})`)
      }
    }
  } finally {
    for (const { db } of open.values()) db.close()
  }
  return { records, bytes }
}

// ------------------------------------------------------------------------- the page

/** Hachidori's own test (offscreen.js `supportsSharedWasmMemory`): what the move is for. */
export function canThread(win) {
  if (win.crossOriginIsolated !== true || typeof win.SharedArrayBuffer !== 'function' || typeof win.WebAssembly?.Memory !== 'function') return false
  try {
    return new win.WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer instanceof win.SharedArrayBuffer
  } catch {
    return false
  }
}

async function run(win) {
  const internals = win.__TAURI_INTERNALS__
  const call = (command, args, options) => internals.invoke(PLUGIN + command, args, options)
  const step = new URLSearchParams(win.location.search).get('step')
  try {
    if (step === 'export') {
      const { to, page } = await call('ext_migration_begin')
      const totals = await exportStorage({ idb: win.indexedDB, storage: win.localStorage, put: (bytes) => call('ext_migration_put', bytes) })
      await call('ext_migration_exported', totals)
      win.location.replace(`${to}${page}?step=import`)
    } else if (step === 'import') {
      const manifest = await call('ext_migration_manifest')
      const totals = await importStorage({
        idb: win.indexedDB,
        storage: win.localStorage,
        parts: manifest.parts,
        get: (index) => call('ext_migration_get', { index })
      })
      await call('ext_migration_done', { ...totals, isolated: canThread(win) })
    }
  } catch (error) {
    await call('ext_migration_failed', { error: `${step}: ${error?.message ?? error}` }).catch(() => {})
  }
}

if (typeof window !== 'undefined' && window.location?.pathname === PAGE) void run(window)
