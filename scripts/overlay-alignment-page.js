/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Browser-side harness code. */
/* global document, window, Image, getComputedStyle, requestAnimationFrame */
/**
 * The browser half of the overlay alignment harness (scripts/measure-overlay-alignment.mjs).
 * Bundled with the overlay's own `ui/render.js` and run in headless Chrome, never in the app.
 *
 *  - `generateSample(spec)` draws a game-style test image glyph by glyph, so the true cell of
 *    every character (its advance along the line and its em box across it) is known exactly.
 *  - `inkTruth(...)` derives the same cells for a real capture set in a fixed-pitch font, from
 *    the ink of each line and its known text.
 *  - `measure(...)` lays the overlay over a sample with the real renderer and stylesheet and reads
 *    back where every drawn character is (Range rectangles), its font size and the box it sits in.
 */

/** Draw one sample. Every glyph is placed by hand, so its cell is exact; nothing is kerned. */
export async function generateSample(spec) {
  await document.fonts.ready
  const canvas = document.createElement('canvas')
  const scale = spec.pixel ?? 1
  canvas.width = spec.width
  canvas.height = spec.height
  const ctx = canvas.getContext('2d')
  // Pixel-art samples are drawn small and blown up with nearest-neighbour, like a retro console.
  const draw = scale > 1 ? document.createElement('canvas') : canvas
  if (scale > 1) {
    draw.width = Math.round(spec.width / scale)
    draw.height = Math.round(spec.height / scale)
  }
  const g = draw.getContext('2d')
  g.fillStyle = spec.background
  g.fillRect(0, 0, draw.width, draw.height)
  for (const panel of spec.panels ?? []) {
    g.fillStyle = panel.fill
    g.strokeStyle = panel.stroke ?? panel.fill
    g.lineWidth = panel.border ?? 0
    g.beginPath()
    g.roundRect(panel.x / scale, panel.y / scale, panel.width / scale, panel.height / scale, (panel.radius ?? 0) / scale)
    g.fill()
    if (panel.border) g.stroke()
  }
  if (scale > 1) g.imageSmoothingEnabled = false
  const lines = []
  for (const line of spec.lines) {
    const size = line.size / scale
    g.font = `${line.weight ?? 'normal'} ${size}px ${line.font}`
    g.fillStyle = line.color
    g.textBaseline = 'ideographic'
    const tracking = (line.tracking ?? 0) * size
    const glyphs = []
    if (!line.vertical) {
      let x = line.x / scale
      const top = line.y / scale
      for (const c of line.text) {
        const m = g.measureText(c)
        const advance = line.monospace ? (/[ -~]/.test(c) ? size / 2 : size) : m.width
        const dx = line.monospace ? (advance - m.width) / 2 : 0
        g.fillText(c, x + dx, top + size)
        glyphs.push({
          c,
          x: x * scale,
          y: top * scale,
          w: advance * scale,
          h: size * scale,
          ink: [
            (x + dx - m.actualBoundingBoxLeft) * scale,
            (top + size - m.actualBoundingBoxAscent) * scale,
            (x + dx + m.actualBoundingBoxRight) * scale,
            (top + size + m.actualBoundingBoxDescent) * scale
          ]
        })
        x += advance + tracking
      }
    } else {
      // A column, right to left: each glyph centred in a square cell down the column.
      const left = line.x / scale
      let y = line.y / scale
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      for (const c of line.text) {
        const m = g.measureText(c)
        const cx = left + size / 2
        const cy = y + size / 2
        g.fillText(c, cx, cy)
        glyphs.push({
          c,
          x: left * scale,
          y: y * scale,
          w: size * scale,
          h: size * scale,
          ink: [
            (cx - m.actualBoundingBoxLeft) * scale,
            (cy - m.actualBoundingBoxAscent) * scale,
            (cx + m.actualBoundingBoxRight) * scale,
            (cy + m.actualBoundingBoxDescent) * scale
          ]
        })
        y += size + tracking
      }
      g.textAlign = 'start'
    }
    lines.push({ text: line.text, vertical: !!line.vertical, size: line.size, glyphs })
  }
  if (scale > 1) {
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(draw, 0, 0, spec.width, spec.height)
  }
  return {
    png: canvas.toDataURL('image/png'),
    truth: { name: spec.name, width: spec.width, height: spec.height, source: 'rendered', lines }
  }
}

async function loadImage(url) {
  const image = new Image()
  image.src = url
  await image.decode()
  return image
}

/**
 * The truth for a real capture set in a fixed-pitch font (most console games): each line's known
 * text on its grid (`x0`, `pitch`, glyph `size`, em box `top`, read off the ink once by hand), and
 * each glyph's ink, found as the light pixels inside its cell.
 *
 * `lines`: [{text, x0, pitch, size, top}] in image pixels.
 */
