import { GameScene, VisualFrame } from './parts'

/** The overlay: recognised text drawn back over the game, one word under the pointer. */
export function OverlayVisual() {
  return (
    <VisualFrame>
      <GameScene className="h-52 w-full max-w-[22rem]">
        {/* Scene suggestion: a skyline and a window glow. */}
        <div className="absolute inset-x-0 bottom-16 h-16 opacity-40">
          <div className="absolute bottom-0 left-[8%] h-10 w-8 rounded-t-sm bg-black/60" />
          <div className="absolute bottom-0 left-[22%] h-14 w-10 rounded-t-sm bg-black/50" />
          <div className="absolute bottom-0 left-[40%] h-8 w-12 rounded-t-sm bg-black/60" />
          <div className="absolute bottom-0 left-[62%] h-12 w-9 rounded-t-sm bg-black/55" />
          <div className="absolute bottom-0 left-[78%] h-9 w-14 rounded-t-sm bg-black/60" />
        </div>
        {/* The game's own text box. */}
        <div className="absolute inset-x-3 bottom-3 rounded-md bg-black/55 px-3 pt-2 pb-2.5 ring-1 ring-white/10">
          {/* Kimochi's overlay: the crop region, and the recognised line drawn in place. */}
          <div className="relative -mx-1 rounded-sm px-1 py-0.5 outline-1 outline-dashed outline-white/45">
            <p lang="ja" className="text-[13px] leading-6 text-white sm:text-[15px]">
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
        <span className="absolute top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-2 py-0.5 text-[10px] font-medium text-white/80">
          Overlay on
        </span>
      </GameScene>
    </VisualFrame>
  )
}

function Corner({ className }: { className: string }) {
  return <span className={`absolute size-3 border-t-2 border-l-2 border-white/50 ${className}`} />
}
