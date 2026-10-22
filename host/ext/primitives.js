/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * Engine-independent primitives shared by every extension host Kimochi runs: the generic host
 * (`host/ext/`, Hachidori and 10ten) and the Yomitan shims (`host/yomitan/`, bundled into
 * `dist/spike/shim.js` and `dist/spike/panel-shim.js`). DICTIONARY_ENGINES.md §11.4.
 *
 * Imports nothing, on purpose: the Yomitan bundles must not pull in the extension manifests that
 * `engines.js` inlines. Nothing here touches `window` at module load either, because the Yomitan
 * bundles are also run in `node:vm` by the tests with a hand-made global.
 */

/** The engine this document runs (DICTIONARY_ENGINES.md §2). Never null: Yomitan is the default. */
export function resolveEngine(win) {
  let stored
  try {
    stored = win.localStorage['kimochi.dictionaryEngine']
  } catch {
    // No storage (sandboxed frame, node:vm): fall back to the prelude.
  }
  const engine = stored ?? win.__kimochiDictionaryEngine ?? 'yomitan'
  // 'builtin' is Yomitan's stored name. The Yomitan API pop-up ('custom-api') needs no host: it
  // talks to the browser's Yomitan (the mirror holds 'none' for it; a stored spelling here too).
  if (engine === 'custom-api') return 'none'
  return engine === 'builtin' ? 'yomitan' : engine
}

/**
 * `chrome.*` events. A throwing listener is handed to `onError`; the generic host reports it and
 * carries on with the other listeners, the Yomitan shims rethrow (stopping the loop), which is
 * what their hand-written events always did.
 */
export class ChromeEvent {
  constructor(onError = (error) => console.error(error)) {
    this.listeners = new Set()
    this.onError = onError
    this.addListener = (f) => {
      if (typeof f === 'function') this.listeners.add(f)
    }
    this.removeListener = (f) => this.listeners.delete(f)
    this.hasListener = (f) => this.listeners.has(f)
    this.hasListeners = () => this.listeners.size > 0
    // Bound, like the listener methods: callers pass `event.emit` around detached.
    this.emit = (...args) => {
      for (const f of [...this.listeners]) {
        try {
          f(...args)
        } catch (error) {
          this.onError(error)
        }
      }
    }
  }
}

/** For hosts whose events let a listener's exception propagate. */
export const rethrow = (error) => {
  throw error
}

/**
 * The promise and callback forms of an asynchronous `chrome.*` call. Called without a callback it
 * returns the promise; with one (the last argument) it calls back with the value, or with no
 * argument and `lastError` set for the duration of the callback, as Chrome does.
 * `setLastError(value | undefined)` is how the host exposes `chrome.runtime.lastError`.
 */
export function callbackApi(setLastError) {
  const finish = (promise, cb) => {
    if (typeof cb !== 'function') return promise
    promise.then(
      (value) => cb(value),
      (error) => {
        setLastError({ message: describe(error) })
        try {
          cb()
        } finally {
          setLastError(undefined)
        }
      }
    )
    return undefined
  }
  const api =
    (fn) =>
    (...args) => {
      const cb = typeof args.at(-1) === 'function' ? args.pop() : undefined
      return finish(
        Promise.resolve().then(() => fn(...args)),
        cb
      )
    }
  return { finish, api }
}

/**
 * `storage.<area>.get(keys)` over a plain object: null for everything, a key or a list of keys,
 * or an object of defaults. `copy` decides what crosses (structuredClone in-realm, JSON across a
 * transport).
 */
export function selectStorage(data, keys, copy) {
  if (keys === null || keys === undefined) return copy(data)
  if (typeof keys === 'string') keys = [keys]
  if (Array.isArray(keys)) return copy(Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])))
  return copy(Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, k in data ? data[k] : v])))
}

/**
 * `storage.onChanged`'s `changes` between two snapshots of an area. Chrome's shape: `oldValue`
 * only for a key that existed, `newValue` only for a key that still does.
 */
export function storageChanges(previous, next, copy) {
  const changes = {}
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (JSON.stringify(previous[key]) === JSON.stringify(next[key])) continue
    const change = {}
    if (key in previous) change.oldValue = previous[key]
    if (key in next) change.newValue = copy(next[key])
    changes[key] = change
  }
  return changes
}

