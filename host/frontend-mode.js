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
