import { MiniWindow, VisualFrame } from './parts'

const LINES = [
  { t: '21:04', text: '秋葉原の夏は、今年も容赦なく暑かった。' },
  { t: '21:06', text: '「助手よ、コーヒーを淹れてくれたまえ」' }
]

/** The Log: a running transcript of every line read, newest last, one word looked up. */
export function LogVisual() {
  return (
    <VisualFrame>
      <MiniWindow title="Log" className="w-full max-w-[23rem]">
        <ol className="divide-y divide-hairline">
          {LINES.map((l) => (
            <li key={l.t} className="flex gap-2.5 px-3 py-2">
              <span className="pt-0.5 text-[10px] font-medium text-ink-3 tnum">{l.t}</span>
              <span lang="ja" className="text-[13px] leading-5 text-ink-2">
                {l.text}
              </span>
            </li>
          ))}
          <li className="relative flex gap-2.5 bg-hover px-3 py-2">
            <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />
            <span className="pt-0.5 text-[10px] font-medium text-ink-3 tnum">21:09</span>
            <span lang="ja" className="text-[13px] leading-5 text-ink">
              <span className="rounded-[3px] bg-accent-soft text-accent-ink underline decoration-accent-ink/50 underline-offset-[3px]">
                世界線
              </span>
              が、ほんのわずかに揺らいだ気がした。
            </span>
          </li>
        </ol>
      </MiniWindow>
    </VisualFrame>
  )
}
