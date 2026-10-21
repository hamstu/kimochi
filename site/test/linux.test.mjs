import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LINUX_GUIDE_PATH,
  LINUX_SECTIONS,
  aptInstallCommand,
  appImageRunCommand,
  installCommand,
  linuxAsset,
  linuxSectionFromHash,
  primaryDownloadHref
} from '../src/lib/linux.js'

const a = (name) => ({
  name,
  size: 1,
  browser_download_url: `https://example.test/${name}`
})

const TAGGED = [
  a('kimochi_0.2.0_amd64.deb'),
  a('kimochi_0.2.0_arm64.deb'),
  a('kimochi_0.2.0_amd64.AppImage'),
  a('kimochi_0.2.0_aarch64.AppImage'),
  a('kimochi_0.2.0_arm64-arch.deb'),
  a('kimochi_0.2.0_aarch64-arch.AppImage'),
  a('kimochi_0.2.0_amd64.AppImage.sig'),
  a('Kimochi_0.2.0_x64-setup.exe')
]

test('the hash picks a section, with friendly aliases', () => {
  assert.deepEqual(LINUX_SECTIONS, ['steam-deck', 'debian', 'other'])
  assert.equal(linuxSectionFromHash('#steam-deck'), 'steam-deck')
  assert.equal(linuxSectionFromHash('#SteamDeck'), 'steam-deck')
  assert.equal(linuxSectionFromHash('#debian'), 'debian')
  assert.equal(linuxSectionFromHash('#ubuntu'), 'debian')
  assert.equal(linuxSectionFromHash('#pop-os'), 'debian')
  assert.equal(linuxSectionFromHash('#other'), 'other')
  assert.equal(linuxSectionFromHash('#fedora'), 'other')
  assert.equal(linuxSectionFromHash('#arch'), 'other')
  assert.equal(linuxSectionFromHash('other'), 'other')
})

test('an empty, unknown or malformed hash is no section', () => {
  assert.equal(linuxSectionFromHash(''), null)
  assert.equal(linuxSectionFromHash(undefined), null)
  assert.equal(linuxSectionFromHash('#updating'), null)
  assert.equal(linuxSectionFromHash('#toString'), null)
  assert.equal(linuxSectionFromHash('#%E0%A4%A'), null)
})

test('the installer command is built from the origin', () => {
  assert.equal(installCommand('https://kimochi.example'), 'curl -fsSL https://kimochi.example/install.sh | sh')
  assert.equal(installCommand('http://127.0.0.1:1450/'), 'curl -fsSL http://127.0.0.1:1450/install.sh | sh')
  assert.equal(
    installCommand('https://kimochi.example', { uninstall: true }),
    'curl -fsSL https://kimochi.example/install.sh | sh -s -- --uninstall'
  )
  assert.equal(
    installCommand('https://kimochi.example', { noLaunch: true }),
    'curl -fsSL https://kimochi.example/install.sh | sh -s -- --no-launch'
  )
})

test('apt and AppImage commands use the real file name, or a glob', () => {
  assert.equal(aptInstallCommand('kimochi_0.2.0_amd64.deb'), 'sudo apt install ./kimochi_0.2.0_amd64.deb')
  assert.equal(aptInstallCommand(null), 'sudo apt install ./[Kk]imochi_*.deb')
  assert.equal(aptInstallCommand('evil; rm -rf ~.deb'), 'sudo apt install ./[Kk]imochi_*.deb')
  assert.equal(
    appImageRunCommand('Kimochi_amd64.AppImage'),
    'chmod +x ./Kimochi_amd64.AppImage && ./Kimochi_amd64.AppImage'
  )
  assert.equal(appImageRunCommand(undefined), 'chmod +x ./[Kk]imochi_*.AppImage && ./[Kk]imochi_*.AppImage')
})

test('linuxAsset picks the generic build for the CPU, x64 when unknown', () => {
  const pick = (format, arch, assets = TAGGED) => linuxAsset(assets, format, arch)?.name ?? null
  assert.equal(pick('deb', 'x64'), 'kimochi_0.2.0_amd64.deb')
  assert.equal(pick('deb', 'arm64'), 'kimochi_0.2.0_arm64.deb')
  assert.equal(pick('deb', 'unknown'), 'kimochi_0.2.0_amd64.deb')
  assert.equal(pick('AppImage', 'x64'), 'kimochi_0.2.0_amd64.AppImage')
  assert.equal(pick('AppImage', 'arm64'), 'kimochi_0.2.0_aarch64.AppImage')
  // Only the Arch build exists: still offered.
  assert.equal(
    pick('AppImage', 'arm64', [a('kimochi_0.2.0_aarch64-arch.AppImage')]),
    'kimochi_0.2.0_aarch64-arch.AppImage'
  )
  // The nightly's names.
  assert.equal(pick('deb', 'x64', [a('Kimochi_arm64.deb'), a('Kimochi_amd64.deb')]), 'Kimochi_amd64.deb')
  assert.equal(pick('deb', 'x64', [a('Kimochi_arm64.deb')]), null)
  assert.equal(pick('deb', 'x64', []), null)
})

test('the main download button sends Linux visitors to the guide', () => {
  assert.equal(primaryDownloadHref('linux', 'https://example.test/k.AppImage', 'https://r'), LINUX_GUIDE_PATH)
  assert.equal(primaryDownloadHref('linux', null, 'https://r'), '/download/linux')
  assert.equal(
    primaryDownloadHref('macos', 'https://example.test/k.app.zip', 'https://r'),
    'https://example.test/k.app.zip'
  )
  assert.equal(primaryDownloadHref('windows', null, 'https://r'), 'https://r')
  assert.equal(primaryDownloadHref('unknown', null, 'https://r'), 'https://r')
})
