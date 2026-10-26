import type { ReactNode } from 'react'
import type { Button, Frame } from './script'
import { useResolvedTheme } from './env'

function down(frame: Frame, button: Button): string {
  return frame.pressed.includes(button) ? 'kd-down' : ''
}

/** The Deck's left or right controls, drawn flat; pressed parts light up with the script. */
function Controls({ side, frame }: { side: 'left' | 'right'; frame: Frame }) {
  const body = 'fill-[var(--kd-deck-part)]'
  return (
    <svg viewBox="0 0 100 220" className="h-auto w-full" aria-hidden="true">
      {side === 'left' ? (
        <>
          {/* D-pad */}
          <g transform="translate(50 62)">
            <rect className={`kd-pad-part ${body} ${down(frame, 'up')}`} x="-9" y="-30" width="18" height="24" rx="3" />
            <rect className={`kd-pad-part ${body} ${down(frame, 'right')}`} x="6" y="-9" width="24" height="18" rx="3" />
            <rect className={`kd-pad-part ${body}`} x="-9" y="6" width="18" height="24" rx="3" />
            <rect className={`kd-pad-part ${body}`} x="-30" y="-9" width="24" height="18" rx="3" />
          </g>
          <g transform="translate(50 150)">
            <circle r="30" className="fill-[var(--kd-deck-well)]" />
            <circle r="21" className={`kd-pad-part ${body} ${down(frame, 'L3')}`} />
          </g>
        </>
      ) : (
        <>
          <g transform="translate(50 62)" fontSize="11" fontWeight="700" textAnchor="middle" dominantBaseline="central">
            {(
              [
                ['Y', 0, -22],
                ['B', 22, 0],
                ['A', 0, 22],
                ['X', -22, 0]
              ] as const
            ).map(([label, x, y]) => (
              <g key={label} transform={`translate(${x} ${y})`}>
                <circle r="11" className={`kd-pad-part ${body} ${label === 'A' || label === 'B' ? down(frame, label) : ''}`} />
                <text className="fill-[var(--kd-deck-ink)]">{label}</text>
              </g>
            ))}
          </g>
          <g transform="translate(50 150)">
            <circle r="30" className="fill-[var(--kd-deck-well)]" />
            <circle r="21" className={`kd-pad-part ${body} ${down(frame, 'R3')}`} />
          </g>
        </>
      )}
    </svg>
  )
}

const GLYPH: Record<Button, string> = { L3: 'L3', R3: 'R3', up: '▲', right: '▶', A: 'A', B: 'B' }

const HINT_KEYS: Record<string, Button[]> = {
  Kimochi: ['L3', 'R3']
}

/**
 * The demo's own note of the buttons held (the handheld's controls are hidden on phones), in Gaming
 * Mode's glyphs; not something the app draws. Before the menu opens it names the shortcut.
 */
export function DeckHud({ frame }: { frame: Frame }) {
  const theme = useResolvedTheme()
  const keys = frame.pressed.length ? frame.pressed : (HINT_KEYS[frame.hint] ?? [])
  if (frame.hint === '' && frame.pressed.length === 0) return null
  return (
    <div className="kd-gm kd-gm-layer kd-gm-top" data-cm-theme={theme} aria-hidden="true">
      <div className="kd-echo">
        {keys.map((b, i) => (
          <span key={b} className="kd-echo-key">
            {i > 0 && <span className="kd-echo-plus">+</span>}
            <kbd className={`cm-glyph ${b === 'A' ? 'cm-confirm' : ''} ${frame.pressed.includes(b) ? 'kd-down' : ''}`}>{GLYPH[b]}</kbd>
          </span>
        ))}
        {frame.hint && <span>{frame.hint}</span>}
      </div>
    </div>
  )
}

/** A handheld: the 1280×800 screen in a dark body with the controls either side. */
export function DeckBody({ frame, children }: { frame: Frame; children: ReactNode }) {
  return (
    <div className="kd-deck-body mx-auto flex w-full items-center gap-[2%] rounded-[clamp(18px,6vw,56px)] p-[2.2%] sm:px-[3%]">
      <div className="hidden w-[13%] shrink-0 sm:block">
        <Controls side="left" frame={frame} />
      </div>
      <div className="min-w-0 flex-1 overflow-hidden rounded-[6px] ring-1 ring-black/60">{children}</div>
      <div className="hidden w-[13%] shrink-0 sm:block">
        <Controls side="right" frame={frame} />
      </div>
    </div>
  )
}
