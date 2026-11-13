// The pre-commit hook (.githooks/pre-commit, installed by scripts/install-hooks.mjs on `npm
// install`): formats the staged version of each committed file with oxfmt or rustfmt, then lints
// the staged JavaScript and TypeScript with oxlint.
//
// It works on the index only, never stashing or rewriting work that is not being committed:
// several sessions may share one working tree, and a file can be staged in part. Each staged
// file is copied out of the index into a scratch tree, formatted there and written back to the
// index; the working copy is updated too, but only when it matched what was staged.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const git = (args, options = {}) => {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, ...options })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

const root = git(['rev-parse', '--show-toplevel']).trim()
const formatted = /\.(?:[cm]?[jt]sx?|json|jsonc|css|html|ya?ml)$/
const linted = /\.(?:[cm]?[jt]sx?)$/
// Staged files, with their mode, blob and path ("<mode> <blob> <stage>\t<path>").
const staged = new Map()
const names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean)
if (names.length) {
  for (const line of git(['ls-files', '--stage', '-z', '--', ...names], { cwd: root }).split('\0')) {
    const match = /^(\d+) ([0-9a-f]+) 0\t(.+)$/s.exec(line)
    if (match) staged.set(match[3], { mode: match[1], blob: match[2] })
  }
}
const files = [...staged.keys()].filter((file) => formatted.test(file) || file.endsWith('.rs'))
if (!files.length) process.exit(0)

const scratch = mkdtempSync(path.join(tmpdir(), 'kimochi-pre-commit-'))
let failed = false
try {
  git(['checkout-index', `--prefix=${scratch}${path.sep}`, '--', ...files], { cwd: root })
  for (const config of ['.oxfmtrc.json', '.oxlintrc.json', 'rustfmt.toml']) {
    if (existsSync(path.join(root, config))) copyFileSync(path.join(root, config), path.join(scratch, config))
  }
  const bin = (name) => path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)
  const tool = (command, args, input) =>
    spawnSync(command, args, {
      cwd: scratch,
      input,
      encoding: 'utf8',
      stdio: input === undefined ? 'inherit' : 'pipe',
      shell: process.platform === 'win32' && command.endsWith('.cmd')
    })

  const web = files.filter((file) => formatted.test(file))
  if (web.length) {
    // oxfmt applies .oxfmtrc.json's ignore patterns and overrides to these relative paths.
    const result = tool(bin('oxfmt'), ['--no-error-on-unmatched-pattern', ...web], '')
    if (result.status !== 0) {
      process.stderr.write(result.stdout + result.stderr)
      failed = true
    }
  }
  for (const file of files.filter((name) => name.endsWith('.rs'))) {
    if (file.startsWith('src-tauri/patches/')) continue
    // From stdin, so rustfmt formats this file alone (its `mod` children may not be staged).
    const result = tool(
      'rustfmt',
      ['--edition', '2021', '--config-path', 'rustfmt.toml', '--emit', 'stdout'],
      readFileSync(path.join(scratch, file), 'utf8')
    )
    if (result.error) {
      console.error(`pre-commit: rustfmt could not run (${result.error.message}); Rust files left as staged.`)
      break
    }
    if (result.status !== 0) {
      process.stderr.write(result.stderr)
      failed = true
      continue
    }
    writeFileSync(path.join(scratch, file), result.stdout)
  }

  // Back into the index (and the working copy, where it held exactly what was staged).
  const changed = []
  for (const file of files) {
    const { mode, blob } = staged.get(file)
    const next = git(['hash-object', '-w', '--path', file, path.join(scratch, file)], { cwd: root }).trim()
    if (next === blob) continue
    git(['update-index', '--cacheinfo', `${mode},${next},${file}`], { cwd: root })
    const working = path.join(root, file)
    if (existsSync(working) && git(['hash-object', '--path', file, working], { cwd: root }).trim() === blob) {
      copyFileSync(path.join(scratch, file), working)
    }
    changed.push(file)
  }
  if (changed.length) console.log(`pre-commit: formatted ${changed.length} staged file(s): ${changed.join(', ')}`)

  const scripts = files.filter((file) => linted.test(file))
  if (scripts.length && tool(bin('oxlint'), ['--deny-warnings', ...scripts]).status !== 0) {
    console.error('pre-commit: oxlint found problems in the staged files (commit with --no-verify to skip).')
    failed = true
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
