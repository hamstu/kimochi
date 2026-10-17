// `npm run dev:local`: Kimochi against a local Kimochi server, everything booted in one go.
//
//   1. finds the server repository: KIMOCHI_SERVER_DIR, else ../kimochi-server
//   2. makes sure the static-assets folder its wrangler.toml names exists (wrangler only checks
//      that it exists; locally the website is served by Vite on :1450, so an empty one is enough)
//   3. applies the server's new D1 migrations to the local database (`npm run db:migrate:local`)
//   4. starts the server (`npm run dev` there, wrangler on :3000) and the website (`npm run
//      site:dev`, Vite on :1450), or reuses either one already answering (/health on :3000, / on
//      :1450)
//   5. waits for both to answer
//   6. runs the app (`node scripts/run.mjs dev`) with KIMOCHI_SERVER=local, which a debug build
//      uses over the `serverSettings.mode` setting (Settings → Account shows it as pinned)
//
// Child output is prefixed with [server] / [site]. When the app exits, or on Ctrl-C, only the
// processes this script started are stopped, by their PIDs and process groups (so wrangler's
// workerd goes too); a server or site that was already running is left alone.
//
//   --servers-only   steps 1–5, then wait for Ctrl-C (no app)
//   -- <args>        passed through to `node scripts/run.mjs dev`
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const windows = process.platform === 'win32'
const npm = windows ? 'npm.cmd' : 'npm'
const args = process.argv.slice(2)
const serversOnly = args.includes('--servers-only')
const passthrough = args.includes('--') ? args.slice(args.indexOf('--') + 1) : []

const SERVER = { name: 'server', host: '127.0.0.1', port: 3000, probe: 'http://127.0.0.1:3000/health' }
const SITE = { name: 'site', host: '127.0.0.1', port: 1450, probe: 'http://127.0.0.1:1450/' }
const READY_TIMEOUT_MS = 90_000

const log = (message) => console.log(`[dev:local] ${message}`)
const fail = (message) => {
  console.error(`[dev:local] ${message}`)
  return shutdown(1)
}

// ---------------------------------------------------------------- children

/** Processes this script started, stopped on exit. */
const started = []

/** Write a child's output line by line, each with `[name] ` in front. */
function prefix(stream, name, out) {
  let buffered = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffered += chunk
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() ?? ''
    for (const line of lines) out.write(`[${name}] ${line}\n`)
  })
  stream.on('end', () => {
    if (buffered) out.write(`[${name}] ${buffered}\n`)
  })
}

/**
 * Start `npm <npmArgs>` in `cwd` with prefixed output. On POSIX it leads a process group of its
 * own, so stopping it reaches everything it started (npm → wrangler → workerd) and a Ctrl-C in
 * the terminal reaches this script rather than racing it.
 */
function start(name, npmArgs, cwd, { quiet = false } = {}) {
  const child = spawn(npm, npmArgs, {
    cwd,
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !windows,
    shell: windows,
    windowsHide: true
  })
  prefix(child.stdout, name, process.stdout)
  prefix(child.stderr, name, process.stderr)
  const entry = { name, child, exited: false }
  child.on('exit', (code, signal) => {
    entry.exited = true
    if (!stopping && !quiet) log(`${name} exited (${signal ?? code})`)
  })
  child.on('error', (error) => {
    entry.exited = true
    if (!stopping) log(`${name} could not start: ${error.message}`)
  })
  started.push(entry)
  return entry
}

/** Run `npm <npmArgs>` in `cwd` to completion, output prefixed. Resolves to the exit code. */
function runToEnd(name, npmArgs, cwd) {
  return new Promise((resolve) => {
    const entry = start(name, npmArgs, cwd, { quiet: true })
    const done = (code) => {
      started.splice(started.indexOf(entry), 1)
      resolve(code)
    }
    entry.child.on('exit', (code) => done(code ?? 1))
    entry.child.on('error', () => done(1))
  })
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal) // the whole group: npm and everything under it
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
}

/** Stop one child we started: SIGTERM to its group, SIGKILL after 5 s (taskkill /T on Windows). */
function stop(entry) {
  const pid = entry.child.pid
  if (!pid) return Promise.resolve()
  if (windows) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    // The group can outlive its leader (workerd after npm), so signal it even if npm is gone.
    signalGroup(pid, 'SIGTERM')
    const timer = setTimeout(() => {
      signalGroup(pid, 'SIGKILL')
      resolve()
    }, 5000)
    const finish = () => {
      clearTimeout(timer)
      // Anything in the group that ignored SIGTERM.
      setTimeout(() => {
        signalGroup(pid, 'SIGKILL')
        resolve()
      }, 300)
    }
    if (entry.exited) finish()
    else entry.child.once('exit', finish)
  })
}