/**
 * Run every `onMessage` listener of `targets` the way Chrome's `sendMessage` does inside one
 * realm: the first `sendResponse` wins, `return true` keeps the channel open, a returned promise
 * answers. `handled` says whether anyone will answer; `response` settles with that answer.
 */
export function runListeners(targets, message, sender, copy) {
  let handled = false
  let done
  const response = new Promise((resolve) => {
    done = resolve
  })
  for (const target of targets) {
    for (const listener of [...target.events.onMessage.listeners]) {
      const value = listener(copy(message), copy(sender), (data) => {
        handled = true
        done(copy(data))
      })
      if (value === true) handled = true
      else if (value?.then) {
        handled = true
        value.then(done)
      }
    }
  }
  return { handled, response }
}

/**
 * Listen to native's channel, broadcast and window-addressed relay events. Channels transfer
 * large replies without evaluating huge JS events. Separate event names keep
 * large replies out of unrelated WebViews; the address filter also guards older hosts and the
 * browser harness. Native stamps a per-sender `seq`, and
 * delivery is not exactly-once, so a sequence number already seen from a sender is dropped (a
 * redelivered port acknowledgement fails the whole call, a redelivered broadcast fires every
 * listener twice). `onDuplicate(from, seq)` is told about each drop.
 */
export async function listenRelay(tauri, label, onPayload, onDuplicate = () => {}) {
  if (!tauri?.event?.listen) return
  const seen = new Map()
  const receive = ({ payload }) => {
    if (!payload?.payload) return
    const { from, to, seq } = payload
    if (from === label) return
    if (typeof to === 'string' && to !== label) return
    if (typeof seq === 'number' && typeof from === 'string') {
      if (seq <= (seen.get(from) ?? 0)) {
        onDuplicate(from, seq)
        return
      }
      seen.set(from, seq)
    }
    onPayload(payload.payload, from)
  }
  if (typeof tauri.core?.Channel === 'function') {
    const channel = new tauri.core.Channel((payload) => receive({ payload }))
    await tauri.core.invoke('ext_relay_listen', { channel })
  }
  await Promise.all(['ext-relay', `ext-relay:${label}`].map((event) => tauri.event.listen(event, receive)))
}

/**
 * The tab id of a window, from its label: the overlay is tab 1, every other window a stable
 * non-zero id of its own (10ten drops `sender.tab.id === 0`; Yomitan's backend routes by tab id).
 */
export function tabIdFor(label) {
  if (label === 'overlay') return 1
  let tabId = 2
  for (const ch of String(label)) tabId = ((tabId * 31 + ch.charCodeAt(0)) >>> 0) % 1000000 || 2
  return tabId === 1 ? 2 : tabId
}

/**
 * `chrome.runtime.getPlatformInfo()`, from native's `__KIMOCHI_PLATFORM__`
 * (`{os: 'macos' | 'windows' | 'linux', arch}`) on `win` or else on `fallback` (a frame's top
 * window), else sniffed from the user agent's platform.
 */
export function platformInfo(win, fallback = null) {
  let injected = win.__KIMOCHI_PLATFORM__
  try {
    injected ??= fallback?.__KIMOCHI_PLATFORM__
  } catch {
    // A detached or foreign fallback keeps the sniffed answer.
  }
  const OS = { macos: 'mac', mac: 'mac', windows: 'win', win: 'win', linux: 'linux' }
  const ARCH = {
    aarch64: 'arm64',
    arm64: 'arm64',
    x86_64: 'x86-64',
    'x86-64': 'x86-64',
    x86: 'x86-32',
    'x86-32': 'x86-32',
    arm: 'arm'
  }
  const platform = win.navigator?.platform ?? ''
  const os = OS[injected?.os] ?? (/Mac/.test(platform) ? 'mac' : /Win/.test(platform) ? 'win' : 'linux')
  const arch = ARCH[injected?.arch] ?? 'arm64'
  return { os, arch, nacl_arch: arch }
}

/**
 * The JSON image of a value, which is what `chrome.storage` and message passing carry across a
 * transport: functions and `undefined` members disappear, as they do in Chrome.
 */
export function json(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** An in-realm copy, as the Yomitan hosts make between same-origin frames. */
export function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

export function describe(error) {
  return String(error?.message ?? error)
}

/** Resolve with `promise`, or reject with `message` if it has not settled within `ms`. */
export function within(promise, ms, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
