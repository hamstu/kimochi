import type { ReactNode } from 'react'
import { Check, ChevronsUpDown, Monitor } from 'lucide-react'
import { MiniWindow, VisualFrame } from './parts'

/** The highlight colour presets, in the app's order (the first is chosen). */
const SWATCHES = ['bg-accent', 'bg-sky-500', 'bg-teal-500', 'bg-green-600', 'bg-amber-400', 'bg-red-500']

/** The line in the preview, one word hovered. */
const WORDS = ['今日は', 'いい', '天気', 'ですね']
const HOVERED = 2

/** A small slider: a filled track up to `value` (0 to 1) and a round thumb. */
function Slider({ value }: { value: number }) {
  return (
    <span className="relative block h-1 w-full rounded-full bg-press">
      <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${value * 100}%` }} />
      <span
        className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line-strong bg-raised shadow-sm"
        style={{ left: `${value * 100}%` }}
      />
    </span>
  )
}

/** A setting's name over its control, as in the app's settings grid. */
function Setting({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="truncate text-[9px] font-medium text-ink">{name}</span>
      {children}
    </div>
  )
}

/**
 * Settings → Overlay → Overlay appearance, scaled down: the live preview (a line of scanned text,
 * one word turned into its hover card with the dictionary above it), then the highlight colour,
 * highlight opacity, hover card appearance and dictionary opacity.
 */
export function OverlayStyleVisual() {
  return (
    <VisualFrame>
      <MiniWindow title="Settings · Overlay appearance" className="w-full max-w-[23rem]">
        <div className="p-2.5">
          {/* The live preview, on the app's grid ground. */}
          <div className="relative flex h-24 items-end justify-center overflow-hidden rounded-md border border-hairline bg-sunken bg-[linear-gradient(color-mix(in_oklab,var(--k-line)_45%,transparent)_1px,transparent_1px),linear-gradient(90deg,color-mix(in_oklab,var(--k-line)_45%,transparent)_1px,transparent_1px)] bg-[size:10px_10px] pb-2.5">
            <div className="absolute top-1.5 left-1/2 w-24 translate-x-[0.4rem] rounded-[4px] border border-hairline bg-raised/90 px-2 py-1.5 shadow-pop">
              <p lang="ja" className="text-[11px] font-semibold text-ink">
                天気
              </p>
              <span className="mt-1 block h-1 w-full rounded-full bg-press" />
            </div>
            <p lang="ja" className="flex gap-0.5 rounded-[3px] bg-neutral-900 p-0.5 text-[12px] leading-5">
              {WORDS.map((w, i) =>
                i === HOVERED ? (
                  <span key={w} className="rounded-[3px] bg-raised px-0.5 text-ink shadow-sm">
                    {w}
                  </span>
                ) : (
                  <span key={w} className="rounded-[3px] bg-accent/35 px-0.5 text-white ring-1 ring-accent ring-inset">
                    {w}
                  </span>
                )
              )}
            </p>
          </div>

          {/* The controls. */}
          <div className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1.25fr)] gap-3">
            <Setting name="Highlight colour">
              <span className="grid w-fit grid-cols-3 gap-1">
                {SWATCHES.map((c, i) => (
                  <span key={c} className={`grid size-3.5 place-items-center rounded-full ${c}`}>
                    {i === 0 && <Check size={8} strokeWidth={3} className="text-white" aria-hidden />}
                  </span>
                ))}
              </span>
            </Setting>
            <Setting name="Highlight opacity">
              <span className="pt-1">
                <Slider value={0.4} />
              </span>
              <span className="flex justify-between text-[8px] text-ink-3 tnum">
                <span>Off</span>
                <span>100</span>
              </span>
            </Setting>
            <Setting name="Hover card">
              <span className="flex h-5 items-center gap-1 rounded-[4px] border border-line-strong bg-field px-1.5 text-[9px] text-ink">
                <Monitor size={9} className="shrink-0 text-ink-2" aria-hidden />
                <span className="flex-1 truncate">Same as Kimochi</span>
                <ChevronsUpDown size={8} className="shrink-0 text-ink-3" aria-hidden />
              </span>
            </Setting>
          </div>
          <div className="mt-2.5 flex items-center gap-3 border-t border-hairline pt-2">
            <span className="flex-1 text-[9px] font-medium text-ink">Dictionary opacity</span>
            <span className="w-24">
              <Slider value={0.8} />
            </span>
            <span className="w-5 text-right text-[8px] text-ink-3 tnum">80%</span>
          </div>
        </div>
      </MiniWindow>
    </VisualFrame>
  )
}
