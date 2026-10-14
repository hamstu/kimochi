#!/usr/bin/env node
/**
 * How well the overlay's text lines up with the source text under it, per OCR engine.
 *
 *   node scripts/measure-overlay-alignment.mjs generate
 *       Draws the rendered samples (overlay-alignment-samples.mjs) into
 *       scripts/fixtures/overlay-alignment/<name>.png with their ground truth, <name>.truth.json.
 *
 *   node scripts/measure-overlay-alignment.mjs truth <name> --images <dir>
 *       Fills in a real capture's truth (<name>.truth.json, whose `grid` gives each line's text
 *       on its fixed-pitch grid) with the ink of every glyph, read from the image in <dir>.
 *
 *   node scripts/measure-overlay-alignment.mjs normalize <raw.json> <engine> <out.json>
 *       Turns one engine's raw answer (what `ocr_frame` returns) into the normalised result the
 *       overlay consumes (`normalizeOcrResult`), and saves it as a fixture.
 *
 *   node scripts/measure-overlay-alignment.mjs measure [--ui <dir>] [--label <name>]
 *       [--images <dir>] [--out <dir>] [--shots]
 *       Lays every fixture's OCR result over its image with the overlay's real renderer and
 *       stylesheet (`<dir>/render.js` and `<dir>/overlay.html`, default `ui/`), in headless
 *       Chrome, and reports per engine how far each drawn character is from the true one. With
 *       `--shots`, also saves screenshots of each: word mode with every word hovered as the
 *       reader sees it (`.hover`), its text alone in red over the source (`.align`), and grouped
 *       mode light and dark. Metrics and screenshots go to `--out` (default: a folder in the
 *       system's temp directory); `--label` names them (before, after); `--only` picks fixtures.
 *       Images not in the fixtures folder (real captures, which are not committed) are looked
 *       for in `--images`.
 *
 *   node scripts/measure-overlay-alignment.mjs glyphs
 *       Records the overlay font's metrics for every character in the fixtures (glyphs.json),
 *       which the regression test lays text out with, so it needs no browser.
 *
 * Nothing here touches the desktop, the app or the network: Chrome is headless and private.
 * The metrics themselves are pure and shared with the regression test
 * (scripts/overlay-alignment.test.mjs) through scripts/overlay-alignment-metrics.mjs.
 *
 * The corpus, scripts/fixtures/overlay-alignment/:
 *
 *  - Six rendered samples (`generate`), drawn for this, with their images: dialogue in a rounded
 *    gothic with tracking, a 3× pixel font with spaces, long katakana with Latin and digits,
 *    small UI text, a large Mincho title, and vertical columns.
 *  - `chrono`: one line pair of Chrono Trigger dialogue from a real capture (Retina, so scale 2),
 *    its truth from the game's fixed grid and the ink in each cell (`truth`). The image is not
 *    committed; pass its folder as `--images` to measure it.
 *  - `manga`: the manga page from the kimochi-mangaocr crate's test fixtures, likewise not
 *    committed, with no per-glyph truth: the regression test only checks every box lays out.
 *  - `bubble`: one speech bubble from a manga page, a real Quick Shot (263×291, not committed),
 *    two blocks of two vertical columns with ruby beside each; its truth is each glyph's ink read
 *    from the image (３５ share one cell). Its Manga OCR answer is the detector's rough regions.
 *  - `<sample>.<engine>.json`: what each engine answered for that image, once, normalised as
 *    the overlay receives it (`normalizeOcrResult`, less the ink margins, which are applied when
 *    measured so a change to them is measured too). Google Lens through the app's ignored live
 *    test (google_lens.rs), Kimochi cloud through its endpoint, MeikiOCR and Manga OCR through
 *    their crates' examples with the app's models, Apple Live Text through capture-core's
 *    observer, each shaped as `ocr_frame` returns it. Manga OCR finds no text in most game
 *    images (its detector is for manga pages), so it has fixtures only where it did.
 *  - `oneocr-shape`: OneOCR runs only on Windows, so its answer is synthesised from the truth in
 *    the shape its worker returns: a group per line, the line's box two or three pixels outside
 *    the ink, and a word per character (a recorded Windows game frame gave 44 word boxes for 45
 *    characters).
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { evaluate, launchChrome } from './cdp.mjs'
import { SAMPLES } from './overlay-alignment-samples.mjs'
import { alignmentMetrics, summarize, formatTable } from './overlay-alignment-metrics.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const FIXTURES = path.join(root, 'scripts/fixtures/overlay-alignment')

function option(argv, flag, fallback) {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}

/** The renderer from `ui` and the harness's page code, as one script for the page. */
async function pageBundle(ui) {
  const { outputFiles } = await build({
    stdin: {
      contents: `export * from ${JSON.stringify(path.join(ui, 'render.js'))}
export * from ${JSON.stringify(path.join(root, 'scripts/overlay-alignment-page.js'))}`,
      resolveDir: root,
      loader: 'js'
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'harness',
    platform: 'browser',
    target: 'es2022'
  })
  return outputFiles[0].text
}

/** A truth file: one glyph per line, positions to a hundredth of a pixel. */
function truthJson(truth) {
  const round = (key, value) => (typeof value === 'number' ? Math.round(value * 100) / 100 : value)
  const { lines, ...rest } = truth
  const body = lines
    .map((line) => {
      const { glyphs, ...head } = line
      const rows = glyphs.map((glyph) => `    ${JSON.stringify(glyph, round)}`).join(',\n')
      return `  {${JSON.stringify(head, round).slice(1, -1)}, "glyphs": [\n${rows}\n  ]}`
    })
    .join(',\n')
  return `${JSON.stringify(rest, round, 1).slice(0, -2)},\n "lines": [${body ? `\n${body}\n ` : ''}]\n}`
}

/** One module of the overlay under test, bundled and imported here. */
async function importFrom(file) {
  const { outputFiles } = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022'
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
}

/** The overlay's own stylesheet: the first <style> of overlay.html. */
async function overlayCss(ui) {
  const html = await readFile(path.join(ui, 'overlay.html'), 'utf8')
  return html.match(/<style>([\s\S]*?)<\/style>/)[1]
}

async function openPage(browser, viewport) {
  const page = await browser.newPage()
  await page.send('Page.enable')
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.scale ?? 1,
    mobile: false
  })
  return page
}

