#!/usr/bin/env node
// A development build for someone to try: CI's trial release bundles (a manual run of ci.yml with
// `bundles`, the same optimised, signed bundles a release builds, published nowhere) for one
// platform, copied to the download mirror under `dev/<name>/`:
// https://downloads.kimochiapp.com/dev/<name>/<file>. Nothing is released, tagged or announced, and
// the app's updater never offers these (they are not in `app/latest.json`).
//
//   node scripts/dev-build.mjs --ref <branch> [--platform linux-x64] [--name <folder>]
//       Starts the run on <branch> (pushed) for that platform alone (ci.yml's `platform` input:
//       its checks and bundle only), waits for the bundle, uploads it.
//   node scripts/dev-build.mjs --run <run id> [--platform …] [--name …]
//       Uploads from a run already started (or finished): `gh workflow run ci.yml --ref <branch>
//       -f bundles=true [-f platform=linux-x64]`). A run on `main` waits behind main's own CI run
//       (one concurrency group per ref), so start it on a branch.
//   --dry-run   downloads and lists what would be uploaded, uploads nothing
//
// Platforms: linux-x64 (AppImage and .deb; the Steam Deck takes the AppImage), linux-arm64,
// windows-x64, windows-arm64, macos. The folder defaults to <date>-<branch>-<commit>.
//
// Needs `gh` (signed in, with Actions access) and Cloudflare's `cf` CLI (`npm i -g cf`), signed in
// (`cf auth login`) to the account that owns the bucket. `cf` uploads at most 300 MB per file.
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ACCOUNT_ID, BUCKET, MIRROR } from './download-mirror.mjs'

export const PLATFORMS = {
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', files: /\.(AppImage|deb)$/ },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', files: /\.(AppImage|deb)$/ },
  'windows-x64': { target: 'x86_64-pc-windows-msvc', files: /-setup\.exe$/ },
  'windows-arm64': { target: 'aarch64-pc-windows-msvc', files: /-setup\.exe$/ },
  macos: { target: 'aarch64-apple-darwin', files: /\.app\.zip$/ }
}
const CF_LIMIT = 300 * 1024 * 1024

/** A folder name from a date, branch and commit: `2026-11-19-fix-wine-8-723ef04`. */
export function folderName(date, branch, sha) {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return [date.toISOString().slice(0, 10), slug, sha.slice(0, 7)].filter(Boolean).join('-')
}

/** Whether a name is safe as one path segment of a public URL. */
export const safeName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)

