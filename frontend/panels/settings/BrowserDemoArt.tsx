/**
 * Settings → Browser Extension: a line drawing of a browser, in the style of Read along's art
 * (ReadAlongArt.tsx), that plays the extension's whole flow on a loop. The pointer clicks Kimochi
 * in the toolbar, then the page's picture; the picture is scanned, its line comes back as
 * Kimochi's text box over it, and the pointer rests on a word with the dictionary's pop-up open.
 *
 * Every moving part runs on one 12 s CSS timeline (browser-tab.css, `bd-*` keyframes). Without
 * animation (reduced motion) each part rests in its last state, so the still picture is the
 * finished one: text read, word looked up.
 */
import type { ReactNode } from 'react'
import { EllipsisVertical, Puzzle } from 'lucide-react'
import appIcon from '../../assets/app-icon.svg'

const W = 560
const H = 240

/** The picture: sky, sun and hills, a speech bubble with its line of Japanese. */
const PIC = { x: 262, y: 86, w: 270, h: 134 }
const LINE = '今日はいい天気だね'
const EM = 17
const LINE_X = 344.5
const LINE_Y = 130
/** The looked-up word: 天気, the 6th and 7th characters. */
const WORD = { from: 5, to: 7 }

const xs = (from: number, to: number): string =>
  Array.from({ length: to - from }, (_, i) => LINE_X + (from + i) * EM).join(' ')

/** Lines of text on the page, as rounded bars: [x, y, width, height]. */
const BARS: [number, number, number, number][] = [
  [28, 72, 170, 8],
  [28, 86, 118, 8],
  ...[210, 196, 204, 150].map((w, i): [number, number, number, number] => [28, 108 + i * 10, w, 4]),
  ...[206, 188, 200, 120].map((w, i): [number, number, number, number] => [28, 156 + i * 10, w, 4]),
  ...[198, 90].map((w, i): [number, number, number, number] => [28, 204 + i * 10, w, 4])
]

/** The pointer: an arrow with its tip at 0,0. */
const ARROW = 'M0.5 0.5V15.5L4.5 12L7.5 18.5L10 17.5L7 11H12Z'

