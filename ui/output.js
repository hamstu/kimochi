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

import { buildFilteredText, visibleAnnotations } from './annotations.js'
import { logicalGroups } from './ocr-result.js'
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
export async function addHistoryEntry(text, { detached = false, groups, engine, merge = false } = {}) {
  const entry = { ...newEntry(text), ...(groups ? { groups, engine } : {}) }
  const native = await optional(
    'history_add',
    { text, detached, groups: groups ?? null, engine: engine ?? null, merge },
    null
  )
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
export async function publishScan(annotations, grouping, options = {}) {
  const text = publishableText(annotations, grouping)
  if (!text.trim()) return ''
  await publishText(text)
  await addHistoryEntry(text, options)
  return text
}

export { MAX_HISTORY_ENTRIES }

/** Publish a capture once while preserving independently readable OCR units. */
export async function publishOcrResult(result, options = {}) {
  let groups = result.groups ?? []
  if (result.geometry && !result.textAnnotations.some(a => a.granularity === 'block')) {
    groups = logicalGroups(visibleAnnotations(result.textAnnotations, options.grouping ?? {})).groups
    if (!groups.length) return ''
  }
  const text = groups.map(group => group.text).join('\n') || result.fullText || ''
  if (!text.trim()) return ''
  // History first: with `merge`, a reading already in the history (the same sentence again,
  // or a piece of one) is skipped there, and then is not sent to the clipboard either. A fuller
  // reading replaces the fragments it contains; see history_merge.rs.
  const entry = await addHistoryEntry(text, {
    detached: options.detached,
    groups,
    engine: result.engine,
    merge: !!options.merge
  })
  if (entry?.skipped) return ''
  await publishText(text)
  return text
}
