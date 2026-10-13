/**
 * Browser integration harness for the generic extension host (DICTIONARY_ENGINES.md §9).
 *
 * A classic script loaded before `/spike/ext-host.js`, because the host reads everything it
 * needs synchronously when it installs: the engine mirror in localStorage and the extension
 * origins (`window.__TAURI__` comes from dictionary-harness-native.js, loaded just before). Once the
 * page is parsed it starts the engine the way the overlay does and wires the buttons. Everything
 * the host reports (here and in the extension window's page) lands in the on-page log, in
 * `window.__harness.log`, and in the console as `[report] …`, so a devtools-driven tester can read
 * the outcome without guessing.
 *
 * Query: `?engine=hachidori|tenten|yomitan` (default hachidori; yomitan runs the overlay's Yomitan
 * path over `/spike/shim.js` instead, see dictionary-harness-yomitan.js), `?hachidori=<origin>&tenten=<origin>`
 * (defaults http://127.0.0.1:1440 and :1441, the dev server's extension ports), `?scope=<selector>`
 * (the scan scope passed to `start`, as the Log passes `[data-yomitan-scan]`; default none),
 * `?fetch=proxy[&chunk=<bytes>&ipc=<ms>]` (remote fetches through the plugin-http stand-in),
 * `?relay=1` on the hub page plus a second page with `?window=dictionary` (the app's cross-window
 * layout: extension pages open in the second page and reach the hub over the emulated `ext_relay`),
 * `?frame=none` (the mining-screenshot frame source answers as before any scan),
 * `?dictionary=<url>` (Yomitan only, repeatable: import these Yomitan zips instead of the fixture).
 *
 * The native stand-in itself (`window.__TAURI__`, the relay bus, plugin-http over the dev proxy,
 * `extension_window_ensure` opening the extension window's page) is dictionary-harness-native.js,
 * shared with that page. Starting Hachidori or 10ten here opens it: their background (and
 * Hachidori's offscreen document) run there, first-party on the extension origin, as in the app's
 * hidden `ext-<id>` window (DICTIONARY_ENGINES.md §5.4).
 */
