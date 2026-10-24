/**
 * The Yomitan API pop-up (Kimochi's own) over the overlay's text: Shift-scan and click, through
 * the scanner the Log uses (`scan-text.ts`).
 *
 * The overlay is click-through and never the key window, so it sees neither the pointer nor
 * Shift for itself. Native reads both and the overlay replays them as `pointermove` events on
 * `window` (the `pointer` listener in overlay.js), the feed every dictionary engine scans from;
 * real events arrive too while the pointer is over a word. Both are read here.
 */
import { createScanner } from './scan-text.js'

/** Opens the Yomitan API pop-up for a term at a desktop point, once installed. */
let showTerm = null
/** Hides it and forgets the scan, once installed. */
let hideTerm = null
/** The Yomitan API's `/tokenize`, once installed. */
let tokenizeText = null

/**
 * The Yomitan API's parse of `text` (`parseText` results, as Yomitan's own parser gives them), so
 * the controller's word cursor stops on the words the API's dictionaries match.
 */
export async function apiTokenize(text) {
  if (!tokenizeText) throw Error('The Yomitan API pop-up is not ready')
  return tokenizeText(text)
}

/** The controller's word cursor: look `term` up as if it had been clicked at (x, y). */
export async function lookupTerm(term, x, y, sentence) {
  if (!showTerm) throw Error('The Yomitan API pop-up is not ready')
  await showTerm({ term, cursorX: x, cursorY: y, anchor: null, sentence, focus: false })
}

/** Closes the Yomitan API pop-up, when it is the engine in use (the overlay's words changed). */
export function dismissApiLookup() {
  hideTerm?.()
}

const WORD_BOX = '[data-ocr-word-box]'

/** AnkiConnect's address when the setting has none (ankiconnect.rs `DEFAULT_URL`). */
const DEFAULT_ANKI_CONNECT_URL = 'http://127.0.0.1:8765'

/**
 * The pop-up's Add to Anki settings from the reader settings, or null (no Add to Anki button) until
 * mining is on and a deck, a note type and its fields are set: the same rule as the Log's pop-up
 * (`buildAnkiConfigForPopover`), so a half-set-up Settings → Anki never shows a button that fails.
 */
export function popupAnkiConfig(reader) {
  if (!reader?.ankiEnabled || !reader.ankiDeckName || !reader.ankiModelName) return null
  if (!Array.isArray(reader.ankiModelFields) || reader.ankiModelFields.length === 0) return null
  return {
    ankiConnectUrl: (typeof reader.ankiConnectUrl === 'string' && reader.ankiConnectUrl.trim()) || DEFAULT_ANKI_CONNECT_URL,
    deck: reader.ankiDeckName,
    model: reader.ankiModelName,
    modelFields: reader.ankiModelFields,
    mappings: Array.isArray(reader.ankiFieldMappings) ? reader.ankiFieldMappings : [],
    tags: Array.isArray(reader.ankiTags) ? reader.ankiTags : []
  }
}

/**
 * `embedded`: Built-in Yomitan is loaded in this document (its own pop-up is switched off while
 * the Yomitan API is the engine). The Yomitan API on its own (`startApiEngine` in overlay.js) loads
 * none of Yomitan's files, so there is nothing to switch. `onVisibilityChange(visible)`: told when
 * this word's pop-up opens or closes, so automatic OCR can hold still while it's read.
 */
export async function installApiLookup({ embedded = true, onVisibilityChange = () => {} } = {}) {
  const { setEmbeddedEnabled } = embedded
    ? await import('/spike/frontend-mode.js')
    : { setEmbeddedEnabled: () => {} }
  const { invoke } = window.__TAURI__.core
  let settings = await invoke('settings_get', { key: 'yomitanSettings' })
  let reader = (await invoke('settings_get', { key: 'superTexthooker' })) || {}
  const apiMode = () => settings?.popupType === 'custom-api'
  // Empty means the helper's default address (resolveYomitanApiUrl in yomitan-api-setup.ts).
  const baseUrl = () => settings?.customApiUrl?.trim() || 'http://127.0.0.1:19633'

  async function open({ term, cursorX, cursorY, anchor, sentence, focus }) {
    try {
      onVisibilityChange(true)
      await invoke('show_popover', {
        term: term.trim(),
        cursorX,
        cursorY,
        anchor,
        width: reader.popoverWidth || 480,
        height: reader.popoverHeight || 360,
        baseUrl: baseUrl(),
        focus,
        sentence,
        includeMedia: Boolean(reader.audioEnabled || reader.ankiEnabled),
        audioAutoplay: Boolean(reader.audioEnabled && reader.audioAutoplay),
        audioVolume: reader.audioVolume ?? 0.9,
        ankiConfig: popupAnkiConfig(reader)
      })
    } catch (error) {
      onVisibilityChange(false)
      console.error('API dictionary popup:', error)
    }
  }

  const scanner = createScanner({
    region: WORD_BOX,
    // A box's own text and, after it, the next boxes' text (`.ocr-lookahead`), so a word OCR
    // split across two boxes is still found whole.
    block: WORD_BOX,
    sentenceOf: (node) => {
      const box = node.parentElement?.closest(WORD_BOX)
      return box?.renderText ?? box?.querySelector('.ocr-word-current')?.textContent ?? null
    },
    tokenize: (text, scanLength) =>
      invoke('yomitan_tokenize', { baseUrl: baseUrl(), body: { text, scan_length: scanLength } }),
    show: ({ term, sentence, anchor, point, clicked }) =>
      void open({ term, cursorX: point.screenX, cursorY: point.screenY, anchor, sentence, focus: clicked })
  })

  const update = () => {
    setEmbeddedEnabled(!apiMode())
    if (!apiMode()) scanner.stop()
  }
  update()
  await window.__TAURI__.event.listen('settings:changed', ({ payload }) => {
    if (payload.key === 'yomitanSettings') {
      settings = payload.value
      update()
      if (!apiMode()) void invoke('hide_popover')
    }
    if (payload.key === 'superTexthooker') reader = payload.value || {}
  })
  // Only the first pop-up is this word's; the ones nested on it close on their own.
  await window.__TAURI__.event.listen('popover:hide', ({ payload }) => {
    if (payload?.level) return
    onVisibilityChange(false)
    scanner.clearSelection()
  })

  const pointOf = (event) => ({
    x: event.clientX,
    y: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY
  })
  window.addEventListener(
    'pointermove',
    (event) => {
      if (!apiMode()) return
      if (event.shiftKey) scanner.scan(pointOf(event))
      else scanner.stop()
    },
    true
  )
  document.addEventListener(
    'click',
    (event) => {
      if (!apiMode() || !event.target?.closest?.(WORD_BOX)) return
      event.stopPropagation()
      scanner.lookUp(pointOf(event))
    }
  )

  showTerm = open
  tokenizeText = (text) =>
    invoke('yomitan_tokenize', { baseUrl: baseUrl(), body: { text, scan_length: 16 } })
  hideTerm = () => {
    if (!apiMode()) return
    scanner.stop()
    onVisibilityChange(false)
    void invoke('hide_popover')
  }
}
