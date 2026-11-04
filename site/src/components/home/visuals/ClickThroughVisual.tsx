import { MousePointer2, X } from 'lucide-react'
import { VisualFrame } from './parts'

/**
 * Click-through: the overlay's text over the game's text box, and a click on it reaching the game
 * (here, a visual novel's "next line" click). Below, the hint bar the app shows under the scan area
 * (`ui/overlay-hints.js`, a dark frosted pill in every theme) with its real wording.
 */
export function ClickThroughVisual() {
  return (
    <VisualFrame>
      <div className="overlay-scene relative h-52 w-full max-w-[22rem] overflow-hidden rounded-lg shadow-pop">
        {/* Scene suggestion: a room. */}
        <div className="absolute inset-x-0 top-0 bottom-24 opacity-50">
          <div className="absolute top-5 left-[12%] h-12 w-16 rounded-sm bg-[var(--scene-shape)]" />
          <div className="absolute bottom-0 left-[58%] h-16 w-24 rounded-t-sm bg-[var(--scene-shape)]" />
        </div>
        {/* The game's text box, Kimochi's overlay text in place over it. */}
        <div className="absolute inset-x-3 bottom-12 rounded-md bg-[var(--scene-box)] px-3 pt-2 pb-2.5 ring-1 ring-[var(--scene-box-ring)]">
          <div className="relative -mx-1 rounded-sm px-1 py-0.5 outline-1 outline-dashed outline-[var(--scene-guide)]">
            <p lang="ja" className="text-[13px] leading-6 text-[var(--scene-ink)] sm:text-[15px]">
              「準備はいいか？行くぞ」
            </p>
          </div>
          {/* The game's own "next line" marker, answering the click. */}
          <span className="absolute right-3 bottom-1.5 text-[9px] text-[var(--scene-ink)] opacity-70">▼</span>
          {/* The click, landing on the text and going through to the game. */}
          <span className="absolute top-4 left-[42%]">
            <span className="absolute -top-2 -left-2 size-5 rounded-full border-2 border-[var(--scene-ink)] opacity-40" />
            <MousePointer2 size={16} className="relative fill-white text-black drop-shadow" aria-hidden />
          </span>
        </div>
        {/* The hint bar under the scan area. */}
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/80 py-1 pr-1.5 pl-3 text-[10px] font-medium whitespace-nowrap text-white/85 shadow-pop ring-1 ring-white/10">
          <span>
            Hold <kbd className="rounded bg-white/15 px-1 py-px font-sans font-semibold text-white">Shift</kbd> to look up
            words and click text
          </span>
          <X size={10} className="text-white/60" aria-hidden />
        </div>
      </div>
    </VisualFrame>
  )
}
