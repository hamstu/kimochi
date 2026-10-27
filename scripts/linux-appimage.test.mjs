import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hashOverlapsHeaders, spaPlugins, verifyDictionaryImages } from './linux-appimage.mjs'

// Minimal ELF64 section metadata, using the real failed library's header/hash offsets.
function elf(programHeaders, hashOffset = 0x1f0) {
  const bytes = Buffer.alloc(1024)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  bytes.writeBigUInt64LE(64n, 32)
  bytes.writeBigUInt64LE(0x300n, 40)
  bytes.writeUInt16LE(56, 54)
  bytes.writeUInt16LE(programHeaders, 56)
  bytes.writeUInt16LE(64, 58)
  bytes.writeUInt16LE(2, 60)
  bytes.writeUInt16LE(0, 62)
  bytes.writeBigUInt64LE(0x390n, 0x300 + 24)
  bytes.write('.gnu.hash\0', 0x390)
  bytes.writeBigUInt64LE(BigInt(hashOffset), 0x340 + 24)
  return bytes
}

test('GNU hash remains safe until an added program header overlaps it', () => {
  assert.equal(hashOverlapsHeaders(elf(7)), false)
  assert.equal(hashOverlapsHeaders(elf(8)), true)
  assert.equal(hashOverlapsHeaders(elf(8, 0x200)), false)
})
test('non-ELF and incomplete section tables are ignored', () => {
  assert.equal(hashOverlapsHeaders(Buffer.from('plain text')), false)
  assert.equal(hashOverlapsHeaders(elf(8).subarray(0, 100)), false)
})

// A finished AppDir: libavif in usr/lib, and an AppRun whose `--check-avif` answer `run` fakes.
async function appdir(t, { libavif = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kimochi-appdir-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'usr/lib'), { recursive: true })
  if (libavif) await writeFile(path.join(root, 'usr/lib/libavif.so.16'), '')
  return root
}
const answers = (status, stdout) => (command, args) => {
  assert.match(command, /AppRun$/)
  assert.equal(args[0], '--check-avif')
  assert.match(args[1], /sample\.avif$/)
  return { status, stdout, stderr: '' }
}
const decoded = 'AVIF ok: sample.avif decoded to a 140-byte PNG with libavif 1.0.4 (dav1d [dec]:1.4.1, aom [enc/dec]:3.8.2)'

test('an AppDir whose binary decodes AVIF with a bundled AV1 decoder passes', async (t) => {
  await verifyDictionaryImages(await appdir(t), answers(0, decoded))
})

test('an AppDir without libavif, a decode, or an AV1 decoder fails the build', async (t) => {
  await assert.rejects(verifyDictionaryImages(await appdir(t, { libavif: false }), answers(0, decoded)), /carries no libavif/)
  await assert.rejects(verifyDictionaryImages(await appdir(t), answers(1, 'AVIF check failed: AVIF decode failed: No codec available')), /cannot decode AVIF: .*No codec/)
  await assert.rejects(verifyDictionaryImages(await appdir(t), answers(0, 'AVIF ok: sample.avif with libavif 1.0.4 (rav1e [enc]:0.7.1)')), /no AV1 decoder/)
})

test('the AppImage carries the PipeWire plugins an audio stream needs', () => {
  // Sentence audio's capture stream cannot be made without audioconvert (SPA_PLUGIN_DIR is the bundle's).
  assert.ok(spaPlugins.includes('support'))
  assert.ok(spaPlugins.includes('audioconvert'))
})
