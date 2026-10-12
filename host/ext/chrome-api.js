/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * The `chrome.*` surface of one context (DICTIONARY_ENGINES.md §5.3).
 *
 * Everything that is about *this* document (event objects, ports it holds, alarms, i18n,
 * `getURL`) is answered here; everything shared between contexts (message routing, storage, the
 * tab and context tables) is a call to the hub through `link.call(op, args)`, whichever transport
 * that crosses. The same object is installed as `chrome` and as `browser`.
 */
import { getMessage } from './i18n.js'
import { callbackApi } from './primitives.js'
import { importLocalZip, isLocalZipImport } from './local-archive.js'
import { ChromeEvent, NO_RECEIVER, describe, json, platformInfo, randomId } from './util.js'

/**
 * Namespaces neither extension may find: both feature-detect them (`chrome.downloads?.…`,
 * `typeof scripting?.registerContentScripts`, `chrome.management ? …`), and a stub that half
 * works would send them down a path this host cannot finish.
 */
const ABSENT = [
  'management', 'scripting', 'userScripts', 'downloads', 'tabCapture', 'declarativeNetRequest',
  'webRequest', 'webNavigation', 'sidePanel', 'identity', 'debugger', 'tts', 'ttsEngine', 'menus'
]

export function createExtensionContext({ win, engine, descriptor, origin, kind, link, report, messages = null, captureHint = null }) {
  const runtimeId = `kimochi-${engine}`
  const manifest = descriptor.manifest
  let i18nState = messages
  const onError = (error) => {
    console.error(error)
    report({ check: 'ext-host-listener-error', error: describe(error), stack: String(error?.stack ?? '').slice(0, 2000) })
  }
  const event = () => new ChromeEvent(onError)

  const events = {
    onMessage: event(),
    onConnect: event(),
    onInstalled: event(),
    onStartup: event(),
    storageChanged: event(),
    areaChanged: { local: event(), sync: event(), session: event(), managed: event() },
    actionClicked: event(),
    alarm: event()
  }

  /**
   * `getURL`. Only `getURL('')` from an app document can differ from the real origin: Hachidori
   * compares `location.protocol` with the protocol of `getURL('')` and refuses to start its reader
   * when they are equal (content.js `EXTENSION_PROTOCOL`, the only caller of `getURL('')` in either
   * extension). That holds by construction on macOS and Linux (`hachidori:` vs `tauri:`), but not on
   * Windows (`http://hachidori.localhost` vs `http://tauri.localhost`) or in the browser harness
   * (two `http://127.0.0.1` ports). There, and only for the empty path from a content context, the
   * answer carries a protocol the page can never have; every real path keeps the real origin.
   */
  const getURL = (path = '') => {
    const text = String(path ?? '')
    if (text === '' && kind === 'content') {
      if (new URL(origin).protocol === win.location.protocol) return `chrome-extension://${runtimeId}/`
    }
    return new URL(text.replace(/^\/+/, ''), origin + '/').href
  }

  // ---------------------------------------------------------------- callback / promise forms

  const lastErrorHolder = { value: undefined }
  /** Promise when called without a callback, callback + `lastError` when called with one. */
  const { api } = callbackApi((value) => (lastErrorHolder.value = value))
  const unsupported = (name) =>
    api(() => {
      report({ check: 'ext-host-unsupported', api: name })
      throw Error(`${name} is not available in Kimochi`)
    })
  const noop = (value) => api(() => value)
  const hint = () => {
    if (kind !== 'content' || typeof captureHint !== 'function') return null
    try {
      return json(captureHint() ?? null)
    } catch {
      return null
    }
  }
  const call = (op, args) => link.call(op, args)

  // ---------------------------------------------------------------- messages and ports

  const ports = new Map()

  function makePort(id, name, sender, opening = Promise.resolve()) {
    const onMessage = event()
    const onDisconnect = event()
    let closed = false
    const close = (error) => {
      if (closed) return
      closed = true
      ports.delete(id)
      if (error) lastErrorHolder.value = { message: error }
      try {
        onDisconnect.emit(port)
      } finally {
        lastErrorHolder.value = undefined
      }
    }
    const port = {
      name,
      sender,
      onMessage,
      onDisconnect,
      postMessage(message) {
        if (closed) throw Error('Attempting to use a disconnected port object')
        const value = json(message)
        void opening.then(() => call('portPost', { port: id, message: value })).catch(() => close())
      },
      disconnect() {
        if (closed) return
        closed = true
        ports.delete(id)
        void opening.then(() => call('portClose', { port: id })).catch(() => {})
      }
    }
    ports.set(id, { port, close, onMessage })
    return port
  }

  function connect(target, info) {
    const id = randomId('P')
    // Chrome accepts posts immediately; our asynchronous worker wake-up must finish first.
    const opening = call('connect', { port: id, name: info?.name ?? '', ...target })
    const port = makePort(id, info?.name ?? '', undefined, opening)
    void opening.catch((error) => ports.get(id)?.close(describe(error)))
    return port
  }

  /**
   * Run this context's `onMessage` listeners for one delivery, with Chrome's rules: the first
   * `sendResponse` wins; `true` keeps the channel open; a returned promise answers with its value;
   * listeners that do neither leave the message unanswered.
   */
  function runListeners(message, sender, settle) {
    const listeners = [...events.onMessage.listeners]
    if (listeners.length === 0) return settle({ status: 'none' })
    let settled = false
    let pending = false
    const respond = (result) => {
      if (settled) return
      settled = true
      settle(result)
    }
    const sendResponse = (value) => respond({ status: 'response', value: json(value) })
    for (const listener of listeners) {
      let returned
      try {
        returned = listener(json(message), json(sender), sendResponse)
      } catch (error) {
        onError(error)
        continue
      }
      if (returned === true) pending = true
      else if (returned && typeof returned.then === 'function') {
        pending = true
        returned.then(
          (value) => respond({ status: 'response', value: json(value) }),
          (error) => respond({ status: 'error', error: describe(error) })
        )
      }
    }
    if (settled) return undefined
    if (pending) return settle({ status: 'pending' })
    return settle({ status: 'unanswered' })
  }

  /** Events the hub sends this context. */
  function handleEvent(frame) {
    switch (frame?.type) {
      case 'deliver':
        runListeners(frame.message, frame.sender, (result) => {
          void call('delivered', { id: frame.id, ...result }).catch(() => {})
        })
        break
      case 'port-open': {
        if (!events.onConnect.hasListeners()) {
          void call('portClose', { port: frame.port, noListener: true }).catch(() => {})
          break
        }
        const port = makePort(frame.port, frame.name, frame.sender)
        events.onConnect.emit(port)
        break
      }
      case 'port-message': {
        const entry = ports.get(frame.port)
        entry?.onMessage.emit(json(frame.message), entry.port)
        break
      }
      case 'port-close':
        ports.get(frame.port)?.close(frame.error)
        break
      case 'storage-changed':
        events.storageChanged.emit(json(frame.changes), frame.area)
        events.areaChanged[frame.area]?.emit(json(frame.changes))
        break
      case 'action-clicked':
        events.actionClicked.emit(json(frame.tab))
        break
      default:
        break
    }
  }

  /**
   * Deliver a message straight to this context's own listeners, as the background would with
   * `tabs.sendMessage`. The host uses it to drive Hachidori's `hd_reader_command`.
   */
  function deliverLocal(message, sender) {
    return new Promise((resolve) => {
      runListeners(message, sender, (result) => {
        if (result.status !== 'pending') resolve(result)
      })
      // A pending listener resolves through the same callback later; nothing waits on it here.
      setTimeout(() => resolve({ status: 'pending' }), 0)
    })
  }

  /** `sendMessage([extensionId,] message [, options])`, Chrome's overload rules. */
  function messageArgs(args) {
    if (args.length >= 2 && (typeof args[0] === 'string' || args[0] === undefined || args[0] === null) && typeof args[1] !== 'function' && args[1] !== undefined) {
      if (args[0] && args[0] !== runtimeId) throw Error(NO_RECEIVER)
      return args[1]
    }
    return args[0]
  }

  // ---------------------------------------------------------------- storage

  function storageArea(area) {
    const op = (action, extra) => call('storage', { area, action, ...extra })
    return {
      get: api((keys) => op('get', { keys: keys === undefined ? null : json(keys) })),
      getKeys: api(() => op('getKeys', {})),
      set: api((values) => op('set', { values: json(values ?? {}) }).then(() => undefined)),
      remove: api((keys) => op('remove', { keys: json(keys) }).then(() => undefined)),
      clear: api(() => op('clear', {}).then(() => undefined)),
      getBytesInUse: api((keys) => op('getBytesInUse', { keys: keys === undefined ? null : json(keys) })),
      setAccessLevel: noop(undefined),
      onChanged: events.areaChanged[area],
      QUOTA_BYTES: area === 'sync' ? 102400 : area === 'session' ? 10485760 : 10485760
    }
  }

  // ---------------------------------------------------------------- alarms (10ten only)

  function createAlarms() {
    const MAX_TIMER_MS = 2 ** 31 - 1
    const alarms = new Map()
    const arm = (alarm) => {
      clearTimeout(alarm.timer)
      alarm.timer = setTimeout(() => {
        if (Date.now() < alarm.scheduledTime) return arm(alarm)
        const fired = { name: alarm.name, scheduledTime: alarm.scheduledTime }
        if (alarm.periodInMinutes) fired.periodInMinutes = alarm.periodInMinutes
        if (alarm.periodInMinutes) {
          alarm.scheduledTime = Date.now() + alarm.periodInMinutes * 60000
          arm(alarm)
        } else alarms.delete(alarm.name)
        events.alarm.emit(fired)
      }, Math.min(Math.max(alarm.scheduledTime - Date.now(), 0), MAX_TIMER_MS))
    }
    const view = (alarm) => {
      const out = { name: alarm.name, scheduledTime: alarm.scheduledTime }
      if (alarm.periodInMinutes) out.periodInMinutes = alarm.periodInMinutes
      return out
    }
    return {
      create: api((nameOrInfo, maybeInfo) => {
        const name = typeof nameOrInfo === 'string' ? nameOrInfo : ''
        const info = (typeof nameOrInfo === 'string' ? maybeInfo : nameOrInfo) ?? {}
        clearTimeout(alarms.get(name)?.timer)
        const scheduledTime =
          info.when ?? Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60000
        const alarm = { name, scheduledTime, periodInMinutes: info.periodInMinutes }
        alarms.set(name, alarm)
        arm(alarm)
      }),
      get: api((name = '') => (alarms.has(name) ? view(alarms.get(name)) : undefined)),
      getAll: api(() => [...alarms.values()].map(view)),
      clear: api((name = '') => {
        const alarm = alarms.get(name)
        if (!alarm) return false
        clearTimeout(alarm.timer)
        alarms.delete(name)
        return true
      }),
      clearAll: api(() => {
        for (const alarm of alarms.values()) clearTimeout(alarm.timer)
        const had = alarms.size > 0
        alarms.clear()
        return had
      }),
      onAlarm: events.alarm
    }
  }

  // ---------------------------------------------------------------- the surface

  const actionApi = {
    setIcon: noop(undefined),
    setTitle: noop(undefined),
    getTitle: noop(manifest.action?.default_title ?? manifest.name),
    setBadgeText: noop(undefined),
    getBadgeText: noop(''),
    setBadgeBackgroundColor: noop(undefined),
    getBadgeBackgroundColor: noop([0, 0, 0, 0]),
    setBadgeTextColor: noop(undefined),
    setPopup: noop(undefined),
    getPopup: noop(''),
    enable: noop(undefined),
    disable: noop(undefined),
    isEnabled: noop(true),
    getUserSettings: noop({ isOnToolbar: false }),
    openPopup: unsupported('action.openPopup'),
    onClicked: events.actionClicked
  }

  const permissionsList = { permissions: [...(manifest.permissions ?? [])], origins: [...(manifest.host_permissions ?? [])] }
  const chromeApi = {
    runtime: {
      id: runtimeId,
      get lastError() {
        return lastErrorHolder.value
      },
      getURL,
      getManifest: () => json(manifest),
      getPlatformInfo: api(() => platformInfo(win)),
      // A content context says which transcript line it is reading, for `captureVisibleTab`.
      sendMessage: api((...args) => {
        const message = json(messageArgs(args))
        const send = (value) => call('sendMessage', { message: value, capture: hint() })
        return engine === 'hachidori' && kind === 'page' && isLocalZipImport(message)
          ? importLocalZip(win, message, send, report) : send(message)
      }),
      connect: (...args) => {
        const info = typeof args[0] === 'object' && args[0] !== null ? args[0] : args[1]
        return connect({}, info)
      },
      onMessage: events.onMessage,
      onConnect: events.onConnect,
      onMessageExternal: event(),
      onConnectExternal: event(),
      onInstalled: events.onInstalled,
      onStartup: events.onStartup,
      onSuspend: event(),
      onSuspendCanceled: event(),
      onUpdateAvailable: event(),
      onRestartRequired: event(),
      openOptionsPage: api(() => call('open', { url: getURL(descriptor.optionsPage) }).then(() => undefined)),
      getContexts: api((filter) => call('getContexts', { filter: json(filter ?? {}) })),
      setUninstallURL: noop(undefined),
      requestUpdateCheck: noop({ status: 'no_update' }),
      reload: unsupported('runtime.reload'),
      restart: unsupported('runtime.restart'),
      OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
      ContextType: { TAB: 'TAB', POPUP: 'POPUP', BACKGROUND: 'BACKGROUND', OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT', SIDE_PANEL: 'SIDE_PANEL', DEVELOPER_TOOLS: 'DEVELOPER_TOOLS' },
      PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd', FUCHSIA: 'fuchsia' }
    },
    storage: {
      local: storageArea('local'),
      sync: storageArea('sync'),
      session: storageArea('session'),
      onChanged: events.storageChanged
    },
    tabs: {
      query: api((queryInfo) => call('tabs', { action: 'query', args: [json(queryInfo ?? {})] })),
      get: api((tabId) => call('tabs', { action: 'get', args: [tabId] })),
      // Extension pages here live in a panel, not a tab, and Chrome answers `undefined` outside one.
      getCurrent: api(() => undefined),
      sendMessage: api((tabId, message, options) =>
        call('tabsSendMessage', { tabId, message: json(message), options: json(options ?? {}) })
      ),
      connect: (tabId, info) => connect({ tabId, frameId: info?.frameId, documentId: info?.documentId }, info),
      create: api((props) => call('open', { url: props?.url ?? getURL(descriptor.optionsPage) })),
      update: api((tabIdOrProps, maybeProps) => {
        const props = typeof tabIdOrProps === 'object' ? tabIdOrProps : maybeProps
        return props?.url ? call('open', { url: props.url }) : call('tabs', { action: 'get', args: [typeof tabIdOrProps === 'number' ? tabIdOrProps : 1] })
      }),
      getZoom: noop(1),
      setZoom: noop(undefined),
      getZoomSettings: noop({ mode: 'automatic', scope: 'per-origin', defaultZoomFactor: 1 }),
      reload: unsupported('tabs.reload'),
      remove: unsupported('tabs.remove'),
      // `(windowId?, options?)`: the captured source frame as a data URL (hub.js, capture.js).
      captureVisibleTab: api((...args) => {
        const windowId = typeof args[0] === 'object' && args[0] !== null ? undefined : args[0]
        const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : args[1]
        return call('captureVisibleTab', { windowId: windowId ?? null, options: json(options ?? {}) })
      }),
      onActivated: event(),
      onUpdated: event(),
      onRemoved: event(),
      onCreated: event(),
      onReplaced: event(),
      onZoomChange: event(),
      TAB_ID_NONE: -1
    },
    windows: {
      getAll: api((info) => call('windows', { action: 'getAll', args: [json(info ?? {})] })),
      get: api((id, info) => call('windows', { action: 'get', args: [id, json(info ?? {})] })),
      getCurrent: api((info) => call('windows', { action: 'get', args: [1, json(info ?? {})] })),
      getLastFocused: api((info) => call('windows', { action: 'get', args: [1, json(info ?? {})] })),
      create: unsupported('windows.create'),
      update: api(() => call('windows', { action: 'get', args: [1, {}] })),
      remove: unsupported('windows.remove'),
      onFocusChanged: event(),
      onCreated: event(),
      onRemoved: event(),
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2
    },
    i18n: {
      getMessage: (name, substitutions) => getMessage(i18nState, runtimeId, name, substitutions),
      getUILanguage: () => win.navigator?.language ?? 'en',
      getAcceptLanguages: api(() => [...(win.navigator?.languages ?? [win.navigator?.language ?? 'en'])]),
      detectLanguage: unsupported('i18n.detectLanguage')
    },
    contextMenus: {
      // 10ten (context-menus.ts) creates its items with a callback and treats `lastError` in it
      // as "already exists, update instead"; the callback must therefore run, without error.
      create: (props, cb) => {
        if (typeof cb === 'function') setTimeout(() => cb(), 0)
        return props?.id ?? randomId('M')
      },
      update: noop(undefined),
      remove: noop(undefined),
      removeAll: noop(undefined),
      onClicked: event(),
      onShown: event(),
      onHidden: event()
    },
    action: actionApi,
    browserAction: actionApi,
    commands: {
      getAll: noop([]),
      update: noop(undefined),
      reset: noop(undefined),
      onCommand: event(),
      onChanged: event()
    },
    permissions: {
      getAll: api(() => json(permissionsList)),
      contains: api(({ permissions = [], origins = [] } = {}) =>
        permissions.every((p) => permissionsList.permissions.includes(p)) &&
        origins.every((o) => permissionsList.origins.includes('<all_urls>') || permissionsList.origins.includes(o))
      ),
      request: api(({ permissions = [], origins = [] } = {}) =>
        permissions.every((p) => permissionsList.permissions.includes(p)) &&
        origins.every((o) => permissionsList.origins.includes('<all_urls>') || permissionsList.origins.includes(o))
      ),
      remove: noop(false),
      onAdded: event(),
      onRemoved: event()
    },
    offscreen: {
      createDocument: api((params) => call('offscreen', { action: 'create', url: params?.url })),
      hasDocument: api(() => call('offscreen', { action: 'has' })),
      closeDocument: api(() => call('offscreen', { action: 'close' })),
      Reason: {
        TESTING: 'TESTING', AUDIO_PLAYBACK: 'AUDIO_PLAYBACK', IFRAME_SCRIPTING: 'IFRAME_SCRIPTING', DOM_SCRAPING: 'DOM_SCRAPING',
        BLOBS: 'BLOBS', DOM_PARSER: 'DOM_PARSER', USER_MEDIA: 'USER_MEDIA', DISPLAY_MEDIA: 'DISPLAY_MEDIA', WEB_RTC: 'WEB_RTC',
        CLIPBOARD: 'CLIPBOARD', LOCAL_STORAGE: 'LOCAL_STORAGE', WORKERS: 'WORKERS', BATTERY_STATUS: 'BATTERY_STATUS',
        MATCH_MEDIA: 'MATCH_MEDIA', GEOLOCATION: 'GEOLOCATION'
      }
    },
    extension: {
      inIncognitoContext: false,
      isAllowedFileSchemeAccess: noop(false),
      isAllowedIncognitoAccess: noop(false),
      getURL
    }
  }
  if (descriptor.alarms) chromeApi.alarms = createAlarms()

  // Tauri's Windows IPC is WebView2's own `chrome.webview`; whatever the engine already put on
  // `window.chrome` (WebView2's bridge, Chrome's `loadTimes`) stays reachable.
  const previous = win.chrome
  if (previous && typeof previous === 'object') {
    for (const key of Object.keys(previous)) if (!(key in chromeApi)) chromeApi[key] = previous[key]
    if (previous.webview) chromeApi.webview = previous.webview
  }

  /** Reading an absent namespace is reported once: it is a feature the engine wanted and lacks. */
  const reportedAbsent = new Set()
  const chrome = new Proxy(chromeApi, {
    has(target, key) {
      if (ABSENT.includes(key)) return false
      return key in target
    },
    get(target, key, receiver) {
      if (typeof key === 'string' && ABSENT.includes(key)) {
        if (!reportedAbsent.has(key)) {
          reportedAbsent.add(key)
          report({ check: 'ext-host-absent-api', api: key })
        }
        return undefined
      }
      return Reflect.get(target, key, receiver)
    }
  })

  return {
    chrome,
    events,
    handleEvent,
    deliverLocal,
    getURL,
    runtimeId,
    setMessages(state) {
      i18nState = state
    },
    /** Every port this document holds hangs up when it goes away, as Chrome does. */
    disconnectAll() {
      for (const { port } of [...ports.values()]) port.disconnect()
    }
  }
}
