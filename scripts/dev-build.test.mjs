import assert from 'node:assert/strict'
import test from 'node:test'
import { PLATFORMS, contentType, folderName, safeName } from './dev-build.mjs'

test('a development build is named by its date, branch and commit', () => {
  const date = new Date('2026-11-19T22:30:00Z')
  assert.equal(
    folderName(date, 'texthook-old-wine-flatpak', '723ef0445054b415'),
    '2026-11-19-texthook-old-wine-flatpak-723ef04'
  )
  assert.equal(
    folderName(date, 'claude/Faster game_pause!', 'abcdef1234'),
    '2026-11-19-claude-faster-game-pause-abcdef1'
  )
  assert.ok(safeName(folderName(date, 'x'.repeat(200), 'abcdef1234')))
})

test('only safe folder names are taken', () => {
  assert.ok(safeName('deck-wine8'))
  assert.ok(!safeName('../app'))
  assert.ok(!safeName('a/b'))
  assert.ok(!safeName(''))
})

test('each platform picks its bundle and nothing else', () => {
  assert.ok(PLATFORMS['linux-x64'].files.test('Kimochi_1.1.0_amd64.AppImage'))
  assert.ok(PLATFORMS['linux-x64'].files.test('Kimochi_1.1.0_amd64.deb'))
  assert.ok(!PLATFORMS['linux-x64'].files.test('Kimochi_1.1.0_amd64.AppImage.sig'))
  assert.ok(PLATFORMS['windows-x64'].files.test('Kimochi_1.1.0_x64-setup.exe'))
  assert.ok(PLATFORMS.macos.files.test('Kimochi.app.zip'))
  assert.equal(contentType('Kimochi.AppImage'), 'application/vnd.appimage')
})
