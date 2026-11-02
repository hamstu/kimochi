import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transform } from 'esbuild'
import { readFile } from 'node:fs/promises'
const { code } = await transform(await readFile(new URL('../ui/desktop-point.ts', import.meta.url), 'utf8'), {
  loader: 'ts',
  format: 'esm'
})
const { desktopPointOf, screenScale } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))

const withPlatform = (platform, run) => {
  const fake = { __KIMOCHI_PLATFORM__: platform }
  fake.top = fake
  globalThis.window = fake
  try {
    run()
  } finally {
    delete globalThis.window
  }
}

test('without a factor from native, screen coordinates are desktop points', () => {
  withPlatform(undefined, () => assert.equal(screenScale(), 1))
  withPlatform({ os: 'macos' }, () => {
    assert.deepEqual(desktopPointOf({ screenX: 300, screenY: 200, isTrusted: true }), { x: 300, y: 200 })
  })
})

test("a trusted event's screen coordinates are scaled by the factor native reported", () => {
  // The reader's case: Windows Text size 150 % on a 100 % display, WebView2 at 1.5.
  withPlatform({ os: 'windows', screenScale: 1.5 }, () => {
    assert.deepEqual(desktopPointOf({ screenX: 245, screenY: 94, isTrusted: true }), { x: 367.5, y: 141 })
    // An event without the flag (a plain object, an old browser) is taken as the real pointer.
    assert.deepEqual(desktopPointOf({ screenX: 10, screenY: 10 }), { x: 15, y: 15 })
  })
})

test('a replayed event already carries desktop points and is left alone', () => {
  withPlatform({ os: 'windows', screenScale: 1.5 }, () => {
    assert.deepEqual(desktopPointOf({ screenX: 368, screenY: 141, isTrusted: false }), { x: 368, y: 141 })
  })
})

test('a nonsense factor counts as none', () => {
  for (const bad of [0, -1, NaN, Infinity, '1.5', null]) {
    withPlatform({ os: 'windows', screenScale: bad }, () => assert.equal(screenScale(), 1))
  }
})

test('a same-origin frame reads the top page’s factor', () => {
  const top = { __KIMOCHI_PLATFORM__: { os: 'windows', screenScale: 1.25 } }
  top.top = top
  const frame = { __KIMOCHI_PLATFORM__: { os: 'windows' }, top }
  globalThis.window = frame
  try {
    assert.equal(screenScale(), 1.25)
  } finally {
    delete globalThis.window
  }
})
