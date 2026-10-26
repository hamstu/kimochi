import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('with Auto OCR on, Scan is Force rescan: enabled, primary, and keeps its shortcut', async () => {
  const panel = await read('frontend/main/SourcePanel.tsx')
  assert.match(panel, /controller\.isAutoOCREnabled\s*\?\s*'Force rescan'/)
  assert.doesNotMatch(panel, /'Auto OCR is on'/)
  // Auto OCR no longer disables the button.
  const disabled = panel.match(/const scanDisabled =([\s\S]*?)\n\n/)[1]
  assert.doesNotMatch(disabled, /isAutoOCREnabled/)
})

test('the scan action clears what was read and starts Auto OCR over before scanning', async () => {
  const overlay = await read('ui/overlay.js')
  const action = overlay.match(/case 'triggerScan':([\s\S]*?)case 'openControllerMenu'/)[1]
  assert.match(action, /if \(scanner\.isRunning\) forceRescan\(\)\s*\n\s*return performScan\(\)/)
  const force = overlay.match(/function forceRescan\(\) \{([\s\S]*?)\n\}/)[1]
  assert.match(force, /clearSelectionText\(\)/)
  assert.match(force, /scanner\.resume\(\)/)
  const clear = overlay.match(/function clearSelectionText\(\) \{([\s\S]*?)\n\}/)[1]
  assert.match(clear, /state\.annotations = \[\]/)
  assert.match(clear, /scanner\.reset\(\)/)
})
