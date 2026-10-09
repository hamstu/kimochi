import { Plus, Sparkles, Volume2 } from 'lucide-react'
import { VisualFrame } from './parts'

/** A Yomitan dictionary popup with Listen, Explain and Add to Anki. */
export function DictionaryVisual() {
  return (
    <VisualFrame>
      <div className="w-full max-w-[19rem] rounded-lg border border-hairline bg-raised p-3.5 shadow-pop">
        <div className="flex items-end justify-between gap-3">
          <p lang="ja" className="leading-none text-ink">
            <ruby className="text-[26px] font-medium">
              世界線<rt className="pb-1 text-[10px] font-normal text-ink-3">せかいせん</rt>
            </ruby>
          </p>
          <span lang="ja" className="pb-0.5 text-[11px] text-ink-3">
            せ<span className="border-t border-ink-3">かいせん</span>
            <span className="ml-1 rounded-sm bg-press px-1 text-[10px] text-ink-2">0</span>
          </span>
        </div>
        <ol className="mt-3 space-y-1 text-[12px] leading-[1.45] text-ink-2">
          <li>
            <span className="mr-1.5 text-ink-3 tnum">1</span>
            <i className="text-ink-3">n</i> world line (path of an object through spacetime)
          </li>
          <li>
            <span className="mr-1.5 text-ink-3 tnum">2</span>
            <i className="text-ink-3">n, colloquial</i> timeline; alternate reality
          </li>
        </ol>
        <div className="mt-3 flex items-center gap-1 border-t border-hairline pt-2.5">
          <span className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-hover">
            <Volume2 size={14} />
          </span>
          <span className="grid size-7 place-items-center rounded-md text-ink-2">
            <Sparkles size={14} />
          </span>
          <span className="ml-auto inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[11px] font-medium text-accent-contrast">
            <Plus size={13} />
            Anki
          </span>
        </div>
      </div>
    </VisualFrame>
  )
}
