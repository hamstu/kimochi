import DOMPurify from 'dompurify'
import { marked } from 'marked'
/** Dictionary/LLM HTML is display data, never executable app code. */
export const displayHtml = (html: string): string => DOMPurify.sanitize(html)

/** A note's Markdown as display HTML: single line breaks kept, as the person typed them. */
export const markdownHtml = (text: string): string =>
  displayHtml(marked.parse(text, { breaks: true, async: false }) as string)
