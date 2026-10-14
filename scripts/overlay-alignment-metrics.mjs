/**
 * Alignment metrics for the overlay: how far each drawn character is from the character it was
 * read from. Pure, so the headless measurement (measure-overlay-alignment.mjs) and the regression
 * test (overlay-alignment.test.mjs) score the same way.
 *
 * A fixture's truth is a list of lines, each a list of glyphs with their cell (`x, y, w, h`: the
 * advance along the line by the em box across it) and, when known, their ink box, in image pixels.
 * The drawn characters are `{c, cx, cy, ink?, fontSize, vertical}` in overlay points.
 *
 * Each drawn character is given to the truth line it sits on, and the line's drawn text is matched
 * to its true text by longest common subsequence (OCR misreads and drops characters; only matched
 * pairs are scored). Then, per pair, as fractions of the true glyph size:
 *
 *  - along: the error along the line (x for horizontal text, y for vertical)
 *  - across: the error across it
 *  - size: drawn glyph size over the true one (ink height for horizontal text, else font size)
 *
 * and per line the spread of the drawn font sizes (coefficient of variation), which is zero when a
 * line is set at one size.
 */

/** Compare characters as a reader would: full-width and half-width forms alike. */
const fold = (c) => c.normalize('NFKC').toLowerCase()

/** Indices of an LCS between two sequences of characters. */
export function matchSequence(a, b) {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = fold(a[i]) === fold(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const pairs = []
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (fold(a[i]) === fold(b[j])) {
      pairs.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return pairs
}

const centre = (box) => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]

/** A truth line in overlay points: its glyphs (spaces dropped) and its band. */
function truthLine(line, scale) {
  const glyphs = line.glyphs
    .filter((g) => g.c.trim())
    .map((g) => ({
      c: g.c,
      x: g.x / scale,
      y: g.y / scale,
      w: g.w / scale,
      h: g.h / scale,
      ink: g.ink ? g.ink.map((v) => v / scale) : null
    }))
  const size = line.size / scale
  const xs = glyphs.flatMap((g) => [g.x, g.x + g.w])
  const ys = glyphs.flatMap((g) => [g.y, g.y + g.h])
  return {
    vertical: line.vertical,
    size,
    glyphs,
    box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  }
}

/** Which truth line a drawn character belongs to: the nearest band it lies along. */
function lineOf(lines, character) {
  let best = -1
  let bestDistance = Infinity
  lines.forEach((line, index) => {
    const [x0, y0, x1, y1] = line.box
    const s = line.size
    const [across, from, to, along, start, end] = line.vertical
      ? [character.cx, x0, x1, character.cy, y0, y1]
      : [character.cy, y0, y1, character.cx, x0, x1]
    if (along < start - 2 * s || along > end + 2 * s) return
    const distance = across < from ? from - across : across > to ? across - to : 0
    if (distance < 0.9 * s && distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  })
  return best
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN)
function quantile(values, q) {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

/**
 * Score one rendering of one fixture.
 *
 * @param {{lines: {vertical: boolean, size: number, glyphs: {c: string, x: number, y: number, w: number, h: number, ink?: number[]}[]}[]}} truth
 * @param {{c: string, cx: number, cy: number, ink?: number[]|null, fontSize: number}[]} characters
 * @param {number} scale capture pixels per overlay point
 */
export function alignmentMetrics(truth, characters, scale = 1) {
  const lines = truth.lines.map((line) => truthLine(line, scale))
  const assigned = lines.map(() => [])
  for (const character of characters) {
    const index = lineOf(lines, character)
    if (index >= 0) assigned[index].push(character)
  }
  const along = []
  const across = []
  const sizes = []
  const spreads = []
  let truthCount = 0
  let matched = 0
  lines.forEach((line, index) => {
    truthCount += line.glyphs.length
    const drawn = [...assigned[index]].sort((a, b) => (line.vertical ? a.cy - b.cy : a.cx - b.cx))
    const pairs = matchSequence(
      drawn.map((d) => d.c),
      line.glyphs.map((g) => g.c)
    )
    matched += pairs.length
    const fonts = []
    for (const [i, j] of pairs) {
      const d = drawn[i]
      const g = line.glyphs[j]
      const s = line.size
      let dx
      let dy
      if (!line.vertical && d.ink && g.ink) {
        const [tx, ty] = centre(g.ink)
        const [ox, oy] = centre(d.ink)
        dx = ox - tx
        dy = oy - ty
        const trueInk = g.ink[3] - g.ink[1]
        if (trueInk > s * 0.4) sizes.push((d.ink[3] - d.ink[1]) / trueInk)
      } else {
        dx = d.cx - (g.x + g.w / 2)
        dy = d.cy - (g.y + g.h / 2)
        sizes.push(d.fontSize / s)
      }
      along.push(Math.abs(line.vertical ? dy : dx) / s)
      across.push(Math.abs(line.vertical ? dx : dy) / s)
      fonts.push(d.fontSize)
    }
    if (fonts.length > 1) {
      const m = mean(fonts)
      spreads.push(Math.sqrt(mean(fonts.map((f) => (f - m) ** 2))) / m)
    }
  })
  return {
    glyphs: truthCount,
    matched,
    coverage: truthCount ? matched / truthCount : 0,
    alongMean: mean(along),
    alongP90: quantile(along, 0.9),
    acrossMean: mean(across),
    acrossP90: quantile(across, 0.9),
    sizeRatio: quantile(sizes, 0.5),
    sizeSpread: spreads.length ? Math.max(...spreads) : 0,
    within: along.length ? along.filter((v, i) => v < 0.25 && across[i] < 0.25).length / along.length : NaN
  }
}

/** Per engine and mode: glyph-weighted means over its fixtures. */
export function summarize(rows) {
  const groups = new Map()
  for (const row of rows) {
    const key = `${row.engine}\t${row.mode}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return [...groups.entries()].map(([key, members]) => {
    const [engine, mode] = key.split('\t')
    const weight = members.reduce((sum, row) => sum + row.matched, 0) || 1
    const avg = (field) =>
      members.reduce((sum, row) => sum + (Number.isFinite(row[field]) ? row[field] * row.matched : 0), 0) / weight
    return {
      engine,
      mode,
      samples: members.length,
      matched: members.reduce((sum, row) => sum + row.matched, 0),
      glyphs: members.reduce((sum, row) => sum + row.glyphs, 0),
      alongMean: avg('alongMean'),
      alongP90: avg('alongP90'),
      acrossMean: avg('acrossMean'),
      sizeRatio: avg('sizeRatio'),
      sizeSpread: Math.max(...members.map((row) => row.sizeSpread)),
      within: avg('within')
    }
  })
}

const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—')
const fx = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—')

export function formatTable(summary, label) {
  const header = `| ${label} | mode | samples | glyphs matched | along err (mean / p90, ×glyph) | across err (mean) | size ratio | row size spread | glyphs within ¼ glyph |`
  const rule = '|---|---|---|---|---|---|---|---|---|'
  const body = summary
    .sort((a, b) => a.engine.localeCompare(b.engine) || a.mode.localeCompare(b.mode))
    .map(
      (s) =>
        `| ${s.engine} | ${s.mode} | ${s.samples} | ${s.matched}/${s.glyphs} | ${fx(s.alongMean)} / ${fx(s.alongP90)} | ${fx(s.acrossMean)} | ${fx(s.sizeRatio)} | ${pct(s.sizeSpread)} | ${pct(s.within)} |`
    )
  return [header, rule, ...body].join('\n')
}
