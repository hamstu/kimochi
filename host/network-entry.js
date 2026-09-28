/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
import { observeFrame } from './observe.js'
import { fetch as rustFetch } from '@tauri-apps/plugin-http'
const hub = window.__extensionHost
hub.nativeFetch = window.__spikeNativeFetch ?? window.fetch.bind(window)
hub.fetchRemote = (input, init) => rustFetch(input, init ? { ...init } : undefined)
// Installed in every extension frame before its original scripts execute.
hub.installNetwork = (win) => {
  if (win.__spikeNetworkInstalled) return
  win.__spikeNetworkInstalled = true
  observeFrame(win, hub)
  const nativeFetch = win.__spikeNativeFetch ?? win.fetch.bind(win)
  const NativeXHR = win.XMLHttpRequest
  const remote = (url) =>
    /^https?:$/.test(new URL(url, win.location.href).protocol) &&
    new URL(url, win.location.href).origin !== win.location.origin
  win.fetch = (input, init) => {
    const url = typeof input === 'string' || input instanceof win.URL ? String(input) : input.url
    return remote(url) ? hub.fetchRemote(input, init) : nativeFetch(input, init)
  }
  // Only the remote asynchronous XHR surface used by Yomitan's URL importer.
  win.XMLHttpRequest = class extends win.EventTarget {
    constructor() {
      super()
      this.readyState = 0
      this.status = 0
      this.statusText = ''
      this.response = null
      this.responseType = ''
      this.responseText = ''
      this.timeout = 0
      this.withCredentials = false
      this.headers = {}
      this.upload = new win.EventTarget()
    }
    emit(type, event = new win.Event(type)) {
      this.dispatchEvent(event)
      this['on' + type]?.(event)
    }
    open(method, url, async = true) {
      this.url = new URL(url, win.location.href).href
      this.method = method
      if (!remote(this.url)) {
        this.native = new NativeXHR()
        this.native.open(method, url, async)
        for (const name of [
          'load',
          'error',
          'progress',
          'abort',
          'timeout',
          'loadend',
          'readystatechange'
        ])
          this.native.addEventListener(name, (e) => {
            for (const key of ['readyState', 'status', 'statusText', 'response', 'responseURL'])
              this[key] = this.native[key]
            if (!this.responseType || this.responseType === 'text')
              this.responseText = this.native.responseText
            this.emit(
              name,
              name === 'progress'
                ? new win.ProgressEvent(name, {
                    loaded: e.loaded,
                    total: e.total,
                    lengthComputable: e.lengthComputable
                  })
                : new win.Event(name)
            )
          })
      } else if (!async) throw Error('Synchronous remote XHR is unsupported')
      this.readyState = 1
      this.emit('readystatechange')
    }
    setRequestHeader(name, value) {
      if (this.native) this.native.setRequestHeader(name, value)
      else this.headers[name] = value
    }
    getResponseHeader(name) {
      return this.native
        ? this.native.getResponseHeader(name)
        : (this.responseHeaders?.get(name) ?? null)
    }
    getAllResponseHeaders() {
      return this.native
        ? this.native.getAllResponseHeaders()
        : [...(this.responseHeaders ?? [])].map(([k, v]) => `${k}: ${v}\r\n`).join('')
    }
    abort() {
      this.aborted = true
      if (this.native) this.native.abort()
      else this.controller?.abort()
    }
    send(body) {
      if (this.native) {
        this.native.responseType = this.responseType
        this.native.timeout = this.timeout
        this.native.send(body)
        return
      }
      this.controller = new AbortController()
      const started = performance.now()
      let timer
      if (this.timeout)
        timer = setTimeout(() => {
          this.timedOut = true
          this.controller.abort()
        }, this.timeout)
      hub.log({ check: 'download-start', url: this.url })
      void (async () => {
        try {
          const res = await hub.fetchRemote(this.url, {
            method: this.method,
            headers: this.headers,
            body,
            signal: this.controller.signal
          })
          this.status = res.status
          this.statusText = res.statusText
          this.responseURL = res.url
          this.responseHeaders = res.headers
          this.readyState = 2
          this.emit('readystatechange')
          const total = Number(res.headers.get('content-length')) || 0
          let loaded = 0
          const reader = res.body?.getReader()
          const chunks = []
          if (reader)
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              chunks.push(value)
              loaded += value.byteLength
              this.readyState = 3
              this.emit(
                'progress',
                new win.ProgressEvent('progress', { loaded, total, lengthComputable: total > 0 })
              )
            }
          // Blob is constructed in the requesting frame: Yomitan uses instanceof Blob.
          const blob = new win.Blob(chunks, { type: res.headers.get('content-type') ?? '' })
          chunks.length = 0
          this.response =
            this.responseType === 'blob'
              ? blob
              : this.responseType === 'arraybuffer'
                ? await blob.arrayBuffer()
                : await blob.text()
          if (!this.responseType || this.responseType === 'text') this.responseText = this.response
          if (this.responseType === 'json') this.response = JSON.parse(this.response)
          this.readyState = 4
          this.emit('readystatechange')
          hub.log({
            check: 'download-complete',
            status: this.status,
            bytes: loaded,
            ms: performance.now() - started,
            url: this.url
          })
          this.emit('load')
        } catch (error) {
          this.status = 0
          this.readyState = 4
          this.emit('readystatechange')
          hub.log({ check: 'download-error', message: String(error) })
          this.emit(this.timedOut ? 'timeout' : this.aborted ? 'abort' : 'error')
        } finally {
          clearTimeout(timer)
          this.emit('loadend')
        }
      })()
    }
  }
  for (const [key, value] of Object.entries({
    UNSENT: 0,
    OPENED: 1,
    HEADERS_RECEIVED: 2,
    LOADING: 3,
    DONE: 4
  })) {
    win.XMLHttpRequest[key] = value
    win.XMLHttpRequest.prototype[key] = value
  }
}
hub.installNetwork(window)
