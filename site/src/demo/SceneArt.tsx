import { memo } from 'react'
import { GAME } from './content'

/** Deterministic pseudo-random numbers, so the skyline is the same on every render. */
function rng(seed: number): () => number {
  let s = ((seed + 1) * 2654435761) % 2147483647 || 1
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

interface Building {
  x: number
  w: number
  h: number
  lit: [number, number][]
}

function skyline(seed: number, count: number, minH: number, maxH: number, litChance: number): Building[] {
  const r = rng(seed)
  const out: Building[] = []
  let x = -10
  for (let i = 0; i < count && x < 1290; i++) {
    const w = 40 + r() * 90
    const h = minH + r() * (maxH - minH)
    const lit: [number, number][] = []
    for (let wy = 14; wy < h - 12; wy += 16)
      for (let wx = 8; wx < w - 10; wx += 13) if (r() < litChance) lit.push([wx, wy])
    out.push({ x, w, h, lit })
    x += w + r() * 6
  }
  return out
}

const FAR = skyline(7, 30, 140, 320, 0.05)
const NEAR = skyline(31, 22, 90, 230, 0.16)

const STARS = (() => {
  const r = rng(2024)
  return Array.from({ length: 46 }, () => ({ x: r() * 1280, y: r() * 300, size: r() * 1.3 + 0.3, o: 0.2 + r() * 0.55 }))
})()

/**
 * The synthetic game background (original art): dusk sky over a city skyline, seen from a rooftop
 * with a railing and a satellite dish. Drawn at 1280×800 and scaled with the screen.
 */
export const SceneArt = memo(function SceneArt() {
  const { sky, skyline: ink, windows, glow } = GAME.scene
  return (
    <svg className="kd-art" viewBox="0 0 1280 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="kd-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={sky[0]} />
          <stop offset="0.55" stopColor={sky[1]} />
          <stop offset="0.9" stopColor={sky[2]} />
        </linearGradient>
        <radialGradient id="kd-sun" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={glow} stopOpacity="0.95" />
          <stop offset="0.35" stopColor={glow} stopOpacity="0.45" />
          <stop offset="1" stopColor={glow} stopOpacity="0" />
        </radialGradient>
        <linearGradient id="kd-haze" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={sky[2]} stopOpacity="0" />
          <stop offset="1" stopColor={sky[2]} stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <rect width="1280" height="800" fill="url(#kd-sky)" />
      {/* stars */}
      {STARS.map((s, i) => (
        <circle key={i} cx={s.x} cy={s.y} r={s.size} fill="#fff" opacity={s.o} />
      ))}
      <ellipse cx="880" cy="500" rx="460" ry="280" fill="url(#kd-sun)" />
      <circle cx="880" cy="468" r="52" fill={glow} opacity="0.92" />
      <g className="kd-cloud" opacity="0.35" fill={sky[1]}>
        <ellipse cx="260" cy="210" rx="210" ry="18" />
        <ellipse cx="420" cy="236" rx="160" ry="12" />
      </g>
      <g className="kd-cloud kd-cloud-slow" opacity="0.4" fill={sky[2]}>
        <ellipse cx="980" cy="330" rx="260" ry="14" />
        <ellipse cx="1120" cy="352" rx="150" ry="9" />
      </g>
      {/* far skyline */}
      <g fill={ink} opacity="0.55">
        {FAR.map((b, i) => (
          <rect key={i} x={b.x} y={600 - b.h} width={b.w} height={b.h + 200} />
        ))}
      </g>
      <rect y="380" width="1280" height="240" fill="url(#kd-haze)" />
      {/* near skyline with lit windows */}
      <g>
        {NEAR.map((b, i) => (
          <g key={i} transform={`translate(${b.x} ${660 - b.h})`}>
            <rect width={b.w} height={b.h + 200} fill={ink} />
            <g fill={windows} className={i % 5 === 2 ? 'kd-flicker' : undefined}>
              {b.lit.map(([x, y], k) => (
                <rect key={k} x={x} y={y} width="6" height="8" opacity={0.55 + ((k * 37) % 40) / 100} />
              ))}
            </g>
          </g>
        ))}
      </g>
      {/* a neon sign and an antenna on one roof */}
      <g transform="translate(330 470)">
        <rect x="0" y="0" width="18" height="70" rx="3" fill="#ff5fa2" opacity="0.85" className="kd-flicker" />
        <rect x="-2" y="-2" width="22" height="74" rx="4" fill="none" stroke="#ff5fa2" strokeOpacity="0.35" strokeWidth="6" />
      </g>
      {/* rooftop foreground: railing and a satellite dish */}
      <g fill="#0b0916">
        <rect x="0" y="690" width="1280" height="110" />
        <rect x="0" y="640" width="1280" height="6" />
        {Array.from({ length: 33 }, (_, i) => (
          <rect key={i} x={i * 40} y="640" width="4" height="52" />
        ))}
        <g transform="translate(1110 560) rotate(-24)">
          <path d="M-70 0 A70 70 0 0 0 70 0 Z" />
          <line x1="0" y1="0" x2="0" y2="-56" stroke="#0b0916" strokeWidth="5" />
          <circle cx="0" cy="-58" r="6" />
        </g>
        <rect x="1104" y="580" width="12" height="112" />
      </g>
    </svg>
  )
})
