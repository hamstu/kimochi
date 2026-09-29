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
