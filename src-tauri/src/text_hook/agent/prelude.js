// Kimochi's Agent host, inside the game (text_hook/agent/mod.rs builds the script: this prelude,
// the Frida 16 API shim, then the collection's libLoader.js inside
// `(function (send, recv) { … }).call(globalThis, __kimochi.send, __kimochi.recv)`, then
// `__kimochi.ready()`).
//
// libLoader.js asks its host for what it needs (`send({cmd, key, ...})` then `recv(key).wait()`):
// the script to run, the files it requires, a place to keep settings. Kimochi answers here, in the
// game, so nothing has to travel back: files are read with Frida's File API, from the scripts
// folder only; writes are refused; settings last as long as the session. What Kimochi reads (the
// text, the script's log, that it loaded) goes out on frida-inject's standard error, which is not
// buffered, one marked JSON line each.
//
// `__kimochi` is defined before this file: `{ dir, mission, maxChars }` (dir and mission are the
// game's own paths: Windows paths, under Wine too).
;(function () {
  'use strict'
  const host = globalThis.__kimochi
  const MARK = '\u0001K '
  const error = console.error.bind(console)
  // ASCII only: frida-inject may write standard error in the console's code page (Frida 16 does,
  // and Wine's may not be UTF-8), which would mangle Japanese; \u escapes come through any of them.
  const ascii = (json) => json.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  const out = (payload) => {
    try {
      error(MARK + ascii(JSON.stringify(payload)))
    } catch (_) {}
  }

  // The script's own log, at once rather than when frida-inject flushes its output.
  const logged = (level) =>
    function () {
      out({ cmd: 'log', level, text: Array.prototype.map.call(arguments, String).join(' ').slice(0, 2000) })
    }
  console.log = logged('info')
  console.info = logged('info')
  console.warn = logged('warning')
  console.error = logged('error')
  console.debug = () => {}

  // ---------------------------------------------------------------- paths (the game’s platform)
  const windows = Process.platform === 'windows'
  const SEP = windows ? '\\' : '/'
  const isAbsolute = (p) => (windows ? /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p) : p.startsWith('/'))
  function normalise(p) {
    const drive = windows ? (/^[A-Za-z]:/.exec(p)?.[0] ?? '') : ''
    const parts = []
    for (const part of p.slice(drive.length).split(windows ? /[\\/]+/ : /\/+/)) {
      if (!part || part === '.') continue
      if (part === '..') parts.pop()
      else parts.push(part)
    }
    return drive + SEP + parts.join(SEP)
  }
  const resolve = (base, p) => normalise(isAbsolute(p) ? p : base + SEP + p)
  const dirname = (p) => {
    const n = normalise(String(p))
    const at = n.lastIndexOf(SEP)
    return at > (windows ? 2 : 0) ? n.slice(0, at) : n.slice(0, windows ? 3 : 1)
  }
  const root = normalise(host.dir)
  // Only the collection's own files are ever read.
  const inside = (p) => {
    const lower = windows ? p.toLowerCase() : p
    const base = windows ? root.toLowerCase() : root
    return lower === base || lower.startsWith(base + SEP)
  }
  function isFile(p) {
    if (!inside(p)) return false
    try {
      new File(p, 'rb').close()
      return true
    } catch (_) {
      return false
    }
  }
  function readText(p) {
    if (!inside(p)) return null
    try {
      return patchLibrary(p, File.readAllText(p))
    } catch (_) {
      return null
    }
  }

  // Overlays are applied to loaded source only: the verified collection remains byte-for-byte
  // pinned. These ARM64 library branches otherwise assume Android's module and C++ ABI.
  function patchLibrary(path, source) {
    if (Process.platform !== 'darwin' || Process.arch !== 'arm64') return source
    const name = path.slice(path.lastIndexOf(SEP) + 1)
    if (name === 'libCitra.js') {
      return source.replace("Process.findModuleByName('libcitra-android.so')", 'Process.mainModule')
    }
    if (name === 'libYuzu.js') {
      return source.replace(
        /\[__e\.getExportByName\('([^']*NSt6__ndk1[^']*)'\)\]/g,
        (_, symbol) => `DebugSymbol.findFunctionsNamed('${symbol.replace('NSt6__ndk1', 'NSt3__1')}')`
      )
    }
    return source
  }

  // ---------------------------------------------------------------- the host's answers
  const storage = { localStorage: new Map(), sessionStorage: new Map() }
  function remote(func, args) {
    switch (func) {
      case '__mission':
        return host.mission
      case '__dirname':
        return root
      case 'path_dirname':
        return dirname(args[0])
      case 'fs_readFileSync':
        return readText(resolve(root, String(args[0])))
      case 'fs_realpathSync': {
        const p = resolve(typeof args[1] === 'string' ? args[1] : root, String(args[0]))
        return isFile(p) ? p : null
      }
      case '_statPath': {
        const p = resolve(typeof args[1] === 'string' ? args[1] : root, String(args[0]))
        return isFile(p) ? { path: p, isFile: true, isDir: false } : { path: p, errno: -2 }
      }
      case 'fs_writeFileSync':
        return false
      default:
        out({ cmd: 'log', level: 'warning', text: `Kimochi does not run ${func} for scripts.` })
        return null
    }
  }
  function storageCall(cmd, args) {
    const [area, op] = cmd.split('_')
    const map = storage[area]
    const key = String(args[0])
    switch (op) {
      case 'getItem':
        return map.has(key) ? map.get(key) : args.length > 1 ? args[1] : null
      case 'setItem':
        map.set(key, String(args[1]))
        return undefined
      case 'removeItem':
        map.delete(key)
        return undefined
      case 'clear':
        map.clear()
        return undefined
      case 'key':
        return [...map.keys()][Number(args[0])] ?? null
      case 'length':
        return map.size
      case 'keys':
        return [...map.keys()]
      default:
        return null
    }
  }
  /** `{ reply }` for a request answered here; undefined for one Kimochi reads. */
  function answer(p) {
    const cmd = p.cmd
    if (cmd === 'eval') return { reply: remote(String(p.func), Array.isArray(p.args) ? p.args : []) }
    if (/^(localStorage|sessionStorage)_/.test(cmd))
      return { reply: storageCall(cmd, Array.isArray(p.args) ? p.args : []) }
    if (cmd === 'prompt') return { reply: p.default ?? '' }
    if (cmd === 'getScripts') return { reply: [] }
    // Writing files, script windows, remote calls, switching scripts: not in Kimochi.
    if (['writeBytes', 'loadHtml', 'rpc_send', 'rpc_invoke', 're_attach', 'setTargetID'].includes(cmd)) {
      return { reply: cmd === 'writeBytes' ? false : null }
    }
    return undefined
  }

  // ---------------------------------------------------------------- send / recv
  // Frida's own `send` and `recv` are read-only (and its console uses them): libLoader.js runs in
  // a function whose `send` and `recv` are these instead.
  const replies = new Map()
  const realSend = globalThis.send
  const realRecv = globalThis.recv
  host.send = function (payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.cmd !== 'string') {
      return realSend.apply(globalThis, arguments)
    }
    const answered = answer(payload)
    if (answered) {
      if (payload.key !== undefined) replies.set(String(payload.key), answered.reply)
      return
    }
    if (payload.cmd === 'copy') {
      const text = String(payload.text ?? '')
      // A runaway hook (a whole script file, a memory dump) is no line to read.
      if (!text || text.length > host.maxChars * 4) return
      out({ cmd: 'copy', text: text.length > host.maxChars ? text.slice(0, host.maxChars) : text })
      return
    }
    if (payload.cmd === 'detach') out({ cmd: 'detach' })
  }
  host.recv = function (type, callback) {
    if (typeof type === 'function' || callback === undefined) return realRecv.apply(globalThis, arguments)
    const key = String(type)
    const result = replies.has(key) ? replies.get(key) : null
    replies.delete(key)
    // Answered already: a request is never left waiting on a host that does not reply.
    return { wait: () => callback({ type, result }, null) }
  }

  host.ready = () => out({ cmd: 'ready' })
  // A script that throws while it loads leaves frida-inject running, its error on the buffered
  // standard output: said here instead, so Kimochi can move on to another engine.
  host.failed = (e) => {
    const text = e && e.message ? String(e.message) : String(e)
    out({ cmd: 'error', text: text.slice(0, 500), stack: String((e && e.stack) || '').slice(0, 2000) })
  }
})()
