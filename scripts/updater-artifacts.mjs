// The self-updater's release side: what `src-tauri/src/updater.rs` downloads and how it finds it.
//
//   node scripts/updater-artifacts.mjs sign --target <rust triple> [--profile release|debug] [--out <dir>]
//       After `npm run release:bundle` on this OS: the file the app downloads for each manifest key
//       (macOS: a tar.gz of the .app, made here; Windows: the NSIS installer; Linux: the AppImage,
//       and the .deb for deb installs), its minisign signature (`<asset>.sig`, made with
//       `tauri signer sign`, which reads TAURI_SIGNING_PRIVATE_KEY or _PATH, and _PASSWORD),
//       and a sidecar `updater-<key>.json` naming the asset, its signature and its size. The
//       sidecars, signatures and the macOS tar.gz land in --out (default
//       src-tauri/target/<profile>/updater/); the installer, AppImage and .deb stay where tauri
//       put them and are uploaded as they are.
//
//       Run after every post-processing step (scripts/linux-appimage.mjs repacks the AppImage;
//       Windows Authenticode signing happens inside `tauri build`): the signature must cover the
//       bytes users download, which is why tauri's own `createUpdaterArtifacts` is not used.
//
//   node scripts/updater-artifacts.mjs manifest --version <x.y.z> --tag <vX.Y.Z> --repo <owner/name>
//       --sidecars <dir> --out <file> [--notes <file>] [--date <RFC 3339>]
//       Composes `latest.json` from every platform's sidecar: the document the app fetches from
//       `https://github.com/<repo>/releases/latest/download/latest.json`. Refuses a tag that is
//       not `v<version>` (the app compares versions, not tags: a release whose version was not
//       bumped would never be offered).
//
// Both are dependency-free (node built-ins only) so CI's manifest job needs no `npm ci`.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

/** The updater's `{os}-{arch}` key for a Rust target triple, and the bundles that serve it. */
export function platformKeys(triple) {
  const m = /^(x86_64|aarch64)-(apple-darwin|pc-windows-msvc|unknown-linux-gnu)$/.exec(triple)
  if (!m) throw new Error(`unsupported target: ${triple}`)
  const arch = m[1]
  switch (m[2]) {
    case 'apple-darwin':
      return [{ key: `darwin-${arch}`, bundle: 'app' }]
    case 'pc-windows-msvc':
      return [{ key: `windows-${arch}`, bundle: 'nsis' }]
    default:
      // The plugin looks for `{os}-{arch}-{installer}` first, then `{os}-{arch}`: a .deb
      // install finds its own key, an AppImage the plain one.
      return [
        { key: `linux-${arch}`, bundle: 'appimage' },
        { key: `linux-${arch}-deb`, bundle: 'deb' }
      ]
  }
}

/** tauri's own arch word in bundle file names. */
const archName = (triple) => (triple.startsWith('aarch64') ? 'aarch64' : 'x64')

/**
 * Which file serves each key, given the bundle directory's contents (`files`: relative paths
 * under it). This build's bundles are found by the product name and version in tauri's own
 * file names, so a stale bundle of another name or version beside them is left alone. The
 * macOS entry names the archive this script makes; the rest are tauri's files.
 */
export function plan(triple, version, files, product = 'Kimochi') {
  const one = (dir, what, test) => {
    const found = files.filter((f) => f.startsWith(`${dir}/`) && test(path.basename(f)))
    if (found.length !== 1) throw new Error(`expected one ${what} in ${dir}/, found ${found.length}: ${found.join(', ') || 'none'}`)
    return found[0]
  }
  const versioned = (suffix) => {
    const pattern = new RegExp(`^${escape(product)}_${escape(version)}_[A-Za-z0-9]+${escape(suffix)}$`)
    return (name) => pattern.test(name)
  }
  return platformKeys(triple).map(({ key, bundle }) => {
    switch (bundle) {
      case 'app': {
        const app = one('macos', `${product}.app`, (name) => name === `${product}.app`)
        return { key, bundle, source: app, asset: `${product}_${version}_${archName(triple)}.app.tar.gz`, archive: true }
      }
      case 'nsis': {
        const exe = one('nsis', `${product}_${version}_*-setup.exe`, versioned('-setup.exe'))
        return { key, bundle, source: exe, asset: path.basename(exe), archive: false }
      }
      case 'appimage': {
        const image = one('appimage', `${product}_${version}_*.AppImage`, versioned('.AppImage'))
        return { key, bundle, source: image, asset: path.basename(image), archive: false }
      }
      default: {
        const deb = one('deb', `${product}_${version}_*.deb`, versioned('.deb'))
        return { key, bundle, source: deb, asset: path.basename(deb), archive: false }
      }
    }
  })
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `latest.json`, in the static format `tauri-plugin-updater` reads. */
export function manifest({ version, tag, repo, notes, date, sidecars }) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a version: ${version}`)
  if (tag !== `v${version}`) throw new Error(`tag ${tag} does not match version ${version} (expected v${version})`)
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`not an owner/name repository: ${repo}`)
  if (sidecars.length === 0) throw new Error('no updater sidecars: nothing was signed')
  const platforms = {}
  for (const sidecar of sidecars) {
    const { platform, asset, signature, size } = sidecar
    if (!platform || !asset || !signature) throw new Error(`incomplete sidecar: ${JSON.stringify(sidecar)}`)
    if (platforms[platform]) throw new Error(`two sidecars for ${platform}`)
    platforms[platform] = {
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(asset)}`,
      signature: signature.trim(),
      ...(Number.isInteger(size) && size > 0 ? { size } : {})
    }
  }
  const document = { version, pub_date: date ?? new Date().toISOString(), platforms }
  if (notes) document.notes = notes
  return document
}

