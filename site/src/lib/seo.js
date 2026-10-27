/**
 * Per-route head tags, JSON-LD and the sitemap. Pure: used by the client (title and description
 * on navigation), by the build's prerender step (scripts/prerender.mjs writes every route's HTML
 * with these tags) and by test/seo.test.mjs.
 *
 * Every fact here must already be on the site.
 */
import { FAQ } from '../content/faq.js'

/** The production origin. No trailing slash. */
export const SITE_URL = 'https://kimochiapp.com'

/** The name paired with the category, so Kimochi is not confused with other "Kimochi" apps. */
export const ENTITY_NAME = 'Kimochi: Japanese OCR overlay for games'

/** The social card (public/og.png, drawn by `npm run docs:screenshots -- --only og-site`). */
export const OG_IMAGE = {
  url: `${SITE_URL}/og.png`,
  width: 1200,
  height: 630,
  alt: 'Kimochi: Read and play in Japanese. The main window beside the wordmark.'
}

/**
 * @typedef {object} RouteMeta
 * @property {string} path      Route path, no trailing slash ("/" for home).
 * @property {string} title     Document title.
 * @property {string} description Meta description.
 * @property {boolean} index    Indexable, listed in the sitemap. False adds `noindex`.
 * @property {'full' | 'shell'} render  `full` prerenders the page's content; `shell` only its head
 *   (pages that need the browser: the session, `?token=` and so on).
 * @property {string} [file]    Output file under dist/ (default `<path>.html`, `index.html` for /).
 */

/** @type {RouteMeta[]} */
export const ROUTES = [
  {
    path: '/',
    title: 'Kimochi · Read Japanese games with an OCR overlay',
    description:
      'Kimochi is a free, open-source desktop app for macOS, Windows and Linux that reads the Japanese text in your games, manga, videos and apps, draws it right over them, and lets you hover any word to look it up and make Anki cards.',
    index: true,
    render: 'full'
  },
  {
    path: '/faq',
    title: 'FAQ · Kimochi, the Japanese OCR overlay for games',
    description:
      'Answers about Kimochi: what it is, who it is for, what it costs, which platforms, OCR engines and dictionaries it supports, and what leaves your computer.',
    index: true,
    render: 'full'
  },
  {
    path: '/compare',
    title: 'Kimochi vs Game Sentence Miner, Kamui, owocr and YomiNinja',
    description:
      'A fair, sourced comparison of tools for reading Japanese games: Kimochi, Game Sentence Miner, Kamui, owocr and YomiNinja. Platforms, OCR engines, overlays, dictionaries, Anki and price.',
    index: true,
    render: 'full'
  },
  {
    path: '/download/linux',
    title: 'Install Kimochi on Linux and Steam Deck',
    description:
      'How to install Kimochi on Steam Deck, Ubuntu and Debian, Fedora, Arch and other Linux systems, plus updating, uninstalling and what to do if it won’t start.',
    index: true,
    render: 'full'
  },
  {
    path: '/privacy',
    title: 'Privacy policy · Kimochi',
    description:
      'Kimochi has no analytics, telemetry or ads. Exactly what stays on your computer and what leaves it, feature by feature, and what an optional account stores.',
    index: true,
    render: 'full'
  },
  {
    path: '/terms',
    title: 'Terms of use · Kimochi',
    description: 'The terms for using the Kimochi app, the website and an optional Kimochi account and Kimochi Cloud.',
    index: true,
    render: 'full'
  },
  { path: '/account', title: 'Account · Kimochi', description: 'Your Kimochi account.', index: false, render: 'shell' },
  { path: '/account/sign-in', title: 'Sign in · Kimochi', description: 'Sign in to your Kimochi account.', index: false, render: 'shell' },
  { path: '/account/sign-up', title: 'Create an account · Kimochi', description: 'Create a Kimochi account.', index: false, render: 'shell' },
  { path: '/account/forgot', title: 'Reset password · Kimochi', description: 'Reset your Kimochi password.', index: false, render: 'shell' },
  { path: '/account/reset', title: 'Choose a new password · Kimochi', description: 'Choose a new Kimochi password.', index: false, render: 'shell' },
  { path: '/account/verify', title: 'Confirm email · Kimochi', description: 'Confirm your email for Kimochi.', index: false, render: 'shell' },
  { path: '/account/admin', title: 'Admin · Kimochi', description: 'Kimochi admin.', index: false, render: 'shell' },
  { path: '/link', title: 'Sign in to Kimochi · Kimochi', description: 'Link the Kimochi app to your account.', index: false, render: 'shell' }
]

/**
 * The page for unknown paths, written to dist/404.html and served with status 404.
 * @type {RouteMeta}
 */
export const NOT_FOUND = {
  path: '/404',
  title: 'Not found · Kimochi',
  description: 'This page wandered off.',
  index: false,
  render: 'full',
  file: '404.html'
}

/**
 * The route's metadata, or NOT_FOUND. Trailing slashes are ignored.
 * @param {string} pathname
 * @returns {RouteMeta}
 */
export function routeMeta(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/'
  return ROUTES.find((r) => r.path === path) ?? NOT_FOUND
}

/** @param {string} path */
export function canonicalUrl(path) {
  return path === '/' ? `${SITE_URL}/` : `${SITE_URL}${path}`
}

/**
 * The output file under dist/ for a route.
 * @param {RouteMeta} route
 */
export function outputFile(route) {
  if (route.file) return route.file
  return route.path === '/' ? 'index.html' : `${route.path.slice(1)}.html`
}

