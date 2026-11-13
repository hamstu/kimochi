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
  const lineA = el(
    { class: 'line', 'data-yomitan-scan': '' },
    el({ class: 'token' }, text('食べ')),
    el({ class: 'token' }, text('ました'))
  )
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
    plugins: [
      {
        name: 'stub-frontend',
        setup(b) {
          b.onResolve({ filter: /^\/js\// }, (args) => ({ path: args.path, namespace: 'stub' }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
            if (args.path !== '/js/app/frontend.js') return { contents: 'export {}' }
            return { contents: 'export const Frontend = globalThis.__scanScopeFrontend' }
          })
        }
      }
    ]
  })
  const code = Buffer.from(outputFiles[0].contents).toString('base64')
  const mode = await import(`data:text/javascript;base64,${code}`)
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

test("the hook card's controls and the hint bar carry data-no-scan; the hooked line does not", () => {
  const card = read('ui/hook-card.js')
  assert.match(
    card,
    /for \(const element of \[bar, controls, corner, menu\]\) element\.setAttribute\('data-no-scan', ''\)/
  )
  assert.doesNotMatch(card, /text\.setAttribute\('data-no-scan'/)
  assert.match(read('ui/overlay-hints.js'), /bar\.setAttribute\('data-no-scan', ''\)/)
  // Hachidori and 10ten skip it too: their scope check refuses a point inside the marker first.
  assert.match(read('host/ext/content.js'), /if \(element\?\.closest\?\.\('\[data-no-scan\]'\)\) return false/)
})

test("a document that never sets a scope keeps Yomitan's default of scanning everything", async () => {
  const { Frontend } = await loadFrontendMode()
  const frontend = new Frontend()
  await frontend.prepare()
  assert.equal(frontend._textScanner.includeSelector, null)
})

// --- Who sets the scope, and who carries the marker. ----------------------------------------

test('only the panel relay scopes its scanner, to the marker the Log lines carry', () => {
  const relay = read('ui/panel-yomitan.js')
  assert.match(relay, /export const SCAN_SELECTOR = '\[data-yomitan-scan\]'/)
  assert.match(relay, /^setScanScope\(SCAN_SELECTOR\)$/m)
  // The windows whose scanning must stay as it was never narrow it.
  for (const path of [
    'ui/overlay.js',
    'ui/popup-host.js',
    'ui/api-lookup.js',
    'host/yomitan/overlay.js',
    'host/yomitan/panel.js',
    'host/yomitan/common.js'
  ]) {
    assert.doesNotMatch(read(path), /setScanScope|includeSelector/, path)
  }
})

test('every form of a transcript line carries the marker', () => {
  const row = read('frontend/texthooker/components/LineRow.tsx')
  assert.match(row, /const groupProps = \{\s*["']data-yomitan-scan["']: ["']["'],/)
  // The row being edited holds a text box, which lookups leave alone: it alone has no marker.
  const rows = row.match(/className="line(?! line-editing)[ "]/g) ?? []
  const spreads = row.match(/\{\.\.\.groupProps\}/g) ?? []
  assert.ok(rows.length >= 4, 'LineRow renders its row forms')
  assert.equal(spreads.length, rows.length, 'each .line row spreads groupProps')
  const editing = row.match(/<div\s+className=\{`line line-editing[\s\S]*?\n\s*>/)?.[0]
  assert.ok(editing, 'the editing row is there')
  assert.ok(!/groupProps|data-yomitan-scan/.test(editing), 'the editing row has no marker')
})

test('the vendored seams the scope relies on are still there', () => {
  assert.match(read('extensions/yomitan/js/app/frontend.js'), /this\._textScanner = new TextScanner\(/)
  const scanner = read('extensions/yomitan/js/language/text-scanner.js')
  assert.match(scanner, /set includeSelector\(value\) \{\s*this\._includeSelector = value;/)
  assert.match(scanner, /const includeSelector = this\._includeSelector;/)
})
