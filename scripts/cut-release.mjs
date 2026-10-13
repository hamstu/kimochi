// Cuts a release: `npm run release -- <x.y.z> [--dry-run]`.
//
// A release is a tag `v<x.y.z>` on main, and the tag is the only thing that makes one: CI
// (.github/workflows/ci.yml) sees it, checks and bundles every platform, and publishes the
// release once all of them are built and signed. This script makes that tag the one way that
// passes CI's own checks:
//
//   1. Refuses unless on `main`, the working tree is clean, and main is exactly `origin/main`
//      after a fetch: the tag must name a commit everyone already has, with nothing local in it.
//   2. Refuses if `v<x.y.z>` exists here or on origin, or if x.y.z is not greater than the
//      version in src-tauri/tauri.conf.json (the app only offers a higher version).
//   3. Sets the version in src-tauri/tauri.conf.json, src-tauri/Cargo.toml ([package]) and
//      src-tauri/Cargo.lock, and moves CHANGELOG.md's Unreleased entries under the version
//      (refusing an empty Unreleased: that section becomes the release notes).
//   4. Commits those four files as "Kimochi x.y.z", tags the commit `v<x.y.z>` (annotated, with
//      the changelog section as its message), and pushes main and the tag together (--atomic,
//      so a rejected push leaves neither on origin).
//
//   --dry-run            every check, then prints the changes and commands; writes nothing.
//   --skip-clean-check   for developing this script only (with --dry-run): skips the clean
//                        working tree check, which any uncommitted work would otherwise fail.
//
// The rewrites are pure functions of the files' text (tested in cut-release.test.mjs); git and
// cargo run only through `git()` and `verifyLockfile()`, and the checks take `git` as a
// parameter so the tests can drive them with a fake.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promoteUnreleased, sectionFor, today } from './changelog.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

// Every file a release changes, relative to the repository root.
export const FILES = {
  tauriConf: 'src-tauri/tauri.conf.json',
  cargoToml: 'src-tauri/Cargo.toml',
  cargoLock: 'src-tauri/Cargo.lock',
  changelog: 'CHANGELOG.md'
}
const CRATE = 'kimochi'

/** `x.y.z` as numbers. Plain releases only: the manifest job and the changelog accept no suffix. */
export function parseVersion(version) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  if (!m) {
    const hint = /^v\d/.test(version) ? ` (without the "v": ${version.slice(1)})` : ''
    throw new Error(`not a version (x.y.z): ${version}${hint}`)
  }
  return m.slice(1).map(Number)
}

/** Negative, zero or positive as `a` is lower than, equal to or higher than `b`. */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/** tauri.conf.json's top-level `version`, rewritten in place so the file's layout is kept. */
export function bumpTauriConf(text, version) {
  const current = JSON.parse(text).version
  if (typeof current !== 'string') throw new Error(`${FILES.tauriConf} has no "version"`)
  // The first "version" key is the top-level one in tauri's own layout; the parse below proves it.
  const next = text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`)
  if (JSON.parse(next).version !== version) throw new Error(`could not set "version" in ${FILES.tauriConf}`)
  return { current, text: next }
}

/** Cargo.toml's `version` under `[package]` (not a dependency's, not another table's). */
export function bumpCargoToml(text, version) {
  const table = /^\[package\][ \t]*\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)
  if (!table) throw new Error(`${FILES.cargoToml} has no [package] table`)
  const line = /^version[ \t]*=[ \t]*"([^"]*)"/m.exec(table[1])
  if (!line) throw new Error(`${FILES.cargoToml} [package] has no version`)
  const at = table.index + table[0].length - table[1].length + line.index
  return {
    current: line[1],
    text: `${text.slice(0, at)}version = "${version}"${text.slice(at + line[0].length)}`
  }
}

/**
 * Cargo.lock's entry for this crate: the same one-line change `cargo update -p kimochi` makes
 * (verifyLockfile runs cargo afterwards to confirm). Computed here so a dry run can show it
 * without touching the file.
 */
export function bumpCargoLock(text, version, crate = CRATE) {
  const pattern = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${crate}"\\r?\\nversion = )"([^"]*)"`, 'g')
  const matches = [...text.matchAll(pattern)]
  if (matches.length !== 1) throw new Error(`expected one "${crate}" package in ${FILES.cargoLock}, found ${matches.length}`)
  return { current: matches[0][2], text: text.replace(pattern, `$1"${version}"`) }
}

