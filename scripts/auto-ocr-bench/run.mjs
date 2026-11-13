#!/usr/bin/env node
// Auto OCR end-to-end bench: a fake VN in a browser window, read by a real Kimochi build that is
// driven only through its own command line (no synthetic input). For every line the game posts
// when it finished painting; the Log's `line` event says when Kimochi published it.
//
//   KIMOCHI_BENCH_EXE=<app executable> node scripts/auto-ocr-bench/run.mjs <plan.json> <out-dir>
//
// plan.json: { "label": "...", "engines": ["livetext", ...], "scenarios": [{ "name", "query",
//   "settings"?: { "autoOCRSettings.pollInterval": 250, ... } }], "repeat"?: 1 }
// Use an isolated identity (scripts/e2e-windows/tauri.e2e.json): the bench changes the engine,
// Auto OCR settings and sessions of the app it drives.
import http from 'node:http'
import os from 'node:os'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const [planPath, outDir] = process.argv.slice(2)
if (!planPath || !outDir) {
  console.error('usage: run.mjs <plan.json> <out-dir>')
  process.exit(2)
}
const plan = JSON.parse(readFileSync(planPath, 'utf8'))
const exe = process.env.KIMOCHI_BENCH_EXE
if (!exe || !existsSync(exe)) throw new Error('set KIMOCHI_BENCH_EXE to the app executable')
mkdirSync(outDir, { recursive: true })
const PORT = +(process.env.KIMOCHI_BENCH_PORT || 47811)
const win = process.platform === 'win32'
var browserPid = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- the CLI
// The command line looks the app up by the release identifier, and a write with no app running
// falls back to that identifier's settings file. Every write is guarded: the app answering must
// be the isolated test profile, or the bench stops before touching anything.
const ISOLATED = process.env.KIMOCHI_BENCH_PROFILE_MATCH || 'dev.kimochi.e2e'
function guard() {
  const r = spawnSync(exe, ['status', '--json', '--no-start'], { encoding: 'utf8', timeout: 30000 })
  const s = r.status === 0 ? JSON.parse(r.stdout) : null
  if (!s?.running || !String(s.profileDir ?? '').includes(ISOLATED))
    throw new Error(`refusing to drive an app that is not the isolated profile (${s?.profileDir ?? 'not running'})`)
}
function cli(...args) {
  if (!['status', 'watch'].includes(args[0])) guard()
  const r = spawnSync(exe, [...args, '--no-start'], { encoding: 'utf8', timeout: 60000 })
  if (r.status !== 0) throw new Error(`kimochi ${args.join(' ')} → ${r.status}: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

// ---------------------------------------------------------------- truth server
const truth = []
let nextQuery = ''
let current = ''
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'POST' && url.pathname === '/truth') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const rec = JSON.parse(body)
        rec.recvAt = Date.now()
        truth.push(rec)
      } catch {
        /* a malformed record is dropped */
      }
      res.end('ok')
    })
    return
  }
  if (url.pathname === '/next') {
    const q = nextQuery && url.searchParams.get('after') !== current ? nextQuery : ''
    return res.end(q)
  }
  if (url.pathname === '/' || url.pathname === '/game.html') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(readFileSync(path.join(here, 'game.html')))
  }
  res.statusCode = 404
  res.end()
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

// ---------------------------------------------------------------- CPU accounting
function systemTimes() {
  let busy = 0
  let total = 0
  for (const c of os.cpus()) {
    const t = c.times
    busy += t.user + t.nice + t.sys + t.irq
    total += t.user + t.nice + t.sys + t.irq + t.idle
  }
  return { busy, total }
}
// CPU seconds used so far by the app and the helpers OCR runs in.
const HELPER = /^kimochi|screenai|mediaanalysisd|VisionKit|oneocr/i
function processCpu() {
  const out = {}
  if (win) {
    const ps = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-Process | Where-Object { $_.CPU -ne $null } | ForEach-Object { "{0}`t{1}`t{2}" -f $_.Id,$_.CPU,$_.ProcessName }'
      ],
      { encoding: 'utf8' }
    ).stdout
    for (const line of ps.split(/\r?\n/)) {
      const [pid, cpu, name] = line.split('\t')
      if (name && HELPER.test(name)) out[`${name}#${pid}`] = +cpu
    }
    return out
  }
  const ps = execFileSync('ps', ['-A', '-o', 'pid=,time=,comm='], { encoding: 'utf8' })
  for (const line of ps.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)
    if (!m || !HELPER.test(path.basename(m[3]))) continue
    // [[dd-]hh:]mm:ss[.cc]
    const [rest, days] = m[2].includes('-') ? [m[2].split('-')[1], +m[2].split('-')[0]] : [m[2], 0]
    const parts = rest.split(':').map(Number)
    let secs = 0
    for (const p of parts) secs = secs * 60 + p
    out[`${path.basename(m[3])}#${m[1]}`] = secs + days * 86400
  }
  return out
}
function cpuDelta(a, b) {
  const by = {}
  for (const [k, v] of Object.entries(b)) {
    const d = v - (a[k] ?? 0)
    if (d > 0.005) by[k.split('#')[0]] = (by[k.split('#')[0]] ?? 0) + d
  }
  return by
}

