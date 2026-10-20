import { ArrowLeftRight, ChevronsUpDown, Crop, Maximize2, ScanText } from 'lucide-react'
import { MiniSwitch, VisualFrame } from './parts'

/** A row label in the app's sidebar style: small caps, quiet. */
function Label({ children }: { children: string }) {
  return <p className="px-0.5 pb-1 text-[9px] font-medium tracking-[0.06em] text-ink-3 uppercase">{children}</p>
}

/** A select in the sidebar: icon tile, name, the up-down chevron. */
function Select({ icon, name }: { icon: string; name: string }) {
  return (
    <div className="flex h-7 items-center gap-2 rounded-md border border-hairline bg-field px-2 text-[11px] text-ink">
      <span className="grid size-4 place-items-center rounded-[3px] bg-press text-[9px] font-semibold text-ink-2">{icon}</span>
      <span className="flex-1 truncate">{name}</span>
      <ChevronsUpDown size={11} className="text-ink-3" aria-hidden />
    </div>
  )
}

/**
 * Mini mode: Kimochi shrunk to its sidebar (MainPanel's `data-mini`), the source, the switches and
 * the OCR model in a slim window beside the game, with the expand button where the sidebar toggle was.
 */
export function MiniModeVisual() {
  return (
    <VisualFrame>
      <div className="w-full max-w-[15rem] overflow-hidden rounded-lg border border-hairline bg-raised text-[11px] shadow-pop">
        <div className="relative flex h-7 items-center border-b border-hairline bg-bar px-2.5">
          <Maximize2 size={11} className="text-ink-3" aria-hidden />
          <span className="absolute inset-x-10 flex items-center justify-center gap-1.5 font-medium text-ink-2">
            <img src="/icon.svg" alt="" className="size-3" />
            Kimochi
          </span>
        </div>
        <div className="flex flex-col gap-2 p-2">
          <div>
            <div className="rounded-md border border-hairline bg-bar p-1.5">
              <div className="flex items-center gap-2 px-0.5 pb-1.5">
                <span className="grid size-4 place-items-center rounded-[3px] bg-[#d23a4b] text-[9px] font-bold text-white">S</span>
                <span className="flex-1 truncate font-semibold text-ink">STEINS;GATE</span>
              </div>
              <div className="grid grid-cols-2 gap-1">
                <span className="flex h-5 items-center justify-center gap-1 rounded bg-press text-[10px] text-ink-2">
                  <Crop size={9} aria-hidden />
                  Crop area
                </span>
                <span className="flex h-5 items-center justify-center gap-1 rounded bg-press text-[10px] text-ink-2">
                  <ArrowLeftRight size={9} aria-hidden />
                  Change
                </span>
              </div>
            </div>
          </div>
          <div className="divide-y divide-hairline rounded-md border border-hairline">
            <div className="flex h-7 items-center gap-2 px-2 text-ink-2">
              <ScanText size={11} aria-hidden />
              <span className="flex-1">Auto OCR</span>
              <MiniSwitch on />
            </div>
            <div className="flex h-7 items-center gap-2 px-2 text-ink-2">
              <span className="size-[11px] rounded-full border border-current" aria-hidden />
              <span className="flex-1">Show overlay</span>
              <MiniSwitch on />
            </div>
          </div>
          <div>
            <Label>OCR model</Label>
            <Select icon="M" name="MeikiOCR" />
          </div>
        </div>
      </div>
    </VisualFrame>
  )
}
