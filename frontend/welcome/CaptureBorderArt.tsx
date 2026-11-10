/**
 * The capture border step's picture: a line-drawn Windows window with a game in it, and the
 * yellow border Windows draws around a window while it is captured. Drawn in the style of the
 * Settings art (BrowserDemoArt.tsx): grey lines, one colour for the point. Once captures hide the
 * border (`hidden`), it fades away and leaves the plain window.
 */
import type { JSX } from 'react'
import style from './CaptureBorderArt.module.css'

const W = 520
const H = 300
/** The window, inside the picture's margin so the border and its glow have room. */
const WIN = { x: 26, y: 18, w: 468, h: 264, r: 8 }
const TITLE = 30
/** The game's picture, under the title bar. */
const GAME = { x: WIN.x, y: WIN.y + TITLE, w: WIN.w, h: WIN.h - TITLE }
const LINE = 'この先は危ないぞ。'
const EM = 16

/** Round only the bottom corners: the game sits under the title bar. */
function bottomRounded(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x} ${y}H${x + w}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}Z`
}

export default function CaptureBorderArt({ hidden }: { hidden: boolean }): JSX.Element {
  const right = WIN.x + WIN.w
  const titleMid = WIN.y + TITLE / 2
  const box = { x: GAME.x + 22, y: GAME.y + GAME.h - 74, w: GAME.w - 44, h: 56 }
  return (
    <svg
      className={style.art}
      data-border={hidden ? 'hidden' : 'shown'}
      viewBox={`0 0 ${W} ${H}`}
      fill="none"
      aria-hidden
      focusable="false"
    >
      <defs>
        <clipPath id="cb-game">
          <path d={bottomRounded(GAME.x, GAME.y, GAME.w, GAME.h, WIN.r)} />
        </clipPath>
      </defs>

      {/* The window: title bar with the app's icon and name, then minimise, maximise, close. */}
      <rect className={style.chrome} x={WIN.x} y={WIN.y} width={WIN.w} height={WIN.h} rx={WIN.r} />
      <rect className={style.icon} x={WIN.x + 12.5} y={titleMid - 5.5} width={11} height={11} rx={2.5} />
      <rect className={style.bar} x={WIN.x + 32} y={titleMid - 2} width={78} height={4} rx={2} />
      <path
        className={style.glyph}
        d={[
          `M${right - 118} ${titleMid}H${right - 108}`,
          `M${right - 72.5} ${titleMid - 4.5}h9v9h-9Z`,
          `M${right - 26} ${titleMid - 4.5}l9 9M${right - 17} ${titleMid - 4.5}l-9 9`
        ].join('')}
      />

      {/* The game: sky, sun, hills, a castle on the far hill and a dialogue box. */}
      <g clipPath="url(#cb-game)">
        <rect className={style.sky} x={GAME.x} y={GAME.y} width={GAME.w} height={GAME.h} />
        <circle className={style.sun} cx={GAME.x + 392} cy={GAME.y + 42} r={16} />
        <path
          className={style.cloud}
          d={`M${GAME.x + 60} ${GAME.y + 52}h56a10 10 0 0 0-14-12a14 14 0 0 0-26-2a10 10 0 0 0-16 14Z`}
        />
        <path
          className={style.hillFar}
          d={`M${GAME.x} ${GAME.y + 128}L${GAME.x + 90} ${GAME.y + 96}L${GAME.x + 170} ${GAME.y + 118}L${GAME.x + 270} ${GAME.y + 82}L${GAME.x + 380} ${GAME.y + 112}L${GAME.x + GAME.w} ${GAME.y + 92}V${GAME.y + GAME.h}H${GAME.x}Z`}
        />
        {/* A castle on the far hill: two towers and a gate. */}
        <path
          className={style.castle}
          d={`M${GAME.x + 252} ${GAME.y + 90}V${GAME.y + 66}h6v4h4v-4h6v4h4v-4h6v24M${GAME.x + 258} ${GAME.y + 90}v-8a4 4 0 0 1 8 0v8`}
        />
        <path
          className={style.hill}
          d={`M${GAME.x} ${GAME.y + 150}Q${GAME.x + 120} ${GAME.y + 118} ${GAME.x + 240} ${GAME.y + 142}T${GAME.x + GAME.w} ${GAME.y + 134}V${GAME.y + GAME.h}H${GAME.x}Z`}
        />

        <rect className={style.box} x={box.x + 0.5} y={box.y + 0.5} width={box.w} height={box.h} rx={6} />
        <rect className={style.tag} x={box.x + 12.5} y={box.y - 9.5} width={58} height={18} rx={4} />
        <text className={style.name} x={box.x + 41.5} y={box.y + 4} fontSize={10} textAnchor="middle">
          ゆうしゃ
        </text>
        <text className={style.ink} x={box.x + 18} y={box.y + 32} fontSize={EM}>
          {LINE}
        </text>
        <path className={style.more} d={`M${box.x + box.w - 22} ${box.y + 40}h8l-4 5Z`} />
      </g>
      <path className={style.rule} d={`M${WIN.x} ${GAME.y + 0.5}H${right}`} />
      <rect
        className={style.frame}
        x={WIN.x + 0.5}
        y={WIN.y + 0.5}
        width={WIN.w - 1}
        height={WIN.h - 1}
        rx={WIN.r}
      />

      {/* What Windows draws around a captured window. */}
      <rect
        className={style.border}
        x={WIN.x - 1.5}
        y={WIN.y - 1.5}
        width={WIN.w + 3}
        height={WIN.h + 3}
        rx={WIN.r + 1.5}
      />
    </svg>
  )
}

/** The two switches on Settings → Privacy & security → Screenshot borders, as Windows lays them out. */
const ROWS = [
  { title: 'Screenshot border settings access', note: 262 },
  { title: 'Let apps turn off the screenshot border', note: 226 }
]
const SW = 520
const ROW_H = 52
const GAP = 4

/**
 * Line-drawn Settings rows with both switches on, so the reader knows what to look for: the
 * titles are the real ones, the descriptions only lines.
 */
export function BorderSettingsArt(): JSX.Element {
  const height = ROWS.length * ROW_H + (ROWS.length - 1) * GAP + 1
  return (
    <svg
      className={`${style.art} ${style.settings}`}
      viewBox={`0 0 ${SW} ${height}`}
      fill="none"
      aria-hidden
      focusable="false"
    >
      {ROWS.map((row, i) => {
        const y = i * (ROW_H + GAP) + 0.5
        const mid = y + ROW_H / 2
        return (
          <g key={row.title}>
            <rect className={style.row} x={0.5} y={y} width={SW - 1} height={ROW_H} rx={6} />
            {/* The row's icon: a picture frame for the first, a list for the second. */}
            {i === 0 ? (
              <path
                className={style.glyph}
                d={`M18 ${mid - 8}h16v16h-16ZM21 ${mid + 5}l4-5 3 3 2-2 3 4`}
              />
            ) : (
              <path
                className={style.glyph}
                d={`M18 ${mid - 6}h2M24 ${mid - 6}h10M18 ${mid}h2M24 ${mid}h10M18 ${mid + 6}h2M24 ${mid + 6}h10`}
              />
            )}
            <text className={style.rowTitle} x={52} y={mid - 2} fontSize={13}>
              {row.title}
            </text>
            <rect className={style.bar} x={52} y={mid + 7} width={row.note} height={4} rx={2} />
            <rect className={style.bar} x={SW - 96} y={mid - 2} width={14} height={4} rx={2} />
            <rect className={style.switch} x={SW - 70.5} y={mid - 10} width={40} height={20} rx={10} />
            <circle className={style.knob} cx={SW - 40.5} cy={mid} r={6} />
          </g>
        )
      })}
    </svg>
  )
}
