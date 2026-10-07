/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Linux runtime bridge. */
import { layoutGroup, characterCells } from './text-layout.js'

/** Fit the existing reader's character geometry to an OCR screen rectangle. */
export function gnomeWordCells(text, rect, vertical = false, measure = text => [...text].length) {
  const runs = layoutGroup([{ text, rect, block: text.includes('\n') }], vertical, measure)
  const cells = characterCells(text, runs, vertical, measure)
  const seen = new Set()
  return cells.flatMap((cell, offset) => {
    if (!cell || seen.has(cell)) return []
    seen.add(cell)
    const x = Math.max(rect.x, cell.x), y = Math.max(rect.y, cell.y)
    const width = Math.min(rect.x + rect.width, cell.x + cell.width) - x
    const height = Math.min(rect.y + rect.height, cell.y + cell.height) - y
    return width > 0 && height > 0 ? [{ text: text.slice(offset), sentence: text, offset, x, y, width, height }] : []
  })
}