/** @param {string} s */
export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** JSON for a <script> element: `<` escaped so no string can close the element. */
function scriptJson(/** @type {unknown} */ value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

const PERSON_ID = `${SITE_URL}/#hamish`
const WEBSITE_ID = `${SITE_URL}/#website`
const APP_ID = `${SITE_URL}/#app`

const PERSON = {
  '@type': 'Person',
  '@id': PERSON_ID,
  name: 'Hamish Macpherson',
  description: 'An individual developer in Canada who makes Kimochi.',
  address: { '@type': 'PostalAddress', addressCountry: 'CA' },
  sameAs: ['https://github.com/hamstu']
}

const WEBSITE = {
  '@type': 'WebSite',
  '@id': WEBSITE_ID,
  url: `${SITE_URL}/`,
  name: 'Kimochi',
  alternateName: ENTITY_NAME,
  inLanguage: 'en',
  publisher: { '@id': PERSON_ID }
}

/** Kimochi Cloud is priced in US dollars (the Stripe prices). */
const PRICE_CURRENCY = 'USD'

const APP = {
  '@type': 'SoftwareApplication',
  '@id': APP_ID,
  name: 'Kimochi',
  alternateName: ENTITY_NAME,
  url: `${SITE_URL}/`,
  description:
    'A desktop app that reads the Japanese text on your screen with OCR, draws it over your game, manga or video, and lets you hover any word to look it up in Yomitan, Hachidori or 10ten and make Anki cards.',
  applicationCategory: 'EducationalApplication',
  operatingSystem: 'macOS, Windows, Linux',
  inLanguage: 'en',
  isAccessibleForFree: true,
  license: 'https://www.gnu.org/licenses/gpl-3.0.html',
  image: OG_IMAGE.url,
  author: { '@id': PERSON_ID },
  publisher: { '@id': PERSON_ID },
  offers: [
    { '@type': 'Offer', name: 'Kimochi', price: '0', priceCurrency: PRICE_CURRENCY, description: 'Free forever. No account, no limits.' },
    { '@type': 'Offer', name: 'Kimochi Cloud (monthly)', price: '6', priceCurrency: PRICE_CURRENCY, description: 'Billed monthly. 14-day free trial.' },
    { '@type': 'Offer', name: 'Kimochi Cloud (yearly)', price: '60', priceCurrency: PRICE_CURRENCY, description: 'Billed yearly ($5 a month, two months free). 14-day free trial.' },
    { '@type': 'Offer', name: 'Kimochi Cloud (lifetime)', price: '125', priceCurrency: PRICE_CURRENCY, description: 'One payment.' }
  ],
  downloadUrl: 'https://github.com/hamstu/kimochi-tauri/releases/latest',
  sameAs: ['https://github.com/hamstu/kimochi-tauri']
  // Leave out softwareVersion and datePublished until there is a tagged release.
}

/**
 * FAQPage from the published questions (the ones with an answer).
 * @param {typeof FAQ} faq
 */
export function faqPage(faq) {
  return {
    '@type': 'FAQPage',
    '@id': `${SITE_URL}/faq#faq`,
    url: `${SITE_URL}/faq`,
    isPartOf: { '@id': WEBSITE_ID },
    mainEntity: faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a.join(' ') }
    }))
  }
}

/**
 * The JSON-LD graph for a route: the site and its maker everywhere, the app on home and compare,
 * the FAQ on /faq. Null for pages that are not indexed.
 * @param {RouteMeta} route
 */
export function jsonLd(route) {
  if (!route.index) return null
  /** @type {object[]} */
  const graph = [WEBSITE, PERSON]
  if (route.path === '/' || route.path === '/compare') graph.push(APP)
  if (route.path === '/faq') graph.push(APP, faqPage(FAQ))
  graph.push({
    '@type': 'WebPage',
    '@id': `${canonicalUrl(route.path)}#page`,
    url: canonicalUrl(route.path),
    name: route.title,
    description: route.description,
    isPartOf: { '@id': WEBSITE_ID },
    ...(route.path === '/' ? { about: { '@id': APP_ID } } : {})
  })
  return { '@context': 'https://schema.org', '@graph': graph }
}

/**
 * The route's head tags as HTML (title, description, robots, canonical, Open Graph, Twitter,
 * JSON-LD). The template's own generic tags are replaced by these.
 * @param {RouteMeta} route
 */
export function headTags(route) {
  const url = canonicalUrl(route.path)
  const t = escapeHtml(route.title)
  const d = escapeHtml(route.description)
  const lines = [`<title>${t}</title>`, `<meta name="description" content="${d}" />`]
  if (!route.index) lines.push('<meta name="robots" content="noindex" />')
  else lines.push(`<link rel="canonical" href="${url}" />`)
  lines.push(
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="Kimochi" />',
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    ...(route.index ? [`<meta property="og:url" content="${url}" />`] : []),
    `<meta property="og:image" content="${OG_IMAGE.url}" />`,
    '<meta property="og:image:type" content="image/png" />',
    `<meta property="og:image:width" content="${OG_IMAGE.width}" />`,
    `<meta property="og:image:height" content="${OG_IMAGE.height}" />`,
    `<meta property="og:image:alt" content="${escapeHtml(OG_IMAGE.alt)}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${OG_IMAGE.url}" />`
  )
  const ld = jsonLd(route)
  if (ld) lines.push(`<script type="application/ld+json">${scriptJson(ld)}</script>`)
  return lines.join('\n    ')
}

/** sitemap.xml for every indexable route. */
export function sitemapXml(routes = ROUTES) {
  const urls = routes
    .filter((r) => r.index)
    .map((r) => `  <url><loc>${canonicalUrl(r.path)}</loc></url>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}
