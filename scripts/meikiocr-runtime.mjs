// What a staged MeikiOCR runtime is: the target, ONNX Runtime version and flavor that
// prepare-meikiocr.mjs stages for, and the `build.json` marker it writes once staging is complete.
// Shared with scripts/run.mjs, which restages before `npm run dev` when the staged runtime is not
// the one this host needs (an x64 runtime left in a Windows ARM64 checkout, say).
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

// Rust target triples prepare-meikiocr.mjs can stage a runtime for.
export const TARGETS = {
  'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64' },
  'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64' },
  'x86_64-pc-windows-msvc': { platform: 'win32', arch: 'x64' },
  'aarch64-pc-windows-msvc': { platform: 'win32', arch: 'arm64' },
  'x86_64-unknown-linux-gnu': { platform: 'linux', arch: 'x64' },
  'aarch64-unknown-linux-gnu': { platform: 'linux', arch: 'arm64' }
}

// 3: Windows DirectML staging gained DirectML.dll and the marker records the target triple.
// 4: the CPU runtime comes from Microsoft's NuGet package (the GitHub archives are gone, #250).
export const PACKAGING_VERSION = 4

/** The staging directory (MEIKIOCR_DEST, default src-tauri/resources/meikiocr). */
export const meikiocrDestination = (env = process.env) =>
  path.resolve(env.MEIKIOCR_DEST ?? path.join(root, 'src-tauri/resources/meikiocr'))

function requestedTarget(argv, env, hostPlatform, hostArch) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') return argv[i + 1]
    if (argv[i].startsWith('--target=')) return argv[i].slice('--target='.length)
  }
  if (env.KIMOCHI_TARGET) return env.KIMOCHI_TARGET
  // MEIKIOCR_ARCH predates --target and still selects the architecture on the host OS.
  const arch = env.MEIKIOCR_ARCH ?? hostArch
  const host = Object.entries(TARGETS).find(([, t]) => t.platform === hostPlatform && t.arch === arch)
  if (!host) throw new Error(`No MeikiOCR runtime for host ${hostPlatform}/${arch}`)
  return host[0]
}

/**
 * The runtime prepare-meikiocr.mjs would stage for these arguments and environment: its target,
 * the files it must hold, and the `build.json` marker (plus the older marker it adopts in place).
 */
export function runtimeIdentity({
  argv = process.argv.slice(2),
  env = process.env,
  platform: hostPlatform = process.platform,
  arch: hostArch = process.arch
} = {}) {
  const target = requestedTarget(argv, env, hostPlatform, hostArch)
  if (!TARGETS[target]) {
    throw new Error(`Unsupported MeikiOCR target "${target}". Supported: ${Object.keys(TARGETS).join(', ')}`)
  }
  const { platform, arch } = TARGETS[target]
  const version = platform === 'darwin' && arch === 'arm64' ? '1.30.0' : '1.22.0'
  const flavor = env.MEIKIOCR_RUNTIME_FLAVOR ?? (platform === 'win32' ? 'directml' : 'cpu')
  if (!['cpu', 'directml', 'cuda'].includes(flavor)) {
    throw new Error(`Unknown MEIKIOCR_RUNTIME_FLAVOR "${flavor}" (cpu, directml or cuda)`)
  }
  if (flavor === 'directml' && platform !== 'win32') throw new Error('DirectML is Windows-only')
  if (flavor === 'cuda' && (platform === 'darwin' || arch !== 'x64')) {
    throw new Error('CUDA runtime requires Windows or Linux on x64')
  }
  const override = env.MEIKIOCR_RUNTIME_DIR ?? null
  const library = { darwin: 'libonnxruntime.dylib', win32: 'onnxruntime.dll', linux: 'libonnxruntime.so' }[platform]
  const required = flavor === 'directml' ? [library, 'DirectML.dll'] : [library]
  // Linux's archive exposes both the SONAME and versioned library through links.
  // Keep those names in the bundle too; prepare-meikiocr resolves them to regular files.
  if (platform === 'linux') required.push(`${library}.1`, `${library}.${version}`)
  const fields = { packagingVersion: PACKAGING_VERSION, version, target, flavor, override }
  // A packaging-version-2 marker (no triple) describes byte-identical macOS and Linux staging;
  // prepare-meikiocr adopts it rather than re-download.
  const legacy = JSON.stringify({ packagingVersion: 2, version, platform, arch, flavor, override })
  return { ...fields, platform, arch, library, required, marker: JSON.stringify(fields), legacy }
}

const exists = (file) =>
  access(file).then(
    () => true,
    () => false
  )

/**
 * Why the runtime staged in `runtimeDir` is not the one `identity` describes, or null when it is.
 * The reason reads after "MeikiOCR runtime ", e.g. "built for x86_64-pc-windows-msvc".
 */
export async function runtimeMismatch(runtimeDir, identity) {
  const current = await readFile(path.join(runtimeDir, 'build.json'), 'utf8').catch(() => null)
  if (current === null) return 'not staged yet'
  let staged
  try {
    staged = JSON.parse(current)
  } catch {
    return 'has an unreadable build.json'
  }
  const adoptable = current === identity.legacy && identity.platform !== 'win32'
  if (current !== identity.marker && !adoptable) {
    if (!staged || typeof staged !== 'object') return 'has an unreadable build.json'
    const builtFor = staged.target ?? (staged.platform && `${staged.platform}/${staged.arch}`)
    if (builtFor !== identity.target) return `built for ${builtFor ?? 'an unknown target'}, not ${identity.target}`
    if (staged.packagingVersion !== identity.packagingVersion) {
      return `packaging version ${staged.packagingVersion}, not ${identity.packagingVersion}`
    }
    for (const key of ['version', 'flavor', 'override']) {
      if ((staged[key] ?? null) !== identity[key]) {
        return `${key} ${JSON.stringify(staged[key] ?? null)}, not ${JSON.stringify(identity[key])}`
      }
    }
    return 'has a build.json prepare-meikiocr does not write'
  }
  for (const name of identity.required) {
    if (!(await exists(path.join(runtimeDir, name)))) return `is missing ${name}`
  }
  // An adoptable legacy marker still goes through prepare-meikiocr, which rewrites it in place.
  return adoptable ? `has the packaging-version-2 marker` : null
}
