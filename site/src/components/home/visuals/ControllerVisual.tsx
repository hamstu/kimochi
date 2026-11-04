import { AppWindow, BookOpenText, History, ScanText, SlidersHorizontal, Zap, type LucideIcon } from 'lucide-react'
import { VisualFrame } from './parts'

/** The controller menu's items, clockwise from the top (ui/controller.js `menuItems`). */
const ITEMS: { label: string; Icon: LucideIcon }[] = [
  { label: 'Scan', Icon: ScanText },
  { label: 'Read along', Icon: BookOpenText },
  { label: 'Auto OCR', Icon: Zap },
  { label: 'Recent text', Icon: History },
  { label: 'Kimochi', Icon: AppWindow },
  { label: 'OCR settings', Icon: SlidersHorizontal }
]

/** The menu's geometry in a 100 × 100 box (the Halo design in ui/radial-menu.js, scaled down). */
const C = 50
const HUB = 15
const ORBIT = 33
const TILE = 15
const SPOKE_IN = HUB + 2
const SPOKE_OUT = ORBIT - TILE / 2 - 2

/**
 * Gaming Mode: a handheld drawn in thin outlines, a game on its screen, and Kimochi's controller
 * menu (the Halo ring: a hub naming the chosen action, spokes out to icon tiles) open over it with
 * Scan chosen. The device and screen share one coordinate box so the screen sits in the bezel.
 */
export function ControllerVisual() {
  return (
    <VisualFrame>
      <div className="relative aspect-[400/168] w-full max-w-[30rem]">
        <svg viewBox="0 0 400 168" className="absolute inset-0 size-full" fill="none" strokeWidth={1.25}>
          {/* Body, then the screen's bezel. */}
          <rect x="1.5" y="1.5" width="397" height="165" rx="44" className="fill-raised stroke-line-strong" />
          <rect x="98" y="16" width="204" height="136" rx="8" className="fill-bar stroke-hairline" />
          {/* Left: stick, D-pad, trackpad. */}
          <circle cx="62" cy="44" r="17" className="stroke-line-strong" />
          <circle cx="62" cy="44" r="11" className="fill-bar stroke-hairline" />
          <path
            d="M33 72h8v-8h8v8h8v8h-8v8h-8v-8h-8z"
            transform="translate(-6 0)"
            className="fill-bar stroke-line-strong"
            strokeLinejoin="round"
          />
          <rect x="44" y="104" width="36" height="36" rx="7" className="stroke-hairline" />
          {/* Right: face buttons, stick, trackpad. */}
          {[
            [358, 62],
            [370, 74],
            [358, 86],
            [346, 74]
          ].map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r="5.5" className="fill-bar stroke-line-strong" />
          ))}
          <circle cx="324" cy="44" r="13" className="stroke-line-strong" />
          <circle cx="324" cy="44" r="8" className="fill-bar stroke-hairline" />
          <rect x="320" y="104" width="36" height="36" rx="7" className="stroke-hairline" />
        </svg>

        {/* The screen: a game, with the controller menu over it. */}
        <div className="overlay-scene absolute top-[11.3%] left-[25.9%] h-[77.4%] w-[48.2%] overflow-hidden rounded-[3px]">
          <div className="absolute inset-x-0 bottom-[30%] h-[45%] opacity-50">
            <div className="absolute bottom-0 left-[14%] h-full w-[16%] rounded-t-full bg-[var(--scene-shape)]" />
            <div className="absolute bottom-0 left-[70%] h-[85%] w-[17%] rounded-t-full bg-[var(--scene-shape)]" />
          </div>
          <div className="absolute inset-x-[5%] bottom-[6%] flex h-[22%] items-center rounded-[3px] bg-[var(--scene-box)] px-[4%] ring-1 ring-[var(--scene-box-ring)]">
            <p lang="ja" className="truncate text-[9px] text-[var(--scene-ink)] sm:text-[11px]">
              「容赦なく進めるぞ」
            </p>
          </div>

          <svg viewBox="0 0 100 100" className="absolute top-[1%] left-1/2 h-[76%] -translate-x-1/2">
            <circle cx={C} cy={C} r={ORBIT + TILE / 2 + 7} fill="var(--scene-box)" opacity={0.75} />
            {ITEMS.map(({ label, Icon }, i) => {
              const a = -Math.PI / 2 + (i * Math.PI * 2) / ITEMS.length
              const at = (r: number) => [C + r * Math.cos(a), C + r * Math.sin(a)] as const
              const [x0, y0] = at(SPOKE_IN)
              const [x1, y1] = at(SPOKE_OUT)
              const [x, y] = at(ORBIT)
              const chosen = i === 0
              return (
                <g key={label}>
                  <line
                    x1={x0}
                    y1={y0}
                    x2={x1}
                    y2={y1}
                    stroke="var(--scene-guide)"
                    strokeWidth={chosen ? 1.2 : 0.6}
                    opacity={chosen ? 1 : 0.6}
                  />
                  <rect
                    x={x - TILE / 2}
                    y={y - TILE / 2}
                    width={TILE}
                    height={TILE}
                    rx={4}
                    className={chosen ? 'fill-accent' : 'fill-raised'}
                    opacity={chosen ? 1 : 0.9}
                  />
                  <Icon
                    x={x - 4.5}
                    y={y - 4.5}
                    width={9}
                    height={9}
                    strokeWidth={2}
                    className={chosen ? 'text-accent-contrast' : 'text-ink-2'}
                    aria-hidden
                  />
                </g>
              )
            })}
            <circle cx={C} cy={C} r={HUB} fill="var(--scene-box)" stroke="var(--scene-box-ring)" strokeWidth={0.6} />
            <text
              x={C}
              y={C}
              textAnchor="middle"
              dominantBaseline="central"
              fill="var(--scene-ink)"
              className="text-[6.5px] font-semibold"
            >
              Scan
            </text>
          </svg>
        </div>
      </div>
    </VisualFrame>
  )
}
