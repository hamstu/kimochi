/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test helpers. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { syncSourceHighlightStyle } from '../host/ext/content.js'

test('invisible mode suppresses Hachidori fallback paint and restores the original styling', () => {
  const nodes = []
  const root = {
    querySelector: () => nodes[0] ?? null,
    append: (node) => nodes.push(node)
  }
  const doc = {
    createElement: () => ({
      setAttribute() {},
      remove() {
        nodes.splice(nodes.indexOf(this), 1)
      }
    })
  }
  syncSourceHighlightStyle(doc, root, false)
  assert.equal(nodes.length, 0)
  syncSourceHighlightStyle(doc, root, true)
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].textContent, '.gsm-hoshidicts-source-highlight-layer { visibility: hidden !important; }')
  syncSourceHighlightStyle(doc, root, true)
  assert.equal(nodes.length, 1, 'repeated popup measurements do not add styles or trigger a mutation loop')
  syncSourceHighlightStyle(doc, root, false)
  assert.equal(nodes.length, 0, 'turning invisible mode off restores the original source highlight')
})
