import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
process.chdir(fileURLToPath(new URL('../', import.meta.url)))
const env = {
  ...process.env,
  DEVELOPER_DIR: '/Library/Developer/CommandLineTools',
  MACOSX_DEPLOYMENT_TARGET: '14.0'
}
const task = process.argv[2]
// Use an installed local development certificate when available. Never store key material.
if (
  process.platform === 'darwin' &&
  task === 'bundle' &&
  !env.APPLE_SIGNING_IDENTITY &&
  !env.KIMOCHI_ADHOC
) {
  const identities = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8'
  })
  const match = identities.stdout?.match(/([A-F0-9]{40}) "Apple Development:/)
  if (match) {
    env.APPLE_SIGNING_IDENTITY = match[1]
    console.log('Using installed Apple Development identity for this local bundle.')
  }
}

if (task === 'launch') {
  const r = spawnSync('open', ['src-tauri/target/debug/bundle/macos/Kimochi Next POC.app'], {
    stdio: 'inherit',
    env
  })
  process.exit(r.status ?? 1)
}
await import('./prepare.mjs')

// The React panels build into `dist/app/`, after prepare.mjs has rebuilt `dist/` from `yomitan/`
// (it wipes the directory first). `dist/app` exists in neither `yomitan/` nor `ui/`, so the
// extension hash verification is unaffected.
if (task !== 'check') {
  const frontend = spawnSync('node_modules/.bin/vite', ['build'], { stdio: 'inherit', env })
  if (frontend.status !== 0) process.exit(frontend.status ?? 1)
}

const r =
  task === 'check'
    ? spawnSync(
        'cargo',
        [
          'clippy',
          '--manifest-path',
          'src-tauri/Cargo.toml',
          '--features',
          'custom-protocol',
          '--',
          '-D',
          'warnings'
        ],
        { stdio: 'inherit', env }
      )
    : spawnSync('node_modules/.bin/tauri', ['build', '--debug', '--bundles', 'app'], {
        stdio: 'inherit',
        env
      })
process.exit(r.status ?? 1)
