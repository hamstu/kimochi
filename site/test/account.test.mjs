import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  safeReturnTo,
  normalizeLinkCode,
  formatCodeInput,
  messageForCode,
  formatStorage,
  usageFraction,
  resetDay,
  formatResetDay,
  platformLabel,
  planLabel
} from '../src/lib/account.js'

test('safeReturnTo keeps same-origin paths', () => {
  assert.equal(safeReturnTo('/account'), '/account')
  assert.equal(safeReturnTo('/link?code=ABCD-EFGH'), '/link?code=ABCD-EFGH')
  assert.equal(safeReturnTo('/privacy#website'), '/privacy#website')
  assert.equal(safeReturnTo('/'), '/')
})

test('safeReturnTo rejects other origins and tricks', () => {
  for (const bad of [
    null,
    undefined,
    '',
    'https://evil.example/',
    '//evil.example/x',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'account',
    '/foo\nbar',
    '/api/auth/sign-out',
    '/api',
    '/account/sign-in?returnTo=/x',
    '/account/sign-up',
    '/account/reset/',
    'x'.repeat(10)
  ]) {
    assert.equal(safeReturnTo(bad), '/account', String(bad))
  }
  assert.equal(safeReturnTo('//evil', '/'), '/')
})

test('safeReturnTo leaves encoded characters encoded', () => {
  // %0a stays as text in the path: harmless, and URL keeps it encoded.
  assert.equal(safeReturnTo('/x%2F%2Fy'), '/x%2F%2Fy')
})

test('normalizeLinkCode', () => {
  assert.equal(normalizeLinkCode('ABCD-EFGH'), 'ABCD-EFGH')
  assert.equal(normalizeLinkCode('abcd efgh'), 'ABCD-EFGH')
  assert.equal(normalizeLinkCode(' abcdefgh '), 'ABCD-EFGH')
  assert.equal(normalizeLinkCode('ab-cd-ef-gh'), 'ABCD-EFGH')
  assert.equal(normalizeLinkCode('wxyz–2345'), 'WXYZ-2345', 'en dash')
  assert.equal(normalizeLinkCode('ABCD-EFG'), null, 'too short')
  assert.equal(normalizeLinkCode('ABCD-EFGHJ'), null, 'too long')
  assert.equal(normalizeLinkCode('ABCD-EFG0'), null, '0 is not in the alphabet')
  assert.equal(normalizeLinkCode('ABCD-EFGI'), null, 'I is not in the alphabet')
  assert.equal(normalizeLinkCode(''), null)
  assert.equal(normalizeLinkCode(null), null)
})

test('formatCodeInput formats as you type', () => {
  assert.equal(formatCodeInput(''), '')
  assert.equal(formatCodeInput('ab'), 'AB')
  assert.equal(formatCodeInput('abcd'), 'ABCD')
  assert.equal(formatCodeInput('abcde'), 'ABCD-E')
  assert.equal(formatCodeInput('abcd efgh'), 'ABCD-EFGH')
  assert.equal(formatCodeInput('ABCD-EFGH-JKLM'), 'ABCD-EFGH')
  assert.equal(formatCodeInput('a0b1c!d'), 'ABCD')
})

test('messageForCode gives plain language, with a fallback', () => {
  assert.match(messageForCode('provider_not_configured'), /not set up/)
  assert.match(messageForCode('rate_limited'), /Too many attempts/)
  assert.match(messageForCode('access_denied'), /cancelled/)
  assert.equal(messageForCode('something_new'), 'Something went wrong. Please try again.')
  assert.equal(messageForCode(null), 'Something went wrong. Please try again.')
})

test('formatStorage', () => {
  assert.equal(formatStorage(0), '0 B')
  assert.equal(formatStorage(-5), '0 B')
  assert.equal(formatStorage(950), '950 B')
  assert.equal(formatStorage(1_500), '1.5 KB')
  assert.equal(formatStorage(12_345_678), '12.3 MB')
  assert.equal(formatStorage(250_000_000), '250 MB')
  assert.equal(formatStorage(5_000_000_000), '5 GB')
})

test('usageFraction', () => {
  assert.equal(usageFraction(50, 100), 0.5)
  assert.equal(usageFraction(150, 100), 1)
  assert.equal(usageFraction(0, 100), 0)
  assert.equal(usageFraction(10, null), null)
  assert.equal(usageFraction(0, 0), 1)
})

test('resetDay accepts exclusive and inclusive period ends', () => {
  assert.equal(resetDay('2026-11-01T00:00:00.000Z')?.toISOString(), '2026-11-01T00:00:00.000Z')
  assert.equal(resetDay('2026-10-31T23:59:59.999Z')?.toISOString(), '2026-11-01T00:00:00.000Z')
  assert.equal(resetDay('2026-12-31T23:59:59Z')?.toISOString(), '2027-01-01T00:00:00.000Z')
  assert.equal(resetDay('nope'), null)
})

test('formatResetDay', () => {
  const now = new Date('2026-10-16T12:00:00Z')
  assert.equal(formatResetDay(new Date('2026-11-01T00:00:00Z'), now), 'November 1')
  assert.equal(formatResetDay(new Date('2027-01-01T00:00:00Z'), now), 'January 1, 2027')
})

test('labels', () => {
  assert.equal(platformLabel('macos'), 'macOS')
  assert.equal(platformLabel('Windows'), 'Windows')
  assert.equal(platformLabel('haiku'), 'haiku')
  assert.equal(platformLabel(null), 'Unknown platform')
  assert.equal(planLabel('cloud'), 'Kimochi Cloud')
  assert.equal(planLabel('trial'), 'Kimochi Cloud trial')
  assert.equal(planLabel('owner'), 'Owner')
  assert.equal(planLabel(undefined), 'Free')
})

test('relativeTime', async () => {
  const { relativeTime } = await import('../src/lib/account.js')
  const now = new Date('2026-10-16T12:00:00Z')
  assert.equal(relativeTime('2026-10-16T11:59:30Z', now), 'just now')
  assert.equal(relativeTime('2026-10-16T11:00:00Z', now), '1 hour ago')
  assert.equal(relativeTime('2026-10-13T12:00:00Z', now), '3 days ago')
  assert.equal(relativeTime('2026-10-15T12:00:00Z', now), 'yesterday')
  assert.equal(relativeTime(null, now), '')
  assert.equal(relativeTime('nope', now), '')
})

test('deleteConfirmMatches', async () => {
  const { deleteConfirmMatches } = await import('../src/lib/account.js')
  assert.equal(deleteConfirmMatches(' A@B.c ', 'a@b.c'), true)
  assert.equal(deleteConfirmMatches('a@b.co', 'a@b.c'), false)
  assert.equal(deleteConfirmMatches('', 'a@b.c'), false)
  assert.equal(deleteConfirmMatches('Delete', null), true)
  assert.equal(deleteConfirmMatches('a@b.c', null), false)
})
