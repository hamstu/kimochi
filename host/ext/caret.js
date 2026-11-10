/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * `document.caretPositionFromPoint(x, y, {shadowRoots})` where WebKit lacks it.
 *
 * Hachidori finds the word under the pointer inside its own pop-up (a nested lookup) only with
 * this call and its `shadowRoots` option (content-scan.js `caretRangeAt`), with no fallback.
 * WebKit before Safari 26 has no `caretPositionFromPoint`, and its `caretRangeFromPoint` stops at
 * a shadow host, so on older macOS a nested lookup never found a word (#94). Installed before the
 * engine's content scripts; a WebKit that answers for itself is left to.
 */

/** The text position at (`x`, `y`) inside `root` (a shadow root), or null. */
export function caretInShadow(root, x, y, maxChars = 20000) {
  const element = root.elementFromPoint?.(x, y)
  if (!element || element === root.host) return null
  const doc = root.ownerDocument ?? element.ownerDocument
  const walker = doc.createTreeWalker(element, 4 /* NodeFilter.SHOW_TEXT */)
  const range = doc.createRange()
  let seen = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.data ?? ''
    for (let offset = 0; offset < text.length; offset += 1) {
      if (++seen > maxChars) return null
      range.setStart(node, offset)
      range.setEnd(node, offset + 1)
      for (const rect of range.getClientRects()) {
        if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return { offsetNode: node, offset }
      }
    }
  }
  return null
}

/** A `CaretPosition`-shaped answer: what Hachidori reads is `offsetNode` and `offset`. */
function position(win, node, offset) {
  return {
    offsetNode: node,
    offset,
    getClientRect() {
      const range = win.document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset)
      return range.getBoundingClientRect()
    }
  }
}

export function installCaretPosition(win) {
  const proto = win.Document?.prototype
  if (!proto || proto.__kimochiCaretPosition) return
  const native = proto.caretPositionFromPoint
  const fromRange = proto.caretRangeFromPoint
  const within = (node, roots) => roots.some((root) => node && root.contains?.(node))
  proto.__kimochiCaretPosition = true
  proto.caretPositionFromPoint = function (x, y, options) {
    const roots = Array.isArray(options?.shadowRoots) ? options.shadowRoots : []
    let answer = null
    try {
      answer = typeof native === 'function' ? native.call(this, x, y, options) : null
    } catch {
      answer = null
    }
    // A WebKit that took the shadow roots into account answers inside one of them.
    if (answer && (!roots.length || within(answer.offsetNode, roots))) return answer
    for (const root of roots) {
      const found = caretInShadow(root, x, y)
      if (found) return position(win, found.offsetNode, found.offset)
    }
    if (answer) return answer
    if (typeof native !== 'function' && typeof fromRange === 'function') {
      const range = fromRange.call(this, x, y)
      if (range) return position(win, range.startContainer, range.startOffset)
    }
    return null
  }
}
