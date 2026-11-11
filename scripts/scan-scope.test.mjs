/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test helpers. */
/**
 * The main window only looks up its transcript lines.
 *
 * Yomitan's content-script frontend scans any text on the page, and the main window is mostly
 * Kimochi's own UI: settings, the sidebar, the notebook. `ui/panel-yomitan.js` scopes that
 * window's scanner to `[data-yomitan-scan]` through `host/frontend-mode.js`, which sets the
 * vendored `TextScanner#includeSelector` (the seam Yomitan's own display.js uses for
 * `.click-scannable`). The overlay, the popup host and popup iframes never set a scope.
 *
 * The scanner tests run the *vendored* `TextScanner#getTextSourceContent` (and so its
 * `_constrainTextSource` and `everyNodeMatchesSelector`) over a fake text source, so a Yomitan
 * update that changes how the include selector is matched fails here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const SCAN_SELECTOR = '[data-yomitan-scan]'

globalThis.Node ??= { ELEMENT_NODE: 1, TEXT_NODE: 3 }
const { TextScanner } = await import('../extensions/yomitan/js/language/text-scanner.js')

// --- A tiny DOM: enough for `Element#matches` on attribute and class selectors. -------------

function el(attrs = {}, ...children) {
  const node = {
    nodeType: 1,
    parentNode: null,
    attrs,
    children,
    matches(selector) {
      return selector.split(',').some((part) => {
        const s = part.trim()
        const attr = /^\[([\w-]+)\]$/.exec(s)
        if (attr) return attr[1] in this.attrs
        // `[attr] *`: inside an element that has it.
        const within = /^\[([\w-]+)\] \*$/.exec(s)
        if (within) {
          for (let up = this.parentNode; up; up = up.parentNode) if (within[1] in up.attrs) return true
          return false
        }
        const cls = /^\.([\w-]+)$/.exec(s)
        if (cls) return (this.attrs.class ?? '').split(' ').includes(cls[1])
        throw Error(`fake matches() cannot parse ${s}`)
      })
    }
  }
  for (const child of children) child.parentNode = node
  return node
}
const text = (value) => ({ nodeType: 3, parentNode: null, value })

/** Text nodes under `root`, in document order. */
function textNodes(root) {
  return root.nodeType === 3 ? [root] : root.children.flatMap(textNodes)
}

/**
 * A TextSource over `nodes` starting at character `start` of the first: the parts of the
 * interface `getTextSourceContent` uses (clone, setEndOffset, getNodesInRange, text).
 */
function source(nodes, nodeIndex, offset, length = 0) {
  const flat = nodes.map((n) => n.value).join('')
  const begin = nodes.slice(0, nodeIndex).reduce((sum, n) => sum + n.value.length, 0) + offset
  return {
    length,
    clone: () => source(nodes, nodeIndex, offset, length),
    setEndOffset(next) {
      this.length = Math.max(0, Math.min(next, flat.length - begin))
      return this.length
    },
    text() {
      return flat.slice(begin, begin + this.length)
    },
    getNodesInRange() {
      const out = []
      let at = 0
      for (const n of nodes) {
        const from = at
        at += n.value.length
        if (at > begin && from < begin + Math.max(this.length, 1)) out.push(n)
      }
      return out
    }
  }
}

function scan(includeSelector, nodes, nodeIndex, offset, length = 10, excludeSelector = null) {
  const scanner = Object.create(TextScanner.prototype)
  scanner._includeSelector = null
  scanner._excludeSelector = null
  scanner._touchExcludeSelector = null
  scanner.includeSelector = includeSelector
  scanner.excludeSelector = excludeSelector
  return scanner.getTextSourceContent(source(nodes, nodeIndex, offset), length, false, 'mouse')
}

/** The main window's shape: a sidebar label, then two transcript lines with token spans. */
function mainWindow() {
  const lineA = el({ class: 'line', 'data-yomitan-scan': '' },
    el({ class: 'token' }, text('食べ')), el({ class: 'token' }, text('ました')))
  const lineB = el({ class: 'line', 'data-yomitan-scan': '' }, text('今日は'))
  const sidebar = el({ class: 'sidebar' }, text('設定'))
  const after = el({ class: 'settings' }, text('表示'))
  const root = el({ id: 'root' }, sidebar, el({ class: 'log' }, lineA, lineB), after)
  return textNodes(root)
}

