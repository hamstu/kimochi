import DOMPurify from 'dompurify'
/** Dictionary/LLM HTML is display data, never executable app code. */
export const displayHtml = (html: string): string => DOMPurify.sanitize(html)