// ---------------------------------------------------------------- matching
const norm = (t) => (t ?? '').replace(/[\s、。，．・！？!?「」『』（）()…ー〜~▼]/g, '')
function dice(a, b) {
  a = norm(a)
  b = norm(b)
  if (!a || !b) return 0
  const grams = (s) => {
    const m = new Map()
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1)
    return m
  }
  const ga = grams(a)
  const gb = grams(b)
  let hit = 0
  for (const [g, n] of ga) hit += Math.min(n, gb.get(g) ?? 0)
  return (2 * hit) / Math.max(1, a.length - 1 + b.length - 1)
}
const pct = (xs, p) => {
  const s = [...xs].sort((x, y) => x - y)
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : null
}

// ---------------------------------------------------------------- trace
function tracePath() {
  if (process.env.KIMOCHI_BENCH_TRACE) return process.env.KIMOCHI_BENCH_TRACE
  const base = win
    ? path.join(process.env.APPDATA, 'dev.kimochi.e2e')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support/dev.kimochi.e2e')
      : path.join(os.homedir(), '.local/share/dev.kimochi.e2e')
  return path.join(base, 'auto-ocr-trace.jsonl')
}
// The app rotates the trace at 8 MB (auto-ocr-trace.jsonl -> .1.jsonl), so a scenario can span
// both files: read both whole and keep the scenario's time window (the caller filters by time).
function traceSince(file) {
  const rotated = file.replace(/\.jsonl$/, '.1.jsonl')
  return [rotated, file]
    .filter((f) => existsSync(f))
    .flatMap((f) => readFileSync(f, 'utf8').split('\n'))
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// ---------------------------------------------------------------- run
const label = plan.label ?? 'bench'
const results = []
const traceFile = tracePath()
console.log(`trace: ${traceFile}`)

guard()

let first = true
for (let rep = 0; rep < (plan.repeat ?? 1); rep++)
  for (const engine of plan.engines)
    for (const sc of plan.scenarios) {
      const run = `${label}-${engine}-${sc.name}-r${rep}`
      cli('auto-ocr', 'off')
      cli('ocr', engine)
      for (const [k, v] of Object.entries({ ...(plan.settings ?? {}), ...(sc.settings ?? {}) }))
        cli('settings', 'set', k, JSON.stringify(v))
      cli('session', 'new', run)
      const seed = 1 + ((rep * 7 + plan.scenarios.indexOf(sc) * 3 + plan.engines.indexOf(engine) * 11) % 37)
      const query = `${sc.query}&run=${encodeURIComponent(run)}&seed=${seed}`
      current = ''
      nextQuery = query
      if (first) {
        // Open the game window once; later scenarios load into the same window.
        await openGame(`http://127.0.0.1:${PORT}/game.html?${query}`)
        await sleep(2500)
        cli('source', 'set', findGameWindow())
        first = false
      }
      // Wait for the page to pick this scenario up.
      const t0 = Date.now()
      while (!truth.some((r) => r.run === run && r.kind === 'begin')) {
        if (Date.now() - t0 > 30000) throw new Error(`game did not start ${run}`)
        await sleep(100)
      }
      current = run
      nextQuery = ''
      const watcher = spawn(exe, ['watch', 'line', 'scan', 'state'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const events = []
      let buf = ''
      watcher.stdout.on('data', (c) => {
        buf += c
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          try {
            const e = JSON.parse(line)
            e.recvAt = Date.now()
            events.push(e)
          } catch {
            /* not an event line */
          }
        }
      })
      await sleep(300)
      const sys0 = systemTimes()
      const proc0 = processCpu()
      const startedAt = Date.now()
      cli('auto-ocr', 'on')
      while (!truth.some((r) => r.run === run && r.kind === 'end')) await sleep(200)
      const endedAt = Date.now()
      const sys1 = systemTimes()
      const proc1 = processCpu()
      cli('auto-ocr', 'off')
      await sleep(400)
      watcher.kill()

      const lines = truth.filter((r) => r.run === run && r.kind === 'line')
      const logLines = events.filter((e) => e.event === 'line')
      const scans = events.filter((e) => e.event === 'scan')
      const used = new Set()
      const perLine = lines.map((t, idx) => {
        const until = lines[idx + 1]?.shownAt ?? endedAt
        const pick = (list) =>
          list.find((e) => {
            const at = e.at ?? e.recvAt
            return at >= t.shownAt - 50 && at <= until + 1500 && dice(e.text, t.text) >= 0.6 && !used.has(e)
          })
        const log = pick(logLines)
        if (log) used.add(log)
        const scan = scans.find((e) => {
          const at = e.at ?? e.recvAt
          return at >= t.shownAt - 50 && at <= until + 1500 && dice(e.text, t.text) >= 0.6
        })
        return {
          i: t.i,
          chars: [...t.text].length,
          typingMs: t.completeAt - t.shownAt,
          logLatency: log ? (log.at ?? log.recvAt) - t.completeAt : null,
          logAccuracy: log ? Math.round(dice(log.text, t.text) * 100) / 100 : null,
          scanLatency: scan ? (scan.at ?? scan.recvAt) - t.completeAt : null
        }
      })
      const trace = traceSince(traceFile).filter((r) => r.at >= startedAt && r.at <= endedAt)
      const passes = trace.filter((r) => r.kind === 'first-pass')
      const looks = passes.map((r) => r.observerMs).filter((v) => typeof v === 'number' && v > 0)
      const requests = trace.filter(
        (r) => r.kind === 'decision' && r.event?.type === 'request' && r.event.queued === false
      )
      const wall = (endedAt - startedAt) / 1000
      const procCpu = cpuDelta(proc0, proc1)
      const appCpuS = Object.values(procCpu).reduce((a, b) => a + b, 0)
      lines.forEach((t, idx) => {
        const until = lines[idx + 1]?.shownAt ?? endedAt
        // The capture never saw this line's pixels change: the window stopped updating (covered,
        // display asleep), which no scanner can be blamed for. Flagged so a run can be discarded.
        perLine[idx].frozen = !passes.some((r) => r.at >= t.shownAt && r.at < until && r.pixelsChanged === true)
      })
      const results_ = trace.filter(
        (r) => r.kind === 'decision' && r.event?.type === 'result' && (r.event.chars ?? 0) > 0
      )
      lines.forEach((t, idx) => {
        const until = lines[idx + 1]?.shownAt ?? endedAt
        const hit = results_.find((r) => r.at >= t.shownAt && r.at < until) // may precede completeAt: read mid fade
        perLine[idx].overlayLatency = hit ? hit.at - t.completeAt : null
      })
      writeFileSync(
        path.join(outDir, `trace-${run}.json`),
        JSON.stringify({ truth: truth.filter((r) => r.run === run), events, trace })
      )
      const lat = perLine.map((l) => l.logLatency).filter((v) => v !== null)
      const result = {
        run,
        label,
        engine,
        scenario: sc.name,
        query: sc.query,
        settings: { ...(plan.settings ?? {}), ...(sc.settings ?? {}) },
        host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, model: os.cpus()[0]?.model },
        wallS: Math.round(wall * 10) / 10,
        lines: lines.length,
        published: lat.length,
        latency: {
          p50: pct(lat, 0.5),
          p90: pct(lat, 0.9),
          max: lat.length ? Math.max(...lat) : null,
          mean: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null
        },
        overlayLatency: (() => {
          const o = perLine.map((l) => l.overlayLatency).filter((v) => v !== null)
          return { p50: pct(o, 0.5), p90: pct(o, 0.9), max: o.length ? Math.max(...o) : null }
        })(),
        // Busy cores, whole machine (includes the game's browser), and the app + OCR helpers alone.
        systemBusyCores:
          Math.round(((sys1.busy - sys0.busy) / (sys1.total - sys0.total)) * os.cpus().length * 100) / 100,
        appCpuPct: Math.round((appCpuS / wall) * 1000) / 10,
        appCpuByProcess: Object.fromEntries(
          Object.entries(procCpu).map(([k, v]) => [k, Math.round((v / wall) * 1000) / 10])
        ),
        looks: passes.length,
        looksPerS: Math.round((passes.length / wall) * 10) / 10,
        readsPerS: Math.round((looks.length / wall) * 10) / 10,
        observerMs: { p50: pct(looks, 0.5), p90: pct(looks, 0.9) },
        requests: requests.length,
        frozenLines: perLine.filter((l) => l.frozen).length,
        perLine
      }
      results.push(result)
      appendFileSync(path.join(outDir, 'results.jsonl'), JSON.stringify(result) + '\n')
      console.log(
        `${run}: published ${result.published}/${result.lines}  latency p50 ${result.latency.p50} p90 ${result.latency.p90} max ${result.latency.max}  ` +
          `app ${result.appCpuPct}% cpu  looks ${result.looksPerS}/s reads ${result.readsPerS}/s obs p50 ${result.observerMs.p50}ms`
      )
    }

writeFileSync(path.join(outDir, `truth-${label}.json`), JSON.stringify(truth))
nextQuery = 'mode=instant&n=0&start=0&run=closing'
await sleep(1500)
try {
  if (browserPid) process.kill(browserPid)
} catch {
  /* already closed */
}
server.close()
process.exit(0)

// The game's window: by the browser process we started (Chrome's --app title can lag), else title.

function findGameWindow() {
  const listed = cli('source', 'list').split(/\r?\n/)
  const id = (l) => l.match(/\[([^\]]+)\]\s*$/)?.[1]
  const hit =
    listed.find((l) => l.startsWith('window') && /Kimochi Bench VN/.test(l)) ||
    listed.find((l) => l.startsWith('window') && browserPid && new RegExp(`:${browserPid}\\]`).test(l)) ||
    listed.find((l) => l.startsWith('window') && /127\.0\.0\.1/.test(l))
  if (!hit || !id(hit)) throw new Error('the game window is not in `kimochi source list`')
  return id(hit)
}

async function openGame(url) {
  const profile = path.resolve(outDir, 'browser-profile')
  const size = process.env.KIMOCHI_BENCH_WINDOW || '1280,800'
  const browser =
    process.env.KIMOCHI_BENCH_BROWSER ||
    (win
      ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  const child = spawn(
    browser,
    [
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      `--window-size=${size}`,
      '--window-position=80,80',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows'
    ],
    { detached: true, stdio: 'ignore' }
  )
  child.unref()
  browserPid = child.pid
  writeFileSync(path.join(outDir, 'browser.pid'), String(child.pid))
}
