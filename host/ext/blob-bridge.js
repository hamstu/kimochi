/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * `blob:` URLs between Hachidori's settings page and its offscreen document.
 *
 * In Chrome every page of an extension is one origin in one browser, so the settings page can
 * hand its offscreen engine a `blob:` URL of a chosen file, and the engine can hand a backup
 * archive back the same way. In Kimochi the settings page is a frame of the `dictionary` window
 * and the offscreen document lives in the hidden `ext-hachidori` window; the WebView partitions
 * blob URLs by top-level site, so neither can read the other's. local-archive.js already carries a
 * plain `.zip` import over Hachidori's own upload store; this bridge does the rest, without
 * changing a message Hachidori sees:
 *
 * - `hd_import` of anything else (an `.mdx`, with or without its `.mdd` resources) and
 *   `hd_backup_prepare` (Backup → Restore): each local `blob:` URL is read in the page, sent to
 *   the offscreen document in chunks, rebuilt there as a Blob, and the message goes on with that
 *   document's URL in its place. The copies are released once the engine has answered.
 * - `hd_backup_export` (Download backup): the archive's URL in the answer is the offscreen
 *   document's; the page reads it through the bridge and gets a URL of its own, which
 *   `hd_backup_release` is mapped back from so the engine still frees its copy.
 *
 * The offscreen side is a listener for the host's own target, `kimochi-blob-bridge`, beside
 * Hachidori's (each of which ignores targets it does not know); it answers extension pages only.
 */

export const BLOB_BRIDGE_TARGET = 'kimochi-blob-bridge'
const CHUNK_BYTES = 1024 * 1024

function encode(win, bytes) {
  const strings = []
  for (let at = 0; at < bytes.length; at += 32768) strings.push(String.fromCharCode(...bytes.subarray(at, at + 32768)))
  return win.btoa(strings.join(''))
}

function decode(win, text) {
  const binary = win.atob(String(text ?? ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The offscreen document's side: holds uploaded chunks and serves its own blobs in chunks. */
export function installBlobBridge(win, events) {
  const uploads = new Map()
  const reads = new Map()
  const answer = async (message) => {
    const token = String(message.token ?? '')
    switch (message.type) {
      case 'append': {
        const bytes = decode(win, message.data)
        if (bytes.byteLength !== message.byteLength) throw Error('A chunk did not decode to its length')
        if (!uploads.has(token)) uploads.set(token, { parts: [], url: null })
        uploads.get(token).parts.push(bytes)
        return {}
      }
      case 'commit': {
        const upload = uploads.get(token) ?? { parts: [], url: null }
        upload.url ??= win.URL.createObjectURL(new win.Blob(upload.parts, { type: String(message.mime ?? '') }))
        upload.parts = []
        uploads.set(token, upload)
        return { blobUrl: upload.url }
      }
      case 'release': {
        const upload = uploads.get(token)
        if (upload?.url) win.URL.revokeObjectURL(upload.url)
        uploads.delete(token)
        return {}
      }
      case 'read': {
        const url = String(message.blobUrl ?? '')
        if (!url.startsWith('blob:')) throw Error('Only blob: URLs are read through the bridge')
        let blob = reads.get(url)
        if (!blob) {
          const response = await win.fetch(url)
          if (!response.ok) throw Error(`Reading ${url} failed: ${response.status}`)
          blob = await response.blob()
          reads.set(url, blob)
        }
        const offset = Math.max(0, Number(message.offset) || 0)
        const end = Math.min(blob.size, offset + CHUNK_BYTES)
        const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer())
        const eof = end >= blob.size
        if (eof) reads.delete(url)
        return { data: encode(win, bytes), byteLength: bytes.byteLength, size: blob.size, type: blob.type, eof }
      }
      default:
        throw Error(`Unknown blob bridge request ${JSON.stringify(message.type)}`)
    }
  }
  events.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== BLOB_BRIDGE_TARGET) return false
    if (sender?.tab !== undefined) {
      sendResponse({ ok: false, error: 'The blob bridge answers extension pages only' })
      return false
    }
    answer(message).then(
      (value) => sendResponse({ ok: true, ...value }),
      (error) => sendResponse({ ok: false, error: String(error?.message ?? error) })
    )
    return true
  })
}

