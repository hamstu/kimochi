import { VisualFrame } from './parts'

const ITEMS = ['Scan', 'Read Along', 'Auto OCR', 'Recent text', 'Kimochi', 'OCR settings']

/** The Steam Deck radial menu (both sticks together), Scan highlighted. */
export function ControllerVisual() {
  const size = 200
  const c = size / 2
  const rOuter = 92
  const rInner = 38
  const n = ITEMS.length
  const step = (Math.PI * 2) / n
  // Item 0 (Scan) at the top.
  const angle = (i: number) => -Math.PI / 2 + i * step
  const pt = (r: number, a: number) => [c + r * Math.cos(a), c + r * Math.sin(a)] as const
  const wedge = (i: number) => {
    const a0 = angle(i) - step / 2
    const a1 = angle(i) + step / 2
    const [x0, y0] = pt(rOuter, a0)
    const [x1, y1] = pt(rOuter, a1)
    const [x2, y2] = pt(rInner, a1)
    const [x3, y3] = pt(rInner, a0)
    return `M${x0},${y0} A${rOuter},${rOuter} 0 0 1 ${x1},${y1} L${x2},${y2} A${rInner},${rInner} 0 0 0 ${x3},${y3} Z`
  }
  return (
    <VisualFrame>
      <div className="flex items-center gap-5">
        <svg viewBox={`0 0 ${size} ${size}`} className="size-52 shrink-0 drop-shadow-sm">
          {ITEMS.map((label, i) => {
            const [lx, ly] = pt((rOuter + rInner) / 2, angle(i))
            const active = i === 0
            const words = label.split(' ')
            return (
              <g key={label}>
                <path
                  d={wedge(i)}
                  className={active ? 'fill-accent' : 'fill-raised stroke-hairline'}
                  strokeWidth={1}
                />
                <text
                  x={lx}
                  y={ly - (words.length - 1) * 5}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className={`text-[9.5px] font-medium ${active ? 'fill-accent-contrast' : 'fill-ink-2'}`}
                >
                  {words.map((w, j) => (
                    <tspan key={w} x={lx} dy={j === 0 ? 0 : 11}>
                      {w}
                    </tspan>
                  ))}
                </text>
              </g>
            )
          })}
          {/* The stick, pushed toward Scan. */}
          <circle cx={c} cy={c} r={rInner - 8} className="fill-bar stroke-hairline" strokeWidth={1} />
          <circle cx={c} cy={c - 9} r={11} className="fill-raised stroke-line-strong" strokeWidth={1} />
        </svg>
        <dl className="hidden space-y-1.5 text-[11px] sm:block">
          {[
            ['L3 + R3', 'Menu'],
            ['D-pad', 'Words'],
            ['A', 'Reading'],
            ['B', 'Back']
          ].map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <dt className="min-w-12 rounded-sm border border-line-strong bg-raised px-1 py-px text-center font-medium text-ink">
                {k}
              </dt>
              <dd className="text-ink-2">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </VisualFrame>
  )
}
