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
import { logGroups } from './ocr-result.js'
import { pushHistory, MAX_HISTORY_ENTRIES } from './settings.js'
import { optional, getSetting, setSetting, publishText } from './native.js'

/** The exact text Electron would have published for this OCR result. */
export function publishableText(annotations, grouping) {
  return buildFilteredText(
    annotations ?? [],
    grouping.filterSmallText ?? true,
    grouping.filterSmallTextThreshold ?? 0.75,
    grouping.language
  )
}

function newEntry(text) {
  const id =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
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
export async function addHistoryEntry(text, options = {}) {
  const { groups, engine, frame, session } = options
  const entry = {
    ...newEntry(text),
    ...(groups ? { groups, engine } : {}),
    ...(frame ? { frame } : {}),
    ...(session ? { session } : {})
  }
  const native = await optional('history_add', nativeItem({ text, ...options }), null)
  if (native) return native
  await setSetting('scannedTextHistory', pushHistory(getSetting('scannedTextHistory'), entry))
  return entry
}

/** `history_add`'s arguments for a reading: every field present, null when not given. */
function nativeItem({ text, detached, groups, engine, merge, frame, session }) {
  return {
    text,
    detached: !!detached,
    groups: groups ?? null,
    engine: engine ?? null,
    merge: !!merge,
    frame: frame ?? null,
    session: session ?? null
  }
}

/**
 * Several readings for the history, in order, as `{text, ...addHistoryEntry's options}`: one
 * native write and one Log update (`history_add_many`), so a refresh of Auto OCR lands in the
 * Log together rather than a line at a time. Without native (the browser preview), one by one.
 */
export async function addHistoryEntries(items) {
  const entries = []
  // At most what the history keeps per write: a longer batch would push out its own first lines.
  for (let at = 0; at < items.length; at += MAX_HISTORY_ENTRIES) {
    const batch = items.slice(at, at + MAX_HISTORY_ENTRIES)
    const native = await optional('history_add_many', { entries: batch.map(nativeItem) }, null)
    if (native) entries.push(...native)
    else for (const { text, ...options } of batch) entries.push(await addHistoryEntry(text, options))
  }
  return entries
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

/**
 * Publish a capture once while preserving independently readable OCR units.
 *
 * `options.onPublication` hears how it went, `{lines, duplicate}`, for the activity feed: the
 * returned string is empty both for a reading with nothing in it and for one the history
 * already had, and to the reader those are different outcomes.
 */
export async function publishOcrResult(result, options = {}) {
  return (await publishOcrResults([result], options))[0]
}

/**
 * `publishOcrResult` for several captures at once, in order (Auto OCR's passages from one
 * refresh): their history entries are written together (`addHistoryEntries`), so they reach the
 * Log at once. Returns each one's published string, as `publishOcrResult` does.
 */
export async function publishOcrResults(results, options = {}) {
  const report = (lines, duplicate = false) => options.onPublication?.({ lines, duplicate })
  const readings = results.map((result) => {
    // The groups the Log will show, one line each (shared with Read along's full screen).
    const groups = logGroups(result, options.grouping ?? {})
    if (result.geometry && !result.textAnnotations.some((a) => a.granularity === 'block') && !groups.length) return null
    const text = groups.map((group) => group.text).join('\n') || result.fullText || ''
    return text.trim() ? { result, groups, text } : null
  })
  const written = readings.filter((reading) => reading !== null)
  // History first: with `merge`, a reading already in the history (the same sentence again,
  // or a piece of one) is skipped there, and then is not sent to the clipboard either. A fuller
  // reading replaces the fragments it contains; see history_merge.rs.
  const entries = await addHistoryEntries(
    written.map(({ result, groups, text }) => ({
      text,
      detached: options.detached,
      groups,
      engine: result.engine,
      merge: options.merge,
      // The capture frame it was read from: a mining screenshot from this line shows it.
      frame: options.frame,
      // The Log session it goes to (the browser extension's tabs choose theirs).
      session: options.session
    }))
  )
  const published = []
  let answered = 0
  for (const reading of readings) {
    // The answers are for the readings written, in order.
    const entry = reading ? entries[answered++] : null
    // Nothing to log, or nothing native would take (`invalid`, said on its answer).
    if (!reading || entry?.invalid) {
      report(0)
      published.push('')
      continue
    }
    if (entry?.skipped) {
      report(0, true)
      published.push('')
      continue
    }
    await publishText(reading.text)
    // The Log gives each non-empty group a line of its own, and an ungrouped reading one line.
    report(reading.groups.filter((group) => group.text?.trim()).length || 1)
    published.push(reading.text)
  }
  return published
}
