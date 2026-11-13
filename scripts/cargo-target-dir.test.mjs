/**
 * Where the stagers (scripts/prepare-*.mjs) find a crate's build output: `<crate>/target`, or
 * CARGO_TARGET_DIR, a relative one resolved against the directory cargo ran in.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { cargoTargetDir } from './cargo-target-dir.mjs'

const crate = path.resolve('/repo/hookd')

test('without CARGO_TARGET_DIR, the crate’s own target directory', () => {
  assert.equal(cargoTargetDir(crate, {}), path.join(crate, 'target'))
  assert.equal(cargoTargetDir(crate, { CARGO_TARGET_DIR: '' }), path.join(crate, 'target'))
})

test('CARGO_TARGET_DIR, absolute or relative to where cargo ran', () => {
  const shared = path.resolve('/builds/shared')
  assert.equal(cargoTargetDir(crate, { CARGO_TARGET_DIR: shared }), shared)
  const cwd = path.resolve('/repo')
  assert.equal(cargoTargetDir(crate, { CARGO_TARGET_DIR: 'out/target' }, cwd), path.join(cwd, 'out/target'))
})