/** Whether a page's message carries local blob: URLs (or a backup) that need the bridge. */
export function needsBlobBridge(message) {
  if (message?.type === 'hd_import') {
    return isBlob(message.blobUrl) || (Array.isArray(message.resources) && message.resources.some((r) => isBlob(r?.blobUrl)))
  }
  return ['hd_backup_prepare', 'hd_backup_export', 'hd_backup_release'].includes(message?.type)
}

const isBlob = (value) => typeof value === 'string' && value.startsWith('blob:')

/**
 * The page's side. `send(message)` is the page's `runtime.sendMessage`; `exported` maps the page's
 * own URLs of downloaded backups to the offscreen document's (kept per page).
 */
export function createBlobBridgeClient(win, { send, report }) {
  const exported = new Map()
  const bridge = async (fields) => {
    const reply = await send({ target: BLOB_BRIDGE_TARGET, ...fields })
    if (!reply?.ok) throw Error(reply?.error || 'Kimochi could not hand the file to Hachidori')
    return reply
  }

  async function upload(url) {
    const response = await win.fetch(url)
    if (!response.ok) throw Error(`Reading the chosen file failed: ${response.status}`)
    const blob = await response.blob()
    const token = `kimochi-blob-${win.crypto.randomUUID()}`
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const part = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
      await bridge({ type: 'append', token, data: encode(win, part), byteLength: part.length })
    }
    const { blobUrl } = await bridge({ type: 'commit', token, mime: blob.type })
    return { token, blobUrl, bytes: blob.size }
  }

  async function download(url) {
    const parts = []
    let type = ''
    for (let offset = 0; ; ) {
      const reply = await bridge({ type: 'read', blobUrl: url, offset })
      parts.push(decode(win, reply.data))
      type = reply.type ?? type
      offset += reply.byteLength
      if (reply.eof || reply.byteLength === 0) break
    }
    return new win.Blob(parts, { type })
  }

  return async function sendWithBlobs(message) {
    if (message.type === 'hd_backup_export') {
      const reply = await send(message)
      if (!reply?.ok || !isBlob(reply.blobUrl)) return reply
      const blob = await download(reply.blobUrl)
      const local = win.URL.createObjectURL(blob)
      exported.set(local, reply.blobUrl)
      report({ check: 'ext-host-blob-bridge', direction: 'export', bytes: blob.size })
      return { ...reply, blobUrl: local }
    }
    if (message.type === 'hd_backup_release') {
      const remote = exported.get(message.blobUrl)
      if (!remote) return send(message)
      exported.delete(message.blobUrl)
      win.URL.revokeObjectURL(message.blobUrl)
      return send({ ...message, blobUrl: remote })
    }
    const uploaded = []
    try {
      const copy = { ...message }
      if (isBlob(copy.blobUrl)) {
        const sent = await upload(copy.blobUrl)
        uploaded.push(sent)
        copy.blobUrl = sent.blobUrl
      }
      if (Array.isArray(copy.resources)) {
        copy.resources = await Promise.all(copy.resources.map(async (resource) => {
          if (!isBlob(resource?.blobUrl)) return resource
          const sent = await upload(resource.blobUrl)
          uploaded.push(sent)
          return { ...resource, blobUrl: sent.blobUrl }
        }))
      }
      if (uploaded.length) report({ check: 'ext-host-blob-bridge', direction: 'import', type: message.type, files: uploaded.length, bytes: uploaded.reduce((sum, u) => sum + u.bytes, 0) })
      return await send(copy)
    } catch (error) {
      report({ check: 'ext-host-blob-bridge-failed', type: message.type, error: String(error?.message ?? error) })
      throw error
    } finally {
      for (const { token } of uploaded) void bridge({ type: 'release', token }).catch(() => {})
    }
  }
}
