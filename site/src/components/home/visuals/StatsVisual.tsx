import { VisualFrame } from './parts'

// Characters read per day over two weeks (illustrative).
const DAYS = [3.1, 0, 4.8, 6.2, 2.4, 0, 7.9, 5.5, 3.3, 8.6, 6.1, 0, 4.2, 9.4]
const MAX = Math.max(...DAYS)

/** Session stats: reading time, lines, characters, and a two-week strip. */
export function StatsVisual() {
  return (
    <VisualFrame>
      <div className="w-full max-w-[20rem] rounded-lg border border-hairline bg-raised p-4 shadow-pop">
        <dl className="grid grid-cols-3 gap-3">
          {[
            ['Reading', '3h 42m'],
            ['Lines', '1,284'],
            ['Characters', '38,910']
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-[10px] font-medium tracking-[0.06em] text-ink-3 uppercase">{k}</dt>
              <dd className="mt-0.5 text-[17px] font-semibold tracking-[-0.01em] text-ink tnum">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex h-16 items-end gap-1 border-b border-hairline pb-px">
          {DAYS.map((d, i) => (
            <span
              key={i}
              className={`flex-1 rounded-t-[2px] ${i === DAYS.length - 1 ? 'bg-accent' : 'bg-press'}`}
              style={{ height: d === 0 ? 2 : `${(d / MAX) * 100}%` }}
            />
          ))}
        </div>
        <div className="mt-1.5 flex justify-between text-[10px] text-ink-3">
          <span>2 weeks ago</span>
          <span>Today</span>
        </div>
      </div>
    </VisualFrame>
  )
}
