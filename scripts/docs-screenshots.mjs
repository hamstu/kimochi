#!/usr/bin/env node
/**
 * Renders every screenshot in the docs (site-docs/src/assets/screenshots/) from the browser
 * preview harness, never the real app, in headless Chrome at 2× (retina), light and dark.
 *
 *   npm run docs:screenshots -- [--only id,id] [--theme light|dark] [--port <n>] [--list]
 *
 * What runs (nothing touches the desktop or an installed app):
 *
 * - The preview harness (vite.preview.config.ts: every React window with the Tauri runtime
 *   mocked, frontend/dev/) on `--port` (default 1474), and, for shots of the marketing site's demo,
 *   the site's dev server (site/vite.config.ts) on port + 1. Both in this process, closed at the end.
 * - Each server also serves the screenshot stage (site-docs/shots/stage/) at /__shots/. The stage
 *   frames one harness page in an app window (rounded corners, hairline, soft shadow) on a
 *   transparent ground, plays the shot's actions with real CDP mouse and key input, then draws its
 *   marks: glowing outlines, a dimmed surround (focus), numbered badges, callout notes, a cursor.
 * - Shots are declared in site-docs/shots/shots.config.mjs. Each is written as lossless WebP
 *   (`<id>-light.webp`, `<id>-dark.webp`) at 2×. The social cards (site-docs/public/og.png, `og`;
 *   site/public/og.png, `og-site`) are drawn the same way.
 * - Each screenshot is also rendered at the size the docs show it, at 1× and (when smaller than its
 *   own size) 2× (`<id>-<theme>.w<width>x<density>.webp`): Chrome draws the page again at that
 *   scale, so a 1× screen gets text rasterized for its pixels instead of a resampled 2× picture,
 *   which reads soft. The sizes come from the `<Screenshot id width>` uses in the docs' pages and
 *   the column width below; Screenshot.astro picks the files up by name.
 *
 * Needs `npm ci` (root), `npm ci --prefix site` (for site shots) and `npm ci --prefix site-docs`
 * (sharp). Chrome is found as in scripts/cdp.mjs (`$CHROME` overrides).
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluate, launchChrome } from './cdp.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const docs = path.join(root, 'site-docs')
const STAGE = path.join(docs, 'shots/stage')
const OUT = path.join(docs, 'src/assets/screenshots')
const SCALE = 2
/** The widest a screenshot is shown: the docs column (46rem) plus the frame's 1rem tuck each side. */
const COLUMN = 736 + 32
const CONTENT = path.join(docs, 'src/content/docs')

const requireDocs = createRequire(path.join(docs, 'package.json'))
const sharp = (await import(pathToFileURL(requireDocs.resolve('sharp')).href)).default
const { SHOTS, OG } = await import(pathToFileURL(path.join(docs, 'shots/shots.config.mjs')).href)

function options(argv) {
  const value = (flag) => {
    const at = argv.indexOf(flag)
    return at >= 0 ? argv[at + 1] : undefined
  }
  return {
    only: value('--only')?.split(',').filter(Boolean),
    theme: value('--theme'),
    port: Number(value('--port') ?? 1474),
    list: argv.includes('--list')
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Every page (and frame) starts at the same moment, so the harness's seeded timestamps ("19:31",
 * "checked 4 minutes ago") come out the same on every run and an unchanged window gives an
 * unchanged image. The clock still runs from there, so timers and animations behave.
 */
const CLOCK = Date.parse('2026-10-21T19:45:00Z')
const FIXED_CLOCK = `(() => {
  const start = ${CLOCK}, real = Date.now(), RealDate = Date
  const now = () => start + (RealDate.now() - real)
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(now()) }
    static now() { return now() }
  }
  globalThis.Date = FixedDate
})()`

/** Serves the stage's files at /__shots/ on a Vite server. */
function stagePlugin() {
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }
  return {
    name: 'kimochi-docs-shots-stage',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? ''
        if (!url.startsWith('/__shots/')) return next()
        const file = path.join(STAGE, path.basename(url))
        try {
          const body = await readFile(file)
          res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream')
          res.setHeader('Cache-Control', 'no-store')
          res.end(body)
        } catch {
          res.statusCode = 404
          res.end()
        }
      })
    }
  }
}

