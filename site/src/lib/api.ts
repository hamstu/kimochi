/**
 * Typed client for the Kimochi account API (kimochi-server/API.md). The site and the API share
 * an origin, so every call is a relative `/api/...` URL with the session cookie
 * (`credentials: 'same-origin'`). Errors are thrown as `ApiError` carrying the server's
 * `{ error, message }`; a network failure becomes code `network`.
 */
import { messageForCode } from './account.js'

export type Plan = 'free' | 'trial' | 'cloud' | 'owner'
export type Provider = 'google' | 'discord'

export interface User {
  id: string
  email: string | null
  emailVerified: boolean
  displayName: string | null
  avatarUrl: string | null
  plan: Plan
  /** Whether the account has Kimochi Cloud (trial, paid, lifetime, or granted). */
  cloud: boolean
  billing: Billing
  status: 'active' | 'suspended'
  hasPassword: boolean
  providers: Provider[]
  createdAt: string
}

/** Where Kimochi Cloud comes from, and what happens next (all dates ISO). */
export interface Billing {
  source: 'subscription' | 'lifetime' | 'grant' | null
  /** Stripe's subscription status: trialing, active, past_due, canceled… */
  status: string | null
  interval: 'month' | 'year' | null
  trialEnd: string | null
  periodEnd: string | null
  /** When a cancelled subscription ends. */
  cancelAt: string | null
  hasCustomer: boolean
  trialAvailable: boolean
}

export type Choice = 'monthly' | 'yearly' | 'lifetime'

export type MetricName = 'ocr' | 'translate' | 'tts' | 'explain' | 'storage'

export interface Metric {
  used: number
  /** null = unlimited */
  limit: number | null
}

export interface Usage {
  plan: Plan
  cloud: boolean
  period: { start: string; end: string }
  metrics: Record<MetricName, Metric>
}

export interface Device {
  id: string
  name: string
  platform: string
  createdAt: string
  lastUsedAt: string | null
  current: boolean
}

export interface SyncSession {
  id: string
  name: string
  lineCount: number
}

/** `GET /api/account/sync`: what this account has synced from Kimochi. */
export interface SyncSummary {
  used: number
  limit: number | null
  records: number
  seq: number
  sessions: SyncSession[]
}

/** Everything the account has synced, as a ZIP (same origin, so the session cookie goes along). */
export const EXPORT_URL = '/api/account/export'

export type LinkStatus = 'pending' | 'approved' | 'denied' | 'expired'

export interface LinkRequest {
  code: string
  deviceName: string
  platform: string
  createdAt: string
  status: LinkStatus
}

export interface AdminOverview {
  plans: Partial<Record<Plan, number>>
  subscriptions: { interval: string | null; status: string; count: number }[]
  lifetime: number
  recent: { email: string | null; status: string; interval: string | null; updatedAt: string }[]
}

export interface AdminLimits {
  plans: Plan[]
  metrics: MetricName[]
  limits: Record<Plan, Record<MetricName, number | null>>
  defaults: Record<Plan, Record<MetricName, number | null>>
}

export type AdminUser = User & { grant: 'cloud' | 'owner' | null }

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly body: Record<string, unknown>
  constructor(status: number, code: string, message: string, body: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.body = body
  }
}

const STATUS_CODES: Record<number, string> = {
  400: 'invalid',
  401: 'unauthorized',
  402: 'quota_exceeded',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
  502: 'upstream',
  503: 'not_configured'
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch {
    throw new ApiError(0, 'network', messageForCode('network'))
  }
  const isJson = (res.headers.get('Content-Type') ?? '').includes('application/json')
  let data: unknown = null
  if (isJson && res.status !== 204) {
    try {
      data = await res.json()
    } catch {
      data = null
    }
  }
  if (!res.ok) {
    const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
    const code = typeof obj.error === 'string' ? obj.error : (STATUS_CODES[res.status] ?? 'internal')
    // No JSON at all (e.g. a static host's 404, or the dev proxy with no server behind it) means
    // the API itself is unreachable rather than refusing.
    if (!isJson && (res.status === 404 || res.status >= 500)) {
      throw new ApiError(res.status, 'network', messageForCode('network'))
    }
    const message = typeof obj.message === 'string' && obj.message ? obj.message : messageForCode(code)
    throw new ApiError(res.status, code, message, obj)
  }
  return data as T
}

