import { Clipboard, ScanText, Webhook } from 'lucide-react'
import { MiniWindow, VisualFrame } from './parts'

const INPUTS = [
  { name: 'Screen (OCR)', detail: 'Read the game window', icon: ScanText },
  { name: 'Clipboard', detail: 'Lines you copy', icon: Clipboard },
  { name: 'WebSocket', detail: 'ws://localhost:6677', icon: Webhook, on: true }
]

/** Text inputs: OCR, the clipboard, or a texthooker over WebSocket, all into the same Log. */
export function InputsVisual() {
  return (
    <VisualFrame>
      <MiniWindow title="Settings · Log" className="w-full max-w-[20rem]">
        <p className="px-3 pt-2.5 pb-1 text-[10px] font-medium tracking-[0.06em] text-ink-3 uppercase">Text comes from</p>
        <ul className="px-1.5 pb-1.5">
          {INPUTS.map(({ name, detail, icon: Icon, on }) => (
            <li key={name} className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[12px] ${on ? 'bg-hover' : ''}`}>
              <span className={`grid size-3 place-items-center rounded-full border ${on ? 'border-accent' : 'border-line-strong'}`}>
                {on && <span className="size-1.5 rounded-full bg-accent" />}
              </span>
              <Icon size={13} className="text-ink-3" aria-hidden />
              <span className={`flex-1 ${on ? 'font-medium text-ink' : 'text-ink-2'}`}>{name}</span>
              <span className={`text-[10px] ${on ? 'font-mono text-ink-2' : 'text-ink-3'}`}>{detail}</span>
            </li>
          ))}
        </ul>
        <p className="flex items-center gap-1.5 border-t border-hairline px-3 py-2 text-[11px] text-ink-3">
          <span className="size-1.5 rounded-full bg-ok" />
          Connected to your texthooker
        </p>
      </MiniWindow>
    </VisualFrame>
  )
}
