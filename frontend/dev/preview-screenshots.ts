/**
 * DEV-ONLY: screenshots' commands for the browser preview (`preview-setup.ts`).
 *
 * The open session's OCR lines have screenshots, two lines to a scan (a line the site's demo adds
 * gets its own, `demoLineAdded`): a drawn game scene with the lines in its dialogue box, the box
 * as the OCR crop area and the lines' text marked. `?screenshots=0` leaves every line without.
 */
import { snapshotLines } from '@texthooker/core/store'
import { scanOf, type Shot } from '@texthooker/lib/screenshots'

const ON = new URLSearchParams(location.search).get('screenshots') !== '0'
const W = 1280
const H = 720

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A game scene: sky, hills, a figure, and a dialogue box with `lines` in it. */
function scene(lines: string[], hue: number): string {
  const text = lines
    .map((line, i) => `<text x="120" y="${560 + i * 52}" font-size="34" fill="#fff" font-family="Hiragino Sans, sans-serif">${escape(line.slice(0, 30))}</text>`)
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 60% 70%)"/><stop offset="1" stop-color="hsl(${hue + 30} 70% 88%)"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#sky)"/>
<ellipse cx="300" cy="560" rx="520" ry="160" fill="hsl(${hue + 90} 35% 45%)"/>
<ellipse cx="1000" cy="580" rx="560" ry="180" fill="hsl(${hue + 100} 30% 38%)"/>
<circle cx="980" cy="250" r="70" fill="hsl(${hue} 30% 30%)"/><rect x="920" y="320" width="120" height="200" rx="40" fill="hsl(${hue} 30% 30%)"/>
<rect x="80" y="500" width="1120" height="190" rx="18" fill="rgba(10,14,30,0.82)" stroke="rgba(255,255,255,0.6)" stroke-width="3"/>
${text}</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function shots(): Shot[] {
  if (!ON) return []
  const byScan = new Map<string, { at: number; texts: string[] }>()
  for (const line of snapshotLines()) {
    const scan = scanOf(line)
    if (!scan) continue
    const entry = byScan.get(scan) ?? { at: line.ts, texts: [] }
    entry.texts.push(line.text)
    byScan.set(scan, entry)
  }
  return [...byScan.entries()].map(([scan, { at, texts }], i) => shotOf(scan, at, texts, i))
}

/** Scan `scan`'s screenshot: a scene with `texts` in its dialogue box. */
export function shotOf(scan: string, at: number, texts: string[], i: number): Shot {
  return {
    scan,
    url: scene(texts, (i * 37) % 360),
    at,
    width: W,
    height: H,
    text: texts.join('\n'),
    crop: [80, 500, 1120, 190],
    marks: texts.map((text, j) => ({
      text,
      bbox: [112, 526 + j * 52, 112 + Math.min(30, text.length) * 34 + 8, 572 + j * 52] as [number, number, number, number]
    }))
  }
}

export const SCREENSHOTS_ON = ON

export const SCREENSHOT_HANDLERS: Record<string, (args: Record<string, unknown> | undefined) => unknown> = {
  screenshots_list: shots,
  screenshot_status: () => ({ kept: shots().length, last: null }),
  screenshot_attach: () => null,
  screenshot_add_to_note: () => null
}
