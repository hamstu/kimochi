# Kimochi docs

The user documentation for Kimochi, served at **docs.kimochiapp.com**: an [Astro](https://astro.build)
+ [Starlight](https://starlight.astro.build) site built from Markdown/MDX, separate from the marketing
site in `site/` but dressed in its tokens, fonts and light/dark theme.

## Run

```sh
npm ci --prefix site-docs          # once
npm run docs:dev                   # http://127.0.0.1:1460 (from the repo root), with live reload
npm run docs:build                 # static site in site-docs/dist (+ sitemap, search index)
npm --prefix site-docs run check:links   # after a build: every link, image and #fragment resolves
npm run docs:preview               # serve dist at http://127.0.0.1:1461
npm run docs:screenshots           # re-render every screenshot (see below)
```

The build fails on a broken content link (starlight-links-validator); `check:links` also checks the
header, footer, sidebar, images and fragments in the built HTML, and `-- --external` requests every
external URL once.

## Layout

```
site-docs/
  astro.config.mjs        site URL, sidebar (the information architecture), Starlight overrides
  wrangler.toml           the Cloudflare Worker that serves dist/ (not deployed yet)
  DOCS_TODO.md            open questions for Hamish (also <Todo> boxes in the dev server)
  public/                 favicon, og.png (the social card, drawn by docs:screenshots), _headers, robots.txt
  scripts/check-links.mjs post-build link check
  shots/                  the screenshot pipeline: shots.config.mjs (every shot) and stage/ (the frame)
  src/
    content/docs/         the pages, one .md/.mdx per page; folders match the sidebar groups
    pages/changelog.astro the repository's CHANGELOG.md, rendered
    components/           Screenshot, Todo, and the Starlight overrides (SiteTitle, Footer, Head)
    styles/theme.css      Starlight mapped onto the marketing site's tokens
    assets/screenshots/   <id>-light.webp / <id>-dark.webp, written by docs:screenshots
```

## Writing pages

- A page is `src/content/docs/<group>/<name>.mdx` with `title` and `description` frontmatter (the
  description is the page's meta description and social text: one plain sentence). Add it to the
  sidebar in `astro.config.mjs`.
- Write for people using the app: plain, task-first, UI labels in **bold** exactly as the app shows
  them, tables for settings and shortcuts. Only document what the app actually does; if you're not
  sure, ask with `<Todo>TODO(hamish): …</Todo>` and add it to `DOCS_TODO.md`.
- Keys: `<kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>8</kbd>`. Japanese text gets the Japanese font automatically
  when marked `lang="ja"`.
- Starlight's components (`Steps`, `Tabs`, `Card`, `LinkCard`, asides `:::note`) are available.
- Internal links are root-relative with a trailing slash: `[Auto OCR](/reading/auto-ocr/)`.

## Screenshots

Every screenshot is rendered from the **preview harness** (`frontend/dev/`, the real React windows with
the Tauri runtime mocked and demo data, also behind `npm run preview:ui` and the marketing site's
demo), never from the real app:

```sh
npm run docs:screenshots                         # every shot, light and dark
npm run docs:screenshots -- --only notebook,source-menu --theme dark
npm run docs:screenshots -- --list               # ids and harness pages
```

Run it after any change to the app's UI and commit the changed images. It needs the root, `site/` and
`site-docs/` dependencies installed, and Chrome (or `$CHROME`).

How it works (`scripts/docs-screenshots.mjs`):

1. Starts the harness's Vite server (`vite.preview.config.ts`) on port 1474, and the marketing site's
   dev server on 1475 for the shots of its live demo, both in-process.
2. Both serve the **stage** (`shots/stage/`) at `/__shots/stage.html`: a transparent page that frames
   one harness page in an app window (rounded corners, hairline, soft shadow). Because it is
   same-origin, it can measure elements inside the app.
3. Headless Chrome (`scripts/cdp.mjs`) loads the stage at 2× device pixels, emulating the shot's theme
   (`prefers-color-scheme`, plus `?theme=` for the app) and reduced motion; plays the shot's actions
   with real mouse and key input (so Radix menus open as they do for a person); then the stage draws
   the shot's marks.
4. The stage's box is captured as PNG and written as lossless WebP. Every page runs on a fixed clock
   (2026-10-21 19:45 UTC, time zone UTC, locale en-US), so the harness's seeded timestamps don't
   drift: re-running on an unchanged window writes a byte-identical file, and `git status` shows
   only the shots whose window really changed. At build time Astro's image
   pipeline turns each into AVIF and WebP at 1× and 2× of its display width.

A shot is one entry in `shots/shots.config.mjs`:

```js
{
  id: 'line-actions',                        // → src/assets/screenshots/line-actions-{light,dark}.webp
  page: 'panel.html?window=log',             // harness page + parameters (frontend/dev/preview-setup.ts)
  size: [900, 560],                          // the app window, CSS px
  crop: { x: 0, y: 0, width: 240, height: 560 },  // optional: a detail of the window
  ready: '.line',                            // wait for this before anything else
  actions: [{ rightClick: { selector: '.line', index: 1 } }],
  marks: [
    { type: 'glow', target: '[role="menu"]' },                 // soft glowing outline
    { type: 'focus', target: '.line-translated' },             // dim everything else
    { type: 'badge', target: '.src-card', n: 1 },              // numbered dot
    { type: 'note', target: '.src-scan', text: 'Scan', side: 'right' },  // callout with a leader
    { type: 'cursor', target: { selector: '.kd-word', text: '容赦' } }   // a mouse pointer
  ]
}
```

Targets are CSS selectors inside the app, or `{ selector, text, index, pad }`. Use one in a page with
`<Screenshot id="line-actions" alt="…" width={720} />`; it shows the light or dark image with the
reader's theme. The dictionary pop-up pictures in `lookups/dictionaries` come from
`frontend/assets/dictionary-previews/` (the app's own captures, `npm run capture:dictionary-previews`).

## Theme

`src/styles/theme.css` imports the marketing site's `site/src/styles/tokens.css` (the one source of the
colour roles, fonts, weights, radii and shadows) and maps Starlight's variables onto them, so a token
change restyles both sites. Starlight always sets `data-theme` on `<html>`, which is what tokens.css
keys its dark mode on. The header wordmark, footer and social card are overrides in `src/components/`.

## SEO

- Every page has its own `<title>`, meta description, canonical URL (`https://docs.kimochiapp.com/…`)
  and Open Graph/Twitter tags (Starlight), plus a shared 1200×630 `og:image` (`public/og.png`,
  redrawn by `docs:screenshots`) from `src/components/Head.astro`.
- `sitemap-index.xml` is generated at build (Starlight's sitemap, from `site` in astro.config.mjs) and
  listed in `public/robots.txt`.
- Unknown paths get `404.html` with status 404 (`not_found_handling = "404-page"`).

## Deploying

The docs are a separate, script-less Cloudflare Worker with static assets (`wrangler.toml`), so they
deploy on their own and never touch kimochi-server, which keeps serving kimochiapp.com and `/api`.

```sh
npx wrangler login       # once, with the account that holds the kimochiapp.com zone
npm run docs:deploy      # astro build, then wrangler deploy
```

**Nothing has been deployed and no DNS or Cloudflare setting has changed.** As configured, the first
deploy creates the `kimochi-docs` Worker on the account's workers.dev subdomain only (a preview URL).
To put it on docs.kimochiapp.com, uncomment `routes` in `wrangler.toml` and deploy again: wrangler then
adds the custom domain and creates its DNS record in the kimochiapp.com zone. After that you can set
`workers_dev = false`, as kimochi-server does.
