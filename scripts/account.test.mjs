/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
// Kimochi accounts as the panels see them (ui/account.ts): who translates a line, the usage
// meters, the accounts list and Sync on Settings → Account.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load } from './load.mjs'

const {
  translationRoute,
  translationAvailable,
  usageRows,
  resetLine,
  shortDate,
  normalizeStatus,
  activeAccount,
  accountLines,
  accountInitial
} = await load('account.ts')
const { lastSyncLine, syncStateLine, normalizeSyncStatus, conflictTitle, logLine, logText, appendLog } =
  await load('sync.ts')

test('automatic translation is Kimochi cloud while signed in, otherwise the DeepL key', () => {
  assert.equal(translationRoute('auto', '', true), 'kimochi')
  assert.equal(translationRoute('auto', 'key:fx', true), 'kimochi')
  assert.equal(translationRoute('auto', 'key:fx', false), 'deepl')
  assert.equal(translationRoute('auto', '   ', false), null)
  assert.equal(translationRoute(undefined, 'key', false), 'deepl', 'settings from before the option')
})

test('a chosen provider is never swapped for the other one', () => {
  assert.equal(translationRoute('deepl', 'key', true), 'deepl')
  assert.equal(translationRoute('deepl', '', true), null)
  assert.equal(translationRoute('kimochi', 'key', false), null)
  assert.equal(translationRoute('kimochi', '', true), 'kimochi')
  assert.equal(translationAvailable('kimochi', 'key', false), false)
  assert.equal(translationAvailable('auto', '', true), true)
})

const USAGE = {
  plan: 'free',
  period: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
  metrics: {
    storage: { used: 18_400_000, limit: 250_000_000 },
    ocr: { used: 500, limit: 500 },
    tts: { used: 12, limit: 100 },
    explain: { used: 3, limit: null }
  }
}

test('usage meters come in a fixed order, with amounts a person can read', () => {
  const rows = usageRows(USAGE)
  assert.deepEqual(
    rows.map((row) => row.metric),
    ['ocr', 'tts', 'explain', 'storage'],
    'missing metrics are left out'
  )
  assert.equal(rows[0].amount, '500 of 500 scans')
  assert.equal(rows[0].exhausted, true)
  assert.equal(rows[0].fraction, 1)
  assert.equal(rows[1].amount, '12 of 100 read-alouds')
  assert.equal(rows[1].exhausted, false)
  assert.equal(rows[2].fraction, null, 'unlimited has no meter')
  assert.match(rows[2].amount, /unlimited/)
  assert.equal(rows[3].amount, '18 MB of 250 MB')
  assert.deepEqual(usageRows(null), [])
})

test('allowances reset on the first of next month, in UTC', () => {
  assert.equal(resetLine(USAGE), 'Monthly allowances reset on Nov 1.')
  assert.equal(shortDate('2027-01-01T00:00:00Z'), 'Jan 1')
  assert.equal(shortDate('nonsense'), null)
  assert.equal(resetLine(null), null)
})

test('the last sync reads as a relative time, and the state as a sentence', () => {
  const now = Date.UTC(2026, 9, 16, 12, 0)
  assert.equal(lastSyncLine(null, now), 'Not synced yet.')
  assert.equal(lastSyncLine(now - 20_000, now), 'Synced just now.')
  assert.equal(lastSyncLine(now - 60_000, now), 'Synced 1 minute ago.')
  assert.equal(lastSyncLine(now - 5 * 60_000, now), 'Synced 5 minutes ago.')
  assert.equal(lastSyncLine(now - 3 * 3_600_000, now), 'Synced 3 hours ago.')
  assert.match(lastSyncLine(now - 3 * 86_400_000, now), /^Synced on Oct 1[23]\.$/)
  const status = normalizeSyncStatus({ state: 'offline', lastSyncAt: now - 60_000, pending: 2 })
  assert.match(syncStateLine(status, now), /^Offline: .* 2 changes waiting to sync\.$/)
  assert.equal(syncStateLine(normalizeSyncStatus({ state: 'syncing' }), now), 'Syncing…')
  assert.equal(syncStateLine(normalizeSyncStatus({ state: 'idle', lastSyncAt: now - 60_000, pending: 1 }), now), 'Synced 1 minute ago. 1 change waiting to sync.')
})

