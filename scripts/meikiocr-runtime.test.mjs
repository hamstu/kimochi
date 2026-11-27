/**
 * `npm run dev` restages the MeikiOCR runtime (scripts/run.mjs) whenever the staged one is not what
 * prepare-meikiocr.mjs would stage for this host: an x64 ONNX Runtime left in a Windows ARM64
 * checkout loads nowhere, and speech detection silently stops with it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runtimeIdentity, runtimeMismatch } from './meikiocr-runtime.mjs'

const armWindows = runtimeIdentity({ argv: [], env: {}, platform: 'win32', arch: 'arm64' })

async function staged(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kimochi-meikiocr-test-'))
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(dir, name), contents)
  return dir
}
const complete = (marker) => ({ 'build.json': marker, 'onnxruntime.dll': '', 'DirectML.dll': '' })

test('the identity for Windows ARM64 is the marker prepare-meikiocr writes', () => {
  assert.equal(
    armWindows.marker,
    '{"packagingVersion":4,"version":"1.22.0","target":"aarch64-pc-windows-msvc","flavor":"directml","override":null}'
  )
  assert.deepEqual(armWindows.required, ['onnxruntime.dll', 'DirectML.dll'])
})

test('KIMOCHI_TARGET, --target and MEIKIOCR_RUNTIME_DIR shape the identity', () => {
  const fromEnv = runtimeIdentity({ argv: [], env: { KIMOCHI_TARGET: 'x86_64-unknown-linux-gnu' } })
  assert.equal(fromEnv.target, 'x86_64-unknown-linux-gnu')
  assert.equal(fromEnv.flavor, 'cpu')
  const fromFlag = runtimeIdentity({ argv: ['dev', '--target', 'aarch64-apple-darwin'], env: {} })
  assert.equal(fromFlag.version, '1.30.0')
  const local = runtimeIdentity({ argv: [], env: { MEIKIOCR_RUNTIME_DIR: 'C:/ort' }, platform: 'win32', arch: 'x64' })
  assert.equal(JSON.parse(local.marker).override, 'C:/ort')
  assert.throws(() => runtimeIdentity({ argv: [], env: { KIMOCHI_TARGET: 'riscv64gc-unknown-linux-gnu' } }))
})

test('a matching runtime is not restaged', async () => {
  const dir = await staged(complete(armWindows.marker))
  try {
    assert.equal(await runtimeMismatch(dir, armWindows), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a runtime built for another target is restaged', async () => {
  const x64 = runtimeIdentity({ argv: [], env: {}, platform: 'win32', arch: 'x64' })
  const dir = await staged(complete(x64.marker))
  try {
    assert.equal(
      await runtimeMismatch(dir, armWindows),
      'built for x86_64-pc-windows-msvc, not aarch64-pc-windows-msvc'
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an older packaging version is restaged', async () => {
  const old = JSON.stringify({ ...JSON.parse(armWindows.marker), packagingVersion: 3 })
  const dir = await staged(complete(old))
  try {
    assert.equal(await runtimeMismatch(dir, armWindows), 'packaging version 3, not 4')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a different MEIKIOCR_RUNTIME_DIR override is restaged', async () => {
  const dir = await staged(complete(armWindows.marker))
  try {
    const local = runtimeIdentity({
      argv: [],
      env: { MEIKIOCR_RUNTIME_DIR: 'D:/ort' },
      platform: 'win32',
      arch: 'arm64'
    })
    assert.equal(await runtimeMismatch(dir, local), 'override null, not "D:/ort"')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing, corrupt or incomplete staging is restaged', async () => {
  const missing = await staged({ 'onnxruntime.dll': '' })
  const corrupt = await staged({ ...complete(''), 'build.json': '{"packagingVersion":4,' })
  const incomplete = await staged({ 'build.json': armWindows.marker, 'onnxruntime.dll': '' })
  try {
    assert.equal(await runtimeMismatch(missing, armWindows), 'not staged yet')
    assert.equal(await runtimeMismatch(corrupt, armWindows), 'has an unreadable build.json')
    assert.equal(await runtimeMismatch(incomplete, armWindows), 'is missing DirectML.dll')
  } finally {
    for (const dir of [missing, corrupt, incomplete]) await rm(dir, { recursive: true, force: true })
  }
})
