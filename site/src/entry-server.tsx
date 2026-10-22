import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import { App } from './App'

export { NOT_FOUND, ROUTES, headTags, outputFile, sitemapXml } from './lib/seo.js'

/**
 * The build's prerender entry (scripts/prerender.mjs): the app's HTML at `url`, as the browser's
 * first render will produce it, so main.tsx can hydrate it.
 */
export function render(url: string): string {
  return renderToString(
    <StrictMode>
      <StaticRouter location={url}>
        <App />
      </StaticRouter>
    </StrictMode>
  )
}
