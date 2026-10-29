/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = new URL('../', import.meta.url)

/**
 * `frontend/bridge/tauri.ts` with its runtime imports stubbed: only the pure error parsing is
 * exercised, so neither a Tauri runtime nor React has to exist.
 */
async function loadBridge() {
  const stubs = {
    name: 'stubs',
    setup(builder) {
      builder.onResolve({ filter: /^(@tauri-apps\/|react$)/ }, (args) => ({
        path: args.path,
        namespace: 'stub'
      }))
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents:
          'export const invoke = () => Promise.reject(new Error("no runtime"));' +
          'export const emit = () => Promise.resolve(); export const listen = () => Promise.resolve(() => {});' +
          'export const useSyncExternalStore = (_s, get) => get();',
        loader: 'js'
      }))
    }
  }
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('frontend/bridge/tauri.ts', root))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    plugins: [stubs]
  })
  const code = Buffer.from(outputFiles[0].contents).toString('base64')
  return import(`data:text/javascript;base64,${code}`)
}

test('a stale system-picker source parses as pickAgain with a clean message', async () => {
  const { nativeError } = await loadBridge()
  const stale = nativeError(
    'gone: pick-again: The shared screen or window has closed. Choose it again in the system picker.'
  )
  assert.equal(stale.kind, 'gone')
  assert.equal(stale.pickAgain, true)
  assert.equal(
    stale.message,
    'The shared screen or window has closed. Choose it again in the system picker.'
  )
  const unpicked = nativeError('permission: pick-again: Choose a screen or window first.')
  assert.equal(unpicked.kind, 'permission')
  assert.equal(unpicked.pickAgain, true)
})

test('every other error keeps its kind and message and is not pickAgain', async () => {
  const { nativeError } = await loadBridge()
  assert.deepEqual(nativeError('gone: that source has closed; refresh the list and pick again'), {
    kind: 'gone',
    message: 'that source has closed; refresh the list and pick again',
    raw: 'gone: that source has closed; refresh the list and pick again',
    pickAgain: false,
    hidden: false
  })
  assert.equal(nativeError('busy: a capture is already running').pickAgain, false)
  // The tag only means something after a known prefix.
  const bare = nativeError('pick-again: nothing')
  assert.equal(bare.kind, 'unknown')
  assert.equal(bare.pickAgain, false)
})

test('the frontend tag matches the one native writes', async () => {
  const sources = await readFile(new URL('src-tauri/src/sources.rs', root), 'utf8')
  const bridge = await readFile(new URL('frontend/bridge/tauri.ts', root), 'utf8')
  const native = sources.match(/pub const PICK_AGAIN: &str = "([^"]+)";/)
  const ui = bridge.match(/const PICK_AGAIN = '([^']+)'/)
  assert.ok(native && ui, 'PICK_AGAIN must be declared on both sides')
  assert.equal(ui[1], `${native[1]}:`)
})

test('a window that is only out of view parses as hidden with a clean message', async () => {
  const { nativeError } = await loadBridge()
  const minimised = nativeError('gone: hidden: Window is minimized; restore it before capturing.')
  assert.equal(minimised.kind, 'gone')
  assert.equal(minimised.hidden, true)
  assert.equal(minimised.pickAgain, false)
  assert.equal(minimised.message, 'Window is minimized; restore it before capturing.')
  assert.equal(nativeError('gone: that source has closed').hidden, false)
})

test('the frontend hidden tag matches the one native writes', async () => {
  const sources = await readFile(new URL('src-tauri/src/sources.rs', root), 'utf8')
  const bridge = await readFile(new URL('frontend/bridge/tauri.ts', root), 'utf8')
  const autoscan = await readFile(new URL('ui/autoscan.ts', root), 'utf8')
  const native = sources.match(/pub const HIDDEN: &str = "([^"]+)";/)
  const ui = bridge.match(/const HIDDEN = '([^']+)'/)
  assert.ok(native && ui, 'HIDDEN must be declared on both sides')
  assert.equal(ui[1], `${native[1]}:`)
  assert.ok(autoscan.includes(String.raw`/^gone:\s*${native[1]}:/`), 'autoscan recognises the same tag')
})
