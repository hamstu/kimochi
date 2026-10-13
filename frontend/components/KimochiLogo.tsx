/**
 * The Kimochi icon as inline SVG, one element per part so onboarding can build it on screen.
 *
 * Geometry is `branding/icon.svg` (written by `branding/compose.mjs`) on its 1024 canvas: the
 * continuous-corner squircle with its indigo fill, sheen and top edge; the four reticle brackets
 * (`RETICLE`: half 0.335, arm 0.115, stroke 0.046, opacity 0.82), one path each; and the キ
 * outline (`KI`, Hiragino Sans W8, placed by `placeGlyph`).
 *
 * The キ outline is a single contour (its three strokes are merged), so it cannot be split into
 * stroke paths. Instead the glyph is drawn as three thick pen strokes along the centre lines of
 * キ's strokes, in writing order (upper bar, lower bar, the long down stroke), and clipped by the
 * real outline: what shows is always exactly the font's shape, and each pen stroke can be drawn
 * in with `stroke-dashoffset`. A clip path (static) holding animated visible strokes renders the
 * same in WebKit, WebView2, WebKitGTK and Chrome, where an animated mask does not reliably.
 *
 * `animate` plays the build (see KimochiLogo.module.css); `settled` (or reduced motion, in the
 * CSS) shows the final state at once. Without `animate` the icon is static.
 */
import { useEffect, useId, useState, type JSX } from 'react'
import style from './KimochiLogo.module.css'

/** `squircle()` in compose.mjs at the full 1024 tile. */
const SQUIRCLE =
  'M352.2 0 L671.8 0 C773.21 0 823.92 0 869.65 15.09 L878.5 17.26 C938.1 38.95 985.05 85.9 1006.74 145.5 C1024 200.08 1024 250.79 1024 352.2 L1024 671.8 C1024 773.21 1024 823.92 1008.91 869.65 L1006.74 878.5 C985.05 938.1 938.1 985.05 878.5 1006.74 C823.92 1024 773.21 1024 671.8 1024 L352.2 1024 C250.79 1024 200.08 1024 154.35 1008.91 L145.5 1006.74 C85.9 985.05 38.95 938.1 17.26 878.5 C0 823.92 0 773.21 0 671.8 L0 352.2 C0 250.79 0 200.08 15.09 154.35 L17.26 145.5 C38.95 85.9 85.9 38.95 145.5 17.26 C200.08 0 250.79 0 352.2 0 Z'

/** `KI` in compose.mjs: font units, y up negative. */
const KI =
  'M358 -641L219 -620C149 -609 116 -605 72 -604L99 -433C140 -444 163 -448 248 -461L386 -483L409 -357L218 -327C158 -317 116 -313 75 -311L102 -141C165 -157 170 -158 239 -169L437 -200L463 -56C477 20 481 49 481 83L671 52C659 14 657 4 641 -82L613 -227L802 -256C886 -268 886 -268 943 -274L913 -443C871 -430 838 -423 769 -412L584 -384L560 -510L716 -534C824 -550 824 -550 858 -553L830 -721C786 -708 758 -703 687 -692L531 -668L520 -723C512 -769 507 -803 506 -834L322 -806C332 -777 337 -756 348 -693Z'

/** Where `placeGlyph` puts キ on the 1024 tile. */
const KI_TRANSFORM = 'translate(266.7 705.55) scale(0.491341)'

/**
 * The pen strokes, in font units and writing order. Each runs along the centre of one of キ's
 * strokes, past both ends, and is a little wider than the stroke it covers; the outline clip
 * trims the rest.
 */
const PEN: { d: string; width: number }[] = [
  { d: 'M20 -509 L920 -648', width: 180 },
  { d: 'M20 -215 L1000 -369', width: 180 },
  { d: 'M408 -880 L584 130', width: 200 }
]

/** The four corner brackets, clockwise from the top left (`RETICLE`). */
const BRACKETS = [
  { d: 'M168.96 286.72V168.96H286.72', corner: 'tl' },
  { d: 'M737.28 168.96H855.04V286.72', corner: 'tr' },
  { d: 'M855.04 737.28V855.04H737.28', corner: 'br' },
  { d: 'M286.72 855.04H168.96V737.28', corner: 'bl' }
] as const

