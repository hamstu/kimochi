// Points git at the repository's hooks (.githooks/: format and lint what is committed), on
// `npm install`. Leaves a hooks path someone set themselves alone, and does nothing outside a git
// checkout (an npm pack, a CI cache restore without .git).
import { spawnSync } from 'node:child_process'

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' })
if (process.env.CI || git('rev-parse', '--git-dir').status !== 0) process.exit(0)
const current = git('config', '--get', 'core.hooksPath').stdout.trim()
if (current && current !== '.githooks') {
  console.warn(`core.hooksPath is ${current}; not installing .githooks (see CONTRIBUTING.md).`)
} else if (!current) {
  git('config', 'core.hooksPath', '.githooks')
}