test('sync status from native is read strictly', () => {
  const status = normalizeSyncStatus({
    state: 'weird',
    conflicts: [{ id: 'c1', collection: 'sessions', recordId: 's1', data: { name: 'Novel' }, detectedAt: 5 }, { nope: 1 }, null]
  })
  assert.equal(status.state, 'off')
  assert.equal(status.conflicts.length, 1)
  assert.equal(conflictTitle(status.conflicts[0]), 'Session “Novel”')
  assert.equal(conflictTitle({ ...status.conflicts[0], collection: 'prefs', recordId: 'superTexthooker/fontSizePx', data: 20 }), 'Setting superTexthooker.fontSizePx')
  assert.equal(normalizeSyncStatus(null).state, 'off')
})

test('the sync log is plain, timestamped and bounded', () => {
  const at = new Date(2026, 9, 17, 9, 5, 7, 42).getTime()
  assert.equal(logLine({ t: at, kind: 'push', text: 'sent' }), '2026-10-17 09:05:07.042  push     sent')
  assert.equal(logText([{ t: at, kind: 'a', text: 'x' }, { t: at, kind: 'b', text: 'y' }]).split('\n').length, 2)
  let entries = []
  for (let i = 0; i < 10; i++) entries = appendLog(entries, { t: i, kind: 'info', text: String(i) }, 4)
  assert.deepEqual(entries.map((e) => e.text), ['6', '7', '8', '9'])
})

test('anything unexpected from native reads as signed out', () => {
  assert.equal(normalizeStatus(null).signedIn, false)
  assert.equal(normalizeStatus({ signedIn: 'yes' }).signedIn, false)
  const status = normalizeStatus({ signedIn: true, user: { displayName: 'A' } })
  assert.equal(status.signedIn, true)
  assert.deepEqual(status.accounts, [])
  assert.equal(status.server, null)
})

test('the accounts on this computer are read strictly, and one is in use', () => {
  const status = normalizeStatus({
    signedIn: true,
    accounts: [
      { key: 'cloud-u1', user: { id: 'u1' }, server: { mode: 'cloud', url: 'x' }, signedIn: true, active: true },
      { key: 'local-u2', server: { mode: 'local', url: 'y' }, signedIn: false, active: false, available: false },
      { user: { id: 'no key' } },
      'junk'
    ],
    profile: { key: 'cloud-u1', root: 'profiles/cloud-u1', needsSignIn: false }
  })
  assert.deepEqual(status.accounts.map((a) => a.key), ['cloud-u1', 'local-u2'])
  assert.equal(activeAccount(status).key, 'cloud-u1')
  assert.equal(status.accounts[1].available, false)
  assert.equal(status.accounts[0].available, true, 'available unless native says otherwise')
  assert.equal(status.profile.root, 'profiles/cloud-u1')
  assert.equal(activeAccount(normalizeStatus({ signedIn: false })), null, 'the Local profile')
})

test('the server an account belongs to is read strictly', () => {
  const server = (raw) => normalizeStatus({ signedIn: false, server: raw }).server
  assert.deepEqual(server({ mode: 'local', url: 'http://localhost:3000', forced: true }), {
    mode: 'local',
    url: 'http://localhost:3000',
    forced: true
  })
  assert.equal(server({ mode: 'cloud', url: 'x' }).forced, false)
  assert.equal(server({ mode: 'staging', url: 'x' }), null)
  assert.equal(server('cloud'), null)
})

test('the account token never reaches a webview', async () => {
  // The status the webviews get is built in one place; it must not carry the token.
  const rust = await readFile(new URL('../src-tauri/src/account.rs', import.meta.url), 'utf8')
  const status = rust.slice(rust.indexOf('fn status_value'), rust.indexOf('fn announce()'))
  assert.ok(status.length > 0, 'status_value is where it was')
  assert.doesNotMatch(status, /"token"|\.token\b/)
})

test('the sidebar account bar shows the name over the email, or the email alone', () => {
  const user = { id: 'u', email: 'reader@example.com', displayName: 'Hamish', plan: 'free', status: 'active' }
  assert.deepEqual(accountLines(user), { primary: 'Hamish', secondary: 'reader@example.com' })
  assert.deepEqual(accountLines({ ...user, displayName: '  ' }), { primary: 'reader@example.com', secondary: null })
  assert.deepEqual(accountLines({ ...user, displayName: 'Hamish', email: null }), { primary: 'Hamish', secondary: null })
  assert.deepEqual(accountLines({ ...user, displayName: null, email: null }), { primary: 'Kimochi account', secondary: null })
  assert.equal(accountInitial(user), 'H')
  assert.equal(accountInitial({ ...user, displayName: null }), 'R')
  assert.equal(accountInitial({ ...user, displayName: 'はな' }), 'は')
  assert.equal(accountInitial(null), 'K')
})
