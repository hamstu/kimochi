/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */

const CHUNK_BYTES = 1024 * 1024
const TARGET = 'hachidori-upload-store'

export function isLocalZipImport(message) {
  return message?.type === 'hd_import' && typeof message.blobUrl === 'string'
    && message.blobUrl.startsWith('blob:') && /\.zip$/i.test(message.fileName ?? '')
    && !message.resources?.length
}

/** Read a partitioned blob in its creating page; rebuild it in Hachidori's offscreen store. */
export async function importLocalZip(win, message, send, report) {
  const token = `local-archive-${crypto.randomUUID()}`
  const started = Date.now()
  let bytes = 0, chunks = 0
  const request = (type, fields = {}) => send({ target: TARGET, relayed: true, type, token,
    requestId: message.requestId ?? null, ...fields })
  try {
    const response = await win.fetch(message.blobUrl)
    if (!response.ok) throw new Error(`Reading the local archive failed: ${response.status}`)
    const blob = await response.blob()
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const part = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
      const strings = []
      for (let at = 0; at < part.length; at += 32768) strings.push(String.fromCharCode(...part.subarray(at, at + 32768)))
      const reply = await request('hd_upload_append', { data: win.btoa(strings.join('')), byteLength: part.length })
      if (!reply?.ok) throw new Error(reply?.error || 'The engine refused the local archive chunk.')
      bytes += part.length
      chunks++
    }
    const reply = await request('hd_upload_import', { fileName: message.fileName, importDecision: message.importDecision })
    report({ check: 'ext-host-local-archive', bytes, chunks, ms: Date.now() - started, ok: reply?.ok === true })
    return reply
  } catch (error) {
    report({ check: 'ext-host-local-archive-failed', error: String(error?.message ?? error), bytes, chunks })
    throw error
  } finally {
    await request('hd_upload_discard').catch(() => {})
  }
}