async function generate() {
  await mkdir(FIXTURES, { recursive: true })
  const browser = await launchChrome()
  try {
    const page = await openPage(browser, { width: 800, height: 600 })
    await evaluate(page, await pageBundle(path.join(root, 'ui')))
    for (const spec of SAMPLES) {
      const { png, truth } = await evaluate(page, `harness.generateSample(${JSON.stringify(spec)})`)
      await writeFile(path.join(FIXTURES, `${spec.name}.png`), Buffer.from(png.split(',')[1], 'base64'))
      await writeFile(path.join(FIXTURES, `${spec.name}.truth.json`), truthJson(truth) + '\n')
      console.log(`${spec.name}: ${truth.lines.length} lines`)
    }
  } finally {
    await browser.close()
  }
}

/**
 * A real capture's truth, from the grid its `grid` records (x0, pitch, size and top of each
 * line, read off the ink once by hand) and the ink in each cell of the image.
 */
async function captureTruth(name, images) {
  const file = path.join(FIXTURES, `${name}.truth.json`)
  const truth = JSON.parse(await readFile(file, 'utf8'))
  const image = path.join(images, truth.image)
  const url = `data:image/png;base64,${(await readFile(image)).toString('base64')}`
  const browser = await launchChrome()
  try {
    const page = await openPage(browser, { width: 800, height: 600 })
    await evaluate(page, await pageBundle(path.join(root, 'ui')))
    truth.lines = await evaluate(page, `harness.inkTruth(${JSON.stringify(url)}, ${JSON.stringify(truth.grid)})`)
  } finally {
    await browser.close()
  }
  await writeFile(file, truthJson(truth) + '\n')
  console.log(`${name}: ${truth.lines.reduce((n, line) => n + line.glyphs.filter((g) => g.ink).length, 0)} glyphs with ink`)
}

