import DOMPurify from 'dompurify'
import { marked } from 'marked'
/** Dictionary/LLM HTML is display data, never executable app code. */
export const displayHtml = (html: string): string => DOMPurify.sanitize(html)

/**
 * Stylesheet text (a dictionary's `styles.css`) as display HTML: one `<style>` element, sanitized
 * like the glossaries it styles. FORCE_BODY keeps a leading `<style>` that parsing would otherwise
 * move out of the fragment.
 */
export const displayCss = (css: string): string =>
  css ? DOMPurify.sanitize(`<style>${css}</style>`, { FORCE_BODY: true }) : ''

/** A note's Markdown as display HTML: single line breaks kept, as the person typed them. */
export const markdownHtml = (text: string): string =>
  displayHtml(marked.parse(text, { breaks: true, async: false }) as string)
