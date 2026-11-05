// The connection to the Kimochi app: a WebSocket to its browser bridge on 127.0.0.1.
//
// Kimochi accepts only this extension's origin (chrome-extension://<id>), so a web page can't
// talk to it. The connection is opened while at least one tab uses Kimochi, and closed a little
// after the last one stops. Messages are JSON; see "Browser bridge" in COMMANDS.md for the protocol.

/** The release app's port first, then a development build's. */
const PORTS = [27640, 27641]
const PROTOCOL = 1
const SCAN_TIMEOUT_MS = 60_000
const KEEPALIVE_MS = 20_000
const IDLE_CLOSE_MS = 30_000

export class Bridge {
  constructor({ onStatus, onSettings, onEnded, onRescan, onSessions, onReply, onEngines }) {
    this.onEngines = onEngines
    /** Kimochi's OCR engines and the selected one. */
    this.engines = null
    this.onSessions = onSessions
    this.onReply = onReply
    /** Kimochi's sessions: `{sessions: [{id, name}], active}`. */
    this.sessions = null
    this.onRescan = onRescan
    this.onStatus = onStatus
    this.onSettings = onSettings
    this.onEnded = onEnded
    /** 'idle' | 'connecting' | 'connected' | 'offline' */
    this.status = 'idle'
    this.settings = null
    this.css = null
    this.app = null
    this.socket = null
    this.users = 0
    this.pending = new Map()
    this.nextId = 1
    this.retryTimer = null
    this.retryDelay = 1000
    this.keepalive = null
    this.idleTimer = null
  }

  retain() {
    this.users += 1
    clearTimeout(this.idleTimer)
    if (!this.socket) this.connectNow()
  }

  release() {
    this.users = Math.max(0, this.users - 1)
    if (this.users > 0) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS)
  }

  setStatus(status) {
    if (this.status === status) return
    this.status = status
    this.onStatus(status)
  }

  connectNow() {
    clearTimeout(this.retryTimer)
    this.retryDelay = 1000
    if (this.socket) return
    this.connect(0)
  }

  connect(index) {
    if (this.users === 0) return
    this.setStatus('connecting')
    const port = PORTS[index]
    let opened = false
    const socket = new WebSocket(`ws://127.0.0.1:${port}/kimochi-browser`)
    this.socket = socket
    socket.onopen = () => {
      opened = true
      socket.send(JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL,
        version: chrome.runtime.getManifest().version,
        browser: navigator.userAgent,
      }))
    }
    socket.onmessage = (event) => this.receive(event.data)
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      clearInterval(this.keepalive)
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error('Kimochi closed the connection'))
      }
      this.pending.clear()
      if (!opened && index + 1 < PORTS.length) {
        this.connect(index + 1)
        return
      }
      this.app = null
      this.setStatus(this.users > 0 ? 'offline' : 'idle')
      this.scheduleRetry()
    }
  }

  scheduleRetry() {
    if (this.users === 0) return
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => this.connect(0), this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, 10_000)
  }

  close() {
    clearTimeout(this.retryTimer)
    clearInterval(this.keepalive)
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.setStatus('idle')
  }

  receive(text) {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    switch (message.type) {
      case 'welcome':
        this.app = message.app
        this.retryDelay = 1000
        clearInterval(this.keepalive)
        // Traffic keeps the service worker (and so this socket) alive between scans.
        this.keepalive = setInterval(() => this.send({ type: 'ping' }), KEEPALIVE_MS)
        // Kimochi's overlay stylesheet: the page draws its boxes with it.
        this.css = message.css ?? null
        if (message.engines?.engines) {
          this.engines = message.engines
          this.onEngines(message.engines)
        }
        if (message.sessions) {
          this.sessions = message.sessions
          this.onSessions(message.sessions)
        }
        this.setStatus('connected')
        if (message.settings) {
          this.settings = message.settings
          this.onSettings(message.settings)
        }
        break
      case 'settings':
        this.settings = message.settings
        this.onSettings(message.settings)
        break
      case 'ended':
        this.onEnded()
        break
      case 'rescan':
        this.onRescan()
        break
      case 'engines':
        this.engines = message.engines
        this.onEngines(message.engines)
        break
      case 'sessions':
        this.sessions = message.sessions
        this.onSessions(message.sessions)
        break
      // Answers to one tab's request; every tab hears them and keeps its own (by id).
      case 'page':
      case 'sessionCreated':
        this.onReply(message)
        break
      case 'result':
      case 'error': {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.type === 'result') pending.resolve(message)
        else pending.reject(new Error(message.message || 'Kimochi could not read that'))
        break
      }
    }
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  scan(payload) {
    if (this.status !== 'connected') {
      return Promise.reject(new Error('Kimochi isn’t running'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Kimochi took too long to read that'))
      }, SCAN_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ type: 'scan', id, ...payload })
    })
  }
}
