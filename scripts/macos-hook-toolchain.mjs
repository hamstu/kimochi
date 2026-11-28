// Homebrew MinGW's i686 compiler uses SJLJ exceptions, incompatible with Rust's DW2 std.
// Use LLVM-MinGW with Rust's gnullvm targets on macOS. This is a build tool, never bundled.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { cargoTargetDir } from './cargo-target-dir.mjs'

const name = 'llvm-mingw-20261117-ucrt-macos-universal'
const sha256 = '98d340bbb8d46b09ad6886ffba88bd9d5415e131c316de48e6bd7647377446aa'

export async function macosHookToolchain(root) {
  const base = path.join(cargoTargetDir(path.join(root, 'hookd')), 'build-tools')
  const bin = path.join(base, name, 'bin')
  if (existsSync(path.join(bin, 'i686-w64-mingw32-clang'))) return bin
  console.log('Downloading the pinned LLVM-MinGW compiler for the Windows hook helpers (125 MB).')
  const response = await fetch(`https://github.com/mstorsjo/llvm-mingw/releases/download/20261117/${name}.tar.xz`)
  if (!response.ok) throw Error(`LLVM-MinGW download: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw Error('LLVM-MinGW checksum mismatch')
  await mkdir(base, { recursive: true })
  const staging = path.join(base, `.llvm-mingw-${process.pid}`)
  await mkdir(staging, { recursive: true })
  try {
    const archive = path.join(staging, 'compiler.tar.xz')
    await writeFile(archive, bytes)
    const unpacked = spawnSync('tar', ['-xf', archive, '-C', staging], { stdio: 'inherit' })
    if (unpacked.error || unpacked.status !== 0) throw Error('Could not unpack LLVM-MinGW')
    await rename(path.join(staging, name), path.join(base, name))
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return bin
}
