/**
 * Where the overlay's text can let clicks through to the game (`overlayCanClickThrough`,
 * ui/capabilities.ts): the overlay gates its words by it, and Settings → OCR & Overlay greys out
 * **Click through text to the game** where it can't, instead of offering a switch that does nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const built = await build({
  entryPoints: [`${root}ui/capabilities.ts`],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral'
})
const { overlayCanClickThrough, normalizeCapabilities } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
)

const linux = (backend, overlay = {}) =>
  normalizeCapabilities({ os: 'linux', session: { backend, compositor: 'x' }, overlay })

test('macOS, Windows and Linux on X11 always can', () => {
  assert.equal(overlayCanClickThrough(normalizeCapabilities({ os: 'macos' })), true)
  assert.equal(overlayCanClickThrough(normalizeCapabilities({ os: 'windows' })), true)
  assert.equal(overlayCanClickThrough(linux('x11')), true)
})

test('Wayland can only where native reads Shift', () => {
  assert.equal(overlayCanClickThrough(linux('wayland', { shiftGate: true })), true)
  assert.equal(overlayCanClickThrough(linux('wayland', { shiftGate: false })), false)
  assert.equal(overlayCanClickThrough(linux('wayland')), false)
})

test('the overlay and Settings decide by the same rule', async () => {
  const overlay = await readFile(`${root}ui/overlay.js`, 'utf8')
  assert.match(overlay, /const gated = overlayCanClickThrough\(caps\)/)
  const tab = await readFile(`${root}frontend/panels/settings/OcrTab.tsx`, 'utf8')
  assert.match(tab, /overlayCanClickThrough\(capabilities\)/)
  assert.match(tab, /id="ocr-click-through"[\s\S]{0,200}disabled=\{!canClickThrough\}/)
})
