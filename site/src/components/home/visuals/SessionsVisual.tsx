import { Check, ChevronsUpDown } from 'lucide-react'
import { VisualFrame } from './parts'

const SESSIONS = [
  { name: 'Steins;Gate', lines: '1,284 lines', active: true },
  { name: '逆転裁判', lines: '642 lines' },
  { name: 'Persona 5 Royal', lines: '2,017 lines' },
  { name: 'よつばと！ 第1巻', lines: '96 lines' }
]

/** Sessions: the Log's session menu, one log (with its own stats) per game or book. */
export function SessionsVisual() {
  return (
    <VisualFrame>
      <div className="flex w-full max-w-[17rem] flex-col items-end gap-1.5">
        <div className="w-full overflow-hidden rounded-lg border border-hairline bg-raised py-1 text-[11px] shadow-pop">
          <p className="px-3 pt-0.5 pb-1 text-[10px] text-ink-3">Change session</p>
          <ul>
            {SESSIONS.map((s) => (
              <li key={s.name} className={`flex items-center gap-2 px-3 py-1 ${s.active ? 'bg-hover' : ''}`}>
                <span lang="ja" className={`flex-1 truncate ${s.active ? 'font-medium text-ink' : 'text-ink-2'}`}>
                  {s.name}
                </span>
                <span className="text-[10px] text-ink-3 tnum">{s.lines}</span>
                <span className="w-3">{s.active && <Check size={11} className="text-accent-ink" aria-hidden />}</span>
              </li>
            ))}
          </ul>
          <div className="mt-1 border-t border-hairline px-3 pt-1.5 pb-1 text-ink-2">
            <p className="flex items-center gap-2 py-0.5">
              <span className="flex-1">Switch session by window name</span>
              <Check size={11} className="text-accent-ink" aria-hidden />
            </p>
            <p className="py-0.5">Manage sessions…</p>
          </div>
        </div>
        <span className="flex h-6 items-center gap-1 rounded-md bg-hover px-2 text-[11px] text-ink">
          Steins;Gate
          <ChevronsUpDown size={10} className="text-ink-3" aria-hidden />
        </span>
      </div>
    </VisualFrame>
  )
}
