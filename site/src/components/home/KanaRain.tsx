import { useEffect, useRef, type CSSProperties } from 'react'

/**
 * Falling columns of kana and kanji behind the hero, drawn in one WebGL2 fragment pass.
 *
 * The glyphs are rasterised once into an atlas: red holds the sharp glyph, green a blurred copy
 * that gives each character its glow. Three layers of columns at different sizes, speeds and
 * brightness give depth. Each column carries a drop whose head is bright, near-white and changes
 * character quickly; the trail behind it fades out and its characters change only now and then.
 * A soft streak along each lit column adds the haze. Nothing is simulated on the CPU: every
 * frame is a pure function of time, so a frame costs one draw call.
 *
 * Pauses off screen and in hidden tabs, and draws a single still frame under reduced motion.
 * Renders nothing where WebGL2 is unavailable.
 */

const KANA =
  'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン' +
  'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん'
const KANJI = '気持日本語読文字言葉夢光雨心音声星空月火水木金土山川花風雪海名前'
const GLYPHS = Array.from(KANA + KANJI)

const ATLAS_COLS = 12
const CELL = 96 // atlas cell, device pixels
const FONT = '"Noto Sans JP Variable", "Hiragino Sans", sans-serif'

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;      // canvas size, device pixels
uniform float uTime;    // seconds
uniform float uScale;   // device pixels per CSS pixel
uniform sampler2D uAtlas;
uniform vec3 uTrail;    // trail colour
uniform vec3 uHead;     // head colour
out vec4 outColor;

const float COLS = ${ATLAS_COLS}.0;
const float COUNT = ${GLYPHS.length}.0;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec2 glyph(float id, vec2 uv) {
  float gx = mod(id, COLS);
  float gy = floor(id / COLS);
  return texture(uAtlas, (vec2(gx, gy) + uv) / vec2(COLS, ceil(COUNT / COLS))).rg;
}

// One layer of columns. Returns (trail amount, head amount).
vec2 layer(vec2 px, float size, float speed, float bright, float seed) {
  float cs = size * uScale;
  float col = floor(px.x / cs);
  float hc = hash(vec2(col, seed));
  if (hc < 0.18) return vec2(0.0);                    // some columns stay empty
  float rows = uRes.y / cs;
  float trail = mix(8.0, 26.0, hash(vec2(col, seed + 1.0)));
  float cycle = rows + trail + mix(4.0, 40.0, hash(vec2(col, seed + 2.0)));
  float v = speed * mix(0.6, 1.4, hash(vec2(col, seed + 3.0)));
  float head = mod(uTime * v + hc * cycle, cycle);    // head position, in rows from the top
  float row = floor(px.y / cs);
  float d = head - row;                               // rows behind the head
  if (d < 0.0 || d > trail) return vec2(0.0);

  vec2 uv = vec2(fract(px.x / cs), fract(px.y / cs));
  bool isHead = d < 1.0;
  // The head flickers fast; trailing cells change slowly, each on its own clock.
  float cellSeed = hash(vec2(col * 7.0 + seed, row));
  float rate = isHead ? 14.0 : mix(0.15, 1.2, cellSeed);
  float id = floor(hash(vec2(col + seed, row + floor(uTime * rate + cellSeed * 9.0))) * COUNT);
  vec2 g = glyph(id, uv);

  float fade = pow(1.0 - d / trail, 1.6);
  float amount = (g.r + g.g * 0.5) * fade * bright;
  // Haze: a soft streak down the middle of the lit part of the column.
  float streak = 1.0 - abs(uv.x - 0.5) * 2.0;
  amount += streak * streak * fade * bright * 0.06;
  float h = isHead ? (g.r * 2.0 + g.g * 0.35) * bright : 0.0;
  return vec2(amount, h);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 a = layer(px, 11.0, 5.0, 0.28, 31.0)
         + layer(px, 15.0, 7.5, 0.55, 17.0)
         + layer(px, 21.0, 10.0, 1.0, 3.0);
  float trail = clamp(a.x, 0.0, 1.0);
  float head = clamp(a.y, 0.0, 1.0);
  vec3 rgb = mix(uTrail, uHead, head / max(trail + head, 1e-4));
  float alpha = clamp(trail + head, 0.0, 1.0);
  outColor = vec4(rgb * alpha, alpha);                // premultiplied
}`

function buildAtlas(): HTMLCanvasElement {
  const rows = Math.ceil(GLYPHS.length / ATLAS_COLS)
  const make = (): [HTMLCanvasElement, CanvasRenderingContext2D] => {
    const c = document.createElement('canvas')
    c.width = ATLAS_COLS * CELL
    c.height = rows * CELL
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `500 ${CELL * 0.62}px ${FONT}`
    return [c, ctx]
  }
  const [sharp, sctx] = make()
  const [glow, gctx] = make()
  gctx.filter = `blur(${CELL * 0.09}px)`
  GLYPHS.forEach((ch, i) => {
    const x = (i % ATLAS_COLS) * CELL + CELL / 2
    const y = Math.floor(i / ATLAS_COLS) * CELL + CELL / 2
    sctx.fillText(ch, x, y)
    gctx.fillText(ch, x, y)
    gctx.fillText(ch, x, y)
  })
  // Pack: red = sharp, green = glow.
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

/** Reads a CSS colour (any syntax the browser knows) as linear 0..1 RGB. */
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
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`KanaRain shader: ${gl.getShaderInfoLog(s)}`)
  return s
}

export function KanaRain({ className = '', style }: { className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false })
    if (!gl) return
    let disposed = false
    let raf = 0
    let visible = true
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const start = performance.now() - 40_000 // start mid-rain, not on an empty sky

    // A background flourish: if the GPU path fails, log it and leave the hero plain.
    const prog = gl.createProgram()!
    try {
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG))
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`KanaRain link: ${gl.getProgramInfoLog(prog)}`)
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
    const uRes = u('uRes'), uTime = u('uTime'), uScale = u('uScale'), uTrail = u('uTrail'), uHead = u('uHead')

    const tex = gl.createTexture()
    let ready = false

    const setColors = (): void => {
      const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark')
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--k-accent-text').trim()
      gl.uniform3fv(uTrail, cssColor(accent || '#9eb1ff'))
      // Radix indigo-12, the accent's strongest step: pale in dark mode, deep in light.
      gl.uniform3fv(uHead, cssColor(dark ? '#d6e1ff' : '#1f2d5c'))
    }

    const draw = (): void => {
      if (!ready) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.round(canvas.clientWidth * dpr)
      const h = Math.round(canvas.clientHeight * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        gl.viewport(0, 0, w, h)
      }
      gl.uniform2f(uRes, w, h)
      gl.uniform1f(uScale, dpr)
      gl.uniform1f(uTime, (performance.now() - start) / 1000)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    const loop = (): void => {
      raf = 0
      draw()
      if (visible && !reduced.matches && !document.hidden) raf = requestAnimationFrame(loop)
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
        kick()
      })

    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
      if (visible) kick()
    })
    io.observe(canvas)
    const ro = new ResizeObserver(kick)
    ro.observe(canvas)
    const themeObs = new MutationObserver(() => {
      setColors()
      kick()
    })
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    const onScheme = (): void => {
      setColors()
      kick()
    }
    scheme.addEventListener('change', onScheme)
    reduced.addEventListener('change', kick)
    document.addEventListener('visibilitychange', kick)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      io.disconnect()
      ro.disconnect()
      themeObs.disconnect()
      scheme.removeEventListener('change', onScheme)
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
