import { Pause } from 'lucide-react'
import { VisualFrame } from './parts'

/**
 * The overlay made your own: Transparent hover cards (the game's own text stays, with a faint
 * outline on the word being looked up), a faded dictionary pop-up the game shows through, and the
 * game paused while you read. The scene follows the site theme (`.overlay-scene` in index.css).
 */
export function OverlayLookVisual() {
  return (
    <VisualFrame>
      <div className="overlay-scene relative h-52 w-full max-w-[22rem] overflow-hidden rounded-lg shadow-pop">
        {/* Scene suggestion: hills. */}
        <div className="absolute inset-x-0 bottom-16 h-20 opacity-50">
          <div className="absolute bottom-0 left-[4%] h-14 w-[38%] rounded-t-full bg-[var(--scene-shape)]" />
          <div className="absolute bottom-0 left-[46%] h-20 w-[48%] rounded-t-full bg-[var(--scene-shape)]" />
        </div>

        {/* The game is paused while you read. */}
        <span className="absolute top-2.5 left-2.5 inline-flex items-center gap-1 rounded-full bg-[var(--scene-chip)] px-2 py-0.5 text-[10px] font-medium text-[var(--scene-chip-ink)]">
          <Pause size={9} aria-hidden />
          Game paused
        </span>

        {/* A faded dictionary pop-up: the game shows through it. */}
        <div className="absolute top-3 right-3 w-[11.5rem] rounded-md border border-hairline bg-[color-mix(in_oklab,var(--k-raised)_60%,transparent)] p-2.5 shadow-pop">
          <p lang="ja" className="leading-none text-ink">
            <ruby className="text-[18px] font-medium">
              夕焼け<rt className="pb-0.5 text-[9px] font-normal text-ink-3">ゆうやけ</rt>
            </ruby>
          </p>
          <p className="mt-1.5 text-[11px] leading-snug text-ink-2">
            <i className="text-ink-3">n</i> sunset; evening glow
          </p>
          <span className="mt-1.5 block text-[9px] font-medium text-ink-3 tnum">Dictionary opacity 60%</span>
        </div>

        {/* The game's own text box, its text left as the game drew it. */}
        <div className="absolute inset-x-3 bottom-3 rounded-md bg-[var(--scene-box)] px-3 pt-2 pb-2.5 ring-1 ring-[var(--scene-box-ring)] backdrop-blur-sm">
          <p lang="ja" className="font-serif text-[13px] leading-6 text-[var(--scene-ink)] sm:text-[15px]">
            「きれいな
            <span className="rounded-[3px] outline-1 outline-offset-1 outline-[var(--scene-guide)]">夕焼け</span>
            だね」
          </p>
        </div>
      </div>
    </VisualFrame>
  )
}
