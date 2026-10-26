/**
 * Gaming Mode's controller menu, the shipped "Halo" design, ported from the app: the markup and
 * geometry of `RadialMenu.show()` in ui/radial-menu.js, the items of `menuItems()` in
 * ui/controller.js, and the look of ui/controller.css + ui/controller-variants.css (`.kd-gm` in
 * demo.css). A hub names the chosen action; spokes run out to an icon per action on a frosted halo.
 * Geometry is in the app's points on a 1280 × 800 handheld screen (`--u` in demo.css).
 */
import type { CSSProperties } from 'react'
import { useResolvedTheme } from './env'

const HUB = 96
const ORBIT = 198
const HALO = 292
const SPOKE_IN = 6
const SPOKE_OUT = 44
const SIZE = HALO * 2

/** Lucide icons, as `ICONS` in ui/radial-menu.js. */
export const ICONS = {
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8h8"/><path d="M7 12h10"/><path d="M7 16h6"/>',
  dictionary:
    '<path d="M12 7v14"/><path d="M16 12h2"/><path d="M16 8h2"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/><path d="M6 12h2"/><path d="M6 8h2"/>',
  auto: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  app: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
  settings:
    '<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>'
}

export function Icon({ paths }: { paths: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: paths }}
    />
  )
}

interface Item {
  label: string
  icon: keyof typeof ICONS
  enabled: boolean
  lit?: boolean
  detail?: string
  unavailable?: string
}

/**
 * The app's `menuItems()`, as the demo's run has them: Auto OCR off, and Read along only once a
 * scan has given it text (lit then, as the likely choice).
 */
function items(hasText: boolean): Item[] {
  return [
    { label: 'Scan', icon: 'scan', enabled: true },
    { label: 'Read along', icon: 'dictionary', enabled: hasText, lit: hasText, unavailable: 'Scan first' },
    { label: 'Auto OCR', icon: 'auto', enabled: true, detail: 'Off' },
    { label: 'Recent text', icon: 'history', enabled: true },
    { label: 'Kimochi', icon: 'app', enabled: true },
    { label: 'OCR settings', icon: 'settings', enabled: true }
  ]
}

function polar(degrees: number, radius: number): [number, number] {
  const r = ((degrees - 90) * Math.PI) / 180
  return [radius * Math.cos(r), radius * Math.sin(r)]
}

/** A length in the app's points, for inline styles. */
const u = (points: number): string => `calc(${points.toFixed(2)} * var(--u))`

interface RadialMenuProps {
  /** The chosen item, -1 for none ("Choose an action"). */
  selected: number
  /** A pressed it: the icon grows as the menu closes. */
  chosen: boolean
  leaving: boolean
  /** A scan has text, so Read along is available. */
  hasText: boolean
}

export function RadialMenu({ selected, chosen, leaving, hasText }: RadialMenuProps) {
  const theme = useResolvedTheme()
  const list = items(hasText)
  const span = 360 / list.length
  const item = list[selected]
  const current = item ? (item.enabled ? item.label : (item.unavailable ?? 'Unavailable')) : 'Choose an action'
  const ring = {
    '--cm-hub': u(HUB),
    '--cm-orbit': u(ORBIT),
    '--cm-halo': u(HALO),
    '--cm-size': u(SIZE)
  } as CSSProperties
  return (
    <div className="kd-gm kd-gm-menu" data-cm-theme={theme} aria-hidden="true">
      <div className={`cm-root ${leaving ? 'cm-leaving' : ''}`}>
        <div className="cm-vignette" />
        <div className="cm-ring" style={ring}>
          <div className="cm-glass" />
          <svg className="cm-wedges" viewBox={`${-SIZE / 2} ${-SIZE / 2} ${SIZE} ${SIZE}`}>
            <defs>
              <radialGradient id="kd-cm-spoke-fade" cx="0" cy="0" r={ORBIT} gradientUnits="userSpaceOnUse">
                <stop offset={HUB / ORBIT} className="cm-fade-from" />
                <stop offset="1" className="cm-fade-to" />
              </radialGradient>
            </defs>
            {list.map((it, i) => {
              const [x1, y1] = polar(i * span, HUB + SPOKE_IN)
              const [x2, y2] = polar(i * span, ORBIT - SPOKE_OUT)
              return (
                <line
                  key={it.label}
                  className={`cm-spoke ${i === selected ? 'cm-selected' : ''} ${it.enabled ? '' : 'cm-disabled'}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                />
              )
            })}
            <circle className="cm-disc" r={HUB} />
          </svg>
          {list.map((it, i) => {
            const [x, y] = polar(i * span, ORBIT)
            return (
              <div
                key={it.label}
                className={`cm-item ${i === selected ? 'cm-selected' : ''} ${i === selected && chosen ? 'cm-chosen' : ''}`}
                data-disabled={it.enabled ? undefined : ''}
                data-lit={it.lit ? '' : undefined}
                style={{ '--x': u(x), '--y': u(y), '--i': i } as CSSProperties}
              >
                <span className="cm-icon">
                  <Icon paths={ICONS[it.icon]} />
                </span>
                <span className="cm-label">{it.label}</span>
                {it.detail && <span className="cm-detail">{it.detail}</span>}
              </div>
            )
          })}
          <div className="cm-center">
            <div className={`cm-current ${item?.enabled ? '' : 'cm-muted'}`}>{current}</div>
            {item?.enabled && item.detail && <div className="cm-current-detail">{item.detail}</div>}
            <div className="cm-hints">
              <span className="cm-hint">
                <kbd className="cm-glyph cm-confirm">A</kbd>Select
              </span>
              <span className="cm-hint">
                <kbd className="cm-glyph cm-cancel">B</kbd>Close
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
