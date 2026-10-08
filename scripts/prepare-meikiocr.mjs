/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Build-time JavaScript. */
// Stage self-contained native assets. Nothing here runs on an end user's machine.
//
//   node scripts/prepare-meikiocr.mjs [--target <rust-triple>] [--with-models]
//
// Stages the ONNX Runtime (bundled) and the licences. The models are downloaded by the app on
// demand; `--with-models` (or KIMOCHI_WITH_MODELS=1) also stages a development copy of them.
//
// The target defaults to the host (or KIMOCHI_TARGET). Every archive is extracted in-process
// (gzip/tar and zip/nupkg readers below), so a Windows builder needs no `tar` or `unzip`.
// MEIKIOCR_DEST overrides the staging directory (default src-tauri/resources/meikiocr).
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const root = fileURLToPath(new URL('../', import.meta.url))
const destination = path.resolve(
  process.env.MEIKIOCR_DEST ?? path.join(root, 'src-tauri/resources/meikiocr')
)

// Rust target triples this script can stage a runtime for.
const TARGETS = {
  'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64' },
  'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64' },
  'x86_64-pc-windows-msvc': { platform: 'win32', arch: 'x64' },
  'aarch64-pc-windows-msvc': { platform: 'win32', arch: 'arm64' },
  'x86_64-unknown-linux-gnu': { platform: 'linux', arch: 'x64' },
  'aarch64-unknown-linux-gnu': { platform: 'linux', arch: 'arm64' }
}

function requestedTarget() {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') return argv[i + 1]
    if (argv[i].startsWith('--target=')) return argv[i].slice('--target='.length)
  }
  if (process.env.KIMOCHI_TARGET) return process.env.KIMOCHI_TARGET
  // MEIKIOCR_ARCH predates --target and still selects the architecture on the host OS.
  const arch = process.env.MEIKIOCR_ARCH ?? process.arch
  const host = Object.entries(TARGETS).find(
    ([, t]) => t.platform === process.platform && t.arch === arch
  )
  if (!host) throw new Error(`No MeikiOCR runtime for host ${process.platform}/${arch}`)
  return host[0]
}

const target = requestedTarget()
if (!TARGETS[target]) {
  throw new Error(
    `Unsupported MeikiOCR target "${target}". Supported: ${Object.keys(TARGETS).join(', ')}`
  )
}
const { platform, arch } = TARGETS[target]
const version = platform === 'darwin' && arch === 'arm64' ? '1.30.0' : '1.22.0'
const flavor = process.env.MEIKIOCR_RUNTIME_FLAVOR ?? (platform === 'win32' ? 'directml' : 'cpu')
if (!['cpu', 'directml', 'cuda'].includes(flavor)) {
  throw new Error(`Unknown MEIKIOCR_RUNTIME_FLAVOR "${flavor}" (cpu, directml or cuda)`)
}
if (flavor === 'directml' && platform !== 'win32') throw new Error('DirectML is Windows-only')
if (flavor === 'cuda' && (platform === 'darwin' || arch !== 'x64')) {
  throw new Error('CUDA runtime requires Windows or Linux on x64')
}
// 3: Windows DirectML staging gained DirectML.dll and the marker records the target triple.
const packagingVersion = 3

// SHA-256 of every archive this script downloads. An archive missing from this table is
// refused unless it is an opt-in CUDA build, which is staged with a loud warning instead.
const checksums = {
  'onnxruntime-osx-arm64-1.30.0.tgz':
    '6ebb5062a934537c352937821f9fe9718e7de1a2db1122a93dd363ffd53a7012',
  'onnxruntime-osx-x86_64-1.22.0.tgz':
    'e4ec94a7696de74fb1b12846569aa94e499958af6ffa186022cfde16c9d617f0',
  'Microsoft.ML.OnnxRuntime.DirectML.1.22.0.nupkg':
    'b38d92c31d202d1dc772af9416fe30b6abae8527651e742c380c2d131e5f1817',
  'Microsoft.AI.DirectML.1.15.4.nupkg':
    '4e7cb7ddce8cf837a7a75dc029209b520ca0101470fcdf275c1f49736a3615b9',
  'onnxruntime-win-x64-1.22.0.zip':
    '174c616efc0271194488642a72f1a514e01487da4dfe84c49296d66e40ebe0da',
  'onnxruntime-win-arm64-1.22.0.zip':
    '7008f7ff82f8e7de563a22f2b590e08e706a1289eba606b93de2b56edfb1e04b',
  'onnxruntime-linux-x64-1.22.0.tgz':
    '8344d55f93d5bc5021ce342db50f62079daf39aaafb5d311a451846228be49b3',
  'onnxruntime-linux-aarch64-1.22.0.tgz':
    'bb76395092d150b52c7092dc6b8f2fe4d80f0f3bf0416d2f269193e347e24702'
}