const enc = encodeURIComponent

export const api = {
  // Auth (sets or clears the session cookie)
  me: () => request<{ user: User }>('GET', '/api/auth/me').then((r) => r.user),
  signUp: (b: { email: string; password: string; displayName?: string }) =>
    request<{ user: User }>('POST', '/api/auth/sign-up', b).then((r) => r.user),
  signIn: (b: { email: string; password: string }) =>
    request<{ user: User }>('POST', '/api/auth/sign-in', b).then((r) => r.user),
  signOut: () => request<void>('POST', '/api/auth/sign-out'),
  verifyEmail: (token: string) =>
    request<{ user: User }>('POST', '/api/auth/verify-email', { token }).then((r) => r.user),
  resendVerification: () => request<void>('POST', '/api/auth/resend-verification'),
  forgotPassword: (email: string) => request<void>('POST', '/api/auth/forgot-password', { email }),
  resetPassword: (token: string, password: string) =>
    request<{ user: User }>('POST', '/api/auth/reset-password', { token, password }).then((r) => r.user),
  changePassword: (b: { currentPassword?: string; newPassword: string }) =>
    request<void>('POST', '/api/auth/change-password', b),
  unlinkProvider: (p: Provider) => request<void>('DELETE', `/api/auth/oauth/${p}`),

  // Account (cookie only)
  updateProfile: (displayName: string) =>
    request<{ user: User }>('PATCH', '/api/account', { displayName }).then((r) => r.user),
  deleteAccount: (confirm: string) => request<void>('DELETE', '/api/account', { confirm }),
  devices: () => request<{ devices: Device[] }>('GET', '/api/account/devices').then((r) => r.devices),
  revokeDevice: (id: string) => request<void>('DELETE', `/api/account/devices/${enc(id)}`),
  sync: () => request<SyncSummary>('GET', '/api/account/sync'),
  deleteSync: () => request<void>('DELETE', '/api/account/sync'),
  usage: () => request<Usage>('GET', '/api/v1/usage'),

  // Kimochi Cloud billing (Stripe Checkout and the Customer Portal)
  checkout: (plan: Choice, returnTo: 'home' | 'account') =>
    request<{ url: string }>('POST', '/api/billing/checkout', { plan, returnTo }).then((r) => r.url),
  billingPortal: () => request<{ url: string }>('POST', '/api/billing/portal').then((r) => r.url),
  billingRefresh: () => request<{ user: User }>('POST', '/api/billing/refresh').then((r) => r.user),

  // Owner only
  adminOverview: () => request<AdminOverview>('GET', '/api/admin/overview'),
  adminLimits: () => request<AdminLimits>('GET', '/api/admin/limits'),
  adminSetLimits: (limits: Partial<Record<Plan, Partial<Record<MetricName, number | null>>>>) =>
    request<{ limits: AdminLimits['limits'] }>('PUT', '/api/admin/limits', { limits }).then((r) => r.limits),
  adminUser: (email: string) =>
    request<{ user: AdminUser; usage: Usage }>('GET', `/api/admin/users?email=${enc(email)}`),
  adminSetUser: (b: { email: string; grant?: 'cloud' | 'owner' | null; status?: 'active' | 'suspended' }) =>
    request<{ user: AdminUser }>('POST', '/api/admin/users/plan', b).then((r) => r.user),

  // Linking the app
  linkRequest: (code: string) => request<LinkRequest>('GET', `/api/link/${enc(code)}`),
  approveLink: (code: string) => request<void>('POST', `/api/link/${enc(code)}/approve`),
  denyLink: (code: string) => request<void>('POST', `/api/link/${enc(code)}/deny`)
}

/** Full-page URL that starts Google/Discord sign-in (or linking, when already signed in). */
export function oauthStartUrl(provider: Provider, returnTo: string): string {
  return `/api/auth/oauth/${provider}/start?returnTo=${enc(returnTo)}`
}

/** The sign-in page URL that returns to `path` afterwards. */
export function signInUrl(path: string): string {
  return path === '/account' ? '/account/sign-in' : `/account/sign-in?returnTo=${enc(path)}`
}
