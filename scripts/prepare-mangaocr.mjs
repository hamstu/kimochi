// Build-time provisioning only; screenshots and inference never use the network.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
// Accepted for symmetry with prepare-meikiocr.mjs (`--target <rust-triple>` or KIMOCHI_TARGET).
// The Manga OCR models are platform-neutral safetensors, so the target only labels the output.
const argv = process.argv.slice(2)
const flag = argv.findIndex((arg) => arg === '--target' || arg.startsWith('--target='))
const target =
  (flag < 0 ? undefined : argv[flag].includes('=') ? argv[flag].split('=')[1] : argv[flag + 1]) ??
  process.env.KIMOCHI_TARGET ??
  'host'
const library = path.resolve(root, '../kimochi-mangaocr')
const manifest = JSON.parse(
  await readFile(path.join(library, 'scripts/model-manifest.json'), 'utf8')
)
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

await mkdir(models, { recursive: true })
for (const [name, expected] of Object.entries({ ...manifest.sha256, [manifest.detector.filename]: manifest.detector.sha256 })) {
  const target = path.join(models, name)
  if (await verified(target, expected)) continue
  const stage = `${target}.${process.pid}.tmp`
  try {
    const cached = path.join(local, name)
    if (await verified(cached, expected)) {
      await cp(cached, stage)
    } else {
      console.log(`Downloading Manga OCR ${name}…`)
      const url = name === manifest.detector.filename ? manifest.detector.url : `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${name}`
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
for (const name of ['LICENSE', 'LICENSE-APACHE', 'NOTICE']) {
  await cp(path.join(library, name), path.join(destination, name))
}
await cp(
  path.join(library, 'scripts/model-manifest.json'),
  path.join(destination, 'model-manifest.json')
)
console.log(`Manga OCR verified models ready for offline bundling (target: ${target}).`)
