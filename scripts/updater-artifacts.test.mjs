import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { manifest, plan, platformKeys } from './updater-artifacts.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

test('every CI target maps to the keys the updater looks up', () => {
  assert.deepEqual(platformKeys('aarch64-apple-darwin'), [{ key: 'darwin-aarch64', bundle: 'app' }])
  assert.deepEqual(platformKeys('x86_64-pc-windows-msvc'), [{ key: 'windows-x86_64', bundle: 'nsis' }])
  assert.deepEqual(platformKeys('aarch64-pc-windows-msvc'), [{ key: 'windows-aarch64', bundle: 'nsis' }])
  assert.deepEqual(platformKeys('x86_64-unknown-linux-gnu'), [
    { key: 'linux-x86_64', bundle: 'appimage' },
    { key: 'linux-x86_64-deb', bundle: 'deb' }
  ])
  assert.deepEqual(platformKeys('aarch64-unknown-linux-gnu'), [
    { key: 'linux-aarch64', bundle: 'appimage' },
    { key: 'linux-aarch64-deb', bundle: 'deb' }
  ])
  assert.throws(() => platformKeys('wasm32-unknown-unknown'), /unsupported target/)
})

test('the plan names the file the app downloads for each key', () => {
  const mac = plan('aarch64-apple-darwin', '0.2.0', ['macos/Kimochi.app', 'macos/Kimochi.app.zip'])
  assert.deepEqual(mac, [
    { key: 'darwin-aarch64', bundle: 'app', source: 'macos/Kimochi.app', asset: 'Kimochi_0.2.0_aarch64.app.tar.gz', archive: true }
  ])
  const win = plan('x86_64-pc-windows-msvc', '0.2.0', ['nsis/Kimochi_0.2.0_x64-setup.exe', 'nsis/Kimochi_0.2.0_x64-setup.exe.sig'])
  assert.deepEqual(win, [
    { key: 'windows-x86_64', bundle: 'nsis', source: 'nsis/Kimochi_0.2.0_x64-setup.exe', asset: 'Kimochi_0.2.0_x64-setup.exe', archive: false }
  ])
  const linux = plan('x86_64-unknown-linux-gnu', '0.2.0', [
    'appimage/Kimochi_0.2.0_amd64.AppImage',
    'appimage/Kimochi_0.2.0_amd64-gaming-mode.tar.gz',
    'appimage/Kimochi.AppDir/AppRun',
    'deb/Kimochi_0.2.0_amd64.deb'
  ])
  assert.deepEqual(linux, [
    { key: 'linux-x86_64', bundle: 'appimage', source: 'appimage/Kimochi_0.2.0_amd64.AppImage', asset: 'Kimochi_0.2.0_amd64.AppImage', archive: false },
    { key: 'linux-x86_64-deb', bundle: 'deb', source: 'deb/Kimochi_0.2.0_amd64.deb', asset: 'Kimochi_0.2.0_amd64.deb', archive: false }
  ])
  assert.throws(
    () => plan('x86_64-pc-windows-msvc', '0.2.0', ['nsis/Kimochi_0.2.0_x64-setup.exe', 'nsis/Kimochi_0.2.0_x64-setup.exe']),
    /expected one Kimochi_0\.2\.0_\*-setup\.exe in nsis\/, found 2/
  )
  assert.throws(() => plan('aarch64-apple-darwin', '0.2.0', []), /expected one Kimochi\.app in macos\/, found 0/)
})

test('a stale bundle of another name or version beside this build is left alone', () => {
  const mac = plan('aarch64-apple-darwin', '0.2.0', ['macos/Kimochi Next POC.app', 'macos/Kimochi.app'])
  assert.equal(mac[0].source, 'macos/Kimochi.app')
  const win = plan('x86_64-pc-windows-msvc', '0.2.0', ['nsis/Kimochi_0.1.0_x64-setup.exe', 'nsis/Kimochi_0.2.0_x64-setup.exe'])
  assert.equal(win[0].asset, 'Kimochi_0.2.0_x64-setup.exe')
  const named = plan('x86_64-unknown-linux-gnu', '1.0.0', ['appimage/Kimochi Beta_1.0.0_amd64.AppImage', 'deb/Kimochi Beta_1.0.0_amd64.deb'], 'Kimochi Beta')
  assert.equal(named[0].asset, 'Kimochi Beta_1.0.0_amd64.AppImage')
  assert.equal(named[1].asset, 'Kimochi Beta_1.0.0_amd64.deb')
  assert.throws(() => plan('x86_64-pc-windows-msvc', '0.2.0', ['nsis/Kimochi_0.1.0_x64-setup.exe']), /found 0/, 'an old version is not this build')
})

