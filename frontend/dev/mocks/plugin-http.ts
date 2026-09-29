/** DEV-ONLY stand-in for `@tauri-apps/plugin-http`: the browser's own fetch (subject to CORS). */
export async function fetch(input: URL | Request | string, init?: RequestInit): Promise<Response> {
  return window.fetch(input, init)
}
