// The `kimochi` command's launcher on Windows (cli-launcher/), built for this machine's own
// architecture and staged for the bundle. Settings > Command line copies it to the user's `bin`
// folder as kimochi.exe (src-tauri/src/cli/install.rs). Windows only: elsewhere the command is the
// app's own executable.
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const destination = path.join(root, 'src-tauri/resources/cli')

if (process.platform === 'win32') {
  await mkdir(destination, { recursive: true })
  const built = spawnSync(
    'cargo',
    ['build', '--locked', '--release', '--manifest-path', path.join(root, 'cli-launcher/Cargo.toml')],
    { stdio: 'inherit' }
  )
  if (built.error) throw built.error
  if (built.status !== 0) throw new Error(`The command-line launcher failed to build (${built.status}).`)
  await copyFile(
    path.join(root, 'cli-launcher/target/release/kimochi-cli.exe'),
    path.join(destination, 'kimochi-cli.exe')
  )
  console.log('Command-line launcher staged.')
}