test('a scan that starts on a transcript line reads the line, across its token spans', () => {
  const nodes = mainWindow()
  // nodes: 設定 | 食べ | ました | 今日は | 表示
  assert.equal(scan(SCAN_SELECTOR, nodes, 1, 0, 5), '食べました')
  assert.equal(scan(SCAN_SELECTOR, nodes, 1, 1, 3), 'べまし')
})

test('a scan that starts on unmarked UI text reads nothing', () => {
  const nodes = mainWindow()
  assert.equal(scan(SCAN_SELECTOR, nodes, 0, 0), '')
  assert.equal(scan(SCAN_SELECTOR, nodes, 4, 0), '')
})

test('a scan stops where marked text ends, and carries on into the next marked line', () => {
  const nodes = mainWindow()
  // Two marked lines in a row continue, as they always did; the settings text after them does not.
  assert.equal(scan(SCAN_SELECTOR, nodes, 3, 0, 10), '今日は')
  assert.equal(scan(SCAN_SELECTOR, nodes, 2, 0, 6), 'ました今日は')
})

test('with no scope (the overlay, the popup host, popup iframes) everything scans', () => {
  const nodes = mainWindow()
  assert.equal(scan(null, nodes, 0, 0, 4), '設定食べ')
  assert.equal(scan(null, nodes, 4, 0), '表示')
})

// --- Kimochi's own controls over scannable text: `data-no-scan`. ------------------------------

const NO_SCAN = '[data-no-scan], [data-no-scan] *'

/** The overlay's shape: a hooked line on the card, then the card's open menu. */
function hookCard() {
  const line = el({ class: 'hook-card-text' }, text('食べました'))
  const menu = el(
    { class: 'hook-card-menu', 'data-no-scan': '' },
    el({ class: 'hook-card-menu-label' }, text('不透明度')),
    text('設定')
  )
  return textNodes(el({ class: 'hook-card' }, line, menu))
}

test('text marked data-no-scan is never read, even where everything else scans', () => {
  const nodes = hookCard()
  // nodes: 食べました | 不透明度 | 設定
  assert.equal(scan(null, nodes, 1, 0, 4, NO_SCAN), '')
  assert.equal(scan(null, nodes, 2, 0, 2, NO_SCAN), '')
  // The line still reads, and stops where the menu starts.
  assert.equal(scan(null, nodes, 0, 0, 8, NO_SCAN), '食べました')
})

// --- frontend-mode.js, with the vendored Frontend replaced by a stand-in. -------------------

let frontendModeLoads = 0
async function loadFrontendMode() {
  const calls = []
  class Frontend {
    constructor() {
      this._textScanner = new TextScanner({})
      this.disabled = null
    }
    async prepare() {
      calls.push(['prepare', this._textScanner.includeSelector])
    }
    setDisabledOverride(value) {
      this.disabled = value
    }
  }
  globalThis.__scanScopeFrontend = Frontend
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../host/frontend-mode.js', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    plugins: [{
      name: 'stub-frontend',
      setup(b) {
        b.onResolve({ filter: /^\/js\// }, (args) => ({ path: args.path, namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
          if (args.path !== '/js/app/frontend.js') return { contents: 'export {}' }
          return { contents: 'export const Frontend = globalThis.__scanScopeFrontend' }
        })
      }
    }]
  })
  // A fresh module each time (an identical data: URL is the cached module), so it wraps this Frontend.
  const source = `${Buffer.from(outputFiles[0].contents)}\n// load ${++frontendModeLoads}`
  const mode = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  return { mode, Frontend, calls }
}

test('setScanScope scopes a frontend before it prepares, and later ones too', async () => {
  const { mode, Frontend, calls } = await loadFrontendMode()
  mode.setScanScope(SCAN_SELECTOR)
  const frontend = new Frontend()
  await frontend.prepare()
  // Preparing ends with a search; it must already be scoped by then.
  assert.deepEqual(calls, [['prepare', SCAN_SELECTOR]])
  mode.setScanScope(null)
  assert.equal(frontend._textScanner.includeSelector, null)
  // Kimochi's own controls stay out of every scan, scoped or not.
  assert.equal(frontend._textScanner.excludeSelector, NO_SCAN)
})

