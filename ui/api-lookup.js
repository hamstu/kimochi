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

export async function installApiLookup() {
  const { setEmbeddedEnabled } = await import('/spike/frontend-mode.js')
  const { invoke } = window.__TAURI__.core
  let settings = await invoke('settings_get', { key: 'yomitanSettings' })
  let reader = (await invoke('settings_get', { key: 'superTexthooker' })) || {}
  const apiMode = () => settings?.popupType === 'custom-api'
  // Empty means the helper's default address (resolveYomitanApiUrl in yomitan-api-setup.ts).
  const baseUrl = () => settings?.customApiUrl?.trim() || 'http://127.0.0.1:19633'

  async function open({ term, cursorX, cursorY, anchor, sentence, focus }) {
    try {
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
        ankiConfig: reader.ankiEnabled
          ? {
              ankiConnectUrl: reader.ankiConnectUrl,
              deck: reader.ankiDeckName,
              model: reader.ankiModelName,
              modelFields: reader.ankiModelFields,
              mappings: reader.ankiFieldMappings,
              tags: reader.ankiTags
            }
          : null
      })
    } catch (error) {
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
  await window.__TAURI__.event.listen('popover:hide', () => scanner.clearSelection())

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
    void invoke('hide_popover')
  }
}
