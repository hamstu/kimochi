import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from './load.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

const {
  actionLabel,
  barPercent,
  checkedLine,
  downloadProgress,
  isIndeterminate,
  isPrimaryAction,
  noticeDetail,
  noticeShown,
  noticeTitle,
  normalizeUpdateStatus,
  relativeTime,
  releaseUrl,
  showsBar,
  updateActions,
  updateInPlay
} = await load('update.ts')

const NOW = Date.parse('2026-10-13T10:00:00Z')
const base = {
  state: 'none',
  currentVersion: '0.1.0',
  version: null,
  notes: null,
  date: null,
  size: null,
  receivedBytes: null,
  totalBytes: null,
  message: null,
  stage: null,
  checkedAt: NOW - 4 * 60_000,
  dismissed: false,
  automatic: true
}
const offered = (patch) => ({ ...base, version: '0.2.0', size: 91_300_000, ...patch })

test('normalizes the native payload and rejects anything else', () => {
  assert.equal(normalizeUpdateStatus(null), null)
  assert.equal(normalizeUpdateStatus({ state: 'nope', currentVersion: '0.1.0' }), null)
  assert.equal(normalizeUpdateStatus({ state: 'none' }), null, 'the current version is required')
  const status = normalizeUpdateStatus({
    state: 'failed',
    currentVersion: '0.1.0',
    version: '0.2.0',
    stage: 'download',
    message: 'boom',
    receivedBytes: -1,
    checkedAt: 12,
    dismissed: true,
    automatic: 'yes'
  })
  assert.deepEqual(status, {
    ...base,
    state: 'failed',
    version: '0.2.0',
    stage: 'download',
    message: 'boom',
    checkedAt: 12,
    dismissed: true,
    automatic: false
  })
  assert.equal(normalizeUpdateStatus({ state: 'none', currentVersion: '0.1.0', stage: 'x' }).stage, null)
})

test('relative times read like a person says them', () => {
  assert.equal(relativeTime(NOW - 20_000, NOW), 'just now')
  assert.equal(relativeTime(NOW - 60_000, NOW), '1 minute ago')
  assert.equal(relativeTime(NOW - 4 * 60_000, NOW), '4 minutes ago')
  assert.equal(relativeTime(NOW - 3 * 3_600_000, NOW), '3 hours ago')
  assert.equal(relativeTime(NOW - 26 * 3_600_000, NOW), 'yesterday')
  assert.equal(relativeTime(NOW - 5 * 86_400_000, NOW), '5 days ago')
  assert.equal(relativeTime(NOW + 60_000, NOW), 'just now', 'a clock skew never reads as the future')
})

test('the sidebar notice shows for an update in play, and goes away on Not now', () => {
  assert.equal(noticeShown(null), false)
  assert.equal(noticeShown(base), false)
  assert.equal(noticeShown({ ...base, state: 'checking' }), false)
  assert.equal(noticeShown({ ...base, state: 'failed', stage: 'check', message: 'offline' }), false, 'a failed check only concerns the Check button')
  assert.equal(noticeShown(offered({ state: 'available' })), true)
  assert.equal(noticeShown(offered({ state: 'available', dismissed: true })), false)
  assert.equal(noticeShown(offered({ state: 'downloading', dismissed: true })), true, 'a download the user started is never hidden')
  assert.equal(noticeShown(offered({ state: 'ready', dismissed: true })), true)
  assert.equal(noticeShown(offered({ state: 'installing' })), true)
  assert.equal(noticeShown(offered({ state: 'failed', stage: 'download' })), true)
  assert.equal(noticeShown(offered({ state: 'failed', stage: 'download', dismissed: true })), false)
  assert.equal(updateInPlay(offered({ state: 'failed', stage: 'install' })), true)
})

test('the notice says what is happening and what comes next', () => {
  assert.equal(noticeTitle(offered({ state: 'available' })), 'Kimochi 0.2.0 is available')
  assert.equal(noticeDetail(offered({ state: 'available' })), '91 MB download')
  assert.equal(noticeDetail(offered({ state: 'available', size: null })), null)
  assert.equal(noticeTitle(offered({ state: 'downloading', receivedBytes: 12_000_000, totalBytes: 91_300_000 })), 'Downloading Kimochi 0.2.0')
  assert.equal(noticeDetail(offered({ state: 'downloading', receivedBytes: 12_000_000, totalBytes: 91_300_000 })), '12 MB of 91 MB')
  assert.equal(noticeTitle(offered({ state: 'ready' })), 'Kimochi 0.2.0 is ready')
  assert.equal(noticeDetail(offered({ state: 'ready' })), 'Restart Kimochi to finish updating.')
  assert.equal(noticeTitle(offered({ state: 'installing' })), 'Installing Kimochi 0.2.0…')
  assert.equal(noticeTitle(offered({ state: 'failed', stage: 'download', message: 'Network error' })), 'Download failed')
  assert.equal(noticeDetail(offered({ state: 'failed', stage: 'download', message: 'Network error' })), 'Network error')
  assert.equal(noticeTitle(offered({ state: 'failed', stage: 'install' })), 'Could not install the update')
  assert.equal(noticeTitle(offered({ state: 'available', version: null })), 'A new version is available')
})

test('download progress copes with an unknown total', () => {
  assert.equal(downloadProgress(offered({ state: 'downloading', receivedBytes: 5_000_000, totalBytes: null, size: null })), '5.0 MB')
  assert.equal(downloadProgress(offered({ state: 'downloading', receivedBytes: 5_000_000, totalBytes: null })), '5.0 MB of 91 MB', 'the manifest size stands in')
})

