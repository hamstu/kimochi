/**
 * Yomitan custom-API client (`yomitanSettings.popupType === 'custom-api'`).
 *
 * The requests are the Electron main-process handlers' requests, verbatim — `POST ${apiUrl}/tokenize`
 * with `{text, scanLength: 32}`, `POST ${apiUrl}/termEntries` with `{term}`, and a bare-URL
 * `{action: 'version', version: 8}` probe for the Test button (`src/main/index.ts`).
 *
 * Transport is the native `yomitan_request` command rather than `fetch`: the WebView origin is
 * cross-origin to any API host, and routing through Rust means the URL the user configures is not
 * limited to a hard-coded allow-list. Rust's `validate_configured_api_url` checks the scheme, the
 * host and the absence of credentials and query strings — plain HTTP to a LAN address is accepted,
 * as it was in Electron, because this request carries only the term being looked up and the command
 * is not callable from the overlay. (The OCR endpoint keeps the stricter loopback-only rule: it
 * carries captured pixels on a timer.)
 *
 * The built-in popup path is different and is NOT handled here: it belongs to the overlay, where
 * the real Yomitan backend lives.
 */
import { invoke } from '@tauri-apps/api/core'
import { nativeError } from './tauri'
import type { TokenizeResponse } from './types'

/**
 * Mirrors Rust's `validate_configured_api_url`, so the field can say what is wrong before a request
 * is sent. Any host is fine over either scheme; only these four shapes are refused.
 */
export function describeUrlRestriction(candidate: string): string | null {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return 'That is not a URL.'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return 'Use an http:// or https:// URL.'
  if (!url.hostname) return 'The URL has no host.'
  if (url.username || url.password) return 'Remove the credentials from the URL.'
  if (url.search) return 'Remove the query string from the URL.'
  return null
}

const request = <T>(url: string, body: unknown): Promise<T> =>
  invoke<T>('yomitan_request', { url, body })

export async function tokenize(text: string, apiUrl: string): Promise<TokenizeResponse> {
  const url = `${apiUrl}/tokenize`
  try {
    return await request<TokenizeResponse>(url, { text, scanLength: 32 })
  } catch (error) {
    throw new Error(`${nativeError(error).message} (requesting ${url})`)
  }
}

export async function termEntries(term: string, apiUrl: string): Promise<unknown> {
  const url = `${apiUrl}/termEntries`
  try {
    return await request<unknown>(url, { term })
  } catch (error) {
    throw new Error(`${nativeError(error).message} (requesting ${url})`)
  }
}

export async function testApiConnection(
  apiUrl: string
): Promise<{ success: boolean; error?: string }> {
  const restriction = describeUrlRestriction(apiUrl)
  if (restriction) return { success: false, error: restriction }
  try {
    await request(apiUrl, { action: 'version', version: 8 })
    return { success: true }
  } catch (error) {
    return { success: false, error: nativeError(error).message }
  }
}
