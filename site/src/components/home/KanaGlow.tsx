import { useEffect, useRef, type CSSProperties } from 'react'

/**
 * A soft orb of kana and kanji glowing out from the top centre of the hero, like ASCII art drawn
 * with Japanese, in one WebGL2 fragment pass.
 *
 * The page is a fixed grid of glyph cells. Each cell's intensity is a squashed radial falloff from
 * the orb's centre, times slow, domain-warped fbm noise that drifts and morphs, so patches of the
 * glow brighten and dim like breathing. Intensity sets a cell's opacity, and (through the glyph it
 * picks) its density: the atlas is sorted from the sparsest stroke (ヽ, 一) to the densest (響, 靄),
 * so the core is drawn in heavy kanji and the rim in light kana. Glyphs change rarely, each cell on
 * its own clock, cross-fading into the next instead of snapping. Nothing is simulated on the CPU:
 * a frame is a pure function of time, so it costs one draw call.
 *
 * It fades in over ~1.8 s, the orb blooming outward from its centre. Pauses off screen and in
 * hidden tabs, draws one still frame under reduced motion, re-reads its colours (tokens) when the
 * theme changes, and renders nothing where WebGL2 is unavailable.
 */

// From sparse to dense; the atlas re-sorts them by measured ink, so this order is only a guide.
const GLYPHS = Array.from(
  'ヽ丶一ノ・ーニ二ヘへくしつソンシハ人入八十小リりいこ' +
    'アイウエオカキクケコサスセタチツテトナヌネホマミムメモヤユヨラルレロワヲ' +
    'あうえおかきけさすせそたちてとなにぬねのはひふほまみむめもやゆよらるれろわをん' +
    '日月山川木水火土心気本文言音光空星雨花風雪海夜夢字読語声葉持' +
    '雲霧響輝露願靄漂癒瀬曙霞燈鶴龍',
)

const ATLAS_COLS = 12
const CELL = 96 // atlas cell, device pixels
const FONT = '"Noto Sans JP Variable", "Hiragino Sans", sans-serif'
const FADE_MS = 1800

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;      // canvas size, device pixels
uniform float uTime;    // seconds
uniform float uScale;   // device pixels per CSS pixel
uniform float uCell;    // grid cell, CSS pixels
uniform float uFade;    // 0..1, the mount fade-in
uniform float uGain;    // peak opacity
uniform float uCeil;    // the most any glyph shows: it stays in the background
uniform vec2 uOrb;      // orb centre, CSS pixels from the top left
uniform vec2 uRadius;   // orb radii, CSS pixels
uniform sampler2D uAtlas;
uniform vec3 uEdge;     // rim colour
uniform vec3 uInk;      // body colour
uniform vec3 uCore;     // core colour
out vec4 outColor;

const float COLS = ${ATLAS_COLS}.0;
const float COUNT = ${GLYPHS.length}.0;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s / 0.875;
}

vec2 glyph(float id, vec2 uv) {
  float gx = mod(id, COLS);
  float gy = floor(id / COLS);
  return texture(uAtlas, (vec2(gx, gy) + uv) / vec2(COLS, ceil(COUNT / COLS))).rg;
}