async function startServers(port, needSite) {
  const { createServer } = await import('vite')
  const preview = await createServer({
    configFile: path.join(root, 'vite.preview.config.ts'),
    cacheDir: path.join(root, 'node_modules/.vite-docs-screenshots'),
    server: { port, strictPort: true, host: '127.0.0.1', hmr: false },
    logLevel: 'warn',
    plugins: [stagePlugin()]
  })
  await preview.listen()
  const servers = { preview, previewUrl: `http://127.0.0.1:${port}` }
  if (needSite) {
    const site = await createServer({
      root: path.join(root, 'site'),
      configFile: path.join(root, 'site/vite.config.ts'),
      cacheDir: path.join(root, 'site/node_modules/.vite-docs-screenshots'),
      server: { port: port + 1, strictPort: true, host: '127.0.0.1', hmr: false },
      logLevel: 'warn',
      plugins: [stagePlugin()]
    })
    await site.listen()
    Object.assign(servers, { site, siteUrl: `http://127.0.0.1:${port + 1}` })
  }
  return servers
}

/** The harness URL for a shot: its page with `theme` added (the harness seeds `appearance` from it). */
function pageUrl(shot, theme) {
  const [file, query = ''] = shot.page.split('?')
  const params = new URLSearchParams(query)
  if (shot.server !== 'site' && !params.has('theme')) params.set('theme', theme)
  // The harness starts on a first run, with no dictionary engine downloaded; the docs show the app
  // in use. The welcome guide's shots keep the first run unless they say otherwise.
  if (shot.server !== 'site' && !params.has('ext') && !file.startsWith('welcome')) params.set('ext', 'ready')
  const base = shot.server === 'site' ? '/' : '/dev/'
  return `${base}${file}${params.size ? `?${params}` : ''}`
}

async function mouse(page, type, { x, y }, extra = {}) {
  await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra })
}

const KEYS = {
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }
}

/** Plays a shot's actions with real input, so Radix menus, hovers and focus behave as for a person. */
async function act(page, actions = []) {
  const point = (target) => evaluate(page, `__stage.point(${JSON.stringify(target)})`)
  for (const a of actions) {
    if (a.wait) await sleep(a.wait)
    else if (a.waitFor) await evaluate(page, `__stage.waitFor(${JSON.stringify(a.waitFor)})`)
    else if (a.run) await evaluate(page, `__stage.run(${JSON.stringify(a.run)})`)
    else if (a.hover) await mouse(page, 'mouseMoved', await point(a.hover))
    else if (a.rightClick) await evaluate(page, `__stage.contextMenu(${JSON.stringify(a.rightClick)})`)
    else if (a.click || a.doubleClick) {
      const at = await point(a.click ?? a.doubleClick)
      await mouse(page, 'mouseMoved', at)
      for (let clickCount = 1; clickCount <= (a.doubleClick ? 2 : 1); clickCount++) {
        await mouse(page, 'mousePressed', at, { button: 'left', buttons: 1, clickCount })
        await mouse(page, 'mouseReleased', at, { button: 'left', buttons: 0, clickCount })
      }
    } else if (a.key) {
      const key = KEYS[a.key] ?? { key: a.key, text: a.key }
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    } else if (a.type) {
      await page.send('Input.insertText', { text: a.type })
    }
    await sleep(a.after ?? 250)
  }
}

async function setTheme(page, theme) {
  await page.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: theme },
      { name: 'prefers-reduced-motion', value: 'reduce' }
    ]
  })
}

async function capture(page, clip) {
  const { data } = await page.send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...clip, scale: 1 },
    captureBeyondViewport: true
  })
  return Buffer.from(data, 'base64')
}

/** One shot in one theme: the stage around a harness page. */
async function shoot(page, servers, shot, theme) {
  const base = shot.server === 'site' ? servers.siteUrl : servers.previewUrl
  const config = { ...shot, theme, url: pageUrl(shot, theme) }
  await setTheme(page, theme)
  const loaded = page.once('Page.loadEventFired', { timeout: 60000 })
  await page.send('Page.navigate', { url: `${base}/__shots/stage.html?shot=${encodeURIComponent(JSON.stringify(config))}` })
  await loaded
  await evaluate(page, '__stage.ready')
  await act(page, shot.actions)
  await sleep(shot.after ?? 400)
  if (shot.clipTo) {
    await evaluate(page, `__stage.clipTo(${JSON.stringify(shot.clipTo)})`)
    await sleep(300)
  }
  await evaluate(page, '__stage.mark()')
  await sleep(150)
  const clip = await evaluate(page, '__stage.clip()')
  return capture(page, clip)
}

/** Every `<Screenshot id="…" width={…}>` in the docs, as id → the widths it is asked for. */
async function usages() {
  const found = new Map()
  for (const entry of await readdir(CONTENT, { recursive: true })) {
    if (!/\.mdx?$/.test(entry)) continue
    const text = await readFile(path.join(CONTENT, entry), 'utf8')
    for (const [tag] of text.matchAll(/<Screenshot\b[^>]*?\/>/gs)) {
      const id = tag.match(/\bid="([^"]+)"/)?.[1]
      if (!id) continue
      const width = Number(tag.match(/\bwidth=\{(\d+)\}/)?.[1]) || undefined
      found.set(id, [...(found.get(id) ?? []), width])
    }
  }
  return found
}

