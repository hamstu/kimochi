/** Types for ui/log-sections.js, for the TypeScript modules that import it. */
export function logSections(groups: unknown, text?: string): string[]
export function sectionText(text: unknown): string
export function readingSections(groups: unknown, text?: string): string[]
declare const sections: {
  logSections: typeof logSections
  sectionText: typeof sectionText
  readingSections: typeof readingSections
}
export default sections
