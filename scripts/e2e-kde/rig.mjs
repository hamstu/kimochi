// Node side of rig.sh: the session's windows, input, screenshots and the kimochi CLI.
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const here = new URL('.', import.meta.url).pathname
const sh = (...args) =>
  execFileSync(join(here, 'rig.sh'), args.map(String), { encoding: 'utf8', maxBuffer: 64 << 20 }).trim()
export const RIG = process.env.KIMOCHI_KDE_RIG ?? join(process.env.TMPDIR ?? '/tmp', 'kimochi-kde-rig')

export const rig = {
  sh,
  up: (env = {}) => execFileSync(join(here, 'rig.sh'), ['up'], { stdio: 'inherit', env: { ...process.env, ...env } }),
  app: (...args) => sh('app', ...args),
  target: (...args) => sh('target', ...args),
  /** Fake pointer and keys. Each call is its own input device: keys still down when it ends are
   * released (KWin drops the device), so hold a key and check things in the same call, or `hold`. */
  input: (...args) => sh('input', ...args),
  /** `input` in the background, for a key held while the caller checks things; resolves at its end. */
  hold: (...args) =>
    new Promise((resolve) =>
      spawn(join(here, 'rig.sh'), ['input', ...args.map(String)], { stdio: 'ignore' }).on('exit', resolve)
    ),
  shot: (file) => sh('shot', file),
  js: (code) => sh('js', code),
  /** Every managed window: caption, class, pid, id, frame and client rectangles, state. */
  windows() {
    const out = sh(
      'js',
      `for (const w of workspace.windowList()) out({caption: w.caption, class: w.resourceClass, pid: w.pid,
      id: w.internalId.toString(), frame: w.frameGeometry, client: w.clientGeometry, minimized: w.minimized, active: w.active,
      normal: w.normalWindow, layer: w.layer, output: w.output && w.output.name})`
    )
    return out ? out.split('\n').map((l) => JSON.parse(l)) : []
  },
  k(...args) {
    return sh('k', ...args)
  },
  kjson(...args) {
    return JSON.parse(sh('k', ...args, '--json'))
  },
  log: (name) => {
    try {
      return readFileSync(join(RIG, 'log', name), 'utf8')
    } catch {
      return ''
    }
  },
  evidence() {
    try {
      return readFileSync(join(RIG, 'data', 'dev.kimochi.app', 'evidence.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return null
          }
        })
        .filter(Boolean)
    } catch {
      return []
    }
  },
  /** The fake game's latest self-report (target.py): its client size and text rectangles. */
  targetLayout() {
    const lines = rig
      .log('target.log')
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('{'))
    return lines.length ? JSON.parse(lines.at(-1)) : null
  },
  /** How many button presses the fake game has received. */
  targetClicks() {
    return rig
      .log('target.log')
      .split('\n')
      .filter((l) => l.startsWith('click ')).length
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export async function until(what, check, { timeout = 20000, every = 250 } = {}) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      last = await check()
      if (last) return last
    } catch (e) {
      last = e
    }
    await sleep(every)
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`)
}