export function contentType(file) {
  if (file.endsWith('.AppImage')) return 'application/vnd.appimage'
  if (file.endsWith('.deb')) return 'application/vnd.debian.binary-package'
  if (file.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable'
  if (file.endsWith('.zip')) return 'application/zip'
  if (file.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}

function run(command, args, { capture = true } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr ?? ''}`)
  return result.stdout ?? ''
}
const gh = (...args) => run('gh', args)
const json = (...args) => JSON.parse(gh(...args))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function startRun(ref, platform) {
  const before = new Date(Date.now() - 5000).toISOString()
  gh('workflow', 'run', 'ci.yml', '--ref', ref, '-f', 'bundles=true', '-f', `platform=${platform}`)
  for (let i = 0; i < 30; i++) {
    await sleep(4000)
    const runs = json(
      'run',
      'list',
      '--workflow',
      'ci.yml',
      '--event',
      'workflow_dispatch',
      '--branch',
      ref,
      '--limit',
      '5',
      '--json',
      'databaseId,createdAt'
    )
    const started = runs.find((r) => r.createdAt >= before)
    if (started) return started.databaseId
  }
  throw new Error('the run did not appear; see `gh run list --workflow ci.yml`')
}

/** Waits for the run's artifact for `target`, or fails when the run ends without it. */
async function waitForArtifact(runId, target) {
  const name = `Kimochi-${target}`
  let last = ''
  for (;;) {
    const info = json('run', 'view', String(runId), '--json', 'status,conclusion,url,jobs')
    const { artifacts } = json('api', `repos/{owner}/{repo}/actions/runs/${runId}/artifacts?per_page=100`)
    if (artifacts.some((a) => a.name === name && !a.expired)) return { name, info }
    if (info.status === 'completed')
      throw new Error(`run ${runId} ended (${info.conclusion}) without ${name}: ${info.url}`)
    const job = info.jobs.find((j) => j.name.includes('Bundle') && j.status !== 'completed') ?? info.jobs.at(-1)
    const now = `${info.status}${job ? `: ${job.name} (${job.status})` : ''}`
    if (now !== last) console.log(`  ${now}`)
    last = now
    await sleep(30_000)
  }
}

async function filesUnder(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(path.join(entry.parentPath ?? entry.path, entry.name))
  }
  return out
}

function upload(key, file) {
  run('cf', [
    'r2',
    'objects',
    'put',
    key,
    '--bucket-name',
    BUCKET,
    '--file',
    file,
    '--content-type',
    contentType(file),
    '--quiet'
  ])
}

function args(argv) {
  const options = { platform: 'linux-x64', dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--dry-run') options.dryRun = true
    else if (['--ref', '--run', '--platform', '--name'].includes(flag)) options[flag.slice(2)] = argv[++i]
    else throw new Error(`unknown argument: ${flag}`)
  }
  if (!options.ref === !options.run) throw new Error('pass --ref <branch> or --run <run id>')
  if (!PLATFORMS[options.platform]) throw new Error(`--platform: one of ${Object.keys(PLATFORMS).join(', ')}`)
  if (options.name && !safeName(options.name)) throw new Error('--name: letters, digits, dots, dashes and underscores')
  return options
}

async function main() {
  const options = args(process.argv.slice(2))
  const platform = PLATFORMS[options.platform]
  process.env.CLOUDFLARE_ACCOUNT_ID ||= ACCOUNT_ID
  if (!options.dryRun) run('cf', ['auth', 'whoami'])

  const runId = options.run ?? (await startRun(options.ref, options.platform))
  const meta = json('run', 'view', String(runId), '--json', 'headBranch,headSha,url,event')
  console.log(`Run ${runId} (${meta.headBranch} @ ${meta.headSha.slice(0, 7)}): ${meta.url}`)
  if (meta.event !== 'workflow_dispatch')
    console.log('  (not a manual run: only manual runs with `bundles` and tag runs build bundles)')
  const { name: artifact } = await waitForArtifact(runId, platform.target)

  const work = await mkdtemp(path.join(os.tmpdir(), 'kimochi-dev-build-'))
  try {
    gh('run', 'download', String(runId), '--name', artifact, '--dir', work)
    // The bundles themselves; not `trial-updater/` (updater archives and signatures).
    const files = (await filesUnder(work)).filter((f) => !f.includes(`${path.sep}trial-updater${path.sep}`))
    const bundles = files.filter((f) => platform.files.test(f))
    if (!bundles.length) throw new Error(`${artifact} has no ${platform.files} file`)
    const folder = options.name ?? folderName(new Date(), meta.headBranch, meta.headSha)
    const uploaded = []
    for (const file of bundles) {
      const { size } = await stat(file)
      if (size > CF_LIMIT) throw new Error(`${path.basename(file)} is ${size} bytes, over cf's 300 MB upload limit`)
      const key = `dev/${folder}/${path.basename(file)}`
      console.log(`${options.dryRun ? 'would upload' : 'uploading'} ${key} (${(size / 1048576).toFixed(1)} MB)`)
      if (!options.dryRun) upload(key, file)
      uploaded.push({ name: path.basename(file), size, url: `${MIRROR}/${key}` })
    }
    // What the folder holds and where it came from, beside it.
    const about = {
      branch: meta.headBranch,
      commit: meta.headSha,
      run: meta.url,
      platform: options.platform,
      built: new Date().toISOString(),
      files: uploaded
    }
    const aboutFile = path.join(work, 'build.json')
    await writeFile(aboutFile, `${JSON.stringify(about, null, 2)}\n`)
    if (!options.dryRun) upload(`dev/${folder}/build.json`, aboutFile)
    console.log(`\n${options.dryRun ? 'Would be' : 'Ready'} at:`)
    for (const file of uploaded) console.log(`  ${file.url}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message ?? error)
    process.exit(1)
  })
}
