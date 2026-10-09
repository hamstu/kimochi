import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickAsset,
  classifyAsset,
  detectPlatformFromUA,
  platformFromClientHints,
  assetLabel,
  formatBytes
} from '../src/lib/assets.js'

const a = (name, size = 1) => ({ name, size, browser_download_url: `https://example.test/${name}` })

// Mirrors .github/workflows/ci.yml "Upload to release". A tagged release keeps tauri's versioned
// names; `-arch` before the extension marks the Arch Linux runner's build.
const TAGGED = [
  a('Kimochi_0.2.0_aarch64.app.zip'),
  a('Kimochi_0.2.0_x64-setup.exe'),
  a('Kimochi_0.2.0_arm64-setup.exe'),
  a('kimochi_0.2.0_amd64.deb'),
  a('kimochi_0.2.0_arm64.deb'),
  a('kimochi_0.2.0_amd64.AppImage'),
  a('kimochi_0.2.0_aarch64.AppImage'),
  a('kimochi_0.2.0_arm64-arch.deb'),
  a('kimochi_0.2.0_aarch64-arch.AppImage'),
  a('Kimochi.app.tar.gz.sig'),
  a('latest.json')
]

// The rolling `nightly` pre-release: the same names without `_<ver>`. The first five are the assets
// it carried on 2026-10-09; the x64 Linux and Arch ones are what those runners would add.
const NIGHTLY = [
  a('Kimochi_aarch64.app.zip'),
  a('Kimochi_aarch64.AppImage'),
  a('Kimochi_arm64-setup.exe'),
  a('Kimochi_arm64.deb'),
  a('Kimochi_x64-setup.exe'),
  a('Kimochi_amd64.deb'),
  a('Kimochi_amd64.AppImage'),
  a('Kimochi_aarch64-arch.AppImage')
]

const pick = (os, arch, assets = TAGGED) => pickAsset(assets, { os, arch })?.name ?? null

test('macOS picks the Apple silicon app zip, whatever the detected arch', () => {
  assert.equal(pick('macos', 'arm64'), 'Kimochi_0.2.0_aarch64.app.zip')
  assert.equal(pick('macos', 'unknown'), 'Kimochi_0.2.0_aarch64.app.zip')
  assert.equal(pick('macos', 'x64'), null, 'no Intel build')
  assert.equal(pick('macos', 'unknown', NIGHTLY), 'Kimochi_aarch64.app.zip')
})

test('macOS prefers a dmg over the app zip when both exist', () => {
  const assets = [...TAGGED, a('Kimochi_0.2.0_aarch64.dmg')]
  assert.equal(pick('macos', 'arm64', assets), 'Kimochi_0.2.0_aarch64.dmg')
})

test('a universal (arch-less) asset matches any arch, after exact matches', () => {
  const assets = [a('Kimochi_0.2.0_universal.dmg')]
  assert.equal(pick('macos', 'x64', assets), 'Kimochi_0.2.0_universal.dmg')
  assert.equal(pick('macos', 'arm64', [...assets, a('Kimochi_0.2.0_aarch64.dmg')]), 'Kimochi_0.2.0_aarch64.dmg')
})

test('Windows picks the setup exe for the arch, x64 when unknown', () => {
  assert.equal(pick('windows', 'x64'), 'Kimochi_0.2.0_x64-setup.exe')
  assert.equal(pick('windows', 'arm64'), 'Kimochi_0.2.0_arm64-setup.exe')
  assert.equal(pick('windows', 'unknown'), 'Kimochi_0.2.0_x64-setup.exe')
  assert.equal(pick('windows', 'x64', NIGHTLY), 'Kimochi_x64-setup.exe')
  assert.equal(pick('windows', 'arm64', NIGHTLY), 'Kimochi_arm64-setup.exe')
})

test('Linux prefers the generic AppImage over deb', () => {
  assert.equal(pick('linux', 'x64'), 'kimochi_0.2.0_amd64.AppImage')
  assert.equal(pick('linux', 'arm64'), 'kimochi_0.2.0_aarch64.AppImage')
  assert.equal(pick('linux', 'unknown'), 'kimochi_0.2.0_amd64.AppImage')
  assert.equal(pick('linux', 'arm64', NIGHTLY), 'Kimochi_aarch64.AppImage')
  assert.equal(pick('linux', 'x64', NIGHTLY), 'Kimochi_amd64.AppImage')
})

