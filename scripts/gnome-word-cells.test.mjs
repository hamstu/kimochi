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
