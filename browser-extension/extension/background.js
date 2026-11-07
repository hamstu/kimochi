// Kimochi browser extension: the service worker.
//
// It owns the one WebSocket to the Kimochi app (bridge.js) and everything that needs extension
// privileges: injecting the page script, taking the tab's screenshot, and fetching an image's
// own bytes from any site. The page script (content.js) owns the page: picking, the boxes, the
// toolbar, and noticing when the picked element changes.
//
// Per tab: the page script holds a long-lived port named "kimochi". Over it the page asks for
// scans ({type: "scan"}) and the worker answers with Kimochi's results; app-wide news (connected,
// settings, Kimochi left browser mode) goes to every open port.

import { Bridge } from './bridge.js'

const MAX_SIDE = 4096
/** No more than this many pixels go to Kimochi, however the picture is shaped (a long strip). */
const MAX_PIXELS = 12_000_000

/** tabId -> { port, busy, queued, lastHash } */
const tabs = new Map()

const bridge = new Bridge({
  onStatus: (status) => broadcast({ type: 'status', status }),
  onSettings: (settings) => broadcast({ type: 'settings', settings, css: bridge.css }),
  onEnded: () => broadcast({ type: 'ended' }),
  onSessions: (sessions) => broadcast({ type: 'sessions', sessions }),
  onEngines: (engines) => broadcast({ type: 'engines', engines }),
  onReply: (message) => broadcast(message),
  // Kimochi's Read again (its button or scan shortcut): the tab that was read last.
  onRescan: () => {
    const tab = tabs.get(lastTab) ?? [...tabs.values()].at(-1)
    tab?.port.postMessage({ type: 'rescan' })
  },
})

/** The tab whose picture Kimochi read last. */
let lastTab = null

function broadcast(message) {
  for (const tab of tabs.values()) {
    try {
      tab.port.postMessage(message)
    } catch {
      // A port whose page went away; onDisconnect removes it.
    }
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
    await chrome.tabs.sendMessage(tab.id, { type: 'activate' })
  } catch (error) {
    // chrome:// pages, the Web Store and PDFs refuse scripts.
    console.warn('Kimochi: cannot run on this page', error)
    await chrome.action.setBadgeText({ tabId: tab.id, text: '✕' })
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#888' })
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 2000)
  }
})

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'kimochi' || !port.sender?.tab?.id) return
  const tabId = port.sender.tab.id
  const windowId = port.sender.tab.windowId
  const tab = { port, windowId, busy: false, queued: null, lastHash: null }
  tabs.set(tabId, tab)
  bridge.retain()
  port.postMessage({ type: 'status', status: bridge.status })
  if (bridge.settings) port.postMessage({ type: 'settings', settings: bridge.settings, css: bridge.css })
  if (bridge.sessions) port.postMessage({ type: 'sessions', sessions: bridge.sessions })
  if (bridge.engines) port.postMessage({ type: 'engines', engines: bridge.engines })
  updateBadge(tabId, true)

  port.onMessage.addListener((message) => {
    if (message.type === 'scan') {
      lastTab = tabId
      requestScan(tabId, message)
    }
    else if (message.type === 'connect') bridge.connectNow()
    else if (message.type === 'stop') {
      tab.lastHash = null
      bridge.send({ type: 'stop' })
    } else if (message.type === 'forget') tab.lastHash = null
    // Session requests and Open Kimochi go straight to Kimochi.
    else if (['page', 'assign', 'createSession', 'renameSession', 'show', 'setEngine'].includes(message.type)) bridge.send(message)
    else if (message.type === 'remember-target') rememberTarget(tabId, message.signature)
    else if (message.type === 'forget-target') rememberTarget(tabId, null)
  })
  port.onDisconnect.addListener(() => {
    if (tabs.get(tabId)?.port === port) tabs.delete(tabId)
    bridge.release()
    updateBadge(tabId, false)
  })
})

function updateBadge(tabId, on) {
  chrome.action.setBadgeText({ tabId, text: on ? 'on' : '' }).catch(() => {})
  if (on) chrome.action.setBadgeBackgroundColor({ tabId, color: '#d6455d' }).catch(() => {})
}

/** One scan in flight per tab; a request arriving meanwhile replaces any queued one. */
function requestScan(tabId, request) {
  const tab = tabs.get(tabId)
  if (!tab) return
  if (tab.busy) {
    tab.queued = request
    return
  }
  tab.busy = true
  runScan(tab, request)
    .catch((error) => {
      tab.port.postMessage({ type: 'error', id: request.id, message: String(error?.message ?? error) })
    })
    .finally(() => {
      tab.busy = false
      const next = tab.queued
      tab.queued = null
      if (next && tabs.get(tabId) === tab) requestScan(tabId, next)
    })
}

