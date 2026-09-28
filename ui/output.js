/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Where recognised text goes once it has been read.
 *
 * Electron publishes the same string to three places after every scan — manual,
 * select-and-scan and auto alike (OverlayApp.performScan and friends): the
 * persisted scan history, the texthooker (clipboard and/or WebSocket), and from
 * there to TTS. Crucially that string is `buildFilteredText(...)`, not the
 * endpoint's `fullText`, so what is copied, spoken and logged is what the
 * overlay actually shows after furigana filtering.
 */

import { buildFilteredText } from './annotations.js'
import { pushHistory, MAX_HISTORY_ENTRIES } from './settings.js'
import { optional, getSetting, setSetting, publishText } from './native.js'

/** The exact text Electron would have published for this OCR result. */
export function publishableText(annotations, grouping) {
  return buildFilteredText(
    annotations ?? [],
    grouping.filterSmallText ?? true,
    grouping.filterSmallTextThreshold ?? 0.75
  )
}

function newEntry(text) {
  const id =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return { id, text, timestamp: Date.now() }
}

/**
 * Append to the scan history.
 *
 * Prefers a native command, which applies the cap atomically. Without one this
 * falls back to read-modify-write on the settings key, which carries the same
 * add/delete race Electron already has when the log panel edits history while a
 * scan lands.
 */
export async function addHistoryEntry(text) {
  const entry = newEntry(text)
  const native = await optional('history_add', { text }, null)
  if (native) return native
  await setSetting('scannedTextHistory', pushHistory(getSetting('scannedTextHistory'), entry))
  return entry
}

export function listHistory() {
  return getSetting('scannedTextHistory')
}

export async function deleteHistoryEntry(id) {
  const native = await optional('history_delete', { id }, null)
  if (native) return
  await setSetting(
    'scannedTextHistory',
    listHistory().filter((entry) => entry.id !== id)
  )
}

export async function clearHistory() {
  const native = await optional('history_clear', undefined, null)
  if (native) return
  await setSetting('scannedTextHistory', [])
}

/**
 * Publish one scan's text everywhere it should go.
 *
 * Returns the published string so the caller can hand it straight to TTS, and
 * an empty string when the capture produced nothing worth recording — an empty
 * scan must not push a blank entry onto the history or wipe the clipboard.
 */
export async function publishScan(annotations, grouping) {
  const text = publishableText(annotations, grouping)
  if (!text.trim()) return ''
  await publishText(text)
  await addHistoryEntry(text)
  return text
}

export { MAX_HISTORY_ENTRIES }
