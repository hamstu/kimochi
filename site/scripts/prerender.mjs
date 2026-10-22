// Prerender: after `vite build` (the client, into dist/) and `vite build --ssr` (src/entry-server.tsx,
// into .ssr/), write every route as static HTML with its own head tags (src/lib/seo.js), plus
// dist/404.html and dist/sitemap.xml. Marketing pages carry their full content and are hydrated by
// src/main.tsx; account pages are head-only shells that render in the browser.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const site = fileURLToPath(new URL('..', import.meta.url))
const dist = join(site, 'dist')
const ssrDir = join(site, '.ssr')

const { render, ROUTES, NOT_FOUND, headTags, outputFile, sitemapXml } = await import(
  pathToFileURL(join(ssrDir, 'entry-server.js')).href
)

const template = await readFile(join(dist, 'index.html'), 'utf8')
const HEAD = /<!-- head:start[\s\S]*?<!-- head:end -->/
const ROOT = '<div id="root"></div>'
if (!HEAD.test(template) || !template.includes(ROOT)) {
  throw new Error('dist/index.html is missing the head:start/head:end block or the empty #root')
}

for (const route of [...ROUTES, NOT_FOUND]) {
  const body = route.render === 'full' ? render(route.path) : ''
  const html = template.replace(HEAD, () => headTags(route)).replace(ROOT, () => `<div id="root">${body}</div>`)
  const file = join(dist, outputFile(route))
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, html)
  console.log(`prerendered ${route.path.padEnd(18)} → dist/${outputFile(route)}${body ? '' : ' (shell)'}`)
}

await writeFile(join(dist, 'sitemap.xml'), sitemapXml())
console.log('wrote dist/sitemap.xml')
await rm(ssrDir, { recursive: true, force: true })
