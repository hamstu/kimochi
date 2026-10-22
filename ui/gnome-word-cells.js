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

/** Controller metadata must not limit the shared WebView's text. Intern the
 * repeated sentences so long OCR lines cannot overflow the bounded Shell RPC. */
export function packGnomeWords(words, limit = 220000) {
  const sentences=[],indices=new Map(),packed=[]
  let size=64
  for(const word of words) {
    let id=indices.get(word.sentence)
    const fresh=id===undefined
    if(fresh)id=sentences.length
    const cell={sentenceId:id,offset:word.offset,x:word.x,y:word.y,width:word.width,height:word.height}
    const added=JSON.stringify(cell).length+(fresh?JSON.stringify(word.sentence).length:0)+2
    if(size+added>limit)break
    if(fresh){indices.set(word.sentence,id);sentences.push(word.sentence)}
    packed.push(cell);size+=added
  }
  return {words:packed,sentences}
}