/** `owner/name` from an origin URL (https or ssh), for the links printed at the end. */
export function githubRepo(url) {
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? m[1] : null
}

/**
 * Everything a release of `version` changes, from the files' current text: the new text of each
 * file, the release notes, and the commit and tag. Throws when the release cannot be cut.
 */
export function planRelease({ version, date, files }) {
  parseVersion(version)
  const conf = bumpTauriConf(files.tauriConf, version)
  if (compareVersions(version, conf.current) <= 0) {
    throw new Error(`${version} is not greater than the current version ${conf.current} (${FILES.tauriConf})`)
  }
  const toml = bumpCargoToml(files.cargoToml, version)
  const lock = bumpCargoLock(files.cargoLock, version)
  // The three should agree already; a mismatch means someone bumped one by hand.
  for (const [file, found] of [[FILES.cargoToml, toml.current], [FILES.cargoLock, lock.current]]) {
    if (found !== conf.current) throw new Error(`${file} says ${found} but ${FILES.tauriConf} says ${conf.current}: make them agree first`)
  }
  const changelog = promoteUnreleased(files.changelog, version, date)
  const notes = sectionFor(changelog, version)
  const tag = `v${version}`
  return {
    current: conf.current,
    version,
    date,
    tag,
    notes,
    files: { tauriConf: conf.text, cargoToml: toml.text, cargoLock: lock.text, changelog },
    commitMessage: `Kimochi ${version}`,
    tagMessage: `Kimochi ${version}\n\n${notes}\n`
  }
}

/**
 * The repository checks, in the order a person would want to hear about them. `git(args)` runs
 * git and returns `{ status, stdout, stderr }`. Throws with what to do on the first that fails.
 */
export function preflight({ tag, git, skipClean = false }) {
  const out = (args) => {
    const result = git(args)
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`)
    return result.stdout.trimEnd()
  }
  const branch = git(['symbolic-ref', '--short', '-q', 'HEAD'])
  const name = branch.status === 0 ? branch.stdout.trim() : '(detached HEAD)'
  if (name !== 'main') throw new Error(`releases are cut from main; this checkout is on ${name}`)

  if (!skipClean) {
    const dirty = out(['status', '--porcelain'])
    if (dirty) throw new Error(`the working tree is not clean; commit or stash first:\n${dirty}`)
  }

  out(['fetch', '--quiet', 'origin', 'main'])
  const head = out(['rev-parse', 'HEAD'])
  const upstream = out(['rev-parse', 'refs/remotes/origin/main'])
  if (head !== upstream) {
    const [ahead, behind] = out(['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/origin/main']).split(/\s+/)
    throw new Error(
      `main is ${ahead} commit(s) ahead of and ${behind} behind origin/main; ` +
        'push or pull first, so the release commit sits on what everyone already has'
    )
  }

  if (git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status === 0) {
    throw new Error(`tag ${tag} already exists here (git tag -d ${tag} if it is a leftover)`)
  }
  if (out(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) {
    throw new Error(`tag ${tag} already exists on origin: that version has been released`)
  }
  return { head }
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}

/**
 * Asks cargo to bring Cargo.lock in line with the new Cargo.toml and checks it agrees with the
 * line bumpCargoLock already wrote: offline, and only this crate's entry, so no dependency moves
 * as a side effect of a release.
 */
function verifyLockfile(expected) {
  const result = spawnSync(
    'cargo',
    ['update', '-p', CRATE, '--offline', '--quiet', '--manifest-path', path.join(root, FILES.cargoToml)],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] }
  )
  if (result.error) throw new Error(`cargo update failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`cargo update -p ${CRATE} --offline failed (${result.status})`)
  if (readFileSync(path.join(root, FILES.cargoLock), 'utf8') !== expected) {
    throw new Error(`cargo changed ${FILES.cargoLock} beyond the version line; look at \`git diff\``)
  }
}

