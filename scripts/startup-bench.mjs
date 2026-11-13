// Cold-start benchmark: launches a Kimochi binary several times, waits for each launch's
// `{check: "startup"}` record in evidence.jsonl (src-tauri/src/boot.rs, frontend/entries/boot.ts),
// quits it, and prints the medians.
//
//   node scripts/startup-bench.mjs [binary] [--runs 5] [--settle 1500] [--json]
//
// `binary` defaults to the debug build (src-tauri/target/debug/kimochi[.exe]); on macOS it may be a
// `.app` bundle. A debug binary built by `tauri dev` loads its pages from the dev server, which
// must already be running (`node node_modules/vite/bin/vite.js --config vite.dev.config.ts`).
// The runs use the real app data directory (settings, dictionaries), as a launch by hand would.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const IDENTIFIER = 'dev.kimochi.app'
const root = fileURLToPath(new URL('../', import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function dataDir(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData/Roaming'), IDENTIFIER)
  if (platform === 'darwin') return path.join(home, 'Library/Application Support', IDENTIFIER)
  return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local/share'), IDENTIFIER)
}

/** The `startup` records in `text` (evidence.jsonl lines), oldest first. */
export function startupRecords(text) {
  const records = []
  for (const line of text.split('\n')) {
    if (!line.includes('"startup"')) continue
    try {
      const value = JSON.parse(line)
      if (value.check === 'startup' && value.launch !== false) records.push(value)
    } catch {
      /* A partly written line. */
    }
  }
  return records
}

/** One flat row of timings (ms since process start) from a startup record. */
export function flatten(record) {
  const row = {}
  for (const [name, ms] of Object.entries(record.native ?? {})) row[name] = ms
  for (const [name, ms] of Object.entries(record.web ?? {})) row[`web:${name}`] = ms
  return row
}

export function median(values) {
  const sorted = values.filter((v) => typeof v === 'number').sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** Medians per mark across rows, ordered by when each mark happens. */
export function summarize(rows) {
  const names = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  return Object.fromEntries(
    names
      .map((name) => [name, median(rows.map((row) => row[name]))])
      .sort((a, b) => (a[1] ?? Infinity) - (b[1] ?? Infinity))
  )
}

function resolveBinary(arg) {
  const exe = process.platform === 'win32' ? 'kimochi.exe' : 'kimochi'
  const file = arg ?? path.join(root, 'src-tauri/target/debug', exe)
  if (file.endsWith('.app')) return path.join(file, 'Contents/MacOS', 'kimochi')
  return file
}

function quit(child) {
  try {
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch {
    /* Already gone. */
  }
}

async function launch(binary, evidence, timeoutMs) {
  const offset = existsSync(evidence) ? statSync(evidence).size : 0
  const child = spawn(binary, [], { stdio: 'ignore', env: { ...process.env } })
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      await sleep(100)
      if (!existsSync(evidence)) continue
      // A rotated log starts over: read it all.
      const buffer = readFileSync(evidence)
      const text = buffer.subarray(buffer.length >= offset ? offset : 0).toString('utf8')
      const found = startupRecords(text).at(-1)
      if (found) return found
    }
    throw Error(`no startup record within ${timeoutMs} ms`)
  } finally {
    quit(child)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name, fallback) => {
    const at = args.indexOf(name)
    if (at < 0) return fallback
    const [value] = args.splice(at, 2).slice(1)
    return value
  }
  const runs = Number(option('--runs', 5))
  const settle = Number(option('--settle', 2000))
  const timeout = Number(option('--timeout', 60000))
  const asJson = args.includes('--json')
  const binary = resolveBinary(args.find((arg) => !arg.startsWith('--')))
  if (!existsSync(binary)) throw Error(`no binary at ${binary}`)
  const evidence = path.join(dataDir(), 'evidence.jsonl')
  const rows = []
  for (let run = 1; run <= runs; run++) {
    await sleep(settle)
    try {
      const record = await launch(binary, evidence, timeout)
      const row = flatten(record)
      rows.push(row)
      if (!asJson)
        console.log(
          `run ${run}: ready ${row['web:ready'] ?? '?'} ms, first paint ${row['web:first-contentful-paint'] ?? '?'} ms`
        )
    } catch (error) {
      console.error(`run ${run}: ${error.message}`)
    }
  }
  const summary = summarize(rows)
  if (asJson) console.log(JSON.stringify({ binary, runs: rows.length, median: summary, rows }, null, 2))
  else {
    console.log(`\n${binary}\nmedian of ${rows.length} launches (ms since process start):`)
    for (const [name, ms] of Object.entries(summary)) console.log(`  ${String(ms).padStart(6)}  ${name}`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
