// @ts-check
/**
 * Pure helpers for the account pages (/account/*, /link): returnTo sanitising, link-code
 * normalising, plain-language error messages, and number/date formatting for usage meters.
 * Plain JS + JSDoc so `node --test` imports it directly (site/test/account.test.mjs); TypeScript
 * checks it via `checkJs`. Nothing here touches the DOM or the network.
 */

/** Where sign-in sends people when no (valid) returnTo is given. */
export const DEFAULT_RETURN_TO = '/account'

/** Paths that must never be a returnTo target (would loop back into the auth flow). */
const AUTH_PATHS = ['/account/sign-in', '/account/sign-up', '/account/forgot', '/account/reset', '/account/verify']

/**
 * Keep a returnTo only when it is a same-origin path ("/link?code=…"). Rejects absolute URLs,
 * protocol-relative "//host", backslash tricks ("/\host"), control characters, /api routes and
 * the auth pages themselves; anything rejected becomes `fallback`.
 * @param {string | null | undefined} raw
 * @param {string} [fallback]
 * @returns {string}
 */
export function safeReturnTo(raw, fallback = DEFAULT_RETURN_TO) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return fallback
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback
  let url
  try {
    url = new URL(raw, 'https://kimochi.invalid')
  } catch {
    return fallback
  }
  if (url.origin !== 'https://kimochi.invalid') return fallback
  const path = url.pathname.replace(/\/+$/, '') || '/'
  if (path === '/api' || path.startsWith('/api/')) return fallback
  if (AUTH_PATHS.includes(path)) return fallback
  return url.pathname + url.search + url.hash
}

/** The link-code alphabet from the API contract (no 0, 1, I, O). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * Normalise what a person typed or pasted into the canonical "ABCD-EFGH" form, or null when it
 * is not exactly 8 code characters. Case, spaces and hyphens are ignored; the look-alikes O→0
 * are not guessed at, since 0 and O are both outside the alphabet anyway.
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function normalizeLinkCode(raw) {
  if (typeof raw !== 'string') return null
  const chars = raw.toUpperCase().replace(/[\s\-‐-―ー_]/g, '')
  if (chars.length !== 8) return null
  for (const c of chars) if (!CODE_ALPHABET.includes(c)) return null
  return `${chars.slice(0, 4)}-${chars.slice(4)}`
}

/**
 * Format a code while it is being typed: uppercase, drop anything outside the alphabet, insert
 * the hyphen after four characters, cap at eight.
 * @param {string} raw
 * @returns {string}
 */
export function formatCodeInput(raw) {
  const chars = [...String(raw).toUpperCase()].filter((c) => CODE_ALPHABET.includes(c)).slice(0, 8).join('')
  return chars.length > 4 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars
}

/**
 * Plain-language messages for the `?error=` codes the OAuth callback redirects with, plus the
 * API's error codes. Unknown codes get a generic sentence.
 * @type {Record<string, string>}
 */
const MESSAGES = {
  provider_not_configured:
    'That sign-in option is not set up on this server yet. Use your email and password instead, or try again later.',
  access_denied: 'Sign-in was cancelled. Nothing was changed.',
  oauth_cancelled: 'Sign-in was cancelled. Nothing was changed.',
  invalid_state: 'That sign-in attempt timed out or was started in another tab. Please try again.',
  state_mismatch: 'That sign-in attempt timed out or was started in another tab. Please try again.',
  oauth_failed: 'We could not finish signing you in with that provider. Please try again.',
  provider_error: 'We could not finish signing you in with that provider. Please try again.',
  already_linked: 'That account is already connected to a different Kimochi account.',
  identity_in_use: 'That account is already connected to a different Kimochi account.',
  email_unverified:
    'That provider did not confirm your email address, so we could not match it to an account. Try another way to sign in.',
  suspended: 'This account is suspended. Contact us if you think this is a mistake.',
  unauthorized: 'Please sign in to continue.',
  forbidden: 'That action was blocked. Reload the page and try again.',
  not_found: 'We could not find that.',
  invalid: 'Something in that request was not right. Check it and try again.',
  conflict: 'That conflicts with something that already exists.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  quota_exceeded: 'You have used this month’s allowance for that.',
  not_configured: 'That service is not set up on this server yet.',
  upstream: 'A service Kimochi relies on did not answer. Please try again in a moment.',
  internal: 'Something went wrong on our side. Please try again.',
  network: 'We could not reach Kimochi’s server. Check your connection and try again.'
}