/**
 * The overlay font's metrics for every character in the fixtures, measured as the overlay
 * measures them (`measureInk`), saved as glyphs.json for the regression test.
 */
async function glyphs() {
  const characters = new Set()
  for (const file of await readdir(FIXTURES)) {
    if (!file.endsWith('.json') || file.endsWith('.truth.json') || file === 'glyphs.json') continue
    const ocr = JSON.parse(await readFile(path.join(FIXTURES, file), 'utf8'))
    for (const c of JSON.stringify(ocr.textAnnotations.map((a) => a.description))) characters.add(c)
  }
  const browser = await launchChrome()
  let table
  try {
    const page = await openPage(browser, { width: 800, height: 600 })
    await evaluate(page, await pageBundle(path.join(root, 'ui')))
    table = await evaluate(
      page,
      `document.fonts.ready.then(() => harness.glyphTable(harness.measureInk, ${JSON.stringify([...characters].sort())}))`
    )
  } finally {
    await browser.close()
  }
  const font = Object.values(table).find(Boolean)
  const compact = {
    font: { fontAscent: font.fontAscent, fontDescent: font.fontDescent },
    glyphs: Object.fromEntries(
      Object.entries(table).map(([c, m]) => [
        c,
        m ? [m.advance, m.start, m.end, m.ascent, m.descent].map((v) => Math.round(v * 1000) / 1000) : null
      ])
    )
  }
  await writeFile(path.join(FIXTURES, 'glyphs.json'), JSON.stringify(compact) + '\n')
  console.log(`glyphs.json: ${characters.size} characters`)
}

async function normalize(raw, engine, out) {
  const { load } = await import('./load.mjs')
  const { normalizeOcrResult } = await load('ocr-result.ts')
  const value = JSON.parse(await readFile(raw, 'utf8'))
  const result = normalizeOcrResult(value.ocr ?? value, engine)
  // What the overlay reads, to a tenth of a pixel; the ink margins are applied when measured.
  const fixture = {
    engine: result.engine,
    fullText: result.fullText,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped, not used
    textAnnotations: result.textAnnotations.map(({ characters, confidence, inkMargin, ...rest }) => rest)
  }
  const round = (key, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)
  await writeFile(out, JSON.stringify(fixture, round) + '\n')
  console.log(`${out}: ${fixture.textAnnotations.length} annotations`)
}

/** Every fixture: an OCR result named `<sample>.<engine>.json` beside its truth and image. */
async function fixtures(images) {
  const files = await readdir(FIXTURES)
  const out = []
  for (const file of files.sort()) {
    const match = file.match(/^([\w-]+)\.([\w-]+)\.json$/)
    if (!match || match[2] === 'truth') continue
    const [, sample, engine] = match
    const truthFile = path.join(FIXTURES, `${sample}.truth.json`)
    if (!existsSync(truthFile)) continue
    const truth = JSON.parse(await readFile(truthFile, 'utf8'))
    const image = [path.join(FIXTURES, `${sample}.png`), images && path.join(images, truth.image ?? `${sample}.png`)].find(
      (candidate) => candidate && existsSync(candidate)
    )
    out.push({ sample, engine, truth, ocr: JSON.parse(await readFile(path.join(FIXTURES, file), 'utf8')), image })
  }
  return out
}

/**
 * What overlay.js hands the renderer for this result, at `scale` capture pixels per point. The
 * fixtures keep what the engine said; its ink margins are stamped on as `normalizeOcrResult`
 * does (`withInkMargins`, when the overlay under test has it), so a change to them is measured.
 */
export function viewFor(fixture, scale, grouping, withInkMargins = (a) => a) {
  const { width, height } = fixture.truth
  return {
    annotations: withInkMargins(fixture.ocr.textAnnotations, fixture.ocr.engine),
    info: {
      full_width: width,
      full_height: height,
      crop_pixels: [0, 0, width, height],
      source_bounds: { x: 0, y: 0, width: width / scale, height: height / scale }
    },
    origin: { x: 0, y: 0, width: width / scale, height: height / scale },
    grouping: { enabled: grouping, proximityThreshold: 100, filterSmallText: true, filterSmallTextThreshold: 0.75 },
    opacity: 80
  }
}