let stopping = false
async function shutdown(code) {
  if (stopping) return
  stopping = true
  if (started.length) log(`stopping ${started.map((e) => e.name).join(' and ')}…`)
  await Promise.all(started.map(stop))
  process.exit(code)
}

// ---------------------------------------------------------------- probes

/** Whether something accepts connections on host:port. */
function listening(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

async function answers(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return response.ok
  } catch {
    return false
  }
}

async function waitFor(service, entry) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await answers(service.probe)) return true
    if (entry?.exited) return false
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

/** Reuse a running `service`, or start it with `npm <npmArgs>` in `cwd`. */
async function ensure(service, npmArgs, cwd) {
  if (await answers(service.probe)) {
    log(`${service.name}: reusing the one already answering at ${service.probe}`)
    return null
  }
  if (await listening(service.host, service.port)) {
    await fail(
      `${service.name}: something is listening on ${service.host}:${service.port} but ${service.probe} does not answer. Stop it, or let it finish starting, and try again.`
    )
  }
  log(`${service.name}: starting \`npm ${npmArgs.join(' ')}\` in ${cwd}`)
  return start(service.name, npmArgs, cwd)
}

// ---------------------------------------------------------------- main

/** The app, once started: a Ctrl-C reaches it too, so its own exit drives the shutdown. */
let app = null
function interrupted(code) {
  if (!app || app.exitCode !== null || app.signalCode !== null) return void shutdown(code)
  log('waiting for Kimochi to quit…')
  setTimeout(() => void shutdown(code), 15_000).unref()
}
process.on('SIGINT', () => interrupted(130))
process.on('SIGTERM', () => {
  app?.kill('SIGTERM')
  interrupted(143)
})
process.on('SIGHUP', () => interrupted(129))

// 1. The server repository.
const serverDir = path.resolve(process.env.KIMOCHI_SERVER_DIR || path.join(root, '..', 'kimochi-server'))
if (!existsSync(path.join(serverDir, 'wrangler.toml'))) {
  await fail(
    `No Kimochi server at ${serverDir} (no wrangler.toml). Clone it beside this repository as ../kimochi-server, or set KIMOCHI_SERVER_DIR.`
  )
}
for (const [dir, hint] of [
  [serverDir, `cd ${serverDir} && npm install`],
  [path.join(root, 'site'), 'npm --prefix site install']
]) {
  if (!existsSync(path.join(dir, 'node_modules'))) await fail(`${dir} has no node_modules; run \`${hint}\` first.`)
}

// 2. The assets folder wrangler.toml names (relative to the server repository).
const toml = readFileSync(path.join(serverDir, 'wrangler.toml'), 'utf8')
const assetsSection = toml.split(/^\[/m).find((section) => section.startsWith('assets]'))
const assetsDir = assetsSection?.match(/^\s*directory\s*=\s*"([^"]+)"/m)?.[1]
if (assetsDir) {
  const resolved = path.resolve(serverDir, assetsDir)
  if (!existsSync(resolved)) {
    log(`creating ${resolved} (the server's static assets; the website itself runs on :1450)`)
    mkdirSync(resolved, { recursive: true })
  }
}

// 3. New migrations for the local database.
log('applying the server database migrations (local)…')
const migrated = await runToEnd('server', ['run', 'db:migrate:local'], serverDir)
if (migrated !== 0) await fail(`\`npm run db:migrate:local\` failed (exit ${migrated}).`)

// 4. Server and site.
const server = await ensure(SERVER, ['run', 'dev'], serverDir)
const site = await ensure(SITE, ['run', 'site:dev'], root)

// 5. Both answering.
for (const [service, entry] of [
  [SERVER, server],
  [SITE, site]
]) {
  if (!(await waitFor(service, entry))) await fail(`${service.name} did not answer at ${service.probe}.`)
}
log(`server ready at http://localhost:${SERVER.port}, website at http://127.0.0.1:${SITE.port}`)

if (serversOnly) {
  log(started.length ? 'servers only: Ctrl-C stops what this started.' : 'servers only: nothing was started here.')
  if (!started.length) process.exit(0)
  // Stay up while the children do.
  await Promise.race(started.map((entry) => new Promise((resolve) => entry.child.once('exit', resolve))))
  await shutdown(1)
} else {
  // 6. The app, in this process group: Ctrl-C reaches `tauri dev` as with `npm run dev`.
  log('starting Kimochi (KIMOCHI_SERVER=local)…')
  app = spawn(process.execPath, [path.join(root, 'scripts', 'run.mjs'), 'dev', ...passthrough], {
    cwd: root,
    env: { ...process.env, KIMOCHI_SERVER: 'local' },
    stdio: 'inherit'
  })
  app.on('error', (error) => void fail(`the app could not start: ${error.message}`))
  app.on('exit', (code, signal) => void shutdown(code ?? (signal ? 1 : 0)))
}