/**
 * The widths (in CSS pixels, frame included) a shot of `natural` width is drawn at in the docs:
 * Screenshot.astro shows it at min(width, natural), and never wider than the column.
 */
function shownWidths(asked = [], natural) {
  return [...new Set(asked.map((w) => Math.min(w ?? natural, natural, COLUMN)))]
}

/** The shot again at `scale` device pixels per CSS pixel, the page left as it is. */
async function rescale(page, scale) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 2400, height: 1600, deviceScaleFactor: scale, mobile: false })
  await sleep(300)
  return capture(page, await evaluate(page, '__stage.clip()'))
}

async function write(file, png) {
  const webp = await sharp(png).webp({ lossless: true, effort: 5 }).toBuffer()
  await writeFile(file, webp)
  const { width, height } = await sharp(webp).metadata()
  return { width, height, bytes: webp.length }
}

async function main() {
  const opts = options(process.argv.slice(2))
  if (opts.list) {
    for (const s of SHOTS) console.log(`${s.id.padEnd(28)} ${s.page}`)
    return
  }
  const shots = opts.only ? SHOTS.filter((s) => opts.only.includes(s.id)) : SHOTS
  if (opts.only?.some((id) => !SHOTS.some((s) => s.id === id) && !OG.some((card) => card.id === id)))
    throw Error(`Unknown shot in --only: ${opts.only.join(', ')} (see --list)`)
  const themes = opts.theme ? [opts.theme] : ['light', 'dark']
  await mkdir(OUT, { recursive: true })

  const servers = await startServers(opts.port, shots.some((s) => s.server === 'site'))
  const browser = await launchChrome({ args: ['--force-color-profile=srgb', '--font-render-hinting=none'] })
  let failed = 0
  try {
    const page = await browser.newPage()
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
    await page.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
    await page.send('Emulation.setLocaleOverride', { locale: 'en-US' })
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FIXED_CLOCK, runImmediately: true })
    await page.send('Emulation.setDeviceMetricsOverride', { width: 2400, height: 1600, deviceScaleFactor: SCALE, mobile: false })
    const used = await usages()
    for (const shot of shots) {
      for (const theme of shot.themes ?? themes) {
        if (!themes.includes(theme)) continue
        const file = path.join(OUT, `${shot.id}-${theme}.webp`)
        try {
          const png = await shoot(page, servers, shot, theme)
          const { width, height, bytes } = await write(file, png)
          console.log(`✓ ${path.relative(root, file)}  ${width}×${height}  ${Math.round(bytes / 1024)} KB`)
          const natural = width / SCALE
          // Sizes a page no longer asks for go with the old capture.
          const sizedName = /^(.+)\.w\d+x\d\.webp$/
          for (const old of (await readdir(OUT)).filter((f) => f.match(sizedName)?.[1] === `${shot.id}-${theme}`))
            await rm(path.join(OUT, old))
          for (const shown of shownWidths(used.get(shot.id), natural)) {
            // At its own width, the 2× file already is the 2× picture.
            for (const density of shown === natural ? [1] : [1, 2]) {
              const sized = path.join(OUT, `${shot.id}-${theme}.w${shown}x${density}.webp`)
              const out = await write(sized, await rescale(page, (density * shown) / natural))
              console.log(`  ↳ ${path.basename(sized)}  ${out.width}×${out.height}`)
            }
          }
          await page.send('Emulation.setDeviceMetricsOverride', { width: 2400, height: 1600, deviceScaleFactor: SCALE, mobile: false })
        } catch (error) {
          failed++
          console.error(`✗ ${shot.id} (${theme}): ${error.message}`)
        }
      }
    }
    // The social cards: 1200×630 at 1×, light, the main window beside the wordmark.
    for (const card of OG) {
      if (opts.only && !opts.only.includes(card.id)) continue
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false })
      const png = await shoot(page, servers, card, 'light')
      const out = path.join(root, card.out)
      await writeFile(out, await sharp(png).resize(1200, 630).flatten({ background: '#ffffff' }).png({ compressionLevel: 9 }).toBuffer())
      console.log(`✓ ${path.relative(root, out)}  1200×630`)
    }
  } finally {
    await browser.close()
    await servers.preview.close()
    await servers.site?.close()
  }
  if (failed) {
    console.error(`${failed} screenshot(s) failed`)
    process.exitCode = 1
  }
}

await main()
