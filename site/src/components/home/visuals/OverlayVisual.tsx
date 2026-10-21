import { VisualFrame } from './parts'

/**
 * The overlay: recognised text drawn back over the game, one word under the pointer. The scene
 * follows the site theme (`.overlay-scene` in index.css): a light desktop in light mode.
 */
export function OverlayVisual() {
  return (
    <VisualFrame>
      <div className="overlay-scene relative h-52 w-full max-w-[22rem] overflow-hidden rounded-lg shadow-pop">
        {/* Scene suggestion: a skyline. */}
        <div className="absolute inset-x-0 bottom-16 h-16 opacity-50">
          <div className="absolute bottom-0 left-[8%] h-10 w-8 rounded-t-sm bg-[var(--scene-shape)]" />
          <div className="absolute bottom-0 left-[22%] h-14 w-10 rounded-t-sm bg-[var(--scene-shape)]" />
          <div className="absolute bottom-0 left-[40%] h-8 w-12 rounded-t-sm bg-[var(--scene-shape)]" />
          <div className="absolute bottom-0 left-[62%] h-12 w-9 rounded-t-sm bg-[var(--scene-shape)]" />
          <div className="absolute bottom-0 left-[78%] h-9 w-14 rounded-t-sm bg-[var(--scene-shape)]" />
        </div>
        {/* The game's own text box. */}
        <div className="absolute inset-x-3 bottom-3 rounded-md bg-[var(--scene-box)] px-3 pt-2 pb-2.5 ring-1 ring-[var(--scene-box-ring)] backdrop-blur-sm">
          {/* Kimochi's overlay: the crop region, and the recognised line drawn in place. */}
          <div className="relative -mx-1 rounded-sm px-1 py-0.5 outline-1 outline-dashed outline-[var(--scene-guide)]">
            <p lang="ja" className="text-[13px] leading-6 text-[var(--scene-ink)] sm:text-[15px]">
              「助手よ、コーヒーを
              <span className="rounded-[3px] bg-accent px-0.5 text-accent-contrast">淹れて</span>
              くれたまえ」
            </p>
            {/* Proximity marker */}
            <span className="absolute -bottom-1 left-1 h-0.5 w-6 rounded-full bg-accent" />
          </div>
        </div>
        {/* Crop corners */}
        <Corner className="top-2 left-2" />
        <Corner className="top-2 right-2 rotate-90" />
        <span className="absolute top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-[var(--scene-chip)] px-2 py-0.5 text-[10px] font-medium text-[var(--scene-chip-ink)]">
          Overlay on
        </span>
      </div>
    </VisualFrame>
  )
}

function Corner({ className }: { className: string }) {
  return <span className={`absolute size-3 border-t-2 border-l-2 border-[var(--scene-guide)] ${className}`} />
}
