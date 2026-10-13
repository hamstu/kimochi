// Build-time provisioning only; screenshots and inference never use the network.
//
//   node scripts/prepare-mangaocr.mjs [--target <rust-triple>] [--with-models]
//
// Stages the licences and the upstream model manifest, which are bundled. The models themselves
// are not: the app downloads them on demand (src-tauri/src/model_store.rs) from the pinned list in
// src-tauri/ocr-models.json. `--with-models` (or KIMOCHI_WITH_MODELS=1) also stages a development
// copy of them here, where a development build finds them without downloading.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { ocrCrateDir } from './ocr-crates.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
// Accepted for symmetry with prepare-meikiocr.mjs (`--target <rust-triple>` or KIMOCHI_TARGET).
// The Manga OCR models are platform-neutral safetensors, so the target only labels the output.
const argv = process.argv.slice(2)
const flag = argv.findIndex((arg) => arg === '--target' || arg.startsWith('--target='))
const target =
  (flag < 0 ? undefined : argv[flag].includes('=') ? argv[flag].split('=')[1] : argv[flag + 1]) ??
  process.env.KIMOCHI_TARGET ??
  'host'
const withModels = argv.includes('--with-models') || process.env.KIMOCHI_WITH_MODELS === '1'
// The mangaocr source Cargo builds from (the pinned revision, or a local override).
const library = ocrCrateDir('mangaocr')
const { files } = JSON.parse(
  await readFile(path.join(root, 'src-tauri/ocr-models.json'), 'utf8')
).engines.mangaocr
const destination = path.join(root, 'src-tauri/resources/mangaocr')
const models = path.join(destination, 'models')
const local = process.env.MANGAOCR_MODEL_DIR ?? path.join(library, 'models')

async function sha(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function verified(file, expected) {
  try {
    return (await sha(file)) === expected
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

await mkdir(destination, { recursive: true })
if (withModels) {
  await mkdir(models, { recursive: true })
  for (const { name, url, sha256: expected } of files) {
    const target = path.join(models, name)
    if (await verified(target, expected)) continue
    const stage = `${target}.${process.pid}.tmp`
    try {
      const cached = path.join(local, name)
      if (await verified(cached, expected)) {
        await cp(cached, stage)
      } else {
        console.log(`Downloading Manga OCR ${name}…`)
        const response = await fetch(url, {
          signal: AbortSignal.timeout(300000)
        })
        if (!response.ok || !response.body)
          throw new Error(`Manga OCR download failed (${response.status}): ${name}`)
        await pipeline(Readable.fromWeb(response.body), createWriteStream(stage, { flags: 'wx' }))
      }
      if (!(await verified(stage, expected))) throw new Error(`Manga OCR checksum mismatch: ${name}`)
      await rename(stage, target)
    } finally {
      await rm(stage, { force: true })
    }
  }
}
for (const name of ['LICENSE', 'LICENSE-APACHE', 'NOTICE']) {
  await cp(path.join(library, name), path.join(destination, name))
}
await cp(
  path.join(library, 'scripts/model-manifest.json'),
  path.join(destination, 'model-manifest.json')
)
console.log(
  withModels
    ? `Manga OCR verified models staged for development (not bundled; target: ${target}).`
    : `Manga OCR licences ready for bundling (target: ${target}); models download on demand.`
)