const sidecars = [
  { platform: 'darwin-aarch64', asset: 'Kimochi_0.2.0_aarch64.app.tar.gz', signature: 'sig-mac\n', size: 90_000_000 },
  { platform: 'windows-x86_64', asset: 'Kimochi_0.2.0_x64-setup.exe', signature: 'sig-win', size: 74_000_000 },
  { platform: 'linux-x86_64-deb', asset: 'Kimochi_0.2.0_amd64.deb', signature: 'sig-deb' }
]

test('latest.json carries a URL, a signature and the size per platform', () => {
  const document = manifest({
    version: '0.2.0',
    tag: 'v0.2.0',
    repo: 'hamstu/kimochi-tauri',
    notes: 'Self-updates.',
    date: '2026-10-13T09:00:00Z',
    sidecars
  })
  assert.deepEqual(document, {
    version: '0.2.0',
    pub_date: '2026-10-13T09:00:00Z',
    notes: 'Self-updates.',
    platforms: {
      'darwin-aarch64': {
        url: 'https://github.com/hamstu/kimochi-tauri/releases/download/v0.2.0/Kimochi_0.2.0_aarch64.app.tar.gz',
        signature: 'sig-mac',
        size: 90_000_000
      },
      'windows-x86_64': {
        url: 'https://github.com/hamstu/kimochi-tauri/releases/download/v0.2.0/Kimochi_0.2.0_x64-setup.exe',
        signature: 'sig-win',
        size: 74_000_000
      },
      'linux-x86_64-deb': {
        url: 'https://github.com/hamstu/kimochi-tauri/releases/download/v0.2.0/Kimochi_0.2.0_amd64.deb',
        signature: 'sig-deb'
      }
    }
  })
  const dated = manifest({ version: '0.2.0', tag: 'v0.2.0', repo: 'a/b', sidecars })
  assert.ok(!Number.isNaN(Date.parse(dated.pub_date)), 'a missing date is now')
  assert.equal('notes' in dated, false)
})

test('a manifest refuses a release that would never be offered or could not be verified', () => {
  const ok = { version: '0.2.0', tag: 'v0.2.0', repo: 'hamstu/kimochi-tauri', sidecars }
  assert.throws(() => manifest({ ...ok, tag: 'v0.2.1' }), /tag v0.2.1 does not match version 0.2.0/)
  assert.throws(() => manifest({ ...ok, tag: '0.2.0' }), /does not match/)
  assert.throws(() => manifest({ ...ok, version: 'nightly', tag: 'nightly' }), /not a version/)
  assert.throws(() => manifest({ ...ok, sidecars: [] }), /nothing was signed/)
  assert.throws(() => manifest({ ...ok, sidecars: [{ platform: 'darwin-aarch64', asset: 'x' }] }), /incomplete sidecar/)
  assert.throws(() => manifest({ ...ok, sidecars: [sidecars[0], sidecars[0]] }), /two sidecars/)
  assert.throws(() => manifest({ ...ok, repo: 'https://github.com/a/b' }), /owner\/name/)
})

test('CI signs in release mode and composes the manifest after every bundle', async () => {
  const ci = await readFile(`${root}.github/workflows/ci.yml`, 'utf8')
  assert.match(ci, /updater-artifacts\.mjs sign/)
  assert.match(ci, /updater-artifacts\.mjs manifest/)
  assert.match(ci, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/)
  assert.match(ci, /needs: \[plan, bundle\]/, 'the manifest waits for every platform')
})
