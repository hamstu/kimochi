/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * A scan's text as the Log shows it, for Read along's full-screen dictionary.
 *
 * The Log gives each group of a scan a line of its own ("1 / 2", "2 / 2"; frontend/texthooker/
 * host.ts `ingestHistory`), the groups being what `publishOcrResult` wrote to the history
 * (`logGroups`, ui/ocr-result.ts), and a scan with no groups one line of its whole text. The full
 * screen shows the same sections, each as one run of text (`sectionText`).
 */

/** A scan's sections, as the Log's lines: each group with text, or the whole text as one. */
export function logSections(groups, text = "") {
  const sections = (Array.isArray(groups) ? groups : [])
    .map((group) => (typeof group?.text === "string" ? group.text : ""))
    .filter((value) => value.trim());
  if (sections.length) return sections;
  return typeof text === "string" && text.trim() ? [text] : [];
}

const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

/**
 * One section as one run of text: the OCR line breaks inside it (`logicalGroups` puts one between
 * lines, and an engine that reads a word or a particle per box makes one per box) are taken out.
 * Japanese runs straight on across a break; two Latin or digit runs keep a space between them.
 * Spaces inside a line, the ideographic space `logicalGroups` puts at a wide gap among them, are
 * kept as the Log has them.
 */
export function sectionText(text) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let joined = "";
  for (const line of lines) {
    if (joined && !CJK.test(joined.slice(-1)) && !CJK.test(line[0])) joined += " ";
    joined += line;
  }
  return joined;
}

/** The sections Read along shows: the Log's, each one run of text, empty ones dropped. */
export function readingSections(groups, text = "") {
  return logSections(groups, text).map(sectionText).filter(Boolean);
}

export default { logSections, sectionText, readingSections };
