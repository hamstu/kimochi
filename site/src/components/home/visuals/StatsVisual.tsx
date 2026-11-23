import { Flame } from 'lucide-react'
import { MiniWindow, VisualFrame } from './parts'

const WEEKS = 22

/**
 * How much was read on each day of the heatmap, 0 (nothing) to 4, from a fixed pattern so the
 * prerendered HTML and the browser agree. The last two weeks are an unbroken streak.
 */
function level(week: number, day: number): number {
  const n = (week * 7 + day) * 37
  if (week >= WEEKS - 2) return 1 + ((n >> 2) % 3)
  const v = (n ^ (n >> 3)) % 11
  return v < 5 ? 0 : v < 8 ? 1 : v < 10 ? 2 : (n >> 4) % 2 ? 3 : 4
}

const SHADES = [
  'bg-press',
  'bg-[color-mix(in_oklab,var(--k-accent)_30%,var(--k-raised))]',
  'bg-[color-mix(in_oklab,var(--k-accent)_55%,var(--k-raised))]',
  'bg-[color-mix(in_oklab,var(--k-accent)_78%,var(--k-raised))]',
  'bg-accent'
]

const TOTALS = [
  { label: 'Today', value: '6,412', unit: 'chars' },
  { label: 'This week', value: '38,950', unit: 'chars' },
  { label: 'Speed', value: '7,180', unit: 'chars/h' }
]

/** The Stats tab: a reading heatmap with the current streak, and a row of totals. */
export function StatsVisual() {
  return (
    <VisualFrame>
      <MiniWindow
        title="Stats"
        className="w-full max-w-[23rem]"
        trailing={
          <span className="inline-flex items-center gap-1 text-[10px] text-ink-2">
            <Flame size={11} className="text-accent-ink" aria-hidden />
            <span className="tnum">13-day streak</span>
          </span>
        }
      >
        <div className="px-3 pt-3 pb-2.5">
          <div className="grid grid-flow-col grid-rows-7 gap-[3px]">
            {Array.from({ length: WEEKS * 7 }, (_, i) => {
              const week = Math.floor(i / 7)
              const day = i % 7
              return <span key={i} className={`aspect-square rounded-[2px] ${SHADES[level(week, day)]}`} />
            })}
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-hairline pt-2.5">
            {TOTALS.map((t) => (
              <div key={t.label}>
                <dt className="text-[10px] text-ink-3">{t.label}</dt>
                <dd className="text-[13px] font-medium text-ink tnum">
                  {t.value} <span className="text-[10px] font-normal text-ink-3">{t.unit}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </MiniWindow>
    </VisualFrame>
  )
}