void main() {
  vec2 css = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uScale;
  vec2 cell = floor(css / uCell);
  vec2 uv = fract(css / uCell);
  vec2 cc = (cell + 0.5) * uCell;

  // The orb: a squashed falloff with a long, faint tail.
  vec2 d = (cc - uOrb) / uRadius;
  float r = length(d);
  float fall = exp(-r * r * 1.4) * 0.85 + exp(-r * 2.2) * 0.25;

  // Slow morphing noise: fbm warped by fbm, drifting.
  float t = uTime;
  vec2 p = cc / 260.0;
  vec2 w = vec2(fbm(p + vec2(0.0, t * 0.08)), fbm(p + vec2(5.2, 1.3) - t * 0.065));
  float n = fbm(p * 1.2 + w * 1.9 + vec2(t * 0.04, -t * 0.05));
  n = smoothstep(0.15, 0.85, n);
  float I = fall * mix(0.4, 1.3, n);

  // Each cell breathes a little on its own.
  float h = hash(cell);
  I *= 0.75 + 0.25 * sin(t * mix(0.6, 1.5, hash(cell + 7.7)) + h * 6.2832);

  // Sparse at the rim: a cell shows only once the glow passes its own threshold (smoothly).
  float h2 = hash(cell + 3.3);
  float present = smoothstep(h2 - 0.1, h2 + 0.1, I * 1.6);

  // Glyph choice: denser glyphs nearer the core, re-rolled rarely, cross-faded on the cell's clock.
  float period = mix(2.0, 6.0, hash(cell + 1.9));
  float ph = t / period + h * 11.0;
  float k = floor(ph);
  float blend = smoothstep(0.6, 1.0, fract(ph));
  float base = clamp(fall, 0.0, 1.0) * 0.82;
  float wA = clamp(base + (hash(cell + vec2(k * 13.7, k * 3.1)) - 0.5) * 0.6, 0.0, 1.0);
  float wB = clamp(base + (hash(cell + vec2((k + 1.0) * 13.7, (k + 1.0) * 3.1)) - 0.5) * 0.6, 0.0, 1.0);
  vec2 gA = glyph(floor(wA * (COUNT - 1.0) + 0.5), uv);
  vec2 gB = glyph(floor(wB * (COUNT - 1.0) + 0.5), uv);
  vec2 g = mix(gA, gB, blend);

  // Fade in, blooming outward from the orb.
  float reveal = smoothstep(0.0, 1.0, uFade * 2.2 - r * 0.45) * uFade;

  float a = pow(smoothstep(0.03, 1.0, I), 1.4) * present * reveal * uGain;
  float coreAmt = smoothstep(0.55, 1.1, I);
  float ink = g.r + g.g * 0.2 * coreAmt;
  // A soft ceiling, so the brightest patches level off instead of flaring.
  float alpha = uCeil * (1.0 - exp(-ink * a * 2.2 / uCeil));
  vec3 rgb = mix(uEdge, uInk, smoothstep(0.08, 0.5, I));
  rgb = mix(rgb, uCore, coreAmt * 0.7);
  outColor = vec4(rgb * alpha, alpha); // premultiplied
}`

/** Renders the glyphs, sorted by ink, into an atlas: red = sharp glyph, green = a blurred copy. */
function buildAtlas(): HTMLCanvasElement {
  // Measure each glyph's ink, so the atlas runs from sparse to dense.
  const m = document.createElement('canvas')
  m.width = m.height = 32
  const mctx = m.getContext('2d', { willReadFrequently: true })!
  mctx.textAlign = 'center'
  mctx.textBaseline = 'middle'
  mctx.font = `500 22px ${FONT}`
  const inkOf = (ch: string): number => {
    mctx.clearRect(0, 0, 32, 32)
    mctx.fillText(ch, 16, 16)
    const px = mctx.getImageData(0, 0, 32, 32).data
    let sum = 0
    for (let i = 3; i < px.length; i += 4) sum += px[i]
    return sum
  }
  const sorted = GLYPHS.map((ch) => [ch, inkOf(ch)] as const)
    .sort((a, b) => a[1] - b[1])
    .map(([ch]) => ch)

  const rows = Math.ceil(sorted.length / ATLAS_COLS)
  const make = (): [HTMLCanvasElement, CanvasRenderingContext2D] => {
    const c = document.createElement('canvas')
    c.width = ATLAS_COLS * CELL
    c.height = rows * CELL
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `500 ${CELL * 0.64}px ${FONT}`
    return [c, ctx]
  }
  const [sharp, sctx] = make()
  const [glow, gctx] = make()
  gctx.filter = `blur(${CELL * 0.1}px)`
  sorted.forEach((ch, i) => {
    const x = (i % ATLAS_COLS) * CELL + CELL / 2
    const y = Math.floor(i / ATLAS_COLS) * CELL + CELL / 2
    sctx.fillText(ch, x, y)
    gctx.fillText(ch, x, y)
  })
  const out = document.createElement('canvas')
  out.width = sharp.width
  out.height = sharp.height
  const octx = out.getContext('2d')!
  const s = sctx.getImageData(0, 0, sharp.width, sharp.height).data
  const g = gctx.getImageData(0, 0, glow.width, glow.height).data
  const img = octx.createImageData(sharp.width, sharp.height)
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = s[i + 3]
    img.data[i + 1] = g[i + 3]
    img.data[i + 3] = 255
  }
  octx.putImageData(img, 0, 0)
  return out
}

/** Reads a CSS colour (any syntax the browser knows) as 0..1 RGB. */
function cssColor(value: string): [number, number, number] {
  const c = document.createElement('canvas')
  c.width = c.height = 1
  const ctx = c.getContext('2d')!
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return [r / 255, g / 255, b / 255]
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`KanaGlow shader: ${gl.getShaderInfoLog(s)}`)
  return s
}

export function KanaGlow({ className = '', style }: { className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false })
    if (!gl) return
    let disposed = false
    let raf = 0
    let visible = true
    let shownAt = 0 // when the atlas was ready: the fade-in starts here
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const start = performance.now() - 30_000 // start somewhere into the noise, not at its origin

    // A background flourish: if the GPU path fails, log it and leave the hero plain.
    const prog = gl.createProgram()!
    try {
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG))
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`KanaGlow link: ${gl.getProgramInfoLog(prog)}`)
    } catch (err) {
      console.warn(err)
      return
    }
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
    const u = (n: string) => gl.getUniformLocation(prog, n)
    const uRes = u('uRes'), uTime = u('uTime'), uScale = u('uScale'), uCell = u('uCell'), uFade = u('uFade')
    const uGain = u('uGain'), uCeil = u('uCeil')
    const uOrb = u('uOrb'), uRadius = u('uRadius'), uEdge = u('uEdge'), uInk = u('uInk'), uCore = u('uCore')

    const tex = gl.createTexture()
    let ready = false

    const setColors = (): void => {
      const root = getComputedStyle(document.documentElement)
      const token = (name: string, fallback: string): [number, number, number] =>
        cssColor(root.getPropertyValue(name).trim() || fallback)
      const dark = root.colorScheme.includes('dark')
      const mix = (a: number[], b: number[], t: number): number[] => a.map((v, i) => v + (b[i] - v) * t)
      const accent = token('--k-accent', '#3e63dd')
      const accentText = token('--k-accent-text', '#3a5bc7')
      const quiet = token('--k-text-3', '#80838d')
      // Blue all the way through, never white: a muted blue at the rim, the accent in the body,
      // and at the core the accent's light text tone in dark mode (its full strength in light).
      gl.uniform3fv(uEdge, mix(quiet, accent, 0.55))
      gl.uniform3fv(uInk, dark ? accent : accentText)
      gl.uniform3fv(uCore, dark ? mix(accentText, accent, 0.25) : accent)
      gl.uniform1f(uCeil, dark ? 0.42 : 0.5)
    }

    const draw = (now: number): boolean => {
      if (!ready) return false
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const cw = canvas.clientWidth
      const w = Math.round(cw * dpr)
      const h = Math.round(canvas.clientHeight * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        gl.viewport(0, 0, w, h)
      }
      const narrow = cw < 640
      const fadeT = reduced.matches ? 1 : Math.min(1, (now - shownAt) / FADE_MS)
      gl.uniform2f(uRes, w, h)
      gl.uniform1f(uScale, dpr)
      gl.uniform1f(uCell, narrow ? 15 : 18)
      gl.uniform2f(uOrb, cw / 2, narrow ? 70 : 110)
      gl.uniform2f(uRadius, narrow ? cw * 0.8 : Math.min(cw * 0.66, 1000), narrow ? 330 : 560)
      gl.uniform1f(uGain, narrow ? 0.45 : 0.7) // a phone shows the orb larger, so dimmer
      gl.uniform1f(uFade, fadeT * fadeT * (3 - 2 * fadeT)) // ease in and out
      gl.uniform1f(uTime, (now - start) / 1000)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      return fadeT < 1
    }

    const loop = (now: number): void => {
      raf = 0
      const fading = draw(now)
      // Under reduced motion only the (instant) still frame is drawn; `fading` is false there.
      if (visible && !document.hidden && (fading || !reduced.matches)) raf = requestAnimationFrame(loop)
    }
    const kick = (): void => {
      if (!raf && !disposed) raf = requestAnimationFrame(loop)
    }

    document.fonts
      .load(`500 48px ${FONT}`, GLYPHS.join(''))
      .catch(() => undefined)
      .then(() => {
        if (disposed) return
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, buildAtlas())
        gl.generateMipmap(gl.TEXTURE_2D)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        setColors()
        ready = true
        shownAt = performance.now()
        kick()
      })

    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
      if (visible) kick()
    })
    io.observe(canvas)
    const ro = new ResizeObserver(kick)
    ro.observe(canvas)
    const onTheme = (): void => {
      setColors()
      kick()
    }
    const themeObs = new MutationObserver(onTheme)
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    scheme.addEventListener('change', onTheme)
    reduced.addEventListener('change', kick)
    document.addEventListener('visibilitychange', kick)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      io.disconnect()
      ro.disconnect()
      themeObs.disconnect()
      scheme.removeEventListener('change', onTheme)
      reduced.removeEventListener('change', kick)
      document.removeEventListener('visibilitychange', kick)
      // Not loseContext(): the canvas keeps its context, and a remount (React strict mode) gets it back.
      gl.deleteTexture(tex)
      gl.deleteBuffer(buf)
      gl.deleteProgram(prog)
    }
  }, [])

  return <canvas ref={ref} aria-hidden style={style} className={`pointer-events-none block ${className}`} />
}
