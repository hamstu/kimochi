/** Host-only mode switch; distributed Yomitan and its saved options stay untouched. */
import { Frontend } from "/js/app/frontend.js";
const frontends = new Set();
let enabled = true;
const prepare = Frontend.prototype.prepare;
Frontend.prototype.prepare = async function (...args) {
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
