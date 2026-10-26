/**
 * Line drawings of Read along's two dictionary looks (Settings → Game Mode): the pop-up beside the
 * word, and the full-screen dictionary. Both share one game screen, drawn at 1:1 CSS pixels with
 * every stroke on a half pixel, so the 1px lines land on whole device pixels at 1x and 2x.
 * Colours are CSS variables on `.read-along-art` (game-mode.css), which follow the theme and the
 * card's selected state.
 */
import type { ReactNode } from 'react'

const W = 192
const H = 120

/** A row of words: 1px dashes from x to x at height y. */
const words = (y: number, spans: [number, number][]): string =>
  spans.map(([from, to]) => `M${from} ${y}H${to}`).join('')

/** The game behind both looks: the screen, a ridge of hills and (unless covered) a sun. */
function Screen({ sun = true, children }: { sun?: boolean; children: ReactNode }): ReactNode {
  return (
    <svg
      className="read-along-art"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      fill="none"
      strokeWidth={1}
      aria-hidden
      focusable="false"
    >
      <rect className="ra-screen" x={0.5} y={0.5} width={W - 1} height={H - 1} rx={6} />
      <g className="ra-scenery">
        {sun && <circle cx={34.5} cy={24.5} r={8} />}
        <path d="M1 70.5L32 46.5L52 58.5L88 32.5L120 54.5L142 44.5L191 72.5" />
      </g>
      {children}
    </svg>
  )
}

/** A dictionary entry: reading, headword and a tag, then definitions with a bullet each. */
function Entry({
  x,
  y,
  defs,
  defsAt = y + 17,
  step = 9
}: {
  x: number
  y: number
  /** Each definition's length. */
  defs: number[]
  /** The first definition's line (whole pixel; drawn half a pixel below). */
  defsAt?: number
  step?: number
}): ReactNode {
  return (
    <>
      <path className="ra-faint" d={words(y + 0.5, [[x, x + 14]])} />
      <path className="ra-strong" d={words(y + 6.5, [[x, x + 26]])} />
      <rect className="ra-faint" x={x + 31.5} y={y + 3.5} width={14} height={6} rx={3} />
      {defs.map((length, i) => (
        <g key={i}>
          <circle className="ra-dot" cx={x + 2.5} cy={defsAt + 0.5 + i * step} r={1.5} />
          <path className="ra-line" d={words(defsAt + 0.5 + i * step, [[x + 7, x + 7 + length]])} />
        </g>
      ))}
    </>
  )
}

/** The pop-up: a dialogue box with one word outlined, and the dictionary's card above it. */
export function PopupArt(): ReactNode {
  return (
    <Screen>
      <rect className="ra-panel" x={10.5} y={80.5} width={171} height={29} rx={3} />
      <path
        className="ra-line"
        d={
          words(90.5, [[20, 40], [44, 58], [94, 118], [122, 152]]) +
          words(99.5, [[20, 52], [56, 84], [88, 110]])
        }
      />
      <rect className="ra-mark" x={59.5} y={86.5} width={31} height={8} rx={2} />
      <path className="ra-accent" d={words(90.5, [[63, 87]])} />
      <rect className="ra-panel" x={58.5} y={18.5} width={92} height={56} rx={3} />
      <Entry x={66} y={27} defs={[58, 46, 36]} />
    </Screen>
  )
}

/** Full screen: the scanned line across the top of the dimmed game, its entry filling the rest. */
export function FullscreenArt(): ReactNode {
  return (
    <Screen sun={false}>
      <rect className="ra-dim" x={1} y={1} width={W - 2} height={H - 2} rx={5.5} />
      <path className="ra-line" d={words(13.5, [[14, 34], [38, 52], [92, 116], [120, 144], [148, 178]])} />
      <rect className="ra-mark" x={53.5} y={8.5} width={35} height={10} rx={2} />
      <path className="ra-accent" d={words(13.5, [[57, 85]])} />
      <rect className="ra-panel" x={10.5} y={26.5} width={171} height={83} rx={3} />
      <circle className="ra-accent-dot" cx={160.5} cy={37.5} r={1.5} />
      <circle className="ra-dot" cx={166.5} cy={37.5} r={1.5} />
      <circle className="ra-dot" cx={172.5} cy={37.5} r={1.5} />
      <Entry x={20} y={35} defs={[118, 96, 132, 84, 104]} defsAt={59} step={10} />
      <path className="ra-faint" d={words(49.5, [[20, 172]])} />
    </Screen>
  )
}
