#!/usr/bin/env node
/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS script. */
/**
 * Sync end to end against a local Kimochi server (`npm run dev` in kimochi-server, on :3000):
 * signs in a test account on the website API, links two "computers" to it (and one to a second
 * account), then runs the ignored Rust test `sync::tests::e2e_two_computers_against_a_server`,
 * which syncs two profile folders through the server: union of lines, a concurrent rename kept
 * as a conflict, a delete travelling as a tombstone, and another account seeing none of it.
 *
 *   node scripts/sync-e2e.mjs [--base http://localhost:3000] [--origin http://127.0.0.1:1450]
 *
 * `--origin` is the server's PUBLIC_URL (the website's origin, checked on cookie requests).
 * Tokens go to the test through the environment only; nothing prints them.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}
const BASE = arg('--base', 'http://localhost:3000')
const ORIGIN = arg('--origin', 'http://127.0.0.1:1450')
const EMAIL = arg('--email', 'e2e-test@example.com')
const PASSWORD = arg('--password', 'correct-horse-battery')

async function web(cookie, path, body) {
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' }
  if (cookie.value) headers.Cookie = `kimochi_session=${cookie.value}`
  const res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) })
  for (const set of res.headers.getSetCookie()) {
    const m = /^kimochi_session=([^;]*)/.exec(set)
    if (m) cookie.value = m[1]
  }
  return res
}

async function signIn(email, password) {
  const cookie = { value: null }
  let res = await web(cookie, '/api/auth/sign-in', { email, password })
  if (res.status === 401) res = await web(cookie, '/api/auth/sign-up', { email, password, displayName: 'E2E' })
  if (!res.ok) throw new Error(`sign-in ${email}: ${res.status} ${await res.text()}`)
  return cookie
}

async function link(cookie, name) {
  const start = await (
    await fetch(`${BASE}/api/v1/link/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: name, platform: 'e2e' })
    })
  ).json()
  const approve = await web(cookie, `/api/link/${start.code}/approve`)
  if (approve.status !== 204) throw new Error(`approve: ${approve.status}`)
  const poll = await (
    await fetch(`${BASE}/api/v1/link/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollToken: start.pollToken })
    })
  ).json()
  if (poll.status !== 'approved') throw new Error(`poll: ${poll.status}`)
  return poll.token
}

const account = await signIn(EMAIL, PASSWORD)
const tokenA = await link(account, 'E2E computer A')
const tokenB = await link(account, 'E2E computer B')
const other = await signIn(`e2e-other-${Date.now()}@example.com`, PASSWORD)
const tokenOther = await link(other, 'E2E other account')
console.log(`Linked two computers to ${EMAIL} and one to a second account; running the Rust test…`)

const tauri = fileURLToPath(new URL('../src-tauri/', import.meta.url))
const result = spawnSync(
  'cargo',
  ['test', '--bin', 'kimochi', 'e2e_two_computers_against_a_server', '--', '--ignored', '--nocapture'],
  {
    cwd: tauri,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(process.platform === 'darwin'
        ? { DEVELOPER_DIR: '/Library/Developer/CommandLineTools', RUSTFLAGS: '-C link-arg=-Wl,-rpath,/usr/lib/swift' }
        : {}),
      KIMOCHI_E2E_BASE: BASE,
      KIMOCHI_E2E_TOKEN_A: tokenA,
      KIMOCHI_E2E_TOKEN_B: tokenB,
      KIMOCHI_E2E_TOKEN_OTHER: tokenOther
    }
  }
)
process.exit(result.status ?? 1)
