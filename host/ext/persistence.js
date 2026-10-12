/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * Keeping `chrome-local-<id>.json` and the extension's own storage in step (DICTIONARY_ENGINES.md
 * §5.4.1).
 *
 * The two halves of an engine's state live in different places. `chrome.storage` is a JSON file in
 * Kimochi's app data directory (native `storage_load`/`storage_save`), named by the app identifier
 * and shared by every way of launching Kimochi. The data the extension keeps itself (Hachidori's
 * imported dictionaries in IDBFS/OPFS, 10ten's `jpdict` IndexedDB) lives in a WebKit website data
 * store, which macOS picks per *process identity*: a bundle (`dev.kimochi.app`) and the bare dev
 * executable (`target/debug/kimochi`) get different stores. So the file can describe dictionaries
 * that are not in the store this launch opened; Hachidori then lists every one as "not an imported
 * dictionary directory".
 *
 * So the extension window (the engine origin's first-party document, where that data lives) keeps
 * a random **store marker** in the origin's own localStorage, and the hub tags the file with the
 * marker of the store its data belongs to (`host.store`). At each engine start, before the
 * extension's scripts run, the window asks the hub what the file claims is stored (descriptor
 * `persistence.claimed`), checks exactly those things in this store (`probeClaims`: IDBFS paths,
 * a non-empty database), and reports back; the hub resets the stale metadata keys when something
 * claimed is positively absent (hub.js `reconcilePersistence`). A probe that cannot tell (an API
 * missing, an open that fails) never resets anything.
 */

/** The key of the store marker in the extension origin's localStorage. Host-private. */
export const STORE_MARKER_KEY = 'kimochi.extensionStore'

/** This WebKit store's marker for the extension origin: `{id, fresh}`; `fresh` when just made. */
export function storeMarker(win, makeId) {
  try {
    const existing = win.localStorage.getItem(STORE_MARKER_KEY)
    if (existing) return { id: existing, fresh: false }
    const id = makeId()
    win.localStorage.setItem(STORE_MARKER_KEY, id)
    return { id, fresh: true }
  } catch {
    // No storage here (it would be the first thing to fail in a broken profile): no marker.
    return { id: null, fresh: false }
  }
}

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? Error('IndexedDB request failed'))
  })

/** Open an existing database without creating or upgrading it (`databases()` said it exists). */
async function openExisting(win, name) {
  const req = win.indexedDB.open(name)
  req.onupgradeneeded = () => {
    // Only fires for a database that does not exist, which `databases()` ruled out; refuse to
    // create one in the extension's name.
    req.transaction?.abort()
  }
  return request(req)
}

async function opfsHas(win, path) {
  const root = await win.navigator?.storage?.getDirectory?.()
  if (!root) return false
  const segments = path.split('/').filter(Boolean)
  // WasmFS may map the mount point to the OPFS root or keep it as a directory: try both.
  for (const candidate of [segments, segments.slice(1)]) {
    if (candidate.length === 0) continue
    try {
      let dir = root
      for (const name of candidate) dir = await dir.getDirectoryHandle(name)
      return true
    } catch {
      // Not on this layout.
    }
  }
  return false
}

/**
 * Check `claimed` (from descriptor `persistence.claimed`) in this document's storage, as the
 * descriptor's `probe` says. Returns `{checked, missing, error}`: `missing` lists only what was
 * positively not found; `error` is set (and `missing` empty) when the probe could not tell.
 */
export async function probeClaims(win, probe, claimed) {
  const result = { checked: claimed.length, missing: [], error: null }
  if (!probe || claimed.length === 0) return result
  try {
    if (typeof win.indexedDB?.databases !== 'function') throw Error('indexedDB.databases() is not available')
    const names = new Set((await win.indexedDB.databases()).map((d) => d.name))
    if (probe.kind === 'indexeddb-nonempty') {
      // One claim: the database exists and its store holds records.
      let present = false
      if (names.has(probe.database)) {
        const db = await openExisting(win, probe.database)
        try {
          present = db.objectStoreNames.contains(probe.store) && (await request(db.transaction(probe.store, 'readonly').objectStore(probe.store).count())) > 0
        } finally {
          db.close()
        }
      }
      if (!present) result.missing = [...claimed]
      return result
    }
    if (probe.kind === 'idbfs-paths') {
      // Emscripten IDBFS: one database per mount point, one record per file or directory, keyed by
      // its absolute path. A claimed directory is there when its key is.
      const absent = []
      if (names.has(probe.database)) {
        const db = await openExisting(win, probe.database)
        try {
          if (!db.objectStoreNames.contains(probe.store)) absent.push(...claimed)
          else {
            const store = db.transaction(probe.store, 'readonly').objectStore(probe.store)
            for (const path of claimed) if ((await request(store.count(path))) === 0) absent.push(path)
          }
        } finally {
          db.close()
        }
      } else absent.push(...claimed)
      for (const path of absent) {
        if (!(probe.opfs && (await opfsHas(win, path)))) result.missing.push(path)
      }
      return result
    }
    throw Error(`unknown probe ${probe.kind}`)
  } catch (error) {
    result.missing = []
    result.error = String(error?.message ?? error)
    return result
  }
}
