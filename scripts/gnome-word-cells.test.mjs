import test from 'node:test'
import assert from 'node:assert/strict'
import { gnomeWordCells } from '../ui/gnome-word-cells.js'

test('GNOME Shift gliding starts lookup at each hovered character, within OCR bounds', () => {
  const cells = gnomeWordCells('今日は良い天気', {x: 20, y: 30, width: 210, height: 30})
  assert.equal(cells.length, 7)
  assert.equal(cells[5].text, '天気')
  assert.equal(cells[5].sentence, '今日は良い天気')
  assert.equal(cells[5].offset, 5)
  assert.ok(cells.every(c => c.x >= 20 && c.x + c.width <= 230 && c.y >= 30 && c.y + c.height <= 60))
})
test('vertical cells preserve supplementary characters and skip line breaks', () => {
  const cells = gnomeWordCells('𠮷野\n猫', {x: 10, y: 20, width: 60, height: 100}, true)
  assert.equal(cells.length, 3)
  assert.equal(cells[0].text, '𠮷野\n猫')
  assert.equal(cells[1].offset, 2)
  assert.equal(cells[2].text, '猫')
})

test('long line controller metadata stays bounded without imposing a character cap on shared rendering',async()=>{
  const {packGnomeWords}=await import('../ui/gnome-word-cells.js')
  const text='日本語'.repeat(600)
  const cells=gnomeWordCells(text,{x:0,y:0,width:18000,height:30}).slice(0,500)
  const packed=packGnomeWords(cells)
  assert.equal(packed.words.length,500);assert.deepEqual(packed.sentences,[text])
  assert.ok(JSON.stringify(packed).length<220000)
  assert.equal(packed.words[499].offset,cells[499].offset)
  assert.equal(packGnomeWords(cells,100).words.length,0)
})