export async function inkTruth(url, lines, { threshold = 150 } = {}) {
  const image = await loadImage(url)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const g = canvas.getContext('2d')
  g.drawImage(image, 0, 0)
  const { data, width } = g.getImageData(0, 0, canvas.width, canvas.height)
  const bright = (x, y) => {
    const i = (y * width + x) * 4
    return Math.min(data[i], data[i + 1], data[i + 2]) > threshold
  }
  return lines.map((line) => ({
    text: line.text,
    vertical: false,
    size: line.size,
    glyphs: [...line.text].map((c, i) => {
      const x = Math.round(line.x0 + i * line.pitch)
      const box = [Infinity, Infinity, -Infinity, -Infinity]
      for (let y = Math.round(line.top - line.size * 0.15); y < line.top + line.size * 1.15; y++)
        for (let px = x; px < x + line.pitch; px++)
          if (bright(px, y)) {
            box[0] = Math.min(box[0], px)
            box[1] = Math.min(box[1], y)
            box[2] = Math.max(box[2], px + 1)
            box[3] = Math.max(box[3], y + 1)
          }
      return {
        c,
        x,
        y: line.top,
        w: line.size,
        h: line.size,
        ...(box[0] < box[2] ? { ink: box } : {})
      }
    })
  }))
}

/**
 * Every character's metrics in the overlay's font (`measureInk`, one character at a time), for
 * the regression test to lay text out exactly as the overlay does without a browser.
 */
export function glyphTable(measureInk, characters) {
  const table = {}
  for (const c of characters) table[c] = measureInk(c)
  return table
}

/** Where every drawn character is, read back from the DOM after the renderer laid it out. */
function readCharacters(container) {
  const out = []
  const ctx = document.createElement('canvas').getContext('2d')
  const walker = document.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const host = node.parentElement
    if (!host || host.closest('.ocr-lookahead')) continue
    const box = host.closest('[data-ocr-word-box]')
    if (!box || getComputedStyle(box).visibility === 'hidden') continue
    const style = getComputedStyle(host)
    const fontSize = parseFloat(style.fontSize)
    const spacing = parseFloat(style.letterSpacing) || 0
    const vertical = style.writingMode.startsWith('vertical')
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`
    // A transformed box (the old hover zoom) draws its glyphs bigger than its font size says.
    const zoom = (() => {
      const t = getComputedStyle(box).transform
      const m = t && t !== 'none' ? t.match(/matrix\(([^,]+)/) : null
      return m ? parseFloat(m[1]) : 1
    })()
    const text = node.textContent
    let offset = 0
    for (const c of text) {
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset + c.length)
      offset += c.length
      if (c === '\n' || c.trim() === '') continue
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0)
      if (!rects.length) continue
      const r = rects[0]
      // Letter spacing is added after each glyph: the glyph is centred in the rest of its advance.
      const cx = vertical ? r.left + r.width / 2 : r.left + (r.width - spacing * zoom) / 2
      const cy = vertical ? r.top + (r.height - spacing * zoom) / 2 : r.top + r.height / 2
      const m = ctx.measureText(c)
      let ink = null
      if (!vertical) {
        // The rectangle is the primary font's ascent over its descent; the baseline divides it.
        const a = m.fontBoundingBoxAscent
        const d = m.fontBoundingBoxDescent
        const baseline = r.top + (r.height * a) / (a + d)
        ink = [
          r.left - m.actualBoundingBoxLeft * zoom,
          baseline - m.actualBoundingBoxAscent * zoom,
          r.left + m.actualBoundingBoxRight * zoom,
          baseline + m.actualBoundingBoxDescent * zoom
        ]
      }
      out.push({
        c,
        cx,
        cy,
        ink,
        fontSize: fontSize * zoom,
        vertical,
        box: Number(box.dataset.harnessIndex ?? -1)
      })
    }
  }
  return out
}

/**
 * Lay the overlay over a sample and report every drawn character.
 *
 * `render` is the bundled `TextOverlayRenderer`; `view` what overlay.js would hand it. Word mode
 * is measured as the reader sees it while pointing at a word: every box marked as hovered.
 */
export async function measure({ Renderer, css, imageUrl, view, scale, hover = true, diagnostic = false }) {
  document.head.querySelector('#harness-style')?.remove()
  const style = document.createElement('style')
  style.id = 'harness-style'
  style.textContent =
    css +
    `
    body { margin: 0; background: #fff; }
    #source { position: absolute; left: 0; top: 0; }
    ${
      diagnostic
        ? `.ocr-word, .ocr-group { background: transparent !important; border-color: transparent !important; box-shadow: none !important; }
           .ocr-word::before, .ocr-word::after { display: none !important; }
           .ocr-word { color: rgba(255, 0, 64, 0.85) !important; }
           .ocr-group { color: rgba(255, 0, 64, 0.85) !important; }`
        : ''
    }`
  document.head.append(style)
  document.body.replaceChildren()
  const image = await loadImage(imageUrl)
  const source = document.createElement('img')
  source.id = 'source'
  source.src = imageUrl
  source.style.width = `${image.naturalWidth / scale}px`
  source.style.height = `${image.naturalHeight / scale}px`
  document.body.append(source)
  const container = document.createElement('div')
  container.id = 'words'
  document.body.append(container)
  await document.fonts.ready
  const renderer = new Renderer(container, {})
  renderer.render(view)
  ;[...container.children].forEach((element, index) => (element.dataset.harnessIndex = String(index)))
  if (hover && renderer.mode === 'words') {
    renderer.selectionIndices = new Set(renderer.words.map((word) => word.index))
    renderer.updateProximity()
  }
  // Let transitions settle before reading positions (the hover zoom animates).
  for (const element of container.querySelectorAll('*')) element.style.transition = 'none'
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const characters = readCharacters(container)
  const boxes = [...container.children].map((element) => {
    const r = element.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height, text: element.textContent }
  })
  window.__renderer = renderer
  return { characters, boxes, mode: renderer.mode }
}
