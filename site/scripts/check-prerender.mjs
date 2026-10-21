// Checks the built site the way a crawler without JavaScript sees it: every route's file in dist/
// has its own title and description, canonical (indexed pages) or noindex (the rest), JSON-LD that
// parses, and its content in #root (prerendered pages). Run after `npm run build`.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NOT_FOUND, ROUTES, canonicalUrl, escapeHtml, outputFile } from '../src/lib/seo.js'

const dist = fileURLToPath(new URL('../dist', import.meta.url))
const problems = []
const titles = new Set()

for (const route of [...ROUTES, NOT_FOUND]) {
  const file = outputFile(route)
  const html = await readFile(join(dist, file), 'utf8').catch(() => null)
  const fail = (msg) => problems.push(`${file}: ${msg}`)
  if (!html) {
    fail('missing')
    continue
  }
  const title = html.match(/<title>([^<]*)<\/title>/g) ?? []
  if (title.length !== 1 || title[0] !== `<title>${escapeHtml(route.title)}</title>`) fail(`title ${title}`)
  if (titles.has(route.title)) fail('duplicate title')
  titles.add(route.title)
  if (!html.includes(`<meta name="description" content="${escapeHtml(route.description)}"`)) fail('description')
  if ((html.match(/name="description"/g) ?? []).length !== 1) fail('more than one description')
  const canonical = html.includes(`<link rel="canonical" href="${canonicalUrl(route.path)}"`)
  const noindex = html.includes('<meta name="robots" content="noindex"')
  if (route.index ? !canonical || noindex : canonical || !noindex) fail('canonical/noindex')
  if (!/property="og:image" content="https:\/\//.test(html)) fail('og:image is not absolute')
  if (!html.includes('name="twitter:card" content="summary_large_image"')) fail('twitter:card')
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map((m) => JSON.parse(m[1]))
  const types = ld.flatMap((d) => d['@graph'] ?? [d]).map((n) => n['@type'])
  if (route.index && !types.includes('WebSite')) fail('no JSON-LD WebSite')
  if (route.path === '/' && !types.includes('SoftwareApplication')) fail('no SoftwareApplication')
  if (route.path === '/faq' && !types.includes('FAQPage')) fail('no FAQPage')
  const root = html.match(/<div id="root">([\s\S]*)<\/div>\s*<\/body>/)?.[1] ?? ''
  const text = root.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (route.render === 'full' && !/<h1[\s>]/.test(root)) fail('no h1 in the prerendered content')
  if (route.render === 'full' && text.length < 30) fail('no prerendered content')
  console.log(`${problems.length ? '' : 'ok'} ${file.padEnd(24)} ${String(text.length).padStart(6)} chars  ${types.join(', ')}`)
}

for (const extra of ['sitemap.xml', 'robots.txt', 'llms.txt', 'favicon.ico', 'site.webmanifest', '_headers']) {
  await readFile(join(dist, extra)).catch(() => problems.push(`${extra}: missing`))
}

if (problems.length) {
  console.error(`\n${problems.join('\n')}`)
  process.exit(1)
}
console.log('\nEvery route has its own head tags and static HTML.')