// ---------------------------------------------------------------------------- command line

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const eq = arg.indexOf('=')
    if (eq > 0) out[arg.slice(2, eq)] = arg.slice(eq + 1)
    else out[arg.slice(2)] = argv[++i]
  }
  return out
}

const listFiles = async (dir, prefix = '') => {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      // A .app is a directory, but it is the bundle; do not descend.
      if (entry.isDirectory() && !entry.name.endsWith('.app')) return listFiles(path.join(dir, entry.name), rel)
      return [rel]
    })
  )
  return nested.flat()
}

function signFile(file) {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY (or _PATH) is not set; the updater artifacts cannot be signed')
  }
  const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js')
  // The key comes from the environment, never the command line. An unset password makes the
  // CLI prompt for one (and fail without a terminal); an empty one is "no password".
  const env = { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '', ...process.env }
  const result = spawnSync(process.execPath, [cli, 'signer', 'sign', file], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`tauri signer sign failed for ${file} (${result.status})`)
  return `${file}.sig`
}

async function sign(options) {
  const triple = options.target ?? process.env.KIMOCHI_TARGET
  if (!triple) throw new Error('--target <rust triple> (or KIMOCHI_TARGET) is required')
  const profile = options.profile ?? 'release'
  const { version, productName } = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  const bundleDir = path.join(root, 'src-tauri/target', profile, 'bundle')
  const out = path.resolve(options.out ?? path.join(root, 'src-tauri/target', profile, 'updater'))
  await mkdir(out, { recursive: true })
  const entries = plan(triple, version, await listFiles(bundleDir), productName)
  for (const entry of entries) {
    const source = path.join(bundleDir, entry.source)
    let artifact
    if (entry.archive) {
      artifact = path.join(out, entry.asset)
      // The system tar keeps the .app's symlinks, modes and signature; the updater extracts it
      // with the `tar` crate and skips the first path component (`Kimochi.app/`).
      const tar = spawnSync('tar', ['-czf', artifact, '-C', path.dirname(source), path.basename(source)], {
        stdio: 'inherit',
        env: { ...process.env, COPYFILE_DISABLE: '1' }
      })
      if (tar.error) throw tar.error
      if (tar.status !== 0) throw new Error(`tar failed (${tar.status})`)
    } else {
      artifact = source
    }
    const sig = signFile(artifact)
    const signature = (await readFile(sig, 'utf8')).trim()
    if (!entry.archive) await writeFile(path.join(out, `${entry.asset}.sig`), signature)
    const { size } = await stat(artifact)
    const sidecar = { platform: entry.key, asset: entry.asset, signature, size }
    await writeFile(path.join(out, `updater-${entry.key}.json`), JSON.stringify(sidecar, null, 2))
    console.log(`${entry.key}: ${entry.asset} (${size} bytes), signed`)
  }
  console.log(`Updater artifacts in ${out}`)
}

async function compose(options) {
  for (const name of ['version', 'tag', 'repo', 'sidecars', 'out']) {
    if (!options[name]) throw new Error(`--${name} is required`)
  }
  const dir = path.resolve(options.sidecars)
  const names = (await readdir(dir)).filter((name) => /^updater-.*\.json$/.test(name)).sort()
  const sidecars = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(dir, name), 'utf8'))))
  const notes = options.notes && existsSync(options.notes) ? (await readFile(options.notes, 'utf8')).trim() : undefined
  const document = manifest({
    version: options.version,
    tag: options.tag,
    repo: options.repo,
    notes: notes || undefined,
    date: options.date,
    sidecars
  })
  await writeFile(options.out, JSON.stringify(document, null, 2) + '\n')
  console.log(`${options.out}: ${Object.keys(document.platforms).join(', ')}`)
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const [command, ...rest] = process.argv.slice(2)
  const run = { sign, manifest: compose }[command]
  if (!run) {
    console.error('Usage: node scripts/updater-artifacts.mjs <sign|manifest> [--option value ...]')
    process.exit(2)
  }
  run(args(rest)).catch((error) => {
    console.error(error.message ?? error)
    process.exit(1)
  })
}