function main(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')))
  const positional = argv.filter((arg) => !arg.startsWith('--'))
  const known = new Set(['--dry-run', '--skip-clean-check'])
  const unknown = [...flags].filter((flag) => !known.has(flag))
  if (positional.length !== 1 || unknown.length) {
    console.error('Usage: npm run release -- <x.y.z> [--dry-run]')
    process.exit(2)
  }
  const dryRun = flags.has('--dry-run')
  const skipClean = flags.has('--skip-clean-check')
  if (skipClean && !dryRun) throw new Error('--skip-clean-check is for developing this script, with --dry-run only')

  const read = (file) => readFileSync(path.join(root, file), 'utf8')
  const original = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, read(file)]))
  const plan = planRelease({ version: positional[0], date: today(), files: original })
  preflight({ tag: plan.tag, git, skipClean })

  const remote = git(['remote', 'get-url', 'origin']).stdout
  const repo = githubRepo(remote ?? '')
  const push = ['push', '--atomic', 'origin', 'main', `refs/tags/${plan.tag}`]

  console.log(`Kimochi ${plan.current} → ${plan.version}`)
  console.log(`\nRelease notes (CHANGELOG.md → ${plan.tag}):\n\n${plan.notes}\n`)
  if (dryRun) {
    console.log('Dry run: nothing written. A real run would:')
    for (const file of [FILES.tauriConf, FILES.cargoToml, FILES.cargoLock]) console.log(`  set the version in ${file}`)
    console.log(`  move CHANGELOG.md's Unreleased entries under ## [${plan.version}] - ${plan.date}`)
    console.log(`  cargo update -p ${CRATE} --offline (to confirm ${FILES.cargoLock})`)
    console.log(`  git commit -m "${plan.commitMessage}" -- ${Object.values(FILES).join(' ')}`)
    console.log(`  git tag -a ${plan.tag} (message: "${plan.commitMessage}" and the notes above)`)
    console.log(`  git ${push.join(' ')}`)
    if (skipClean) console.log('(--skip-clean-check: the working tree was not checked; a real run requires it clean)')
    return
  }

  // Write, confirm with cargo, and put everything back if any of it fails before the commit.
  try {
    for (const [key, file] of Object.entries(FILES)) writeFileSync(path.join(root, file), plan.files[key])
    verifyLockfile(plan.files.cargoLock)
  } catch (error) {
    for (const [key, file] of Object.entries(FILES)) writeFileSync(path.join(root, file), original[key])
    throw error
  }

  const step = (args) => {
    const result = git(args)
    if (result.status !== 0) throw new Error(`git ${args[0]} failed:\n${(result.stderr || result.stdout).trim()}`)
  }
  step(['commit', '--quiet', '-m', plan.commitMessage, '--', ...Object.values(FILES)])
  // verbatim: git's default cleanup would strip the changelog's `### Added` lines as comments.
  step(['tag', '-a', plan.tag, '--cleanup=verbatim', '-m', plan.tagMessage])
  console.log(`Committed "${plan.commitMessage}" and tagged ${plan.tag}; pushing…`)
  const pushed = git(push)
  if (pushed.status !== 0) {
    console.error((pushed.stderr || '').trim())
    throw new Error(
      `the push was rejected, so nothing reached origin. Retry with \`git ${push.join(' ')}\`, ` +
        `or undo with \`git tag -d ${plan.tag} && git reset --hard HEAD~1\``
    )
  }
  console.log(`Pushed main and ${plan.tag}. CI now checks and bundles every platform, then publishes the release.`)
  if (repo) {
    console.log(`Watch: https://github.com/${repo}/actions/workflows/ci.yml?query=branch%3A${plan.tag}`)
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`Release not cut: ${error.message ?? error}`)
    process.exit(1)
  }
}
