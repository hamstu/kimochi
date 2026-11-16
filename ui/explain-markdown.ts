/**
 * The Markdown an Explain answer is written in, read into blocks the overlay builds as DOM nodes
 * (ui/overlay-explain.js): text is only ever text, so nothing an answer says becomes markup.
 *
 * The overlay's modules are served as they are, with no bundler, so the Log's renderer (marked)
 * cannot be had here. This reads what the Explain prompt asks for and models write: paragraphs
 * (a single line break kept, as the Log keeps it), headings, bulleted and numbered lists, quotes,
 * fenced code, and **bold**, *italic* and `code` within a line. An answer still streaming in reads
 * the same way; a mark not yet closed shows as written until it is.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em'; children: Inline[] }
  | { kind: 'br' }

export type Block =
  | { kind: 'p'; children: Inline[] }
  | { kind: 'h'; level: number; children: Inline[] }
  | { kind: 'ul' | 'ol'; items: Inline[][] }
  | { kind: 'pre'; text: string }

/** The first mark in a line: `code`, **strong** (or __strong__), or *em*. */
const MARK = /`([^`]+)`|\*\*(?=\S)(.+?)\*\*|__(?=\S)(.+?)__|\*(?=[^\s*])([^*]+?)\*/

/** A line's text with its marks. */
export function inline(text: string): Inline[] {
  const out: Inline[] = []
  let rest = text
  while (rest) {
    const match = MARK.exec(rest)
    if (!match) {
      out.push({ kind: 'text', text: rest })
      break
    }
    if (match.index > 0) out.push({ kind: 'text', text: rest.slice(0, match.index) })
    if (match[1] !== undefined) out.push({ kind: 'code', text: match[1] })
    else if (match[2] !== undefined || match[3] !== undefined)
      out.push({ kind: 'strong', children: inline(match[2] ?? match[3]) })
    else out.push({ kind: 'em', children: inline(match[4]) })
    rest = rest.slice(match.index + match[0].length)
  }
  return out
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const FENCE = /^\s*(```|~~~)/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/

/** An answer's blocks, in order. */
export function markdownBlocks(markdown: string): Block[] {
  const blocks: Block[] = []
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  /** The paragraph being read: its lines, kept apart (a single line break is kept). */
  let paragraph: string[] = []
  const endParagraph = (): void => {
    if (!paragraph.length) return
    const children: Inline[] = []
    paragraph.forEach((line, index) => {
      if (index) children.push({ kind: 'br' })
      children.push(...inline(line))
    })
    blocks.push({ kind: 'p', children })
    paragraph = []
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const fence = FENCE.exec(line)
    if (fence) {
      endParagraph()
      const code: string[] = []
      for (index++; index < lines.length && !lines[index].trim().startsWith(fence[1]); index++) code.push(lines[index])
      blocks.push({ kind: 'pre', text: code.join('\n') })
      continue
    }
    if (!line.trim() || RULE.test(line)) {
      endParagraph()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      endParagraph()
      blocks.push({
        kind: 'h',
        level: heading[1].length,
        children: inline(heading[2])
      })
      continue
    }
    const bullet = BULLET.exec(line)
    const listed = bullet ?? NUMBERED.exec(line)
    if (listed) {
      endParagraph()
      const kind = bullet ? 'ul' : 'ol'
      const item = listed[1]
      const last = blocks.at(-1)
      if (last?.kind === kind) last.items.push(inline(item))
      else blocks.push({ kind, items: [inline(item)] })
      continue
    }
    const last = blocks.at(-1)
    // An indented line straight after a list item carries the item on.
    if (!paragraph.length && /^\s+\S/.test(line) && (last?.kind === 'ul' || last?.kind === 'ol')) {
      const item = last.items[last.items.length - 1]
      item.push({ kind: 'text', text: ' ' }, ...inline(line.trim()))
      continue
    }
    const quote = QUOTE.exec(line)
    paragraph.push(quote ? quote[1] : line)
  }
  endParagraph()
  return blocks
}
