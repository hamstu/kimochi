import test from 'node:test'
import assert from 'node:assert/strict'
import { hashOverlapsHeaders } from './linux-appimage.mjs'

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