export function BrowserDemoArt(): ReactNode {
  return (
    <svg
      className="browser-demo-art"
      viewBox={`0 0 ${W} ${H}`}
      fill="none"
      aria-hidden
      focusable="false"
    >
      <defs>
        <clipPath id="bd-window">
          <rect x={0.5} y={0.5} width={W - 1} height={H - 1} rx={10} />
        </clipPath>
        <clipPath id="bd-picture">
          <rect x={PIC.x} y={PIC.y} width={PIC.w} height={PIC.h} rx={6} />
        </clipPath>
      </defs>

      <g clipPath="url(#bd-window)">
        {/* The window: tab strip, toolbar, page. */}
        <rect className="bd-page" x={0} y={0} width={W} height={H} />
        <rect className="bd-chrome" x={0} y={0} width={W} height={26.5} />
        {/* The tab strip's floor, open under the current tab so the tab joins the toolbar. */}
        <path className="bd-rule" d={`M0 26.5H54.5M174.5 26.5H${W}M0 52.5H${W}`} />
        {[16, 27, 38].map((cx) => (
          <circle key={cx} className="bd-dot" cx={cx} cy={13.5} r={3.5} />
        ))}
        <path className="bd-tab" d="M54.5 26.5V11.5Q54.5 6.5 59.5 6.5H169.5Q174.5 6.5 174.5 11.5V26.5" />
        <rect className="bd-bar" x={66} y={14} width={64} height={4} rx={2} />
        <path className="bd-glyph" d="M18 35.5L14 39.5L18 43.5M30 35.5L34 39.5L30 43.5" />
        <rect className="bd-field" x={50.5} y={31.5} width={380} height={16} rx={8} />
        <rect className="bd-bar" x={62} y={37.5} width={118} height={4} rx={2} />
        <Puzzle className="bd-glyph" x={455} y={31.5} width={15} height={15} strokeWidth={1.25} />
        <image className="bd-kimochi" href={appIcon} x={484} y={30} width={18} height={18} />
        <EllipsisVertical className="bd-glyph" x={512} y={31.5} width={15} height={15} strokeWidth={1.25} />

        {/* The article. */}
        {BARS.map(([x, y, w, h]) => (
          <rect key={`${x}-${y}`} className="bd-bar" x={x} y={y} width={w} height={h} rx={h / 2} />
        ))}

        {/* The picture. */}
        <g clipPath="url(#bd-picture)">
          <rect className="bd-sky" x={PIC.x} y={PIC.y} width={PIC.w} height={PIC.h} />
          <circle className="bd-sun" cx={298.5} cy={114.5} r={10} />
          <path
            className="bd-hill"
            d={`M${PIC.x} 190.5L300 168.5L326 180.5L372 156.5L420 182.5L452 170.5L${PIC.x + PIC.w} 192.5V${PIC.y + PIC.h}H${PIC.x}Z`}
          />
          <path className="bd-hill-far" d={`M${PIC.x} 204.5L318 194.5L380 206.5L440 196.5L${PIC.x + PIC.w} 208.5`} />
          <path className="bd-bubble" d="M342.5 104.5H500.5Q512.5 104.5 512.5 116.5V132.5Q512.5 144.5 500.5 144.5H378.5L356.5 158.5L362.5 144.5H342.5Q330.5 144.5 330.5 132.5V116.5Q330.5 104.5 342.5 104.5Z" />
          <text className="bd-ink" x={xs(0, LINE.length)} y={LINE_Y} fontSize={EM}>
            {LINE}
          </text>
        </g>
        <rect className="bd-frame" x={PIC.x + 0.5} y={PIC.y + 0.5} width={PIC.w - 1} height={PIC.h - 1} rx={6} />

        {/* The picker's outline as the pointer comes over the picture, then the scan. */}
        <rect className="bd-pick" x={PIC.x - 3.5} y={PIC.y - 3.5} width={PIC.w + 7} height={PIC.h + 7} rx={9} />
        <g clipPath="url(#bd-picture)">
          <rect className="bd-scan" x={PIC.x} y={PIC.y - 2} width={PIC.w} height={2} />
        </g>

        {/* Kimochi's text box over the line, then the word under the pointer. */}
        <g className="bd-ocr">
          <rect className="bd-box" x={337.5} y={113.5} width={167} height={23} rx={3} />
          <text className="bd-text" x={xs(0, LINE.length)} y={LINE_Y} fontSize={EM}>
            {LINE}
          </text>
        </g>
        <g className="bd-hit">
          <rect
            className="bd-hit-mark"
            x={LINE_X + WORD.from * EM - 1.5}
            y={114}
            width={(WORD.to - WORD.from) * EM + 3}
            height={22}
            rx={3}
          />
          <text className="bd-hit-text" x={xs(WORD.from, WORD.to)} y={LINE_Y} fontSize={EM}>
            {LINE.slice(WORD.from, WORD.to)}
          </text>
        </g>

        {/* The dictionary's pop-up. */}
        <g className="bd-popup">
          <rect className="bd-card" x={386.5} y={144.5} width={146} height={84} rx={6} />
          <text className="bd-reading" x={397} y={160} fontSize={8}>
            てんき
          </text>
          <text className="bd-head" x={396} y={180} fontSize={16}>
            天気
          </text>
          <rect className="bd-tag" x={436.5} y={170.5} width={20} height={9} rx={4.5} />
          <circle className="bd-def-dot" cx={399.5} cy={195.5} r={1.5} />
          <text className="bd-def" x={405} y={198.5} fontSize={9}>
            weather
          </text>
          <circle className="bd-def-dot" cx={399.5} cy={207.5} r={1.5} />
          <path className="bd-def-line" d="M405 207.5H496" />
          <circle className="bd-def-dot" cx={399.5} cy={217.5} r={1.5} />
          <path className="bd-def-line" d="M405 217.5H470" />
        </g>

        {/* The extension's toolbar, under its button. */}
        <g className="bd-toolbar">
          <rect className="bd-card" x={404.5} y={57.5} width={128} height={20} rx={10} />
          <circle className="bd-live" cx={416.5} cy={67.5} r={2.5} />
          <text className="bd-status bd-status-pick" x={425} y={70.5} fontSize={9}>
            Click a picture
          </text>
          <text className="bd-status bd-status-reading" x={425} y={70.5} fontSize={9}>
            Reading…
          </text>
          <text className="bd-status bd-status-done" x={425} y={70.5} fontSize={9}>
            Read 1 line
          </text>
        </g>

        {/* The two clicks, and the pointer. */}
        <circle className="bd-ripple bd-ripple-button" cx={493} cy={39} r={10} />
        <circle className="bd-ripple bd-ripple-picture" cx={380} cy={180} r={10} />
        <g className="bd-pointer">
          <path className="bd-arrow" d={ARROW} />
        </g>
      </g>
      <rect className="bd-window" x={0.5} y={0.5} width={W - 1} height={H - 1} rx={10} />
    </svg>
  )
}
