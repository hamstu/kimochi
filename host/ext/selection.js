/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * `shadowRoot.getSelection()` where WebKit lacks it (Chrome has it; Safari does not).
 *
 * Hachidori reads the text selected in its pop-up, which lives in a shadow root, with
 * `shadow.getSelection?.() ?? window.getSelection()`, and keeps it only when the selection's
 * `anchorNode` is inside the pop-up (content.js: the Anki `popup-selection-text` marker, and a
 * click that ends a selection not opening a lookup). WebKit's `window.getSelection()` describes a
 * selection inside a shadow root against the shadow host: `anchorNode` is outside the pop-up and
 * `isCollapsed` is true even with text selected, so `{popup-selection-text}` was always empty in
 * Kimochi (#93). `Selection.getComposedRanges({shadowRoots})` (Safari 17+) gives the real range,
 * and this answers with it. Installed before the engine's content scripts.
 */

/** The selection's range inside `root`, from `getComposedRanges`, or null. */
export function composedRange(selection, root) {
  if (typeof selection?.getComposedRanges !== 'function') return null
  let ranges = []
  try {
    ranges = selection.getComposedRanges({ shadowRoots: [root] })
  } catch {
    // Safari 17 took the shadow roots as arguments.
    try {
      ranges = selection.getComposedRanges(root)
    } catch {
      return null
    }
  }
  const range = ranges?.[0]
  if (!range || !root.contains(range.startContainer)) return null
  return range
}

/** A `Selection` read for one shadow root: what Hachidori uses, over a live range in it. */
function shadowSelection(win, selection, range) {
  const live = win.document.createRange()
  live.setStart(range.startContainer, range.startOffset)
  live.setEnd(range.endContainer, range.endOffset)
  return {
    anchorNode: range.startContainer,
    anchorOffset: range.startOffset,
    focusNode: range.endContainer,
    focusOffset: range.endOffset,
    isCollapsed: range.collapsed,
    rangeCount: 1,
    type: range.collapsed ? 'Caret' : 'Range',
    getRangeAt(index) {
      if (index !== 0) throw new win.DOMException('Index out of range', 'IndexSizeError')
      return live
    },
    toString: () => live.toString(),
    removeAllRanges: () => selection.removeAllRanges(),
    empty: () => selection.removeAllRanges(),
    containsNode: (node, partly = false) => live.intersectsNode(node) && (partly || live.toString().length > 0)
  }
}

export function installShadowSelection(win) {
  const proto = win.ShadowRoot?.prototype
  if (!proto || typeof proto.getSelection === 'function') return
  Object.defineProperty(proto, 'getSelection', {
    configurable: true,
    writable: true,
    value: function getSelection() {
      const selection = win.getSelection()
      const range = composedRange(selection, this)
      // Nothing selected in this root: the document's selection, which is what Chrome reports too.
      return range ? shadowSelection(win, selection, range) : selection
    }
  })
}
