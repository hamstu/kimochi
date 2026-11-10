import { AArrowDown, AArrowUp, Ellipsis } from 'lucide-react'
import { VisualFrame } from './parts'

/**
 * Text hooking (Windows games): the hooked line in its card over the game (`ui/hook-card.js`), with
 * Auto align setting it over the game's own text box. The card's bar along its top moves it; −/+
 * and ⋯ sit along its bottom, as in the app. Uses the Overlay card's scene (`.overlay-scene`).
 */
export function TextHookerVisual() {
  return (
    <VisualFrame>
      <div className="overlay-scene relative h-52 w-full max-w-[22rem] overflow-hidden rounded-lg shadow-pop">
        {/* Scene suggestion: two characters. */}
        <div className="absolute inset-x-0 bottom-20 h-20 opacity-50">
          <div className="absolute bottom-0 left-[20%] h-16 w-12 rounded-t-full bg-[var(--scene-shape)]" />
          <div className="absolute bottom-0 left-[62%] h-[4.5rem] w-14 rounded-t-full bg-[var(--scene-shape)]" />
        </div>
        {/* The hook card, set by Auto align where the game's own text box is. */}
        <div className="absolute inset-x-3 bottom-3 rounded-[5px] bg-raised/95 px-3 pt-3 pb-1 text-ink shadow-pop ring-1 ring-hairline">
          <span className="absolute top-1 left-1/2 h-1 w-8 -translate-x-1/2 rounded-full bg-press" />
          <p lang="ja" className="text-[13px] leading-6 sm:text-[15px]">
            「今日は
            <span className="rounded-[3px] bg-accent px-0.5 text-accent-contrast">実験</span>
            の続きをしよう」
          </p>
          <div className="flex justify-end gap-0.5 text-ink-3">
            <AArrowDown size={12} aria-hidden />
            <AArrowUp size={12} aria-hidden />
            <Ellipsis size={12} className="ml-1" aria-hidden />
          </div>
        </div>
        <span className="absolute top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-[var(--scene-chip)] px-2 py-0.5 text-[10px] font-medium whitespace-nowrap text-[var(--scene-chip-ink)]">
          Text hooking · LunaHook
        </span>
      </div>
    </VisualFrame>
  )
}
