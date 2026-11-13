#!/usr/bin/env node
// Packs the extension for the Chrome Web Store and Edge Add-ons:
// browser-extension/dist/kimochi-browser-<version>.zip, manifest.json at the zip's root.
//
// The stores give an extension its ID and sign it themselves, so the manifest's `key` (which
// pins the unpacked extension's ID to the store's, see README) is left out of the upload.
//
//   node browser-extension/pack.mjs
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, 'extension')
const dist = join(here, 'dist')
const stage = join(dist, 'stage')

const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'))
delete manifest.key
if (manifest.description.length > 132)
  throw new Error(`description is ${manifest.description.length} characters; the stores allow 132`)

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
cpSync(source, stage, { recursive: true, filter: (path) => !/(^|\/)\.[^/]+$/.test(path) })
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const zip = join(dist, `kimochi-browser-${manifest.version}.zip`)
rmSync(zip, { force: true })
execFileSync('zip', ['-r', '-X', '-q', zip, '.'], { cwd: stage })
rmSync(stage, { recursive: true, force: true })
console.log(zip)
