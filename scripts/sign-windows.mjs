// Windows code signing for Tauri's `bundle.windows.signCommand` (src-tauri/tauri.windows.conf.json).
// Tauri runs it once per binary and installer with the file path as the only argument.
//
// Signs through Azure Artifact Signing (formerly Trusted Signing) with `artifact-signing-cli`
// (`cargo install artifact-signing-cli`; the older `trusted-signing-cli` also works). Nothing
// secret is put on the command line: the CLI reads the service principal from the environment.
//
//   AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID   service principal (CI secrets)
//   KIMOCHI_SIGNING_ENDPOINT   e.g. https://eus.codesigning.azure.net
//   KIMOCHI_SIGNING_ACCOUNT    Artifact Signing account name
//   KIMOCHI_SIGNING_PROFILE    certificate profile name
//   ARTIFACT_SIGNING_CLI       optional path/name of the CLI
//   KIMOCHI_REQUIRE_SIGNING=1  fail instead of leaving the file unsigned when anything is missing
//
// Without credentials a local `npm run bundle` still succeeds and produces unsigned output.
import { spawnSync } from 'node:child_process'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/sign-windows.mjs <file>')
  process.exit(2)
}
const required = [
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TENANT_ID',
  'KIMOCHI_SIGNING_ENDPOINT',
  'KIMOCHI_SIGNING_ACCOUNT',
  'KIMOCHI_SIGNING_PROFILE'
]
const missing = required.filter((name) => !process.env[name])
if (missing.length > 0) {
  const message = `Windows signing not configured (missing ${missing.join(', ')}): ${file}`
  if (process.env.KIMOCHI_REQUIRE_SIGNING === '1') {
    console.error(message)
    process.exit(1)
  }
  console.warn(`WARNING: ${message} left unsigned.`)
  process.exit(0)
}

// The CLI signs with a SHA-256 file digest and an RFC 3161 timestamp from the service, which is
// what keeps signatures valid after the short-lived Artifact Signing certificate expires.
const args = [
  '-e',
  process.env.KIMOCHI_SIGNING_ENDPOINT,
  '-a',
  process.env.KIMOCHI_SIGNING_ACCOUNT,
  '-c',
  process.env.KIMOCHI_SIGNING_PROFILE,
  '-d',
  'Kimochi',
  file
]
const candidates = process.env.ARTIFACT_SIGNING_CLI
  ? [process.env.ARTIFACT_SIGNING_CLI]
  : ['artifact-signing-cli', 'trusted-signing-cli']
for (const cli of candidates) {
  const result = spawnSync(cli, args, { stdio: 'inherit' })
  if (result.error?.code === 'ENOENT') continue
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
console.error(`No signing CLI found (tried ${candidates.join(', ')}).`)
process.exit(1)
