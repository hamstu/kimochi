/**
 * The docs site (site-docs/ in the repository, its own Astro build), served from its own
 * subdomain. Marketing pages link into it with `docsUrl('/install/linux/')`; these are plain
 * external links, not routes, so nothing is added to ROUTES in seo.js.
 */
export const DOCS_URL = 'https://docs.kimochiapp.com'

/** An absolute docs URL for a docs path such as '/install/' (with its trailing slash). */
export function docsUrl(path = '/') {
  return `${DOCS_URL}${path.startsWith('/') ? path : `/${path}`}`
}
