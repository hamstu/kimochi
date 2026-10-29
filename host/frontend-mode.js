/** Host-only mode switch; distributed Yomitan and its saved options stay untouched. */
import { Frontend } from "/js/app/frontend.js";
const frontends = new Set();
let enabled = true;
/** @type {?string} */
let scanScope = null;

/**
 * Yomitan has no option for where a page may be scanned: its own search and popup pages narrow
 * their scanner with `TextScanner#includeSelector` (display.js, `.click-scannable`), and a
 * content-script frontend never sets one. So it is set here, on this document's frontends only.
 */
function applyScanScope(frontend) {
  const scanner = frontend._textScanner;
  if (!scanner || !("includeSelector" in scanner)) {
    console.error("[kimochi] Frontend#_textScanner.includeSelector is gone; lookups are not scoped.");
    return;
  }
  scanner.includeSelector = scanScope;
}

const prepare = Frontend.prototype.prepare;
Frontend.prototype.prepare = async function (...args) {
  // Before the original: preparing ends with a search, which must already be scoped.
  applyScanScope(this);
  const result = await prepare.apply(this, args);
  frontends.add(this);
  this.setDisabledOverride(!enabled);
  return result;
};
export function setEmbeddedEnabled(value) {
  enabled = value;
  for (const frontend of frontends) frontend.setDisabledOverride(!value);
}

/**
 * Limit lookups in this document to text inside elements matching `selector` (null: anywhere).
 * Yomitan trims the scanned text until every node in it has an ancestor that matches, so a scan
 * that starts outside the scope finds nothing and one that starts inside stops at its edge.
 * Per document: the overlay, the popup host and every popup iframe keep scanning everything.
 */
export function setScanScope(selector) {
  scanScope = selector;
  for (const frontend of frontends) applyScanScope(frontend);
}

/**
 * Look up the text a range starts, as if the reader had pointed at it: the controller's word
 * cursor uses this to open the popup on the word it has selected. Resolves false when no
 * frontend is running here yet.
 */
export async function lookupRange(range) {
  const frontend = [...frontends][0];
  if (!frontend || !enabled) return false;
  const { TextSourceRange } = await import("/js/dom/text-source-range.js");
  await frontend.setTextSource(TextSourceRange.create(range));
  return true;
}

/**
 * Read along's lookup: `text` (the characters from the word on) looked up and shown in Yomitan's
 * own popup beside `rect` (this document's CSS pixels), with `sentence` (and the word's `offset`
 * in it) as the popup's sentence for Anki. Yomitan's search and popup are asked for directly
 * (`api.termsFind`, then `kanjiFind` for the first character as its scanner does, and
 * `Popup#showContent`), so there is no Range, no selection and nothing scanned under a pointer.
 * Resolves `{shown, length}`: whether the popup shows entries, and how many characters matched (0
 * for none), or null when no frontend here can (the caller falls back to `lookupRange`).
 */
export async function lookupText({ text, sentence = "", offset = 0, rect }) {
  const frontend = [...frontends][0];
  if (!frontend || !enabled) return null;
  const popup = frontend._popup;
  const scanner = frontend._textScanner;
  const api = frontend._application?.api;
  if (!popup || !api || typeof popup.showContent !== "function" || typeof frontend._getOptionsContext !== "function") {
    console.error("[kimochi] Yomitan's frontend has no popup, api or options context; read along falls back.");
    return null;
  }
  const query = String(text ?? "").slice(0, scanner?._scanLength || 16);
  if (!query) return { shown: false, length: 0 };
  const optionsContext = await frontend._getOptionsContext();
  // A lookup the pointer made may have left its text selected (Yomitan's "select matched text").
  scanner?.clearSelection?.();
  let type = "terms";
  let { dictionaryEntries, originalTextLength } = await api.termsFind(query, {}, optionsContext);
  if (!dictionaryEntries?.length) {
    type = "kanji";
    dictionaryEntries = await api.kanjiFind(query.slice(0, 1), optionsContext);
    originalTextLength = dictionaryEntries?.length ? 1 : 0;
  }
  if (!dictionaryEntries?.length) {
    void popup.hide(false);
    return { shown: false, length: 0 };
  }
  const { tabId, frameId } = frontend._application;
  const pageTheme = scanner?._themeController?.computeSiteTheme?.() ?? "light";
  const vertical = rect?.vertical === true;
  await popup.showContent(
    {
      optionsContext,
      sourceRects: [{ left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height }],
      writingMode: vertical ? "vertical-rl" : "horizontal-tb",
    },
    {
      focus: false,
      historyMode: "clear",
      params: { type, query: type === "kanji" ? query.slice(0, 1) : query, wildcards: "off" },
      state: {
        focusEntry: 0,
        optionsContext,
        url: optionsContext.url,
        pageTheme,
        sentence: { text: sentence || query, offset: sentence ? offset : 0 },
      },
      content: { contentOrigin: { tabId, frameId }, dictionaryEntries },
    },
  );
  return { shown: true, length: originalTextLength ?? null };
}