test('the Arch Linux build ranks after every generic build, even a deb', () => {
  const noAppImage = TAGGED.filter((x) => !x.name.endsWith('.AppImage') || x.name.includes('-arch'))
  assert.equal(pick('linux', 'arm64', noAppImage), 'kimochi_0.2.0_arm64.deb')
  const archOnly = [a('kimochi_0.2.0_arm64-arch.deb'), a('kimochi_0.2.0_aarch64-arch.AppImage')]
  assert.equal(pick('linux', 'arm64', archOnly), 'kimochi_0.2.0_aarch64-arch.AppImage')
})

test('Linux falls back to deb when there is no AppImage', () => {
  const assets = TAGGED.filter((x) => !x.name.endsWith('.AppImage'))
  assert.equal(pick('linux', 'x64', assets), 'kimochi_0.2.0_amd64.deb')
})

test('older <rust-target>-<bundle> names still work', () => {
  const assets = [
    a('aarch64-apple-darwin-Kimochi.app.zip'),
    a('aarch64-pc-windows-msvc-Kimochi_0.1.0_arm64-setup.exe'),
    a('x86_64-unknown-linux-gnu-Kimochi_0.1.0_amd64.AppImage')
  ]
  assert.equal(pick('macos', 'arm64', assets), 'aarch64-apple-darwin-Kimochi.app.zip')
  assert.equal(pick('windows', 'arm64', assets), 'aarch64-pc-windows-msvc-Kimochi_0.1.0_arm64-setup.exe')
  assert.equal(pick('linux', 'x64', assets), 'x86_64-unknown-linux-gnu-Kimochi_0.1.0_amd64.AppImage')
})

test('unknown OS and empty lists return null', () => {
  assert.equal(pick('unknown', 'x64'), null)
  assert.equal(pick('linux', 'x64', []), null)
})

test('classifyAsset ignores non-installers and spots the Arch variant', () => {
  assert.equal(classifyAsset('latest.json'), null)
  assert.equal(classifyAsset('Kimochi.app.tar.gz.sig'), null)
  assert.deepEqual(classifyAsset('kimochi_0.2.0_aarch64-arch.AppImage'), {
    os: 'linux',
    arch: 'arm64',
    format: 'AppImage',
    rank: 0,
    variant: 'arch'
  })
  assert.equal(classifyAsset('kimochi_0.2.0_aarch64.AppImage').variant, null)
  assert.equal(classifyAsset('Kimochi_aarch64-arch.AppImage').variant, 'arch')
  assert.equal(classifyAsset('Kimochi_aarch64.app.zip').os, 'macos')
})

test('detectPlatformFromUA', () => {
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
  assert.deepEqual(detectPlatformFromUA(mac, 'MacIntel'), { os: 'macos', arch: 'unknown' })
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
  assert.deepEqual(detectPlatformFromUA(win, 'Win32'), { os: 'windows', arch: 'x64' })
  const linuxArm = 'Mozilla/5.0 (X11; Linux aarch64; rv:130.0) Gecko/20100101 Firefox/130.0'
  assert.deepEqual(detectPlatformFromUA(linuxArm), { os: 'linux', arch: 'arm64' })
  const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
  assert.deepEqual(detectPlatformFromUA(linux), { os: 'linux', arch: 'x64' })
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
  assert.equal(detectPlatformFromUA(android).os, 'unknown')
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
  assert.equal(detectPlatformFromUA(iphone).os, 'unknown')
})

test('platformFromClientHints', () => {
  assert.deepEqual(platformFromClientHints('macOS', 'arm', '64'), { os: 'macos', arch: 'arm64' })
  assert.deepEqual(platformFromClientHints('Windows', 'x86', '64'), { os: 'windows', arch: 'x64' })
  assert.deepEqual(platformFromClientHints('Windows', 'arm', '64'), { os: 'windows', arch: 'arm64' })
  assert.deepEqual(platformFromClientHints('Linux', '', ''), { os: 'linux', arch: 'unknown' })
  assert.deepEqual(platformFromClientHints('Chrome OS', 'x86', '64'), { os: 'unknown', arch: 'x64' })
})

test('labels and sizes', () => {
  assert.equal(assetLabel('Kimochi_0.2.0_aarch64.app.zip'), 'macOS · Apple silicon · .app.zip')
  assert.equal(assetLabel('Kimochi_arm64-setup.exe'), 'Windows · ARM64 · .exe')
  assert.equal(assetLabel('kimochi_0.2.0_aarch64-arch.AppImage'), 'Linux · ARM64 · Arch Linux · .AppImage')
  assert.equal(formatBytes(48_234_567), '48.2 MB')
  assert.equal(formatBytes(900), '900 B')
  assert.equal(formatBytes(0), '')
})