// The models are not bundled: the app downloads them on demand (src-tauri/src/model_store.rs)
// from the pinned list in src-tauri/ocr-models.json. `--with-models` (or KIMOCHI_WITH_MODELS=1)
// also stages them here, where a development build finds them without downloading.
const withModels =
  process.argv.includes('--with-models') || process.env.KIMOCHI_WITH_MODELS === '1'
const { files: models } = JSON.parse(
  await readFile(path.join(root, 'src-tauri/ocr-models.json'), 'utf8')
).engines.meikiocr

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) })
  if (!response.ok) throw new Error(`MeikiOCR download failed (${response.status}): ${url}`)
  return Buffer.from(await response.arrayBuffer())
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function download(archive, url) {
  const bytes = await get(url)
  const expected = checksums[archive]
  if (expected) {
    if (sha(bytes) !== expected) throw new Error(`Archive checksum mismatch: ${archive}`)
  } else if (/-gpu-/.test(archive)) {
    console.warn(
      `WARNING: ${archive} is not hash-pinned (CUDA runtimes are opt-in). ` +
        `Downloaded SHA-256 ${sha(bytes)}; add it to the checksums table to pin it.`
    )
  } else {
    throw new Error(
      `Refusing unpinned archive ${archive} (SHA-256 ${sha(bytes)}). ` +
        'Verify it and add it to the checksums table in scripts/prepare-meikiocr.mjs.'
    )
  }
  return bytes
}

// ---- Archive readers -------------------------------------------------------------------------
// Both return { names(), read(name) -> { data, mode } } with paths normalised to `a/b/c`.

const clean = (name) => name.replace(/^\.\//, '').replace(/\/+$/, '')

function openTarGz(bytes) {
  const buf = zlib.gunzipSync(bytes)
  const entries = new Map()
  let offset = 0
  let longName = null
  let longLink = null
  let pax = {}
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const field = (start, end) =>
      header.subarray(start, end).toString('utf8').replace(/\0[\s\S]*$/, '')
    const octal = (start, end) => parseInt(field(start, end).trim() || '0', 8)
    let name = field(0, 100)
    const prefix = header.subarray(257, 262).toString() === 'ustar' ? field(345, 500) : ''
    if (prefix) name = `${prefix}/${name}`
    const size = octal(124, 136)
    const type = String.fromCharCode(header[156] || 48)
    const data = buf.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'L' || type === 'K') {
      const value = data.toString('utf8').replace(/\0[\s\S]*$/, '')
      if (type === 'L') longName = value
      else longLink = value
      continue
    }
    if (type === 'x') {
      for (const record of data.toString('utf8').split('\n')) {
        const match = /^\d+ ([^=]+)=(.*)$/.exec(record)
        if (match) pax[match[1]] = match[2]
      }
      continue
    }
    if (type === 'g') continue
    entries.set(clean(pax.path ?? longName ?? name), {
      type,
      mode: octal(100, 108) & 0o777,
      link: pax.linkpath ?? longLink ?? field(157, 257),
      data
    })
    longName = longLink = null
    pax = {}
  }
  return {
    names: () => [...entries.keys()],
    read(name) {
      // Dereference symbolic ('2', relative to the entry) and hard ('1', archive path) links.
      let current = clean(name)
      for (let hops = 0; hops < 16; hops++) {
        const entry = entries.get(current)
        if (!entry) return null
        if (entry.type === '2') {
          current = clean(path.posix.normalize(path.posix.join(path.posix.dirname(current), entry.link)))
        } else if (entry.type === '1') current = clean(entry.link)
        else if (entry.type === '0' || entry.type === '7') return { data: entry.data, mode: entry.mode }
        else return null
      }
      throw new Error(`Too many links resolving ${name}`)
    }
  }
}