;(() => {
  const params = new URLSearchParams(location.search)
  const engine = ['tenten', 'yomitan'].includes(params.get('engine')) ? params.get('engine') : 'hachidori'
  const origins = {
    hachidori: (params.get('hachidori') ?? 'http://127.0.0.1:1440').replace(/\/+$/, ''),
    tenten: (params.get('tenten') ?? 'http://127.0.0.1:1441').replace(/\/+$/, '')
  }
  try {
    localStorage['kimochi.dictionaryEngine'] = engine
  } catch (error) {
    console.error('[harness] localStorage unavailable', error)
  }
  window.__kimochiExtensionOrigins = origins
  // Native injects the Yomitan shim into every frame of the overlay; in the browser the dev server
  // does it for this origin's HTML while this cookie is set (vite.dev.config.ts). Cleared for the
  // other engines, whose frames are on their own origins and get the generic host instead.
  document.cookie = engine === 'yomitan'
    ? 'kimochi-harness-shim=yomitan; path=/; SameSite=Strict'
    : 'kimochi-harness-shim=; path=/; max-age=0; SameSite=Strict'

  const scope = params.get('scope') || null
  // `?window=dictionary` (or `log`): this page plays that Kimochi window, a relay client of the hub
  // page (the default, `overlay`). The native stand-in (dictionary-harness-native.js, loaded first)
  // carries the relay between them and to the extension window's page, which the hub opens (or
  // asks you to open, behind a popup blocker) at `<extension origin>/__kimochi/ext-background.html
  // ?engine=<id>&window=ext-<id>` as native opens the hidden `ext-<id>` window.
  const windowLabel = ['dictionary', 'log'].includes(params.get('window')) ? params.get('window') : null
  if (windowLabel) window.__kimochiPanelLabel = windowLabel
  const native = window.__harnessNative ?? null
  const harness = (window.__harness = {
    engine,
    origins,
    scope,
    window: windowLabel ?? 'overlay',
    relayed: Boolean(native?.relay),
    log: [],
    start: null,
    popup: null,
    mocked: Boolean(native),
    native,
    captures: native?.captures ?? [],
    get http() {
      return native?.http ?? null
    },
    get extensionWindow() {
      return native?.extensionWindow ? { url: native.extensionWindow.url, open: Boolean(native.extensionWindow.handle && !native.extensionWindow.handle.closed) } : null
    }
  })
  const storageKey = (extension) => `kimochi.harness.chrome-local-${extension ?? 'yomitan'}`

  const append = (line) => {
    harness.log.push(line)
    const pre = document.getElementById('log')
    if (pre) {
      pre.textContent += `${line}\n`
      pre.scrollTop = pre.scrollHeight
    }
  }
  const appendReport = (event) => {
    const { at, ...rest } = event.detail ?? {}
    append(`${new Date(at ?? Date.now()).toISOString().slice(11, 23)} ${JSON.stringify(rest)}`)
  }
  window.addEventListener('kimochi-ext-host-report', appendReport)
  // The extension window page's own diagnostics, relayed by the native stand-in.
  window.addEventListener('kimochi-harness-remote-report', (event) => {
    const { at, ...rest } = event.detail ?? {}
    append(`${new Date(at ?? Date.now()).toISOString().slice(11, 23)} [${rest.window ?? 'ext'}] ${JSON.stringify(rest)}`)
  })
  // The Yomitan shim's hub logs as `spike-log`.
  window.addEventListener('spike-log', appendReport)
  window.addEventListener('error', (event) => append(`page error: ${event.message} @ ${event.filename}:${event.lineno}`))
  window.addEventListener('unhandledrejection', (event) => append(`unhandled rejection: ${String(event.reason?.message ?? event.reason)}`))

  // Extension pages (options, Hachidori's first-run startup page) open here.
  window.addEventListener('kimochi-dictionary-navigate', (event) => {
    append(`navigate → ${event.detail.url}`)
    const frame = document.getElementById('options')
    if (frame) frame.src = event.detail.url
  })

  /** 食べました in #target, which may span several text nodes (the hover anchor splits it). */
  function targetRange() {
    const word = '食べました'
    const paragraph = document.getElementById('target')
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    const nodes = []
    let text = ''
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node, from: text.length })
      text += node.data
    }
    const index = text.indexOf(word)
    if (index < 0) return null
    const locate = (offset) => {
      const hit = nodes.findLast(({ from }) => from <= offset)
      return [hit.node, offset - hit.from]
    }
    const range = document.createRange()
    range.setStart(...locate(index))
    range.setEnd(...locate(index + word.length))
    return range
  }

  function showStatus() {
    const pre = document.getElementById('status')
    if (pre) pre.textContent = JSON.stringify({ start: harness.start, popup: harness.popup, host: harness.host?.status?.() ?? null }, null, 2)
  }

  window.addEventListener('DOMContentLoaded', async () => {
    // Pages other than the harness (frontend/dev/dictionary-preview.html) leave out what they do not show.
    const setText = (id, text) => {
      const element = document.getElementById(id)
      if (element) element.textContent = text
      return element
    }
    setText('engine', engine)
    setText('origin', origins[engine] ?? location.origin)
    setText('log', harness.log.map((line) => `${line}\n`).join(''))
    const openPage = (url) => {
      append(`navigate → ${url}`)
      const frame = document.getElementById('options')
      if (frame) frame.src = url
    }
    const host = (harness.host =
      engine === 'yomitan'
        ? window.__extensionHost &&
          (await import('/ui/dictionary-harness-yomitan.js')).createYomitanHarness({
            log: (value) => window.__extensionHost.log(value),
            openPage,
            dictionaries: params.getAll('dictionary')
          })
        : window.__kimochiExtensionHost)
    if (!host) {
      harness.start = {
        ready: false,
        error: engine === 'yomitan'
          ? 'window.__extensionHost is missing: did /spike/shim.js load and install for yomitan?'
          : 'window.__kimochiExtensionHost is missing: did /spike/ext-host.js load and resolve the engine?'
      }
      setText('ready', 'host missing')
      showStatus()
      return
    }
    const outline = document.getElementById('popup-outline') ?? document.createElement('div')
    host.observePopup((state) => {
      harness.popup = state
      append(`popup ${state.visible ? `visible ${JSON.stringify(state.rect)}` : 'hidden'}`)
      if (state.visible) {
        Object.assign(outline.style, { display: 'block', left: `${state.rect.x}px`, top: `${state.rect.y}px`, width: `${state.rect.width}px`, height: `${state.rect.height}px` })
      } else outline.style.display = 'none'
      showStatus()
    })
    const click = (id, fn) =>
      document.getElementById(id)?.addEventListener('click', async () => {
        append(`button: ${id}`)
        try {
          const value = await fn()
          if (value !== undefined) append(`  → ${JSON.stringify(value)}`)
        } catch (error) {
          append(`  ✖ ${String(error?.message ?? error)}`)
        }
        showStatus()
      })
    click('lookup', () => host.lookupRange(targetRange()))
    click('next', () => host.popupControl({ step: 1 }))
    click('prev', () => host.popupControl({ step: -1 }))
    click('scroll', () => host.popupControl({ scroll: 120 }))
    click('dismiss', () => host.dismiss())
    click('open-options', () => host.openOptionsPage())
    click('action', () => host.clickAction?.())
    click('reset', () => {
      localStorage.removeItem(storageKey(engine))
      location.reload()
    })

    setText('ready', 'starting')
    showStatus()
    if (windowLabel === 'dictionary') {
      // The dictionary panel starts nothing: its router relays to the hub by itself, and the
      // extension page arrives as `kimochi-dictionary-navigate` (above).
      harness.start = { ready: true, window: 'dictionary' }
      setText('ready', 'dictionary window (relay client)')
      append('dictionary window: waiting for the hub to open a page here')
      showStatus()
      return
    }
    harness.start = await host.start({ scope, host: windowLabel === null })
    const ready = setText('ready', harness.start.ready ? 'ready' : 'failed')
    if (ready) ready.dataset.state = harness.start.ready ? 'ready' : 'failed'
    append(`start → ${JSON.stringify(harness.start)}`)
    showStatus()
  })
})()
