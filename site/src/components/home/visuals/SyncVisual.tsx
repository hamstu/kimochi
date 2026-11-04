import type { ReactNode } from 'react'
import { Laptop, Monitor, RefreshCw } from 'lucide-react'
import { MiniWindow, VisualFrame } from './parts'

/** The rows of Settings → Account → Sync, with the app's own wording (ui/sync.ts, AccountTab.tsx). */
const ROWS = [
  { label: 'Sync now', detail: 'Synced just now.', action: 'Sync now' },
  { label: 'Conflicts', detail: 'None.' },
  { label: 'Export your data', detail: 'Plain JSON and images', action: 'Export…' }
]

/** Kimochi Cloud sync: two computers kept in step, over the Sync section of the Account settings. */
export function SyncVisual() {
  return (
    <VisualFrame>
      <div className="flex w-full max-w-[20rem] flex-col items-center gap-2.5">
        <div className="flex items-center gap-2 text-[11px] text-ink-2">
          <Device icon={<Laptop size={12} aria-hidden />} name="MacBook" />
          <RefreshCw size={12} className="text-ink-3" aria-hidden />
          <Device icon={<Monitor size={12} aria-hidden />} name="Gaming PC" />
        </div>
        <MiniWindow title="Settings · Account" className="w-full">
          <p className="px-3 pt-2 pb-0.5 text-[10px] font-medium tracking-[0.06em] text-ink-3 uppercase">Sync</p>
          <ul className="divide-y divide-hairline px-3 pb-1">
            {ROWS.map(({ label, detail, action }) => (
              <li key={label} className="flex items-center gap-2 py-1 text-[11px]">
                <span className="flex-1">
                  <span className="block font-medium text-ink">{label}</span>
                  <span className="flex items-center gap-1 text-[10px] text-ink-3">
                    {label === 'Sync now' && <span className="size-1.5 rounded-full bg-ok" />}
                    {detail}
                  </span>
                </span>
                {action && (
                  <span className="rounded-md border border-line-strong bg-field px-1.5 py-0.5 text-[10px] text-ink">{action}</span>
                )}
              </li>
            ))}
          </ul>
        </MiniWindow>
      </div>
    </VisualFrame>
  )
}

function Device({ icon, name }: { icon: ReactNode; name: string }) {
  return (
    <span className="flex h-6 items-center gap-1.5 rounded-md border border-hairline bg-raised px-2 shadow-pop">
      <span className="text-ink-3">{icon}</span>
      {name}
    </span>
  )
}
