/**
 * The Steam Deck controller menu, redrawn from the app's ui/radial-menu.js + ui/controller.css
 * (steam-deck-bringup branch): same geometry (outer 168, inner 92, 3° gaps, items clockwise from
 * the top), same wedges and icons as `menuItems()` in ui/controller.js.
 */
const RADIUS = 168
const INNER = 92
const GAP = 3
const SIZE = RADIUS * 2 + 48

const ICONS = {
  scan: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10',
  dictionary: 'M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z',
  auto: 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z',
  text: 'M4 7V4h16v3M9 20h6M12 4v16'
}

interface Item {
  label: string
  icon: keyof typeof ICONS
  enabled: boolean
  detail?: string
}

/** Before a scan there is no text yet, so Read along is unavailable (as in the app). */
const ITEMS: Item[] = [
  { label: 'Scan', icon: 'scan', enabled: true },
  { label: 'Read along', icon: 'dictionary', enabled: false },
  { label: 'Auto OCR', icon: 'auto', enabled: true, detail: 'Off' },
  { label: 'Recent text', icon: 'text', enabled: true },
  { label: 'Kimochi', icon: 'dictionary', enabled: true },
  { label: 'OCR settings', icon: 'scan', enabled: true }
]

function polar(degrees: number, radius: number): [number, number] {
  const r = ((degrees - 90) * Math.PI) / 180
  return [radius * Math.cos(r), radius * Math.sin(r)]
}

function sector(from: number, to: number, outer: number, inner: number): string {
  const [ax, ay] = polar(from, outer)
  const [bx, by] = polar(to, outer)
  const [cx, cy] = polar(to, inner)
  const [dx, dy] = polar(from, inner)
  const large = to - from > 180 ? 1 : 0
  return `M${ax} ${ay}A${outer} ${outer} 0 ${large} 1 ${bx} ${by}L${cx} ${cy}A${inner} ${inner} 0 ${large} 0 ${dx} ${dy}Z`
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

export function RadialMenu({ selected, chosen, leaving }: { selected: number; chosen: boolean; leaving: boolean }) {
  const span = 360 / ITEMS.length
  return (
    <div className={`kd-cm ${leaving ? 'kd-cm-leaving' : ''}`} aria-hidden="true">
      <div className="kd-cm-vignette" />
      <div className="kd-cm-ring">
        <div className="kd-cm-glass" />
        <svg viewBox={`${-SIZE / 2} ${-SIZE / 2} ${SIZE} ${SIZE}`}>
          <defs>
            <radialGradient id="kd-cm-glow" cx="0" cy="0" r={RADIUS} gradientUnits="userSpaceOnUse">
              <stop offset="0.5" stopColor="#7dd3fc" stopOpacity="0.05" />
              <stop offset="1" stopColor="#7dd3fc" stopOpacity="0.55" />
            </radialGradient>
          </defs>
          <circle r={RADIUS + 14} fill="none" stroke="rgb(255 255 255 / 0.1)" />
          <circle className="kd-cm-ticks" r={RADIUS + 14} />
          <circle r={INNER - 10} fill="rgb(0 0 0 / 0.35)" stroke="rgb(255 255 255 / 0.08)" />
          {ITEMS.map((_, i) => (
            <path
              key={i}
              className={`kd-cm-wedge ${i === selected ? 'kd-sel' : ''} ${i === selected && chosen ? 'kd-chosen' : ''}`}
              d={sector(i * span - span / 2 + GAP, i * span + span / 2 - GAP, RADIUS, INNER)}
            />
          ))}
        </svg>
        {ITEMS.map((item, i) => {
          const [x, y] = polar(i * span, (RADIUS + INNER) / 2)
          return (
            <div
              key={item.label}
              className={`kd-cm-item ${i === selected ? 'kd-sel' : ''}`}
              data-disabled={item.enabled ? undefined : ''}
              style={{ left: `${50 + (x / SIZE) * 100}%`, top: `${50 + (y / SIZE) * 100}%`, ['--i' as string]: i }}
            >
              <Icon d={ICONS[item.icon]} />
              <span className="kd-cm-label">{item.label}</span>
              {item.detail && <span className="kd-cm-detail">{item.detail}</span>}
            </div>
          )
        })}
        <div className="kd-cm-center">
          <div className="kd-cm-title">Kimochi</div>
          <div className="kd-cm-current">{selected >= 0 ? ITEMS[selected].label : ''}</div>
          <div className="kd-cm-hints">
            <span>
              <kbd className="kd-glyph kd-confirm">A</kbd> Select
            </span>
            <span>
              <kbd className="kd-glyph">B</kbd> Close
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
