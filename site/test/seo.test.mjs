import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NOT_FOUND,
  ROUTES,
  canonicalUrl,
  headTags,
  jsonLd,
  outputFile,
  routeMeta,
  sitemapXml
} from '../src/lib/seo.js'
import { FAQ, HOME_FAQ_COUNT } from '../src/content/faq.js'

test('every route has a unique title and description', () => {
  const all = [...ROUTES, NOT_FOUND]
  assert.equal(new Set(all.map((r) => r.title)).size, all.length)
  assert.equal(new Set(ROUTES.filter((r) => r.index).map((r) => r.description)).size, ROUTES.filter((r) => r.index).length)
  for (const r of all) assert.ok(r.description.length > 10 && r.description.length <= 230, r.path)
})

test('account pages are shells with noindex; marketing pages are prerendered and indexed', () => {
  for (const r of ROUTES) {
    const account = r.path.startsWith('/account') || r.path === '/link'
    assert.equal(r.index, !account, r.path)
    assert.equal(r.render, account ? 'shell' : 'full', r.path)
  }
})

test('indexed pages carry published and updated dates, in JSON-LD and the sitemap', () => {
  const xml = sitemapXml()
  for (const r of ROUTES.filter((r) => r.index)) {
    assert.match(r.published ?? '', /^\d{4}-\d{2}-\d{2}$/, r.path)
    assert.match(r.updated ?? '', /^\d{4}-\d{2}-\d{2}$/, r.path)
    assert.ok(r.updated >= r.published, r.path)
    const page = jsonLd(r)['@graph'].find((n) => n['@type'] === 'WebPage')
    assert.equal(page.dateModified, r.updated, r.path)
    assert.ok(xml.includes(`<loc>${canonicalUrl(r.path)}</loc><lastmod>${r.updated}</lastmod>`), r.path)
  }
})

test('routeMeta ignores trailing slashes and falls back to the 404 page', () => {
  assert.equal(routeMeta('/compare/').path, '/compare')
  assert.equal(routeMeta('').path, '/')
  assert.equal(routeMeta('/nope'), NOT_FOUND)
})

test('output files map routes to Cloudflare-style .html paths', () => {
  assert.equal(outputFile(routeMeta('/')), 'index.html')
  assert.equal(outputFile(routeMeta('/download/linux')), 'download/linux.html')
  assert.equal(outputFile(NOT_FOUND), '404.html')
})

test('head tags: canonical and og:url for indexed pages, noindex otherwise, absolute og:image', () => {
  const home = headTags(routeMeta('/'))
  assert.match(home, /<link rel="canonical" href="https:\/\/kimochiapp.com\/" \/>/)
  assert.match(home, /<meta property="og:url" content="https:\/\/kimochiapp.com\/" \/>/)
  assert.match(home, /<meta property="og:image" content="https:\/\//)
  assert.match(home, /twitter:card" content="summary_large_image"/)
  assert.doesNotMatch(home, /noindex/)
  const signIn = headTags(routeMeta('/account/sign-in'))
  assert.match(signIn, /<meta name="robots" content="noindex" \/>/)
  assert.doesNotMatch(signIn, /canonical|og:url|ld\+json/)
})

test('JSON-LD: app on home, FAQPage from every question on /faq, nothing on shells', () => {
  const types = (path) => jsonLd(routeMeta(path))['@graph'].map((n) => n['@type'])
  assert.deepEqual(types('/'), ['WebSite', 'Person', 'SoftwareApplication', 'WebPage'])
  assert.ok(types('/faq').includes('FAQPage'))
  const faq = jsonLd(routeMeta('/faq'))['@graph'].find((n) => n['@type'] === 'FAQPage')
  assert.equal(faq.mainEntity.length, FAQ.length)
  const app = jsonLd(routeMeta('/'))['@graph'].find((n) => n['@type'] === 'SoftwareApplication')
  assert.equal(app.applicationCategory, 'EducationalApplication')
  assert.equal(app.offers[0].price, '0')
  assert.equal(jsonLd(routeMeta('/account')), null)
})

test('JSON-LD in a script element cannot close it', () => {
  assert.doesNotMatch(headTags(routeMeta('/faq')).split('ld+json">')[1].split('</script>')[0], /</)
})

test('sitemap lists exactly the indexed routes', () => {
  const xml = sitemapXml()
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
  assert.deepEqual(locs, ROUTES.filter((r) => r.index).map((r) => canonicalUrl(r.path)))
})

test('FAQ entries are complete and plain text', () => {
  assert.ok(FAQ.length > HOME_FAQ_COUNT)
  assert.equal(new Set(FAQ.map((f) => f.id)).size, FAQ.length)
  for (const f of FAQ) {
    assert.ok(f.q.endsWith('?'), f.id)
    assert.ok(f.a.length > 0 && f.a.every((p) => p.length > 20 && !/[<>]|\[|NEEDS INPUT/.test(p)), f.id)
  }
})