test('the hook card\'s controls and the hint bar carry data-no-scan; the hooked line does not', () => {
  const card = read('ui/hook-card.js')
  assert.match(card, /for \(const element of \[bar, controls, corner, menu\]\) element\.setAttribute\('data-no-scan', ''\)/)
  assert.doesNotMatch(card, /text\.setAttribute\('data-no-scan'/)
  assert.match(read('ui/overlay-hints.js'), /bar\.setAttribute\('data-no-scan', ''\)/)
  // Hachidori and 10ten skip it too: their scope check refuses a point inside the marker first.
  assert.match(read('host/ext/content.js'), /if \(element\?\.closest\?\.\('\[data-no-scan\]'\)\) return false/)
})

test('a document that never sets a scope keeps Yomitan\'s default of scanning everything', async () => {
  const { Frontend } = await loadFrontendMode()
  const frontend = new Frontend()
  await frontend.prepare()
  assert.equal(frontend._textScanner.includeSelector, null)
})

// --- The last word of a line, with Kimochi's controls after it in the document. --------------
//
// These run the vendored `TextSourceRange` and `DOMTextScanner` over a linked DOM, so the range
// end lands where Yomitan really leaves it: a read that runs out of text walks on to the last
// node in the document, past the hook card's `data-no-scan` controls.

const { TextSourceRange } = await import('../extensions/yomitan/js/dom/text-source-range.js')
const matches = el().matches
const STYLE = {
  display: 'inline', position: 'static', visibility: 'visible', opacity: '1', fontSize: '16px',
  color: 'rgb(0, 0, 0)', userSelect: 'auto', webkitUserSelect: 'auto', whiteSpace: 'normal'
}
globalThis.window ??= {}
globalThis.window.getComputedStyle ??= (node) => ({ ...STYLE, ...node.style })

function tag(nodeName, attrs, style, ...childNodes) {
  const node = { nodeType: 1, nodeName, attrs, style, matches, parentNode: null, nextSibling: null, previousSibling: null, childNodes }
  childNodes.forEach((child, i) => {
    child.parentNode = node
    child.previousSibling = childNodes[i - 1] ?? null
    child.nextSibling = childNodes[i + 1] ?? null
  })
  node.firstChild = childNodes[0] ?? null
  node.lastChild = childNodes.at(-1) ?? null
  return node
}
const chars = (nodeValue) => ({ nodeType: 3, nodeName: '#text', nodeValue, childNodes: [], firstChild: null })

class FakeRange {
  constructor(startContainer, startOffset, endContainer = startContainer, endOffset = startOffset) {
    Object.assign(this, { startContainer, startOffset, endContainer, endOffset })
  }
  setStart(node, offset) { Object.assign(this, { startContainer: node, startOffset: offset }) }
  setEnd(node, offset) { Object.assign(this, { endContainer: node, endOffset: offset }) }
  cloneRange() { return new FakeRange(this.startContainer, this.startOffset, this.endContainer, this.endOffset) }
  toString() { return '' }
}

/** The overlay's shape (render.js, hook-card.js): a line's word boxes, then the hook card. */
function overlayDocument({ menuOpen = false } = {}) {
  const word = (value) => tag('SPAN', { class: 'ocr-word' }, { display: 'inline-flex', position: 'absolute' },
    tag('SPAN', { class: 'ocr-word-text' }, { display: 'block' },
      tag('SPAN', { class: 'ocr-word-current' }, {}, chars(value)),
      tag('SPAN', { class: 'ocr-lookahead' }, {})))
  const first = word('猫が')
  const last = word('食べました')
  const label = chars('不透明度')
  const card = tag('DIV', { class: 'hook-card' }, { display: 'block', position: 'absolute' }, chars('\n  '),
    tag('DIV', { class: 'hook-card-bar', 'data-no-scan': '' }, { display: 'flex' }, chars('\n    '),
      tag('BUTTON', { class: 'hook-card-button' }, { display: 'inline-block' }, chars('⋯')), chars('\n  ')),
    tag('DIV', { class: 'hook-card-menu', 'data-no-scan': '' }, { display: menuOpen ? 'block' : 'none' },
      tag('SPAN', { class: 'hook-card-menu-label' }, {}, label)),
    tag('DIV', { class: 'hook-card-controls', 'data-no-scan': '' }, { display: 'flex' }))
  tag('BODY', {}, { display: 'block' }, chars('\n    '),
    tag('DIV', { id: 'words' }, { display: 'block' }, first, last), chars('\n    '), card, chars('\n    '),
    tag('DIV', { id: 'hover' }, { display: 'block' }), chars('\n  '))
  const textOf = (box) => box.firstChild.firstChild.firstChild
  return { first: textOf(first), last: textOf(last), label }
}

/**
 * What a frontend's scanner reads from character `offset` of `node`, through frontend-mode.js,
 * with the profile's Layout-aware scan option set to `layoutAwareScan`. The flag is read back from
 * the scanner, as Yomitan's own lookup (`_findTermDictionaryEntries`) does.
 */
async function lookup(node, offset, layoutAwareScan) {
  const { Frontend } = await loadFrontendMode()
  const frontend = new Frontend()
  await frontend.prepare()
  const scanner = frontend._textScanner
  scanner.setOptions({ layoutAwareScan })
  const source = TextSourceRange.create(new FakeRange(node, offset))
  const text = scanner.getTextSourceContent(source, 16, scanner._layoutAwareScan, 'mouse')
  // The page's whitespace is text without the option: the read ends in the whitespace before the card.
  return text.trimEnd()
}

test('Layout-aware scan stays off on Kimochi\'s pages, whatever the profile says', async () => {
  const { Frontend } = await loadFrontendMode()
  const frontend = new Frontend()
  await frontend.prepare()
  frontend._textScanner.setOptions({ layoutAwareScan: true })
  assert.equal(frontend._textScanner._layoutAwareScan, false)
})

test('the last word of a line is read whole, with the profile\'s Layout-aware scan on or off', async () => {
  const { first, last } = overlayDocument()
  for (const layoutAwareScan of [true, false]) {
    // With the option on, this read ran out of text, ended past the hook card's controls, and
    // lost its last character to Yomitan's exclude check.
    assert.equal(await lookup(last, 0, layoutAwareScan), '食べました')
    assert.equal(await lookup(last, 1, layoutAwareScan), 'べました')
    assert.equal(await lookup(first, 0, layoutAwareScan), '猫が食べました')
  }
})

test('text inside a data-no-scan control is still never read', async () => {
  const { last, label } = overlayDocument({ menuOpen: true })
  for (const layoutAwareScan of [true, false]) {
    assert.equal(await lookup(label, 0, layoutAwareScan), '')
    // A line's last word stops before the open menu.
    assert.equal(await lookup(last, 0, layoutAwareScan), '食べました')
  }
})

// --- Who sets the scope, and who carries the marker. ----------------------------------------

test('only the panel relay scopes its scanner, to the marker the Log lines carry', () => {
  const relay = read('ui/panel-yomitan.js')
  assert.match(relay, /export const SCAN_SELECTOR = '\[data-yomitan-scan\]'/)
  assert.match(relay, /^setScanScope\(SCAN_SELECTOR\)$/m)
  // The windows whose scanning must stay as it was never narrow it.
  for (const path of ['ui/overlay.js', 'ui/popup-host.js', 'ui/api-lookup.js', 'host/yomitan/overlay.js', 'host/yomitan/panel.js', 'host/yomitan/common.js']) {
    assert.doesNotMatch(read(path), /setScanScope|includeSelector/, path)
  }
})

test('every form of a transcript line carries the marker', () => {
  const row = read('frontend/texthooker/components/LineRow.tsx')
  assert.match(row, /const groupProps = \{\s*'data-yomitan-scan': '',/)
  const rows = row.match(/className="line[ "]/g) ?? []
  const spreads = row.match(/\{\.\.\.groupProps\}/g) ?? []
  assert.ok(rows.length >= 4, 'LineRow renders its row forms')
  assert.equal(spreads.length, rows.length, 'each .line row spreads groupProps')
})

test('the vendored seams the scope relies on are still there', () => {
  assert.match(read('extensions/yomitan/js/app/frontend.js'), /this\._textScanner = new TextScanner\(/)
  const scanner = read('extensions/yomitan/js/language/text-scanner.js')
  assert.match(scanner, /set includeSelector\(value\) \{\s*this\._includeSelector = value;/)
  assert.match(scanner, /const includeSelector = this\._includeSelector;/)
  // frontend-mode.js keeps Layout-aware scan off by holding this flag false; every lookup reads it.
  assert.match(scanner, /this\._layoutAwareScan = layoutAwareScan;/)
  assert.equal(scanner.match(/const layoutAwareScan = this\._layoutAwareScan;/g)?.length, 2)
  assert.match(scanner, /textSource\.setStartOffset\(this\._scanLength, this\._layoutAwareScan, true\);/)
})