/**
 * @param {string | null | undefined} code
 * @returns {string}
 */
export function messageForCode(code) {
  return (code && MESSAGES[code]) || 'Something went wrong. Please try again.'
}

/**
 * Byte counts for storage meters: decimal units, "0 B" for zero (unlike assets.js formatBytes).
 * @param {number} bytes
 * @returns {string}
 */
export function formatStorage(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000
    i++
  }
  const digits = i === 0 || n >= 100 ? 0 : 1
  return `${n.toFixed(digits).replace(/\.0$/, '')} ${units[i]}`
}

/**
 * Fraction of an allowance used, clamped to 0…1; null when the limit is unlimited (null).
 * @param {number} used
 * @param {number | null} limit
 * @returns {number | null}
 */
export function usageFraction(used, limit) {
  if (limit === null || limit === undefined) return null
  if (!(limit > 0)) return 1
  return Math.min(1, Math.max(0, used / limit))
}

/**
 * The day an allowance resets, from the usage period's `end`. Accepts either an exclusive end
 * (the next month's 1st at 00:00 UTC) or an inclusive one (the last instant of this month), and
 * returns the reset day as a UTC midnight Date.
 * @param {string} periodEnd ISO 8601
 * @returns {Date | null}
 */
export function resetDay(periodEnd) {
  const t = Date.parse(periodEnd)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return new Date(midnight === t ? t : midnight + 86_400_000)
}

/**
 * "November 1" (adds the year when it differs from `now`'s). Formatted in UTC: resets happen at
 * 00:00 UTC.
 * @param {Date} day
 * @param {Date} [now]
 * @param {string} [locale]
 * @returns {string}
 */
export function formatResetDay(day, now = new Date(), locale = 'en-US') {
  /** @type {Intl.DateTimeFormatOptions} */
  const opts = { month: 'long', day: 'numeric', timeZone: 'UTC' }
  if (day.getUTCFullYear() !== now.getUTCFullYear()) opts.year = 'numeric'
  return new Intl.DateTimeFormat(locale, opts).format(day)
}

/** @type {Record<string, string>} */
const PLATFORMS = {
  macos: 'macOS',
  darwin: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  steamdeck: 'Steam Deck',
  'steam-deck': 'Steam Deck'
}

/**
 * @param {string | null | undefined} platform
 * @returns {string}
 */
export function platformLabel(platform) {
  if (!platform) return 'Unknown platform'
  return PLATFORMS[platform.toLowerCase()] ?? platform
}

/** @type {Record<string, string>} */
const PLANS = { free: 'Free', plus: 'Plus', owner: 'Owner' }

/**
 * @param {string | null | undefined} plan
 * @returns {string}
 */
export function planLabel(plan) {
  return (plan && PLANS[plan]) || 'Free'
}

/**
 * "3 days ago", "just now", "in 2 hours". Falls back to "" for unparseable input.
 * @param {string | null | undefined} iso
 * @param {Date} [now]
 * @param {string} [locale]
 * @returns {string}
 */
export function relativeTime(iso, now = new Date(), locale = 'en-US') {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const secs = Math.round((t - now.getTime()) / 1000)
  if (Math.abs(secs) < 60) return 'just now'
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  /** @type {[Intl.RelativeTimeFormatUnit, number][]} */
  const steps = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86400],
    ['week', 604800],
    ['month', 2629800],
    ['year', 31557600]
  ]
  let unit = steps[0]
  for (const s of steps) if (Math.abs(secs) >= s[1]) unit = s
  return rtf.format(Math.round(secs / unit[1]), unit[0])
}

/**
 * "October 16, 2026" in the viewer's time zone.
 * @param {string | null | undefined} iso
 * @param {string} [locale]
 * @returns {string}
 */
export function formatDay(iso, locale = 'en-US') {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(t))
}

/**
 * Whether the text typed into the delete-account box confirms it: the account's email (any
 * case, surrounding spaces ignored), or the word "delete" when the account has no email.
 * @param {string} typed
 * @param {string | null} email
 * @returns {boolean}
 */
export function deleteConfirmMatches(typed, email) {
  const t = typed.trim().toLowerCase()
  return email ? t === email.trim().toLowerCase() : t === 'delete'
}
