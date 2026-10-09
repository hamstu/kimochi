import { MapPin } from 'lucide-react'
import { VisualFrame } from './parts'

/** A Notebook entry, and the log line it is recognised in. */
export function NotebookVisual() {
  return (
    <VisualFrame>
      <div className="flex w-full max-w-[19rem] flex-col items-stretch">
        <p lang="ja" className="self-start rounded-md bg-raised px-2.5 py-1.5 text-[13px] text-ink-2 shadow-pop">
          <span className="text-ink underline decoration-dotted decoration-accent-ink underline-offset-4">秋葉原</span>
          の夏は、今年も…
        </p>
        <span className="ml-8 h-4 w-px bg-line-strong" />
        <div className="rounded-lg border border-hairline bg-raised p-3.5 shadow-pop">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium tracking-[0.06em] text-ink-3 uppercase">
              <MapPin size={11} /> Place
            </span>
            <span className="text-[10px] text-ink-3">Notebook</span>
          </div>
          <p lang="ja" className="mt-1.5 flex items-baseline gap-2">
            <span className="text-[22px] font-medium text-ink">秋葉原</span>
            <span className="text-[12px] text-ink-3">あきはばら</span>
          </p>
          <p className="mt-1 text-[12px] leading-[1.45] text-ink-2">
            Tokyo&rsquo;s electronics district, where the lab is.
          </p>
          <div className="mt-2 flex gap-1">
            <span lang="ja" className="rounded-sm bg-press px-1.5 py-0.5 text-[11px] text-ink-2">
              アキバ
            </span>
          </div>
        </div>
      </div>
    </VisualFrame>
  )
}