/** Whether the window is on a 1x display, where the scaled-down icon's brackets fall between pixels. */
function useLowDpi(): boolean {
  const [low, setLow] = useState(() => typeof window !== 'undefined' && window.devicePixelRatio < 1.5)
  useEffect(() => {
    const query = window.matchMedia('(max-resolution: 1.49dppx)')
    const update = (): void => setLow(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return low
}

/**
 * The icon for title-bar sizes on 1x displays. The tile and the キ are the real icon's shapes
 * (the glyph outline keeps its proportions; antialiasing suits it), but the brackets are redrawn
 * as 1 px strokes on half-pixel coordinates of a 16-unit grid, so they land on whole pixels
 * instead of smearing across two. On HiDPI the scaled icon is already sharp, so it is used as is.
 */
export function KimochiMark({ size = 16, className }: { size?: number; className?: string }): JSX.Element {
  const id = useId().replace(/:/g, '')
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" role="img" aria-label="Kimochi">
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5a7ce6" />
          <stop offset="0.45" stopColor="#3e63dd" />
          <stop offset="1" stopColor="#2c4cbf" />
        </linearGradient>
      </defs>
      <rect width="16" height="16" rx="4" fill={`url(#${id}-fill)`} shapeRendering="crispEdges" />
      <path
        d="M2.5 5.5V2.5H5.5M10.5 2.5H13.5V5.5M13.5 10.5V13.5H10.5M5.5 13.5H2.5V10.5"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.82"
        strokeWidth="1"
        shapeRendering="crispEdges"
      />
      <g transform={`scale(${16 / 1024})`}>
        <g transform={KI_TRANSFORM}>
          <path d={KI} fill="#fff" />
        </g>
      </g>
    </svg>
  )
}

export default function KimochiLogo({
  size = 128,
  animate = false,
  settled = false,
  className
}: {
  size?: number
  /** Build the icon on screen: squircle, キ in stroke order, then the brackets. */
  animate?: boolean
  /** Jump an animated icon to its final state. */
  settled?: boolean
  className?: string
}): JSX.Element {
  const id = useId().replace(/:/g, '')
  const lowDpi = useLowDpi()
  if (size <= 24 && !animate && lowDpi) return <KimochiMark size={size} className={className} />
  const ref = (name: string): string => `${id}-${name}`
  const url = (name: string): string => `url(#${ref(name)})`
  return (
    <svg
      className={[style.logo, className].filter(Boolean).join(' ')}
      data-animate={animate || undefined}
      data-settled={settled || undefined}
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      role="img"
      aria-label="Kimochi"
    >
      <defs>
        <linearGradient id={ref('fill')} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="1024">
          <stop offset="0" stopColor="#5a7ce6" />
          <stop offset="0.45" stopColor="#3e63dd" />
          <stop offset="1" stopColor="#2c4cbf" />
        </linearGradient>
        <linearGradient id={ref('sheen')} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="563.2">
          <stop offset="0" stopColor="#fff" stopOpacity="0.1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={ref('edge')} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="307.2">
          <stop offset="0" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        {/* icon.svg's glyph gradient (tile y 204.8 → 819.2), in the glyph's font units. */}
        <linearGradient id={ref('glyph')} gradientUnits="userSpaceOnUse" x1="0" y1="-1019" x2="0" y2="231">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#e9edfc" />
        </linearGradient>
        <clipPath id={ref('clip')}>
          <path d={SQUIRCLE} />
        </clipPath>
        <clipPath id={ref('ki')}>
          <path d={KI} />
        </clipPath>
        <filter id={ref('lift')} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="8.19" stdDeviation="12.29" floodColor="#1a2c80" floodOpacity="0.35" />
        </filter>
      </defs>

      <g className={style.tile}>
        <path d={SQUIRCLE} fill={url('fill')} />
        <g clipPath={url('clip')}>
          <rect x="0" y="0" width="1024" height="1024" fill={url('sheen')} />
          <path d={SQUIRCLE} fill="none" stroke={url('edge')} strokeWidth="6.14" />
        </g>
      </g>

      <g filter={url('lift')}>
        {BRACKETS.map((bracket) => (
          <path
            key={bracket.corner}
            className={style.bracket}
            data-corner={bracket.corner}
            d={bracket.d}
            fill="none"
            stroke="#fff"
            strokeOpacity="0.82"
            strokeWidth="47.1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </g>

      <g filter={url('lift')}>
        <g transform={KI_TRANSFORM}>
          <g clipPath={url('ki')}>
            {PEN.map((pen, index) => (
              <path
                key={index}
                className={style.pen}
                data-stroke={index + 1}
                d={pen.d}
                pathLength={1}
                fill="none"
                stroke={url('glyph')}
                strokeWidth={pen.width}
              />
            ))}
          </g>
        </g>
      </g>
    </svg>
  )
}
