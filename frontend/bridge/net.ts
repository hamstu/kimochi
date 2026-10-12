/**
 * HTTP for the panels.
 *
 * The WebView origin is `tauri://localhost`, so a plain `fetch` to the TTS or Yomitan-API hosts is
 * cross-origin. `@tauri-apps/plugin-http` performs the request in Rust instead — but only for URLs
 * inside the capability scope in `src-tauri/capabilities/network.json` (owned by kimochi-native).
 * A URL outside that scope is refused by the plugin with an opaque message, so `isWithinHttpScope`
 * lets a caller check first and explain. The user-configurable Yomitan API URL does NOT come
 * through here — it goes through the native `yomitan_request` command, which validates rather than
 * enumerating hosts. What remains on this path is the TTS endpoint, which is a fixed host.
 */
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

/**
 * Mirrors the `http:default` allow-list in `src-tauri/capabilities/network.json`.
 * `scripts/http-scope.test.mjs` fails the build if the two drift apart.
 */
export const HTTP_SCOPE: string[] = [
  'https://kimochi-server.hamish.workers.dev/**',
  'http://localhost:3000/**',
  'http://127.0.0.1:3000/**',
  'http://localhost:19633/**',
  'http://127.0.0.1:19633/**',
  'http://localhost:8765/**',
  'http://127.0.0.1:8765/**',
  'https://github.com/**',
  'https://*.githubusercontent.com/**',
  'https://api.jiten.moe/**',
  'https://data.10ten.life/**',
  'https://jitendex.org/**',
  'http://localhost:5050/**',
  'http://127.0.0.1:5050/**'
]

function matchesPattern(url: URL, pattern: string): boolean {
  const target = new URL(pattern.replace('/**', '/'))
  if (target.protocol !== url.protocol) return false
  if (target.port !== url.port) return false
  if (target.hostname.startsWith('*.')) return url.hostname.endsWith(target.hostname.slice(1))
  return target.hostname === url.hostname
}

/** Whether a URL can be requested at all under the app's current capability scope. */
export function isWithinHttpScope(candidate: string): boolean {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return false
  }
  return HTTP_SCOPE.some((pattern) => matchesPattern(url, pattern))
}

export class HttpScopeError extends Error {
  constructor(candidate: string, allowed: string[]) {
    super(
      `${candidate} is outside the addresses this build is allowed to contact. Supported: ${allowed.join(', ')}.`
    )
    this.name = 'HttpScopeError'
  }
}

export const httpFetch: typeof globalThis.fetch = (input, init) =>
  tauriFetch(input as string | URL | Request, init as RequestInit)

export function describeFetchError(error: unknown, url: string): string {
  if (error instanceof HttpScopeError) return error.message
  const message = error instanceof Error ? error.message : String(error)
  if (/scope|forbidden|not allowed/i.test(message)) {
    return `${message} — ${url} is outside the addresses this build is allowed to contact.`
  }
  return `${message} (requesting ${url})`
}
