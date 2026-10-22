#!/usr/bin/env node
/**
 * After `npm run build`: every page in dist/ links only to pages and files that exist.
 *
 *   npm --prefix site-docs run check:links [-- --external]
 *
 * Checks every href, src and srcset in every built page, plus #fragments on the same or another
 * docs page, and the pages' canonical URLs. Content links are already checked during the build
 * (starlight-links-validator); this also covers the header, footer, sidebar, images and the
 * marketing site's links back in. `--external` also requests each external URL once (HEAD, then
 * GET) and reports the ones that fail; without it they are only listed.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const SITE = 'https://docs.kimochiapp.com'
const external = process.argv.includes('--external')

if (!existsSync(dist)) {
  console.error('No dist/: run npm run build first.')
  process.exit(1)
}

function pages(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) return pages(file)
    return name.endsWith('.html') ? [file] : []
  })
}

/** The file a site path resolves to, as the Worker serves it (auto-trailing-slash). */
function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split(/[?#]/)[0])
  const file = path.join(dist, clean)
  for (const candidate of [file, `${file}.html`, path.join(file, 'index.html')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const idsCache = new Map()
function ids(file) {
  if (!idsCache.has(file)) {
    const html = readFileSync(file, 'utf8')
    idsCache.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])))
  }
  return idsCache.get(file)
}

const problems = []
const externals = new Map()
const all = pages(dist)

for (const file of all) {
  const html = readFileSync(file, 'utf8')
  const page = '/' + path.relative(dist, file).replace(/index\.html$/, '').replace(/\.html$/, '')
  // A 404 page's canonical names a path that is, by design, not a page.
  const body = page === '/404' ? html.replace(/<link rel="canonical"[^>]*>/, '') : html
  const refs = [
    ...[...body.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1]),
    ...[...body.matchAll(/\ssrcset="([^"]*)"/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+/)[0]))
  ]
  for (let ref of refs) {
    ref = ref.replaceAll('&amp;', '&')
    if (!ref || ref.startsWith('data:') || ref.startsWith('mailto:') || ref.startsWith('javascript:')) continue
    if (ref.startsWith(SITE)) ref = ref.slice(SITE.length) || '/'
    if (/^https?:\/\//.test(ref)) {
      if (!externals.has(ref)) externals.set(ref, page)
      continue
    }
    if (ref.startsWith('#')) {
      if (ref.length > 1 && !ids(file).has(decodeURIComponent(ref.slice(1)))) problems.push(`${page}: no #${ref.slice(1)} on this page`)
      continue
    }
    const absolute = ref.startsWith('/') ? ref : path.posix.join(page.endsWith('/') ? page : path.posix.dirname(page), ref)
    const target = resolve(absolute)
    if (!target) {
      problems.push(`${page}: broken link ${ref}`)
      continue
    }
    const hash = ref.split('#')[1]
    if (hash && target.endsWith('.html') && !ids(target).has(decodeURIComponent(hash))) problems.push(`${page}: ${ref} has no #${hash}`)
  }
}

if (external) {
  for (const [url, page] of externals) {
    const ok = await fetch(url, { method: 'HEAD', redirect: 'follow' })
      .then((r) => (r.ok ? r : fetch(url, { redirect: 'follow' })))
      .then((r) => r.ok)
      .catch(() => false)
    if (!ok) problems.push(`${page}: external link failed ${url}`)
  }
}

console.log(`${all.length} pages, ${externals.size} external links${external ? ' (requested)' : ' (not requested; --external)'}`)
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`)
  console.error(`${problems.length} broken link(s)`)
  process.exit(1)
}
console.log('✓ every internal link, image and #fragment resolves')