function openZip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a zip archive (no end of central directory)')
  let count = buf.readUInt16LE(eocd + 10)
  let directory = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || directory === 0xffffffff) {
    const locator = eocd - 20
    if (buf.readUInt32LE(locator) !== 0x07064b50) throw new Error('Corrupt zip64 locator')
    const record = Number(buf.readBigUInt64LE(locator + 8))
    if (buf.readUInt32LE(record) !== 0x06064b50) throw new Error('Corrupt zip64 record')
    count = Number(buf.readBigUInt64LE(record + 32))
    directory = Number(buf.readBigUInt64LE(record + 48))
  }
  const entries = new Map()
  let p = directory
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip central directory')
    const nameLength = buf.readUInt16LE(p + 28)
    const extraLength = buf.readUInt16LE(p + 30)
    const commentLength = buf.readUInt16LE(p + 32)
    const entry = {
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      compressed: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      mode: (buf.readUInt32LE(p + 38) >>> 16) & 0o777,
      local: buf.readUInt32LE(p + 42)
    }
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength)
    // Zip64 extended information: present only for the fields that overflowed, in this order.
    let extra = p + 46 + nameLength
    const extraEnd = extra + extraLength
    while (extra + 4 <= extraEnd) {
      const id = buf.readUInt16LE(extra)
      const length = buf.readUInt16LE(extra + 2)
      if (id === 0x0001) {
        let q = extra + 4
        for (const key of ['size', 'compressed', 'local']) {
          if (entry[key] === 0xffffffff) {
            entry[key] = Number(buf.readBigUInt64LE(q))
            q += 8
          }
        }
      }
      extra += 4 + length
    }
    entries.set(clean(name), entry)
    p += 46 + nameLength + extraLength + commentLength
  }
  return {
    names: () => [...entries.keys()],
    read(name) {
      const entry = entries.get(clean(name))
      if (!entry) return null
      const local = entry.local
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`Corrupt zip entry ${name}`)
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
      const raw = buf.subarray(start, start + entry.compressed)
      let data
      if (entry.method === 0) data = raw
      else if (entry.method === 8) data = zlib.inflateRawSync(raw)
      else throw new Error(`Unsupported zip compression method ${entry.method}: ${name}`)
      if (data.length !== entry.size) throw new Error(`Zip entry size mismatch: ${name}`)
      if (zlib.crc32 && zlib.crc32(data) !== entry.crc) throw new Error(`Zip CRC mismatch: ${name}`)
      return { data, mode: entry.mode || 0o644 }
    }
  }
}

const openArchive = (archive, bytes) =>
  archive.endsWith('.tgz') ? openTarGz(bytes) : openZip(bytes)

// ---- Runtime selection -----------------------------------------------------------------------

const ortRelease = (archive) =>
  `https://github.com/microsoft/onnxruntime/releases/download/v${version}/${archive}`
// `._*` are AppleDouble resource forks that macOS-built tarballs can carry.
const isLicense = (name) => !name.startsWith('._') && /license|notice|thirdparty/i.test(name)
const library = { darwin: 'libonnxruntime.dylib', win32: 'onnxruntime.dll', linux: 'libonnxruntime.so' }[
  platform
]
const required = flavor === 'directml' ? [library, 'DirectML.dll'] : [library]
// Linux's archive exposes both the SONAME and versioned library through links.
// Keep those names in the bundle too; extract() resolves them to regular files.
if (platform === 'linux') required.push(`${library}.1`, `${library}.${version}`)

/** Copy the selected files and top-level licences out of one archive into `install`. */
async function extract(install, archive, bytes, { dir, pick, top, licensePrefix = '' }) {
  const reader = openArchive(archive, bytes)
  const names = reader.names()
  const picked = names.filter(
    (name) => path.posix.dirname(name) === dir && pick(path.posix.basename(name))
  )
  if (picked.length === 0) throw new Error(`Nothing to stage from ${archive} (${dir})`)
  for (const name of picked) {
    const file = reader.read(name)
    if (!file) continue // a directory or an unsupported link type
    await writeFile(path.join(install, path.posix.basename(name)), file.data, { mode: file.mode })
  }
  for (const name of names) {
    if (path.posix.dirname(name) !== top || !isLicense(path.posix.basename(name))) continue
    const file = reader.read(name)
    if (file) await writeFile(path.join(install, licensePrefix + path.posix.basename(name)), file.data)
  }
}