async function measureAll(argv) {
  const ui = path.resolve(option(argv, '--ui', path.join(root, 'ui')))
  const label = option(argv, '--label', 'current')
  const out = path.resolve(option(argv, '--out', path.join(os.tmpdir(), 'kimochi-overlay-alignment')))
  const images = option(argv, '--images', null)
  const shots = argv.includes('--shots')
  const only = option(argv, '--only', null)
  await mkdir(out, { recursive: true })
  const bundle = await pageBundle(ui)
  const { withInkMargins } = await importFrom(path.join(ui, 'ocr-result.ts'))
  const css = await overlayCss(ui)
  const all = (await fixtures(images)).filter((f) => !only || `${f.sample}.${f.engine}`.includes(only))
  const browser = await launchChrome()
  const rows = []
  try {
    for (const fixture of all) {
      if (!fixture.image) {
        console.warn(`${fixture.sample}.${fixture.engine}: no image, skipped`)
        continue
      }
      const scale = fixture.truth.scale ?? 1
      const imageUrl = `data:image/${fixture.image.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${(await readFile(fixture.image)).toString('base64')}`
      for (const grouping of [false, true]) {
        const viewport = {
          width: Math.ceil(fixture.truth.width / scale),
          height: Math.ceil(fixture.truth.height / scale),
          scale
        }
        const page = await openPage(browser, viewport)
        await evaluate(page, bundle)
        const run = async (diagnostic) =>
          evaluate(
            page,
            `harness.measure({ Renderer: harness.TextOverlayRenderer, css: ${JSON.stringify(css)},
              imageUrl: ${JSON.stringify(imageUrl)}, view: ${JSON.stringify(viewFor(fixture, scale, grouping, withInkMargins))},
              scale: ${scale}, diagnostic: ${diagnostic} })`
          )
        const result = await run(false)
        const metrics = alignmentMetrics(fixture.truth, result.characters, scale)
        rows.push({ sample: fixture.sample, engine: fixture.engine, mode: grouping ? 'grouped' : 'words', ...metrics })
        if (shots) {
          const name = `${fixture.sample}.${fixture.engine}.${grouping ? 'grouped' : 'words'}.${label}`
          if (!grouping) {
            await run(true)
            const { data } = await page.send('Page.captureScreenshot', { format: 'png' })
            await writeFile(path.join(out, `${name}.align.png`), Buffer.from(data, 'base64'))
            await run(false)
            const hover = await page.send('Page.captureScreenshot', { format: 'png' })
            await writeFile(path.join(out, `${name}.hover.png`), Buffer.from(hover.data, 'base64'))
          } else {
            for (const theme of ['light', 'dark']) {
              await page.send('Emulation.setEmulatedMedia', {
                features: [{ name: 'prefers-color-scheme', value: theme }]
              })
              await run(false)
              const { data } = await page.send('Page.captureScreenshot', { format: 'png' })
              await writeFile(path.join(out, `${name}.${theme}.png`), Buffer.from(data, 'base64'))
            }
          }
        }
        await browser.send('Target.closeTarget', { targetId: page.targetId })
      }
    }
  } finally {
    await browser.close()
  }
  await writeFile(path.join(out, `metrics.${label}.json`), JSON.stringify(rows, null, 1) + '\n')
  console.log(formatTable(summarize(rows), label))
  return rows
}

const [command, ...argv] = process.argv.slice(2)
if (command === 'generate') await generate()
else if (command === 'normalize') await normalize(argv[0], argv[1], argv[2])
else if (command === 'truth') await captureTruth(argv[0], option(argv, '--images', FIXTURES))
else if (command === 'glyphs') await glyphs()
else if (command === 'measure') await measureAll(argv)
else {
  console.error('usage: measure-overlay-alignment.mjs generate | normalize <raw> <engine> <out> | measure [...]')
  process.exitCode = 2
}
