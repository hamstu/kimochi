import { ScanText } from 'lucide-react'
import { MiniSwitch, MiniWindow, VisualFrame } from './parts'

/** The compact Controller: Scan on demand, or Auto OCR watching for text to settle. */
export function AutoScanVisual() {
  return (
    <VisualFrame>
      <MiniWindow title="Kimochi" className="w-full max-w-[17rem]">
        <div className="divide-y divide-hairline text-[12px]">
          <div className="flex h-8 items-center justify-between gap-3 px-3">
            <span className="text-ink-2">Source</span>
            <span className="truncate font-medium text-ink">Window · Game</span>
          </div>
          <div className="flex h-8 items-center justify-between gap-3 px-3">
            <span className="text-ink-2">Auto OCR</span>
            <MiniSwitch on />
          </div>
          <div className="flex h-8 items-center justify-between gap-3 px-3">
            <span className="text-ink-2">Overlay</span>
            <MiniSwitch on />
          </div>
          <div className="p-3">
            <span className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-accent text-[12px] font-medium text-accent-contrast">
              <ScanText size={14} aria-hidden />
              Scan
            </span>
            <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-ink-3">
              <span className="relative flex size-1.5">
                <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-60 motion-reduce:hidden" />
                <span className="relative size-1.5 rounded-full bg-ok" />
              </span>
              Watching
            </p>
          </div>
        </div>
      </MiniWindow>
    </VisualFrame>
  )
}
