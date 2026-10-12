/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
// Session storage survives an engine reload, but a new app session gets fresh scan IDs.
const KEY = 'kimochi.publishedScan'

/** `sessionStorage` can throw on access itself in a locked-down webview; then nothing is kept. */
function defaultStorage() {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

export function scanWasPublished(id, storage = defaultStorage()) {
  if (id == null || !storage) return false
  try { return storage.getItem(KEY) === String(id) } catch { return false }
}

export function markScanPublished(id, storage = defaultStorage()) {
  if (id == null || !storage) return
  try { storage.setItem(KEY, String(id)) } catch { /* Storage is best-effort. */ }
}
