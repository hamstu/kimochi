/**
 * The Log footer's reading time (frontend/texthooker/core/stats.ts): a run of reading counts from
 * its first line to its last, plus at most the AFK threshold after it, whether the AFK timer has
 * fired yet or the computer slept in between.
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const AFK_SEC = 60
const ENV_KEY = '__kimochiReadingTimeTestEnv'

const built = await build({
  entryPoints: [fileURLToPath(new URL('../frontend/texthooker/core/stats.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'stand-ins',
      setup(builder) {
        // Only the file system and the settings are replaced; the timing is the real module's.
        builder.onResolve(
          { filter: /^(?:\.\/files|\.\/profile|@tauri-apps\/plugin-fs|\.\.\/lib\/settings)$/ },
          (args) => ({
            path: args.path,
            namespace: 'stand-in'
          })
        )
        builder.onLoad({ filter: /.*/, namespace: 'stand-in' }, () => ({
          contents: `const env = globalThis[${JSON.stringify(ENV_KEY)}];
            export const BaseDirectory = { AppLocalData: 1 };
            export const inProfile = (p) => p;
            export const exists = async () => false, mkdir = async () => {}, readTextFile = async () => '';
            export const writeTextFile = async () => {};
            export const getSettings = () => ({ afkThresholdSec: env.afkSec });
            export const onSettingsChange = () => () => {};`
        }))
      }
    }
  ]
})
const source = built.outputFiles[0].text

async function freshStats() {
  globalThis[ENV_KEY] = { afkSec: AFK_SEC }
  return import(`data:text/javascript;base64,${Buffer.from(`${source}\n//${crypto.randomUUID()}`).toString('base64')}`)
}

const SEC = 1000
const MIN = 60 * SEC

/** A line every `gap` for `ms`, starting now. */
function readFor(stats, ms, gap = 30 * SEC) {
  for (let t = 0; t <= ms; t += gap) {
    stats.recordLine(10)
    if (t < ms) mock.timers.tick(gap)
  }
}

test.beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 }))
test.afterEach(() => mock.timers.reset())

test('a long run of reading keeps its time once the reader goes AFK', async () => {
  const stats = await freshStats()
  // Thirty minutes of reading, a line every 30 seconds.
  readFor(stats, 30 * MIN)
  assert.equal(stats.snapshotStats().elapsedMs, 30 * MIN)
  // The reader stops; the AFK timer fires a minute after the last line.
  mock.timers.tick(AFK_SEC * SEC)
  assert.equal(stats.isRunning(), false)
  assert.equal(stats.snapshotStats().elapsedMs, 30 * MIN + AFK_SEC * SEC)
  // Time away adds nothing.
  mock.timers.tick(10 * MIN)
  assert.equal(stats.snapshotStats().elapsedMs, 30 * MIN + AFK_SEC * SEC)
})

test('a later run adds to the earlier one, and the gap between them adds only the AFK tail', async () => {
  const stats = await freshStats()
  readFor(stats, 5 * MIN)
  mock.timers.tick(20 * MIN)
  readFor(stats, 2 * MIN)
  mock.timers.tick(30 * MIN)
  assert.equal(stats.snapshotStats().elapsedMs, 5 * MIN + AFK_SEC * SEC + 2 * MIN + AFK_SEC * SEC)
})

test("time asleep isn't counted, before or after the AFK timer catches up", async () => {
  const stats = await freshStats()
  readFor(stats, 4 * MIN)
  // The laptop sleeps for an hour: the clock moves on but no timer has run yet.
  mock.timers.setTime(Date.now() + 60 * MIN)
  assert.equal(stats.isRunning(), true)
  assert.equal(stats.snapshotStats().elapsedMs, 4 * MIN + AFK_SEC * SEC)
  mock.timers.tick(AFK_SEC * SEC)
  assert.equal(stats.isRunning(), false)
  assert.equal(stats.snapshotStats().elapsedMs, 4 * MIN + AFK_SEC * SEC)
})

test('a line after a sleep the AFK timer missed starts a new run instead of counting the sleep', async () => {
  const stats = await freshStats()
  readFor(stats, 4 * MIN)
  mock.timers.setTime(Date.now() + 60 * MIN)
  stats.recordLine(10)
  assert.equal(stats.snapshotStats().elapsedMs, 4 * MIN + AFK_SEC * SEC)
  mock.timers.tick(30 * SEC)
  stats.recordLine(10)
  assert.equal(stats.snapshotStats().elapsedMs, 4 * MIN + AFK_SEC * SEC + 30 * SEC)
})

const client = await build({
  entryPoints: [fileURLToPath(new URL('../frontend/texthooker/lib/stats.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'bridge-stand-in',
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/bridge$/ }, (args) => ({ path: args.path, namespace: 'stand-in' }))
        builder.onLoad({ filter: /.*/, namespace: 'stand-in' }, () => ({
          contents: `const env = globalThis[${JSON.stringify(ENV_KEY)}];
            export const getSnapshot = () => env.snapshot, snapshotAge = () => env.age;
            export const call = async () => {}, subscribe = () => () => {};`
        }))
      }
    }
  ]
})

/** lib/stats.ts, as a window other than the Log reads the footer: `snapshot` received `age` ago. */
async function clientStats(snapshot, age) {
  globalThis[ENV_KEY] = { snapshot, age }
  const source = `${client.outputFiles[0].text}\n//${crypto.randomUUID()}`
  const lib = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  return lib.snapshotStats()
}

test('a window ticking a copy of the footer stops where the Log would', async () => {
  const stats = await freshStats()
  readFor(stats, 2 * MIN)
  assert.equal(stats.snapshotStats().runningLeftMs, AFK_SEC * SEC)
  const later = await clientStats({ stats: stats.snapshotStats(), running: stats.isRunning() }, 60 * MIN)
  assert.equal(later.elapsedMs, 2 * MIN + AFK_SEC * SEC)
  const soon = await clientStats({ stats: stats.snapshotStats(), running: stats.isRunning() }, 10 * SEC)
  assert.equal(soon.elapsedMs, 2 * MIN + 10 * SEC)
})