async function runScan(tab, request) {
  const started = performance.now()
  let bitmap
  try {
    bitmap = await grab(tab, request)
  } finally {
    // The page hid its boxes for the screenshot; it can show them again.
    tab.port.postMessage({ type: 'captured', id: request.id })
  }
  const hash = fingerprint(bitmap)
  // Auto updates only reach Kimochi when the pixels changed.
  if (request.reason === 'auto' && !request.fresh && hash === tab.lastHash) {
    bitmap.close()
    tab.port.postMessage({ type: 'unchanged', id: request.id })
    return
  }
  const { base64, width, height } = await encode(bitmap)
  tab.port.postMessage({ type: 'reading', id: request.id })
  const result = await bridge.scan({
    reason: request.reason,
    page: request.page,
    width,
    height,
    png: base64,
  })
  tab.lastHash = hash
  tab.port.postMessage({
    type: 'result',
    id: request.id,
    region: request.region,
    result,
    ms: Math.round(performance.now() - started),
  })
}

/**
 * The picture to read, as an ImageBitmap.
 *
 * An <img> is read from its own bytes at full resolution, so all of it is read even when part is
 * scrolled away (the worker's fetch may cross origins). Anything else, or an image whose bytes
 * can't be had, is cut from a screenshot of the tab: `request.rect` is the visible part in CSS
 * pixels, `request.viewport` the page's viewport size.
 */
async function grab(tab, request) {
  if (request.src) {
    try {
      const response = await fetch(request.src, { credentials: 'include' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await createImageBitmap(await response.blob())
    } catch (error) {
      // The page reads it off a screenshot instead (content.js).
      console.debug('Kimochi: could not fetch the picture', request.src.slice(0, 120), error)
      throw new Error('fetch-failed')
    }
  }
  if (!request.rect) throw new Error('Nothing to read')
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  const shot = await createImageBitmap(await (await fetch(dataUrl)).blob())
  const scale = shot.width / request.viewport.width
  const { x, y, width, height } = request.rect
  const sx = Math.max(0, Math.round(x * scale))
  const sy = Math.max(0, Math.round(y * scale))
  const sw = Math.min(shot.width - sx, Math.round(width * scale))
  const sh = Math.min(shot.height - sy, Math.round(height * scale))
  if (sw < 4 || sh < 4) {
    shot.close()
    throw new Error('That part of the page is off screen')
  }
  const cropped = await createImageBitmap(shot, sx, sy, sw, sh)
  shot.close()
  return cropped
}

/** A coarse 16x16 luminance signature, to tell whether a re-read would see anything new. */
function fingerprint(bitmap) {
  const canvas = new OffscreenCanvas(16, 16)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(bitmap, 0, 0, 16, 16)
  const { data } = context.getImageData(0, 0, 16, 16)
  let signature = `${bitmap.width}x${bitmap.height}:`
  for (let i = 0; i < data.length; i += 4) {
    const luma = (data[i] * 3 + data[i + 1] * 6 + data[i + 2]) / 10
    signature += String.fromCharCode(65 + Math.round(luma / 16))
  }
  return signature
}

async function encode(bitmap) {
  const longest = Math.max(bitmap.width, bitmap.height)
  const scale = Math.min(1, MAX_SIDE / longest, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  // Transparent images (PNG speech bubbles) read better on white than on black.
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return { base64: btoa(binary), width, height }
}

// ------------------------------------------------------------------ the next page

/**
 * The picture each reading tab picked, as where it sits in its page (content.js `signatureOf`):
 * after a full page load on the same site with Auto on, the page script comes back by itself and
 * looks for the picture in the same place (a gallery's next image, a reader's next page). Kept in
 * session storage, which outlives this worker but not the browser.
 */
const targetKey = (tabId) => `target:${tabId}`

function rememberTarget(tabId, signature) {
  const key = targetKey(tabId)
  const write = signature ? chrome.storage.session.set({ [key]: signature }) : chrome.storage.session.remove(key)
  write.catch(() => {})
}

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.status !== 'complete' || tabs.has(tabId) || !tab.url) return
  const key = targetKey(tabId)
  const signature = (await chrome.storage.session.get(key).catch(() => ({})))[key]
  if (!signature?.auto) return
  let origin
  try {
    origin = new URL(tab.url).origin
  } catch {
    return
  }
  // Another site: this tab has moved on.
  if (origin !== signature.origin) {
    rememberTarget(tabId, null)
    return
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    await chrome.tabs.sendMessage(tabId, { type: 'resume', signature })
  } catch (error) {
    console.debug('Kimochi: could not come back to this page', error)
  }
})

chrome.tabs.onRemoved.addListener((tabId) => rememberTarget(tabId, null))