test('the settings line reads the last check or the step under way', () => {
  assert.equal(checkedLine(base, NOW), "You're up to date · checked 4 minutes ago")
  assert.equal(checkedLine({ ...base, checkedAt: null }, NOW), "You're up to date")
  assert.equal(checkedLine({ ...base, state: 'checking' }, NOW), 'Checking for updates…')
  assert.equal(checkedLine({ ...base, state: 'idle', checkedAt: null }, NOW), 'Kimochi checks for updates on its own and asks before installing one.')
  assert.equal(checkedLine({ ...base, state: 'idle', checkedAt: null, automatic: false }, NOW), 'This development build does not check on its own.')
  assert.equal(checkedLine(offered({ state: 'available' }), NOW), 'Kimochi 0.2.0 is available.')
  assert.equal(checkedLine(offered({ state: 'downloading', receivedBytes: 45_650_000, totalBytes: 91_300_000 }), NOW), 'Downloading Kimochi 0.2.0 · 46 MB of 91 MB')
  assert.equal(checkedLine(offered({ state: 'ready' }), NOW), 'Kimochi 0.2.0 is downloaded. Restart Kimochi to finish updating.')
  assert.equal(checkedLine(offered({ state: 'installing' }), NOW), 'Installing Kimochi 0.2.0… Kimochi restarts when this is done.')
  assert.equal(checkedLine({ ...base, state: 'failed', stage: 'check', message: 'Could not reach GitHub.' }, NOW), 'Could not check for updates: Could not reach GitHub.')
  assert.equal(checkedLine(offered({ state: 'failed', stage: 'download' }), NOW), 'Download failed.')
  assert.equal(checkedLine(offered({ state: 'failed', stage: 'install', message: 'denied' }), NOW), 'Could not install the update: denied')
})

test('one button per state: the next step, or a way out', () => {
  assert.deepEqual(updateActions({ ...base, state: 'idle' }), ['check'])
  assert.deepEqual(updateActions(base), ['check'])
  assert.deepEqual(updateActions({ ...base, state: 'checking' }), [])
  assert.deepEqual(updateActions(offered({ state: 'available' })), ['download'])
  assert.deepEqual(updateActions(offered({ state: 'downloading' })), ['cancel'])
  assert.deepEqual(updateActions(offered({ state: 'ready' })), ['install'])
  assert.deepEqual(updateActions(offered({ state: 'installing' })), [])
  assert.deepEqual(updateActions({ ...base, state: 'failed', stage: 'check' }), ['check'])
  assert.deepEqual(updateActions(offered({ state: 'failed', stage: 'download' })), ['retry'])
  assert.deepEqual(updateActions(offered({ state: 'failed', stage: 'install' })), ['retry'])
  assert.equal(actionLabel('download', offered({ state: 'available' })), 'Download (91 MB)')
  assert.equal(actionLabel('download', offered({ state: 'available', size: null })), 'Download')
  assert.equal(actionLabel('install', offered({ state: 'ready' })), 'Restart to update')
  assert.equal(actionLabel('check', base), 'Check for updates')
  assert.equal(actionLabel('dismiss', base), 'Not now')
  assert.deepEqual(['download', 'install', 'retry'].map(isPrimaryAction), [true, true, true])
  assert.deepEqual(['check', 'cancel', 'dismiss'].map(isPrimaryAction), [false, false, false])
})

test('the bar only speaks while something happens', () => {
  assert.equal(showsBar(offered({ state: 'available' })), false)
  assert.equal(showsBar(offered({ state: 'ready' })), false)
  assert.equal(showsBar(offered({ state: 'downloading' })), true)
  assert.equal(showsBar(offered({ state: 'installing' })), true)
  assert.equal(barPercent(offered({ state: 'downloading', receivedBytes: 45_650_000, totalBytes: 91_300_000 })), 50)
  assert.equal(barPercent(offered({ state: 'downloading', receivedBytes: 91_299_999, totalBytes: 91_300_000 })), 99, '100% only ever means done')
  assert.equal(barPercent(offered({ state: 'downloading', receivedBytes: 1, totalBytes: null, size: null })), 0)
  assert.equal(barPercent(offered({ state: 'ready' })), 100)
  assert.equal(barPercent(offered({ state: 'installing' })), 100)
  assert.equal(isIndeterminate(offered({ state: 'installing' })), true)
  assert.equal(isIndeterminate(offered({ state: 'downloading', totalBytes: null, size: null })), true)
  assert.equal(isIndeterminate(offered({ state: 'downloading', totalBytes: null })), false, 'the manifest size makes the bar measurable')
})

test('What\'s new points at the tagged release', () => {
  assert.equal(releaseUrl('hamstu/kimochi-tauri', offered({ state: 'available' })), 'https://github.com/hamstu/kimochi-tauri/releases/tag/v0.2.0')
  assert.equal(releaseUrl('hamstu/kimochi-tauri', base), null)
})

test('the configured endpoint, the settings link and the release script agree on the repository', async () => {
  const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  const [endpoint] = config.plugins.updater.endpoints
  const repo = endpoint.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\/latest\.json$/)?.[1]
  assert.ok(repo, `the endpoint must be the latest release's latest.json: ${endpoint}`)
  assert.ok(config.plugins.updater.pubkey.length > 40, 'the minisign public key is set')
  const section = await readFile(path.join(root, 'frontend/panels/settings/UpdatesSection.tsx'), 'utf8')
  assert.ok(section.includes(`'${repo}'`), 'Settings → Updates opens the same repository')
})
