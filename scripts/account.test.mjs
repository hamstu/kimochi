/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
// Kimochi accounts as the panels see them (ui/account.ts): who translates a line, the usage
// meters, and the backup lines on Settings → Account.
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
  lastBackupLine,
  normalizeStatus,
  backupProgressLine,
  accountLines,
  accountInitial
} = await load('account.ts')

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

test('the last backup reads as a relative time', () => {
  const now = Date.UTC(2026, 9, 16, 12, 0)
  assert.equal(lastBackupLine(null, now), 'Not backed up yet.')
  assert.equal(lastBackupLine(now - 20_000, now), 'Backed up just now.')
  assert.equal(lastBackupLine(now - 60_000, now), 'Backed up 1 minute ago.')
  assert.equal(lastBackupLine(now - 5 * 60_000, now), 'Backed up 5 minutes ago.')
  assert.equal(lastBackupLine(now - 3 * 3_600_000, now), 'Backed up 3 hours ago.')
  assert.match(lastBackupLine(now - 3 * 86_400_000, now), /^Backed up on Oct 1[23]\.$/)
})

test('backup progress names the step', () => {
  assert.equal(backupProgressLine({ phase: 'uploading', done: 2, total: 5 }), 'Uploading 2 of 5…')
  assert.equal(backupProgressLine({ phase: 'downloading', done: 0, total: 0 }), 'Downloading…')
  assert.equal(backupProgressLine({ phase: 'done', done: 1, total: 1 }), null)
  assert.equal(backupProgressLine(null), null)
})

test('anything unexpected from native reads as signed out', () => {
  assert.equal(normalizeStatus(null).signedIn, false)
  assert.equal(normalizeStatus({ signedIn: 'yes' }).signedIn, false)
  const status = normalizeStatus({ signedIn: true, user: { displayName: 'A' } })
  assert.equal(status.signedIn, true)
  assert.equal(status.backup.running, false)
  assert.equal(status.server, null)
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