async function stageRuntime(install) {
  const nativeArch = { arm64: 'arm64', x64: 'x64' }[arch]
  const pinned = []
  if (platform === 'darwin') {
    const archive = `onnxruntime-osx-${arch === 'x64' ? 'x86_64' : 'arm64'}-${version}.tgz`
    const bytes = await download(archive, ortRelease(archive))
    pinned.push([archive, bytes])
    const base = archive.replace('.tgz', '')
    await extract(install, archive, bytes, {
      dir: `${base}/lib`,
      pick: (name) => name === library,
      top: base
    })
  } else if (flavor === 'directml') {
    const archive = `Microsoft.ML.OnnxRuntime.DirectML.${version}.nupkg`
    const bytes = await download(archive, ortRelease(archive))
    pinned.push([archive, bytes])
    await extract(install, archive, bytes, {
      dir: `runtimes/win-${nativeArch}/native`,
      pick: (name) => name === 'onnxruntime.dll' || name === 'onnxruntime_providers_shared.dll',
      top: '.'
    })
    // onnxruntime.dll imports DirectML.dll; ship the exact version the package declares.
    const reader = openZip(bytes)
    const nuspec = reader
      .names()
      .find((name) => !name.includes('/') && name.endsWith('.nuspec'))
    const declared = /<dependency\s+id="Microsoft\.AI\.DirectML"\s+version="([^"]+)"/.exec(
      reader.read(nuspec).data.toString('utf8')
    )?.[1]
    if (!declared) throw new Error(`${archive} does not declare a Microsoft.AI.DirectML version`)
    const directmlVersion = declared.replace(/[[\]()\s]/g, '').split(',')[0]
    const directml = `Microsoft.AI.DirectML.${directmlVersion}.nupkg`
    const directmlBytes = await download(
      directml,
      `https://www.nuget.org/api/v2/package/Microsoft.AI.DirectML/${directmlVersion}`
    )
    pinned.push([directml, directmlBytes])
    await extract(install, directml, directmlBytes, {
      dir: `bin/${nativeArch}-win`,
      pick: (name) => name === 'DirectML.dll',
      top: '.',
      licensePrefix: 'DirectML-'
    })
  } else {
    const os = platform === 'win32' ? 'win' : 'linux'
    const cpuArch = platform === 'linux' && arch === 'arm64' ? 'aarch64' : nativeArch
    const extension = platform === 'win32' ? 'zip' : 'tgz'
    const archive = `onnxruntime-${os}-${cpuArch}${flavor === 'cuda' ? '-gpu' : ''}-${version}.${extension}`
    const bytes = await download(archive, ortRelease(archive))
    pinned.push([archive, bytes])
    const base = archive.replace(/\.(zip|tgz)$/, '')
    await extract(install, archive, bytes, {
      dir: `${base}/lib`,
      pick: (name) =>
        platform === 'win32'
          ? /\.dll$/i.test(name)
          : name === library || name.startsWith(`${library}.`) || /providers.*\.so$/.test(name),
      top: base
    })
  }
  await writeFile(
    path.join(install, 'archive-sha256.txt'),
    pinned.map(([archive, bytes]) => `${sha(bytes)}  ${archive}\n`).join('')
  )
}

// ---- Models ----------------------------------------------------------------------------------

if (withModels) {
  await mkdir(path.join(destination, 'models'), { recursive: true })
  for (const { name, url, sha256: expected, size } of models) {
    const file = path.join(destination, 'models', name)
    const existing = await readFile(file).catch(() => null)
    if (existing && sha(existing) === expected) continue
    const bytes = await get(url)
    if (bytes.length !== size || sha(bytes) !== expected) {
      throw new Error(`Model checksum mismatch: ${name}`)
    }
    await writeFile(`${file}.tmp`, bytes)
    await rename(`${file}.tmp`, file)
  }
}

// ---- Runtime ---------------------------------------------------------------------------------

const runtime = path.join(destination, 'runtime')
const override = process.env.MEIKIOCR_RUNTIME_DIR
const marker = JSON.stringify({
  packagingVersion,
  version,
  target,
  flavor,
  override: override ?? null
})
const markerFile = path.join(runtime, 'build.json')
const current = await readFile(markerFile, 'utf8').catch(() => '')
const present = async () => {
  for (const name of required) {
    if (!(await access(path.join(runtime, name)).then(() => true, () => false))) return false
  }
  return true
}
// A packaging-version-2 marker (no triple) describes byte-identical macOS and Linux staging, so
// adopt it rather than re-download: on macOS the staged dylib has also been re-signed in place.
const legacy = JSON.stringify({
  packagingVersion: 2,
  version,
  platform,
  arch,
  flavor,
  override: override ?? null
})
if (current !== marker && current === legacy && platform !== 'win32' && (await present())) {
  await writeFile(markerFile, marker)
} else if (current !== marker || !(await present())) {
  const stage = await mkdtemp(path.join(tmpdir(), 'kimochi-meikiocr-'))
  try {
    const install = path.join(stage, 'install')
    await mkdir(install)
    if (override) {
      await cp(path.resolve(override), install, { recursive: true, dereference: true })
    } else {
      await stageRuntime(install)
    }
    for (const name of required) {
      await access(path.join(install, name)).catch(() => {
        throw new Error(`MeikiOCR runtime for ${target} is missing ${name}`)
      })
    }
    await writeFile(path.join(install, 'build.json'), marker)
    await rm(runtime, { recursive: true, force: true })
    await cp(install, runtime, { recursive: true })
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
await cp(path.join(root, '../kimochi-meikiocr/LICENSE'), path.join(destination, 'LICENSE'))
await cp(path.join(root, '../kimochi-meikiocr/NOTICE'), path.join(destination, 'NOTICE'))
console.log(
  withModels
    ? `MeikiOCR models (development copy, not bundled) and ${target} (${flavor}) runtime ready.`
    : `MeikiOCR ${target} (${flavor}) runtime ready for bundling; models download on demand.`
)
